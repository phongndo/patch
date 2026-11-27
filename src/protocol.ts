//! The shapes the page and the server exchange. The server mirrors them in
//! `cli/src/protocol.rs`; change both together (tests/contract.test.ts checks).

export type Mode = "all" | "uncommitted" | "staged";

/** What keeps the repository's history. Jujutsu has no staging area. */
export type Vcs = "git" | "jj";

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
  state: "open" | "closed" | "merged";
}

export type Side = "additions" | "deletions";

export interface Comment {
  id: string;
  file: string;
  side: Side;
  /** First and last line, inclusive, numbered on `side`; 0 for the whole file, or with no file the whole change. */
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
  vcs: Vcs;
  patch: string;
  /** Names this run, so a reloaded tab finds its own comments and no other run's. */
  session: string;
  /** Names this read of the review: an image is served only to the read it belongs to. */
  read: number;
  /** Each changed file's paths as Git recorded them, in the patch's order; none for a pull request. */
  files?: ChangedPaths[];
}

/** A changed file's paths before and after; one it lacks, or cannot name in UTF-8, is absent. */
export interface ChangedPaths {
  old?: string;
  new?: string;
}

export interface ScopesResponse {
  base?: string;
  branches: string[];
}

/** `/api/commits`: a page of the history of HEAD, newest first, or of what a search finds in it. */
export interface CommitsResponse {
  commits: Commit[];
  /** Where the next page starts; absent on the last. */
  next?: string;
}

/** `/api/prs`: a page of pull requests. */
export interface PullRequestsResponse {
  pulls: PullRequest[];
  next?: string;
}

/** `/api/unchanged`: the files a review leaves alone, which can be opened whole for context. */
export type UnchangedFiles = string[];

/** `/api/grep`: a line of an unchanged file with the text searched for, capitals only matching capitals. */
export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/** A finished review; with no comments, it passed. */
export interface Submission {
  comments: Comment[];
  /** The run of Patch the page drew its review from; another run refuses it. */
  session?: string;
}
