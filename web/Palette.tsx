//! The command palette: every command in commands.ts, and from the first typed
//! letter every file and comment, and the files the change leaves alone. Empty,
//! it offers what is likeliest: the file being read, what was chosen recently,
//! and its modes. A query that starts with a mode's prefix is that mode: > runs
//! commands, / searches the code, # filters the files by name, : goes to a line
//! and ? lists the modes. A file's row goes to the line typed after it, as in
//! state.ts:120, and ⌘↵ runs a row's second action. Commands that need a choice open a page of
//! their own. Commands run once the dialog is gone and focus is back on the
//! page, so whatever they open can take it.

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
import type { Comment, GrepMatch, PullRequest, Scope, ScopesResponse, Side } from "../src/protocol.ts";
import { loadGrep, loadPullRequests, loadScopes } from "./api.ts";
import { hitLimit, matcher, searchDiff, type Hit } from "./grep.ts";
import { actionGroups, actionNames, definitionOf, type Action } from "./commands.ts";
import { listMotions } from "./hotkeys.ts";
import { FileIcon } from "./FileIcon.tsx";
import { Icon, statusIcons } from "./Icon.tsx";
import type { IconName } from "./icons.gen.ts";
import { Marked } from "./Marked.tsx";
import { aboutLabel, removeComment } from "./Notes.tsx";
import { search, type Searchable } from "./search.ts";
import { fontPresets, preferences, type Settings } from "./settings.ts";
import {
  comparePaths,
  isGlobal,
  kindOf,
  matchesName,
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

interface Entry extends Searchable {
  id: string;
  icon: IconName;
  /** A file's path: the row shows the file's own icon, as the tree does. */
  file?: string;
  /** What happened to the file, shown at the row's end as the tree marks it. */
  tone?: Status;
  group?: string;
  detail?: string;
  /** Which characters of the label the search matched. */
  marks?: ReadonlySet<number>;
  keys?: string;
  checked?: boolean;
  colors?: readonly string[];
  /** Leaves the palette open, for choices made more than one at a time. */
  stay?: boolean;
  page?: Action;
  run?: () => void;
  /** What ⌘↵ does instead, named for the footer. */
  alt?: { label: string; run: () => void };
}

interface Page {
  placeholder: string;
  empty: string;
  entries: () => Entry[];
}

// Whether a command's own key opened its page.
const [direct, setDirect] = createSignal(false);
const [query, setQuery] = createSignal("");

/** The palette's modes, each the prefix that starts a query, in the order it lists them. */
const modes = [
  { prefix: ">", id: "commands", chip: "Commands", label: "Run a command", icon: "command" },
  { prefix: "/", id: "grep", chip: "Code", label: "Search file contents", icon: "codeSearch" },
  { prefix: "#", id: "names", chip: "Names", label: "Filter files by name", icon: "filter" },
  { prefix: ":", id: "line", chip: "Line", label: "Go to a line in this file", icon: "listOrdered" },
  { prefix: "?", id: "help", chip: "Help", label: "What the palette can do", icon: "question" },
] as const satisfies ReadonlyArray<{
  prefix: string;
  id: string;
  chip: string;
  label: string;
  icon: IconName;
}>;
type Mode = (typeof modes)[number]["id"];

// What was chosen lately, newest first, by row: it is offered before anything is typed and
// ranks a little higher when something is. Kept in this browser for every review.
const recentKey = "patch:recent";
function readRecent(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}
const [recent, setRecent] = createSignal<readonly string[]>(readRecent());
function rememberChoice(id: string) {
  const next = [id, ...recent().filter((other) => other !== id)].slice(0, 20);
  setRecent(next);
  try {
    localStorage.setItem(recentKey, JSON.stringify(next));
  } catch {
    // Storage is off: nothing is remembered.
  }
}
/** Rows worth remembering: commands, files and comments, not searches or one-off rows. */
const remembered = (id: string) => /^(file|unchanged|comment):/.test(id) || id in definitionsById;
const definitionsById = Object.fromEntries(actionNames.map((name) => [name, true]));

/** Opens the palette, on a command's page or on every command, with something already typed. */
export function openPalette(page?: Action, typed = "") {
  setDirect(page !== undefined);
  setQuery(typed);
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
  previewSvg: () => onOff(settings.previewSvg),
  previewMarkdown: () => onOff(settings.previewMarkdown),
  wholeFiles: () => onOff(settings.wholeFiles),
  groupByKind: () => onOff(settings.groupByKind),
  sidebar: () => (settings.sidebarOpen ? "Shown" : "Hidden"),
  showComments: () => (settings.commentsOpen ? "Shown" : "Hidden"),
  showUnchanged: () => onOff(state.showUnchanged()),
  sidebarSide: () => `Files on the ${settings.sidebarSide}`,
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
  onFind: (text: string) => void;
  /** Goes to a line a search of the code found. */
  onGoToLine: (file: string, line: number, side: Side) => void;
  /** Narrows the files to those whose names have this in them; empty shows them all. */
  onFilterNames: (text: string) => void;
  /** Shows a file on its own, in place of the review. */
  onBrowse: (path: string) => void;
  /** The file being read, which the empty palette and : are about. */
  currentFile: () => string | undefined;
  onRestoreDefaults: () => void;
}) {
  const [scopes, setScopes] = createSignal<ScopesResponse>();
  const [pulls, setPulls] = createSignal<PullRequest[]>();
  const [themes, setThemes] = createSignal<readonly Theme[]>();
  const [problem, setProblem] = createSignal("");
  // The files the change leaves alone are read the first time the palette opens on a review.
  const unchanged = () => state.catalog();
  createEffect(
    () => palette() !== undefined && state.store.review !== undefined && state.catalog() === undefined,
    (wanted) => {
      if (wanted) state.readCatalog();
    },
  );
  let afterClose: (() => void) | undefined;

  const page = createMemo(() => palette()?.at(-1));
  // Read again on opening: another review's tab may have chosen something since.
  createEffect(
    () => palette() !== undefined,
    (open) => {
      if (open) setRecent(readRecent());
    },
  );

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
    state.ordered().map((comment) => ({
      id: `comment:${comment.id}`,
      label: comment.body.trim().split("\n")[0]!,
      icon: "comment",
      detail: isGlobal(comment)
        ? aboutLabel(comment)
        : `${comment.file.split("/").at(-1)} · ${aboutLabel(comment)}`,
      words: `${comment.file} ${comment.body}`,
      run: () => run(comment),
      alt: { label: "edit", run: () => props.onEditComment(comment) },
    }));
  const fileEntries = (): Entry[] =>
    state.visibleFiles().map((file) => {
      const { additions, deletions } = stats(file);
      const status = statusOf(file);
      return {
        id: `file:${file.name}`,
        label: file.name,
        path: true,
        // What is left to review is likelier wanted.
        weight: state.isViewed(file.name) ? 0.95 : 1,
        icon: "fileText",
        file: file.name,
        tone: status,
        detail: `+${additions} −${deletions}`,
        checked: state.isViewed(file.name),
        run: () => props.onOpenFile(file.name),
        alt: { label: "open alone", run: () => props.onBrowse(file.name) },
      };
    });
  const unchangedEntries = (): Entry[] => {
    const paths = unchanged();
    if (paths instanceof Error) return [];
    const changed = new Set(state.files().flatMap((file) => [file.name, file.prevName ?? file.name]));
    return (paths ?? [])
      .filter((path) => !changed.has(path))
      .map((path) => ({
        id: `unchanged:${path}`,
        label: path,
        path: true,
        file: path,
        // What changed is likelier wanted.
        weight: 0.75,
        icon: "fileText",
        group: "Unchanged file",
        run: () => props.onOpenFile(path),
      }));
  };
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
      entries: () => commentEntries(props.onEditComment),
    },
    deleteComment: {
      placeholder: "Delete comment",
      empty: "No comments to delete.",
      entries: () =>
        commentEntries((comment) => removeComment(comment.id)).map((entry) => ({
          ...entry,
          icon: "trash",
        })),
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
        {
          id: "only:unviewed",
          label: "Not viewed",
          icon: "checkCircle",
          group: "Only",
          checked: state.onlyUnviewed(),
          stay: true,
          run: () => void state.setOnlyUnviewed((only) => !only),
        },
        {
          id: "only:commented",
          label: "With comments",
          icon: "comment",
          group: "Only",
          checked: state.onlyCommented(),
          stay: true,
          run: () => void state.setOnlyCommented((only) => !only),
        },
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

  /** The mode the query's first letter names; on a command's page there is none. */
  const modeInfo = () => (page() ? undefined : modes.find((mode) => query().startsWith(mode.prefix)));
  const mode = (): Mode | undefined => modeInfo()?.id;
  const modeText = () => query().slice(1).trim();
  const fileName = (path: string) => path.split("/").at(-1) ?? path;

  /** What can be done to the file being read: the empty palette's first rows. */
  const contextEntries = (): Entry[] => {
    const file = props.currentFile();
    if (!file) return [];
    const changed = state.fileByName(file);
    const name = fileName(file);
    const action = (id: Action, label: string, icon: IconName): Entry => ({
      id: `here:${id}`,
      label,
      icon,
      keys: preferences.keyText(id),
      run: () => props.run(id),
    });
    return [
      action("fileComment", `Comment on ${name}`, "comment"),
      ...(changed
        ? [
            action(
              "viewed",
              state.isViewed(file) ? `Mark ${name} not viewed` : `Mark ${name} viewed`,
              "checkCircle",
            ),
          ]
        : []),
      state.isBrowsing()
        ? action("backToReview", "Back to the review", "diffUnified")
        : {
            id: "here:alone",
            label: `Show ${name} on its own`,
            icon: "fileText",
            run: () => props.onBrowse(file),
          },
    ];
  };
  /** Each mode as a row that types its prefix. */
  const modeEntries = (): Entry[] =>
    modes.map((mode) => ({
      id: `mode:${mode.id}`,
      label: mode.label,
      icon: mode.icon,
      keys: mode.prefix,
      stay: true,
      run: () => setQuery(mode.prefix),
    }));
  /** Rows chosen lately, as they are now; one that is gone is left out. */
  const recentEntries = (everything: readonly Entry[]): Entry[] => {
    const byId = new Map(everything.map((entry) => [entry.id, entry]));
    return recent()
      .flatMap((id) => {
        const entry = byId.get(id);
        return entry ? [{ ...entry, id: `recent:${id}`, group: undefined }] : [];
      })
      .slice(0, 5);
  };
  /** `:42` goes to line 42 of the file being read. */
  const lineEntries = (): Entry[] => {
    const file = props.currentFile();
    const line = Number(modeText());
    if (!file || !Number.isInteger(line) || line < 1) return [];
    return [
      {
        id: `line:${line}`,
        label: `Go to line ${line}`,
        icon: "diffUnified",
        detail: fileName(file),
        run: () => props.onGoToLine(file, line, "additions"),
      },
    ];
  };
  const exploring = state.showUnchanged;
  // Exploring, the files the change leaves alone are searched by the server, once typing pauses.
  const [remote, setRemote] = createSignal<{
    text: string;
    key: string;
    found: readonly GrepMatch[] | Error;
  }>();
  /** The server's answer to what is asked now, of the review shown now. */
  const answer = () => {
    const far = remote();
    return far?.text === modeText() && far.key === state.store.review?.scopeKey ? far.found : undefined;
  };
  createEffect(
    () => (mode() === "grep" && exploring() ? modeText() : ""),
    (text) => {
      const key = state.store.review?.scopeKey;
      if (text.length < 2 || !key) return;
      const timer = setTimeout(() => {
        // Only the answer to what is asked now, of the review shown now: an older one
        // that comes back late is dropped.
        const keep = (found: readonly GrepMatch[] | Error) => {
          if (modeText() === text && state.store.review?.scopeKey === key && exploring())
            setRemote({ text, key, found });
        };
        loadGrep(key, text).then(keep, (error: unknown) =>
          keep(error instanceof Error ? error : new Error(String(error))),
        );
      }, 150);
      return () => clearTimeout(timer);
    },
  );
  const searching = () =>
    mode() === "grep" && exploring() && modeText().length >= 2 && answer() === undefined;
  /** Lines with what is typed in them: the diff's, and exploring the other files' too. */
  const grepEntries = (): Entry[] => {
    const text = modeText();
    if (text.length < 2) return [];
    // Exploring, the server searches every file whole, the changed ones as they are now;
    // in the review, the diff's lines are searched here, the removed ones too.
    const found = answer();
    const hits: Hit[] = !exploring()
      ? searchDiff(state.files(), text)
      : Array.isArray(found)
        ? found.map((match) => ({ ...match, side: "additions" as const }))
        : [];
    const find = matcher(text);
    const entries = hits
      .toSorted((a, b) => comparePaths(a.file, b.file) || a.line - b.line)
      .slice(0, hitLimit)
      .map((hit): Entry => {
        const label = hit.text.trim() || " ";
        const at = find(label);
        return {
          id: `hit:${hit.file}:${hit.side}:${hit.line}`,
          label,
          icon: "code",
          detail: `${hit.file}:${hit.line}${hit.side === "deletions" ? " (removed)" : ""}`,
          marks: at < 0 ? undefined : new Set(Array.from(text, (_, index) => at + index)),
          run: () => props.onGoToLine(hit.file, hit.line, hit.side),
        };
      });
    if (exploring() && found instanceof Error)
      entries.push({ id: "grep-error", label: found.message, icon: "x" });
    return entries;
  };
  /** Files whose names have what is typed in them, after a row that filters the tree and the review to them. */
  const nameEntries = (): Entry[] => {
    const text = modeText();
    const others = unchanged();
    const all = [
      ...new Set([
        ...state.files().map((file) => file.name),
        ...(exploring() && Array.isArray(others) ? others : []),
      ]),
    ];
    const found = text ? all.filter((path) => matchesName(path, text)).sort(comparePaths) : [];
    const applied = state.nameQuery().trim();
    const head: Entry[] = text
      ? [
          {
            id: "names-filter",
            label: `Show only files named “${text}”`,
            icon: "filter",
            detail: `${found.length} ${found.length === 1 ? "file" : "files"}`,
            run: () => props.onFilterNames(text),
          },
        ]
      : applied
        ? [
            {
              id: "names-clear",
              label: `Show every file again, not only “${applied}”`,
              icon: "x",
              run: () => props.onFilterNames(""),
            },
          ]
        : [];
    return [
      ...head,
      ...found.slice(0, 100).map((path): Entry => ({
        id: `name:${path}`,
        label: path,
        path: true,
        file: path,
        icon: "fileText",
        run: () => props.onOpenFile(path),
      })),
    ];
  };
  /** Entries in labeled sections, or the best matches in one list while searching. */
  const sections = createMemo((): Array<{ label: string; entries: Entry[] }> => {
    if (!palette()) return [];
    const one = (label: string, entries: Entry[]) => (entries.length ? [{ label, entries }] : []);
    const grouped = (entries: Entry[], order?: readonly string[]) => {
      const groups = Map.groupBy(entries, (entry) => entry.group ?? "");
      return (order ?? [...groups.keys()])
        .filter((group) => groups.has(group))
        .map((label) => ({ label, entries: groups.get(label)! }));
    };
    const here = current();
    switch (mode()) {
      case "grep":
        return one(exploring() ? "In every file" : "In the diff", grepEntries());
      case "names":
        return one("", nameEntries());
      case "line":
        return one("", lineEntries());
      case "help":
        return one("Modes", modeEntries());
      case "commands": {
        const text = modeText();
        if (!text) return grouped(commandEntries(), actionGroups);
        return one("", ranked(commandEntries(), text));
      }
    }
    const text = query().trim();
    const own = here ? here.entries() : commandEntries();
    if (!text) {
      if (here) return grouped(own);
      // Before anything is typed: the file being read, what was chosen lately, then the modes
      // and every command.
      const file = props.currentFile();
      return [
        ...one(file ? `This file · ${fileName(file)}` : "", contextEntries()),
        ...one(
          "Recent",
          recentEntries([
            ...own,
            ...fileEntries(),
            ...unchangedEntries(),
            ...commentEntries(props.onOpenComment),
          ]),
        ),
        ...one("Search", modeEntries().slice(1)),
        ...grouped(own, actionGroups),
      ];
    }
    // A file's row with a line after its name, as in state.ts:120, goes to that line.
    const at = /^(.+?):(\d+)$/.exec(text);
    const name = at ? at[1]! : text;
    const toLine = (entry: Entry): Entry => {
      if (!at || !entry.path) return entry;
      const path = entry.label;
      const line = Number(at[2]);
      return { ...entry, detail: `line ${line}`, run: () => props.onGoToLine(path, line, "additions") };
    };
    const everything = here
      ? page() === "goToFile"
        ? [...own, ...unchangedEntries()]
        : own
      : [
          ...own,
          // Commands come first when a file matches about as well.
          ...fileEntries().map((entry) => ({ ...entry, group: "File", weight: 0.9 * (entry.weight ?? 1) })),
          ...unchangedEntries().map((entry) => ({ ...entry, weight: 0.9 * entry.weight! })),
          ...commentEntries(props.onOpenComment).map((entry) => ({
            ...entry,
            group: "Comment",
            weight: 0.8,
          })),
        ];
    const entries = ranked(everything, name).map(toLine);
    // Why no unchanged file was found: a pull request not fetched has nothing to read them from.
    const missing = unchanged();
    if (missing instanceof Error && (!here || page() === "goToFile"))
      entries.push({ id: "unchanged-error", label: missing.message, icon: "x", group: "Unchanged file" });
    if (!here) {
      entries.push({
        id: "find-text",
        label: `Search the code for “${text}”`,
        icon: "search",
        keys: "/",
        stay: true,
        run: () => setQuery(`/${text}`),
      });
      entries.push({
        id: "find-diff",
        label: `Find “${text}” on screen`,
        icon: "search",
        run: () => props.onFind(text),
      });
    }
    return one("", entries);
  });

  /** The best matches, what was chosen lately a little ahead. */
  function ranked(entries: readonly Entry[], text: string): Entry[] {
    const lately = new Map(recent().map((id, index) => [id, 1.2 - index * 0.01]));
    return search(
      entries.map((entry) => ({
        ...entry,
        words: `${entry.words ?? ""} ${entry.group ?? ""}`,
        weight: (entry.weight ?? 1) * (lately.get(entry.id) ?? 1),
      })),
      text,
    )
      .slice(0, 100)
      .map(({ entry, marks }): Entry => ({ ...entry, marks }));
  }
  const entryById = createMemo(
    () => new Map(sections().flatMap((section) => section.entries.map((entry) => [entry.id, entry]))),
  );
  const [highlighted, setHighlighted] = createSignal<string | null>(null);
  const highlightedEntry = () => entryById().get(highlighted() ?? "");

  const loading = () =>
    !problem() &&
    (searching() ||
      (page() === "choosePull" && !pulls()) ||
      ((page() === "chooseBase" || page() === "chooseCommit") && !scopes()) ||
      ((page() === "lightTheme" || page() === "darkTheme") && !themes()));

  // Highlights the best match again after each letter; otherwise the list keeps whichever row
  // was highlighted before, if it still matches. A choice that stays open keeps its place.
  const command = createCommandController();
  const searched = createMemo(() => `${query()}\n${page()}\n${loading()}`);
  createEffect(
    () => searched() && untrack(() => sections()[0]?.entries[0]?.id),
    (first) =>
      queueMicrotask(() => {
        if (!first) return;
        command.setValue(first);
        setHighlighted(first); // The controller's own highlight is not reported.
      }),
  );

  function choose(entry: Entry, alt = false) {
    const id = entry.id.replace(/^(recent|here):/, "");
    if (remembered(id)) rememberChoice(id);
    if (alt && entry.alt) return close(entry.alt.run);
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
          onValueChange={setHighlighted}
          pages={palette() ?? []}
          onPagesChange={(next, details) => {
            // A page opened by its own key has nothing behind it to go back to.
            if (details.reason === "escape-key" && direct() && next.length === 0) close();
            else setPalette(next as Action[]);
          }}
          status={loading() ? "loading" : "idle"}
        >
          <div
            class="palette-search"
            ref={(element) =>
              // Before the list takes Enter: with ⌘ or Control it runs the row's second action.
              element.addEventListener(
                "keydown",
                (event) => {
                  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
                  const entry = entryById().get(command.getValue() ?? "");
                  if (!entry?.alt) return;
                  event.preventDefault();
                  event.stopPropagation();
                  choose(entry, true);
                },
                { capture: true },
              )
            }
          >
            {/* The mode a query's prefix chose shows as the field's icon. */}
            <span
              class={{ "palette-mode": true, active: modeInfo() !== undefined }}
              title={modeInfo()?.chip ?? "Search"}
            >
              <Icon name={modeInfo()?.icon ?? "search"} />
              <Show when={modeInfo()}>{(info) => <span class="sr-only">{info().chip} mode</span>}</Show>
            </span>
            <CommandInput
              class="palette-input"
              onKeyDown={listMotions}
              aria-label="Search commands"
              placeholder={
                current()?.placeholder ??
                (mode() === "grep"
                  ? exploring()
                    ? "Search the code in every file"
                    : "Search the code in the diff"
                  : mode() === "names"
                    ? "Filter files by name"
                    : mode() === "line"
                      ? "Go to line…"
                      : mode() === "commands"
                        ? "Run a command"
                        : "Search commands, files and comments · ? for more")
              }
            />
          </div>
          <CommandEmpty class="menu-empty palette-empty">
            {problem() ||
              (loading()
                ? "Loading…"
                : (current()?.empty ??
                  (mode() === "grep"
                    ? modeText().length < 2
                      ? `Type two or more letters to search ${exploring() ? "every file" : "the diff"}.`
                      : `Nothing ${exploring() ? "in any file" : "in the diff"} has “${modeText()}”.`
                    : mode() === "names"
                      ? "Type part of a file's name."
                      : mode() === "line"
                        ? props.currentFile()
                          ? "Type a line number."
                          : "Open a file first."
                        : "Nothing matches.")))}
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
                        onSelect={(event) =>
                          choose(
                            entry(),
                            "metaKey" in event &&
                              ((event as MouseEvent).metaKey || (event as MouseEvent).ctrlKey),
                          )
                        }
                      >
                        <span class="palette-icon" title={entry().group} aria-hidden="true">
                          <Show when={entry().file} fallback={<Icon name={entry().icon} />}>
                            {(path) => <FileIcon path={path()} />}
                          </Show>
                        </span>
                        <Marked label={entry().label} marks={entry().marks} />
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
                        <Show when={entry().tone}>
                          {(tone) => (
                            <span class={["palette-status", `status-${tone()}`]} title={title(tone())}>
                              <Icon name={statusIcons[tone()]} />
                            </span>
                          )}
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
            <Show when={highlightedEntry()?.alt}>{(alt) => <span>⌘↵ {alt().label}</span>}</Show>
            <span>↑↓ move</span>
            <span>esc {page() && !direct() ? "back" : "close"}</span>
          </footer>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
