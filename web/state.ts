//! The review's state: one Solid store for what the reviewer writes, saved as
//! a draft on every change, and a plain signal for the parsed diff.

import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { createMemo, createRoot, createSignal, createStore, flush, snapshot } from "solid-js";
import type { Comment, ReviewResponse, Scope, Side } from "../src/protocol.ts";
import { loadReview, saveDraft, submit } from "./api.ts";

export interface Target {
  file: string;
  side: Side;
  start: number;
  end: number;
  /** Set when editing an existing comment. */
  id?: string;
}

export type Status = "added" | "modified" | "deleted" | "renamed";
export const statuses: readonly Status[] = ["added", "modified", "deleted", "renamed"];
export const statusOf = (file: FileDiffMetadata): Status =>
  file.type === "new"
    ? "added"
    : file.type === "deleted"
      ? "deleted"
      : file.type === "change"
        ? "modified"
        : "renamed";

export type Kind = "code" | "tests" | "generated" | "docs";
export const kinds: readonly Kind[] = ["code", "tests", "generated", "docs"];
const testPath =
  /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$/i;
const docPath =
  /(^|\/)docs?\/|\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(README|CHANGELOG|LICENSE|NOTICE)[^/]*$/i;
const generatedPath = /\.gen\.[^/]+$|(^|\/)(dist|vendor|__generated__)\//;
export const kindOf = (file: FileDiffMetadata): Kind =>
  generated.test(file.name) || generatedPath.test(file.name)
    ? "generated"
    : testPath.test(file.name)
      ? "tests"
      : docPath.test(file.name)
        ? "docs"
        : "code";

/** Machine-written files open collapsed. */
const generated =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|flake\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|[^/]*\.min\.(js|css)|[^/]*\.map|[^/]*\.snap)$/;
const largeLines = 1500;

export const opensCollapsed = (file: FileDiffMetadata) =>
  generated.test(file.name) || file.unifiedLineCount > largeLines;

export const stats = (file: FileDiffMetadata) => {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
};

/** Where a side's line sits in the parsed file, or undefined when the diff does not show it. */
function lineIndex(file: FileDiffMetadata, side: Side, line: number): number | undefined {
  for (const hunk of file.hunks) {
    const first = side === "additions" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "additions" ? hunk.additionCount : hunk.deletionCount;
    if (line >= first && line < first + count)
      return (side === "additions" ? hunk.additionLineIndex : hunk.deletionLineIndex) + line - first;
  }
  return undefined;
}

/** The commented lines, read from the diff so the agent sees what the reviewer saw. */
export function excerpt(file: FileDiffMetadata, side: Side, start: number, end: number): string[] {
  const lines = side === "additions" ? file.additionLines : file.deletionLines;
  const out: string[] = [];
  for (let line = start; line <= end; line++) {
    const index = lineIndex(file, side, line);
    const text = index === undefined ? undefined : lines[index];
    if (text !== undefined) out.push(text.replace(/\r?\n$/, ""));
  }
  return out;
}

/** Whether a comment's last line is in the diff on screen, so it can be drawn there. */
export const isShown = (file: FileDiffMetadata | undefined, comment: Pick<Comment, "side" | "end">) =>
  file !== undefined && lineIndex(file, comment.side, comment.end) !== undefined;

/** Folders before files at each level, then by name: the order the file tree shows. */
export function sortFiles(files: FileDiffMetadata[]): FileDiffMetadata[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return files.toSorted((a, b) => {
    const left = a.name.split("/");
    const right = b.name.split("/");
    for (let index = 0; ; index++) {
      const leftIsDir = index < left.length - 1;
      const rightIsDir = index < right.length - 1;
      if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
      const order = collator.compare(left[index] ?? "", right[index] ?? "");
      if (order || !leftIsDir) return order;
    }
  });
}

// randomUUID exists only on secure pages (HTTPS, localhost); a remote review
// over plain HTTP on the tailnet has getRandomValues only.
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

function createReviewState() {
  const [store, setStore] = createStore({
    review: undefined as Omit<ReviewResponse, "patch" | "draft"> | undefined,
    comments: [] as Comment[],
    note: "",
    viewed: [] as string[],
    loading: true,
    error: "",
    submitted: false,
  });
  // Parsed diffs stay out of the store: they go to the highlighter workers,
  // which cannot clone store proxies, and they never change in place.
  const [files, setFiles] = createSignal<FileDiffMetadata[]>([]);
  const [composer, setComposer] = createSignal<Target>();
  /** Kinds and Git statuses the reviewer filtered out of the tree and the diff. */
  const [hiddenStatuses, setHiddenStatuses] = createSignal<ReadonlySet<Status>>(new Set());
  const [hiddenKinds, setHiddenKinds] = createSignal<ReadonlySet<Kind>>(new Set());
  const visibleFiles = createMemo(() => {
    const statuses = hiddenStatuses();
    const kinds = hiddenKinds();
    if (!statuses.size && !kinds.size) return files();
    return files().filter((file) => !statuses.has(statusOf(file)) && !kinds.has(kindOf(file)));
  });
  let restored = false;

  const persist = () => {
    flush(); // Setters apply on the next microtask; save what was just written.
    if (!store.review || store.submitted) return;
    const { comments, note, viewed } = snapshot(store);
    saveDraft(store.review.draftKey, { comments, note, viewed });
  };

  async function load(scope?: Scope) {
    setStore((s) => {
      s.loading = true;
      s.error = "";
    });
    try {
      const { patch, draft, ...review } = await loadReview(scope);
      const started = performance.now();
      const parsed = parsePatchFiles(patch, {
        cacheKeyPrefix: `${review.draftKey}:${Date.now()}:`,
      }).flatMap((entry) => entry.files);
      console.debug(`patch: parsed ${parsed.length} files in ${(performance.now() - started).toFixed(1)}ms`);
      setFiles(sortFiles(parsed));
      setComposer(undefined);
      setStore((s) => {
        s.review = review;
        s.loading = false;
        // The draft is one per repository; switching views keeps what is written.
        if (!restored) {
          s.comments = draft.comments;
          s.note = draft.note;
          s.viewed = draft.viewed;
        }
      });
      restored = true;
    } catch (error) {
      setStore((s) => {
        s.loading = false;
        s.error = error instanceof Error ? error.message : String(error);
      });
    }
  }

  /** Names the commits or pull request a comment was written against; working-tree views need none. */
  const scopeNote = () => {
    const scope = store.review?.scope;
    if (scope?.kind === "pr") return `PR #${scope.number}`;
    if (scope?.kind === "commits")
      return scope.from === scope.to
        ? `commit ${scope.to.slice(0, 7)}`
        : `commits ${scope.from.slice(0, 7)}..${scope.to.slice(0, 7)}`;
    return undefined;
  };

  const fileByName = (name: string) => files().find((file) => file.name === name);

  function saveComment(target: Target, body: string) {
    const file = fileByName(target.file);
    if (!file) return;
    setStore((s) => {
      const existing = target.id ? s.comments.find((comment) => comment.id === target.id) : undefined;
      if (existing) existing.body = body;
      else
        s.comments.push({
          id: newId(),
          file: target.file,
          side: target.side,
          start: target.start,
          end: target.end,
          body,
          excerpt: excerpt(file, target.side, target.start, target.end),
          scope: scopeNote(),
        });
    });
    setComposer(undefined);
    persist();
  }

  function deleteComment(id: string) {
    setStore((s) => {
      const index = s.comments.findIndex((comment) => comment.id === id);
      if (index >= 0) s.comments.splice(index, 1);
    });
    if (composer()?.id === id) setComposer(undefined);
    persist();
  }

  function setNote(note: string) {
    setStore((s) => {
      s.note = note;
    });
    persist();
  }

  /** Returns whether the file is now viewed. */
  function toggleViewed(name: string): boolean {
    const viewed = !store.viewed.includes(name);
    setStore((s) => {
      if (viewed) s.viewed.push(name);
      else s.viewed.splice(s.viewed.indexOf(name), 1);
    });
    persist();
    return viewed;
  }

  async function finish(decision: "approve" | "comment") {
    const review = store.review;
    if (!review) return;
    const { comments, note, viewed } = snapshot(store);
    await submit(review.draftKey, { decision, comments, note, viewed });
    setStore((s) => {
      s.submitted = true;
    });
  }

  return {
    store,
    files,
    visibleFiles,
    hiddenStatuses,
    setHiddenStatuses,
    hiddenKinds,
    setHiddenKinds,
    composer,
    setComposer,
    load,
    fileByName,
    saveComment,
    deleteComment,
    setNote,
    toggleViewed,
    finish,
  };
}

export const state = createRoot(createReviewState);
