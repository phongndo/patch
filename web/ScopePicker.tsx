//! Chooses what to review: a view of the working tree against any base
//! branch, one commit or a run of them, or an open pull request. Every tab is
//! one list under one search field, and the field keeps focus throughout. Each
//! row is one thing to review, so at most one is checked, save in a run of
//! commits.

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
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@ui-sdk/solid/tabs";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { Commit, Mode, PullRequest, Scope, ScopesResponse } from "../src/protocol.ts";
import { loadPullRequests, loadScopes } from "./api.ts";
import { definitionOf, type Action } from "./commands.ts";
import { isPressed, listMotions } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.gen.ts";
import { Marked } from "./Marked.tsx";
import { search, type Searchable } from "./search.ts";
import { preferences } from "./settings.ts";
import { state } from "./state.ts";
import { scopeOpen as open, setScopeOpen as setOpen } from "./ui.ts";

const tabs = [
  { value: "changes", label: "Changes", find: "Search views and branches" },
  { value: "commits", label: "Commits", find: "Search commits" },
  { value: "prs", label: "Pull requests", find: "Search open pull requests" },
] as const;
type Tab = (typeof tabs)[number]["value"];

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

export function ScopePicker() {
  const [tab, setTab] = createSignal<Tab>("changes");
  const [query, setQuery] = createSignal("");
  const [scopes, setScopes] = createSignal<ScopesResponse>();
  const [scopesError, setScopesError] = createSignal("");
  const [pulls, setPulls] = createSignal<PullRequest[]>();
  const [pullsError, setPullsError] = createSignal("");
  const [searching, setSearching] = createSignal(false);
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

  // The command opens it as well as the button.
  createEffect(open, (shown) => {
    if (!shown) return;
    const kind = untrack(scope)?.kind;
    setTab(kind === "commits" ? "commits" : kind === "pr" ? "prs" : "changes");
    setQuery("");
    setMark(undefined);
    setScopesError("");
    loadScopes(untrack(base)).then(setScopes, (failure) => setScopesError(message(failure)));
  });

  const pullQuery = createMemo(() => (open() && tab() === "prs" ? query().trim() : undefined));
  createEffect(pullQuery, (text) => {
    if (text === undefined) return;
    let wanted = true;
    setSearching(true);
    const timer = setTimeout(
      async () => {
        let found: PullRequest[] = [];
        let problem = "";
        try {
          found = await loadPullRequests(text);
        } catch (failure) {
          problem = message(failure);
        }
        if (!wanted) return;
        setPulls(found);
        setPullsError(problem);
        setSearching(false);
      },
      text ? 250 : 0,
    );
    return () => {
      wanted = false;
      clearTimeout(timer);
    };
  });

  // Commits are listed newest first; a run goes from the older end to the newer.
  const commits = () => scopes()?.commits ?? [];
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
    choose({ kind: "commits", from: run.at(-1)!.sha, to: run[0]!.sha });
  }

  const find = (rows: Row[]) =>
    search(rows, query())
      .slice(0, 100)
      .map(({ entry, marks }): Row => ({ ...entry, marks }));
  const viewRows = () =>
    views.map((view): Row => {
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
    const rows = (pulls() ?? []).map((pull): Row => ({
      id: `pull:${pull.number}`,
      label: pull.title,
      icon: "brandGithub",
      detail: `${pull.draft ? "Draft · " : ""}#${pull.number} · ${pull.author}`,
      words: `${pull.number} ${pull.author} ${pull.head}`,
      hint: `${pull.title}\n${pull.head} → ${pull.base}`,
      checked: current?.kind === "pr" && current.number === pull.number,
      pick: () => choose({ kind: "pr", number: pull.number }),
    }));
    // GitHub searches. Until it answers, Enter must not take one the last search found.
    const matches = new Map(find(rows).map((row) => [row.id, row.marks]));
    return rows
      .filter((row) => !searching() || matches.has(row.id))
      .map((row): Row => ({ ...row, marks: matches.get(row.id) }));
  };
  const sections = createMemo(() => {
    if (!open()) return [];
    const { since } = scopes() ?? {};
    const all = {
      changes: () => [
        { label: "", rows: find(viewRows()) },
        { label: "Compare against", rows: find(branchRows()) },
      ],
      commits: () => [
        {
          label: since ? `Since ${since}` : `Recent on ${state.store.review?.branch ?? "this branch"}`,
          rows: find(commitRows()),
        },
      ],
      prs: () => [{ label: "", rows: pullRows() }],
    }[tab()]();
    return all.filter(({ rows }) => rows.length);
  });

  const error = () => (tab() === "prs" ? pullsError() : scopesError());
  const loading = () => !error() && (tab() === "prs" ? searching() : !scopes());
  const empty = () => {
    if (error()) return "";
    if (loading()) return "Loading…";
    if (query().trim()) return "Nothing matches.";
    return tab() === "prs" ? "No open pull requests." : "No commits yet.";
  };

  // Starts on what is under review, and on the best match after each letter.
  const command = createCommandController();
  const listed = createMemo(() => `${open()}\n${tab()}\n${query()}\n${loading()}`);
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
  }
  function onKeyDown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    const view = views.find(({ action }) => isPressed(event, action));
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
          name={scope()?.kind === "pr" ? "brandGithub" : scope()?.kind === "commits" ? "commit" : "branch"}
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
                  {label}
                </TabsTab>
              )}
            </For>
          </TabsList>
          <Command
            class="scope-body"
            filter={false}
            query={query()}
            onQueryChange={setQuery}
            onValueChange={setHighlighted}
            controller={command}
            status={loading() ? "loading" : "idle"}
          >
            <div class="palette-search scope-search">
              <Icon name="search" />
              <CommandInput
                class="palette-input"
                data-autofocus
                onKeyDown={onKeyDown}
                aria-label={tabs.find(({ value }) => value === tab())!.find}
                placeholder={tabs.find(({ value }) => value === tab())!.find}
              />
            </div>
            {/* The field has focus, and moves through the list. */}
            <TabsPanel class="scope-panel" value={tab()} tabindex={-1}>
              <Show when={error()}>
                <p class="menu-error">{error()}</p>
              </Show>
              <CommandEmpty class="menu-empty">{empty()}</CommandEmpty>
              <CommandList aria-label={tabs.find(({ value }) => value === tab())!.label}>
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
