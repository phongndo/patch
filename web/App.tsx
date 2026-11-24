import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/solid/popover";
import { toast, Toast, ToastAction, ToastRegion, ToastTitle } from "@ui-sdk/solid/toast";
import { createEffect, createMemo, createSignal, createStore, For, onSettled, Show, lazy } from "solid-js";
import { stayConnected } from "./api.ts";
import { createDiffView, type DiffView, type Note } from "./diff.ts";
import { copyText, feedbackText } from "./feedback.ts";
import { bindActions } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import { moved } from "./CommentsPanel.tsx";
import { CommentCard, Composer } from "./Notes.tsx";
import { isShown, kindOf, kinds, opensCollapsed, state, stats, type Kind, type Target } from "./state.ts";
import { ScopePicker } from "./ScopePicker.tsx";
import { defaults, preferences } from "./settings.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Splitter } from "./splitter.ts";

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
  const [finishing, setFinishing] = createSignal(false);
  const [sendError, setSendError] = createSignal("");
  let searchInput: HTMLInputElement | undefined;
  const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({});
  let scroller: HTMLElement | undefined;
  let approveButton: HTMLButtonElement | undefined;
  let sendButton: HTMLButtonElement | undefined;
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
  /** Comments whose lines left the diff after a refresh or a scope change; they are sent as written. */
  const movedCount = () => store.comments.filter(moved).length;
  const summary = () => (commentCount() ? `${commentCount()} comment${commentCount() === 1 ? "" : "s"}` : "");
  const hasFeedback = () => commentCount() > 0;

  function annotationsFor(name: string): DiffLineAnnotation<Note>[] {
    const composer = state.composer();
    const file = state.fileByName(name);
    const annotations: DiffLineAnnotation<Note>[] = [];
    for (const comment of store.comments) {
      if (comment.file !== name || comment.id === composer?.id || !isShown(file, comment)) continue;
      annotations.push({
        side: comment.side,
        lineNumber: comment.end,
        metadata: { kind: "comment", id: comment.id },
      });
    }
    if (composer?.file === name)
      annotations.push({
        side: composer.side,
        lineNumber: composer.end,
        metadata: { kind: "composer", target: composer },
      });
    return annotations;
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
    state.compose(target);
    // The gutter click selects its line after this handler runs.
    requestAnimationFrame(() => diff?.clearSelection());
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
        <Show when={count()}>
          <span class="file-comments" title={count() === 1 ? "1 comment" : `${count()} comments`}>
            <Icon name="comment" />
            {count()}
          </span>
        </Show>
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
        note.kind === "comment" ? <CommentCard id={note.id} /> : <Composer target={note.target} />,
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

  function jumpTo(comment: { file: string; side: "additions" | "deletions"; end: number }) {
    setFinishing(false);
    if (collapsed[comment.file]) setFileCollapsed(comment.file, false);
    diff?.scrollToLine(comment.file, comment.end, comment.side);
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

  /** Opens Finish with everything written counted. */
  function openFinish() {
    state.keepWriting();
    setSendError("");
    setFinishing(true);
  }

  async function send(decision: "approve" | "comment") {
    setSendError("");
    try {
      await state.finish(decision);
      if (!store.submitted) return;
      toast.dismiss("disconnected");
      setFinishing(false);
      // The agent has the feedback; the tab has nothing left to do.
      window.close();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
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

  const [settingsOpen, openSettings] = createSignal(false);
  const [settingsOpened, setSettingsOpened] = createSignal(false);
  const setSettingsOpen = (open: boolean) => {
    if (open) setSettingsOpened(true);
    openSettings(open);
  };
  const idle = () => !state.composer() && !finishing() && !store.submitted && !settingsOpen();
  bindActions({
    nextFile: { run: () => idle() && step(1) },
    previousFile: { run: () => idle() && step(-1) },
    layout: { run: () => idle() && chooseLayout(layout() === "split" ? "unified" : "split") },
    foldAll: { run: () => idle() && toggleAll() },
    refresh: { run: () => idle() && void refresh() },
    sidebar: { run: () => idle() && setSidebar((shown) => !shown) },
    search: { run: () => idle() && searchInput?.focus() },
    viewed: {
      run: () => {
        const file = idle() ? currentFile() : undefined;
        if (file && toggleViewed(file)) step(1);
      },
    },
    comment: {
      run: () => {
        const selection = idle() ? diff?.view.getSelectedLines() : undefined;
        if (selection) openComposer(selection.id, selection.range);
      },
    },
    finish: {
      inInputs: true,
      run: () => {
        if (state.composer() || store.submitted || settingsOpen()) return;
        if (finishing()) void send(hasFeedback() ? "comment" : "approve");
        else openFinish();
      },
    },
    settings: { inInputs: true, run: () => setSettingsOpen(true) },
  });

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
              class={{ "icon-button": true, refresh: true, stale: stale() }}
              title={preferences.hint(stale() ? "The repository changed · refresh" : "Refresh", "refresh")}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
            </button>
            <button
              class="icon-button"
              title={preferences.hint(
                allCollapsed() ? "Expand every file" : "Collapse every file",
                "foldAll",
              )}
              onClick={toggleAll}
            >
              <Icon name={allCollapsed() ? "chevrons" : "chevronsClose"} />
            </button>
            <button
              class="icon-button"
              title={preferences.hint(
                layout() === "split" ? "Split · switch to unified" : "Unified · switch to split",
                "layout",
              )}
              onClick={() => chooseLayout(layout() === "split" ? "unified" : "split")}
            >
              <Icon name={layout() === "split" ? "diffSplit" : "diffUnified"} />
            </button>
            <Popover open={finishing()} onOpenChange={(open) => (open ? openFinish() : setFinishing(false))}>
              <PopoverTrigger class="button primary" disabled={store.submitted}>
                Finish
                <span class="count" data-empty={commentCount() ? undefined : ""}>
                  {commentCount()}
                </span>
              </PopoverTrigger>
              <PopoverContent
                class="finish"
                side="bottom"
                align="end"
                sideOffset={6}
                // With comments written, Enter sends them; it never approves past them.
                initialFocus={() => (hasFeedback() ? sendButton : approveButton)}
              >
                <PopoverTitle class="finish-title">{summary() || "No comments yet"}</PopoverTitle>
                <Show when={movedCount()}>
                  <p class="finish-warning">
                    {movedCount() === 1 ? "1 comment is" : `${movedCount()} comments are`} on lines no longer
                    in the diff. {movedCount() === 1 ? "It is" : "They are"} sent as written.
                  </p>
                </Show>
                <Show when={sendError()}>
                  <p class="error">{sendError()}</p>
                  <button class="link" onClick={() => void copyFeedback()}>
                    Copy feedback
                  </button>
                </Show>
                <div class="finish-actions">
                  <span class="hint">{hasFeedback() ? "⌘↵ sends" : "⌘↵ approves"}</span>
                  <button
                    class="button"
                    ref={(element) => (approveButton = element)}
                    onClick={() => void send("approve")}
                  >
                    <Icon name="check" />
                    Approve
                  </button>
                  <button
                    class="button primary"
                    disabled={!hasFeedback()}
                    ref={(element) => (sendButton = element)}
                    onClick={() => void send("comment")}
                  >
                    Send feedback
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </header>

      <Sidebar
        searchRef={(element) => (searchInput = element)}
        onFind={(text) => diff?.find(text)}
        onOpenFile={(path) => diff?.scrollToFile(path)}
        onOpenComment={jumpTo}
        onOpenSettings={() => setSettingsOpen(true)}
        onEditComment={(comment) => {
          jumpTo(comment);
          state.compose({ ...comment });
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

      {/* The dialog and its theme catalog load the first time Settings opens. */}
      <Show when={settingsOpened()}>
        <SettingsDialog open={settingsOpen()} onOpenChange={setSettingsOpen} />
      </Show>

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
