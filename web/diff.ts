//! Drives Pierre's CodeView: one virtualized scroller for every file, with
//! comments rendered as line annotations.

import {
  CodeView,
  type CodeViewDiffItem,
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { render, type JSX } from "@solidjs/web";
import { loadSide } from "./api.ts";
import { preferences, type Settings } from "./settings.ts";
import { useTheme } from "./themes.ts";
import { changesOf, rememberFile, type Change, type Target } from "./state.ts";

export type Note = { kind: "comment"; id: string } | { kind: "composer"; target: Target };

export interface DiffViewHooks {
  annotationsFor(file: string): DiffLineAnnotation<Note>[];
  renderNote(note: Note): JSX.Element;
  renderHeader(file: FileDiffMetadata): JSX.Element;
  onComment(file: string, range: SelectedLineRange): void;
  onCollapsedChange(file: string, collapsed: boolean): void;
  /** Names the review whose files context expansion reads. */
  scopeKey(): string;
}

const startup = preferences.settings;
// A community theme must be registered before the first render asks for it.
await Promise.all([useTheme(startup.lightTheme), useTheme(startup.darkTheme)]);
const themesOf = (settings: Settings) => ({ dark: settings.darkTheme, light: settings.lightTheme });
// What the highlighter workers were last told, so they are re-told only on a change.
let workers = { ...themesOf(startup), wordDiff: startup.wordDiff };

const pool = getOrCreateWorkerPoolSingleton({
  poolOptions: {
    workerFactory: () => new DiffsWorker(),
    poolSize: Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1)),
  },
  highlighterOptions: {
    theme: themesOf(startup),
    preferredHighlighter: "highlights",
    preferredDiffLib: "@pierre/patches",
    lineDiffType: startup.wordDiff ? "word-alt" : "none",
  },
});

/** Mounts Solid content into a plain element once, and disposes it when dropped. */
class Mounts {
  #mounted = new Map<string, { element: HTMLElement; dispose: () => void }>();
  get(key: string, view: () => JSX.Element, className: string): HTMLElement {
    let mounted = this.#mounted.get(key);
    if (!mounted) {
      const element = document.createElement("div");
      element.className = className;
      mounted = { element, dispose: render(view, element) };
      this.#mounted.set(key, mounted);
    }
    return mounted.element;
  }
  /** Drops every mount whose key is not in `keep`. */
  retain(keep: Set<string>) {
    for (const [key, mounted] of this.#mounted)
      if (!keep.has(key)) {
        mounted.dispose();
        this.#mounted.delete(key);
      }
  }
  clear() {
    this.retain(new Set());
  }
}

export const noteKey = (note: Note) =>
  note.kind === "comment"
    ? `c:${note.id}`
    : `composer:${note.target.file}:${note.target.side}:${note.target.end}:${note.target.id ?? ""}`;

export function createDiffView(root: HTMLElement, hooks: DiffViewHooks) {
  const notes = new Mounts();
  const headers = new Mounts();
  const versions = new Map<string, number>();
  const signatures = new Map<string, string>();
  // The line under the pointer, and the change last stepped to until the reader scrolls on.
  let hovered: Change | undefined;
  let stepped: Change | undefined;
  // Whether the pointer moved since that step; a page scrolled under a still pointer is not pointing.
  let pointed = true;
  let flash: ReturnType<typeof setTimeout> | undefined;
  let files = new Map<string, FileDiffMetadata>();

  const item = (file: FileDiffMetadata, collapsed: boolean): CodeViewDiffItem<Note> => {
    const annotations = hooks.annotationsFor(file.name);
    signatures.set(file.name, annotations.map((annotation) => noteKey(annotation.metadata)).join("|"));
    const version = (versions.get(file.name) ?? 0) + 1;
    versions.set(file.name, version);
    return { id: file.name, type: "diff", fileDiff: file, annotations, collapsed, version };
  };

  const options = {
    theme: themesOf(startup),
    themeType: startup.colorScheme,
    itemMetrics: { lineHeight: startup.lineHeight },
    preferredHighlighter: "highlights",
    diffStyle: "split",
    diffIndicators: startup.indicators,
    lineDiffType: startup.wordDiff ? "word-alt" : "none",
    hunkSeparators: "line-info",
    overflow: startup.wrap ? "wrap" : "scroll",
    stickyHeaders: true,
    searchOptions: { disableShortcuts: true },
    enableGutterUtility: true,
    enableLineSelection: true,
    lineHoverHighlight: "number",
    expansionLineCount: 20,
    parseDiffOptions: { preferredDiffLib: "@pierre/patches" },
    layout: { paddingTop: 12, paddingBottom: 160, gap: 12 },
    // Comment rows sit on the editor's background; how strongly changes are
    // tinted comes from the page (settings.ts, tint) through these variables.
    unsafeCSS: [
      "[data-line-annotation],[data-gutter-buffer=annotation]{--diffs-annotation-bg:var(--diffs-bg)}",
      "[data-line],[data-no-newline]{--mix-dark:var(--patch-line-dark,80%);--mix-light:var(--patch-line-light,88%)}",
      "[data-gutter-buffer],[data-column-number]{--mix-dark:var(--patch-number-dark,85%);--mix-light:var(--patch-number-light,91%)}",
    ].join("\n"),
    async loadDiffFiles(fileDiff) {
      const key = hooks.scopeKey();
      const [oldText, newText] = await Promise.all([
        fileDiff.type === "new" ? "" : loadSide(key, "old", fileDiff.prevName ?? fileDiff.name),
        fileDiff.type === "deleted" ? "" : loadSide(key, "new", fileDiff.name),
      ]);
      rememberFile(fileDiff.name, oldText, newText);
      return {
        oldFile: { name: fileDiff.prevName ?? fileDiff.name, contents: oldText },
        newFile: { name: fileDiff.name, contents: newText },
      };
    },
    renderAnnotation(annotation: { metadata: Note }) {
      const note = annotation.metadata;
      return notes.get(noteKey(note), () => hooks.renderNote(note), "note-slot");
    },
    renderHeaderMetadata(file: { name: string }) {
      const fileDiff = files.get(file.name);
      return fileDiff ? headers.get(file.name, () => hooks.renderHeader(fileDiff), "header-slot") : undefined;
    },
    onGutterUtilityClick(range: SelectedLineRange, context?: { item: CodeViewItem<Note> }) {
      if (context) hooks.onComment(context.item.id, range);
    },
    onLineEnter(line: { lineNumber: number }, context?: { item: CodeViewItem<Note> }) {
      if (context && "annotationSide" in line)
        hovered = {
          file: context.item.id,
          side: line.annotationSide as Change["side"],
          start: line.lineNumber,
          end: line.lineNumber,
        };
    },
    onLineLeave() {
      hovered = undefined;
    },
    onItemCollapsedChange(_item, nextItem) {
      hooks.onCollapsedChange(nextItem.id, nextItem.collapsed ?? false);
    },
  } as NonNullable<ConstructorParameters<typeof CodeView<Note>>[0]>;
  const view = new CodeView<Note>(options, pool);
  view.setup(root);

  const anchor = () => view.getScrollAnchor(view.getScrollTop());

  function endFlash() {
    if (flash === undefined) return;
    clearTimeout(flash);
    flash = undefined;
    view.clearSelectedLines();
  }
  // Once the reader scrolls, stepping goes on from what is on screen.
  const listening = new AbortController();
  for (const name of ["wheel", "touchmove"])
    root.addEventListener(
      name,
      () => {
        stepped = undefined;
      },
      { passive: true, signal: listening.signal },
    );
  root.addEventListener(
    "pointermove",
    (event) => {
      if (event.movementX || event.movementY) pointed = true;
    },
    { passive: true, signal: listening.signal },
  );
  root.addEventListener(
    "pointerdown",
    (event) => {
      endFlash(); // What is selected from here on is the reader's own.
      pointed = true;
      if (event.target === root) stepped = undefined; // The scrollbar.
    },
    { capture: true, signal: listening.signal },
  );

  return {
    view,
    /**
     * Scrolls to the next run of changed lines after where the reader is, and lights it up for a
     * moment. Nothing stays selected: stepping is a way to move, not a cursor to carry around.
     */
    stepChange(direction: 1 | -1) {
      const changes = [...files.values()]
        .filter((file) => !view.getItem(file.name)?.collapsed)
        .flatMap(changesOf);
      const same = (a: Change, b: Change) =>
        a.file === b.file && a.side === b.side && a.start === b.start && a.end === b.end;
      const last = stepped;
      const index = last ? changes.findIndex((change) => same(change, last)) : -1;
      let next: Change | undefined;
      if (index >= 0) next = changes[index + direction];
      else {
        const names = [...files.keys()];
        const at = anchor();
        const here = names.indexOf(at?.id ?? "");
        const line = at?.type === "line" ? at : undefined;
        const after = (change: Change) => {
          const file = names.indexOf(change.file);
          if (file !== here) return file > here;
          return !line || line.side !== change.side || change.end >= line.lineNumber;
        };
        next = direction > 0 ? changes.find(after) : changes.findLast((change) => !after(change));
      }
      if (!next) return;
      const { file, side, start, end } = next;
      stepped = next;
      pointed = false;
      clearTimeout(flash);
      view.setSelectedLines({ id: file, range: { start, end, side, endSide: side } });
      flash = setTimeout(endFlash, 700);
      view.scrollTo({
        type: "line",
        id: file,
        lineNumber: start,
        side,
        align: "center",
        behavior: "smooth-auto",
      });
    },
    /** The lines a new comment would be about: selected, pointed at, or just stepped to. */
    commentTarget(): { file: string; range: SelectedLineRange } | undefined {
      const selection = flash === undefined ? view.getSelectedLines() : null;
      if (selection) return { file: selection.id, range: selection.range };
      const lines = (pointed ? hovered : undefined) ?? stepped ?? hovered;
      if (!lines || !files.has(lines.file)) return undefined;
      return { file: lines.file, range: { start: lines.start, end: lines.end, side: lines.side } };
    },
    setFiles(next: FileDiffMetadata[], collapsed: (file: FileDiffMetadata) => boolean) {
      notes.clear();
      headers.clear();
      hovered = undefined;
      stepped = undefined;
      // Versions keep counting across reloads: CodeView redraws a file only when its version moves.
      files = new Map(next.map((file) => [file.name, file]));
      view.setItems(next.map((file) => item(file, collapsed(file))));
    },
    /** Re-sends a file whose comments changed; unchanged files are left alone. */
    refreshAnnotations() {
      const keep = new Set<string>();
      for (const [name, file] of files) {
        const annotations = hooks.annotationsFor(name);
        for (const annotation of annotations) keep.add(noteKey(annotation.metadata));
        const signature = annotations.map((annotation) => noteKey(annotation.metadata)).join("|");
        if (signature === signatures.get(name)) continue;
        const current = view.getItem(name);
        view.updateItem(item(file, current?.collapsed ?? false));
      }
      notes.retain(keep);
    },
    setCollapsed(name: string, collapsed: boolean) {
      const file = files.get(name);
      const current = view.getItem(name);
      if (!file || !current || (current.collapsed ?? false) === collapsed) return;
      view.updateItem(item(file, collapsed));
    },
    setLayout(diffStyle: "split" | "unified") {
      options.diffStyle = diffStyle;
      view.setOptions({ ...options });
    },
    /** Applies the reviewer's settings to the diff, including the highlighter workers. */
    async configure(settings: Settings) {
      await Promise.all([useTheme(settings.lightTheme), useTheme(settings.darkTheme)]);
      const theme = themesOf(settings);
      const lineDiffType = settings.wordDiff ? "word-alt" : "none";
      const workersChanged =
        theme.dark !== workers.dark ||
        theme.light !== workers.light ||
        settings.wordDiff !== workers.wordDiff;
      workers = { ...theme, wordDiff: settings.wordDiff };
      Object.assign(options, {
        theme,
        themeType: settings.colorScheme,
        diffIndicators: settings.indicators,
        lineDiffType,
        overflow: settings.wrap ? "wrap" : "scroll",
        itemMetrics: { lineHeight: settings.lineHeight },
      });
      if (workersChanged) void pool.setRenderOptions({ theme, lineDiffType });
      view.setOptions({ ...options });
    },
    scrollToFile(name: string) {
      stepped = undefined;
      view.scrollTo({ type: "item", id: name, align: "start", behavior: "instant" });
    },
    scrollToLine(name: string, lineNumber: number, side: "additions" | "deletions") {
      stepped = undefined;
      view.scrollTo({ type: "line", id: name, lineNumber, side, align: "center", behavior: "smooth-auto" });
    },
    /** Where the reader is, to come back to after the files are replaced. */
    anchor,
    restore(anchor: ReturnType<typeof view.getScrollAnchor>) {
      if (anchor) view.scrollToAnchor(anchor, "instant");
    },
    topFile(): string | undefined {
      return anchor()?.id;
    },
    find: (query?: string) => view.openSearch({ scope: "all", query, mode: "find" }),
    clearSelection: () => view.clearSelectedLines(),
    destroy() {
      clearTimeout(flash);
      listening.abort();
      notes.clear();
      headers.clear();
      view.cleanUp();
    },
  };
}

export type DiffView = ReturnType<typeof createDiffView>;
