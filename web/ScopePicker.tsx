//! Chooses what to review: a view of the working tree against any base
//! branch, one commit or a run of them, or a pull request. Every tab is one
//! list under one search field, and the field keeps focus throughout. Each row
//! is one thing to review, so at most one is checked, save in a run of commits.
//! Commits and pull requests come a page at a time, the next as the list is
//! scrolled or arrowed to its end, and the server searches them all.

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  createCommandController,
} from "@ui-sdk/solid/command";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/solid/popover";
import { useAsyncOptions } from "@ui-sdk/solid/async-options";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@ui-sdk/solid/tabs";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { Commit, Mode, Scope, ScopesResponse } from "../src/protocol.ts";
import { loadCommits, loadPullRequests, loadScopes } from "./api.ts";
import { definitionOf, type Action } from "./commands.ts";
import { isPressed, listMotions } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.gen.ts";
import { Marked } from "./Marked.tsx";
import { search as fuzzy, type Searchable } from "./search.ts";
import { preferences } from "./settings.ts";
import { state } from "./state.ts";
import {
  requests,
  scopeOpen as open,
  scopeTab,
  setScopeOpen as setOpen,
  setScopeTab,
  type ScopeTab as Tab,
} from "./ui.ts";

const capital = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;
/** The tabs, in the words of the repository's tools: GitLab's are merge requests. */
const tabs = [
  { value: "changes", label: () => "Changes", find: () => "Search views and branches" },
  { value: "commits", label: () => "Commits", find: () => "Search commits" },
  { value: "prs", label: () => capital(requests().many), find: () => `Search open ${requests().many}` },
] as const;
const tabOf = (value: Tab) => tabs.find((shown) => shown.value === value)!;

const views: Array<{ kind: Mode; action: Action; label: string; hint: string }> = [
  {
    kind: "all",
    action: "reviewBranch",
    label: "Branch",
    hint: "Everything since the base, with uncommitted files",
  },
  {
    kind: "uncommitted",
    action: "reviewUncommitted",
    label: "Uncommitted",
    hint: "Changes not committed yet, untracked files too",
  },
  {
    kind: "staged",
    action: "reviewStaged",
    label: "Staged",
    hint: "What the next commit would hold",
  },
];

/** The views a repository has: Jujutsu has no staging area, and calls the rest its working copy. */
const viewsOf = (jj: boolean) =>
  jj
    ? views
        .filter(({ kind }) => kind !== "staged")
        .map((view) =>
          view.kind === "uncommitted"
            ? { ...view, label: "Working copy", hint: "The working-copy commit, as jj diff shows it" }
            : view,
        )
    : views;

interface Row extends Searchable {
  id: string;
  icon: IconName;
  detail?: string;
  hint?: string;
  keys?: string;
  checked: boolean;
  marks?: ReadonlySet<number>;
  /** Between the two ends of the run of commits being chosen. */
  ranged?: boolean;
  pick: (extend: boolean) => void;
}

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/**
 * What a search finds a page at a time, through the cursor each page ends with, and the text the
 * shown pages were last found for.
 */
function usePages<Item>(
  load: (
    query: string,
    after: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ items: Item[]; next?: string }>,
) {
  const cursors = new Map<string, string | undefined>();
  const [found, setFound] = createSignal<string>();
  const pages = useAsyncOptions<Item>(
    async (query, { signal, page }) => {
      const key = (at: number) => `${at}\n${query}`;
      if (page === 0) cursors.clear();
      const { items, next } = await load(query.trim(), cursors.get(key(page)), signal);
      // A search typed since replaced this one: what it found is for nothing now.
      if (signal.aborted) throw signal.reason;
      cursors.set(key(page + 1), next);
      setFound(query);
      return { items, hasMore: next !== undefined };
    },
    { debounce: 200 },
  );
  return Object.assign(pages, { found });
}

export function ScopePicker() {
  const [tab, setTab] = createSignal<Tab>("changes");
  const [query, setQuery] = createSignal("");
  const [scopes, setScopes] = createSignal<ScopesResponse>();
  const [scopesError, setScopesError] = createSignal("");
  const history = usePages((query, after, signal) =>
    loadCommits(query, after, signal).then(({ commits, next }) => ({ items: commits, next })),
  );
  const pulls = usePages((query, after, signal) =>
    loadPullRequests(query, after, signal).then(({ pulls, next }) => ({ items: pulls, next })),
  );
  /** The pages a tab lists; the changes are listed here, whole. */
  const pagesOf = (shown: Tab) => (shown === "commits" ? history : shown === "prs" ? pulls : undefined);
  const [highlighted, setHighlighted] = createSignal<string | null>(null);
  // One end of a run of commits, while the other is being chosen.
  const [mark, setMark] = createSignal<string>();

  const scope = () => state.store.review?.scope;
  // The base last compared against, also while something else is under review.
  const base = createMemo<string | undefined>((last) => {
    const review = state.store.review;
    return (review?.scope.kind === "all" ? review.base : undefined) ?? last ?? scopes()?.base;
  });
  const choose = (next: Scope) => {
    setOpen(false);
    void state.load(next);
  };
  const chooseView = (kind: Mode) => choose({ kind, base: kind === "all" ? base() : undefined });

  /** The tabs shown since the picker opened: each lists afresh the first time. */
  let shownSince = new Set<Tab>();

  // The command opens it as well as the button. What it lists is read afresh each time.
  createEffect(open, (shown) => {
    if (!shown) return;
    const kind = untrack(scope)?.kind;
    const first: Tab =
      untrack(scopeTab) ?? (kind === "commits" ? "commits" : kind === "pr" ? "prs" : "changes");
    setScopeTab(undefined);
    setTab(first);
    setQuery("");
    setMark(undefined);
    setScopesError("");
    loadScopes(untrack(base)).then(setScopes, (failure) => setScopesError(message(failure)));
    shownSince = new Set([first]);
    const pages = pagesOf(first);
    pages?.setQuery("");
    pages?.reload();
  });

  /** Typing searches the tab shown, once it pauses. */
  function search(text: string) {
    setQuery(text);
    pagesOf(tab())?.setQuery(text);
  }

  // Commits are listed newest first; a run goes from the older end to the newer.
  const commits = () => history.items;
  const between = (a: string | undefined, b: string | undefined): Commit[] => {
    const list = commits();
    const ends = [a, b].map((sha) => list.findIndex((commit) => commit.sha === sha));
    return ends.includes(-1) ? [] : list.slice(Math.min(...ends), Math.max(...ends) + 1);
  };
  const reviewed = createMemo(() => {
    const current = scope();
    return new Set(
      current?.kind === "commits" ? between(current.from, current.to).map((commit) => commit.sha) : [],
    );
  });
  const marked = createMemo(() =>
    between(mark(), highlighted()?.replace("commit:", "")).map((commit) => commit.sha),
  );

  /** Shift takes the commit as one end of a run; the one under review is an end already. */
  function pickCommit({ sha }: Commit, extend: boolean) {
    const start = mark() ?? (extend && reviewed().size === 1 ? [...reviewed()][0] : undefined);
    if (extend && !start) return void setMark(sha);
    const run = between(start ?? sha, sha);
    // The other end is no longer listed (a search found this one): Patch puts the two in order.
    if (!run.length) return choose({ kind: "commits", from: start!, to: sha });
    choose({ kind: "commits", from: run.at(-1)!.sha, to: run[0]!.sha });
  }

  const find = (rows: Row[]) =>
    fuzzy(rows, query())
      .slice(0, 100)
      .map(({ entry, marks }): Row => ({ ...entry, marks }));
  /**
   * Rows a server found: all of them, in its order, marked where they match. Until it answers a
   * new search, only those that match it show, so Enter can't take one the last search found.
   */
  const found = (rows: Row[], pages: ReturnType<typeof usePages>) => {
    const matches = new Map(fuzzy(rows, query()).map((match) => [match.entry.id, match.marks]));
    const answered = (pages.found() ?? "").trim() === query().trim();
    return rows
      .filter((row) => answered || !query().trim() || matches.has(row.id))
      .map((row): Row => ({ ...row, marks: matches.get(row.id) }));
  };
  const jj = () => state.store.review?.vcs === "jj";
  const viewRows = () =>
    viewsOf(jj()).map((view): Row => {
      const { icon, words } = definitionOf(view.action);
      // On the base itself there is nothing to compare.
      const against =
        view.kind === "all" && base() !== state.store.review?.branch && base() ? `vs ${base()}` : undefined;
      return {
        id: `view:${view.kind}`,
        label: view.label,
        icon,
        detail: against,
        words: `${words ?? ""} ${against ?? ""}`,
        hint: view.hint,
        keys: preferences.keyText(view.action),
        checked: scope()?.kind === view.kind,
        pick: () => chooseView(view.kind),
      };
    });
  // The base is already what Branch compares against, and a branch has no changes against itself.
  const branchRows = () =>
    (scopes()?.branches ?? [])
      .filter((branch) => branch !== base() && branch !== state.store.review?.branch)
      .map((branch): Row => ({
        id: `branch:${branch}`,
        label: branch,
        path: true,
        icon: "branch",
        checked: false,
        pick: () => choose({ kind: "all", base: branch }),
      }));
  const commitRows = () =>
    commits().map((commit): Row => ({
      id: `commit:${commit.sha}`,
      label: commit.subject,
      icon: "commit",
      detail: `${commit.short} · ${commit.when}`,
      words: `${commit.sha} ${commit.author}`,
      hint: `${commit.subject}\n${commit.author}, ${commit.when}\nShift-click two for a range`,
      checked: reviewed().has(commit.sha) || commit.sha === mark(),
      ranged: marked().includes(commit.sha),
      pick: (extend) => pickCommit(commit, extend),
    }));
  const pullRows = () => {
    const current = scope();
    return pulls.items.map((pull): Row => ({
      id: `pull:${pull.number}`,
      label: pull.title,
      icon: requests().icon,
      detail: `${pull.draft ? "Draft · " : ""}${pull.state === "open" ? "" : `${capital(pull.state)} · `}${requests().mark}${pull.number} · ${pull.author}`,
      words: `${pull.number} ${pull.author} ${pull.head}`,
      hint: `${pull.title}\n${pull.head} → ${pull.base}`,
      checked: current?.kind === "pr" && current.number === pull.number,
      pick: () => choose({ kind: "pr", number: pull.number }),
    }));
  };
  const branch = () => state.store.review?.branch ?? "this branch";
  const sections = createMemo(() => {
    if (!open()) return [];
    const searched = query().trim() !== "";
    const all = {
      changes: () => [
        { label: "", rows: find(viewRows()) },
        { label: "Compare against", rows: find(branchRows()) },
      ],
      commits: () => [
        {
          label: searched ? `Found in the history of ${branch()}` : `History of ${branch()}`,
          rows: found(commitRows(), history),
        },
      ],
      prs: () => [{ label: "", rows: found(pullRows(), pulls) }],
    }[tab()]();
    return all.filter(({ rows }) => rows.length);
  });

  const pages = () => pagesOf(tab());
  const error = () => {
    const shown = pages();
    return shown ? (shown.status === "error" ? message(shown.error) : "") : scopesError();
  };
  const loading = () => !error() && (pages()?.status === "loading" || (!pages() && !scopes()));
  const empty = () => {
    if (error()) return "";
    if (loading()) return query().trim() ? "Searching…" : "Loading…";
    if (query().trim()) return "Nothing matches.";
    return tab() === "prs" ? `No open ${requests().many}.` : "No commits yet.";
  };
  /** Below a list of pages: more on the way, more to load, or the end. */
  const more = () => {
    const shown = pages();
    if (!shown?.items.length || error()) return "";
    if (shown.status === "loading") return "Loading more…";
    if (shown.hasMore) return "more";
    return tab() === "prs"
      ? `No more ${requests().many}.`
      : query().trim()
        ? "No more commits match."
        : "The first commit.";
  };

  // Starts on what is under review, and on the best match once each search is answered: never
  // when a page is added below, which the highlight is on its way to.
  const command = createCommandController();
  // A first page is told by its first row; a page added below leaves that as it was.
  const head = () =>
    tab() === "commits" ? (history.items[0]?.sha ?? "") : String(pulls.items[0]?.number ?? "");
  const listed = createMemo(
    () => `${open()}\n${tab()}\n${query()}\n${pages()?.found() ?? ""}\n${head()}\n${!pages() && !scopes()}`,
  );
  createEffect(
    () =>
      listed() &&
      untrack(() => {
        const rows = sections().flatMap((section) => section.rows);
        return ((query().trim() ? undefined : rows.find((row) => row.checked)) ?? rows[0])?.id;
      }),
    (start) => queueMicrotask(() => void (start && command.setValue(start))),
  );

  function show(next: Tab) {
    setTab(next);
    setMark(undefined);
    // What it lists follows the search typed on another tab.
    const pages = pagesOf(next);
    if (!pages) return;
    if (!shownSince.has(next)) {
      // Shown the first time since the picker opened: afresh, and at once, not after a pause in typing.
      shownSince.add(next);
      pages.setQuery(query());
      pages.reload();
    } else if (pages.query !== query()) pages.setQuery(query());
  }
  function onKeyDown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    const view = viewsOf(jj()).find(({ action }) => isPressed(event, action));
    const arrow = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    const modified = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
    if (view) chooseView(view.kind);
    else if (arrow && !modified && !event.currentTarget.value) {
      const at = tabs.findIndex(({ value }) => value === tab());
      show(tabs[(at + arrow + tabs.length) % tabs.length]!.value);
    } else if (event.key === "Escape" && mark()) setMark(undefined);
    else return listMotions(event);
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <Popover open={open()} onOpenChange={setOpen}>
      <PopoverTrigger
        class="scope-trigger"
        title={preferences.hint(`${state.store.review?.repository ?? ""} · choose what to review`, "scope")}
      >
        <Icon
          name={scope()?.kind === "pr" ? requests().icon : scope()?.kind === "commits" ? "commit" : "branch"}
        />
        <span class="scope-label">{state.store.review?.label ?? "Loading"}</span>
        <Icon name="chevronSm" />
      </PopoverTrigger>
      <PopoverContent
        class="menu scope-menu"
        side="bottom"
        align="start"
        sideOffset={6}
        initialFocus="[data-autofocus]"
      >
        <PopoverTitle class="sr-only">Choose what to review</PopoverTitle>
        <Tabs class="scope-body" value={tab()} onValueChange={(value) => value && show(value as Tab)}>
          <TabsList class="segmented scope-tabs" aria-label="Review">
            <TabsIndicator class="segmented-indicator" />
            <For each={tabs}>
              {({ value, label }) => (
                <TabsTab class="segmented-item" value={value}>
                  {label()}
                </TabsTab>
              )}
            </For>
          </TabsList>
          <Command
            class="scope-body"
            filter={false}
            query={query()}
            onQueryChange={search}
            onValueChange={setHighlighted}
            onLoadMore={() => pagesOf(tab())?.loadMore()}
            controller={command}
            status={loading() ? "loading" : "idle"}
          >
            <div class="palette-search scope-search">
              <Icon name="search" />
              <CommandInput
                class="palette-input"
                data-autofocus
                onKeyDown={onKeyDown}
                aria-label={tabOf(tab()).find()}
                placeholder={tabOf(tab()).find()}
              />
            </div>
            {/* The field has focus, and moves through the list. */}
            {/* It scrolls, not the list in it, which the Command watches for its end. */}
            <TabsPanel
              class="scope-panel"
              value={tab()}
              tabindex={-1}
              onScroll={(event: Event & { currentTarget: HTMLElement }) => {
                const panel = event.currentTarget;
                if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 40)
                  pagesOf(tab())?.loadMore();
              }}
            >
              <Show when={error()}>
                <p class="menu-error">{error()}</p>
              </Show>
              <CommandEmpty class="menu-empty">{empty()}</CommandEmpty>
              <CommandList aria-label={tabOf(tab()).label()}>
                <For each={sections()} keyed={(section) => section.label}>
                  {(section) => (
                    <CommandGroup class="palette-group">
                      <Show when={section().label}>
                        <CommandGroupLabel class="menu-label">{section().label}</CommandGroupLabel>
                      </Show>
                      <For each={section().rows} keyed={(row) => row.id}>
                        {(row) => (
                          <CommandItem
                            class={{ "menu-item": true, "palette-item": true, ranged: row().ranged ?? false }}
                            value={row().id}
                            label={row().label}
                            title={row().hint}
                            aria-current={row().checked ? "true" : undefined}
                            onSelect={(event) =>
                              row().pick((event as KeyboardEvent | MouseEvent).shiftKey ?? false)
                            }
                          >
                            <span class="palette-icon" aria-hidden="true">
                              <Icon name={row().icon} />
                            </span>
                            <Marked label={row().label} marks={row().marks} />
                            <Show when={row().detail}>
                              <span class="palette-detail">{row().detail}</span>
                            </Show>
                            <Show when={row().keys}>
                              <kbd class="palette-keys">{row().keys}</kbd>
                            </Show>
                            <span class="menu-check">
                              <Show when={row().checked}>
                                <Icon name="check" />
                              </Show>
                            </span>
                          </CommandItem>
                        )}
                      </For>
                    </CommandGroup>
                  )}
                </For>
              </CommandList>
              <Show when={more()}>
                <p class="menu-more">
                  <Show when={more() === "more"} fallback={more()}>
                    <button class="link" type="button" onClick={() => pages()?.loadMore()}>
                      Load more
                    </button>
                  </Show>
                </p>
              </Show>
            </TabsPanel>
            <footer class="palette-foot">
              <span>
                ↵ review
                {marked().length > 1 ? ` ${marked().length} commits` : ""}
              </span>
              <Show when={tab() === "commits" && !mark()}>
                <span>⇧↵ {reviewed().size === 1 ? "extend the range" : "start a range"}</span>
              </Show>
              <span>↑↓ move</span>
              <Show when={!query()}>
                <span>←→ switch</span>
              </Show>
              <span>esc {mark() ? "cancel range" : query() ? "clear" : "close"}</span>
            </footer>
          </Command>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
