//! The review's state: one Solid store for what the reviewer writes, and a plain
//! signal for the parsed diff. It belongs to one run of Patch: the tab keeps it
//! over a reload, and no other review sees it.

import { hydratePartialDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { createEffect, createMemo, createRoot, createSignal, createStore, flush, snapshot } from "solid-js";
import type { ChangedPaths, Comment, ReviewResponse, Scope, Side } from "../src/protocol.ts";
import { loadReview, loadUnchanged, loadUnchangedFile, submit } from "./api.ts";
import { previewKind, previewPanes, previewToggles } from "./media.ts";
import { preferences } from "./settings.ts";

/** What a comment is about, as `Comment` says it. */
export interface Target {
  file: string;
  side: Side;
  start: number;
  end: number;
  /** Set when editing an existing comment. */
  id?: string;
}

export const wholeFile = (file: string): Target => ({ file, side: "additions", start: 0, end: 0 });
export const globalTarget = wholeFile("");

/** A file the change leaves alone, read whole to browse. */
export interface OpenedFile {
  name: string;
  contents: string;
  lines: string[];
}

/** What the tab remembers of a run. */
interface Saved {
  comments: Comment[];
  viewed: Record<string, string>;
  /** The file browsing started from, in place of the review; read again on a reload. */
  browsing?: string;
  /** Whether the tree held the whole repository. */
  exploring?: boolean;
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
/** In the order the grouped tree and diff show them. */
export const kinds: readonly Kind[] = ["code", "tests", "docs", "generated"];
const testPath =
  /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$/i;
const docPath =
  /(^|\/)docs?\/|\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(README|CHANGELOG|LICENSE|NOTICE)[^/]*$/i;
const generatedPath = /\.gen\.[^/]+$|(^|\/)(dist|vendor|__generated__)\//;
export const kindOfPath = (path: string): Kind =>
  generated.test(path) || generatedPath.test(path)
    ? "generated"
    : testPath.test(path)
      ? "tests"
      : docPath.test(path)
        ? "docs"
        : "code";
export const kindOf = (file: FileDiffMetadata): Kind => kindOfPath(file.name);

/** Machine-written files open collapsed. */
const generated =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|flake\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|[^/]*\.min\.(js|css)|[^/]*\.map|[^/]*\.snap)$/;
const largeLines = 1500;

/** Very large diffs open folded, and generated files too unless the reviewer turned that off. */
export const opensCollapsed = (file: FileDiffMetadata, foldGenerated = true) =>
  (foldGenerated && kindOf(file) === "generated") || shownLines(file) > largeLines;

/** The lines a diff shows before anything is expanded; its unifiedLineCount counts what is hidden too. */
const shownLines = (file: FileDiffMetadata) =>
  file.hunks.reduce((sum, hunk) => sum + hunk.unifiedLineCount, 0);

export const stats = (file: FileDiffMetadata) => {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
};

/** Fingerprints by parsed file, which never changes in place: filtering on Viewed asks again often. */
const fingerprints = new WeakMap<FileDiffMetadata, string>();

/** Names a file's changes, so a viewed mark lasts only as long as they do. */
function fingerprint(file: FileDiffMetadata): string {
  const known = fingerprints.get(file);
  if (known !== undefined) return known;
  let hash = 5381;
  const add = (text: string) => {
    for (let index = 0; index < text.length; index++) hash = ((hash * 33) ^ text.charCodeAt(index)) | 0;
  };
  add(`${file.type} ${file.prevName ?? ""}`);
  if (!file.hunks.length) add(`${file.prevObjectId ?? ""}:${file.newObjectId ?? ""}`);
  // An added file has only its new mode.
  if (file.prevMode || file.mode) add(`${file.prevMode ?? ""}:${file.mode ?? ""}`);
  for (const hunk of file.hunks)
    for (const part of hunk.hunkContent)
      if (part.type === "change") {
        for (let index = 0; index < part.deletions; index++)
          add(`-${file.deletionLines[part.deletionLineIndex + index]}`);
        for (let index = 0; index < part.additions; index++)
          add(`+${file.additionLines[part.additionLineIndex + index]}`);
      }
  fingerprints.set(file, String(hash));
  return String(hash);
}

/** A run of changed lines, as the diff selects it. */
export interface Change {
  file: string;
  side: Side;
  start: number;
  end: number;
}

/**
 * A parsed file named as Git recorded it. A parser reads a binary file's name from its header line,
 * which a name holding " and b/" splits more than one way; Git's record of the change does not.
 */
export function withRecordedPaths(file: FileDiffMetadata, paths: ChangedPaths): FileDiffMetadata {
  const name = paths.new ?? paths.old;
  const prevName = paths.old && paths.new && paths.old !== paths.new ? paths.old : undefined;
  if (name && (file.name !== name || file.prevName !== prevName)) {
    file.name = name;
    file.prevName = prevName;
  }
  return file;
}

/** The context Git gives around a change (cli/src/git.rs, `--unified=3`; GitHub's diffs the same). */
const CONTEXT_LINES = 3;

/**
 * Marks a diff that already holds both files whole as complete, so nothing offers to load more
 * of them. Its hunks run unbroken from the first line, and the last ends on fewer context lines
 * than Git gives, which only the end of the file cuts short. Any other diff is left partial: a
 * last hunk ending on a full three lines may or may not be the end.
 */
export function completeWhole(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial || (file.type !== "change" && file.type !== "rename-changed") || !file.hunks.length)
    return file;
  let nextOld = 1;
  let nextNew = 1;
  for (const hunk of file.hunks) {
    if (hunk.deletionStart !== nextOld || hunk.additionStart !== nextNew) return file;
    nextOld += hunk.deletionCount;
    nextNew += hunk.additionCount;
  }
  const last = file.hunks.at(-1)!.hunkContent.at(-1);
  if (last?.type === "context" && last.lines >= CONTEXT_LINES) return file;
  return hydratePartialDiff("merge", file, {
    oldFile: { name: file.prevName ?? file.name, contents: file.deletionLines.join("") },
    newFile: { name: file.name, contents: file.additionLines.join("") },
  });
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

/** The commented lines of a file shown whole. */
const linesOf = (file: OpenedFile, start: number, end: number) =>
  file.lines.slice(start - 1, end).map((line) => line.replace(/\r$/, ""));

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** Folders before files at each level, then by name: the order the file tree shows. */
export function comparePaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let index = 0; ; index++) {
    const leftIsDir = index < left.length - 1;
    const rightIsDir = index < right.length - 1;
    if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
    const order = collator.compare(left[index] ?? "", right[index] ?? "");
    if (order || !leftIsDir) return order;
  }
}
export const sortFiles = (files: FileDiffMetadata[]) =>
  files.toSorted((a, b) => comparePaths(a.name, b.name));

/** Whether a path has every word of a name filter in it, in any case. */
export function matchesName(path: string, query: string): boolean {
  const lower = path.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => lower.includes(word));
}

/** Global comments are about the whole change: no file and no lines. */
export const isGlobal = (comment: Pick<Comment, "file">) => comment.file === "";
/** A comment about lines, rather than a whole file or change. */
const hasLines = (comment: Pick<Comment, "start">) => comment.start > 0;

// randomUUID exists only on secure pages (HTTPS, localhost); a remote review
// over plain HTTP on the tailnet has getRandomValues only.
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

function createReviewState() {
  const [store, setStore] = createStore({
    review: undefined as Omit<ReviewResponse, "patch" | "files"> | undefined,
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
  const filesByName = createMemo(() => {
    const byName = new Map<string, FileDiffMetadata>();
    for (const file of files()) if (!byName.has(file.name)) byName.set(file.name, file);
    return byName;
  });
  // What is being written lives here, not in the editor: the diff drops and redraws
  // its editors as files, filters and layout change. There is one at a time.
  const [composer, setComposer] = createSignal<Target>();
  const [composerText, setComposerText] = createSignal("");
  /** Kinds and Git statuses the reviewer filtered out of the tree and the diff. */
  const [hiddenStatuses, setHiddenStatuses] = createSignal<ReadonlySet<Status>>(new Set());
  const [hiddenKinds, setHiddenKinds] = createSignal<ReadonlySet<Kind>>(new Set());
  /** Narrow the files to those not yet viewed, or those with comments. */
  const [onlyUnviewed, setOnlyUnviewed] = createSignal(false);
  const [onlyCommented, setOnlyCommented] = createSignal(false);
  const clearFilter = () => {
    setHiddenStatuses(new Set<Status>());
    setHiddenKinds(new Set<Kind>());
    setOnlyUnviewed(false);
    setOnlyCommented(false);
    setNameQuery("");
  };
  const isFiltered = () =>
    hiddenStatuses().size > 0 ||
    hiddenKinds().size > 0 ||
    onlyUnviewed() ||
    onlyCommented() ||
    nameQuery().trim() !== "";
  /** Narrows the tree and what scrolls by name; the sidebar's search and the palette's # share it. */
  const [nameQuery, setNameQuery] = createSignal("");
  /** Whether the tree holds the whole repository, not only what changed. */
  const [showUnchanged, setShowUnchanged] = createSignal(false);
  /** Files the reviewer switched between preview and code, against the settings. */
  const [previews, setPreviews] = createStore<Record<string, boolean>>({});
  /** Whether a file with a preview and code is shown rendered, in place of its code. An image Git
   * took for text (no NUL in it) is still an image. */
  const isPreviewed = (name: string) => previews[name] ?? previewedFirst(name);
  /** As a file opens: by what its sides are (an SVG renamed to text is still an SVG on one). */
  function previewedFirst(name: string) {
    const file = fileByName(name);
    const paths = file ? previewPanes(file).map((pane) => pane.path) : [name];
    if (paths.some((path) => /\.svg$/i.test(path))) return preferences.settings.previewSvg;
    if (paths.some((path) => previewKind(path) === "markdown")) return preferences.settings.previewMarkdown;
    // An image Git took for text (no NUL in it) is still an image.
    return true;
  }
  const setPreviewed = (name: string, shown: boolean) =>
    setPreviews((s) => {
      s[name] = shown;
    });
  /** Names every choice of preview, so what draws them knows when one changed. */
  const previewChoices = () =>
    [
      preferences.settings.previewSvg,
      preferences.settings.previewMarkdown,
      ...Object.entries(previews).map(([name, shown]) => `${name}:${shown}`),
    ].join("|");
  /** Whether the diff shows a file's lines: not when it has none, or is shown as its preview. */
  const showsCode = (file: FileDiffMetadata) =>
    file.hunks.length > 0 && !(previewToggles(file) && isPreviewed(file.name));
  // Browsing shows files in place of the review: a window of the tree's files, from the one
  // chosen on, that grows as the reader scrolls. The texts of unchanged ones are read as it
  // does; plain, like the parsed diff.
  const [browsing, setBrowsing] = createSignal<string>();
  const [shownPaths, setShownPaths] = createSignal<readonly string[]>([]);
  const [texts, setTexts] = createSignal<ReadonlyMap<string, OpenedFile>>(new Map());
  /** Files that could not be read, which the window passes over. */
  let unreadable = new Set<string>();
  /** Whether the page shows files of the repository rather than the review. */
  const isBrowsing = () => browsing() !== undefined;
  /** The window's files on screen, in order: a changed one as its diff, another whole once read. */
  const windowItems = createMemo(() =>
    [...new Set(shownPaths())].flatMap((name): Array<FileDiffMetadata | OpenedFile> => {
      const diff = fileByName(name);
      if (diff) return [diff];
      const text = texts().get(name);
      return text ? [text] : [];
    }),
  );
  /** The unchanged files on screen. */
  const openedFiles = createMemo((): OpenedFile[] =>
    isBrowsing() ? windowItems().filter((item): item is OpenedFile => "contents" in item) : [],
  );
  const openedByName = (name: string) => openedFiles().find((file) => file.name === name);
  /** The text of an unchanged file read while browsing, on screen or not, to quote and keep comments on. */
  const browsedText = (name: string) => (fileByName(name) ? undefined : texts().get(name));
  // Every file the review leaves alone, read the first time something browses or searches them.
  const [catalog, setCatalog] = createSignal<readonly string[] | Error>();
  let cataloging: Promise<void> | undefined;
  // Counts files chosen to browse, so only the last one chosen is shown.
  let picks = 0;
  /** The files in the order the tree and diff show them: by kind when grouped, each kind by path. */
  const sortedFiles = createMemo(() =>
    preferences.settings.groupByKind
      ? files().toSorted((a, b) => kinds.indexOf(kindOf(a)) - kinds.indexOf(kindOf(b)))
      : files(),
  );
  const visibleFiles = createMemo(() => {
    const statuses = hiddenStatuses();
    const hidden = hiddenKinds();
    const unviewed = onlyUnviewed();
    const commented = onlyCommented() ? new Set(store.comments.map((comment) => comment.file)) : undefined;
    const query = nameQuery();
    if (!statuses.size && !hidden.size && !unviewed && !commented && !query.trim()) return sortedFiles();
    return sortedFiles().filter(
      (file) =>
        !statuses.has(statusOf(file)) &&
        !hidden.has(kindOf(file)) &&
        (!unviewed || !isViewed(file.name)) &&
        (!commented || commented.has(file.name)) &&
        matchesName(file.name, query),
    );
  });
  /**
   * The files the tree lists, in its order: what the filters leave of the change and, exploring,
   * of the files it leaves alone. Browsing scrolls through these.
   */
  const treePaths = createMemo((): string[] => {
    const changed = visibleFiles().map((file) => file.name);
    const all = catalog();
    if (!showUnchanged() || !Array.isArray(all)) return changed;
    const known = new Set(files().flatMap((file) => [file.name, file.prevName ?? file.name]));
    const hidden = hiddenKinds();
    const query = nameQuery();
    const commented = onlyCommented() ? new Set(store.comments.map((comment) => comment.file)) : undefined;
    const rest = all.filter(
      (path) =>
        !known.has(path) &&
        !hidden.has(kindOfPath(path)) &&
        matchesName(path, query) &&
        (!commented || commented.has(path)),
    );
    return [...changed, ...rest].sort(comparePaths);
  });
  let restored = false;

  const remember = () => {
    flush(); // Setters apply on the next microtask; save what was just written.
    if (!store.review) return;
    const { comments, viewed } = snapshot(store);
    const saved: Saved = { comments, viewed, browsing: browsing(), exploring: showUnchanged() };
    try {
      sessionStorage.setItem(savedKey(store.review.session), JSON.stringify(saved));
    } catch {
      // Storage is full or off: a reload starts empty.
    }
  };

  const bodyOf = (id: string | undefined) =>
    (id && store.comments.find((comment) => comment.id === id)?.body) || "";

  /** Opens an editor on some lines, keeping whatever was being written elsewhere. */
  function compose({ file, side, start, end, id }: Target) {
    keepWriting();
    setComposer({ file, side, start, end, id });
    setComposerText(bodyOf(id));
  }

  const cancelComposer = () => {
    setComposer(undefined);
    setComposerText("");
  };

  /** Turns anything half-written into a comment, so moving on never loses it. */
  function keepWriting() {
    flush();
    const target = composer();
    if (target && composerText().trim()) saveComment(target, composerText().trim());
    else cancelComposer();
    flush();
  }

  const isWriting = () => composer() !== undefined && composerText().trim() !== bodyOf(composer()?.id);
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
      const { patch, files: recorded, ...review } = await loadReview(scope);
      if (turn !== loads) return; // Something else was chosen meanwhile.
      const started = performance.now();
      const files = parsePatchFiles(patch, {
        cacheKeyPrefix: `${review.session}:${Date.now()}:`,
      }).flatMap((entry) => entry.files);
      // Git's record of each file, in the same order, names it when the parser could not.
      const named =
        recorded?.length === files.length
          ? files.map((file, at) => withRecordedPaths(file, recorded[at]!))
          : files;
      // Only Patch's own diffs are known to give three lines of context; a pull request's patch is its forge's.
      const parsed = review.scope.kind === "pr" ? named : named.map(completeWhole);
      console.debug(`patch: parsed ${parsed.length} files in ${(performance.now() - started).toFixed(1)}ms`);
      const target = composer();
      const before = target && excerptAt(target);
      // Before the old files go: a comment on lines the new ones lack is kept as written.
      const next = target && parsed.find((file) => file.name === target.file);
      const old = [...expanded];
      expanded.clear();
      const stays =
        !target ||
        isGlobal(target) ||
        (next && (!hasLines(target) || (before && isShown(next, { ...target, excerpt: before }))));
      if (!stays) {
        for (const [name, text] of old) expanded.set(name, text);
        keepWriting();
        expanded.clear();
      }
      const saved = restored ? undefined : readSaved(review.session);
      restored = true;
      const reread = saved ? saved.browsing : browsing();
      setCatalog(undefined);
      cataloging = undefined;
      setTexts(new Map());
      unreadable = new Set();
      // A path that turned from a link into a file, or back, is two diffs: a deletion and an
      // addition. The page shows a path once, as what it is now.
      const byName = new Map<string, FileDiffMetadata>();
      for (const file of parsed)
        if (!byName.has(file.name) || byName.get(file.name)!.type === "deleted") byName.set(file.name, file);
      setFiles(sortFiles([...byName.values()]));
      setStore((s) => {
        s.review = review;
        s.loading = false;
        // Switching what is under review keeps what is written.
        if (saved) {
          s.comments = saved.comments ?? [];
          s.viewed = saved.viewed ?? {};
        }
      });
      if (saved?.exploring) setShowUnchanged(true);
      // What was browsed is read again from what is now under review.
      // Once the new review is in place: its key, and its emptied texts.
      flush();
      if (reread !== undefined)
        void browse(reread).catch(() => {
          if (turn === loads) stopBrowsing();
        });
    } catch (error) {
      if (turn !== loads) return;
      setStore((s) => {
        s.loading = false;
        s.error = error instanceof Error ? error.message : String(error);
      });
    }
  }

  /** Reads the files the review leaves alone, once per review. */
  function readCatalog(): Promise<void> {
    const key = store.review?.scopeKey;
    if (!key || catalog() !== undefined) return Promise.resolve();
    if (cataloging) return cataloging;
    const turn = loads;
    cataloging = loadUnchanged(key)
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
      .then((result) => {
        if (turn !== loads) return;
        cataloging = undefined;
        setCatalog(result);
        flush();
      });
    return cataloging;
  }

  /** Reads the texts of unchanged files about to show; one that can't be read is passed over. */
  async function readTexts(names: readonly string[], wanted: () => boolean) {
    const key = store.review?.scopeKey ?? "";
    // The review's own: a load starts another, which a late failure must not mark.
    const failed = unreadable;
    const missing = names.filter((name) => !fileByName(name) && !texts().has(name) && !failed.has(name));
    if (!missing.length) return;
    const read = await Promise.all(
      missing.map((name) =>
        loadUnchangedFile(key, name).then(
          (contents): OpenedFile => ({ name, contents, lines: contents.split("\n") }),
          () => void failed.add(name),
        ),
      ),
    );
    if (!wanted()) return;
    setTexts((current) => {
      const next = new Map(current);
      for (const file of read) if (file) next.set(file.name, file);
      return next;
    });
  }

  /** Files added to the window at a time, and the most it holds. */
  const page = 8;
  const most = page * 5;
  /** The first of the files being read to show above the window. */
  let prepending: string | undefined;

  /** Shows the review again, in place of the files browsed. */
  function stopBrowsing() {
    picks++; // A file still being read is no longer wanted.
    setBrowsing(undefined);
    setShownPaths([]);
    remember();
  }

  /**
   * Shows files in place of the review, from this one on in the tree's order: a changed one
   * as its diff, another whole. False when what is under review, or the file chosen, changed
   * meanwhile; throws when the file can't be read.
   */
  async function browse(name: string): Promise<boolean> {
    const turn = loads;
    const pick = ++picks;
    const wanted = () => turn === loads && pick === picks;
    if (!fileByName(name) && !texts().has(name)) {
      const contents = await loadUnchangedFile(store.review?.scopeKey ?? "", name);
      if (!wanted() || store.loading) return false;
      setTexts((current) => new Map(current).set(name, { name, contents, lines: contents.split("\n") }));
    }
    // The files around it come too, before and after, read before they show so nothing
    // moves under the reader; the page opens on the file chosen.
    const around = () => {
      const list = treePaths();
      const at = list.indexOf(name);
      return at < 0 ? [name] : list.slice(Math.max(0, at - page), at + page);
    };
    await readTexts(around(), wanted);
    if (!wanted() || store.loading) return false;
    // As the tree lists them now: a filter may have changed while they were read.
    const shown = around();
    setShownPaths(shown);
    setBrowsing(name);
    remember();
    void readTexts(shown, wanted);
    return true;
  }

  /** Adds the tree's next files below the window, or the ones before it above. */
  function extendBrowsing(edge: "start" | "end") {
    if (!isBrowsing()) return;
    const list = treePaths();
    const shown = shownPaths();
    const pick = picks;
    const wanted = () => pick === picks;
    if (edge === "end") {
      const last = list.indexOf(shown.at(-1) ?? "");
      const more = last < 0 ? [] : list.slice(last + 1, last + 1 + page);
      if (!more.length) return;
      // The window keeps a few pages; the farthest go as more come.
      setShownPaths([...shown, ...more].slice(-most));
      void readTexts(more, wanted);
    } else {
      const first = list.indexOf(shown[0] ?? "");
      const more = first <= 0 ? [] : list.slice(Math.max(0, first - page), first);
      if (!more.length) return;
      // Read before they show, so what is above does not grow under the reader one file at a
      // time; not if the list changed meanwhile, which made the window again.
      // Nor twice: several scrolls ask for the same files while they are read.
      if (prepending === more[0]) return;
      prepending = more[0];
      void readTexts(more, wanted).then(() => {
        prepending = undefined;
        if (wanted() && treePaths() === list && shownPaths()[0] === shown[0])
          setShownPaths((current) => [...more, ...current].slice(0, most));
      });
    }
  }

  // A filter that changes while browsing keeps the files it still lists, from the first of them
  // on, and whatever it lists between them: the window is always a run of the tree's files.
  createEffect(treePaths, (list) => {
    if (!isBrowsing()) return;
    const listed = new Set(list);
    const shown = shownPaths();
    const kept = shown.filter((name) => listed.has(name));
    const first = kept[0] ?? list[0];
    if (first === undefined) {
      setShownPaths([]);
      return;
    }
    const at = list.indexOf(first);
    const last = kept.length ? list.indexOf(kept.at(-1)!) : at;
    const next = list.slice(at, Math.max(at + page, last + 1));
    if (next.length === shown.length && next.every((name, index) => name === shown[index])) return;
    setShownPaths(next);
    const pick = picks;
    void readTexts(next, () => pick === picks);
  });

  /** Names the commits or pull request a comment was written against; working-tree views need none. */
  const scopeNote = () => {
    const scope = store.review?.scope;
    if (scope?.kind === "pr") return `${store.review?.forge === "gitlab" ? "MR !" : "PR #"}${scope.number}`;
    if (scope?.kind === "commits")
      return scope.from === scope.to
        ? `commit ${scope.to.slice(0, 7)}`
        : `commits ${scope.from.slice(0, 7)}..${scope.to.slice(0, 7)}`;
    return undefined;
  };

  function fileByName(name: string) {
    return filesByName().get(name);
  }
  const excerptAt = (target: Target) => {
    const file = fileByName(target.file);
    if (file) return excerpt(file, target.side, target.start, target.end);
    const whole = browsedText(target.file);
    return whole && hasLines(target) ? linesOf(whole, target.start, target.end) : [];
  };

  /** Whether a comment's lines are no longer in the diff as they were; it is sent as written. */
  function isMoved(comment: Comment) {
    if (!hasLines(comment)) return false;
    const whole = openedByName(comment.file);
    if (whole) return linesOf(whole, comment.start, comment.end).join("\n") !== comment.excerpt.join("\n");
    return !isShown(fileByName(comment.file), comment);
  }

  /**
   * The line the diff shows a comment or its editor under: 0 is above the file's first, for one about
   * the whole file or lines that changed. Undefined when the diff has no place for it, and the sidebar does.
   */
  function lineOf(target: Target): number | undefined {
    // A file without lines on screen (binary, only renamed, or shown as its preview) has nothing
    // to draw one on, but a comment on the whole of it goes under its preview.
    const drawn =
      visibleFiles().some(
        (file) =>
          file.name === target.file && (showsCode(file) || (!hasLines(target) && previewPanes(file).length)),
      ) || openedByName(target.file) !== undefined;
    if (!drawn) return undefined;
    const comment = target.id ? store.comments.find((comment) => comment.id === target.id) : undefined;
    return comment && isMoved(comment) ? 0 : target.end;
  }

  /** The comments in the order the diff shows them, global ones first. */
  const ordered = createMemo(() => {
    const order = new Map([...sortedFiles(), ...openedFiles()].map((file, index) => [file.name, index]));
    const at = (comment: Comment) => (isGlobal(comment) ? -1 : (order.get(comment.file) ?? order.size));
    return store.comments.toSorted(
      (a, b) =>
        at(a) - at(b) ||
        a.file.localeCompare(b.file) ||
        (lineOf(a) ?? a.end) - (lineOf(b) ?? b.end) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
  });

  /** Writes a comment, or changes one, and returns its id. */
  function saveComment(target: Target, body: string): string | undefined {
    const file = fileByName(target.file);
    const existing = store.comments.some((comment) => comment.id === target.id);
    const id = existing
      ? target.id
      : isGlobal(target) || file || browsedText(target.file)
        ? newId()
        : undefined;
    if (id)
      setStore((s) => {
        const comment = s.comments.find((comment) => comment.id === id);
        if (comment) comment.body = body;
        else
          s.comments.push({
            id,
            file: target.file,
            side: target.side,
            start: target.start,
            end: target.end,
            body,
            excerpt: excerptAt(target),
            scope: isGlobal(target) ? undefined : scopeNote(),
            createdAt: Date.now(),
          });
      });
    cancelComposer();
    remember();
    return id;
  }

  function deleteComments(ids: Iterable<string>) {
    const gone = new Set(ids);
    setStore((s) => {
      for (let index = s.comments.length - 1; index >= 0; index--)
        if (gone.has(s.comments[index]!.id)) s.comments.splice(index, 1);
    });
    if (gone.has(composer()?.id ?? "")) cancelComposer();
    remember();
  }

  /** Deletes a comment and returns what puts it back. */
  function deleteComment(id: string): (() => void) | undefined {
    const gone = snapshot(store).comments.find((comment) => comment.id === id);
    if (!gone) return undefined;
    deleteComments([id]);
    return () => {
      setStore((s) => {
        if (!s.comments.some((comment) => comment.id === id)) s.comments.push(gone);
      });
      remember();
    };
  }

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
      await submit({ comments: snapshot(store).comments, session: store.review.session });
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
    onlyUnviewed,
    setOnlyUnviewed,
    onlyCommented,
    setOnlyCommented,
    isFiltered,
    openedFiles,
    openedByName,
    browsing,
    isBrowsing,
    browse,
    stopBrowsing,
    extendBrowsing,
    windowItems,
    treePaths,
    nameQuery,
    setNameQuery,
    showUnchanged,
    setShowUnchanged,
    catalog,
    readCatalog,
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
    keepWriting,
    hasUnsent,
    load,
    fileByName,
    isMoved,
    lineOf,
    isPreviewed,
    setPreviewed,
    previewChoices,
    showsCode,
    ordered,
    saveComment,
    deleteComment,
    deleteComments,
    isViewed,
    toggleViewed,
    finish,
  };
}

export const state = createRoot(createReviewState);
