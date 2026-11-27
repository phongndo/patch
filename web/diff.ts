//! Drives Pierre's CodeView: one virtualized scroller for every file, with
//! comments rendered as line annotations. Unchanged files the reviewer opened
//! follow the diff as plain files. A changed file's preview (an image, SVG,
//! Markdown) is an annotation above its first line, which CodeView measures
//! like a comment.

import {
  CodeView,
  type CodeViewDiffItem,
  type CodeViewFileItem,
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  i18n,
  type LineAnnotation,
  resolveThemes,
  type SelectedLineRange,
} from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { render, type JSX } from "@solidjs/web";
import { loadSide } from "./api.ts";
import { previewPanes, previewPlaces, previewToggles } from "./media.ts";
import { preferences, type Settings } from "./settings.ts";
import { useTheme } from "./themes.ts";
import { changesOf, rememberFile, type Change, type OpenedFile, type Target } from "./state.ts";

export type Note =
  | { kind: "comment"; id: string }
  | { kind: "composer"; target: Target }
  /** A file's preview: its sides together, or one side over its own column of a split diff. */
  | { kind: "media"; file: string; side?: "old" | "new" };

export interface DiffViewHooks {
  annotationsFor(file: string): DiffLineAnnotation<Note>[];
  renderNote(note: Exclude<Note, { kind: "media" }>): JSX.Element;
  /** A changed file rendered (an image, SVG, Markdown), before its lines and comments. */
  renderMedia(file: FileDiffMetadata, side?: "old" | "new"): JSX.Element;
  /** Whether a file with code to show is shown rendered too. */
  previewed(file: string): boolean;
  renderHeader(file: string): JSX.Element;
  /** `selected`: the lines stay selected while the comment is written, for Shift to extend. */
  onComment(file: string, range: SelectedLineRange, selected?: boolean): void;
  onCollapsedChange(file: string, collapsed: boolean): void;
  /** Names the review whose files context expansion reads. */
  scopeKey(): string;
  /** The reader is near the first or the last file shown. */
  onEdge?(edge: "start" | "end"): void;
}

const startup = preferences.settings;
// A community theme must be registered before the first render asks for it.
await Promise.all([useTheme(startup.lightTheme), useTheme(startup.darkTheme)]);
// The pool starts its workers only once its themes are resolved. Resolved first, it starts
// them as it is made, ahead of the review. Only the default themes, which the page preloads
// (vite.config.ts), are waited for: any other would keep the page blank while it loads.
const preloaded = new Set(["pierre-light", "pierre-dark"]);
if (preloaded.has(startup.lightTheme) && preloaded.has(startup.darkTheme))
  await resolveThemes([startup.lightTheme, startup.darkTheme], "highlights").catch(() => {});
const touchScreen = matchMedia("(hover: none)").matches;
/** Gap rows are as tall as a finger needs on a touch screen (unsafeCSS, below). */
const metrics = (lineHeight: number) => ({
  lineHeight,
  diffHeaderHeight: 44,
  paddingBottom: 0,
  ...(touchScreen && { hunkSeparatorHeight: 44 }),
});
const themesOf = (settings: Settings) => ({ dark: settings.darkTheme, light: settings.lightTheme });
// What the highlighter workers were last told, so they are re-told only on a change.
let workers = { ...themesOf(startup), wordDiff: startup.wordDiff };

const pool = getOrCreateWorkerPoolSingleton({
  poolOptions: {
    workerFactory: () => new DiffsWorker(),
    poolSize: Math.max(2, Math.min(3, (navigator.hardwareConcurrency || 4) - 1)),
  },
  highlighterOptions: {
    theme: themesOf(startup),
    preferredHighlighter: "highlights",
    preferredDiffLib: "@pierre/patches",
    lineDiffType: startup.wordDiff ? "word-alt" : "none",
  },
});

i18n.set({
  messages: {
    searchPlaceholder: "Find",
    unmodifiedLines: "{count, plural, one {# unchanged line} other {# unchanged lines}}",
    unknownUnmodifiedLines: "Rest of the file",
  },
});

const chevron = (direction: "up" | "down") =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="${
      direction === "up"
        ? "M4 10l4-4 4 4"
        : direction === "down"
          ? "M4 6l4 4 4-4"
          : "M5 6l3-3 3 3M5 10l3 3 3-3"
    }" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  )}")`;

/**
 * Pierre's find panel as one plain field: what is typed, how many match, the
 * match before and after, and close, in the page's own colors. Its toggles and
 * replace are gone; match case turns itself on (onSearchStateChange).
 */
const findBar = `
  [data-search-toggles],[data-replace-toggle],[data-replace-cell]{display:none!important}
  [data-editor-widget]{
    --diffs-search-panel-fg:var(--fg);
    --diffs-search-panel-bg:transparent;
    min-width:0;width:300px;max-width:calc(100% - 24px);box-sizing:border-box;height:36px;padding:0 4px 0 12px;
    border:1px solid var(--line-strong);border-radius:10px;
    background:var(--panel);box-shadow:var(--shadow);
    color:var(--fg);font:var(--ui-weight,400) var(--text)/1 var(--font);
  }
  [data-search-grid]{display:flex!important;align-items:center;gap:0;width:100%}
  [data-input-box][data-find]{flex:1;width:auto!important;min-width:0;border:0;background:none;outline:none!important}
  [data-input-box] input{padding:0;border:0;background:none;color:var(--fg);font:inherit;line-height:20px;caret-color:var(--info)}
  [data-input-box] input::placeholder{color:var(--muted);opacity:1}
  [data-matches]{padding-inline:8px;color:var(--muted)!important;font-size:var(--text-meta);font-weight:inherit}
  input:placeholder-shown + [data-matches]{display:none}
  [data-search-icon]{width:26px;height:26px;border-radius:var(--control-radius);color:var(--muted)}
  [data-search-icon]:not(:disabled):hover{background:var(--hover);color:var(--fg)}
  [data-search-icon]:focus-visible{outline:1px solid var(--muted);outline-offset:-1px}
  [data-search-nav] svg{display:none}
  [data-search-nav] [data-search-icon]::before{content:"";width:16px;height:16px;background:currentColor;mask:${chevron("down")}}
  [data-search-nav] [data-search-icon]:first-child::before{mask:${chevron("up")}}
  [data-search-close]{position:static;transform:none;background:none;box-shadow:none;color:var(--muted)}
  [data-search-close]:not(:disabled):hover{background:var(--hover);color:var(--fg)}
  @media (hover:none){[data-input-box] input{font-size:16px}}
`;

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
    : note.kind === "media"
      ? `media:${note.file}:${note.side ?? ""}`
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
  // Lines picked in the gutter are commented on as the press ends: pierre selects a line by its
  // number, a range by sliding along the numbers or by Shift. `pressedBy` is the pointer whose
  // press it is, which tells a reader's selection from one made by stepping; the gutter's +
  // opens its own comment.
  let pressedBy: number | undefined;
  let byButton = false;
  // The file just gone to, while the reader has not scrolled: a last file too short to reach the
  // top is still the one they chose.
  let chosen: string | undefined;
  let files = new Map<string, FileDiffMetadata>();
  let opened = new Map<string, OpenedFile>();
  const has = (name: string) => files.has(name) || opened.has(name);

  /** A file's notes: its preview first, then its comments. */
  const annotationsOf = (name: string): DiffLineAnnotation<Note>[] => {
    const annotations = hooks.annotationsFor(name);
    const diff = files.get(name);
    // Shown as one side alone, the diff draws notes above its lines only on that side: comments on
    // the whole file go there too.
    const alone = diff && onScreen(diff).type;
    if (alone === "new" || alone === "deleted")
      for (const annotation of annotations)
        if (annotation.lineNumber === 0) annotation.side = alone === "new" ? "additions" : "deletions";
    if (!diff || (previewToggles(diff) && !hooks.previewed(name))) return annotations;
    const places = previewPlaces(diff);
    annotations.unshift(
      ...places.map(
        ({ side, pane }) =>
          ({
            side,
            lineNumber: 0,
            metadata: { kind: "media", file: name, side: pane },
          }) as DiffLineAnnotation<Note>,
      ),
    );
    return annotations;
  };
  /**
   * Names where each gap between hunks leads: the function the hunk after it is in, from its
   * `@@` line. It goes at the end of the row's last column, which split leaves empty; CodeView
   * draws rows afresh, so this runs after each render.
   */
  const annotate = (name: string) => {
    const annotations = annotationsOf(name);
    signatures.set(name, annotations.map((annotation) => noteKey(annotation.metadata)).join("|"));
    const version = (versions.get(name) ?? 0) + 1;
    versions.set(name, version);
    return { annotations, version };
  };
  // A file shown as its preview goes to CodeView without its lines, as a binary file does, under a
  // key of its own so nothing drawn for its code is reused. One whose preview has one side (a file
  // only renamed or moved) goes as that side alone, so it takes the whole width as a new file
  // does. One copy per parse keeps it the same.
  const previewOnly = new WeakMap<FileDiffMetadata, FileDiffMetadata>();
  const onScreen = (file: FileDiffMetadata): FileDiffMetadata => {
    const hidden = previewToggles(file) && hooks.previewed(file.name);
    const panes = hidden || !file.hunks.length ? previewPanes(file) : [];
    const oneSide = panes.length === 1 && file.type !== "new" && file.type !== "deleted";
    if (!hidden && !oneSide) return file;
    let bare = previewOnly.get(file);
    if (!bare) {
      bare = {
        ...file,
        type: oneSide ? (panes[0]!.side === "old" ? "deleted" : "new") : file.type,
        hunks: [],
        additionLines: [],
        deletionLines: [],
        splitLineCount: 0,
        unifiedLineCount: 0,
        cacheKey: file.cacheKey && `${file.cacheKey}:preview`,
      };
      previewOnly.set(file, bare);
    }
    return bare;
  };
  const diffItem = (file: FileDiffMetadata, collapsed: boolean): CodeViewDiffItem<Note> => {
    const { annotations, version } = annotate(file.name);
    return { id: file.name, type: "diff", fileDiff: onScreen(file), annotations, collapsed, version };
  };
  // A whole file has one side, so its notes have none.
  const fileItem = (file: OpenedFile, collapsed: boolean): CodeViewFileItem<Note> => {
    const { annotations, version } = annotate(file.name);
    return {
      id: file.name,
      type: "file",
      file: { name: file.name, contents: file.contents },
      annotations: annotations.map(
        ({ lineNumber, metadata }) => ({ lineNumber, metadata }) as LineAnnotation<Note>,
      ),
      collapsed,
      version,
    };
  };
  const item = (name: string, collapsed: boolean): CodeViewItem<Note> | undefined => {
    const diff = files.get(name);
    if (diff) return diffItem(diff, collapsed);
    const whole = opened.get(name);
    return whole && fileItem(whole, collapsed);
  };

  const options = {
    theme: themesOf(startup),
    themeType: startup.colorScheme,
    itemMetrics: metrics(startup.lineHeight),
    preferredHighlighter: "highlights",
    diffStyle: "split",
    diffIndicators: startup.indicators,
    lineDiffType: startup.wordDiff ? "word-alt" : "none",
    hunkSeparators: "line-info-basic",
    overflow: startup.wrap ? "wrap" : "scroll",
    stickyHeaders: true,
    searchOptions: { disableShortcuts: true },
    onSearchStateChange(state?: { text: string; caseSensitive: boolean }) {
      // Match case is not a button: a capital in the search turns it on.
      if (state && state.caseSensitive !== (state.text !== state.text.toLowerCase()))
        root
          .querySelector("[data-search-panel]")
          ?.shadowRoot?.querySelector<HTMLElement>("[data-search-toggles] button")
          ?.click();
    },
    enableGutterUtility: true,
    enableLineSelection: true,
    lineHoverHighlight: "number",
    // A gap opens whole, in one click: never in steps.
    expansionLineCount: Number.MAX_SAFE_INTEGER,
    parseDiffOptions: { preferredDiffLib: "@pierre/patches" },
    // The last file ends at the foot of the window: nothing scrolls past it.
    layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
    // How strongly changes are tinted comes from the page (settings.ts, tint) through these
    // variables.
    unsafeCSS: [
      findBar,
      // Every file's numbers take the room of four digits, so code starts at one place in every
      // file, and a gap's row lays out on the same column: its chevron in the numbers' column, its
      // words where the code starts.
      "[data-line-number-content]{display:inline-block;min-width:4ch;text-align:right}",
      "[data-separator=line-info-basic] [data-separator-wrapper]{grid-template-columns:100% auto}",
      "[data-separator=line-info-basic] [data-expand-button]{width:100%}",
      // Its chevron sits where the file header's does, at the header's size, so every chevron down
      // the left edge lines up.
      "[data-separator=line-info-basic] [data-expand-button]{box-sizing:border-box;justify-content:start;padding-inline-start:calc(var(--file-head-inset) + (var(--file-head-button) - var(--icon-meta)) / 2)}",
      "[data-separator=line-info-basic] [data-expand-button] svg{width:var(--icon-meta);height:var(--icon-meta)}",
      // Nothing pulls past its end and springs back, as on the page.
      "[data-code]{overscroll-behavior:none}",
      // What is the review's and not the file's (comments, folded lines) sits on a band of its
      // own, lifted from the code as the file's header is.
      "[data-line-annotation],[data-gutter-buffer=annotation]{--diffs-annotation-bg:color-mix(in srgb,var(--diffs-fg) 4%,var(--diffs-bg))}",
      // Files run edge to edge, so each one's header is a band, lifted from the chrome in case a
      // theme's chrome and editor match, with a rule between it and the file above.
      "[data-diffs-header]{display:block;height:44px;background:color-mix(in srgb,var(--fg) 4%,var(--panel))!important;box-shadow:inset 0 -1px var(--line),inset 0 1px var(--line)}",
      "[data-separator]{background:color-mix(in srgb,var(--diffs-fg) 4%,var(--diffs-bg))!important}",
      "[data-separator] *{background:transparent!important;border-color:transparent!important}",
      // A gap's row opens whole from anywhere on it: its words reach across the row (CodeView takes
      // a click there as theirs, and gapRow, below, sends it clicks on the rest), and say so on hover.
      "[data-separator=line-info-basic] [data-unmodified-lines]::before{content:'';position:absolute;inset:0 calc(100% - 100cqw) 0 100%;cursor:pointer}",
      // (It ends at the edge of the file's code, measured as a container: past it, the file would
      // scroll sideways, and where scrollbars take room, show an empty track under it.)
      "[data-code]{container-type:inline-size}",
      "[data-separator=line-info-basic][data-patch-hover] [data-unmodified-lines]::after{content:' · show all';color:var(--diffs-fg-number)}",
      "[data-separator=line-info-basic] [data-expand-button]{cursor:pointer}",
      "[data-separator-content]:hover{text-decoration:none}",
      // Lit as one block, gutters and chevrons too, while pointed at (gapRow, below).
      "[data-separator][data-patch-hover]{background:color-mix(in srgb,var(--diffs-fg) 8%,var(--diffs-bg))!important}",
      "[data-separator][data-patch-hover] [data-separator-content]{color:var(--diffs-fg);text-decoration:none}",
      // A change is an edge and a tint that runs through its line number; nothing is hatched.
      "[data-column-number],[data-gutter-buffer]{border-right-color:transparent!important}",
      "[data-indicators=bars] [data-column-number][data-line-type=change-deletion]::before{background:var(--diffs-deletion-base)}",
      // Where a split side has fewer lines, its empty rows are hatched (pierre's own look), so
      // what is missing reads as missing, not as blank lines.
      // A file with no lines on screen (an image, or a file shown as its preview) has nothing to
      // number: its preview runs edge to edge, as a line of code does.
      "[data-code]:not(:has([data-line]))>[data-gutter]{display:none}",
      // A file's lines end at the next header, as they start at theirs: no band of background
      // below a last changed line (itemMetrics.paddingBottom says the same to the layout).
      "[data-diff],[data-code]{padding-bottom:0!important}",
      // Code scrolls sideways only when a line is wider than it: always-visible scrollbars
      // would otherwise draw an empty track under every file. CodeView's own override still wins.
      "[data-code]{overflow-x:var(--diffs-overflow-override,auto)}",
      // Where scrollbars take room, a file that scrolls sideways shows a slim handle, not a dark
      // track along its foot.
      "[data-code]{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--diffs-fg) 25%,transparent) transparent}",
      // Split, a preview's tint fills its whole side of the row (MediaPreview.tsx), so a short
      // side meets the other's end as a short side of code does.
      "[data-diff-type=split]:not(:has([data-line])) [data-line-annotation]{position:relative;--patch-pane-anchor:static}",
      "[data-diff-type=split]:not(:has([data-line])) [data-annotation-content]{position:static}",
      "[data-line],[data-no-newline],[data-gutter-buffer],[data-column-number]{--mix-dark:var(--patch-line-dark,82%);--mix-light:var(--patch-line-light,90%)}",
      // A finger slides along the numbers to pick lines (pierre's own touch-action); the comment
      // opens as it lets go, so the gutter's button, too small to hit, is not needed.
      "@media (hover:none){[data-gutter-utility-slot]{display:none!important}}",
      // A gap's row is as tall as a finger needs (itemMetrics says so to the layout).
      "@media (hover:none){[data-separator=line-info-basic]{height:44px}[data-separator=line-info-basic] [data-expand-button]{min-height:44px}}",
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
      if (note.kind === "media") {
        const file = files.get(note.file);
        return (
          file && notes.get(noteKey(note), () => hooks.renderMedia(file, note.side), "note-slot media-slot")
        );
      }
      return notes.get(noteKey(note), () => hooks.renderNote(note), "note-slot");
    },
    // The whole header is the page's, the same for a diff and a whole file.
    renderCustomHeader(file: { name: string }) {
      if (!has(file.name)) return undefined;
      const header = headers.get(file.name, () => hooks.renderHeader(file.name), "header-slot");
      return header;
    },
    onGutterUtilityClick(range: SelectedLineRange, context?: { item: CodeViewItem<Note> }) {
      byButton = true;
      if (context) hooks.onComment(context.item.id, range);
    },
    onLineSelectionEnd(range: SelectedLineRange | null, context?: { item: CodeViewItem<Note> }) {
      const file = context?.item.id;
      if (pressedBy === undefined || byButton || !range || !file) return;
      // A file seen whole has no sides: its lines are the new ones.
      const side = range.side ?? "additions";
      hooks.onComment(file, { ...range, side, endSide: range.endSide ?? side }, true);
    },
    onLineEnter(line: { lineNumber: number }, context?: { item: CodeViewItem<Note> }) {
      if (!context) return;
      const side = "annotationSide" in line ? (line.annotationSide as Change["side"]) : undefined;
      if (side || context.item.type === "file")
        hovered = {
          file: context.item.id,
          side: side ?? "additions",
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

  /** Re-sends a file whose comments or preview changed; unchanged files are left alone. */
  function refreshAnnotations() {
    const keep = new Set<string>();
    for (const name of [...files.keys(), ...opened.keys()]) {
      const annotations = annotationsOf(name);
      for (const annotation of annotations) keep.add(noteKey(annotation.metadata));
      const signature = annotations.map((annotation) => noteKey(annotation.metadata)).join("|");
      if (signature === signatures.get(name)) continue;
      const next = item(name, view.getItem(name)?.collapsed ?? false);
      if (next) view.updateItem(next);
    }
    notes.retain(keep);
  }

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
        chosen = undefined;
      },
      { passive: true, signal: listening.signal },
    );
  // Near either end, more files may be wanted; checked once a frame at most.
  let edgeFrame = 0;
  function checkEdges() {
    const { scrollTop, scrollHeight, clientHeight } = root;
    if (scrollTop + clientHeight >= scrollHeight - clientHeight) hooks.onEdge?.("end");
    if (scrollTop < clientHeight / 2) hooks.onEdge?.("start");
  }
  const soon = () => {
    edgeFrame ||= requestAnimationFrame(() => {
      edgeFrame = 0;
      checkEdges();
    });
  };
  root.addEventListener("scroll", soon, { passive: true, signal: listening.signal });
  // At the very top or bottom a wheel moves nothing, so no scroll says the reader wants more.
  root.addEventListener(
    "wheel",
    (event) => {
      const { scrollTop, scrollHeight, clientHeight } = root;
      if (event.deltaY < 0 && scrollTop <= 0) hooks.onEdge?.("start");
      else if (event.deltaY > 0 && scrollTop + clientHeight >= scrollHeight - 1) hooks.onEdge?.("end");
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

  // A gap's row is drawn as a cell per column, gutters included, of which only the first gutter's
  // words and chevrons open it. The row works as one: lit whole while pointed at, and opened by a
  // click anywhere on it.
  let lit: Element[] = [];
  const gapRow = (event: Event): Element[] => {
    const cell = event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.matches("[data-separator][data-expand-index]"),
      );
    const index = cell?.getAttribute("data-expand-index");
    const pre = cell?.closest("pre");
    return pre ? [...pre.querySelectorAll(`[data-separator][data-expand-index="${index}"]`)] : [];
  };
  const light = (row: Element[]) => {
    if (row[0] === lit[0] && (!row[0] || row[0].isConnected)) return;
    for (const cell of lit) cell.removeAttribute("data-patch-hover");
    for (const cell of row) cell.setAttribute("data-patch-hover", "");
    lit = row;
  };
  // On every move, not only on entering a cell: a row redrawn under a still pointer (as one is
  // when it opens) has new cells, which no pointer entered.
  root.addEventListener("pointermove", (event) => light(gapRow(event)), {
    passive: true,
    signal: listening.signal,
  });
  root.addEventListener("pointerleave", () => light([]), { signal: listening.signal });
  root.addEventListener(
    "click",
    (event) => {
      const target = event.composedPath()[0];
      if (!(target instanceof Element) || target.closest("[data-expand-button],[data-unmodified-lines]"))
        return;
      // A cell of the row CodeView does not open it from (the other side's gutter): open it as its
      // words would.
      gapRow(event)
        .map((cell) => cell.querySelector<HTMLElement>("[data-unmodified-lines]"))
        .find((words) => words && words.getBoundingClientRect().width > 0)
        ?.click();
    },
    { signal: listening.signal },
  );
  root.addEventListener(
    "pointerdown",
    (event) => {
      endFlash(); // What is selected from here on is the reader's own.
      pointed = true;
      pressedBy ??= event.pointerId;
      if (event.target === root) stepped = undefined; // The scrollbar.
    },
    { capture: true, signal: listening.signal },
  );
  // A press ends after pierre has told the selection it made, which counts as the reader's.
  addEventListener(
    "pointerup",
    (event: PointerEvent) => {
      if (event.pointerId !== pressedBy) return;
      setTimeout(() => {
        pressedBy = undefined;
        byButton = false;
      });
    },
    { signal: listening.signal },
  );
  addEventListener(
    "pointercancel",
    (event: PointerEvent) => event.pointerId === pressedBy && (pressedBy = undefined),
    {
      signal: listening.signal,
    },
  );

  return {
    view,
    /**
     * Scrolls to the next run of changed lines after where the reader is, and lights it up for a
     * moment. Nothing stays selected: stepping is a way to move, not a cursor to carry around.
     */
    stepChange(direction: 1 | -1) {
      const changes = [...files.values()]
        .filter((file) => !view.getItem(file.name)?.collapsed && onScreen(file) === file)
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
      if (!lines || !has(lines.file)) return undefined;
      return { file: lines.file, range: { start: lines.start, end: lines.end, side: lines.side } };
    },
    /** Shows files in this order: a changed one as its diff, an unchanged one whole. */
    setFiles(next: ReadonlyArray<FileDiffMetadata | OpenedFile>, collapsed: (name: string) => boolean) {
      notes.clear();
      headers.clear();
      hovered = undefined;
      stepped = undefined;
      // Versions keep counting across reloads: CodeView redraws a file only when its version moves.
      files = new Map();
      opened = new Map();
      for (const item of next)
        if ("hunks" in item) files.set(item.name, item);
        else opened.set(item.name, item);
      view.setItems(
        next.map((item) =>
          "hunks" in item ? diffItem(item, collapsed(item.name)) : fileItem(item, collapsed(item.name)),
        ),
      );
    },
    /** Says whether the reader is near either end, as after scrolling there. */
    checkEdges,
    refreshAnnotations,
    setCollapsed(name: string, collapsed: boolean) {
      const current = view.getItem(name);
      if (!current || (current.collapsed ?? false) === collapsed) return;
      const next = item(name, collapsed);
      if (next) view.updateItem(next);
    },
    /** Shows changed files whole, every unchanged line unfolded: while browsing, or when asked for. */
    setExpanded(whole: boolean) {
      if ((options.expandUnchanged ?? false) === whole) return;
      options.expandUnchanged = whole;
      view.setOptions({ ...options });
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
        itemMetrics: metrics(settings.lineHeight),
      });
      if (workersChanged) void pool.setRenderOptions({ theme, lineDiffType });
      view.setOptions({ ...options });
    },
    scrollToFile(name: string) {
      stepped = undefined;
      chosen = name;
      view.scrollTo({ type: "item", id: name, align: "start", behavior: "instant" });
    },
    scrollToLine(name: string, lineNumber: number, side: "additions" | "deletions") {
      stepped = undefined;
      view.scrollTo({
        type: "line",
        id: name,
        lineNumber,
        side: opened.has(name) ? undefined : side,
        align: "center",
        behavior: "smooth-auto",
      });
    },
    /** Where the reader is, to come back to after the files are replaced. */
    anchor,
    restore(anchor: ReturnType<typeof view.getScrollAnchor>) {
      if (anchor) view.scrollToAnchor(anchor, "instant");
    },
    topFile(): string | undefined {
      return chosen && has(chosen) ? chosen : anchor()?.id;
    },
    find: (query?: string) => view.openSearch({ scope: "all", query, mode: "find" }),
    clearSelection() {
      view.clearSelectedLines();
    },
    destroy() {
      cancelAnimationFrame(edgeFrame);
      clearTimeout(flash);
      listening.abort();
      notes.clear();
      headers.clear();
      view.cleanUp();
    },
  };
}

export type DiffView = ReturnType<typeof createDiffView>;
