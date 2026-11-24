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
    pub start: u64,
    pub end: u64,
    pub body: String,
    #[serde(default)]
    pub excerpt: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    #[serde(default)]
    pub comments: Vec<Comment>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub viewed: Vec<String>,
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
    pub patch: String,
    pub draft_key: String,
    pub draft: Draft,
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
    /// The ref the listed commits are counted from; absent when they are just recent history.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    pub branches: Vec<String>,
    pub commits: Vec<Commit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub head: String,
    pub base: String,
    pub updated: String,
    pub draft: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Approve,
    Comment,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub decision: Decision,
    #[serde(default)]
    pub comments: Vec<Comment>,
    #[serde(default)]
    pub note: String,
}
