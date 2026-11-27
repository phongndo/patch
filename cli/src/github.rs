//! Pull requests through the GitHub CLI. Nothing is fetched into the
//! repository. The pull request's head and base are read once; its diff and
//! where it branched off are then asked for between exactly those commits, so
//! the patch and every file read for it are of one snapshot, whatever is pushed
//! meanwhile. Its old side is where it branched off, as GitHub diffs it, not the
//! base's tip.

use std::path::Path;

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

async fn gh(root: &Path, args: &[&str]) -> Result<String> {
    run("gh", root, args, Run::default()).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    number: u64,
    title: String,
    author: Author,
    head_ref_name: String,
    base_ref_name: String,
    updated_at: String,
    is_draft: bool,
}

#[derive(Deserialize)]
struct Author {
    login: String,
}

pub async fn list_pull_requests(root: &Path, query: &str) -> Result<Vec<PullRequest>> {
    let mut args = vec![
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "30",
        "--json",
        "number,title,author,headRefName,baseRefName,updatedAt,isDraft",
    ];
    let query = query.trim();
    if !query.is_empty() {
        args.extend(["--search", query]);
    }
    let rows: Vec<Row> = serde_json::from_str(&gh(root, &args).await?).map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| PullRequest {
            number: row.number,
            title: row.title,
            author: row.author.login,
            head: row.head_ref_name,
            base: row.base_ref_name,
            updated: row.updated_at,
            draft: row.is_draft,
        })
        .collect())
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
    let compare = format!("repos/{{owner}}/{{repo}}/compare/{}...{}", view.base_ref_oid, view.head_ref_oid);
    // Where it branched off, and each file's names, which its patch's header lines may not tell
    // apart (a binary file named "x and b/y.png").
    let shape = "{base: .merge_base_commit.sha, files: [.files[] | {filename, previous_filename, status}]}";
    let (compared_args, diff_args) =
        (["api", compare.as_str(), "--jq", shape], ["api", "-H", "Accept: application/vnd.github.diff", compare.as_str()]);
    let (compared, patch) = tokio::join!(gh(root, &compared_args), gh(root, &diff_args));
    let (compared, patch) = (compared?, patch?);
    let compared: Compared = serde_json::from_str(&compared).map_err(|error| error.to_string())?;
    let merge_base = compared.base.trim();
    if merge_base.len() < 40 || !merge_base.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("GitHub did not say where pull request #{number} branched off."));
    }
    let files = compared
        .files
        .into_iter()
        .map(|file| {
            let old = (file.status != "added").then(|| file.previous_filename.unwrap_or_else(|| file.filename.clone()));
            let new = (file.status != "removed").then_some(file.filename);
            (old, new)
        })
        .collect();
    Ok(PullRequestDiff {
        number: view.number,
        title: view.title,
        base_sha: merge_base.to_string(),
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
    run_bytes("gh", root, &["api", "-H", "Accept: application/vnd.github.raw", &blob], Run::default(), limit).await
}

/// The same as text.
pub async fn read_remote_file(root: &Path, sha: &str, path: &str) -> Result<String> {
    let bytes = read_remote_bytes(root, sha, path, 64 * 1024 * 1024).await?;
    Ok(String::from_utf8(bytes).unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned()))
}
