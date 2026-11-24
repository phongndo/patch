import { createMemo, createSignal, For, Show } from "solid-js";
import type { Comment } from "../src/protocol.ts";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@ui-sdk/solid/popover";
import { Icon } from "./Icon.tsx";
import { lineLabel } from "./Notes.tsx";
import { isShown, kindOf, kinds, state, statuses, statusOf, type Kind, type Status } from "./state.ts";
import { Tree } from "./Tree.tsx";

type View = "files" | "comments";

export function Sidebar(props: {
  searchRef: (element: HTMLInputElement) => void;
  onFind: (text: string) => void;
  onOpenFile: (path: string) => void;
  onOpenComment: (comment: Comment) => void;
}) {
  const [view, setView] = createSignal<View>("files");

  const [query, setQuery] = createSignal("");
  const comments = createMemo(() => {
    const text = query().trim().toLowerCase();
    return state.store.comments.filter(
      (comment) =>
        !text || comment.file.toLowerCase().includes(text) || comment.body.toLowerCase().includes(text),
    );
  });
  // Only the kinds and statuses this diff has are offered.
  const present = createMemo(() => ({
    kinds: kinds.filter((kind) => state.files().some((file) => kindOf(file) === kind)),
    statuses: statuses.filter((status) => state.files().some((file) => statusOf(file) === status)),
  }));
  const filtered = () => state.hiddenStatuses().size > 0 || state.hiddenKinds().size > 0;
  /** Click hides or shows one value; Option-click shows only that value. */
  function toggle<T>(current: ReadonlySet<T>, all: readonly T[], value: T, only: boolean): Set<T> {
    const hidden = new Set(current);
    if (only) {
      hidden.clear();
      for (const other of all) if (other !== value) hidden.add(other);
    } else if (hidden.has(value)) hidden.delete(value);
    else hidden.add(value);
    return hidden;
  }
  const kindIcons = { code: "code", tests: "checkCircle", generated: "gear", docs: "fileText" } as const;
  const label = (word: string) => word[0]!.toUpperCase() + word.slice(1);

  return (
    <aside class="sidebar">
      <div class="side-head">
        <button
          class={{ "icon-button": true, active: view() === "files" }}
          title="Files"
          aria-pressed={view() === "files" ? "true" : "false"}
          onClick={() => setView("files")}
        >
          <Icon name="fileTree" />
        </button>
        <button
          class={{ "icon-button": true, active: view() === "comments" }}
          title="Comments"
          aria-pressed={view() === "comments" ? "true" : "false"}
          onClick={() => setView("comments")}
        >
          <Icon name="comment" />
        </button>
        <input
          class="side-search"
          ref={props.searchRef}
          type="search"
          placeholder={view() === "files" ? "Search" : "Search comments"}
          title="Filter the list · Enter finds in the diff (/)"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && query().trim()) {
              event.preventDefault();
              props.onFind(query().trim());
            } else if (event.key === "Escape") {
              setQuery("");
              event.currentTarget.blur();
            }
          }}
        />
        <Popover>
          <PopoverTrigger
            class={{ "icon-button": true, active: filtered() }}
            title={filtered() ? "Filtered" : "Filter by kind or Git status"}
          >
            <Icon name="filter" />
          </PopoverTrigger>
          <PopoverContent class="menu" side="bottom" align="end" sideOffset={6}>
            <PopoverTitle class="menu-title">Filter</PopoverTitle>
            <PopoverDescription class="menu-hint">Option-click to show only one</PopoverDescription>
            <Show when={present().kinds.length > 1}>
              <div class="menu-group">
                <For each={present().kinds}>
                  {(kind) => (
                    <button
                      class="menu-item"
                      aria-pressed={state.hiddenKinds().has(kind) ? "false" : "true"}
                      onClick={(event) =>
                        state.setHiddenKinds(toggle(state.hiddenKinds(), present().kinds, kind, event.altKey))
                      }
                    >
                      <span class={`status kind-${kind}`}>
                        <Icon name={kindIcons[kind]} />
                      </span>
                      {label(kind)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="menu-group">
              <For each={present().statuses}>
                {(status) => (
                  <button
                    class="menu-item"
                    aria-pressed={state.hiddenStatuses().has(status) ? "false" : "true"}
                    onClick={(event) =>
                      state.setHiddenStatuses(
                        toggle(state.hiddenStatuses(), present().statuses, status, event.altKey),
                      )
                    }
                  >
                    <span class={`status status-${status}`}>{status[0]!.toUpperCase()}</span>
                    {label(status)}
                  </button>
                )}
              </For>
            </div>
            <div class="menu-group">
              <button
                class="menu-item"
                disabled={!filtered()}
                onClick={() => {
                  state.setHiddenStatuses(new Set<Status>());
                  state.setHiddenKinds(new Set<Kind>());
                }}
              >
                <span class="status status-clear">
                  <Icon name="x" />
                </span>
                Clear filter
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div class="side-body" hidden={view() !== "files"}>
        <Tree
          files={state.visibleFiles()}
          search={view() === "files" ? query() : ""}
          onOpen={props.onOpenFile}
        />
      </div>

      <Show when={view() === "comments"}>
        <div class="side-body comments">
          <Show
            when={comments().length}
            fallback={
              <p class="empty">
                {state.store.comments.length ? "No matching comments." : "No comments yet."}
              </p>
            }
          >
            <ul class="comment-list">
              <For each={comments()}>
                {(comment) => (
                  <li>
                    <button class="comment-item" onClick={() => props.onOpenComment(comment)}>
                      <span class="comment-where">
                        {comment.file}
                        <span class="muted">
                          {" "}
                          · {lineLabel(comment.start, comment.end, comment.side)}
                          {isShown(state.fileByName(comment.file), comment) ? "" : " · not in this view"}
                        </span>
                      </span>
                      <span class="comment-body">{comment.body}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </aside>
  );
}
