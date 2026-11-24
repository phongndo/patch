//! Reads the change under review from Git. Patch never writes to the
//! repository: every command is read-only and runs without optional locks,
//! and untracked files are diffed through a throwaway copy of the index.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::protocol::{Commit, Scope};

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const LIMIT: usize = 64 * 1024 * 1024;
const DIFF_FLAGS: [&str; 5] = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3"];
/// A hung git (a network filesystem, a credential prompt) must not hang the review.
const TIMEOUT: Duration = Duration::from_secs(60);

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug)]
pub enum Ref {
    Worktree,
    Index,
    Commit(String),
}

#[derive(Clone, Debug)]
pub struct Review {
    pub repository: String,
    pub branch: String,
    pub scope: Scope,
    pub label: String,
    pub base: Option<String>,
    pub old: Ref,
    pub new: Ref,
    pub patch: String,
}

#[derive(Default)]
pub struct Run<'a> {
    pub allow_exit_1: bool,
    pub index_file: Option<&'a Path>,
    pub stdin: Option<&'a [u8]>,
}

pub async fn run(program: &str, cwd: &Path, args: &[&str], options: Run<'_>) -> Result<String> {
    let mut command = Command::new(program);
    if program == "git" {
        command.args(["-c", "core.quotepath=false"]);
        command.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    } else {
        command.env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1");
    }
    if let Some(index) = options.index_file {
        command.env("GIT_INDEX_FILE", index);
    }
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if options.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("{program} is not installed.")
        } else {
            error.to_string()
        }
    })?;
    if let (Some(input), Some(mut pipe)) = (options.stdin, child.stdin.take()) {
        pipe.write_all(input).await.map_err(|error| error.to_string())?;
    }
    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{program} {} timed out.", args.first().unwrap_or(&"")))?
        .map_err(|error| error.to_string())?;
    let code = output.status.code().unwrap_or(-1);
    if code == 0 || (options.allow_exit_1 && code == 1) {
        return String::from_utf8(output.stdout).map_err(|_| "The diff is not valid UTF-8.".to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { format!("{program} {} exited with {code}", args.first().unwrap_or(&"")) } else { stderr })
}

pub async fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    run("git", cwd, args, Run::default()).await
}

async fn try_git(cwd: &Path, args: &[&str]) -> Option<String> {
    git(cwd, args).await.ok().map(|out| out.trim().to_string()).filter(|out| !out.is_empty())
}

pub async fn find_root(directory: &Path) -> Result<PathBuf> {
    let absolute = std::path::absolute(directory).unwrap_or_else(|_| directory.to_path_buf());
    match try_git(&absolute, &["rev-parse", "--show-toplevel"]).await {
        Some(root) => Ok(PathBuf::from(root)),
        None => Err(format!(
            "{} is not inside a Git repository. Pass the repository to review: patchr review <directory>",
            absolute.display()
        )),
    }
}

async fn is_commit(root: &Path, reference: &str) -> bool {
    try_git(root, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{reference}^{{commit}}")])
        .await
        .is_some()
}

/// The branch a pull request would target: the requested one, else the remote's default, else main/master.
pub async fn find_base(root: &Path, requested: Option<&str>) -> Result<Option<String>> {
    if let Some(requested) = requested {
        if !is_commit(root, requested).await {
            return Err(format!("Base {requested} is not a commit in this repository."));
        }
        return Ok(Some(requested.to_string()));
    }
    let remote_head = try_git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).await;
    let mut candidates: Vec<String> = Vec::new();
    if let Some(head) = &remote_head {
        candidates.push(head.trim_start_matches("origin/").to_string());
        candidates.push(head.clone());
    }
    candidates.extend(["main", "master", "origin/main", "origin/master"].map(String::from));
    for candidate in candidates {
        if is_commit(root, &candidate).await {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// A temporary directory removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Result<TempDir> {
        let path = std::env::temp_dir().join(format!("{prefix}{}", crate::random_token(12)));
        std::fs::create_dir(&path).map_err(|error| error.to_string())?;
        Ok(TempDir(path))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `git diff <from>` against the working tree, with untracked files added as
/// intent-to-add to a throwaway index so they show as new, and so a file
/// removed from the index but present on disk shows once, as changed.
async fn diff_worktree(root: &Path, from: &str) -> Result<String> {
    let real = git(root, &["rev-parse", "--path-format=absolute", "--git-path", "index"]).await?;
    let scratch = TempDir::new("patch-index-")?;
    let index = scratch.0.join("index");
    let _ = std::fs::copy(real.trim(), &index); // An unborn repository has no index yet.
    let untracked = run(
        "git",
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        Run { index_file: Some(&index), ..Run::default() },
    )
    .await?;
    if !untracked.is_empty() {
        run(
            "git",
            root,
            &["add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"],
            Run { index_file: Some(&index), stdin: Some(untracked.as_bytes()), ..Run::default() },
        )
        .await?;
    }
    let mut args = vec!["diff"];
    args.extend(DIFF_FLAGS);
    args.extend([from, "--"]);
    run("git", root, &args, Run { index_file: Some(&index), ..Run::default() }).await
}

fn checked(patch: String) -> Result<String> {
    if patch.len() > LIMIT {
        return Err("This change is over the 64 MB review limit.".into());
    }
    Ok(patch)
}

fn is_commit_id(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

async fn resolve_commit(root: &Path, reference: &str) -> Result<String> {
    if !is_commit_id(reference) {
        return Err(format!("{reference} is not a commit id."));
    }
    try_git(root, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{reference}^{{commit}}")])
        .await
        .ok_or_else(|| format!("Commit {reference} is not in this repository."))
}

pub fn repository_name(root: &Path) -> String {
    root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

pub async fn current_branch(root: &Path) -> (Option<String>, String) {
    let head = try_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await;
    let branch = match try_git(root, &["branch", "--show-current"]).await {
        Some(branch) => branch,
        None => head.as_deref().map(|sha| sha[..7.min(sha.len())].to_string()).unwrap_or_else(|| "unborn".into()),
    };
    (head, branch)
}

pub async fn read_review(root: &Path, scope: &Scope) -> Result<Review> {
    let (head, branch) = current_branch(root).await;
    let repository = repository_name(root);

    if let Scope::Commits { from, to } = scope {
        let to = resolve_commit(root, to).await?;
        let first = resolve_commit(root, from).await?;
        // The range starts at the first chosen commit, so diff from its parent.
        let parent = try_git(root, &["rev-parse", "--verify", "--quiet", &format!("{first}^")])
            .await
            .unwrap_or_else(|| EMPTY_TREE.to_string());
        let mut args = vec!["diff"];
        args.extend(DIFF_FLAGS);
        args.extend([parent.as_str(), to.as_str(), "--"]);
        let patch = checked(git(root, &args).await?)?;
        let label = if first == to {
            format!("Commit {}", &to[..7])
        } else {
            format!("Commits {}–{}", &first[..7], &to[..7])
        };
        return Ok(Review {
            repository,
            branch,
            scope: scope.clone(),
            label,
            base: None,
            old: Ref::Commit(parent),
            new: Ref::Commit(to),
            patch,
        });
    }

    let (requested, staged, all) = match scope {
        Scope::All { base } => (base.as_deref(), false, true),
        Scope::Staged { .. } => (None, true, false),
        Scope::Uncommitted { .. } => (None, false, false),
        Scope::Commits { .. } | Scope::Pr { .. } => return Err("Pull requests are read through GitHub.".into()),
    };
    let mut base = None;
    let mut from = head.clone().unwrap_or_else(|| EMPTY_TREE.to_string());
    if all && let Some(head) = &head {
        base = find_base(root, requested).await?;
        if let Some(base) = &base
            && let Some(merge_base) = try_git(root, &["merge-base", base, head]).await
        {
            from = merge_base;
        }
    }
    let patch = if staged {
        let mut args = vec!["diff"];
        args.extend(DIFF_FLAGS);
        args.extend(["--cached", from.as_str(), "--"]);
        git(root, &args).await?
    } else {
        diff_worktree(root, &from).await?
    };
    let label = if all {
        match &base {
            // On the base branch itself the "branch" is just its uncommitted work.
            Some(base) if base != &branch && base.trim_start_matches("origin/") != branch => {
                format!("{branch} vs {base}")
            }
            _ => branch.clone(),
        }
    } else {
        format!("{branch} · {}", if staged { "staged" } else { "uncommitted" })
    };
    Ok(Review {
        repository,
        branch,
        scope: scope.clone(),
        label,
        base,
        old: Ref::Commit(from),
        new: if staged { Ref::Index } else { Ref::Worktree },
        patch: checked(patch)?,
    })
}

/// Local and remote branches, most recently committed first.
pub async fn list_branches(root: &Path) -> Result<Vec<String>> {
    let out = git(
        root,
        &["for-each-ref", "--sort=-committerdate", "--count=300", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    )
    .await?;
    Ok(out.lines().filter(|r| !r.is_empty() && !r.ends_with("/HEAD") && *r != "origin").map(String::from).collect())
}

/// Commits on HEAD that `base` lacks, newest first; the last 50 when there is no base.
pub async fn list_commits(root: &Path, base: Option<&str>) -> Vec<Commit> {
    let range = base.map(|base| format!("{base}..HEAD"));
    let mut args = vec!["log", "--max-count=300", "--format=%H%x00%h%x00%s%x00%an%x00%cr"];
    match &range {
        Some(range) => args.push(range),
        None => args.extend(["-n", "50", "HEAD"]),
    }
    args.push("--");
    let out = try_git(root, &args).await.unwrap_or_default();
    out.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut parts = line.split('\0').map(String::from);
            let mut next = || parts.next().unwrap_or_default();
            Commit { sha: next(), short: next(), subject: next(), author: next(), when: next() }
        })
        .collect()
}

pub fn safe_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !path.split(['/', '\\']).any(|part| part == "..")
}

/// One side of a file, for expanding context around hunks.
pub async fn read_side(root: &Path, reference: &Ref, path: &str) -> Result<String> {
    if !safe_path(path) {
        return Err("Bad path.".into());
    }
    match reference {
        Ref::Worktree => tokio::fs::read_to_string(root.join(path)).await.map_err(|error| error.to_string()),
        Ref::Index => git(root, &["show", &format!(":{path}")]).await,
        Ref::Commit(sha) => git(root, &["show", &format!("{sha}:{path}")]).await,
    }
}

/// Whether the repository already has a commit, so it can be read without the network.
pub async fn has_commit(root: &Path, sha: &str) -> bool {
    // `cat-file -e` prints nothing; only its exit status answers.
    git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_ids() {
        assert!(is_commit_id("abc1234"));
        assert!(!is_commit_id("--output=/tmp/x"));
        assert!(!is_commit_id("ABC1234"));
        assert!(!is_commit_id("abc"));
    }

    #[test]
    fn paths() {
        assert!(safe_path("src/a.ts"));
        assert!(!safe_path("../etc/passwd"));
        assert!(!safe_path("/etc/passwd"));
        assert!(!safe_path(""));
    }
}
