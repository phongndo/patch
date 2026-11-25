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
import type { Comment } from "../src/protocol.ts";
import { stayConnected } from "./api.ts";
import type { Action } from "./commands.ts";
import { createDiffView, type DiffView, type Note } from "./diff.ts";
import { copyText, feedbackText } from "./feedback.ts";
import { bindActions, type Handler } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import { CommentCard, Composer } from "./Notes.tsx";
import { openPalette, Palette } from "./Palette.tsx";
import {
  kindOf,
  kinds,
  opensCollapsed,
  state,
  stats,
  globalTarget,
  wholeFile,
  type Kind,
  type Target,
} from "./state.ts";
import { ScopePicker } from "./ScopePicker.tsx";
import { defaults, preferences } from "./settings.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Splitter } from "./splitter.ts";
import {
  filterOpen,
  palette,
  scopeOpen,
  setScopeOpen,
  setSettingsOpen,
  setSettingsPage,
  setSidebarView,
  settingsOpen,
  type SettingsPage,
  type SidebarView,
} from "./ui.ts";

const SettingsDialog = lazy(() =>
  import("./SettingsDialog.tsx").then((m) => ({ default: m.SettingsDialog })),
);

type Layout = "split" | "unified";
const { settings } = preferences;
const initialLayout: Layout =
  settings.layout === "auto" ? (innerWidth >= 1200 ? "split" : "unified") : settings.layout;

export function App() {
  const { store } = state;
  const [layout, setLayout] = createSignal<Layout>(initialLayout);
  const sidebar = () => settings.sidebarOpen;
  const setSidebar = (toggle: (shown: boolean) => boolean) =>
    preferences.update({ sidebarOpen: toggle(settings.sidebarOpen) });
  const minWidth = 180;
  const [maxWidth, setMaxWidth] = createSignal(Math.round(innerWidth / 2));
  // Follows a drag on its own; the setting, and every effect on it, waits for the end.
  const [sidebarWidth, setSidebarWidth] = createSignal(() => settings.sidebarWidth);
  createEffect(sidebarWidth, (width) =>
    document.documentElement.style.setProperty("--sidebar", `${width}px`),
  );
  let searchInput: HTMLInputElement | undefined;
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

  function openComposer(file: string, range: SelectedLineRange) {
    const side = range.endSide ?? range.side ?? "additions";
    const sameSide = (range.side ?? side) === side;
    const target: Target = {
      file,
      side,
      start: sameSide ? Math.min(range.start, range.end) : range.end,
      end: sameSide ? Math.max(range.start, range.end) : range.end,
    };
    compose(target);
    // The gutter click selects its line after this handler runs.
    requestAnimationFrame(() => diff?.clearSelection());
  }

  /** Opens an editor, in the diff or, for what it has no place for, in the sidebar. */
  function compose(target: Target) {
    state.compose(target);
    if (state.lineOf(target) === undefined) return showSidebar("comments");
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
  const allCollapsed = () => {
    const files = state.visibleFiles();
    return files.length > 0 && files.every((file) => collapsed[file.name]);
  };
  function toggleAll() {
    const value = !allCollapsed();
    for (const file of state.visibleFiles()) setFileCollapsed(file.name, value);
  }

  function toggleViewed(file: string) {
    const viewed = state.toggleViewed(file);
    setFileCollapsed(file, viewed);
    return viewed;
  }

  function FileHeader(props: { file: FileDiffMetadata }) {
    const viewed = () => state.isViewed(props.file.name);
    const count = () => store.comments.filter((comment) => comment.file === props.file.name).length;
    return (
      <span class="file-meta">
        <button
          class="file-comments"
          title={preferences.hint("Comment on the file", "fileComment")}
          onClick={() => compose(wholeFile(props.file.name))}
        >
          <Icon name="comment" />
          {count() || ""}
        </button>
        <label class="viewed" title={preferences.hint("Viewed", "viewed")}>
          <input type="checkbox" checked={viewed()} onChange={() => toggleViewed(props.file.name)} />
          Viewed
        </label>
        <button
          class={{ "icon-button": true, chevron: true, closed: collapsed[props.file.name] ?? false }}
          title={collapsed[props.file.name] ? "Show" : "Hide"}
          onClick={() => setFileCollapsed(props.file.name, !collapsed[props.file.name])}
        >
          <Icon name="chevronSm" />
        </button>
      </span>
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
      renderHeader: (file) => <FileHeader file={file} />,
      onComment: openComposer,
      onCollapsedChange: (file, value) =>
        setCollapsed((s) => {
          s[file] = value;
        }),
      scopeKey: () => store.review?.scopeKey ?? "",
    });
    diff.setLayout(layout());
    const disconnect = stayConnected({
      lost() {
        if (store.submitted) return;
        toast.warning("Patch stopped. Your comments are still here, but can only be copied.", {
          id: "disconnected",
          duration: Infinity,
          dismissible: false,
          action: { label: "Copy feedback", onAction: () => void copyFeedback() },
          // Copying leaves the comments here, so the offer stays.
          onDismiss: (details) => details.reason === "action" && details.cancel(),
        });
      },
      back: () => toast.dismiss("disconnected"),
      changed: () => setStale(true),
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

  createEffect(
    () => state.visibleFiles(),
    (files) => {
      const initial: Record<string, boolean> = {};
      // Keep what the reviewer folded when a filter changes; new files start from the defaults.
      for (const file of files)
        initial[file.name] =
          collapsed[file.name] ?? (state.isViewed(file.name) || opensCollapsed(file, settings.foldGenerated));
      setCollapsed(() => initial);
      diff?.setFiles(files, (file) => initial[file.name] ?? false);
      const anchor = keepPlace;
      keepPlace = undefined;
      if (anchor) requestAnimationFrame(() => diff?.restore(anchor));
    },
  );

  // Comments are drawn by id, side and line; re-annotate only when one of those changes.
  createEffect(
    () => [state.composer(), store.comments.map((c) => `${c.id}:${c.side}:${c.end}`).join()] as const,
    () => diff?.refreshAnnotations(),
    { defer: true },
  );

  createEffect(layout, (value) => diff?.setLayout(value));
  // Remember a layout chosen with the toggle; "auto" stays auto until then.
  const chooseLayout = (value: Layout) => {
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
    const names = state.visibleFiles().map((file) => file.name);
    const index = names.indexOf(currentFile() ?? "");
    const next = names[Math.max(0, Math.min(names.length - 1, index + direction))];
    if (next) diff?.scrollToFile(next);
  };

  function openFile(path: string) {
    if (collapsed[path] && !state.isViewed(path)) setFileCollapsed(path, false);
    diff?.scrollToFile(path);
  }

  /** Shows a comment in the diff, or opens it where it can be read. */
  function openComment(comment: Comment) {
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

  function showSidebar(view: SidebarView) {
    setSidebar(() => true);
    setSidebarView(view);
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
  const idle = () => running() && !settingsOpen() && !scopeOpen() && !filterOpen();
  const flip = (name: "wrap" | "wordDiff" | "foldGenerated" | "ligatures") => ({
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
    search: {
      run: () => {
        setSidebar(() => true);
        flush();
        searchInput?.focus();
      },
    },
    find: { run: () => diff?.find() },

    scope: { run: () => setScopeOpen((shown) => !shown), enabled: () => idle() || scopeOpen() },
    reviewBranch: { run: () => void state.load({ kind: "all", base: base() }) },
    reviewUncommitted: { run: () => void state.load({ kind: "uncommitted" }) },
    reviewStaged: { run: () => void state.load({ kind: "staged" }) },
    chooseBase: page("chooseBase"),
    chooseCommit: page("chooseCommit"),
    choosePull: page("choosePull"),

    foldFile: { run: withCurrentFile((file) => setFileCollapsed(file, !collapsed[file])) },
    foldAll: { run: toggleAll },
    layout: { run: () => chooseLayout(layout() === "split" ? "unified" : "split") },
    layoutAuto: {
      run: () => {
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
    sidebar: { run: () => setSidebar((shown) => !shown) },
    sidebarSide: {
      run: () => preferences.update({ sidebarSide: settings.sidebarSide === "left" ? "right" : "left" }),
    },
    sidebarWidth: { run: () => preferences.update({ sidebarWidth: defaults.sidebarWidth }) },
    showFiles: { run: () => showSidebar("files") },
    showComments: { run: () => showSidebar("comments") },
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
    <div class={{ app: true, "no-sidebar": !sidebar(), "sidebar-right": settings.sidebarSide === "right" }}>
      <header class="bar">
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
        searchRef={(element) => (searchInput = element)}
        onFind={(text) => diff?.find(text)}
        onOpenFile={(path) => diff?.scrollToFile(path)}
        onOpenComment={openComment}
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

      {/* The dialog and its theme catalog load the first time Settings opens. */}
      <Show when={settingsOpened()}>
        <SettingsDialog open={settingsOpen()} onOpenChange={setSettingsOpen} />
      </Show>

      <Palette
        run={(action) => handlers[action].run()}
        onOpenFile={openFile}
        onOpenComment={openComment}
        onEditComment={editComment}
        onFind={(text) => diff?.find(text)}
        onRestoreDefaults={() => preferences.reset()}
      />

      <main class="diff" ref={(element) => (scroller = element)} />

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
      <Show when={!store.loading && !store.error && state.files().length === 0}>
        <div class="overlay quiet">
          <p>No changes in {store.review?.label ?? "this view"}.</p>
        </div>
      </Show>
      <Show when={store.submitted}>
        <div class="overlay">
          <p>Sent to the agent. You can close this tab.</p>
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
