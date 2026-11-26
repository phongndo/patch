//! The file tree: what changed, or exploring, the whole repository with changes
//! marked. Exploring, a file opens on its own in place of the review; otherwise a
//! changed file opens in the review.

import { createEffect, createMemo, createStore, For, Show } from "solid-js";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@ui-sdk/solid/popover";
import { Icon } from "./Icon.tsx";
import { SearchField } from "./SearchField.tsx";
import { search } from "./search.ts";
import { preferences } from "./settings.ts";
import { kindOf, kindOfPath, kinds, state, statuses, statusOf, type Kind } from "./state.ts";
import { Tree, treeStatus } from "./Tree.tsx";
import { filterOpen, setFilterOpen } from "./ui.ts";

export function Sidebar(props: {
  /** Opens a file: exploring, on its own; otherwise a changed one in the review, an unchanged one on its own. */
  onOpen: (path: string) => void;
}) {
  const query = state.nameQuery;
  const setQuery = state.setNameQuery;
  // The whole repository is read the first time it is shown.
  createEffect(
    () => state.showUnchanged() && state.store.review !== undefined && state.catalog() === undefined,
    (wanted) => {
      if (wanted) state.readCatalog();
    },
  );
  const unchanged = createMemo(() => {
    const paths = state.catalog();
    return Array.isArray(paths) ? paths : [];
  });
  // Grouped, the change's files sit in a section per kind, in the order the diff shows them.
  const grouped = () => preferences.settings.groupByKind && !state.showUnchanged();
  const sections = createMemo(() =>
    kinds.flatMap((kind) => {
      const files = state.visibleFiles().filter((file) => kindOf(file) === kind);
      return files.length
        ? [{ kind, paths: files.map((file) => file.name), status: treeStatus(files, false) }]
        : [];
    }),
  );
  // Sections folded away.
  const [folded, setFolded] = createStore<Partial<Record<Kind, boolean>>>({});
  /** The tree's files, filtered by name too: what changed, or exploring every file. */
  const paths = state.treePaths;
  // A name searched for opens the folders it is in.
  const expansion = () => (query().trim() || !state.showUnchanged() ? "open" : "closed");
  // Among changes alone most files are modified, so only the others are marked; among every file, all are.
  const status = createMemo(() => treeStatus(state.visibleFiles(), state.showUnchanged()));
  // Only the kinds and statuses there are to show are offered.
  const present = createMemo(() => ({
    kinds: kinds.filter(
      (kind) =>
        state.files().some((file) => kindOf(file) === kind) ||
        (state.showUnchanged() && unchanged().some((path) => kindOfPath(path) === kind)),
    ),
    statuses: statuses.filter((status) => state.files().some((file) => statusOf(file) === status)),
  }));
  const filtered = state.isFiltered;
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
  function label(word: string) {
    return word[0]!.toUpperCase() + word.slice(1);
  }

  return (
    <aside class="sidebar" id="sidebar" aria-label="Files">
      <div class="side-head">
        <SearchField
          value={query()}
          onInput={setQuery}
          onEnter={() => {
            const best = search(
              paths().map((path) => ({ label: path, path: true })),
              query(),
            )[0];
            if (best) props.onOpen(best.entry.label);
          }}
          placeholder={state.showUnchanged() ? "Search all files" : "Search files"}
          label="Search files"
          title="Filter the files · Enter opens the best match"
          clearAction="clearSearch"
        />
        <button
          class={{ "icon-button": true, active: state.showUnchanged() }}
          aria-pressed={state.showUnchanged() ? "true" : "false"}
          title={preferences.hint(
            state.showUnchanged() ? "Show only what changed" : "Explore: every file in the repository",
            "showUnchanged",
          )}
          onClick={() => state.setShowUnchanged((shown) => !shown)}
        >
          <Icon name="folder" />
        </button>
        <Popover open={filterOpen()} onOpenChange={setFilterOpen}>
          <PopoverTrigger
            class={{ "icon-button": true, active: filtered() }}
            title={filtered() ? "Filtered" : "Filter by kind or Git status"}
          >
            <Icon name="filter" />
          </PopoverTrigger>
          <PopoverContent class="menu filter-menu" side="bottom" align="end" sideOffset={6}>
            <div class="filter-head">
              <PopoverTitle class="menu-title">Filter</PopoverTitle>
              <button class="link" disabled={!filtered()} onClick={() => state.clearFilter()}>
                Clear
              </button>
            </div>
            <PopoverDescription class="sr-only">Option-click shows only that one.</PopoverDescription>
            <div class="menu-group">
              <button
                class="menu-item"
                aria-pressed={state.onlyUnviewed() ? "true" : "false"}
                title="Only files not marked viewed"
                onClick={() => state.setOnlyUnviewed((only) => !only)}
              >
                <span class="status">
                  <Icon name="checkCircle" />
                </span>
                Not viewed
              </button>
              <button
                class="menu-item"
                aria-pressed={state.onlyCommented() ? "true" : "false"}
                title="Only files with comments"
                onClick={() => state.setOnlyCommented((only) => !only)}
              >
                <span class="status">
                  <Icon name="comment" />
                </span>
                With comments
              </button>
            </div>
            <Show when={present().kinds.length > 1}>
              <div class="menu-group">
                <For each={present().kinds}>
                  {(kind) => (
                    <button
                      class="menu-item"
                      title="Option-click to show only these"
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
            <Show when={present().statuses.length > 1}>
              <div class="menu-group">
                <For each={present().statuses}>
                  {(status) => (
                    <button
                      class="menu-item"
                      title="Option-click to show only these"
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
            </Show>
          </PopoverContent>
        </Popover>
      </div>

      {/* The tree takes focus inside its shadow root, where the panel can't see it. */}
      <div class="side-body" tabindex={-1}>
        <Show
          when={!state.showUnchanged() || Array.isArray(state.catalog())}
          fallback={
            <p class="empty">
              {state.catalog() instanceof Error ? (state.catalog() as Error).message : "Reading the files…"}
            </p>
          }
        >
          <Show
            when={grouped()}
            fallback={
              <Tree
                paths={paths()}
                status={status()}
                quietFolders={!state.showUnchanged()}
                expansion={expansion()}
                onOpen={props.onOpen}
              />
            }
          >
            <For each={sections()} keyed={(section) => section.kind}>
              {(section) => (
                <section class="kind-section" aria-label={label(section().kind)}>
                  <button
                    class={{ "kind-head": true, closed: folded[section().kind] ?? false }}
                    aria-expanded={folded[section().kind] ? "false" : "true"}
                    onClick={() =>
                      setFolded((s) => {
                        s[section().kind] = !s[section().kind];
                      })
                    }
                  >
                    <Icon name="chevronSm" />
                    <Icon name={kindIcons[section().kind]} />
                    <span class="kind-name">{label(section().kind)}</span>
                    <span class="kind-count">{section().paths.length}</span>
                  </button>
                  <Show when={!folded[section().kind]}>
                    <Tree
                      paths={section().paths}
                      status={section().status}
                      quietFolders
                      expansion="open"
                      fit
                      onOpen={props.onOpen}
                    />
                  </Show>
                </section>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
