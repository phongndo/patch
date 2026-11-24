import { createMemo, createSignal, For, Show } from "solid-js";
import type { Comment } from "../src/protocol.ts";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@ui-sdk/solid/popover";
import { Tabs, TabsList, TabsPanel, TabsTab, TabsTabIcon } from "@ui-sdk/solid/tabs";
import { CommentsPanel } from "./CommentsPanel.tsx";
import { Icon } from "./Icon.tsx";
import { preferences } from "./settings.ts";
import { kindOf, kinds, state, statuses, statusOf } from "./state.ts";
import { Tree } from "./Tree.tsx";
import { filterOpen, setFilterOpen, setSidebarView, sidebarView as view, type SidebarView } from "./ui.ts";

export function Sidebar(props: {
  searchRef: (element: HTMLInputElement) => void;
  onFind: (text: string) => void;
  onOpenFile: (path: string) => void;
  onOpenComment: (comment: Comment) => void;
  onEditComment: (comment: Comment) => void;
}) {
  const [query, setQuery] = createSignal("");
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
    <Tabs
      class="sidebar"
      render={(attributes) => <aside {...attributes} />}
      id="sidebar"
      value={view()}
      onValueChange={(value) => value && setSidebarView(value as SidebarView)}
    >
      <div class="side-head">
        <TabsList class="side-views" aria-label="Sidebar">
          <TabsTab
            class="icon-button"
            value="files"
            aria-label="Files"
            title={preferences.hint("Files", "showFiles")}
          >
            <TabsTabIcon>
              <Icon name="fileTree" />
            </TabsTabIcon>
          </TabsTab>
          <TabsTab
            class="icon-button"
            value="comments"
            aria-label="Comments"
            title={preferences.hint("Comments", "showComments")}
          >
            <TabsTabIcon>
              <Icon name="comment" />
            </TabsTabIcon>
          </TabsTab>
        </TabsList>
        <input
          class="side-search"
          ref={props.searchRef}
          type="search"
          placeholder={view() === "files" ? "Search" : "Search comments"}
          title={preferences.hint("Filter the list · Enter finds in the diff", "search")}
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
        <Popover open={filterOpen()} onOpenChange={setFilterOpen}>
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
                      <span class="status">
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
              <button class="menu-item" disabled={!filtered()} onClick={() => state.clearFilter()}>
                <span class="status status-clear">
                  <Icon name="x" />
                </span>
                Clear filter
              </button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* The tree takes focus inside its shadow root, where the panel can't see it. */}
      <TabsPanel class="side-body" value="files" keepMounted tabindex={-1}>
        <Tree
          files={state.visibleFiles()}
          search={view() === "files" ? query() : ""}
          onOpen={props.onOpenFile}
        />
      </TabsPanel>

      <TabsPanel class="side-comments" value="comments">
        <CommentsPanel query={query()} onOpen={props.onOpenComment} onEdit={props.onEditComment} />
      </TabsPanel>
    </Tabs>
  );
}
