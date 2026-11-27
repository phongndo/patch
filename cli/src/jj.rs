//! Jujutsu repositories. Every one keeps its commits in a Git repository, which Patch reads as it
//! reads any other: beside the working copy when colocated (`.git`), else inside `.jj`, where Git
//! is pointed with `GIT_DIR` and `GIT_WORK_TREE` (`git_env`). Only what Git can't say is asked of
//! `jj`: which commit the working copy sits on, the bookmarks, and what a revset names.
//!
//! Patch never writes to the repository, and a plain `jj` command snapshots the working copy into
//! a new operation first, even with `--at-op=@` alone. So `jj` is always run with
//! `--ignore-working-copy`, and with `--at-op=@`, without which divergent operations are merged
//! (another write). The files on disk are what is reviewed; the working-copy commit is only ever
//! read for its parent.
//!
//! Even so, jj rebuilds its commit index when it finds it missing, behind, or in an older format,
//! and writes the new one into the repository. So `jj` is pointed at a shadow of the workspace
//! instead (`Shadow`): every part of it a link to the real one, except the index, whose folders are
//! the shadow's own and only its files links. Whatever jj writes to the index lands there.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::git::{Result, Run, run};

/// Where a Jujutsu workspace keeps its commits.
#[derive(Debug)]
pub struct Repo {
    /// The Git repository jj stores its commits in.
    pub git_dir: PathBuf,
    /// Whether that is the workspace's own `.git`, whose index jj keeps as the working copy's
    /// parent: Git then needs no pointing anywhere.
    pub colocated: bool,
    /// Where jj records its operations: any change to the repository adds one.
    op_heads: PathBuf,
    /// The repository itself (`.jj/repo`, or where a workspace's points).
    repo: PathBuf,
    /// The workspace's record of its working copy.
    working_copy: PathBuf,
}

/// Each root's repository, or that it is no Jujutsu one, found once.
static REPOS: Mutex<Option<HashMap<PathBuf, Option<Arc<Repo>>>>> = Mutex::new(None);

/// The Jujutsu repository whose workspace `root` is, if it is one.
pub fn of(root: &Path) -> Option<Arc<Repo>> {
    if let Some(found) = REPOS.lock().unwrap().as_ref().and_then(|repos| repos.get(root)) {
        return found.clone();
    }
    let found = read(root).map(Arc::new);
    REPOS.lock().unwrap().get_or_insert_default().insert(root.to_path_buf(), found.clone());
    found
}

/// A workspace's repository from its `.jj`: `repo` is the repository itself, or for a workspace
/// added beside another, a file with its path; the store's `git_target` names its Git repository.
fn read(root: &Path) -> Option<Repo> {
    let dot = root.join(".jj");
    let mut repo = dot.join("repo");
    if repo.is_file() {
        let target = std::fs::read_to_string(&repo).ok()?;
        repo = dot.join(target.trim_end_matches(['\r', '\n']));
    }
    let store = repo.join("store");
    // Other backends than Git's (Google's, a test one) have nothing Git can read.
    if std::fs::read_to_string(store.join("type")).ok()?.trim() != "git" {
        return None;
    }
    let target = std::fs::read_to_string(store.join("git_target")).ok()?;
    let git_dir = std::fs::canonicalize(store.join(target.trim_end_matches(['\r', '\n']))).ok()?;
    let colocated = std::fs::canonicalize(root.join(".git")).is_ok_and(|own| own == git_dir);
    let repo = std::fs::canonicalize(&repo).ok()?;
    let working_copy = std::fs::canonicalize(dot.join("working_copy")).ok()?;
    Some(Repo { git_dir, colocated, op_heads: repo.join("op_heads").join("heads"), repo, working_copy })
}

/// A workspace jj reads the repository through: under Patch's own state folder, one per
/// repository and kept between reviews, so its index links are made once.
struct Shadow {
    /// The operations it was last brought up to date for.
    operations: String,
}

/// Each root's shadow, brought up to date one caller at a time.
static SHADOWS: Mutex<Option<HashMap<PathBuf, Arc<tokio::sync::Mutex<Shadow>>>>> = Mutex::new(None);

/// Where `root`'s shadow workspace is: named for the root, in a folder only the user can open.
fn shadow_dir(root: &Path) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    let name: String = digest[..8].iter().map(|byte| format!("{byte:02x}")).collect();
    let state = crate::server::state_dir();
    // A state folder in the workspace (one whose root is the home folder) would be written to.
    let resolved = std::path::absolute(&state).unwrap_or(state.clone());
    if resolved.starts_with(root) {
        return Err(format!(
            "Patch keeps a copy of jj's index in {}, which is inside this repository; set XDG_STATE_HOME elsewhere.",
            state.display()
        ));
    }
    Ok(state.join("jj").join(name))
}

/// The shadow of `root`'s workspace, brought up to date with the repository's index.
async fn shadow(root: &Path, repo: &Repo) -> Result<PathBuf> {
    let cell = SHADOWS
        .lock()
        .unwrap()
        .get_or_insert_default()
        .entry(root.to_path_buf())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(Shadow { operations: String::new() })))
        .clone();
    let mut shadow = cell.lock().await;
    let dir = shadow_dir(root)?;
    let operations = operations(repo);
    if shadow.operations != operations || operations.is_empty() {
        let (dir, real, working_copy) = (dir.clone(), repo.repo.clone(), repo.working_copy.clone());
        tokio::task::spawn_blocking(move || mirror(&dir, &real, &working_copy))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("Patch could not prepare its copy of jj's index: {error}"))?;
        shadow.operations = operations;
    }
    Ok(dir)
}

/// Makes `shadow` a workspace whose every part links to the real one's, but whose index folders
/// are its own: the real index's files are linked into them one by one, and any the repository no
/// longer has are let go. What jj wrote there itself is kept.
fn mirror(shadow: &Path, repo: &Path, working_copy: &Path) -> std::io::Result<()> {
    let jj = crate::server::state_dir().join("jj");
    std::fs::create_dir_all(&jj)?;
    #[cfg(unix)]
    std::fs::set_permissions(&jj, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    let into = shadow.join(".jj").join("repo");
    std::fs::create_dir_all(&into)?;
    link(&working_copy.to_path_buf(), &shadow.join(".jj").join("working_copy"))?;
    for entry in std::fs::read_dir(repo)? {
        let entry = entry?;
        let to = into.join(entry.file_name());
        if entry.file_name() == "index" {
            continue;
        }
        // A file of its own (an old `config.toml`, which jj may rewrite as it reads it) is copied,
        // so a rewrite lands here; folders are linked.
        if entry.file_type()?.is_file() {
            let bytes = std::fs::read(entry.path())?;
            if std::fs::read_link(&to).is_ok() || std::fs::read(&to).ok().as_ref() != Some(&bytes) {
                let _ = std::fs::remove_file(&to);
                std::fs::write(&to, bytes)?;
            }
        } else {
            link(&entry.path(), &to)?;
        }
    }
    let index = repo.join("index");
    if index.is_dir() {
        mirror_index(&index, &into.join("index"))?;
    }
    Ok(())
}

/// `at` as a link to `target`, replacing whatever else is there.
fn link(target: &PathBuf, at: &Path) -> std::io::Result<()> {
    match std::fs::read_link(at) {
        Ok(now) if &now == target => return Ok(()),
        Ok(_) => std::fs::remove_file(at)?,
        Err(_) if at.symlink_metadata().is_ok_and(|meta| meta.is_dir()) => std::fs::remove_dir_all(at)?,
        Err(_) if at.symlink_metadata().is_ok() => std::fs::remove_file(at)?,
        Err(_) => {}
    }
    #[cfg(unix)]
    return std::os::unix::fs::symlink(target, at);
    #[cfg(not(unix))]
    return Err(std::io::Error::other("Jujutsu repositories need macOS or Linux."));
}

fn mirror_index(real: &Path, shadow: &Path) -> std::io::Result<()> {
    // A folder of the shadow's own, never a link: through a link, jj would write to the real one.
    if shadow.symlink_metadata().is_ok_and(|meta| !meta.is_dir()) {
        std::fs::remove_file(shadow)?;
    }
    std::fs::create_dir_all(shadow)?;
    for entry in std::fs::read_dir(real)? {
        let entry = entry?;
        let (from, to) = (entry.path(), shadow.join(entry.file_name()));
        if entry.file_type()?.is_dir() {
            mirror_index(&from, &to)?;
        } else if to.symlink_metadata().is_err() {
            link(&from, &to)?;
        }
    }
    // Links to files the repository has let go of (after `jj util gc`) would only fail to load.
    for entry in std::fs::read_dir(shadow)? {
        let path = entry?.path();
        if std::fs::read_link(&path).is_ok() && !path.exists() {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// The workspace `directory` is in, if a Jujutsu one is nearer than any Git repository at `git`.
pub fn find_root(directory: &Path, git: Option<&Path>) -> Option<PathBuf> {
    let found = directory.ancestors().find(|dir| dir.join(".jj").is_dir())?;
    // A Git repository inside the workspace is the nearer one.
    if git.is_some_and(|git| git != found && git.starts_with(found)) {
        return None;
    }
    of(found).map(|_| found.to_path_buf())
}

/// Points Git at the repository of a workspace not colocated with it.
pub fn git_env(command: &mut tokio::process::Command, root: &Path) {
    if let Some(repo) = of(root).filter(|repo| !repo.colocated) {
        command.env("GIT_DIR", &repo.git_dir).env("GIT_WORK_TREE", root);
    }
}

/// As `git_env`, for a blocking thread.
pub fn git_env_blocking(command: &mut std::process::Command, root: &Path) {
    if let Some(repo) = of(root).filter(|repo| !repo.colocated) {
        command.env("GIT_DIR", &repo.git_dir).env("GIT_WORK_TREE", root);
    }
}

/// What changes when anything is done to the repository: its current operations.
pub fn operations(repo: &Repo) -> String {
    let mut heads: Vec<String> = std::fs::read_dir(&repo.op_heads)
        .map(|entries| entries.filter_map(|entry| Some(entry.ok()?.file_name().to_string_lossy().into_owned())).collect())
        .unwrap_or_default();
    heads.sort();
    heads.join(" ")
}

const DIVERGED: &str = "jj ran two operations at once; any jj command (such as `jj status`) merges them, then refresh.";

/// `jj` with `args`, at the current operation, through the shadow: nothing snapshotted, merged or
/// written to the repository.
async fn jj(root: &Path, args: &[&str]) -> Result<String> {
    // Two jj commands ran at once. Patch reads only what is settled, and merging them is a write;
    // even refusing to, jj touches the folder they are recorded in.
    let Some(repo) = of(root) else { return Err("Not a Jujutsu workspace.".into()) };
    let operation = operations(&repo);
    if operation.contains(' ') {
        return Err(DIVERGED.into());
    }
    let shadow = shadow(root, &repo).await?;
    // The operation seen, by its id: `@` would look again, and finding two by then, jj tidies them.
    let at = if operation.is_empty() { "--at-op=@".to_string() } else { format!("--at-op={operation}") };
    let root_arg = format!("--repository={}", shadow.display());
    let mut all = vec!["--ignore-working-copy", at.as_str(), "--no-pager", "--color=never", root_arg.as_str()];
    all.extend(args);
    // Started in the shadow: jj reads some configuration from where it starts, and may rewrite it.
    run("jj", &shadow, &all, Run::default()).await.map_err(|why| {
        // Its first line says what is wrong; the rest is hints for a terminal.
        let first = why.lines().next().unwrap_or("").trim();
        if first.contains("more than one operation") {
            return DIVERGED.into();
        }
        first.strip_prefix("Error: ").unwrap_or(first).to_string()
    })
}

/// `name` as a revset that is that name and nothing else: a bookmark named `release-` is not the
/// parents of `release`. A remote's bookmark is `"name"@"remote"`.
fn literal(name: &str) -> String {
    let quote = |text: &str| format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""));
    match name.rsplit_once('@') {
        Some((bookmark, remote)) if !bookmark.is_empty() && !remote.is_empty() => {
            format!("{}@{}", quote(bookmark), quote(remote))
        }
        _ => quote(name),
    }
}

/// The commit a name or a revset names, when it names exactly one: a bookmark (or tag, or id) by
/// that name first, so one listed in the picker is always itself, else the revset.
async fn commit(root: &Path, revset: &str) -> Result<String> {
    if let Ok(id) = one_commit(root, &literal(revset)).await {
        return Ok(id);
    }
    // Only names and the operators between them (`main@origin`, `@-`, `abc+`): a revset that
    // looks into commits' files (`files()`, `diff_contains()`) may have jj write the trees it merges
    // to answer.
    let named = revset.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_./@+-~:".contains(&byte));
    if !(named || matches!(revset, "trunk()" | "root()")) {
        return Err("Patch takes a bookmark, a commit or change id, trunk() or root(), not other revsets.".into());
    }
    one_commit(root, revset).await
}

async fn one_commit(root: &Path, revset: &str) -> Result<String> {
    let revisions = format!("--revisions={revset}");
    let out = jj(root, &["log", "--no-graph", "--limit=2", &revisions, "--template=self.commit_id() ++ \"\\n\""]).await?;
    match out.lines().collect::<Vec<_>>()[..] {
        [id] => Ok(id.to_string()),
        [] => Err(format!("{revset} names no commit.")),
        _ => Err(format!("{revset} names more than one commit.")),
    }
}

/// jj's id of the root commit, which no Git repository has.
fn is_root(id: &str) -> bool {
    id.bytes().all(|byte| byte == b'0')
}

/// The working copy as jj last recorded it.
#[derive(Clone, Debug)]
pub struct WorkingCopy {
    /// The commit it sits on: its first parent (none on the root commit).
    pub head: Option<String>,
    /// A bookmark on it or its parent, else its change id.
    pub name: String,
    /// Its own commit, as last snapshotted: which files jj tracks in it.
    pub commit: String,
    /// It merges several parents, whose merged tree Git can't diff against.
    pub merge: bool,
    /// Its parents besides the first, for where a branch that merges them left its base.
    pub other_parents: Vec<String>,
    /// A parent holds conflicts, which jj stores in its tree as files of its own.
    pub conflicted: bool,
}

pub async fn working_copy(root: &Path) -> Result<WorkingCopy> {
    let template = concat!(
        r#"self.change_id().short(8) ++ "\0" ++ self.parents().map(|c| c.commit_id()).join(" ") ++ "\0" ++ "#,
        r#"self.local_bookmarks().map(|b| b.name()).join(" ") ++ "\0" ++ "#,
        r#"self.parents().map(|c| c.local_bookmarks().map(|b| b.name()).join(" ")).join(" ") ++ "\0" ++ "#,
        r#"self.commit_id() ++ "\0" ++ if(self.parents().any(|c| c.conflict()), "1", "0")"#,
    );
    let out = jj(root, &["log", "--no-graph", "--revisions=@", &format!("--template={template}")]).await?;
    let fields: Vec<&str> = out.split('\0').collect();
    let [change, parents, own, parents_own, commit, conflicted] = fields[..] else {
        return Err("jj said what Patch can't read about the working copy.".into());
    };
    let parents: Vec<&str> = parents.split(' ').filter(|id| !id.is_empty()).collect();
    let head = parents.first().filter(|id| !is_root(id)).map(|id| id.to_string());
    let name = own.split(' ').chain(parents_own.split(' ')).find(|name| !name.is_empty()).unwrap_or(change.trim());
    Ok(WorkingCopy {
        head,
        name: name.to_string(),
        commit: commit.trim().to_string(),
        merge: parents.len() > 1,
        other_parents: parents.iter().skip(1).filter(|id| !is_root(id)).map(|id| id.to_string()).collect(),
        conflicted: conflicted.trim() == "1",
    })
}

/// Whether a commit holds conflicts, which jj stores in its tree as files of its own.
pub async fn is_conflicted(root: &Path, id: &str) -> bool {
    let revisions = format!("--revisions={}", literal(id));
    let out = jj(root, &["log", "--no-graph", &revisions, r#"--template=if(self.conflict(), "1", "0")"#]).await;
    out.is_ok_and(|out| out.trim() == "1")
}

/// The paths a sparse workspace keeps on disk, or none when it keeps them all.
pub async fn sparse(root: &Path) -> Result<Option<Vec<String>>> {
    let out = jj(root, &["sparse", "list"]).await?;
    let paths: Vec<String> =
        out.lines().map(|line| line.trim_end_matches('/').to_string()).filter(|line| !line.is_empty()).collect();
    Ok((!paths.iter().any(|path| path == ".")).then_some(paths))
}

/// The bookmark a change would land on: the requested revset, else `trunk()` by its bookmark's
/// name, else a local main, master or trunk; never the root commit, which no repository has.
pub async fn find_base(root: &Path, requested: Option<&str>) -> Result<Option<String>> {
    if let Some(requested) = requested {
        commit(root, requested).await.map_err(|why| format!("Base {requested} is not a commit here: {why}"))?;
        return Ok(Some(requested.to_string()));
    }
    let template = concat!(
        r#"self.commit_id() ++ "\0" ++ self.local_bookmarks().map(|b| b.name()).join(" ") ++ "\0" ++ "#,
        r#"self.remote_bookmarks().filter(|b| b.remote() != "git").map(|b| b.name() ++ "@" ++ b.remote()).join(" ")"#,
    );
    let out = jj(root, &["log", "--no-graph", "--revisions=trunk()", &format!("--template={template}")]).await?;
    let mut fields = out.split('\0');
    let (id, local, remote) = (fields.next().unwrap_or(""), fields.next().unwrap_or(""), fields.next().unwrap_or(""));
    // `trunk()` is only ever a remote's bookmark; a repository never pushed has a local one.
    if id.is_empty() || is_root(id) {
        for name in ["main", "master", "trunk"] {
            if one_commit(root, &format!("present({name})")).await.is_ok_and(|id| !is_root(&id)) {
                return Ok(Some(name.into()));
            }
        }
        return Ok(None);
    }
    let name = local.split(' ').chain(remote.split(' ')).find(|name| !name.is_empty());
    Ok(Some(name.map(String::from).unwrap_or_else(|| "trunk()".into())))
}

/// The commit a base names, for Git to find where the change branched off it; the root commit,
/// which no Git repository has, is the empty tree.
pub async fn base_commit(root: &Path, base: &str) -> Option<String> {
    let id = commit(root, base).await.ok()?;
    Some(if is_root(&id) { crate::git::EMPTY_TREE.to_string() } else { id })
}

/// Local and remote bookmarks, most recently committed first; Git's own refs of a colocated
/// repository (`@git`) are the same bookmarks again.
pub async fn bookmarks(root: &Path) -> Result<Vec<String>> {
    let template =
        r#"if(!self.remote() || self.remote() != "git", self.name() ++ if(self.remote(), "@" ++ self.remote()) ++ "\n")"#;
    let out =
        jj(root, &["bookmark", "list", "--all-remotes", "--sort=committer-date-", &format!("--template={template}")]).await?;
    let mut seen = std::collections::HashSet::new();
    Ok(out.lines().filter(|name| !name.is_empty() && seen.insert(name.to_string())).take(300).map(String::from).collect())
}

#[cfg(test)]
mod tests {
    use super::literal;

    #[test]
    fn a_name_is_only_itself() {
        assert_eq!(literal("release-"), r#""release-""#);
        assert_eq!(literal("main@origin"), r#""main"@"origin""#);
        assert_eq!(literal(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(literal("@"), r#""@""#);
    }
}
