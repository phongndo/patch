import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";

export type ReviewMode = "working" | "staged" | "branch";
export interface ReviewSource {
  patch: string;
  repository: string;
  branch: string;
  base: string;
  title: string;
  kind: "git" | "patch" | "example";
  mode?: ReviewMode;
}
export interface ReviewFile {
  id: string;
  path: string;
  additions: number;
  deletions: number;
  diff: FileDiffMetadata;
}
export interface Review {
  id: string;
  source: Omit<ReviewSource, "patch">;
  files: ReviewFile[];
  additions: number;
  deletions: number;
}
export interface Note {
  id: string;
  file: string;
  range: SelectedLineRange;
  text: string;
}
export interface ReviewProgress {
  reviewed: string[];
  notes: Note[];
}
