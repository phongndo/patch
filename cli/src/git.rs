//! Reads the change under review from Git. Patch never writes to the
//! repository: every command is read-only and runs without optional locks,
//! and untracked files are diffed through a throwaway copy of the index.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::protocol::Scope;

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const LIMIT: usize = 64 * 1024 * 1024;
/// The most of one file read as text.
pub const TEXT_LIMIT: u64 = LIMIT as u64;
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

/// One side of a changed file as the review read it, from Git's raw record of the change: its
/// path, its mode, and the id of its contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Side {
    pub path: String,
    pub mode: String,
    pub oid: String,
}

/// A changed file: the side it had before, and the side it has after. A side the page cannot name
/// (a path that is not UTF-8) is left out, so nothing is ever read for it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Change {
    pub old: Option<Side>,
    pub new: Option<Side>,
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
    /// Each changed file's sides, read with the patch; a pull request's come from GitHub and have none.
    pub changes: Option<Vec<Change>>,
    /// Read from GitHub (a pull request, or commits this partial clone lacks the contents of):
    /// a file the repository can't give is asked of GitHub too.
    pub remote: bool,
}

#[derive(Default)]
pub struct Run<'a> {
    pub allow_exit_1: bool,
    pub scratch: Option<&'a Scratch>,
    pub stdin: Option<&'a [u8]>,
}

/// `program` with `args`, read-only and never asking anything, its output piped.
fn command(program: &str, cwd: &Path, args: &[&str], options: &Run<'_>) -> Command {
    let mut command = Command::new(program);
    if program == "git" {
        // Paths unquoted, and each diff written alike whatever the user's configuration: a blank
        // context line keeps its space, and paths keep their a/ and b/.
        command.args([
            "-c",
            "core.quotepath=false",
            "-c",
            "diff.suppressBlankEmpty=false",
            "-c",
            "diff.noprefix=false",
            "-c",
            "diff.mnemonicPrefix=false",
        ]);
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
    command
}

fn spawn(program: &str, mut command: Command) -> Result<tokio::process::Child> {
    command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound { format!("{program} is not installed.") } else { error.to_string() }
    })
}

pub async fn run(program: &str, cwd: &Path, args: &[&str], options: Run<'_>) -> Result<String> {
    let mut child = spawn(program, command(program, cwd, args, &options))?;
    if let (Some(input), Some(mut pipe)) = (options.stdin, child.stdin.take()) {
        pipe.write_all(input).await.map_err(|error| error.to_string())?;
    }
    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{program} {} timed out.", args.first().unwrap_or(&"")))?
        .map_err(|error| error.to_string())?;
    let code = output.status.code().unwrap_or(-1);
    if code == 0 || (options.allow_exit_1 && code == 1) {
        // A file Git takes for text need not be UTF-8 (Latin-1, or a damaged image without a NUL):
        // its bad bytes read as U+FFFD, rather than one file failing the whole review.
        return Ok(
            String::from_utf8(output.stdout).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
        );
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() { format!("{program} {} exited with {code}", args.first().unwrap_or(&"")) } else { stderr })
}

/// The most of a file the page may preview as an image.
pub const MEDIA_LIMIT: u64 = 32 * 1024 * 1024;
pub const TOO_LARGE: &str = "This file is too large to preview.";

/// What `program` writes, as bytes, refused once it is over `limit`: it is
/// stopped there rather than read to the end.
pub async fn run_bytes(program: &str, cwd: &Path, args: &[&str], options: Run<'_>, limit: u64) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut child = spawn(program, command(program, cwd, args, &options))?;
    let (Some(stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(format!("{program} has no output."));
    };
    if let (Some(input), Some(mut pipe)) = (options.stdin, child.stdin.take()) {
        let input = input.to_vec();
        tokio::spawn(async move {
            let _ = pipe.write_all(&input).await;
        });
    }
    // On its own, so stdout is never waited on while the child waits to write here. Only its start
    // is kept; the rest is read and dropped.
    let said = tokio::spawn(async move {
        let mut said = Vec::new();
        let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut said).await;
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        said
    });
    let read = async {
        let mut out = Vec::new();
        stdout.take(limit + 1).read_to_end(&mut out).await.map_err(|error| error.to_string())?;
        if out.len() as u64 > limit {
            return Err(TOO_LARGE.to_string()); // Dropping the child stops it.
        }
        let status = child.wait().await.map_err(|error| error.to_string())?;
        if status.success() || (options.allow_exit_1 && status.code() == Some(1)) {
            return Ok(out);
        }
        let said = said.await.unwrap_or_default();
        let said = String::from_utf8_lossy(&said).trim().to_string();
        Err(if said.is_empty() { format!("{program} {} failed.", args.first().unwrap_or(&"")) } else { said })
    };
    tokio::time::timeout(TIMEOUT, read).await.map_err(|_| format!("{program} {} timed out.", args.first().unwrap_or(&"")))?
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
        // One at a time: a path may hold a newline, so two in one answer can't be told apart.
        let path = async |name| git(root, &["rev-parse", "--path-format=absolute", "--git-path", name]).await;
        let (index, objects) = tokio::join!(path("index"), path("objects"));
        let (index, objects) = (index?, objects?);
        let dir = TempDir::new("patch-index-")?;
        std::fs::create_dir(dir.0.join("objects")).map_err(|error| error.to_string())?;
        let _ = std::fs::copy(index.trim(), dir.0.join("index")); // An unborn repository has no index yet.
        // Quoted, or a colon in the path would end it.
        let objects = objects.trim_end_matches(['\r', '\n']).replace('\\', r"\\").replace('"', "\\\"");
        let mut alternates = format!("\"{objects}\"");
        if let Ok(outer) = std::env::var("GIT_ALTERNATE_OBJECT_DIRECTORIES") {
            alternates += &format!("{}{outer}", if cfg!(windows) { ';' } else { ':' });
        }
        Ok(Scratch { dir, alternates })
    }
}

/// A throwaway index with untracked files added as intent-to-add, so a diff of
/// the working tree shows them as new, and a file removed from the index but
/// present on disk shows once, as changed.
async fn worktree_index(root: &Path) -> Result<Scratch> {
    let prepared = Scratch::new(root).await?;
    let scratch = Some(&prepared);
    // As bytes, exactly: a path that is not UTF-8 must reach `git add` as Git wrote it.
    let untracked = run_bytes(
        "git",
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        Run { scratch, ..Run::default() },
        LIMIT as u64,
    )
    .await?;
    if !untracked.is_empty() {
        run(
            "git",
            root,
            &["add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"],
            Run { scratch, stdin: Some(&untracked), ..Run::default() },
        )
        .await?;
    }
    Ok(prepared)
}

const OVER_LIMIT: &str = "This change is over the 64 MB review limit.";

/// `git diff` with `args` and the flags every review uses, with Git's raw record of each file read
/// in the same run, so the patch and the sides it names agree.
async fn diff_with_changes(root: &Path, args: &[&str], scratch: Option<&Scratch>) -> Result<(String, Vec<Change>)> {
    let mut all = vec!["diff", "--raw", "-z", "--patch", "--no-abbrev", "--full-index"];
    all.extend(DIFF_FLAGS);
    all.extend(args);
    let output = run_bytes("git", root, &all, Run { scratch, ..Run::default() }, LIMIT as u64)
        .await
        .map_err(|error| if error == TOO_LARGE { OVER_LIMIT.to_string() } else { error })?;
    let (records, patch) = raw_records(&output);
    // A file Git takes for text need not be UTF-8 (Latin-1, or a damaged image without a NUL): its
    // bad bytes read as U+FFFD, rather than one file failing the whole review.
    let patch = String::from_utf8(patch.to_vec()).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
    let changes = changes(&records, &patch);
    Ok((patch, changes))
}

/// One of Git's raw records (`--raw -z`): `:old-mode new-mode old-id new-id status`, then its path,
/// or for a rename or copy its two paths.
struct Record<'a> {
    old_mode: &'a str,
    new_mode: &'a str,
    old_oid: &'a str,
    new_oid: &'a str,
    status: u8,
    paths: Vec<&'a [u8]>,
}

/// The raw records at the start of `output`, and the patch after the empty record that ends them.
fn raw_records(output: &[u8]) -> (Vec<Record<'_>>, &[u8]) {
    let mut records = Vec::new();
    let mut rest = output;
    fn field<'a>(rest: &mut &'a [u8]) -> Option<&'a [u8]> {
        let end = rest.iter().position(|byte| *byte == 0)?;
        let (value, after) = rest.split_at(end);
        *rest = &after[1..];
        Some(value)
    }
    while rest.first() == Some(&b':') {
        let Some(head) = field(&mut rest) else { break };
        let head = std::str::from_utf8(&head[1..]).unwrap_or("");
        let parts: Vec<&str> = head.split(' ').collect();
        let [old_mode, new_mode, old_oid, new_oid, status, ..] = parts[..] else { break };
        let status = status.as_bytes().first().copied().unwrap_or(b'?');
        let count = if matches!(status, b'R' | b'C') { 2 } else { 1 };
        let paths: Vec<&[u8]> = (0..count).map_while(|_| field(&mut rest)).collect();
        records.push(Record { old_mode, new_mode, old_oid, new_oid, status, paths });
    }
    (records, rest.strip_prefix(b"\0").unwrap_or(rest))
}

/// Each record as a change's sides. A side Git did not hash (the working tree's) takes its id from
/// the patch's `index` line for the same file; without one, its contents did not change, so they
/// are the old side's. With records and patch out of step, a working tree side has no id and is
/// never read.
fn changes(records: &[Record<'_>], patch: &str) -> Vec<Change> {
    let indexes = index_lines(patch);
    let in_step = indexes.len() == records.len();
    let side = |path: Option<&&[u8]>, mode: &str, oid: Option<&str>| {
        Some(Side { path: std::str::from_utf8(path?).ok()?.to_string(), mode: mode.to_string(), oid: oid?.to_string() })
    };
    let hashed = |oid: &str| !oid.bytes().all(|byte| byte == b'0');
    records
        .iter()
        .enumerate()
        .map(|(at, record)| {
            let new_oid = if hashed(record.new_oid) {
                Some(record.new_oid)
            } else if in_step {
                Some(indexes[at].unwrap_or(record.old_oid)).filter(|oid| hashed(oid))
            } else {
                None
            };
            Change {
                old: if record.status == b'A' { None } else { side(record.paths.first(), record.old_mode, Some(record.old_oid)) },
                new: if record.status == b'D' { None } else { side(record.paths.last(), record.new_mode, new_oid) },
            }
        })
        .collect()
}

/// For each file of a patch, in order, the new side's id from its `index` line, if it has one.
fn index_lines(patch: &str) -> Vec<Option<&str>> {
    let mut found = Vec::new();
    let mut in_header = false;
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            found.push(None);
            in_header = true;
        } else if line.starts_with("@@") {
            in_header = false;
        } else if in_header
            && let Some(rest) = line.strip_prefix("index ")
            && let Some(last) = found.last_mut()
        {
            *last = rest.split(' ').next().and_then(|ids| ids.split_once("..")).map(|(_, new)| new);
        }
    }
    found
}

/// How many of the files' contents on either side of `from`..`to` the repository lacks. A partial
/// clone may: Patch fetches nothing, and Git, told not to, looks through every object it has
/// before saying one is missing, minutes in a large repository. Asking first takes milliseconds.
async fn missing_blobs(root: &Path, from: &str, to: &str) -> Result<usize> {
    let raw = run_bytes("git", root, &["diff-tree", "-r", "-z", "--no-renames", from, to], Run::default(), LIMIT as u64)
        .await
        .map_err(|error| if error == TOO_LARGE { OVER_LIMIT.to_string() } else { error })?;
    let (records, _) = raw_records(&raw);
    // Files and links have contents; a submodule's commit is not in this repository anyway.
    let wanted = |mode: &str, oid: &str| (mode.starts_with("10") || mode == "120000") && oid.bytes().any(|byte| byte != b'0');
    let mut ids = String::new();
    for record in &records {
        for (mode, oid) in [(record.old_mode, record.old_oid), (record.new_mode, record.new_oid)] {
            if wanted(mode, oid) {
                ids.push_str(oid);
                ids.push('\n');
            }
        }
    }
    Ok(missing(root, &ids).await?.len())
}

/// Which of `ids`, one a line, the repository lacks: a partial clone's, which Patch never fetches.
pub async fn missing(root: &Path, ids: &str) -> Result<HashSet<String>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    // Fed while its answers are read: written whole first, a large change fills both pipes.
    let run = Run { stdin: Some(ids.as_bytes()), ..Run::default() };
    let found = run_bytes("git", root, &["cat-file", "--batch-check=%(objectname)"], run, LIMIT as u64).await?;
    let found = String::from_utf8_lossy(&found);
    Ok(found.lines().filter_map(|line| line.strip_suffix(" missing")).map(String::from).collect())
}

/// Whether the repository is a partial clone, which may lack any object, trees too.
async fn is_partial(root: &Path) -> bool {
    let promisors = git(root, &["config", "--get-regexp", r"^remote\..*\.promisor$"]).await.unwrap_or_default();
    promisors.lines().any(|line| line.ends_with(" true"))
}

pub fn checked(patch: String) -> Result<String> {
    if patch.len() > LIMIT {
        return Err(OVER_LIMIT.into());
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
    let (head, branch) =
        tokio::join!(try_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"]), try_git(root, &["branch", "--show-current"]));
    let branch = match branch {
        Some(branch) => branch,
        None => head.as_deref().map(|sha| sha[..7.min(sha.len())].to_string()).unwrap_or_else(|| "unborn".into()),
    };
    (head, branch)
}

/// A run of commits to review, from the first to the last, diffed from the first one's parent.
pub struct Commits {
    pub first: String,
    pub parent: String,
    pub to: String,
    /// Whether this partial clone lacks contents the diff needs, which Patch never downloads.
    pub lacking: bool,
}

impl Commits {
    pub fn label(&self) -> String {
        let (first, to) = (&self.first[..7], &self.to[..7]);
        if first == to { format!("Commit {to}") } else { format!("Commits {first}–{to}") }
    }

    /// Why they can't be read here, and how to make them readable.
    pub fn lacking_message(&self) -> String {
        // The empty tree is named in full: it is no commit, so Git can't find it by a prefix.
        let from = if self.parent == EMPTY_TREE { &self.parent[..] } else { &self.parent[..12] };
        format!(
            "This partial clone lacks some of the files these commits change, and Patch never downloads into the repository. \
             `git diff {from} {} >/dev/null` downloads them; then try again.",
            &self.to[..12]
        )
    }
}

pub async fn commits(root: &Path, from: &str, to: &str) -> Result<Commits> {
    let (mut to, mut first) = (resolve_commit(root, to).await?, resolve_commit(root, from).await?);
    // The page may name the ends either way round: the older one is where the run starts.
    if first != to && git(root, &["merge-base", "--is-ancestor", &to, &first]).await.is_ok() {
        std::mem::swap(&mut first, &mut to);
    }
    // The range starts at the first chosen commit, so diff from its parent.
    let parent = try_git(root, &["rev-parse", "--verify", "--quiet", &format!("{first}^")])
        .await
        .unwrap_or_else(|| EMPTY_TREE.to_string());
    let lacking = match missing_blobs(root, &parent, &to).await {
        Ok(missing) => missing > 0,
        // A partial clone without trees can't even list the files: they are not here either.
        Err(_) if is_partial(root).await => true,
        Err(error) => return Err(error),
    };
    Ok(Commits { first, parent, to, lacking })
}

/// The commits' diff, read here: their contents must all be in the repository.
pub async fn read_commits(root: &Path, scope: &Scope, commits: &Commits) -> Result<Review> {
    if commits.lacking {
        return Err(commits.lacking_message());
    }
    let (_, branch) = current_branch(root).await;
    let (patch, changes) = diff_with_changes(root, &[commits.parent.as_str(), commits.to.as_str(), "--"], None).await?;
    Ok(Review {
        repository: repository_name(root),
        branch,
        scope: scope.clone(),
        label: commits.label(),
        base: None,
        old: Ref::Commit(commits.parent.clone()),
        new: Ref::Commit(commits.to.clone()),
        patch: checked(patch)?,
        changes: Some(changes),
        remote: false,
    })
}

pub async fn read_review(root: &Path, scope: &Scope) -> Result<Review> {
    let repository = repository_name(root);

    if let Scope::Commits { from, to } = scope {
        return read_commits(root, scope, &commits(root, from, to).await?).await;
    }

    let (requested, staged, all) = match scope {
        Scope::All { base } => (base.as_deref(), false, true),
        Scope::Staged { .. } => (None, true, false),
        Scope::Uncommitted { .. } => (None, false, false),
        Scope::Commits { .. } | Scope::Pr { .. } => return Err("Pull requests are read through GitHub.".into()),
    };
    // Where the diff starts, and the throwaway index for the working tree, side by side.
    let start = async {
        let (head_and_branch, base) =
            tokio::join!(current_branch(root), async { if all { find_base(root, requested).await } else { Ok(None) } });
        let (head, branch) = head_and_branch;
        let mut from = head.clone().unwrap_or_else(|| EMPTY_TREE.to_string());
        // An unborn branch has no base.
        let base = match &head {
            Some(head) if all => {
                let base = base?;
                if let Some(base) = &base
                    && let Some(merge_base) = try_git(root, &["merge-base", base, head]).await
                {
                    from = merge_base;
                }
                base
            }
            _ => None,
        };
        Ok::<_, String>((branch, base, from))
    };
    let index = async { if staged { Ok(None) } else { worktree_index(root).await.map(Some) } };
    let (start, index) = tokio::join!(start, index);
    let (branch, base, from) = start?;
    let (patch, changes) = match index? {
        Some(scratch) => diff_with_changes(root, &[from.as_str(), "--"], Some(&scratch)).await?,
        None => diff_with_changes(root, &["--cached", from.as_str(), "--"], None).await?,
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
        changes: Some(changes),
        remote: false,
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

pub const NOT_FILE: &str = "Not a file in the repository.";
pub const CHANGED: &str = "This file changed since the review was read.";

/// One side of a file, for expanding context around hunks. The index is read at stage 0, so a
/// path like `2:a.ts` is never taken for a stage.
pub async fn read_side(root: &Path, reference: &Ref, path: &str) -> Result<String> {
    if !safe_path(path) {
        return Err("Bad path.".into());
    }
    match reference {
        Ref::Worktree => read_worktree(root, path).await,
        Ref::Index => git(root, &["show", &format!(":0:{path}")]).await,
        Ref::Commit(sha) => git(root, &["show", &format!("{sha}:{path}")]).await,
    }
}

/// One side of a file as bytes, up to `limit`: a link is no image or document, so it is refused.
pub async fn read_side_bytes(root: &Path, reference: &Ref, path: &str, limit: u64) -> Result<Vec<u8>> {
    if !safe_path(path) {
        return Err("Bad path.".into());
    }
    let object = match reference {
        Ref::Worktree => return read_worktree_file(root, path, limit).await,
        Ref::Index => format!(":0:{path}"),
        Ref::Commit(sha) => format!("{sha}:{path}"),
    };
    // `cat-file blob` is the bytes as stored: no textconv, no filters.
    run_bytes("git", root, &["cat-file", "blob", &object], Run::default(), limit).await
}

/// A regular file at a commit by its path, up to `limit`: a link or a submodule is refused.
pub async fn read_at_commit(root: &Path, sha: &str, path: &str, limit: u64) -> Result<Vec<u8>> {
    if !safe_path(path) {
        return Err("Bad path.".into());
    }
    let literal = format!(":(literal){path}");
    let listed =
        run_bytes("git", root, &["ls-tree", "-z", "--full-tree", sha, "--", &literal], Run::default(), 64 * 1024).await?;
    // `mode type id<TAB>path`, for the one path asked for.
    let listed = String::from_utf8_lossy(&listed);
    let (meta, listed_path) = listed.trim_end_matches('\0').split_once('\t').ok_or_else(|| NOT_FILE.to_string())?;
    let mut meta = meta.split(' ');
    let (Some(mode), Some("blob"), Some(oid)) = (meta.next(), meta.next(), meta.next()) else { return Err(NOT_FILE.into()) };
    if listed_path != path || !matches!(mode, "100644" | "100755") {
        return Err(NOT_FILE.into());
    }
    run_bytes("git", root, &["cat-file", "blob", oid], Run::default(), limit).await
}

/// A changed file's side exactly as the review read it, up to `limit`: by its id, or from the
/// working tree, which is read again and must still hash to that id.
pub async fn read_change(root: &Path, reference: &Ref, side: &Side, limit: u64) -> Result<Vec<u8>> {
    // A link or a submodule has no contents of its own to show.
    if !matches!(side.mode.as_str(), "100644" | "100755") {
        return Err(NOT_FILE.into());
    }
    let Ref::Worktree = reference else {
        return run_bytes("git", root, &["cat-file", "blob", &side.oid], Run::default(), limit).await;
    };
    let bytes = read_worktree_file(root, &side.path, limit).await?;
    // Hashed as Git hashed it for the diff, through the path's filters.
    let path = format!("--path={}", side.path);
    let now = run("git", root, &["hash-object", &path, "--stdin"], Run { stdin: Some(&bytes), ..Run::default() }).await?;
    if now.trim() != side.oid {
        return Err(CHANGED.into());
    }
    Ok(bytes)
}

/// A file of the working tree as Git sees it: a link's text is where it points, never what it
/// points at, and nothing is read from outside the repository.
async fn read_worktree(root: &Path, path: &str) -> Result<String> {
    let (root, path) = (root.to_path_buf(), path.to_string());
    let bytes = tokio::task::spawn_blocking(move || worktree_text(&root, &path)).await.map_err(|error| error.to_string())??;
    Ok(String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned()))
}

/// A regular file of the working tree, up to `limit` bytes.
async fn read_worktree_file(root: &Path, path: &str, limit: u64) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let (owned_root, owned_path) = (root.to_path_buf(), path.to_string());
    let file = tokio::task::spawn_blocking(move || open_in_repo(&owned_root, &owned_path))
        .await
        .map_err(|error| error.to_string())??;
    if file.metadata().map(|meta| meta.len()).unwrap_or(0) > limit {
        return Err(TOO_LARGE.into());
    }
    let mut bytes = Vec::new();
    // It may grow after it was measured.
    tokio::fs::File::from_std(file).take(limit + 1).read_to_end(&mut bytes).await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(TOO_LARGE.into());
    }
    Ok(bytes)
}

/// The folder a path is in, opened by walking from the repository's own one name at a time without
/// following a link anywhere on the way, and the path's last name. Nothing outside the repository
/// can be reached, even through a folder swapped for a link while the walk is under way.
#[cfg(unix)]
fn walk_in_repo<'a>(root: &Path, path: &'a str) -> Result<(rustix::fd::OwnedFd, &'a str)> {
    use rustix::fs::{Mode, OFlags};
    let (folders, name) = path.rsplit_once('/').unwrap_or(("", path));
    let not_file = |_| NOT_FILE.to_string();
    let mut folder =
        rustix::fs::open(root, OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC, Mode::empty()).map_err(not_file)?;
    for part in folders.split('/').filter(|part| !part.is_empty()) {
        if part == "." || part == ".." {
            return Err(NOT_FILE.into());
        }
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        folder = rustix::fs::openat(&folder, part, flags, Mode::empty()).map_err(not_file)?;
    }
    if name.is_empty() || name == "." || name == ".." {
        return Err(NOT_FILE.into());
    }
    Ok((folder, name))
}

/// A regular file of the working tree, opened: not a link, and not a pipe or a device, which could
/// hold a read forever (it is opened without waiting, and checked once open).
#[cfg(unix)]
fn open_in_repo(root: &Path, path: &str) -> Result<std::fs::File> {
    use rustix::fs::{FileType, Mode, OFlags};
    let (folder, name) = walk_in_repo(root, path)?;
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let file = rustix::fs::openat(&folder, name, flags, Mode::empty()).map_err(|_| NOT_FILE.to_string())?;
    let stat = rustix::fs::fstat(&file).map_err(|error| error.to_string())?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(NOT_FILE.into());
    }
    Ok(std::fs::File::from(file))
}

/// A working tree path's contents as Git sees it: a link's target, or a regular file's bytes.
#[cfg(unix)]
fn worktree_text(root: &Path, path: &str) -> Result<Vec<u8>> {
    use rustix::fs::{AtFlags, FileType};
    use std::io::Read;
    let (folder, name) = walk_in_repo(root, path)?;
    let stat = rustix::fs::statat(&folder, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| NOT_FILE.to_string())?;
    if FileType::from_raw_mode(stat.st_mode) == FileType::Symlink {
        let target = rustix::fs::readlinkat(&folder, name, Vec::new()).map_err(|error| error.to_string())?;
        return Ok(target.into_bytes());
    }
    let mut bytes = Vec::new();
    open_in_repo(root, path)?.take(LIMIT as u64 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() > LIMIT {
        return Err(TOO_LARGE.into());
    }
    Ok(bytes)
}

/// Patch is built for macOS and Linux. Elsewhere a path checked and then opened could be swapped
/// between the two, so the working tree is not read at all.
#[cfg(not(unix))]
fn open_in_repo(_root: &Path, _path: &str) -> Result<std::fs::File> {
    Err("Reading the working tree needs macOS or Linux.".into())
}

#[cfg(not(unix))]
fn worktree_text(root: &Path, path: &str) -> Result<Vec<u8>> {
    open_in_repo(root, path).map(|_| Vec::new())
}

/// The largest file the page may open whole; bigger ones are left out.
const OPEN_LIMIT: u64 = 4 * 1024 * 1024;

/// The regular files in a commit's tree, by path, each with its blob, except those in `changed`,
/// and whether the repository has every file's contents (a partial clone may not). Read from Git,
/// never the working tree, where an ignored file or a link out of the repository could be reached.
pub async fn unchanged_files(root: &Path, tree: &str, changed: &HashSet<String>) -> Result<(HashMap<String, String>, bool)> {
    // Without sizes: looking one up for contents a partial clone lacks searches every object.
    let out = git(root, &["ls-tree", "-r", "-z", "--end-of-options", tree]).await?;
    let mut listed: Vec<(&str, &str)> = Vec::new();
    for entry in out.split('\0') {
        let Some((meta, path)) = entry.split_once('\t') else { continue };
        let mut parts = meta.split_whitespace();
        let (Some(mode), Some("blob"), Some(id)) = (parts.next(), parts.next(), parts.next()) else { continue };
        // Links and submodules have no text of their own.
        if matches!(mode, "100644" | "100755") && !changed.contains(path) {
            listed.push((path, id));
        }
    }
    // Each one's size, or that it is missing, asked all at once.
    let ids: String = listed.iter().flat_map(|(_, id)| [*id, "\n"]).collect();
    let run = Run { stdin: Some(ids.as_bytes()), ..Run::default() };
    let sizes = run_bytes("git", root, &["cat-file", "--batch-check=%(objectname) %(objectsize)"], run, LIMIT as u64).await?;
    let sizes = String::from_utf8_lossy(&sizes);
    let mut complete = true;
    let mut files = HashMap::new();
    for ((path, id), answer) in listed.iter().zip(sizes.lines()) {
        match answer.split_once(' ') {
            Some((_, "missing")) => complete = false,
            Some((_, size)) if size.parse::<u64>().is_ok_and(|size| size <= OPEN_LIMIT) => {
                files.insert(path.to_string(), id.to_string());
            }
            _ => {}
        }
    }
    Ok((files, complete))
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
    fn raw_records_name_each_side_with_its_id() {
        let mut output = b":100644 100755 aaaa 0000 M\0m.png\0:100644 100644 bbbb bbbb R100\0r.txt\0moved.txt\0".to_vec();
        output.extend(b":000000 100644 0000 cccc A\0n.txt\0:100644 100644 dddd 0000 M\0t.txt\0");
        output.extend(b":100644 100644 eeee 0000 M\0bad\xff.png\0:100644 000000 1111 0000 D\0gone.txt\0\0");
        let patch = [
            "diff --git a/m.png b/m.png\nold mode 100644\nnew mode 100755",
            "diff --git a/r.txt b/moved.txt\nsimilarity index 100%\nrename from r.txt\nrename to moved.txt",
            "diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0000..cccc\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+index 1..2",
            "diff --git a/t.txt b/t.txt\nindex dddd..ffff 100644\n--- a/t.txt\n+++ b/t.txt\n@@ -1 +1 @@\n-a\n+b",
            "diff --git a/bad.png b/bad.png\nindex eeee..9999 100644\nBinary files a/bad.png and b/bad.png differ",
            "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex 1111..0000",
        ]
        .join("\n");
        output.extend(patch.as_bytes());
        let (records, rest) = raw_records(&output);
        assert_eq!(rest, patch.as_bytes());
        let side = |path: &str, mode: &str, oid: &str| Some(Side { path: path.into(), mode: mode.into(), oid: oid.into() });
        assert_eq!(
            changes(&records, &patch),
            [
                // Only its mode changed: its contents are the old side's.
                Change { old: side("m.png", "100644", "aaaa"), new: side("m.png", "100755", "aaaa") },
                Change { old: side("r.txt", "100644", "bbbb"), new: side("moved.txt", "100644", "bbbb") },
                Change { old: None, new: side("n.txt", "100644", "cccc") },
                // The working tree's side: its id from the patch.
                Change { old: side("t.txt", "100644", "dddd"), new: side("t.txt", "100644", "ffff") },
                // Not UTF-8: the page cannot name it, so nothing is read for it.
                Change { old: None, new: None },
                Change { old: side("gone.txt", "100644", "1111"), new: None },
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_working_tree_file_is_read_only_through_folders_that_are_no_links() {
        let outside = TempDir::new("patch-outside-").unwrap();
        let root = TempDir::new("patch-root-").unwrap();
        std::fs::write(outside.0.join("secret.png"), "hidden").unwrap();
        std::fs::create_dir(root.0.join("images")).unwrap();
        std::fs::write(root.0.join("images/logo.png"), "logo").unwrap();
        std::os::unix::fs::symlink(&outside.0, root.0.join("linked")).unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret.png"), root.0.join("images/link.png")).unwrap();
        let fifo = std::process::Command::new("mkfifo").arg(root.0.join("pipe.png")).status().unwrap();
        assert!(fifo.success());
        let read = |path: &str| {
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut open_in_repo(&root.0, path)?, &mut bytes).map_err(|error| error.to_string())?;
            Ok::<_, String>(bytes)
        };
        assert_eq!(read("images/logo.png").unwrap(), b"logo");
        // Through a linked folder, a linked file, or a pipe, which would hold the read forever.
        for path in ["linked/secret.png", "images/link.png", "pipe.png", "images/../images/logo.png"] {
            assert!(read(path).is_err(), "{path} was read");
        }
    }

    #[test]
    fn paths() {
        assert!(safe_path("src/a.ts"));
        assert!(!safe_path("../etc/passwd"));
        assert!(!safe_path("/etc/passwd"));
        assert!(!safe_path(""));
    }
}
