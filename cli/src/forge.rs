//! Which forge a repository's pull requests are on, GitHub or GitLab, and reading them from it.
//! Its first remote (origin, if it has one) says, when its host is github.com, or gitlab.com or
//! one named for GitLab that `glab` is set up for; otherwise `gh` is asked whether it knows the
//! repository, then each GitLab `glab` is set up for whether it has a remote's project. No other
//! host is ever sent `glab`'s credentials.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::git::Result;
use crate::github::{self, PullRequestDiff};
use crate::gitlab::{self, Project};
use crate::protocol::{Forge, PullRequest};

/// The forge, and for GitLab the project there.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Found {
    GitHub,
    GitLab(Project),
}

const NO_FORGE: &str = "This repository has no GitHub or GitLab remote.";

type Cell = std::sync::Arc<tokio::sync::OnceCell<Found>>;
static FORGES: Mutex<Option<HashMap<PathBuf, Cell>>> = Mutex::new(None);

async fn find(root: &Path) -> Result<Found> {
    let cell = FORGES.lock().unwrap().get_or_insert_default().entry(root.to_path_buf()).or_default().clone();
    cell.get_or_try_init(|| detect(root)).await.cloned()
}

/// What the first remote's URL says without asking anyone: GitHub's host, GitLab's own, or one
/// named for GitLab.
fn by_name(urls: &[String]) -> Option<Found> {
    let url = urls.first()?;
    let host = github::url_host(url)?;
    if host == "github.com" || host == "ssh.github.com" {
        Some(Found::GitHub)
    } else if host == "gitlab.com" || host.split('.').any(|part| part == "gitlab") {
        Project::of_remote(url).map(Found::GitLab)
    } else {
        None
    }
}

/// Whether GitLab has the project. Only a yes is kept: a no may be a network down or a login
/// not yet made, which the next ask finds put right.
async fn on_gitlab(project: &Project) -> bool {
    static FOUND: Mutex<Option<HashMap<(String, String), ()>>> = Mutex::new(None);
    let key = (project.host.clone(), project.path.clone());
    if FOUND.lock().unwrap().as_ref().is_some_and(|found| found.contains_key(&key)) {
        return true;
    }
    let found = project.exists().await;
    if found {
        FOUND.lock().unwrap().get_or_insert_default().insert(key, ());
    }
    found
}

/// The project on the host its API is on, when its remote names the host's SSH name instead.
/// The project on the host its API is on, when its remote names the host's SSH name instead, and
/// by its path there, without the folder GitLab is installed under.
fn on_api_host(mut project: Project, configured: &[gitlab::Configured]) -> Project {
    if let Some(known) = configured.iter().find(|known| known.ssh_host.as_deref() == Some(project.host.as_str())) {
        project.host = known.name.clone();
    }
    let subfolder = configured.iter().find(|known| known.name == project.host).and_then(|known| known.subfolder.as_deref());
    if let Some(path) = subfolder.and_then(|subfolder| project.path.strip_prefix(subfolder)?.strip_prefix('/')) {
        project.path = path.to_string();
    }
    project
}

/// Whether `glab` may be sent to the project's host with whatever credentials it has: GitLab's
/// own, or one it is set up for. An older `glab` sends a token it was given for one host to any.
fn trusted(project: &Project, configured: &[gitlab::Configured]) -> bool {
    project.host == "gitlab.com" || configured.iter().any(|known| known.name == project.host)
}

/// The remotes' URLs, origin's first.
async fn remote_urls(root: &Path) -> Vec<String> {
    let remotes = crate::git::git(root, &["remote", "-v"]).await.unwrap_or_default();
    let mut remotes: Vec<(&str, &str)> = remotes
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            Some((words.next()?, words.next()?))
        })
        .collect();
    remotes.sort_by_key(|(name, _)| *name != "origin");
    let mut urls: Vec<String> = remotes.into_iter().map(|(_, url)| url.to_string()).collect();
    urls.dedup();
    urls
}

async fn detect(root: &Path) -> Result<Found> {
    let urls = remote_urls(root).await;
    match by_name(&urls) {
        Some(Found::GitHub) => return Ok(Found::GitHub),
        // A name says which forge it is, but not that it may have credentials.
        Some(Found::GitLab(project)) => {
            let configured = gitlab::configured().await;
            let project = on_api_host(project, &configured);
            if trusted(&project, &configured) {
                return Ok(Found::GitLab(project));
            }
        }
        None => {}
    }
    let github = match github::host(root).await {
        Ok(_) => return Ok(Found::GitHub),
        Err(why) => why,
    };
    // A host whose name says nothing is asked about only when `glab` is set up for it.
    let configured = gitlab::configured().await;
    for project in urls.iter().filter_map(|url| Project::of_remote(url)) {
        let project = on_api_host(project, &configured);
        if trusted(&project, &configured) && on_gitlab(&project).await {
            return Ok(Found::GitLab(project));
        }
    }
    Err(if github == github::NO_GITHUB { NO_FORGE.into() } else { github })
}

/// The repository's forge, for the page to name its pull or merge requests.
pub async fn of(root: &Path) -> Result<Forge> {
    Ok(match find(root).await? {
        Found::GitHub => Forge::Github,
        Found::GitLab(_) => Forge::Gitlab,
    })
}

/// The forge as far as the remotes and `glab`'s configuration tell, without asking any forge:
/// GitLab's, or else GitHub's, which `gh` may know a repository on even with no remote at all
/// (`GH_REPO`).
pub async fn named(root: &Path) -> Forge {
    if let Some(found) = FORGES.lock().unwrap().as_ref().and_then(|forges| forges.get(root)?.get().cloned()) {
        return if matches!(found, Found::GitLab(_)) { Forge::Gitlab } else { Forge::Github };
    }
    let urls = remote_urls(root).await;
    if matches!(by_name(&urls), Some(Found::GitHub)) {
        return Forge::Github;
    }
    // GitLab's own, or a host `glab` is set up for, whatever its name.
    let configured = gitlab::configured().await;
    let known = |project: Project| trusted(&on_api_host(project, &configured), &configured);
    if urls.iter().filter_map(|url| Project::of_remote(url)).any(known) { Forge::Gitlab } else { Forge::Github }
}

/// How the review of one is labelled: GitHub numbers them `#`, GitLab `!`.
pub fn label(forge: Forge, number: u64, title: &str) -> String {
    match forge {
        Forge::Github => format!("PR #{number} {title}"),
        Forge::Gitlab => format!("MR !{number} {title}"),
    }
}

pub async fn read_pull_request(root: &Path, number: u64) -> Result<(Forge, PullRequestDiff)> {
    match find(root).await? {
        Found::GitHub => Ok((Forge::Github, github::read_pull_request(root, number).await?)),
        Found::GitLab(project) => Ok((Forge::Gitlab, gitlab::read_merge_request(&project, number).await?)),
    }
}

/// Commits' diff from the forge, for a partial clone without their contents.
pub async fn read_commits(
    root: &Path,
    parent: &str,
    first: &str,
    to: &str,
) -> Result<(String, Vec<(Option<String>, Option<String>)>)> {
    match find(root).await? {
        Found::GitHub => github::read_commits(root, parent, first, to).await,
        Found::GitLab(project) => {
            // How many files the first commit has, to tell whether GitLab listed them all.
            let files = if parent == crate::git::EMPTY_TREE {
                let listed = crate::git::git(root, &["ls-tree", "-r", "-z", "--name-only", "--end-of-options", to]).await;
                listed.ok().map(|listed| listed.split('\0').filter(|path| !path.is_empty()).count())
            } else {
                None
            };
            gitlab::read_commits(&project, parent, first, to, files).await
        }
    }
}

/// A file at a commit, from the forge.
pub async fn read_remote_bytes(root: &Path, sha: &str, path: &str, limit: u64) -> Result<Vec<u8>> {
    match find(root).await? {
        Found::GitHub => github::read_remote_bytes(root, sha, path, limit).await,
        Found::GitLab(project) => gitlab::read_remote_bytes(&project, sha, path, limit).await,
    }
}

/// A page of pull or merge requests. A GitHub search spells out the repository, which
/// `repository` finds once.
pub async fn list(
    root: &Path,
    repository: impl AsyncFnOnce() -> Result<String>,
    query: &str,
    after: Option<&str>,
) -> Result<(Forge, Vec<PullRequest>, Option<String>)> {
    match find(root).await? {
        Found::GitHub => {
            let name = if query.trim().is_empty() { None } else { Some(repository().await?) };
            let (pulls, next) = github::list_pull_requests(root, name.as_deref(), query, after).await?;
            Ok((Forge::Github, pulls, next))
        }
        Found::GitLab(project) => {
            let (pulls, next) = gitlab::list_merge_requests(&project, query, after).await?;
            Ok((Forge::Gitlab, pulls, next))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_named_for_its_forge_says_which_it_is() {
        let urls = |urls: &[&str]| urls.iter().map(|url| url.to_string()).collect::<Vec<_>>();
        let gitlab = |host: &str, path: &str| Some(Found::GitLab(Project { host: host.into(), path: path.into() }));
        assert_eq!(by_name(&urls(&["git@github.com:a/b.git"])), Some(Found::GitHub));
        assert_eq!(by_name(&urls(&["https://gitlab.com/a/b", "git@github.com:a/b"])), gitlab("gitlab.com", "a/b"));
        assert_eq!(by_name(&urls(&["git@github.com:a/b", "https://gitlab.com/a/b"])), Some(Found::GitHub));
        assert_eq!(by_name(&urls(&["git@gitlab.corp.example:t/r.git"])), gitlab("gitlab.corp.example", "t/r"));
        assert_eq!(by_name(&urls(&["https://notgitlab.example/a/b"])), None);
        assert_eq!(by_name(&urls(&["https://ghe.corp.example/a/b"])), None);
        assert_eq!(by_name(&[]), None);
    }
}
