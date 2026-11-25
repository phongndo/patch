//! The review's state: one Solid store for what the reviewer writes, and a plain
//! signal for the parsed diff. It belongs to one run of Patch: the tab keeps it
//! over a reload, and no other review sees it.

import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { createMemo, createRoot, createSignal, createStore, flush, snapshot } from "solid-js";
import type { Comment, ReviewResponse, Scope, Side } from "../src/protocol.ts";
import { loadReview, submit } from "./api.ts";

export interface Target {
  file: string;
  side: Side;
  start: number;
  end: number;
  /** Set when editing an existing comment. */
  id?: string;
}

/** What the tab remembers of a run. */
interface Saved {
  comments: Comment[];
  viewed: Record<string, string>;
}
const savedKey = (session: string) => `patch:${session}`;

/** Reads what this tab wrote in this run, and forgets any other run served from the same address. */
function readSaved(session: string): Saved | undefined {
  const key = savedKey(session);
  for (const other of Object.keys(sessionStorage))
    if (other.startsWith(savedKey("")) && other !== key) sessionStorage.removeItem(other);
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
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

/** Very large files open folded, and generated ones too unless the reviewer turned that off. */
export const opensCollapsed = (file: FileDiffMetadata, foldGenerated = true) =>
  (foldGenerated && generated.test(file.name)) || file.unifiedLineCount > largeLines;

export const stats = (file: FileDiffMetadata) => {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
};

/** Names a file's changes, so a viewed mark lasts only as long as they do. */
function fingerprint(file: FileDiffMetadata): string {
  let hash = 5381;
  const add = (text: string) => {
    for (let index = 0; index < text.length; index++) hash = ((hash * 33) ^ text.charCodeAt(index)) | 0;
  };
  add(`${file.type} ${file.prevName ?? ""}`);
  for (const hunk of file.hunks)
    for (const part of hunk.hunkContent)
      if (part.type === "change") {
        for (let index = 0; index < part.deletions; index++)
          add(`-${file.deletionLines[part.deletionLineIndex + index]}`);
        for (let index = 0; index < part.additions; index++)
          add(`+${file.additionLines[part.additionLineIndex + index]}`);
      }
  return String(hash);
}

/** A run of changed lines, as the diff selects it. */
export interface Change {
  file: string;
  side: Side;
  start: number;
  end: number;
}

/** Every run of changed lines in a file, in order; a replaced run is its new side. */
export function changesOf(file: FileDiffMetadata): Change[] {
  return file.hunks.flatMap((hunk) =>
    hunk.hunkContent.flatMap((part) => {
      if (part.type !== "change") return [];
      const side = part.additions ? "additions" : "deletions";
      const start =
        side === "additions"
          ? hunk.additionStart + part.additionLineIndex - hunk.additionLineIndex
          : hunk.deletionStart + part.deletionLineIndex - hunk.deletionLineIndex;
      return [{ file: file.name, side, start, end: start + part[side] - 1 }];
    }),
  );
}

/** The whole text of files whose hidden context was expanded, by name. */
const expanded = new Map<string, Record<Side, string[]>>();
export const rememberFile = (name: string, oldText: string, newText: string) =>
  void expanded.set(name, { deletions: oldText.split("\n"), additions: newText.split("\n") });

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
    const text = index === undefined ? expanded.get(file.name)?.[side][line - 1] : lines[index];
    if (text !== undefined) out.push(text.replace(/\r?\n$/, ""));
  }
  return out;
}

/** Whether a comment's lines still read in the diff on screen as when it was written, so it can be drawn there. */
export function isShown(
  file: FileDiffMetadata | undefined,
  comment: Pick<Comment, "side" | "start" | "end" | "excerpt">,
) {
  if (!file) return false;
  const now = excerpt(file, comment.side, comment.start, comment.end);
  return now.length > 0 && now.join("\n") === comment.excerpt.join("\n");
}

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
/** General comments are about the whole change: no file and no lines. */
export const isGeneral = (comment: Pick<Comment, "file">) => comment.file === "";

const generalComment = (body: string): Comment => ({
  id: newId(),
  file: "",
  side: "additions",
  start: 0,
  end: 0,
  body,
  excerpt: [],
  createdAt: Date.now(),
});

const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

function createReviewState() {
  const [store, setStore] = createStore({
    review: undefined as Omit<ReviewResponse, "patch"> | undefined,
    comments: [] as Comment[],
    /** Files marked viewed, by name, each with the fingerprint of the changes that were. */
    viewed: {} as Record<string, string>,
    loading: true,
    error: "",
    submitted: false,
  });
  // Parsed diffs stay out of the store: they go to the highlighter workers,
  // which cannot clone store proxies, and they never change in place.
  const [files, setFiles] = createSignal<FileDiffMetadata[]>([]);
  // What is being written lives here, not in the editor: the diff drops and
  // redraws its editors as files, filters and layout change.
  const [composer, setComposer] = createSignal<Target>();
  const [composerText, setComposerText] = createSignal("");
  /** A general comment being written, or edited when it has an id. */
  const [general, setGeneral] = createSignal<{ id?: string }>();
  const [generalText, setGeneralText] = createSignal("");
  /** Kinds and Git statuses the reviewer filtered out of the tree and the diff. */
  const [hiddenStatuses, setHiddenStatuses] = createSignal<ReadonlySet<Status>>(new Set());
  const [hiddenKinds, setHiddenKinds] = createSignal<ReadonlySet<Kind>>(new Set());
  const clearFilter = () => {
    setHiddenStatuses(new Set<Status>());
    setHiddenKinds(new Set<Kind>());
  };
  const visibleFiles = createMemo(() => {
    const statuses = hiddenStatuses();
    const kinds = hiddenKinds();
    if (!statuses.size && !kinds.size) return files();
    return files().filter((file) => !statuses.has(statusOf(file)) && !kinds.has(kindOf(file)));
  });
  let restored = false;

  const remember = () => {
    flush(); // Setters apply on the next microtask; save what was just written.
    if (!store.review) return;
    const { comments, viewed } = snapshot(store);
    try {
      sessionStorage.setItem(savedKey(store.review.session), JSON.stringify({ comments, viewed }));
    } catch {
      // Storage is full or off: a reload starts empty.
    }
  };

  const bodyOf = (id: string | undefined) =>
    (id && store.comments.find((comment) => comment.id === id)?.body) || "";

  /** Opens an editor on some lines, keeping whatever was being written elsewhere. */
  function compose(target: Target) {
    keepWriting();
    setComposer(target);
    setComposerText(bodyOf(target.id));
  }

  function composeGeneral(id?: string) {
    keepWriting();
    setGeneral({ id });
    setGeneralText(bodyOf(id));
  }

  const cancelComposer = () => {
    setComposer(undefined);
    setComposerText("");
  };
  const cancelGeneral = () => {
    setGeneral(undefined);
    setGeneralText("");
  };

  /** Turns anything half-written into a comment, so moving on never loses it. */
  function keepWriting() {
    flush();
    const target = composer();
    if (target && composerText().trim()) saveComment(target, composerText().trim());
    else cancelComposer();
    const open = general();
    if (open && generalText().trim()) saveGeneral(generalText().trim(), open.id);
    else cancelGeneral();
    flush();
  }

  const isWriting = () =>
    (composer() !== undefined && composerText().trim() !== bodyOf(composer()?.id)) ||
    (general() !== undefined && generalText().trim() !== bodyOf(general()?.id));
  /** Whether closing the tab would lose something. */
  const hasUnsent = () => !store.submitted && (store.comments.length > 0 || isWriting());

  let loads = 0;
  async function load(scope?: Scope) {
    const turn = ++loads;
    setStore((s) => {
      s.loading = true;
      s.error = "";
    });
    try {
      const { patch, ...review } = await loadReview(scope);
      if (turn !== loads) return; // Something else was chosen meanwhile.
      const started = performance.now();
      const parsed = parsePatchFiles(patch, {
        cacheKeyPrefix: `${review.session}:${Date.now()}:`,
      }).flatMap((entry) => entry.files);
      console.debug(`patch: parsed ${parsed.length} files in ${(performance.now() - started).toFixed(1)}ms`);
      const target = composer();
      const before = target && excerptAt(target);
      // Before the old files go: a comment on lines the new ones lack is kept as written.
      const next = target && parsed.find((file) => file.name === target.file);
      const old = [...expanded];
      expanded.clear();
      if (target && !(before && isShown(next, { ...target, excerpt: before }))) {
        for (const [name, text] of old) expanded.set(name, text);
        keepWriting();
        expanded.clear();
      }
      const saved = restored ? undefined : readSaved(review.session);
      restored = true;
      setFiles(sortFiles(parsed));
      setStore((s) => {
        s.review = review;
        s.loading = false;
        // Switching what is under review keeps what is written.
        if (saved) {
          s.comments = saved.comments ?? [];
          s.viewed = saved.viewed ?? {};
        }
      });
    } catch (error) {
      if (turn !== loads) return;
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
  const excerptAt = (target: Target) => {
    const file = fileByName(target.file);
    return file ? excerpt(file, target.side, target.start, target.end) : [];
  };

  function saveComment(target: Target, body: string) {
    const file = fileByName(target.file);
    setStore((s) => {
      const existing = target.id ? s.comments.find((comment) => comment.id === target.id) : undefined;
      if (existing) existing.body = body;
      else if (file)
        s.comments.push({
          id: newId(),
          file: target.file,
          side: target.side,
          start: target.start,
          end: target.end,
          body,
          excerpt: excerptAt(target),
          scope: scopeNote(),
          createdAt: Date.now(),
        });
    });
    cancelComposer();
    remember();
  }

  /** Adds a comment about the whole change, or edits one. */
  function saveGeneral(body: string, id?: string) {
    setStore((s) => {
      const existing = id ? s.comments.find((comment) => comment.id === id) : undefined;
      if (existing) existing.body = body;
      else s.comments.push(generalComment(body));
    });
    cancelGeneral();
    remember();
  }

  function deleteComments(ids: Iterable<string>) {
    const gone = new Set(ids);
    setStore((s) => {
      for (let index = s.comments.length - 1; index >= 0; index--)
        if (gone.has(s.comments[index]!.id)) s.comments.splice(index, 1);
    });
    if (gone.has(composer()?.id ?? "")) cancelComposer();
    if (gone.has(general()?.id ?? "")) cancelGeneral();
    remember();
  }

  const deleteComment = (id: string) => deleteComments([id]);

  function isViewed(name: string): boolean {
    const mark = store.viewed[name];
    const file = mark === undefined ? undefined : fileByName(name);
    return file !== undefined && mark === fingerprint(file);
  }

  /** Returns whether the file is now viewed. */
  function toggleViewed(name: string): boolean {
    const file = fileByName(name);
    const viewed = file !== undefined && !isViewed(name);
    setStore((s) => {
      if (viewed) s.viewed[name] = fingerprint(file);
      else delete s.viewed[name];
    });
    remember();
    return viewed;
  }

  let sending = false;
  async function finish() {
    if (!store.review || sending || store.submitted) return;
    sending = true;
    try {
      keepWriting();
      await submit({ comments: snapshot(store).comments });
      sessionStorage.removeItem(savedKey(store.review.session));
      setStore((s) => {
        s.submitted = true;
      });
      flush(); // The page may close at once, and must not ask about comments it just sent.
    } finally {
      sending = false;
    }
  }

  return {
    store,
    files,
    visibleFiles,
    hiddenStatuses,
    setHiddenStatuses,
    hiddenKinds,
    setHiddenKinds,
    clearFilter,
    composer,
    compose,
    cancelComposer,
    composerText,
    setComposerText,
    general,
    composeGeneral,
    cancelGeneral,
    generalText,
    setGeneralText,
    keepWriting,
    hasUnsent,
    load,
    fileByName,
    saveComment,
    saveGeneral,
    deleteComment,
    deleteComments,
    isViewed,
    toggleViewed,
    finish,
  };
}

export const state = createRoot(createReviewState);
