//! The JSON the page and the server exchange. It mirrors `src/protocol.ts`,
//! which the page imports; field names follow it exactly.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    All,
    Uncommitted,
    Staged,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Mode> {
        match value {
            "all" => Some(Mode::All),
            "uncommitted" => Some(Mode::Uncommitted),
            "staged" => Some(Mode::Staged),
            _ => None,
        }
    }
}

/// What keeps the repository's history.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Vcs {
    Git,
    Jj,
}

/// Where its pull requests are: GitHub's, or GitLab's merge requests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Forge {
    Github,
    Gitlab,
}

/// What is under review: a view of the working tree, a run of commits, or a pull request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Scope {
    All {
        #[serde(skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
    Uncommitted {
        #[serde(skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
    Staged {
        #[serde(skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
    Commits {
        from: String,
        to: String,
    },
    Pr {
        number: u64,
    },
}

impl Scope {
    pub fn view(mode: Mode, base: Option<String>) -> Scope {
        match mode {
            Mode::All => Scope::All { base },
            Mode::Uncommitted => Scope::Uncommitted { base },
            Mode::Staged => Scope::Staged { base },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub file: String,
    /// "additions" or "deletions".
    pub side: String,
    /// The first line, or 0 for the whole file, or with no file the whole change.
    pub start: u64,
    pub end: u64,
    pub body: String,
    #[serde(default)]
    pub excerpt: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResponse {
    pub repository: String,
    pub branch: String,
    pub scope: Scope,
    pub scope_key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    pub vcs: Vcs,
    /// Where a pull request under review was read from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forge: Option<Forge>,
    pub patch: String,
    /// Names this run, so a reloaded tab finds its own comments and no other run's.
    pub session: String,
    /// Names this read of the review: an image is served only to the read it belongs to.
    pub read: u64,
    /// Each changed file's paths as Git recorded them, in the patch's order; none for a pull request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<ChangedPaths>>,
}

/// A changed file's paths before and after; one it lacks, or cannot name in UTF-8, is absent.
#[derive(Debug, Serialize)]
pub struct ChangedPaths {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub when: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopesResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    pub branches: Vec<String>,
    /// Where its pull requests are, as far as its remote's name tells.
    pub forge: Forge,
}

/// `/api/commits`: a page of the history of HEAD, newest first, or of the commits a search
/// finds in it, and where the next page starts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitsResponse {
    pub commits: Vec<Commit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

/// `/api/prs`: a page of pull requests (GitLab's merge requests), and where the next page starts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestsResponse {
    pub forge: Forge,
    pub pulls: Vec<PullRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub head: String,
    pub base: String,
    pub updated: String,
    pub draft: bool,
    /// "open", "closed" or "merged".
    pub state: String,
}

// `/api/unchanged` answers `UnchangedFiles`, a plain list of paths (server.rs).

/// A line of an unchanged file with the text searched for in it.
#[derive(Debug, Serialize)]
pub struct GrepMatch {
    pub file: String,
    pub line: u64,
    pub text: String,
}

/// A finished review; with no comments, it passed. They have no default, so a
/// malformed request never reads as that.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub comments: Vec<Comment>,
    /// The run of Patch the page drew its review from; another run refuses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}
