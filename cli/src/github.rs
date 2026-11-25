//! Pull requests through the GitHub CLI. Nothing is fetched into the
//! repository: the diff comes from `gh pr diff`, and file contents for context
//! come from the API at the pull request's commits.

use std::path::Path;

use serde::Deserialize;

use crate::git::{Result, Run, run};
use crate::protocol::PullRequest;

pub struct PullRequestDiff {
    pub number: u64,
    pub title: String,
    pub base_sha: String,
    pub head_sha: String,
    pub patch: String,
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
    let patch = gh(root, &["pr", "diff", &number, "--color", "never"]).await?;
    Ok(PullRequestDiff {
        number: view.number,
        title: view.title,
        base_sha: view.base_ref_oid,
        head_sha: view.head_ref_oid,
        patch,
    })
}

fn encode_segment(segment: &str) -> String {
    let mut out = String::new();
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A file at a commit, from the repository's GitHub remote.
pub async fn read_remote_file(root: &Path, sha: &str, path: &str) -> Result<String> {
    let encoded: Vec<String> = path.split('/').map(encode_segment).collect();
    let endpoint = format!("repos/{{owner}}/{{repo}}/contents/{}?ref={sha}", encoded.join("/"));
    gh(root, &["api", "-H", "Accept: application/vnd.github.raw", &endpoint]).await
}
