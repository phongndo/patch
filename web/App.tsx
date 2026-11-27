import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/solid/popover";
import { toast, Toast, ToastAction, ToastRegion, ToastTitle } from "@ui-sdk/solid/toast";
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  flush,
  For,
  onSettled,
  Show,
  lazy,
} from "solid-js";
import type { Comment, Side } from "../src/protocol.ts";
import { stayConnected } from "./api.ts";
import type { Action } from "./commands.ts";
import { createDiffView, type DiffView, type Note } from "./diff.ts";
import { copyText, feedbackText } from "./feedback.ts";
import { bindActions, type Handler } from "./hotkeys.ts";
import { FileIcon } from "./FileIcon.tsx";
import { MediaPreview } from "./MediaPreview.tsx";
import { previewToggles } from "./media.ts";
import { Icon, statusIcons } from "./Icon.tsx";
import { CommentsSide } from "./CommentsPanel.tsx";
import { CommentCard, Composer } from "./Notes.tsx";
import { openPalette, Palette } from "./Palette.tsx";
import {
  kindOf,
  kinds,
  opensCollapsed,
  state,
  stats,
  statusOf,
  globalTarget,
  isGlobal,
  wholeFile,
  type Kind,
  type OpenedFile,
  type Target,
} from "./state.ts";
import { ScopePicker } from "./ScopePicker.tsx";
import { defaults, preferences } from "./settings.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Splitter } from "./splitter.ts";
import {
  filterOpen,
  keepsOwnView,
  narrow,
  ownComments,
  ownFiles,
  ownLayout,
  setOwnComments,
  setOwnFiles,
  setOwnLayout,
  touchOnly,
  palette,
  scopeOpen,
  setScopeOpen,
  setScopeTab,
  setSettingsOpen,
  setSettingsPage,
  settingsOpen,
  type ScopeTab,
  type SettingsPage,
} from "./ui.ts";

const SettingsDialog = lazy(() =>
  import("./SettingsDialog.tsx").then((m) => ({ default: m.SettingsDialog })),
);

type Layout = "split" | "unified";
const title = (word: string) => word[0]!.toUpperCase() + word.slice(1);
const { settings } = preferences;
const initialLayout: Layout =
  settings.layout === "auto" ? (innerWidth >= 1200 ? "split" : "unified") : settings.layout;

export function App() {
  const { store } = state;
  const [layout, setLayout] = createSignal<Layout>(initialLayout);
  // A device that keeps its own view opens its panels for itself (ui.ts); on a narrow window
  // they are drawers, so one opening closes the other.
  const sidebar = () => (keepsOwnView() ? ownFiles() : settings.sidebarOpen);
  const setSidebar = (toggle: (shown: boolean) => boolean) => {
    if (!keepsOwnView()) return preferences.update({ sidebarOpen: toggle(settings.sidebarOpen) });
    const shown = toggle(ownFiles());
    setOwnFiles(shown);
    if (shown && narrow()) setOwnComments(false);
  };
  const minWidth = 180;
  const [maxWidth, setMaxWidth] = createSignal(Math.round(innerWidth / 2));
  // Follows a drag on its own; the setting, and every effect on it, waits for the end.
  const [sidebarWidth, setSidebarWidth] = createSignal(() => settings.sidebarWidth);
  createEffect(sidebarWidth, (width) =>
    document.documentElement.style.setProperty("--sidebar", `${width}px`),
  );
  const [commentsWidth, setCommentsWidth] = createSignal(() => settings.commentsWidth);
  createEffect(commentsWidth, (width) =>
    document.documentElement.style.setProperty("--comments", `${width}px`),
  );
  const shownLayout = () => (touchOnly() ? ownLayout() : layout());
  const commentsShown = () => (keepsOwnView() ? ownComments() : settings.commentsOpen);
  const setComments = (shown: boolean) => {
    if (!keepsOwnView()) return preferences.update({ commentsOpen: shown });
    setOwnComments(shown);
    if (shown && narrow()) setOwnFiles(false);
  };
  // A finger pulling down from the bar opens the palette, as pulling down refreshes elsewhere: a
  // touch screen has no ⌘K. `pull` is how far, past PULL it opens on letting go.
  const PULL = 64;
  const [pull, setPull] = createSignal(0);
  // How far, read as the pull ends: the signal draws the mark, and updates only once flushed.
  let pulled = 0;
  let pullFrom: number | undefined;
  let barElement: HTMLElement | undefined;
  const pullStart = (event: TouchEvent) => {
    // Only from the bar itself: a menu it opened passes its touches to it too.
    const onBar = barElement?.contains(event.target as Node);
    pullFrom = onBar && event.touches.length === 1 ? event.touches[0]!.clientY : undefined;
  };
  const pullMove = (event: TouchEvent) => {
    if (pullFrom === undefined) return;
    pulled = Math.max(0, event.touches[0]!.clientY - pullFrom);
    setPull(pulled);
  };
  const pullEnd = () => {
    const far = pulled;
    pulled = 0;
    pullFrom = undefined;
    setPull(0);
    if (far < 10) return;
    // A pull that began on a button is not a tap on it: only the click the pull itself ends with,
    // at once and on the bar, is let go.
    const until = performance.now() + 100;
    const swallow = (event: Event) => {
      if (performance.now() < until && (event.target as Element | null)?.closest?.("header.bar"))
        event.stopPropagation();
    };
    addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", swallow, { capture: true }), 100);
    if (far >= PULL) openPalette();
  };
  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({});
  let scroller: HTMLElement | undefined;
  let diff: DiffView | undefined;

  // Lines added and removed per kind of file, and in all.
  const breakdown = createMemo(() => {
    const rows = new Map<Kind | "total", { additions: number; deletions: number }>();
    for (const key of [...kinds, "total"] as const) rows.set(key, { additions: 0, deletions: 0 });
    for (const file of state.files()) {
      const counts = stats(file);
      for (const key of [kindOf(file), "total"] as const) {
        const row = rows.get(key)!;
        row.additions += counts.additions;
        row.deletions += counts.deletions;
      }
    }
    return rows;
  });
  const totals = () => breakdown().get("total")!;
  const number = new Intl.NumberFormat();
  const commentCount = () => store.comments.length;
  /** Where a finished review went: with no comments it passed, which a harness may take quietly. */
  const sent = () =>
    store.comments.some((comment) => comment.body.trim()) ? "Sent to the agent." : "The review passed.";
  /** Finishing with no comments passes the changes, so there must be some to pass. */
  const canFinish = () =>
    !store.submitted && (state.hasUnsent() || (!store.loading && !store.error && state.files().length > 0));

  function annotationsFor(name: string): DiffLineAnnotation<Note>[] {
    const composer = state.composer();
    const annotations: DiffLineAnnotation<Note>[] = [];
    const add = (target: Target, metadata: Note) => {
      const lineNumber = state.lineOf(target);
      if (lineNumber === undefined) return;
      // Above a file's lines, the side must be one the file has.
      const top = state.fileByName(name)?.type === "deleted" ? "deletions" : "additions";
      const side = lineNumber ? target.side : top;
      annotations.push({ side, lineNumber, metadata } as DiffLineAnnotation<Note>);
    };
    // An editor takes its comment's place; a new one goes below what is there.
    const editing = composer?.file === name ? composer : undefined;
    for (const comment of state.ordered()) {
      if (comment.file !== name) continue;
      if (editing && comment.id === editing.id) add(editing, { kind: "composer", target: editing });
      else add(comment, { kind: "comment", id: comment.id });
    }
    if (editing && !editing.id) add(editing, { kind: "composer", target: editing });
    return annotations;
  }

  function comment() {
    const target = diff?.commentTarget();
    if (target) openComposer(target.file, target.range);
    else toast.info("Select lines first, or point at one.", { id: "hint" });
  }

  function openComposer(file: string, range: SelectedLineRange, selected = false) {
    const side = range.endSide ?? range.side ?? "additions";
    const sameSide = (range.side ?? side) === side;
    const target: Target = {
      file,
      side,
      start: sameSide ? Math.min(range.start, range.end) : range.end,
      end: sameSide ? Math.max(range.start, range.end) : range.end,
    };
    compose(target);
    // The gutter's + selects its line after this handler runs; picked lines stay selected, for
    // Shift to extend, until the comment closes (below).
    if (!selected) requestAnimationFrame(() => diff?.clearSelection());
  }

  /** Opens an editor, in the diff or, for what it has no place for, in the sidebar. */
  function compose(target: Target) {
    state.compose(target);
    if (state.lineOf(target) === undefined) return setComments(true);
    if (collapsed[target.file]) setFileCollapsed(target.file, false);
    // The header stays on screen while the file's first line, which this goes above, scrolls away.
    if (state.lineOf(target) === 0 && currentFile() === target.file) diff?.scrollToFile(target.file);
  }

  function setFileCollapsed(file: string, value: boolean) {
    setCollapsed((s) => {
      s[file] = value;
    });
    diff?.setCollapsed(file, value);
  }

  // Collapses every listed file, or expands them all when they already are.
  // Of the files on screen: the review's, or those browsed.
  const allCollapsed = () => {
    const files = shown().items;
    return files.length > 0 && files.every((file) => collapsed[file.name]);
  };
  function toggleAll() {
    const value = !allCollapsed();
    for (const file of shown().items) setFileCollapsed(file.name, value);
  }

  /** Shows a file rendered, or its code; false when it has no other view. */
  function togglePreview(name: string) {
    const file = state.fileByName(name);
    if (!file || !previewToggles(file)) return false;
    state.setPreviewed(name, !state.isPreviewed(name));
    if (collapsed[name]) setFileCollapsed(name, false);
    // A comment being written on lines the preview hides goes on in the comments panel: open it.
    flush();
    const draft = state.composer();
    if (draft?.file === name && state.lineOf(draft) === undefined) setComments(true);
    return true;
  }

  function toggleViewed(file: string) {
    if (!state.fileByName(file)) return false; // An unchanged file has nothing to view.
    const viewed = state.toggleViewed(file);
    setFileCollapsed(file, viewed);
    return viewed;
  }

  /**
   * A file's header, the same for a diff and a whole file: fold, its icon and path, what
   * happened to it, then its counts and what can be done to it.
   */
  function FileHeader(props: { name: string }) {
    const diffFile = () => state.fileByName(props.name);
    const status = () => {
      const file = diffFile();
      return file ? statusOf(file) : undefined;
    };
    const viewed = () => state.isViewed(props.name);
    const folded = () => collapsed[props.name] ?? false;
    const count = () => store.comments.filter((comment) => comment.file === props.name).length;
    const counts = () => {
      const file = diffFile();
      return file ? stats(file) : undefined;
    };
    const at = () => props.name.lastIndexOf("/") + 1;
    const statusLabel = () => {
      const file = diffFile();
      if (!file) return "Unchanged: not part of the change";
      const was = statusOf(file);
      return was === "renamed" ? `Renamed from ${file.prevName}` : title(was);
    };
    return (
      <div class={{ "file-head": true, viewed: viewed() }}>
        <button
          class={{ "icon-button": true, chevron: true, closed: folded() }}
          title={folded() ? "Show the file" : "Hide the file"}
          aria-expanded={folded() ? "false" : "true"}
          onClick={() => setFileCollapsed(props.name, !folded())}
        >
          <Icon name="chevronSm" />
        </button>
        <FileIcon path={props.name} />
        <span class="file-path" title={props.name}>
          <span class="file-dir">
            <bdi>{props.name.slice(0, at())}</bdi>
          </span>
          <span class="file-name">{props.name.slice(at())}</span>
        </span>
        <span
          class={["file-status", status() ? `status-${status()}` : "status-unchanged"]}
          title={statusLabel()}
        >
          <Icon name={status() ? statusIcons[status()!] : "eye"} />
          <span class="sr-only">{statusLabel()}</span>
        </span>
        <span class="file-spacer" />
        <Show when={counts()}>
          {(lines) => (
            <span class="file-counts">
              <Show when={lines().additions}>
                <span class="add">+{lines().additions}</span>
              </Show>
              <Show when={lines().deletions}>
                <span class="del">−{lines().deletions}</span>
              </Show>
            </span>
          )}
        </Show>
        {/* What only some files have goes first, so the rest line up from file to file. */}
        <Show when={diffFile() && previewToggles(diffFile()!)}>
          <button
            class="icon-button file-action"
            title={preferences.hint(
              state.isPreviewed(props.name) ? "Show the code" : "Show the preview",
              "preview",
            )}
            aria-label={state.isPreviewed(props.name) ? "Show the code" : "Show the preview"}
            onClick={() => togglePreview(props.name)}
          >
            <Icon name={state.isPreviewed(props.name) ? "code" : "eye"} />
          </button>
        </Show>
        <button
          class={{ "icon-button": true, "file-action": true, counted: count() > 0 }}
          title={preferences.hint("Comment on the file", "fileComment")}
          aria-label="Comment on the file"
          onClick={() => compose(wholeFile(props.name))}
        >
          <Icon name="comment" />
          <Show when={count()}>
            <span class="file-count">{count()}</span>
          </Show>
        </button>
        <Show when={diffFile()}>
          <button
            class={{ "icon-button": true, "file-action": true, done: viewed() }}
            title={preferences.hint(viewed() ? "Viewed · click to unmark" : "Mark viewed", "viewed")}
            aria-label="Viewed"
            aria-pressed={viewed() ? "true" : "false"}
            onClick={() => toggleViewed(props.name)}
          >
            <Icon name="checkCircle" />
          </button>
        </Show>
        <Show when={state.isBrowsing()}>
          <button
            class="icon-button file-action"
            title={preferences.hint("Back to the review", "backToReview")}
            aria-label="Back to the review"
            onClick={() => state.stopBrowsing()}
          >
            <Icon name="x" />
          </button>
        </Show>
      </div>
    );
  }

  onSettled(() => {
    if (!scroller) return;
    diff = createDiffView(scroller, {
      annotationsFor,
      renderNote: (note) =>
        note.kind === "comment" ? (
          <CommentCard id={note.id} onEdit={compose} />
        ) : (
          <Composer target={note.target} />
        ),
      renderMedia: (file, side) => (
        <MediaPreview
          file={file}
          side={side}
          review={{ key: store.review?.scopeKey ?? "", read: store.review?.read ?? -1 }}
        />
      ),
      previewed: state.isPreviewed,
      renderHeader: (name) => <FileHeader name={name} />,
      onComment: openComposer,
      onCollapsedChange: (file, value) =>
        setCollapsed((s) => {
          s[file] = value;
        }),
      scopeKey: () => store.review?.scopeKey ?? "",
      onEdge: (edge) => state.extendBrowsing(edge),
    });
    diff.setLayout(shownLayout());
    /** The page can't send its comments any more: it says why, and offers them to copy. */
    const showStopped = (why: string) =>
      toast.warning(`${why} Your comments are still here, but can only be copied.`, {
        id: "disconnected",
        duration: Infinity,
        dismissible: false,
        action: { label: "Copy feedback", onAction: () => void copyFeedback() },
        // Copying leaves the comments here, so the offer stays.
        onDismiss: (details) => details.reason === "action" && details.cancel(),
      });
    const disconnect = stayConnected({
      lost() {
        if (!store.submitted) showStopped("Patch stopped.");
      },
      back: () => toast.dismiss("disconnected"),
      changed: () => setStale(true),
      // Another run of Patch on this port knows nothing of what this page drew. With nothing written
      // it is read again there; comments are about the review they were written on, so then the
      // page keeps them to copy and the new run never gets them.
      session: (session) => {
        if (!store.review || store.review.session === session || store.submitted) return;
        if (state.hasUnsent()) showStopped("Patch restarted for another review.");
        else void refresh();
      },
      unsent: state.hasUnsent,
    });
    // Nothing outlives the review, so closing it with comments unsent asks first.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (state.hasUnsent()) event.preventDefault();
    };
    addEventListener("beforeunload", onBeforeUnload);
    const onResize = () => setMaxWidth(Math.round(innerWidth / 2));
    addEventListener("resize", onResize);
    void state.load();
    return () => {
      removeEventListener("resize", onResize);
      removeEventListener("beforeunload", onBeforeUnload);
      disconnect();
      diff?.destroy();
    };
  });

  /** What the page shows: the review, or while browsing a window of the tree's files. */
  const shown = createMemo(() =>
    state.isBrowsing()
      ? { browsing: true, items: state.windowItems() }
      : { browsing: false, items: state.visibleFiles() as ReadonlyArray<FileDiffMetadata | OpenedFile> },
  );
  // Exploring ends with the files it was showing: the review comes back.
  createEffect(state.showUnchanged, (exploring, before) => {
    if (before && !exploring && state.isBrowsing()) state.stopBrowsing();
  });
  // Where the reader was in the review, to come back to after browsing.
  let reviewPlace: ReturnType<DiffView["anchor"]> | undefined;
  createEffect(shown, ({ browsing, items }, before) => {
    if (browsing && !before?.browsing) reviewPlace = diff?.anchor();
    // Back in the review, the reader is where they left it; browsing, files come and go
    // above and below them while they stay put.
    const place =
      !browsing && before?.browsing ? reviewPlace : browsing && before?.browsing ? diff?.anchor() : keepPlace;
    keepPlace = undefined;
    // What was being written on a file no longer shown has nowhere to show now.
    const target = state.composer();
    if (target && !isGlobal(target) && !items.some((item) => item.name === target.file)) state.keepWriting();
    // Keep what the reviewer folded when a filter changes; new files start from the defaults.
    // Browsing, a file opens as it comes into the window, and stays as the reader leaves it.
    const had = new Set(before?.browsing ? before.items.map((item) => item.name) : []);
    const next: Record<string, boolean> = {};
    for (const item of items)
      next[item.name] = browsing
        ? had.has(item.name) && (collapsed[item.name] ?? false)
        : (collapsed[item.name] ??
          (state.isViewed(item.name) || ("hunks" in item && opensCollapsed(item, settings.foldGenerated))));
    setCollapsed((s) => void Object.assign(s, next));
    diff?.setExpanded(browsing || settings.wholeFiles);
    diff?.setFiles(items, (name) => next[name] ?? false);
    requestAnimationFrame(() => {
      if (place) diff?.restore(place);
      if (browsing) diff?.checkEdges();
    });
  });

  // Comments are drawn by id, side and line, and previews by whether they are on; re-annotate
  // only when one of those changes.
  // Lines picked to comment on are let go as their comment closes.
  createEffect(
    () => state.composer() === undefined,
    (closed, before) => {
      if (closed && before === false) diff?.clearSelection();
    },
  );
  createEffect(
    () =>
      [
        state.composer(),
        store.comments.map((c) => `${c.id}:${c.side}:${c.end}`).join(),
        state.previewChoices(),
      ] as const,
    () => diff?.refreshAnnotations(),
    { defer: true },
  );

  createEffect(shownLayout, (value) => diff?.setLayout(value));
  // Whole files, or folded to their changes; browsing always reads them whole.
  createEffect(
    () => settings.wholeFiles || state.isBrowsing(),
    (whole) => diff?.setExpanded(whole),
    { defer: true },
  );
  // Remember a layout chosen with the toggle; "auto" stays auto until then.
  const chooseLayout = (value: Layout) => {
    if (touchOnly()) return setOwnLayout(value);
    setLayout(value);
    preferences.update({ layout: value });
  };
  createEffect(
    () => ({ ...settings }),
    (current) => {
      void diff?.configure(current);
    },
    { defer: true },
  );

  const currentFile = () => diff?.topFile() ?? state.visibleFiles()[0]?.name;
  const step = (direction: 1 | -1) => {
    const names = shown().items.map((file) => file.name);
    const index = names.indexOf(currentFile() ?? "");
    const next = names[Math.max(0, Math.min(names.length - 1, index + direction))];
    if (!next) return;
    diff?.scrollToFile(next);
  };

  /** Goes to a file: a changed one in the review, any other by browsing it. */
  function openFile(path: string) {
    if (!state.fileByName(path)) return void browse(path);
    const hidden = !state.visibleFiles().some((file) => file.name === path);
    const browsing = state.isBrowsing();
    // The review comes back from browsing, and a file still being read is no longer wanted.
    state.stopBrowsing();
    // A file the filter hides is shown by clearing it.
    if (hidden || browsing) {
      if (hidden) state.clearFilter();
      flush();
      // After the review's place is restored.
      return void requestAnimationFrame(() => openFile(path));
    }
    if (collapsed[path] && !state.isViewed(path)) setFileCollapsed(path, false);
    diff?.scrollToFile(path);
  }

  /** Shows one file of the repository in place of the review; false when it can't. */
  async function browse(path: string, quiet = false): Promise<boolean> {
    // An unchanged file is browsed among every file.
    if (!state.fileByName(path)) state.setShowUnchanged(true);
    try {
      if (!(await state.browse(path))) return false;
    } catch (error) {
      if (!quiet)
        toast.error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { id: "hint" });
      return false;
    }
    flush();
    // CodeView takes the file on the next frame.
    await new Promise(requestAnimationFrame);
    diff?.scrollToFile(path);
    return true;
  }

  /** Goes to a line a search found: in the review, or exploring among every file. */
  async function goToLine(file: string, line: number, side: Side) {
    if (state.showUnchanged() || !state.fileByName(file)) {
      if (!(await browse(file))) return;
    } else openFile(file);
    // After whatever the file needed: the review back, a filter cleared, the file drawn.
    for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
    if (collapsed[file]) setFileCollapsed(file, false);
    // A line beyond the diff's hunks shows once the file's whole text has come, which takes
    // a moment: go again until it has, unless the reader moves on first.
    const moved = new AbortController();
    for (const name of ["wheel", "touchmove", "keydown"])
      addEventListener(name, () => moved.abort(), { once: true, capture: true, signal: moved.signal });
    for (let tries = 0; tries < 6 && !moved.signal.aborted; tries++) {
      diff?.scrollToLine(file, line, side);
      await new Promise((done) => setTimeout(done, 250));
    }
    moved.abort();
  }

  /** Shows a comment in the diff, or opens it where it can be read. */
  function openComment(comment: Comment) {
    if (narrow()) setOwnComments(false); // The drawer would cover it.
    const unchanged = comment.file !== "" && !state.fileByName(comment.file);
    // One on a file the change leaves alone is read by browsing it.
    if (unchanged && !state.openedByName(comment.file))
      return void browse(comment.file, true).then((shown) =>
        shown ? openComment(comment) : compose(comment),
      );
    // One on the review's files is read in the review.
    if (!unchanged && comment.file && state.isBrowsing() && state.browsing() !== comment.file) {
      state.stopBrowsing();
      flush();
      return void requestAnimationFrame(() => openComment(comment));
    }
    const line = state.lineOf(comment);
    if (line === undefined) return compose(comment);
    setLastComment(comment.id);
    if (collapsed[comment.file]) setFileCollapsed(comment.file, false);
    if (line) diff?.scrollToLine(comment.file, line, comment.side);
    else diff?.scrollToFile(comment.file);
  }

  function editComment(comment: Comment) {
    openComment(comment);
    compose(comment);
  }

  // Stepping through comments goes in the order the diff shows them.
  const [lastComment, setLastComment] = createSignal<string>();
  function stepComment(direction: 1 | -1) {
    const list = state.ordered().filter((comment) => state.lineOf(comment) !== undefined);
    if (!list.length) {
      toast.info("No comments in the diff yet.", { id: "hint" });
      return;
    }
    const at = list.findIndex((comment) => comment.id === lastComment());
    const next = at < 0 ? (direction > 0 ? 0 : list.length - 1) : at + direction;
    openComment(list[(next + list.length) % list.length]!);
  }

  function nextUnviewed() {
    const names = state.visibleFiles().map((file) => file.name);
    const here = names.indexOf(currentFile() ?? "");
    const next = [...names.slice(here + 1), ...names.slice(0, here + 1)].find(
      (name) => !state.isViewed(name),
    );
    if (next) openFile(next);
    else toast.info("Every file is viewed.", { id: "hint" });
  }

  async function copyFeedback() {
    state.keepWriting();
    if (!store.comments.length) {
      toast.info("No comments to copy.", { id: "hint" });
      return;
    }
    const copied = await copyText(feedbackText(store.comments, store.review?.repository ?? ""));
    if (copied) toast.success("Feedback copied.", { id: "hint" });
    else toast.error("The browser did not allow copying.", { id: "hint" });
  }

  /** Hands the review back to the agent and closes the tab. */
  async function finish() {
    if (!canFinish()) return;
    try {
      await state.finish();
      if (!store.submitted) return;
      toast.dismiss("disconnected");
      toast.dismiss("unsent");
      toast.dismiss("deleted");
      // The agent has the feedback; the tab has nothing left to do.
      window.close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), {
        id: "unsent",
        duration: Infinity,
        action: { label: "Copy feedback", onAction: () => void copyFeedback() },
      });
    }
  }

  // The repository changed since the diff was read; refreshing reads it again in place.
  const [stale, setStale] = createSignal(false);
  let keepPlace: ReturnType<DiffView["anchor"]> | undefined;
  async function refresh() {
    keepPlace = diff?.anchor();
    setStale(false);
    await state.load(store.review?.scope);
  }

  const [settingsOpened, setSettingsOpened] = createSignal(false);
  createEffect(settingsOpen, (open) => {
    if (open) setSettingsOpened(true);
  });
  const openSettings = (page?: SettingsPage) => {
    if (page) setSettingsPage(page);
    setSettingsOpen(true);
  };

  const running = () => !store.submitted && palette() === undefined;
  /** Opens the scope picker on `tab`, wherever it was asked from. */
  const openScope = (tab: ScopeTab) => {
    setScopeTab(tab);
    setScopeOpen(true);
  };
  const idle = () => running() && !settingsOpen() && !scopeOpen() && !filterOpen();
  const flip = (
    name:
      | "wrap"
      | "wordDiff"
      | "foldGenerated"
      | "previewSvg"
      | "previewMarkdown"
      | "wholeFiles"
      | "groupByKind"
      | "ligatures",
  ) => ({
    run: () => preferences.update({ [name]: !settings[name] }),
  });
  const page = (action: Action) => ({ run: () => openPalette(action) });
  const base = () => (store.review?.scope.kind === "all" ? store.review.scope.base : undefined);
  const withCurrentFile = (run: (file: string) => void) => () => {
    const file = currentFile();
    if (file) run(file);
  };

  const handlers: Record<Action, Handler> = {
    palette: { run: () => openPalette(), enabled: () => running() && !settingsOpen() },
    finish: { run: () => void finish() },
    copyFeedback: { run: () => void copyFeedback() },
    viewed: {
      run: withCurrentFile((file) => {
        if (toggleViewed(file)) step(1);
      }),
    },
    refresh: { run: () => void refresh() },

    comment: { run: comment },
    fileComment: { run: withCurrentFile((file) => compose(wholeFile(file))) },
    globalComment: { run: () => compose(globalTarget) },
    nextComment: { run: () => stepComment(1) },
    previousComment: { run: () => stepComment(-1) },
    goToComment: page("goToComment"),
    editComment: page("editComment"),
    deleteComment: page("deleteComment"),
    clearSelection: { run: () => diff?.clearSelection() },

    nextChange: { run: () => void diff?.stepChange(1) },
    previousChange: { run: () => void diff?.stepChange(-1) },
    nextFile: { run: () => step(1) },
    previousFile: { run: () => step(-1) },
    nextUnviewed: { run: nextUnviewed },
    goToFile: page("goToFile"),
    search: { run: () => openPalette(undefined, "#"), enabled: () => running() && !settingsOpen() },
    grep: { run: () => openPalette(undefined, "/"), enabled: () => running() && !settingsOpen() },
    clearSearch: { run: () => state.setNameQuery("") },
    find: { run: () => diff?.find() },

    scope: { run: () => setScopeOpen((shown) => !shown), enabled: () => idle() || scopeOpen() },
    reviewBranch: { run: () => void state.load({ kind: "all", base: base() }) },
    reviewUncommitted: { run: () => void state.load({ kind: "uncommitted" }) },
    // Jujutsu has no staging area.
    reviewStaged: {
      run: () => void state.load({ kind: "staged" }),
      enabled: () => idle() && store.review?.vcs !== "jj",
    },
    chooseBase: page("chooseBase"),
    // Commits and pull requests are many: the picker pages and searches them.
    chooseCommit: { run: () => openScope("commits") },
    choosePull: { run: () => openScope("prs") },

    foldFile: { run: withCurrentFile((file) => setFileCollapsed(file, !collapsed[file])) },
    foldAll: { run: toggleAll },
    layout: { run: () => chooseLayout(shownLayout() === "split" ? "unified" : "split") },
    layoutAuto: {
      run: () => {
        if (touchOnly()) return setOwnLayout("auto");
        setLayout(innerWidth >= 1200 ? "split" : "unified");
        preferences.update({ layout: "auto" });
      },
    },
    wrap: flip("wrap"),
    wordDiff: flip("wordDiff"),
    indicators: {
      run: () => preferences.update({ indicators: settings.indicators === "bars" ? "classic" : "bars" }),
    },
    contrast: page("contrast"),
    foldGenerated: flip("foldGenerated"),
    preview: {
      run: withCurrentFile((file) => {
        if (!togglePreview(file)) toast.info("This file has no preview.", { id: "hint" });
      }),
    },
    previewSvg: flip("previewSvg"),
    previewMarkdown: flip("previewMarkdown"),
    wholeFiles: flip("wholeFiles"),
    groupByKind: flip("groupByKind"),
    sidebar: { run: () => setSidebar((shown) => !shown) },
    sidebarSide: {
      run: () => preferences.update({ sidebarSide: settings.sidebarSide === "left" ? "right" : "left" }),
    },
    sidebarWidth: {
      run: () =>
        preferences.update({ sidebarWidth: defaults.sidebarWidth, commentsWidth: defaults.commentsWidth }),
    },
    showFiles: { run: () => setSidebar(() => true) },
    showComments: { run: () => setComments(!commentsShown()) },
    showUnchanged: {
      run: () => {
        setSidebar(() => true);
        state.setShowUnchanged((shown) => !shown);
      },
    },
    backToReview: { run: () => state.stopBrowsing() },
    filterFiles: page("filterFiles"),
    clearFilter: { run: () => state.clearFilter() },

    appearance: page("appearance"),
    lightTheme: page("lightTheme"),
    darkTheme: page("darkTheme"),
    codeFont: page("codeFont"),
    uiFont: page("uiFont"),
    codeBigger: { run: () => preferences.step("codeSize", 1) },
    codeSmaller: { run: () => preferences.step("codeSize", -1) },
    linesTaller: { run: () => preferences.step("lineHeight", 1) },
    linesShorter: { run: () => preferences.step("lineHeight", -1) },
    codeBolder: { run: () => preferences.step("codeWeight", 1) },
    codeLighter: { run: () => preferences.step("codeWeight", -1) },
    textBigger: { run: () => preferences.step("textSize", 1) },
    textSmaller: { run: () => preferences.step("textSize", -1) },
    textBolder: { run: () => preferences.step("uiWeight", 1) },
    textLighter: { run: () => preferences.step("uiWeight", -1) },
    ligatures: flip("ligatures"),

    settings: { run: () => openSettings(), enabled: running },
    shortcuts: { run: () => openSettings("shortcuts") },
    settingsThemes: { run: () => openSettings("themes") },
    settingsTypography: { run: () => openSettings("typography") },
    restoreDefaults: page("restoreDefaults"),
  };
  bindActions(handlers, idle);

  return (
    <div
      class={{
        app: true,
        "no-sidebar": !sidebar(),
        "no-comments": !commentsShown(),
        "sidebar-right": settings.sidebarSide === "right",
      }}
    >
      <header
        class="bar"
        ref={(element) => (barElement = element)}
        onTouchStart={pullStart}
        onTouchMove={pullMove}
        onTouchEnd={pullEnd}
        onTouchCancel={() => {
          pulled = 0;
          pullFrom = undefined;
          setPull(0);
        }}
      >
        <div class="where">
          <button
            class="icon-button"
            title={preferences.hint(sidebar() ? "Hide the sidebar" : "Show the sidebar", "sidebar")}
            onClick={() => setSidebar((shown) => !shown)}
          >
            <Icon name="sidebarLeft" />
          </button>
          <ScopePicker />
        </div>
        <div class="end">
          <Show when={stale()}>
            <button
              class="button quiet"
              title={preferences.hint("The repository changed", "refresh")}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
              Refresh
            </button>
          </Show>
          <Popover openOnHover delay={250} closeDelay={150}>
            <PopoverTrigger class="summary">
              <span>{state.files().length} files</span>
              <span class="add">+{number.format(totals().additions)}</span>
              <span class="del">−{number.format(totals().deletions)}</span>
            </PopoverTrigger>
            <PopoverContent class="breakdown" side="bottom" align="end" sideOffset={6}>
              <PopoverTitle class="sr-only">Changed lines</PopoverTitle>
              <table>
                <tbody>
                  <For
                    each={kinds.filter(
                      (kind) => breakdown().get(kind)!.additions + breakdown().get(kind)!.deletions > 0,
                    )}
                  >
                    {(kind) => (
                      <tr>
                        <th>{kind[0]!.toUpperCase() + kind.slice(1)}</th>
                        <td class="add">+{number.format(breakdown().get(kind)!.additions)}</td>
                        <td class="del">−{number.format(breakdown().get(kind)!.deletions)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <td class="add">+{number.format(totals().additions)}</td>
                    <td class="del">−{number.format(totals().deletions)}</td>
                  </tr>
                </tfoot>
              </table>
            </PopoverContent>
          </Popover>
          <div class="actions">
            <button
              class="icon-button"
              title={preferences.hint(
                allCollapsed() ? "Expand every file" : "Collapse every file",
                "foldAll",
              )}
              aria-label={allCollapsed() ? "Expand every file" : "Collapse every file"}
              disabled={!shown().items.length}
              onClick={toggleAll}
            >
              <Icon name={allCollapsed() ? "chevrons" : "chevronsClose"} />
            </button>
            <button
              class="icon-button wide-only"
              title={preferences.hint(
                shownLayout() === "split" ? "Split · switch to unified" : "Unified · switch to split",
                "layout",
              )}
              aria-label={shownLayout() === "split" ? "Switch to unified" : "Switch to split"}
              onClick={() => chooseLayout(shownLayout() === "split" ? "unified" : "split")}
            >
              <Icon name={shownLayout() === "split" ? "diffSplit" : "diffUnified"} />
            </button>
            <button
              class={{ "icon-button": true, active: commentsShown() }}
              title={preferences.hint(
                commentsShown() ? "Hide the comments" : "Show the comments",
                "showComments",
              )}
              aria-pressed={commentsShown() ? "true" : "false"}
              onClick={() => setComments(!commentsShown())}
            >
              <Icon name="comment" />
            </button>
            <button
              class="icon-button"
              title={preferences.hint("Command palette", "palette")}
              onClick={() => openPalette()}
            >
              <Icon name="command" />
            </button>
            <button
              class="button primary"
              title={preferences.hint("Send your comments to the agent and close", "finish")}
              disabled={!canFinish()}
              onClick={() => void finish()}
            >
              Finish
              <span class="count" data-empty={commentCount() ? undefined : ""}>
                {commentCount()}
              </span>
            </button>
          </div>
        </div>
      </header>

      <Sidebar
        onClose={() => setSidebar(() => false)}
        onOpen={(path) => {
          if (narrow()) setOwnFiles(false);
          if (state.showUnchanged()) void browse(path);
          else openFile(path);
        }}
      />

      <Splitter
        class="resizer"
        aria-label="Resize the sidebar"
        aria-controls="sidebar"
        title="Drag to resize · double-click to reset"
        side={settings.sidebarSide}
        min={minWidth}
        max={maxWidth()}
        value={sidebarWidth()}
        onValueChange={setSidebarWidth}
        onValueCommit={(width) => preferences.update({ sidebarWidth: width })}
        onDblClick={() => preferences.update({ sidebarWidth: defaults.sidebarWidth })}
      />

      <CommentsSide onOpen={openComment} onClose={() => setComments(false)} />

      <Splitter
        class="resizer comments-resizer"
        aria-label="Resize the comments"
        aria-controls="comments"
        title="Drag to resize · double-click to reset"
        side={settings.sidebarSide === "left" ? "right" : "left"}
        min={minWidth}
        max={maxWidth()}
        value={commentsWidth()}
        onValueChange={setCommentsWidth}
        onValueCommit={(width) => preferences.update({ commentsWidth: width })}
        onDblClick={() => preferences.update({ commentsWidth: defaults.commentsWidth })}
      />

      {/* The dialog and its theme catalog load the first time Settings opens. */}
      <Show when={settingsOpened()}>
        <SettingsDialog open={settingsOpen()} onOpenChange={setSettingsOpen} />
      </Show>

      <Palette
        run={(action) => handlers[action].run()}
        onOpenFile={openFile}
        onGoToLine={(file, line, side) => void goToLine(file, line, side)}
        onBrowse={(path) => void browse(path)}
        currentFile={currentFile}
        onFilterNames={(text) => {
          state.setNameQuery(text);
          if (text) setSidebar(() => true);
        }}
        onOpenComment={openComment}
        onEditComment={editComment}
        onFind={(text) => diff?.find(text)}
        onRestoreDefaults={() => preferences.reset()}
      />

      <main class="diff" ref={(element) => (scroller = element)} />

      <Show when={pull() > 0}>
        <output
          class={{ "pull-hint": true, ready: pull() >= PULL }}
          aria-label="Command palette"
          style={{ translate: `-50% ${Math.min(pull(), PULL * 1.5) * 0.6}px` }}
        >
          <Icon name="command" />
        </output>
      </Show>

      <Show when={store.loading && !state.files().length}>
        <div class="overlay quiet">Reading changes…</div>
      </Show>
      <Show when={store.error}>
        <div class="overlay">
          <p>{store.error}</p>
          <button class="button" onClick={() => void state.load(store.review?.scope)}>
            Try again
          </button>
        </div>
      </Show>
      <Show when={!store.loading && !store.error && !state.files().length && !state.openedFiles().length}>
        <div class="overlay quiet">
          <p>No changes in {store.review?.label ?? "this view"}.</p>
        </div>
      </Show>
      <Show when={store.submitted}>
        <div class="overlay">
          <p>{sent()} You can close this tab.</p>
        </div>
      </Show>
      <ToastRegion align="center" aria-label="Notifications">
        {() => (
          <Toast class="toast">
            <ToastTitle />
            <ToastAction class="link" />
          </Toast>
        )}
      </ToastRegion>
    </div>
  );
}
