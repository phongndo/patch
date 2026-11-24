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
}

export interface Draft {
  comments: Comment[];
  note: string;
  viewed: string[];
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
  /** Keys the saved draft, so a rerun of the same review restores it. */
  draftKey: string;
  draft: Draft;
}

export interface ScopesResponse {
  base?: string;
  branches: string[];
  commits: Commit[];
}

export interface Submission extends Draft {
  decision: "approve" | "comment";
}

export const emptyDraft = (): Draft => ({ comments: [], note: "", viewed: [] });
