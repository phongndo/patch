import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@ui-sdk/solid/hover-card";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/solid/popover";
import { createEffect, createMemo, createSignal, createStore, For, onSettled, Show } from "solid-js";
import { stayConnected } from "./api.ts";
import { createDiffView, type DiffView, type Note } from "./diff.ts";
import { hotkeys } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import { CommentCard, Composer } from "./Notes.tsx";
import { isShown, kindOf, kinds, opensCollapsed, state, stats, type Kind, type Target } from "./state.ts";
import { ScopePicker } from "./ScopePicker.tsx";
import { Sidebar } from "./Sidebar.tsx";

type Layout = "split" | "unified";
const storedLayout = localStorage.getItem("patch.layout");
const initialLayout: Layout =
  storedLayout === "split" || storedLayout === "unified"
    ? storedLayout
    : innerWidth >= 1200
      ? "split"
      : "unified";

export function App() {
  const { store } = state;
  const [layout, setLayout] = createSignal<Layout>(initialLayout);
  const [sidebar, setSidebar] = createSignal(localStorage.getItem("patch.sidebar") !== "hidden");
  const defaultWidth = 280;
  const [sidebarWidth, setSidebarWidth] = createSignal(
    Number(localStorage.getItem("patch.sidebarWidth")) || defaultWidth,
  );
  const clampWidth = (width: number) => Math.round(Math.min(Math.max(width, 180), innerWidth * 0.5));

  function startResize(event: PointerEvent & { currentTarget: HTMLElement }) {
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.toggleAttribute("data-dragging", true);
    const move = (moved: PointerEvent) => setSidebarWidth(clampWidth(moved.clientX));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.toggleAttribute("data-dragging", false);
      localStorage.setItem("patch.sidebarWidth", String(sidebarWidth()));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", end, { once: true });
  }
  const [finishing, setFinishing] = createSignal(false);
  const [disconnected, setDisconnected] = createSignal(false);
  const [sendError, setSendError] = createSignal("");
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
  const hasFeedback = () => commentCount() > 0 || store.note.trim() !== "";

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
    state.setComposer(target);
    // The gutter click selects its line after this handler runs.
    requestAnimationFrame(() => diff?.clearSelection());
  }

  function setFileCollapsed(file: string, value: boolean) {
    setCollapsed((s) => {
      s[file] = value;
    });
    diff?.setCollapsed(file, value);
  }

  function toggleViewed(file: string) {
    const viewed = state.toggleViewed(file);
    setFileCollapsed(file, viewed);
    return viewed;
  }

  function FileHeader(props: { file: FileDiffMetadata }) {
    const viewed = () => store.viewed.includes(props.file.name);
    const count = () => store.comments.filter((comment) => comment.file === props.file.name).length;
    return (
      <span class="file-meta">
        <Show when={count()}>
          <span class="file-comments" title={count() === 1 ? "1 comment" : `${count()} comments`}>
            <Icon name="comment" />
            {count()}
          </span>
        </Show>
        <label class="viewed" title="Viewed (v)">
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
    const disconnect = stayConnected(() => setDisconnected(true));
    void state.load();
    return () => {
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
          collapsed[file.name] ?? (store.viewed.includes(file.name) || opensCollapsed(file));
      setCollapsed(() => initial);
      diff?.setFiles(files, (file) => initial[file.name] ?? false);
    },
  );

  // Comments are drawn by id, side and line; re-annotate only when one of those changes.
  createEffect(
    () => [state.composer(), store.comments.map((c) => `${c.id}:${c.side}:${c.end}`).join()] as const,
    () => diff?.refreshAnnotations(),
    { defer: true },
  );

  createEffect(layout, (value) => {
    diff?.setLayout(value);
    localStorage.setItem("patch.layout", value);
  });
  createEffect(sidebar, (shown) => localStorage.setItem("patch.sidebar", shown ? "shown" : "hidden"));

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

  async function send(decision: "approve" | "comment") {
    setSendError("");
    try {
      await state.finish(decision);
      setFinishing(false);
      // The agent has the feedback; the tab has nothing left to do.
      window.close();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    }
  }

  const idle = () => !state.composer() && !finishing() && !store.submitted;
  hotkeys([
    ["J", () => idle() && step(1)],
    ["K", () => idle() && step(-1)],
    ["S", () => idle() && setLayout((value) => (value === "split" ? "unified" : "split"))],
    ["B", () => idle() && setSidebar((shown) => !shown)],
    ["/", () => idle() && searchInput?.focus()],
    ["Mod+F", () => searchInput?.focus()],
    [
      "V",
      () => {
        const file = idle() ? currentFile() : undefined;
        if (file && toggleViewed(file)) step(1);
      },
    ],
    [
      "C",
      () => {
        const selection = idle() ? diff?.view.getSelectedLines() : undefined;
        if (selection) openComposer(selection.id, selection.range);
      },
    ],
    [
      "Mod+Enter",
      () => {
        if (state.composer() || store.submitted) return;
        if (finishing()) void send(hasFeedback() ? "comment" : "approve");
        else setFinishing(true);
      },
      { inInputs: true },
    ],
  ]);

  return (
    <div class={{ app: true, "no-sidebar": !sidebar() }} style={{ "--sidebar": `${sidebarWidth()}px` }}>
      <header class="bar">
        <div class="where">
          <button
            class="icon-button"
            title={sidebar() ? "Hide the sidebar (b)" : "Show the sidebar (b)"}
            onClick={() => setSidebar((shown) => !shown)}
          >
            <Icon name="sidebarLeft" />
          </button>
          <ScopePicker />
        </div>
        <div class="end">
          <HoverCard delay={250} closeDelay={150}>
            <HoverCardTrigger class="summary" render={(props) => <button type="button" {...props} />}>
              <span>{state.files().length} files</span>
              <span class="add">+{number.format(totals().additions)}</span>
              <span class="del">−{number.format(totals().deletions)}</span>
            </HoverCardTrigger>
            <HoverCardContent class="breakdown" side="bottom" align="end" sideOffset={6}>
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
            </HoverCardContent>
          </HoverCard>
          <div class="actions">
            <button
              class="icon-button"
              title={layout() === "split" ? "Split · switch to unified (s)" : "Unified · switch to split (s)"}
              onClick={() => setLayout((value) => (value === "split" ? "unified" : "split"))}
            >
              <Icon name={layout() === "split" ? "diffSplit" : "diffUnified"} />
            </button>
            <Popover open={finishing()} onOpenChange={setFinishing}>
              <PopoverTrigger class="button primary" disabled={store.submitted}>
                Finish
                <span class="count" data-empty={commentCount() ? undefined : ""}>
                  {commentCount()}
                </span>
              </PopoverTrigger>
              <PopoverContent class="finish" side="bottom" align="end" sideOffset={6}>
                <PopoverTitle class="finish-title">
                  {commentCount()
                    ? `${commentCount()} comment${commentCount() === 1 ? "" : "s"}`
                    : "No comments yet"}
                </PopoverTitle>
                <textarea
                  placeholder="Overall note (optional)"
                  rows={3}
                  value={store.note}
                  onInput={(event) => state.setNote(event.currentTarget.value)}
                />
                <Show when={sendError()}>
                  <p class="error">{sendError()}</p>
                </Show>
                <div class="finish-actions">
                  <span class="hint">⌘↵</span>
                  <button class="button" onClick={() => void send("approve")}>
                    <Icon name="check" />
                    Approve
                  </button>
                  <button
                    class="button primary"
                    disabled={!hasFeedback()}
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
      />

      <button
        type="button"
        class="resizer"
        aria-label="Resize the sidebar"
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDblClick={() => {
          setSidebarWidth(defaultWidth);
          localStorage.removeItem("patch.sidebarWidth");
        }}
        onKeyDown={(event) => {
          const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
          if (!step) return;
          event.preventDefault();
          setSidebarWidth((width) => clampWidth(width + step));
          localStorage.setItem("patch.sidebarWidth", String(sidebarWidth()));
        }}
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
      <Show when={disconnected() && !store.submitted}>
        <div class="toast">Patch stopped. Your comments are saved; run /patch again to continue.</div>
      </Show>
    </div>
  );
}
