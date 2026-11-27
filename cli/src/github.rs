//! Pull requests through the GitHub CLI. Nothing is fetched into the
//! repository. The pull request's head and base are read once; its diff and
//! where it branched off are then asked for between exactly those commits, so
//! the patch and every file read for it are of one snapshot, whatever is pushed
//! meanwhile. Its old side is where it branched off, as GitHub diffs it, not the
//! base's tip.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;

use crate::git::{NOT_FILE, Result, Run, TOO_LARGE, run, run_bytes};
use crate::protocol::PullRequest;

pub struct PullRequestDiff {
    pub number: u64,
    pub title: String,
    pub base_sha: String,
    pub head_sha: String,
    pub patch: String,
    /// Each file's paths before and after, as GitHub compared them, in the patch's order.
    pub files: Vec<(Option<String>, Option<String>)>,
}

#[derive(Deserialize)]
struct Compared {
    base: String,
    files: Vec<ComparedFile>,
}

#[derive(Deserialize)]
struct ComparedFile {
    filename: String,
    previous_filename: Option<String>,
    status: String,
}

impl ComparedFile {
    /// Its paths before and after.
    fn sides(self) -> (Option<String>, Option<String>) {
        let old = (self.status != "added").then(|| self.previous_filename.unwrap_or_else(|| self.filename.clone()));
        let new = (self.status != "removed").then_some(self.filename);
        (old, new)
    }
}

pub const NO_GITHUB: &str = "This repository has no GitHub remote.";

/// Each repository's GitHub host, found once however many ask at the same time.
type Host = std::sync::Arc<tokio::sync::OnceCell<String>>;
static HOSTS: Mutex<Option<HashMap<PathBuf, Host>>> = Mutex::new(None);

/// Where a remote's URL points: `https://host/…`, `ssh://user@host:port/…` or `user@host:…`.
fn url_host(url: &str) -> Option<String> {
    let host = match url.split_once("://") {
        Some((scheme, rest)) if scheme != "file" => rest.split('/').next()?.rsplit('@').next()?.split(':').next()?,
        Some(_) => return None,
        None => url.split_once(':')?.0.rsplit('@').next()?,
    };
    (!host.is_empty() && !host.contains('/')).then(|| host.to_ascii_lowercase())
}

/// The GitHub host `gh` reads this repository from: github.com when every remote is there, else
/// as `gh` resolves it, for GitHub Enterprise. `gh api` alone would ask its default host.
async fn host(root: &Path) -> Result<String> {
    let cell = HOSTS.lock().unwrap().get_or_insert_default().entry(root.to_path_buf()).or_default().clone();
    cell.get_or_try_init(|| find_host(root)).await.cloned()
}

async fn find_host(root: &Path) -> Result<String> {
    let remotes = crate::git::git(root, &["remote", "-v"]).await.unwrap_or_default();
    let hosts: Vec<String> = remotes.lines().filter_map(|line| url_host(line.split_whitespace().nth(1)?)).collect();
    let github = |host: &String| host == "github.com" || host == "ssh.github.com";
    let host = if hosts.iter().all(github) {
        "github.com".to_string()
    } else {
        let url = run("gh", root, &["repo", "view", "--json", "url", "--jq", ".url"], Run::default())
            .await
            .map_err(|error| if error.contains("known GitHub host") { NO_GITHUB.to_string() } else { error })?;
        url_host(url.trim()).ok_or_else(|| NO_GITHUB.to_string())?
    };
    Ok(host)
}

/// `args` for `gh`, an API request sent to the repository's own host.
async fn on_host(root: &Path, args: &[&str]) -> Result<Vec<String>> {
    let mut all: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    if args.first() == Some(&"api") {
        all.splice(1..1, ["--hostname".to_string(), host(root).await?]);
    }
    Ok(all)
}

async fn gh(root: &Path, args: &[&str]) -> Result<String> {
    let args = on_host(root, args).await?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run("gh", root, &args, Run::default())
        .await
        .map_err(|error| if error.contains("known GitHub host") { NO_GITHUB.to_string() } else { error })
}

/// What GitHub compares between two commits: where they branched off, the patch from there,
/// and each file's paths before and after, in the patch's order.
struct Comparison {
    merge_base: String,
    patch: String,
    files: Vec<(Option<String>, Option<String>)>,
}

async fn compare(root: &Path, base: &str, head: &str) -> Result<Comparison> {
    let compare = format!("repos/{{owner}}/{{repo}}/compare/{base}...{head}");
    // Where it branched off, and each file's names, which its patch's header lines may not tell
    // apart (a binary file named "x and b/y.png").
    let shape = "{base: .merge_base_commit.sha, files: [.files[] | {filename, previous_filename, status}]}";
    let (compared_args, diff_args) =
        (["api", compare.as_str(), "--jq", shape], ["api", "-H", "Accept: application/vnd.github.diff", compare.as_str()]);
    let (compared, patch) = tokio::join!(gh(root, &compared_args), gh(root, &diff_args));
    let (compared, patch) = (compared?, patch?);
    let compared: Compared = serde_json::from_str(&compared).map_err(|error| error.to_string())?;
    let merge_base = compared.base.trim().to_string();
    if merge_base.len() < 40 || !merge_base.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("GitHub did not say where the change branched off.".into());
    }
    let files = compared.files.into_iter().map(ComparedFile::sides).collect();
    Ok(Comparison { merge_base, patch, files })
}

/// Commits' diff from GitHub, from `parent` to `to`, the first being `first`: for a partial clone
/// without their contents.
pub async fn read_commits(
    root: &Path,
    parent: &str,
    first: &str,
    to: &str,
) -> Result<(String, Vec<(Option<String>, Option<String>)>)> {
    // The first commit has no parent to compare with; GitHub diffs it alone, but no run from it.
    if parent == crate::git::EMPTY_TREE {
        if first != to {
            return Err("GitHub diffs no run of commits from the very first one.".into());
        }
        let commit = format!("repos/{{owner}}/{{repo}}/commits/{to}");
        let shape = "[.files[] | {filename, previous_filename, status}]";
        let (listed_args, diff_args) =
            (["api", commit.as_str(), "--jq", shape], ["api", "-H", "Accept: application/vnd.github.diff", commit.as_str()]);
        let (listed, patch) = tokio::join!(gh(root, &listed_args), gh(root, &diff_args));
        let listed: Vec<ComparedFile> = serde_json::from_str(&listed?).map_err(|error| error.to_string())?;
        return Ok((patch?, listed.into_iter().map(ComparedFile::sides).collect()));
    }
    let comparison = compare(root, parent, to).await?;
    // GitHub diffs from where the two met; only from the parent itself is it these commits' diff.
    if comparison.merge_base != parent {
        return Err("GitHub's diff of these commits starts elsewhere.".into());
    }
    Ok((comparison.patch, comparison.files))
}

/// The pull requests a page lists at a time.
const PULLS_PAGE: usize = 30;
const PULL_FIELDS: &str = "number title state isDraft updatedAt headRefName baseRefName author { login }";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pull {
    number: u64,
    title: String,
    state: String,
    is_draft: bool,
    updated_at: String,
    head_ref_name: String,
    base_ref_name: String,
    /// None for an account that no longer exists.
    author: Option<Author>,
}

#[derive(Deserialize)]
struct Author {
    login: String,
}

impl From<Pull> for PullRequest {
    fn from(pull: Pull) -> PullRequest {
        PullRequest {
            number: pull.number,
            title: pull.title,
            author: pull.author.map(|author| author.login).unwrap_or_else(|| "ghost".into()),
            head: pull.head_ref_name,
            base: pull.base_ref_name,
            updated: pull.updated_at,
            draft: pull.is_draft,
            state: pull.state.to_lowercase(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    /// A search's hits that are no pull request are empty objects, and dropped.
    nodes: Vec<serde_json::Value>,
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

/// `owner/name` of the repository `gh` works with here, which a search must spell out.
pub async fn repository(root: &Path) -> Result<String> {
    let query = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner } }";
    let args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", &format!("query={query}")];
    let name = gh(root, &[&args[..], &["--jq", ".data.repository.nameWithOwner"]].concat()).await?;
    let name = name.trim();
    if name.split_once('/').is_none_or(|(owner, repo)| owner.is_empty() || repo.is_empty()) {
        return Err(NO_GITHUB.into());
    }
    Ok(name.to_string())
}

/// One page of a GraphQL connection of pull requests, at `path` in the answer, and the cursor of
/// the next page if there is one.
async fn pulls_page(
    root: &Path,
    query: &str,
    variables: &[(&str, String)],
    path: &str,
) -> Result<(Vec<PullRequest>, Option<String>)> {
    let mut args = vec!["api".to_string(), "graphql".into(), "-f".into(), format!("query={query}")];
    for (flag, variable) in variables {
        args.extend([flag.to_string(), variable.clone()]);
    }
    args.extend(["--jq".into(), path.into()]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let page: Connection = serde_json::from_str(&gh(root, &args).await?).map_err(|error| error.to_string())?;
    let pulls =
        page.nodes.into_iter().filter_map(|node| serde_json::from_value::<Pull>(node).ok()).map(PullRequest::from).collect();
    Ok((pulls, page.page_info.end_cursor.filter(|_| page.page_info.has_next_page)))
}

/// A page of pull requests, newest activity first, and the cursor of the next: the open ones, or
/// those GitHub's search finds for `query` (open unless it says otherwise). A number, or `#` and
/// a number, also finds that pull request first, whatever its state.
/// A search spells the repository out, so it needs `repository`; listing them does not.
pub async fn list_pull_requests(
    root: &Path,
    repository: Option<&str>,
    query: &str,
    after: Option<&str>,
) -> Result<(Vec<PullRequest>, Option<String>)> {
    let query = query.trim();
    // `gh` names the repository itself where a field is just `{owner}` or `{repo}`; the rest are
    // strings, which -F would take for numbers when they look like them.
    let here = [("-F", "owner={owner}".to_string()), ("-F", "name={repo}".to_string())];
    let after: Vec<(&str, String)> = after.map(|after| ("-f", format!("after={after}"))).into_iter().collect();
    let page = async {
        if query.is_empty() {
            let graphql = format!(
                "query($owner: String!, $name: String!, $after: String) {{ repository(owner: $owner, name: $name) {{ \
                 pullRequests(states: OPEN, first: {PULLS_PAGE}, after: $after, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{ \
                 nodes {{ {PULL_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }} }} }}"
            );
            pulls_page(root, &graphql, &[&here[..], &after[..]].concat(), ".data.repository.pullRequests").await
        } else {
            let repository = repository.ok_or_else(|| NO_GITHUB.to_string())?;
            let words: Vec<&str> = query.split_whitespace().collect();
            // A state, or a date only a closed or merged one has, chooses its own pull requests.
            let stated = words.iter().any(|word| {
                ["is:open", "is:closed", "is:merged", "is:unmerged"].contains(word)
                    || ["state:", "merged:", "closed:", "-is:"].iter().any(|prefix| word.starts_with(prefix))
            });
            let sorted = words.iter().any(|word| word.starts_with("sort:"));
            let search = format!(
                "repo:{repository} is:pr {}{query}{}",
                if stated { "" } else { "is:open " },
                if sorted { "" } else { " sort:updated-desc" }
            );
            let graphql = format!(
                "query($q: String!, $after: String) {{ search(query: $q, type: ISSUE, first: {PULLS_PAGE}, after: $after) {{ \
                 nodes {{ ... on PullRequest {{ {PULL_FIELDS} }} }} pageInfo {{ hasNextPage endCursor }} }} }}"
            );
            let variables = [&after[..], &[("-f", format!("q={search}"))]].concat();
            pulls_page(root, &graphql, &variables, ".data.search").await
        }
    };
    // Asked for by its number: found on the first page, open or not.
    let number = query.strip_prefix('#').unwrap_or(query).parse::<u64>().ok().filter(|_| after.is_empty());
    let exact = async {
        let number = number?;
        let graphql = format!(
            "query($owner: String!, $name: String!, $number: Int!) {{ repository(owner: $owner, name: $name) {{ \
             pullRequest(number: $number) {{ {PULL_FIELDS} }} }} }}"
        );
        let args = [
            "api",
            "graphql",
            "-f",
            &format!("query={graphql}"),
            "-F",
            "owner={owner}",
            "-F",
            "name={repo}",
            "-F",
            &format!("number={number}"),
            "--jq",
            ".data.repository.pullRequest",
        ];
        let found = gh(root, &args).await.ok()?;
        serde_json::from_str::<Pull>(&found).ok().map(PullRequest::from)
    };
    let (page, exact) = tokio::join!(page, exact);
    let (mut pulls, next) = page?;
    if let Some(exact) = exact {
        pulls.retain(|pull| pull.number != exact.number);
        pulls.insert(0, exact);
    }
    Ok((pulls, next))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct View {
    number: u64,
    title: String,
    base_ref_oid: String,
    head_ref_oid: String,
}

pub async fn read_pull_request(root: &Path, number: u64) -> Result<PullRequestDiff> {
    let number = number.to_string();
    let view: View =
        serde_json::from_str(&gh(root, &["pr", "view", &number, "--json", "number,title,url,baseRefOid,headRefOid"]).await?)
            .map_err(|error| error.to_string())?;
    let Comparison { merge_base, patch, files } = compare(root, &view.base_ref_oid, &view.head_ref_oid).await?;
    Ok(PullRequestDiff {
        number: view.number,
        title: view.title,
        base_sha: merge_base,
        head_sha: view.head_ref_oid,
        patch,
        files,
    })
}

#[derive(Deserialize)]
struct Tree {
    tree: Vec<TreeEntry>,
}

#[derive(Deserialize)]
struct TreeEntry {
    path: String,
    mode: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
    size: Option<u64>,
}

/// A regular file at a commit, found by walking its Git trees one folder at a time: each entry
/// says what it is (a link, a submodule) and is never followed, and no listing is cut short.
async fn remote_blob(root: &Path, sha: &str, path: &str) -> Result<(String, u64)> {
    let commit = format!("repos/{{owner}}/{{repo}}/git/commits/{sha}");
    let mut tree = gh(root, &["api", &commit, "--jq", ".tree.sha"]).await?.trim().to_string();
    let parts: Vec<&str> = path.split('/').collect();
    for (at, part) in parts.iter().enumerate() {
        let listed = gh(root, &["api", &format!("repos/{{owner}}/{{repo}}/git/trees/{tree}")]).await?;
        let listed: Tree = serde_json::from_str(&listed).map_err(|_| NOT_FILE.to_string())?;
        let entry = listed.tree.into_iter().find(|entry| entry.path == *part).ok_or_else(|| NOT_FILE.to_string())?;
        if at + 1 < parts.len() {
            if entry.kind != "tree" {
                return Err(NOT_FILE.into());
            }
            tree = entry.sha;
        } else if entry.kind == "blob" && matches!(entry.mode.as_str(), "100644" | "100755") {
            return Ok((entry.sha, entry.size.unwrap_or(0)));
        }
    }
    Err(NOT_FILE.into())
}

/// A file at a commit, from the repository's GitHub remote: its blob, by id.
pub async fn read_remote_bytes(root: &Path, sha: &str, path: &str, limit: u64) -> Result<Vec<u8>> {
    let (blob, size) = remote_blob(root, sha, path).await?;
    if size > limit {
        return Err(TOO_LARGE.into());
    }
    let blob = format!("repos/{{owner}}/{{repo}}/git/blobs/{blob}");
    let args = on_host(root, &["api", "-H", "Accept: application/vnd.github.raw", &blob]).await?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_bytes("gh", root, &args, Run::default(), limit).await
}

#[cfg(test)]
mod tests {
    use super::url_host;

    #[test]
    fn a_remote_names_its_host_in_every_form_git_takes() {
        let host = |url: &str| url_host(url);
        assert_eq!(host("https://github.com/llvm/llvm-project.git").as_deref(), Some("github.com"));
        assert_eq!(host("https://token@GHE.corp.example:8443/a/b").as_deref(), Some("ghe.corp.example"));
        assert_eq!(host("ssh://git@ssh.github.com:443/a/b.git").as_deref(), Some("ssh.github.com"));
        assert_eq!(host("git@ghe.corp.example:team/repo.git").as_deref(), Some("ghe.corp.example"));
        assert_eq!(host("file:///tmp/repo"), None);
        assert_eq!(host("/tmp/repo"), None);
        assert_eq!(host("../repo"), None);
    }
}
