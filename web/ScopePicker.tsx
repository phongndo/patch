//! Chooses what to review: a view of the working tree against any base
//! branch, one commit or a run of them, or an open pull request.

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
} from "@ui-sdk/solid/command";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/solid/popover";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@ui-sdk/solid/tabs";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Commit, Mode, PullRequest, Scope, ScopesResponse } from "../src/protocol.ts";
import { loadPullRequests, loadScopes } from "./api.ts";
import { listMotions } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import { search } from "./search.ts";
import { preferences } from "./settings.ts";
import { state } from "./state.ts";
import { scopeOpen as open, setScopeOpen as setOpen } from "./ui.ts";

type Tab = "changes" | "commits" | "prs";

const views: Array<{ kind: Mode; label: string; hint: string }> = [
  { kind: "all", label: "Branch", hint: "Everything since the base, with uncommitted files" },
  { kind: "uncommitted", label: "Uncommitted", hint: "Changes not committed yet, untracked files too" },
  { kind: "staged", label: "Staged", hint: "What the next commit would hold" },
];

export function ScopePicker() {
  const [tab, setTab] = createSignal<Tab>("changes");
  const [scopes, setScopes] = createSignal<ScopesResponse>();
  const [branchQuery, setBranchQuery] = createSignal("");
  const [prQuery, setPrQuery] = createSignal("");
  const [prs, setPrs] = createSignal<PullRequest[]>();
  const [error, setError] = createSignal("");
  const [anchor, setAnchor] = createSignal<string>();

  const scope = () => state.store.review?.scope;
  const base = () => scopes()?.base ?? state.store.review?.base;
  const isPr = (number: number) => {
    const current = scope();
    return current?.kind === "pr" && current.number === number;
  };

  async function refreshScopes(nextBase?: string) {
    setError("");
    try {
      setScopes(await loadScopes(nextBase));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  // The command opens it as well as the button.
  createEffect(open, (shown) => {
    if (shown) void refreshScopes(base());
  });

  let prTimer: ReturnType<typeof setTimeout> | undefined;
  function searchPrs(query: string) {
    setPrQuery(query);
    clearTimeout(prTimer);
    prTimer = setTimeout(async () => {
      setError("");
      try {
        setPrs(await loadPullRequests(query));
      } catch (failure) {
        setPrs([]);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }, 250);
  }

  function choose(next: Scope) {
    setOpen(false);
    void state.load(next);
  }

  const branches = createMemo(() => {
    const all = (scopes()?.branches ?? []).map((label) => ({ label, path: true }));
    return search(all, branchQuery())
      .slice(0, 100)
      .map(({ entry }) => entry.label);
  });

  // Commits are listed newest first; a range runs from the older pick to the newer.
  const commits = () => scopes()?.commits ?? [];
  const selected = createMemo(() => {
    const current = scope();
    if (current?.kind !== "commits") return new Set<string>();
    const list = commits();
    const newer = list.findIndex((commit) => commit.sha === current.to);
    const older = list.findIndex((commit) => commit.sha === current.from);
    if (newer < 0 || older < 0) return new Set<string>();
    return new Set(
      list.slice(Math.min(newer, older), Math.max(newer, older) + 1).map((commit) => commit.sha),
    );
  });

  function pickCommit(commit: Commit, extend: boolean) {
    const list = commits();
    const start = extend ? anchor() : undefined;
    if (!start) {
      setAnchor(commit.sha);
      return choose({ kind: "commits", from: commit.sha, to: commit.sha });
    }
    const a = list.findIndex((item) => item.sha === start);
    const b = list.findIndex((item) => item.sha === commit.sha);
    const newer = list[Math.min(a, b)]!;
    const older = list[Math.max(a, b)]!;
    choose({ kind: "commits", from: older.sha, to: newer.sha });
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
      <PopoverContent class="menu scope-menu" side="bottom" align="start" sideOffset={6}>
        <PopoverTitle class="sr-only">Choose what to review</PopoverTitle>
        <Tabs
          value={tab()}
          onValueChange={(value) => {
            if (!value) return;
            setTab(value as Tab);
            if (value === "prs" && !prs()) searchPrs(prQuery());
          }}
        >
          <TabsList class="segmented scope-tabs" aria-label="Review">
            <TabsIndicator class="segmented-indicator" />
            <TabsTab class="segmented-item" value="changes">
              Changes
            </TabsTab>
            <TabsTab class="segmented-item" value="commits">
              Commits
            </TabsTab>
            <TabsTab class="segmented-item" value="prs">
              Pull requests
            </TabsTab>
          </TabsList>

          <Show when={error()}>
            <p class="menu-error">{error()}</p>
          </Show>

          <TabsPanel value="changes">
            <div class="menu-group">
              <For each={views}>
                {(view) => (
                  <button
                    class="menu-item"
                    aria-pressed={scope()?.kind === view.kind ? "true" : "false"}
                    title={view.hint}
                    onClick={() =>
                      choose({ kind: view.kind, base: view.kind === "all" ? base() : undefined })
                    }
                  >
                    <span class="menu-check">
                      <Show when={scope()?.kind === view.kind}>
                        <Icon name="check" />
                      </Show>
                    </span>
                    {view.label}
                    <Show when={view.kind === "all" && base()}>
                      <span class="muted"> vs {base()}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <div class="menu-group">
              <p class="menu-label">Compare the branch against</p>
              <Command
                query={branchQuery()}
                onQueryChange={setBranchQuery}
                filter={false}
                autoHighlight={branchQuery() !== ""}
              >
                <CommandInput
                  class="menu-search"
                  onKeyDown={listMotions}
                  type="search"
                  aria-label="Find a branch to compare against"
                  placeholder="Find a branch"
                />
                <CommandEmpty class="menu-empty">No branches match.</CommandEmpty>
                <CommandList class="menu-list" aria-label="Branches">
                  <For each={branches()}>
                    {(branch) => (
                      <CommandItem
                        class="menu-item"
                        value={branch}
                        aria-current={base() === branch ? "true" : undefined}
                        onSelect={() => choose({ kind: "all", base: branch })}
                      >
                        <CommandItemIcon class="menu-check">
                          <Show when={base() === branch}>
                            <Icon name="check" />
                          </Show>
                        </CommandItemIcon>
                        <span class="mono">{branch}</span>
                      </CommandItem>
                    )}
                  </For>
                </CommandList>
              </Command>
            </div>
          </TabsPanel>

          <TabsPanel value="commits">
            <div class="menu-group">
              <p class="menu-label">
                {scopes()?.since
                  ? `Commits since ${scopes()?.since}`
                  : `Recent commits on ${state.store.review?.branch ?? "this branch"}`}{" "}
                · Shift-click for a range
              </p>
              <div class="menu-list">
                <button
                  class="menu-item"
                  aria-pressed={scope()?.kind === "all" ? "true" : "false"}
                  onClick={() => choose({ kind: "all", base: base() })}
                >
                  <span class="menu-check">
                    <Show when={scope()?.kind === "all"}>
                      <Icon name="check" />
                    </Show>
                  </span>
                  {scopes()?.since ? "All commits and uncommitted changes" : "Uncommitted changes"}
                </button>
                <For each={commits()} fallback={<p class="menu-empty">No commits on this branch yet.</p>}>
                  {(commit) => (
                    <button
                      class="menu-item commit-item"
                      aria-pressed={selected().has(commit.sha) ? "true" : "false"}
                      title={`${commit.subject}\n${commit.author}, ${commit.when}`}
                      onClick={(event) => pickCommit(commit, event.shiftKey)}
                    >
                      <span class="menu-check">
                        <Show when={selected().has(commit.sha)}>
                          <Icon name="check" />
                        </Show>
                      </span>
                      <span class="mono muted">{commit.short}</span>
                      <span class="commit-subject">{commit.subject}</span>
                      <span class="muted commit-when">{commit.when}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </TabsPanel>

          <TabsPanel value="prs">
            <div class="menu-group">
              <Command
                query={prQuery()}
                onQueryChange={searchPrs}
                autoHighlight={prQuery() !== ""}
                filter={false}
                status={prs() ? "idle" : "loading"}
              >
                <CommandInput
                  class="menu-search"
                  onKeyDown={listMotions}
                  type="search"
                  aria-label="Search open pull requests"
                  placeholder="Search open pull requests"
                />
                <CommandEmpty class="menu-empty">
                  {prs() ? "No open pull requests match." : "Loading…"}
                </CommandEmpty>
                <CommandList class="menu-list" aria-label="Pull requests">
                  <For each={prs()}>
                    {(pr) => (
                      <CommandItem
                        class="menu-item pr-item"
                        value={String(pr.number)}
                        aria-current={isPr(pr.number) ? "true" : undefined}
                        onSelect={() => choose({ kind: "pr", number: pr.number })}
                      >
                        <span class="mono muted">#{pr.number}</span>
                        <span class="pr-text">
                          <span class="pr-title">{pr.title}</span>
                          <span class="muted">
                            {pr.author} · {pr.head} → {pr.base}
                            {pr.draft ? " · draft" : ""}
                          </span>
                        </span>
                      </CommandItem>
                    )}
                  </For>
                </CommandList>
              </Command>
            </div>
          </TabsPanel>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
