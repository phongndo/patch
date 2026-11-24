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
import type { Target } from "./state.ts";

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
    enableGutterUtility: true,
    enableLineSelection: true,
    lineHoverHighlight: "number",
    expansionLineCount: 20,
    parseDiffOptions: { preferredDiffLib: "@pierre/patches" },
    layout: { paddingTop: 12, paddingBottom: 160, gap: 12 },
    // Comment rows sit on the editor's own background, not a grey band across both sides.
    unsafeCSS:
      "[data-line-annotation],[data-gutter-buffer=annotation]{--diffs-annotation-bg:var(--diffs-bg)}",
    async loadDiffFiles(fileDiff) {
      const key = hooks.scopeKey();
      const [oldText, newText] = await Promise.all([
        fileDiff.type === "new" ? "" : loadSide(key, "old", fileDiff.prevName ?? fileDiff.name),
        fileDiff.type === "deleted" ? "" : loadSide(key, "new", fileDiff.name),
      ]);
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
    onItemCollapsedChange(_item, nextItem) {
      hooks.onCollapsedChange(nextItem.id, nextItem.collapsed ?? false);
    },
  } as NonNullable<ConstructorParameters<typeof CodeView<Note>>[0]>;
  const view = new CodeView<Note>(options, pool);
  view.setup(root);

  return {
    view,
    setFiles(next: FileDiffMetadata[], collapsed: (file: FileDiffMetadata) => boolean) {
      notes.clear();
      headers.clear();
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
      view.scrollTo({ type: "item", id: name, align: "start", behavior: "instant" });
    },
    scrollToLine(name: string, lineNumber: number, side: "additions" | "deletions") {
      view.scrollTo({ type: "line", id: name, lineNumber, side, align: "center", behavior: "smooth-auto" });
    },
    /** Where the reader is, to come back to after the files are replaced. */
    anchor: () => view.getScrollAnchor(view.getScrollTop()),
    restore(anchor: ReturnType<typeof view.getScrollAnchor>) {
      if (anchor) view.scrollToAnchor(anchor, "instant");
    },
    topFile(): string | undefined {
      return view.getScrollAnchor(view.getScrollTop())?.id;
    },
    find: (query: string) => view.openSearch({ scope: "all", query, mode: "find" }),
    clearSelection: () => view.clearSelectedLines(),
    destroy() {
      notes.clear();
      headers.clear();
      view.cleanUp();
    },
  };
}

export type DiffView = ReturnType<typeof createDiffView>;
