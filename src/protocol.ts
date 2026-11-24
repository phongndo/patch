//! The shapes the page and the server exchange. The server mirrors them in
//! `cli/src/protocol.rs`; change both together (tests/contract.test.ts checks).

export type Mode = "all" | "uncommitted" | "staged";

/** What is under review: a view of the working tree, a run of commits, or a pull request. */
export type Scope =
  | { kind: Mode; base?: string }
  | { kind: "commits"; from: string; to: string }
  | { kind: "pr"; number: number };

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  when: string;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  head: string;
  base: string;
  updated: string;
  draft: boolean;
}

export type Side = "additions" | "deletions";

export interface Comment {
  id: string;
  file: string;
  side: Side;
  /** First and last line, inclusive, numbered on `side`. */
  start: number;
  end: number;
  body: string;
  /** The commented lines as they read when the comment was written. */
  excerpt: string[];
  /** What was under review when the comment was written, when not the working tree. */
  scope?: string;
  /** Milliseconds since the epoch. */
  createdAt?: number;
}

export interface ReviewResponse {
  repository: string;
  branch: string;
  scope: Scope;
  /** Names this review's files for context reads. */
  scopeKey: string;
  label: string;
  base?: string;
  patch: string;
  /** Names this run, so a reloaded tab finds its own comments and no other run's. */
  session: string;
}

export interface ScopesResponse {
  base?: string;
  /** The ref the listed commits are counted from; absent when they are just recent history. */
  since?: string;
  branches: string[];
  commits: Commit[];
}

export interface Submission {
  decision: "approve" | "comment";
  comments: Comment[];
}
