//! The command palette: every command in commands.ts, and from the first typed
//! letter every file and comment. Commands that need a choice open a page of
//! their own. Commands run once the dialog is gone and focus is back on the
//! page, so whatever they open can take it.

import { fuzzyScore } from "@ui-sdk/core/text-match";
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
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/solid/dialog";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { Comment, PullRequest, Scope, ScopesResponse } from "../src/protocol.ts";
import { loadPullRequests, loadScopes } from "./api.ts";
import { actionGroups, actionNames, definitionOf, type Action } from "./commands.ts";
import { listMotions } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.gen.ts";
import { lineLabel } from "./Notes.tsx";
import { fontPresets, preferences, type Settings } from "./settings.ts";
import {
  isGeneral,
  isShown,
  kindOf,
  kinds,
  state,
  stats,
  statuses,
  statusOf,
  type Kind,
  type Status,
} from "./state.ts";
import type { Theme } from "./themes.gen.ts";
import { palette, setPalette } from "./ui.ts";

const { settings, update } = preferences;

interface Entry {
  id: string;
  label: string;
  icon: IconName;
  group?: string;
  detail?: string;
  words?: string;
  keys?: string;
  checked?: boolean;
  colors?: readonly string[];
  /** Leaves the palette open, for choices made more than one at a time. */
  stay?: boolean;
  page?: Action;
  run?: () => void;
}

interface Page {
  placeholder: string;
  empty: string;
  entries: () => Entry[];
}

// Whether a command's own key opened its page.
const [direct, setDirect] = createSignal(false);

/** Opens the palette, on a command's page or on every command. */
export function openPalette(page?: Action) {
  setDirect(page !== undefined);
  setPalette(page ? [page] : []);
}

const title = (word: string) => word[0]!.toUpperCase() + word.slice(1);
const onOff = (value: boolean) => (value ? "On" : "Off");
const shortSize = (value: number) => `${value}px`;

/** What a command's setting is now. */
const details: Partial<Record<Action, () => string>> = {
  layout: () => (settings.layout === "auto" ? "Automatic" : title(settings.layout)),
  wrap: () => onOff(settings.wrap),
  wordDiff: () => onOff(settings.wordDiff),
  indicators: () => (settings.indicators === "bars" ? "Bars" : "+ and −"),
  contrast: () => title(settings.contrast),
  foldGenerated: () => onOff(settings.foldGenerated),
  sidebar: () => (settings.sidebarOpen ? "Shown" : "Hidden"),
  sidebarSide: () => title(settings.sidebarSide),
  ligatures: () => onOff(settings.ligatures),
  appearance: () => title(settings.colorScheme),
  codeBigger: () => shortSize(settings.codeSize),
  codeSmaller: () => shortSize(settings.codeSize),
  linesTaller: () => shortSize(settings.lineHeight),
  linesShorter: () => shortSize(settings.lineHeight),
  codeBolder: () => String(settings.codeWeight),
  codeLighter: () => String(settings.codeWeight),
  textBigger: () => shortSize(settings.textSize),
  textSmaller: () => shortSize(settings.textSize),
  textBolder: () => String(settings.uiWeight),
  textLighter: () => String(settings.uiWeight),
};

/** Commands pressed several times in a row. */
const repeatable = new Set<Action>([
  "codeBigger",
  "codeSmaller",
  "linesTaller",
  "linesShorter",
  "codeBolder",
  "codeLighter",
  "textBigger",
  "textSmaller",
  "textBolder",
  "textLighter",
]);

export function Palette(props: {
  run: (action: Action) => void;
  onOpenFile: (path: string) => void;
  onOpenComment: (comment: Comment) => void;
  onEditComment: (comment: Comment) => void;
  onRestoreDefaults: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [scopes, setScopes] = createSignal<ScopesResponse>();
  const [pulls, setPulls] = createSignal<PullRequest[]>();
  const [themes, setThemes] = createSignal<readonly Theme[]>();
  const [problem, setProblem] = createSignal("");
  let afterClose: (() => void) | undefined;

  const page = createMemo(() => palette()?.at(-1));

  createEffect(page, (current) => {
    setProblem("");
    const failed = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error));
    if (current === "chooseBase" || current === "chooseCommit") {
      setScopes(undefined);
      const base = state.store.review?.base;
      loadScopes(base).then(setScopes, failed);
    } else if (current === "choosePull") {
      setPulls(undefined);
      loadPullRequests("").then(setPulls, failed);
    } else if (current === "lightTheme" || current === "darkTheme")
      void import("./themes.gen.ts").then((catalog) => setThemes(catalog.themes), failed);
  });

  const close = (then?: () => void) => {
    afterClose = then;
    setPalette(undefined);
  };
  const review = (scope: Scope) => () => void state.load(scope);

  const commentEntries = (run: (comment: Comment) => void): Entry[] =>
    state.store.comments.map((comment) => ({
      id: `comment:${comment.id}`,
      label: comment.body.trim().split("\n")[0]!,
      icon: "comment",
      detail: isGeneral(comment)
        ? "General"
        : `${comment.file.split("/").at(-1)} · ${lineLabel(comment.start, comment.end, comment.side)}`,
      words: `${comment.file} ${comment.body}`,
      run: () => run(comment),
    }));
  const onScreen = (comment: Comment) =>
    isGeneral(comment) || isShown(state.fileByName(comment.file), comment);
  const fileEntries = (): Entry[] =>
    state.visibleFiles().map((file) => {
      const { additions, deletions } = stats(file);
      return {
        id: `file:${file.name}`,
        label: file.name,
        icon: "fileText",
        detail: `+${additions} −${deletions}`,
        checked: state.isViewed(file.name),
        run: () => props.onOpenFile(file.name),
      };
    });
  const choices = <K extends keyof Settings>(
    name: K,
    icon: IconName,
    options: ReadonlyArray<{ label: string; value: Settings[K] }>,
  ): Entry[] =>
    options.map(({ label, value }) => ({
      id: `${name}:${String(value)}`,
      label,
      icon,
      checked: settings[name] === value,
      run: () => update({ [name]: value } as Partial<Settings>),
    }));
  const themeEntries = (dark: boolean): Entry[] =>
    (themes() ?? [])
      .filter((theme) => theme.dark === dark)
      .map((theme) => ({
        id: `theme:${theme.id}`,
        label: theme.name,
        icon: "brush",
        group: { pierre: "Pierre", builtin: "Built-in", community: "Community", base16: "Base16" }[
          theme.group as string
        ],
        colors: [theme.colors.editor, ...theme.palette.slice(0, 5)].filter(
          (color): color is string => typeof color === "string",
        ),
        checked: theme.id === (dark ? settings.darkTheme : settings.lightTheme),
        run: () => preferences.chooseTheme(theme),
      }));
  const flip = <T,>(hidden: ReadonlySet<T>, value: T) => {
    const next = new Set(hidden);
    if (!next.delete(value)) next.add(value);
    return next;
  };

  const pages: Partial<Record<Action, Page>> = {
    goToFile: { placeholder: "Go to file", empty: "No files match.", entries: fileEntries },
    goToComment: {
      placeholder: "Go to comment",
      empty: "No comments yet.",
      entries: () => commentEntries(props.onOpenComment),
    },
    editComment: {
      placeholder: "Edit comment",
      empty: "No comments to edit.",
      entries: () =>
        commentEntries(props.onEditComment).filter((_, index) => onScreen(state.store.comments[index]!)),
    },
    deleteComment: {
      placeholder: "Delete comment",
      empty: "No comments to delete.",
      entries: () =>
        commentEntries((comment) => state.deleteComment(comment.id)).map((entry) => ({
          ...entry,
          icon: "trash",
        })),
    },
    deleteAllComments: {
      placeholder: "Delete every comment?",
      empty: "No comments to delete.",
      entries: () =>
        state.store.comments.length
          ? [
              { id: "keep", label: "Keep them", icon: "x", run: () => {} },
              {
                id: "delete",
                label: `Delete ${state.store.comments.length === 1 ? "1 comment" : `all ${state.store.comments.length} comments`}`,
                icon: "trash",
                run: () => state.deleteComments(state.store.comments.map((comment) => comment.id)),
              },
            ]
          : [],
    },
    restoreDefaults: {
      placeholder: "Restore every default setting?",
      empty: "",
      entries: () => [
        { id: "keep", label: "Keep my settings", icon: "x", run: () => {} },
        {
          id: "restore",
          label: "Restore defaults, and every shortcut",
          icon: "refresh",
          run: () => props.onRestoreDefaults(),
        },
      ],
    },
    chooseBase: {
      placeholder: "Compare against",
      empty: "No branches match.",
      entries: () =>
        (scopes()?.branches ?? []).map((branch) => ({
          id: `branch:${branch}`,
          label: branch,
          icon: "branch",
          checked: branch === scopes()?.base,
          run: review({ kind: "all", base: branch }),
        })),
    },
    chooseCommit: {
      placeholder: "Review a commit",
      empty: "No commits match.",
      entries: () =>
        (scopes()?.commits ?? []).map((commit) => ({
          id: `commit:${commit.sha}`,
          label: commit.subject,
          icon: "commit",
          detail: `${commit.short} · ${commit.when}`,
          words: `${commit.sha} ${commit.author}`,
          run: review({ kind: "commits", from: commit.sha, to: commit.sha }),
        })),
    },
    choosePull: {
      placeholder: "Review a pull request",
      empty: "No open pull requests match.",
      entries: () =>
        (pulls() ?? []).map((pull) => ({
          id: `pull:${pull.number}`,
          label: pull.title,
          icon: "brandGithub",
          detail: `#${pull.number} · ${pull.author}`,
          words: `${pull.number} ${pull.author} ${pull.head}`,
          run: review({ kind: "pr", number: pull.number }),
        })),
    },
    filterFiles: {
      placeholder: "Show or hide files",
      empty: "Nothing to filter.",
      entries: () => [
        ...kinds
          .filter((kind) => state.files().some((file) => kindOf(file) === kind))
          .map((kind: Kind): Entry => ({
            id: `kind:${kind}`,
            label: title(kind),
            icon: "fileText",
            group: "Kind",
            checked: !state.hiddenKinds().has(kind),
            stay: true,
            run: () => void state.setHiddenKinds(flip(state.hiddenKinds(), kind)),
          })),
        ...statuses
          .filter((status) => state.files().some((file) => statusOf(file) === status))
          .map((status: Status): Entry => ({
            id: `status:${status}`,
            label: title(status),
            icon: "filter",
            group: "Git status",
            checked: !state.hiddenStatuses().has(status),
            stay: true,
            run: () => void state.setHiddenStatuses(flip(state.hiddenStatuses(), status)),
          })),
      ],
    },
    contrast: {
      placeholder: "Change contrast",
      empty: "No level matches.",
      entries: () =>
        choices("contrast", "brush", [
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
        ]),
    },
    appearance: {
      placeholder: "Appearance",
      empty: "No appearance matches.",
      entries: () =>
        choices("colorScheme", "brush", [
          { label: "System", value: "system" },
          { label: "Light", value: "light" },
          { label: "Dark", value: "dark" },
        ]),
    },
    lightTheme: {
      placeholder: "Light theme",
      empty: "No themes match.",
      entries: () => themeEntries(false),
    },
    darkTheme: { placeholder: "Dark theme", empty: "No themes match.", entries: () => themeEntries(true) },
    codeFont: {
      placeholder: "Code font",
      empty: "No fonts match. Type any installed font in Settings.",
      entries: () => choices("codeFont", "type", fontPresets.code),
    },
    uiFont: {
      placeholder: "Interface font",
      empty: "No fonts match. Type any installed font in Settings.",
      entries: () => choices("uiFont", "type", fontPresets.ui),
    },
  };

  const commandEntries = (): Entry[] =>
    actionNames
      .filter((action) => action !== "palette")
      .map((action) => ({
        id: action,
        label: definitionOf(action).label,
        icon: definitionOf(action).icon,
        group: definitionOf(action).group,
        words: definitionOf(action).words,
        detail: details[action]?.(),
        keys: preferences.keyText(action),
        stay: repeatable.has(action),
        page: pages[action] ? action : undefined,
        run: () => props.run(action),
      }));

  const current = () => {
    const name = page();
    return name ? pages[name] : undefined;
  };
  const score = (entry: Entry, text: string) =>
    Math.max(
      fuzzyScore(entry.label, text),
      0.7 * fuzzyScore(entry.group ?? "", text),
      // Words only match whole: letters scattered over many words match anything.
      (entry.words ?? "").toLowerCase().includes(text.toLowerCase()) ? 0.6 : 0,
    );

  /** Entries in labeled sections, or the best matches in one list while searching. */
  const sections = createMemo((): Array<{ label: string; entries: Entry[] }> => {
    if (!palette()) return [];
    const text = query().trim();
    const here = current();
    const own = here ? here.entries() : commandEntries();
    if (!text) {
      const groups = Map.groupBy(own, (entry) => entry.group ?? "");
      const order = here ? [...groups.keys()] : actionGroups.filter((group) => groups.has(group));
      return order.map((label) => ({ label, entries: groups.get(label)! }));
    }
    const everything = here
      ? own
      : [
          ...own,
          ...fileEntries().map((entry) => ({ ...entry, group: "File" })),
          ...commentEntries(props.onOpenComment).map((entry) => ({ ...entry, group: "Comment" })),
        ];
    const ranked = everything
      .map((entry, index) => ({
        entry,
        // Commands come first when a file matches about as well.
        score: score(entry, text) * (!here && index >= own.length ? 0.8 : 1),
      }))
      .filter((match) => match.score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 100)
      .map((match) => match.entry);
    return ranked.length ? [{ label: "", entries: ranked }] : [];
  });

  const loading = () =>
    !problem() &&
    ((page() === "choosePull" && !pulls()) ||
      ((page() === "chooseBase" || page() === "chooseCommit") && !scopes()) ||
      ((page() === "lightTheme" || page() === "darkTheme") && !themes()));

  // Highlights the best match again after each letter; otherwise the list keeps whichever row
  // was highlighted before, if it still matches. A choice that stays open keeps its place.
  const command = createCommandController();
  const searched = createMemo(() => `${query()}\n${page()}\n${loading()}`);
  createEffect(
    () => searched() && untrack(() => sections()[0]?.entries[0]?.id),
    (first) => queueMicrotask(() => void (first && command.setValue(first))),
  );

  function choose(entry: Entry) {
    if (entry.page) {
      setQuery("");
      setPalette([...(palette() ?? []), entry.page]);
    } else if (entry.stay) entry.run?.();
    else close(entry.run);
  }

  return (
    <Dialog
      open={palette() !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onOpenChangeComplete={(open) => {
        if (open) return;
        setQuery("");
        const run = afterClose;
        afterClose = undefined;
        run?.();
      }}
    >
      <DialogBackdrop class="dialog-backdrop palette-backdrop" />
      <DialogContent class="palette">
        <DialogTitle class="sr-only">Command palette</DialogTitle>
        <Command
          class="palette-command"
          filter={false}
          query={query()}
          onQueryChange={setQuery}
          controller={command}
          pages={palette() ?? []}
          onPagesChange={(next, details) => {
            // A page opened by its own key has nothing behind it to go back to.
            if (details.reason === "escape-key" && direct() && next.length === 0) close();
            else setPalette(next as Action[]);
          }}
          status={loading() ? "loading" : "idle"}
        >
          <div class="palette-search">
            <Icon name="search" />
            <CommandInput
              class="palette-input"
              onKeyDown={listMotions}
              aria-label="Search commands"
              placeholder={current()?.placeholder ?? "Search commands, files and comments"}
            />
          </div>
          <CommandEmpty class="menu-empty palette-empty">
            {problem() || (loading() ? "Loading…" : (current()?.empty ?? "Nothing matches."))}
          </CommandEmpty>
          <CommandList class="palette-list" aria-label="Commands">
            <For each={sections()} keyed={(section) => section.label}>
              {(section) => (
                <CommandGroup class="palette-group">
                  <Show when={section().label}>
                    <CommandGroupLabel class="menu-label">{section().label}</CommandGroupLabel>
                  </Show>
                  <For each={section().entries} keyed={(entry) => entry.id}>
                    {(entry) => (
                      <CommandItem
                        class="menu-item palette-item"
                        value={entry().id}
                        label={entry().label}
                        onSelect={() => choose(entry())}
                      >
                        <span class="palette-icon" aria-hidden="true">
                          <Icon name={entry().icon} />
                        </span>
                        <span class="palette-label">{entry().label}</span>
                        <Show when={query().trim() && !current() && entry().group}>
                          <span class="palette-detail">{entry().group}</span>
                        </Show>
                        <Show when={entry().detail}>
                          <span class="palette-detail">{entry().detail}</span>
                        </Show>
                        <Show when={entry().colors}>
                          <span class="palette-colors" aria-hidden="true">
                            <For each={entry().colors}>
                              {(color) => <span style={{ background: color }} />}
                            </For>
                          </span>
                        </Show>
                        <Show when={entry().checked}>
                          <span class="menu-check">
                            <Icon name="check" />
                            <span class="sr-only">On</span>
                          </span>
                        </Show>
                        <Show when={entry().keys}>
                          <kbd class="palette-keys">{entry().keys}</kbd>
                        </Show>
                      </CommandItem>
                    )}
                  </For>
                </CommandGroup>
              )}
            </For>
          </CommandList>
          <footer class="palette-foot">
            <span>↵ {page() ? "choose" : "run"}</span>
            <span>↑↓ move</span>
            <span>esc {page() && !direct() ? "back" : "close"}</span>
          </footer>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
