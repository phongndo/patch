//! Reads the change under review from Git. Patch never writes to the
//! repository: every command is read-only and runs without optional locks,
//! and untracked files are diffed through a throwaway copy of the index.

use std::collections::{HashMap, HashSet};
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
    pub scratch: Option<&'a Scratch>,
    pub stdin: Option<&'a [u8]>,
}

pub async fn run(program: &str, cwd: &Path, args: &[&str], options: Run<'_>) -> Result<String> {
    let mut command = Command::new(program);
    if program == "git" {
        command.args(["-c", "core.quotepath=false"]);
        // A partial clone fetches missing objects into the repository; Patch never does.
        command.env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0").env("GIT_NO_LAZY_FETCH", "1").env("LC_ALL", "C");
    } else {
        command.env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1");
    }
    if let Some(scratch) = options.scratch {
        command
            .args(["-c", "core.splitIndex=false"])
            .env("GIT_INDEX_FILE", scratch.dir.0.join("index"))
            .env("GIT_OBJECT_DIRECTORY", scratch.dir.0.join("objects"))
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &scratch.alternates);
    }
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if options.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound { format!("{program} is not installed.") } else { error.to_string() }
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
    try_git(root, &["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{reference}^{{commit}}")]).await.is_some()
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

/// Where Git writes for a diff of the working tree: an index and objects outside
/// the repository, which it only reads. Even intent-to-add writes an object.
pub struct Scratch {
    dir: TempDir,
    alternates: String,
}

impl Scratch {
    async fn new(root: &Path) -> Result<Scratch> {
        let path = async |name| git(root, &["rev-parse", "--path-format=absolute", "--git-path", name]).await;
        let dir = TempDir::new("patch-index-")?;
        std::fs::create_dir(dir.0.join("objects")).map_err(|error| error.to_string())?;
        let _ = std::fs::copy(path("index").await?.trim(), dir.0.join("index")); // An unborn repository has no index yet.
        let objects = path("objects").await?;
        // Quoted, or a colon in the path would end it.
        let objects = objects.trim_end_matches(['\r', '\n']).replace('\\', r"\\").replace('"', "\\\"");
        let mut alternates = format!("\"{objects}\"");
        if let Ok(outer) = std::env::var("GIT_ALTERNATE_OBJECT_DIRECTORIES") {
            alternates += &format!("{}{outer}", if cfg!(windows) { ';' } else { ':' });
        }
        Ok(Scratch { dir, alternates })
    }
}

/// `git diff <from>` against the working tree, with untracked files added as
/// intent-to-add to a throwaway index so they show as new, and so a file
/// removed from the index but present on disk shows once, as changed.
async fn diff_worktree(root: &Path, from: &str) -> Result<String> {
    let scratch = Scratch::new(root).await?;
    let scratch = Some(&scratch);
    let untracked =
        run("git", root, &["ls-files", "--others", "--exclude-standard", "-z"], Run { scratch, ..Run::default() }).await?;
    if !untracked.is_empty() {
        run(
            "git",
            root,
            &["add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"],
            Run { scratch, stdin: Some(untracked.as_bytes()), ..Run::default() },
        )
        .await?;
    }
    let mut args = vec!["diff"];
    args.extend(DIFF_FLAGS);
    args.extend([from, "--"]);
    run("git", root, &args, Run { scratch, ..Run::default() }).await
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
        let label = if first == to { format!("Commit {}", &to[..7]) } else { format!("Commits {}–{}", &first[..7], &to[..7]) };
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

async fn log(root: &Path, range: &[&str]) -> Vec<Commit> {
    let mut args = vec!["log", "--max-count=300", "--format=%H%x00%h%x00%s%x00%an%x00%cr"];
    args.extend(range);
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

/// The branch's own commits since `base`, newest first, and the ref they are
/// counted from. On the base branch itself, or a branch with nothing of its
/// own, that list is empty, so it falls back to the last 50 commits and no ref.
pub async fn list_commits(root: &Path, base: Option<&str>) -> (Vec<Commit>, Option<String>) {
    if let Some(base) = base {
        let own = log(root, &[&format!("{base}..HEAD")]).await;
        if !own.is_empty() {
            return (own, Some(base.to_string()));
        }
    }
    (log(root, &["-n", "50", "HEAD"]).await, None)
}

/// A cheap summary of the working tree: HEAD, the status of every changed
/// path, and each changed file's size and modification time, so a second edit
/// to an already modified file still counts as a change.
pub async fn fingerprint(root: &Path) -> String {
    let head = try_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await.unwrap_or_default();
    let status = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).await.unwrap_or_default();
    let mut out = format!("{head}\n{status}");
    for entry in status.split('\0') {
        if let Some(path) = entry.get(3..)
            && let Ok(meta) = std::fs::metadata(root.join(path))
        {
            let modified = meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok());
            out.push_str(&format!("\n{path}:{}:{}", meta.len(), modified.map(|d| d.as_nanos()).unwrap_or(0)));
        }
    }
    out
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
        Ref::Worktree => read_worktree(root, path).await,
        Ref::Index => git(root, &["show", &format!(":{path}")]).await,
        Ref::Commit(sha) => git(root, &["show", &format!("{sha}:{path}")]).await,
    }
}

/// A file of the working tree as Git sees it: a link's text is where it points,
/// never what it points at, and nothing is read from outside the repository,
/// through a linked folder either.
async fn read_worktree(root: &Path, path: &str) -> Result<String> {
    let full = root.join(path);
    let meta = tokio::fs::symlink_metadata(&full).await.map_err(|error| error.to_string())?;
    if meta.file_type().is_symlink() {
        let target = tokio::fs::read_link(&full).await.map_err(|error| error.to_string())?;
        return Ok(target.to_string_lossy().into_owned());
    }
    let inside = match (tokio::fs::canonicalize(&full).await, tokio::fs::canonicalize(root).await) {
        (Ok(real), Ok(root)) => real.starts_with(root),
        _ => false,
    };
    if !inside || !meta.is_file() {
        return Err("Not a file in the repository.".into());
    }
    tokio::fs::read_to_string(&full).await.map_err(|error| error.to_string())
}

/// The largest file the page may open whole; bigger ones are left out.
const OPEN_LIMIT: u64 = 4 * 1024 * 1024;

/// The regular files in a commit's tree, by path, each with its blob, except
/// those in `changed`. Read from Git, never the working tree, where an ignored
/// file or a link out of the repository could be reached.
pub async fn unchanged_files(root: &Path, tree: &str, changed: &HashSet<String>) -> Result<HashMap<String, String>> {
    let out = git(root, &["ls-tree", "-r", "-z", "-l", "--end-of-options", tree]).await?;
    let mut files = HashMap::new();
    for entry in out.split('\0') {
        let Some((meta, path)) = entry.split_once('\t') else { continue };
        let mut parts = meta.split_whitespace();
        let (Some(mode), Some("blob"), Some(id), Some(size)) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        // Links and submodules have no text of their own.
        if !matches!(mode, "100644" | "100755") || changed.contains(path) {
            continue;
        }
        if size.parse::<u64>().is_ok_and(|size| size <= OPEN_LIMIT) {
            files.insert(path.to_string(), id.to_string());
        }
    }
    Ok(files)
}

/// The most lines a search returns, and how much of each.
pub const GREP_LIMIT: usize = 300;
const GREP_WIDTH: usize = 300;

/// Whether a line has `text` in it; capitals in `text` match only capitals.
pub fn finds(text: &str) -> impl Fn(&str) -> bool + '_ {
    let exact = text.chars().any(char::is_uppercase);
    let lower = text.to_lowercase();
    move |line: &str| if exact { line.contains(text) } else { line.to_lowercase().contains(&lower) }
}

/// The lines of one file's text with `text` in them, added to `found` up to the limit.
pub fn grep_text(path: &str, contents: &str, text: &str, found: &mut Vec<(String, u64, String)>) {
    let has = finds(text);
    for (index, line) in contents.lines().enumerate() {
        if found.len() >= GREP_LIMIT {
            return;
        }
        if has(line) {
            found.push((path.to_string(), index as u64 + 1, line.chars().take(GREP_WIDTH).collect()));
        }
    }
}

/// Lines with `text` in a tree's files that `allowed` admits, as path, line and text, added
/// to `found` up to the limit; Git stops once it is reached. Binary files are skipped.
pub async fn grep(
    root: &Path,
    tree: &str,
    text: &str,
    allowed: impl Fn(&str) -> bool,
    found: &mut Vec<(String, u64, String)>,
) -> Result<()> {
    use tokio::io::AsyncBufReadExt;
    let mut args = vec!["-c", "core.quotepath=false", "grep", "-n", "-I", "-z", "--no-color", "-F"];
    if !text.chars().any(char::is_uppercase) {
        args.push("-i");
    }
    args.extend(["-e", text, "--end-of-options", tree, "--"]);
    let mut child = Command::new("git")
        .args(&args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("LC_ALL", "C")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| error.to_string())?;
    let Some(stdout) = child.stdout.take() else { return Ok(()) };
    let mut reader = tokio::io::BufReader::new(stdout);
    let prefix = format!("{tree}:");
    // Each match is the tree and path, NUL, the line number, NUL, the text and a newline; a
    // path may hold a newline, so it is read up to its NUL.
    let read = async {
        let (mut path, mut number, mut line) = (Vec::new(), Vec::new(), Vec::new());
        while found.len() < GREP_LIMIT {
            path.clear();
            number.clear();
            line.clear();
            if reader.read_until(0, &mut path).await? == 0
                || reader.read_until(0, &mut number).await? == 0
                || reader.read_until(b'\n', &mut line).await? == 0
            {
                break;
            }
            let path = String::from_utf8_lossy(path.strip_suffix(&[0]).unwrap_or(&path)).into_owned();
            let Some(path) = path.strip_prefix(&prefix) else { continue };
            let number = String::from_utf8_lossy(number.strip_suffix(&[0]).unwrap_or(&number)).parse::<u64>();
            let (Ok(number), true) = (number, allowed(path)) else { continue };
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            found.push((path.to_string(), number, line.chars().take(GREP_WIDTH).collect()));
        }
        Ok::<_, std::io::Error>(())
    };
    match tokio::time::timeout(TIMEOUT, read).await {
        Ok(result) => result.map_err(|error| error.to_string())?,
        Err(_) => return Err("git grep timed out.".into()),
    }
    // Enough found: dropping the child stops Git. Otherwise it ran out, and exit 1 is no
    // match; anything else is a failure, such as an object the repository lacks.
    if found.len() >= GREP_LIMIT {
        return Ok(());
    }
    let output = child.wait_with_output().await.map_err(|error| error.to_string())?;
    match output.status.code() {
        Some(0 | 1) => Ok(()),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }
}

/// A blob's text; a binary one is refused.
pub async fn read_text(root: &Path, blob: &str) -> Result<String> {
    let text = git(root, &["cat-file", "blob", blob]).await.map_err(|_| "Not a text file.".to_string())?;
    if text.contains('\0') {
        return Err("Not a text file.".into());
    }
    Ok(text)
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

    #[tokio::test]
    async fn a_link_reads_as_where_it_points_and_nothing_outside_is_read() {
        let outside = TempDir::new("patch-outside-").unwrap();
        let root = TempDir::new("patch-root-").unwrap();
        std::fs::write(outside.0.join("secret"), "hidden").unwrap();
        std::fs::write(root.0.join("plain.txt"), "hello").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret"), root.0.join("link")).unwrap();
        std::os::unix::fs::symlink(&outside.0, root.0.join("folder")).unwrap();
        let read = async |path: &str| read_side(&root.0, &Ref::Worktree, path).await;
        assert_eq!(read("plain.txt").await.unwrap(), "hello");
        assert_eq!(read("link").await.unwrap(), outside.0.join("secret").to_string_lossy());
        assert!(read("folder/secret").await.is_err());
    }

    #[test]
    fn paths() {
        assert!(safe_path("src/a.ts"));
        assert!(!safe_path("../etc/passwd"));
        assert!(!safe_path("/etc/passwd"));
        assert!(!safe_path(""));
    }
}
