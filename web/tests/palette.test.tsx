import { HotkeyManager } from "@tanstack/hotkeys";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { $, click, mount, named, press, settle, type } from "./dom.tsx";

const calls: string[] = [];
const target = { file: "a.ts", range: { start: 2, end: 2, side: "additions" as const } };
vi.mock("../diff.ts", () => ({
  createDiffView: () =>
    new Proxy(
      {},
      {
        get: (_, name) => (name === "commentTarget" ? () => target : () => void calls.push(String(name))),
      },
    ) as unknown as import("../diff.ts").DiffView,
}));
vi.mock("../Tree.tsx", () => ({
  Tree: (props: { paths: readonly string[] }) => <div class="tree">{props.paths.join(" ")}</div>,
  treeStatus: () => [],
}));

const { App } = await import("../App.tsx");
const { actionNames, definitionOf } = await import("../commands.ts");
const { preferences, defaults } = await import("../settings.ts");
const { state, globalTarget, wholeFile } = await import("../state.ts");
const ui = await import("../ui.ts");

const patch = (line: string) => `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one
-two
+${line}
 three
diff --git a/b.md b/b.md
--- a/b.md
+++ b/b.md
@@ -1 +1 @@
-x
+y
`;

let line = "TWO";
// Holds the next reads of whole files until it is called.
let held: Promise<void> | undefined;
const submitted: unknown[] = [];

beforeEach(async () => {
  calls.length = 0;
  submitted.length = 0;
  line = "TWO";
  sessionStorage.clear();
  localStorage.removeItem("patch:recent");
  ui.setPalette(undefined);
  ui.setSettingsOpen(false);
  ui.setScopeOpen(false);
  ui.setFilterOpen(false);
  if (state.isBrowsing()) state.stopBrowsing();
  state.setShowUnchanged(false);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/submit") submitted.push(JSON.parse(String(init?.body)));
    if (url.startsWith("/api/unchanged/file")) await held;
    if (url.startsWith("/api/unchanged/file"))
      return url.includes("util")
        ? new Response("export const x = 1;\nexport const y = 2;\n")
        : url.includes("README")
          ? new Response("# demo\n")
          : new Response('{"error":"Unknown file."}', { status: 404 });
    const body = url.startsWith("/api/review")
      ? {
          repository: "demo",
          branch: "feature",
          scope: { kind: "all" },
          scopeKey: "k",
          label: "feature vs main",
          patch: patch(line),
          session: "run1",
        }
      : url.startsWith("/api/scopes")
        ? { branches: ["main", "dev"], base: "main", since: "main", commits: [] }
        : url.startsWith("/api/prs")
          ? []
          : url.startsWith("/api/unchanged")
            ? ["a.ts", "lib/util.ts", "README.md"]
            : url.startsWith("/api/grep")
              ? [{ file: "lib/util.ts", line: 2, text: "export const y = 2;" }]
              : {};
    return new Response(JSON.stringify(body));
  });
  preferences.reset();
  mount(() => <App />);
  await settle();
});
afterEach(async () => {
  state.cancelComposer();
  state.clearFilter();
  state.deleteComments(state.store.comments.map((comment) => comment.id));
  await settle();
  HotkeyManager.resetInstance();
});

const mod = { ctrlKey: true };
const key = (letter: string, init: KeyboardEventInit = {}) =>
  press(document.body, letter, {
    code: /^[a-z]$/i.test(letter) ? `Key${letter.toUpperCase()}` : undefined,
    ...init,
  });
const open = () => key("k", mod);
const search = () => named("combobox", "Search commands") as HTMLInputElement;
const options = () =>
  [...document.querySelectorAll<HTMLElement>(".palette [role=option]")].map(
    (option) => option.querySelector(".palette-label")!.textContent,
  );
const isOpen = () => document.querySelector(".palette[data-open]") !== null;
const choose = async (text: string) => {
  await type(search(), text);
  await press(search(), "Enter");
};

test("every command is in the palette, once, and can be bound in Settings", async () => {
  await open();
  await type(search(), ">");
  const labels = actionNames.filter((name) => name !== "palette").map((name) => definitionOf(name).label);
  expect(options().toSorted()).toEqual(labels.toSorted());
  expect(new Set(labels).size).toBe(labels.length);
});

test("default keys are chords, and no two are the same", () => {
  const keys = actionNames.flatMap((name) => definitionOf(name).key ?? []);
  expect(new Set(keys).size).toBe(keys.length);
  for (const chord of keys) expect(chord).toMatch(/^(Mod|Alt|Control)\+/);
});

test("plain letters do nothing, wherever the pointer is", async () => {
  const before = JSON.stringify(preferences.settings);
  for (const letter of "abcdefghijklmnopqrstuvwxyz0123456789/?") await key(letter);
  expect(calls.filter((name) => /step|scroll|clear/.test(name))).toEqual([]);
  expect(JSON.stringify(preferences.settings)).toBe(before);
  expect(state.composer()).toBeUndefined();
  expect(isOpen()).toBe(false);
});

test("typing finds commands, files and comments, and Enter runs the best after closing", async () => {
  state.saveComment(globalTarget, "rename the widget");
  await settle();
  await open();
  await type(search(), "b.md");
  expect(options()[0]).toBe("b.md");
  await type(search(), "widget");
  expect(options()).toContain("rename the widget");
  await choose("wrap long");
  expect(isOpen()).toBe(false);
  expect(preferences.settings.wrap).toBe(!defaults.wrap);
});

test("an unchanged file is browsed on its own, takes comments, and the review comes back", async () => {
  await open();
  await type(search(), "util");
  expect(options()[0]).toBe("lib/util.ts");
  await press(search(), "Enter");
  await settle();
  expect(state.isBrowsing()).toBe(true);
  expect(state.browsing()).toBe("lib/util.ts");
  // From it on, the files of the tree follow in its order, the changed ones as diffs.
  expect(state.windowItems().map((file) => file.name)).toEqual(["lib/util.ts", "a.ts", "b.md", "README.md"]);
  expect(state.openedFiles().map((file) => file.name)).toEqual(["lib/util.ts", "README.md"]);
  expect(calls).toContain("setFiles");
  // A changed file is not offered twice.
  await open();
  await type(search(), "a.ts");
  expect(options().filter((option) => option === "a.ts")).toHaveLength(1);
  await press(search(), "Escape");

  const id = state.saveComment({ file: "lib/util.ts", side: "additions", start: 2, end: 2 }, "why two?");
  await settle();
  const comment = state.store.comments.find((comment) => comment.id === id)!;
  expect(comment.excerpt).toEqual(["export const y = 2;"]);
  expect(state.lineOf(comment)).toBe(2);
  state.compose(wholeFile("lib/util.ts"));
  state.setComposerText("half written");
  await settle();
  // Back to the review: the file is not on screen, and nothing written on it is lost.
  state.stopBrowsing();
  await settle();
  expect(state.isBrowsing()).toBe(false);
  expect(state.openedFiles()).toEqual([]);
  expect(state.store.comments.map((comment) => comment.body)).toEqual(["why two?", "half written"]);
  expect(state.lineOf(comment)).toBeUndefined();
});

test("the file tree shows unchanged files on request, and the kind filter applies to them", async () => {
  const tree = () => $(".tree").textContent!.split(" ");
  // Grouped by kind, each kind a section of its own that folds, until that is turned off.
  const sections = () =>
    [...document.querySelectorAll(".kind-section")].map((section) => [
      section.querySelector(".kind-name")!.textContent,
      section.querySelector(".tree")?.textContent ?? "",
    ]);
  expect(sections()).toEqual([
    ["Code", "a.ts"],
    ["Docs", "b.md"],
  ]);
  await click($(".kind-head"));
  expect(sections()[0]).toEqual(["Code", ""]);
  await click($(".kind-head"));
  preferences.update({ groupByKind: false });
  await settle();
  expect(tree()).toEqual(["a.ts", "b.md"]);
  // The whole repository is never grouped.
  preferences.update({ groupByKind: true });
  state.setShowUnchanged(true);
  await settle();
  expect(tree()).toEqual(["lib/util.ts", "a.ts", "b.md", "README.md"]);
  state.setHiddenKinds(new Set(["docs"] as const));
  await settle();
  expect(tree()).toEqual(["lib/util.ts", "a.ts"]);
});

test("a changed file chosen while an unchanged one is read is what shows", async () => {
  let release = () => {};
  held = new Promise((done) => (release = done));
  await open();
  await choose("util");
  await settle();
  await open();
  await choose("a.ts");
  await settle();
  release();
  held = undefined;
  await settle();
  expect(state.isBrowsing()).toBe(false);
  expect(calls).toContain("scrollToFile");
});

test("a search that finds only unchanged files does not offer to clear it", async () => {
  state.setShowUnchanged(true);
  state.setNameQuery("util");
  await settle();
  expect($(".tree").textContent).toBe("lib/util.ts");
  expect($(".overlay").textContent).toContain("No changed files match");
  expect(document.querySelector(".overlay button")).toBeNull();
  state.setNameQuery("nothing-here");
  await settle();
  expect($(".overlay").textContent).toContain("No files match the current filters.");
  state.setNameQuery("");
});

test("the files can be narrowed to those not viewed, or with comments", async () => {
  const shown = () => state.visibleFiles().map((file) => file.name);
  state.toggleViewed("a.ts");
  state.setOnlyUnviewed(true);
  await settle();
  expect(shown()).toEqual(["b.md"]);
  state.setOnlyUnviewed(false);
  state.toggleViewed("a.ts");
  state.setOnlyCommented(true);
  await settle();
  expect(shown()).toEqual([]);
  state.saveComment({ file: "a.ts", side: "additions", start: 2, end: 2 }, "why?");
  await settle();
  expect(shown()).toEqual(["a.ts"]);
  expect(state.isFiltered()).toBe(true);
  state.clearFilter();
  await settle();
  expect(shown()).toEqual(["a.ts", "b.md"]);
});

test("exploring shows a changed file on its own too, and ends with the review back", async () => {
  state.setShowUnchanged(true);
  await state.browse("a.ts");
  await settle();
  expect(state.isBrowsing()).toBe(true);
  state.setShowUnchanged(false);
  await settle();
  expect(state.isBrowsing()).toBe(false);
});

test("Enter in the file search opens the best match, and exploring shows it on its own", async () => {
  const files = $<HTMLInputElement>(".sidebar .side-search");
  await type(files, "b.md");
  calls.length = 0;
  await press(files, "Enter");
  expect(calls).toContain("scrollToFile");
  expect(calls).not.toContain("find");
  state.setShowUnchanged(true);
  await settle();
  await type(files, "util");
  await press(files, "Enter");
  await settle();
  expect(state.browsing()).toBe("lib/util.ts");
  await type(files, "");
});

test("a name filter narrows the review, and what browsing scrolls through", async () => {
  const names = () => state.visibleFiles().map((file) => file.name);
  state.setNameQuery("B.MD");
  await settle();
  expect(names()).toEqual(["b.md"]);
  state.setNameQuery("");
  state.setShowUnchanged(true);
  await state.browse("lib/util.ts");
  await settle();
  state.setNameQuery("util readme");
  await settle();
  expect(state.windowItems().map((file) => file.name)).toEqual([]);
  state.setNameQuery("u");
  await settle();
  expect(state.windowItems().map((file) => file.name)).toEqual(["lib/util.ts"]);
  state.clearFilter();
  await settle();
  expect(state.nameQuery()).toBe("");
});

test("/ searches the code: the diff's lines, and exploring every file's", async () => {
  await open();
  await type(search(), "/TWO");
  expect(options()).toEqual(["TWO"]);
  await type(search(), "/two");
  expect(options()).toEqual(["TWO", "two"]);
  expect(document.querySelector(".palette [role=option] .palette-detail")!.textContent).toBe("a.ts:2");
  calls.length = 0;
  await press(search(), "Enter");
  await new Promise((done) => setTimeout(done, 100));
  expect(calls).toContain("scrollToLine");

  state.setShowUnchanged(true);
  await settle();
  await open();
  await type(search(), "/const y");
  await new Promise((done) => setTimeout(done, 250));
  await settle();
  expect(options()).toEqual(["export const y = 2;"]);
  await press(search(), "Escape");
});

test("# filters the files by name, from the palette", async () => {
  await open();
  await type(search(), "#b.m");
  expect(options()).toEqual(["Show only files named “b.m”", "b.md"]);
  await press(search(), "Enter");
  await settle();
  expect(state.nameQuery()).toBe("b.m");
  expect(state.visibleFiles().map((file) => file.name)).toEqual(["b.md"]);
  await open();
  await type(search(), "#");
  expect(options()).toEqual(["Show every file again, not only “b.m”"]);
  await press(search(), "Enter");
  await settle();
  expect(state.nameQuery()).toBe("");
});

test("a filter widened while browsing brings back the files between those it kept", async () => {
  state.setShowUnchanged(true);
  await state.browse("lib/util.ts");
  await settle();
  state.setNameQuery(".m");
  await settle();
  expect(state.windowItems().map((file) => file.name)).toEqual(["b.md", "README.md"]);
  state.setNameQuery("");
  await settle();
  expect(state.windowItems().map((file) => file.name)).toEqual(["b.md", "README.md"]);
  state.setNameQuery("a");
  await settle();
  state.setNameQuery("");
  await settle();
  // From the first file it kept, every file of the list follows, none skipped.
  const shown = state.windowItems().map((file) => file.name);
  const list = state.treePaths();
  expect(shown).toEqual(list.slice(list.indexOf(shown[0]!), list.indexOf(shown[0]!) + shown.length));
});

test("a refresh keeps a draft on a browsed file, and a file browsed meanwhile stays", async () => {
  await state.browse("lib/util.ts");
  await settle();
  state.compose({ file: "lib/util.ts", side: "additions", start: 1, end: 1 });
  state.setComposerText("draft");
  let release = () => {};
  held = new Promise((done) => (release = done));
  const loading = state.load();
  await settle();
  await state.browse("a.ts");
  release();
  held = undefined;
  await loading;
  await settle();
  expect(state.browsing()).toBe("a.ts");
  expect(state.openedFiles()).toEqual([]);
  const [draft] = state.store.comments;
  expect([draft?.body, draft?.excerpt]).toEqual(["draft", ["export const x = 1;"]]);
});

test("browsing another file keeps what was written on the last, and the last file chosen wins", async () => {
  // A slow read of one file does not replace a file chosen after it.
  let release = () => {};
  held = new Promise((done) => (release = done));
  const slow = state.browse("lib/util.ts");
  await state.browse("a.ts");
  release();
  held = undefined;
  expect(await slow).toBe(false);
  await settle();
  expect(state.browsing()).toBe("a.ts");

  await state.browse("lib/util.ts");
  await settle();
  state.compose({ file: "lib/util.ts", side: "additions", start: 2, end: 2 });
  state.setComposerText("unsaved");
  await settle();
  await state.browse("README.md");
  await settle();
  expect(state.browsing()).toBe("README.md");
  const [kept] = state.store.comments;
  expect([kept?.body, kept?.excerpt]).toEqual(["unsaved", ["export const y = 2;"]]);
});

test("empty, the palette offers the file being read, what was chosen lately, and its modes", async () => {
  const labels = () =>
    [...document.querySelectorAll(".palette .menu-label")].map((label) => label.textContent).slice(0, 3);
  await open();
  expect(labels()).toEqual(["This file · a.ts", "Search", "Navigation"]);
  expect(options().slice(0, 3)).toEqual(["Comment on a.ts", "Mark a.ts viewed", "Show a.ts on its own"]);
  await choose("b.md");
  await open();
  expect(labels()).toEqual(["This file · a.ts", "Recent", "Search"]);
  expect(options()[3]).toBe("b.md");
  // ? lists the modes, and choosing one types its prefix.
  await type(search(), "?");
  expect(options()).toEqual(modesListed);
  expect(document.querySelector(".palette-mode")!.getAttribute("title")).toBe("Help");
  await press(search(), "Enter");
  expect(search().value).toBe(">");
  expect(document.querySelector(".palette-mode")!.getAttribute("title")).toBe("Commands");
  await press(search(), "Escape");
});
const modesListed = [
  "Run a command",
  "Search file contents",
  "Filter files by name",
  "Go to a line in this file",
  "What the palette can do",
];

test(": goes to a line of the file being read, and a file's name with :line to its line", async () => {
  await open();
  await type(search(), ":2");
  expect(options()).toEqual(["Go to line 2"]);
  calls.length = 0;
  await press(search(), "Enter");
  await new Promise((done) => setTimeout(done, 100));
  expect(calls).toContain("scrollToLine");
  await open();
  await type(search(), "b.md:1");
  expect(options()[0]).toBe("b.md");
  calls.length = 0;
  await press(search(), "Enter");
  await new Promise((done) => setTimeout(done, 100));
  expect(calls).toContain("scrollToLine");
});

test("⌘↵ runs a row's second action: a changed file opens on its own", async () => {
  await open();
  await type(search(), "b.md");
  expect(document.querySelector(".palette-foot")!.textContent).toContain("⌘↵ open alone");
  await press(search(), "Enter", mod);
  await settle();
  expect(state.browsing()).toBe("b.md");
});

test("a command with a choice opens its page, and Backspace and Escape go back", async () => {
  await open();
  await choose("appearance");
  expect(options()).toEqual(["System", "Light", "Dark"]);
  expect(search().value).toBe("");
  await press(search(), "Backspace");
  expect(options().length).toBeGreaterThan(40);
  await choose("appearance…");
  await choose("dark");
  expect(preferences.settings.colorScheme).toBe("dark");
  expect(isOpen()).toBe(false);
});

test("Control with J and K moves through the palette", async () => {
  await open();
  const at = () => document.querySelector(".palette [data-highlighted] .palette-label")!.textContent;
  const first = at();
  expect((await press(search(), "j", { code: "KeyJ", ctrlKey: true })).defaultPrevented).toBe(true);
  expect(at()).toBe(options()[1]);
  await press(search(), "k", { code: "KeyK", ctrlKey: true });
  expect(at()).toBe(first);
  expect(isOpen()).toBe(true);
});

test("a page opened by its own key closes on Escape", async () => {
  await key("p", mod);
  expect(options()).toEqual(["a.ts", "b.md"]);
  await press(search(), "Escape");
  expect(isOpen()).toBe(false);
  await settle();
  expect(isOpen()).toBe(false);
});

test("filters stay open while several are chosen", async () => {
  await open();
  await choose("filter files");
  expect(options()).toContain("Docs");
  await choose("Docs");
  expect(isOpen()).toBe(true);
  expect(state.visibleFiles().map((file) => file.name)).toEqual(["a.ts"]);
  await choose("Docs");
  expect(state.visibleFiles()).toHaveLength(2);
});

test("keys run commands, but not under the palette or Settings, or while typing", async () => {
  const viewed = () => state.isViewed("a.ts");
  const mark = (target: Element = document.body) =>
    press(target, "V", { code: "KeyV", ctrlKey: true, shiftKey: true });
  await key("j", { altKey: true });
  expect(calls).toContain("stepChange");
  await mark();
  expect(viewed()).toBe(true);
  await mark();
  expect(viewed()).toBe(false);
  for (const cover of [() => ui.setPalette([]), () => ui.setSettingsOpen(true)]) {
    await cover();
    await settle();
    await mark();
    expect(viewed()).toBe(false);
    ui.setPalette(undefined);
    ui.setSettingsOpen(false);
    await settle();
  }
  await press(document.activeElement ?? document.body, "Escape");
  $<HTMLInputElement>(".side-search").focus();
  // ⌘⇧V pastes there.
  expect((await mark($(".side-search"))).defaultPrevented).toBe(false);
  expect(viewed()).toBe(false);
  // The palette's key works while typing.
  await press($(".side-search"), "k", { code: "KeyK", ...mod });
  expect(isOpen()).toBe(true);
});

test("holding the key that saves a comment never finishes, and it only saves while writing", async () => {
  state.compose(globalTarget);
  state.setComposerText("hello");
  await settle();
  const down = async (repeat: boolean) => {
    const init = { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true, cancelable: true, repeat };
    (document.querySelector(".composer textarea") ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", init),
    );
    await settle();
  };
  await down(false);
  expect(state.store.comments.map((comment) => comment.body)).toEqual(["hello"]);
  for (let count = 0; count < 3; count++) await down(true);
  expect(submitted).toEqual([]);
  const up = { key: "Enter", code: "Enter", bubbles: true };
  document.dispatchEvent(new KeyboardEvent("keyup", up));
  // Nor from a search, or under the scope picker.
  await press($(".side-search"), "Enter", mod);
  ui.setScopeOpen(true);
  await settle();
  await key("Enter", mod);
  expect(submitted).toEqual([]);
  ui.setScopeOpen(false);
  await settle();
});

test("keys do nothing under an open popover", async () => {
  for (const trigger of [".scope-trigger", '[title="Filter by kind or Git status"]']) {
    await click($(trigger));
    expect(document.querySelector('[data-slot="popover-content"][data-open]')).not.toBeNull();
    $(trigger).focus();
    await press($(trigger), "\\", { code: "Backslash", ...mod });
    expect(preferences.settings.layout, trigger).toBe(defaults.layout);
    await press(document.activeElement!, "Escape");
  }
});

test("a removed or custom key is what works, and what the palette shows", async () => {
  preferences.bind("layout", "");
  preferences.bind("wordDiff", "W");
  await settle();
  await key("\\", { code: "Backslash", ...mod });
  expect(preferences.settings.layout).toBe(defaults.layout);
  await key("w");
  expect(preferences.settings.wordDiff).toBe(!defaults.wordDiff);
  await open();
  const row = (label: string) =>
    [...document.querySelectorAll(".palette [role=option]")].find((e) => e.textContent!.includes(label))!;
  expect(row("Split or unified").querySelector("kbd")).toBeNull();
  expect(row("Highlight changed words").querySelector("kbd")!.textContent).toContain("W");
});

test("half-written comments survive refreshing, filtering and opening another", async () => {
  await key("/", { code: "Slash", ...mod });
  state.setComposerText("first thought");
  await settle();
  await state.load();
  await settle();
  expect(state.composerText()).toBe("first thought");
  expect(state.composer()).toMatchObject({ file: "a.ts", end: 2 });

  // The lines it is about change: it is kept as written.
  line = "SOMETHING ELSE";
  await state.load();
  await settle();
  expect(state.composer()).toBeUndefined();
  expect(state.store.comments[0]).toMatchObject({ body: "first thought", excerpt: ["TWO"] });

  state.compose({ file: "b.md", side: "additions", start: 1, end: 1 });
  state.setComposerText("second");
  state.compose(globalTarget);
  await settle();
  expect(state.store.comments.map((comment) => comment.body)).toEqual(["first thought", "second"]);
});

const editor = () => document.querySelector<HTMLTextAreaElement>(".composer textarea");
const listed = () => [...document.querySelectorAll(".comment-body")].map((e) => e.textContent);
const button = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].find(
    (e) => e.textContent!.trim() === text || e.title === text,
  )!;

test("every way out of the editor keeps the text, and an empty one leaves nothing", async () => {
  await settle();
  for (const leave of [
    () => press(editor()!, "Escape"),
    () => press(editor()!, "Enter", mod),
    () => click($(".composer [type=submit]")),
  ]) {
    await click(button("Global comment"));
    state.setComposerText("keep me");
    await settle();
    await leave();
    expect(listed()).toEqual(["keep me"]);
    expect(editor()).toBeNull();
    state.deleteComments(state.store.comments.map((comment) => comment.id));
    await settle();
  }
  await click(button("Global comment"));
  await press(editor()!, "Escape");
  expect(editor()).toBeNull();
  expect(listed()).toEqual([]);
});

test("an input method's Escape stays in the editor", async () => {
  state.compose(globalTarget);
  state.setComposerText("か");
  await settle();
  await press(editor()!, "Escape", { isComposing: true });
  expect(editor()).not.toBeNull();
});

test("what is deleted, discarded or emptied can be put back", async () => {
  state.saveComment(globalTarget, "first");
  await settle();
  const undo = async () => {
    await click(button("Undo"));
    expect(listed()).toEqual(["first"]);
  };
  await click($(".comment-card .note-delete"));
  expect(listed()).toEqual([]);
  await undo();

  await click($(".comment-item"));
  expect(editor()!.value).toBe("first");
  state.setComposerText("");
  await settle();
  await press(editor()!, "Escape");
  expect(listed()).toEqual([]);
  await undo();

  await click(button("Global comment"));
  state.setComposerText("never mind");
  await settle();
  await click(button("Discard"));
  expect(listed()).toEqual(["first"]);
  await click(button("Undo"));
  expect(listed()).toEqual(["first", "never mind"]);
});

test("comments are listed as the diff has them, and each opens where it can be read", async () => {
  state.saveComment({ file: "a.ts", side: "additions", start: 2, end: 2 }, "on a line");
  state.saveComment({ file: "b.md", side: "additions", start: 1, end: 1 }, "in the next file");
  state.saveComment(wholeFile("a.ts"), "on the file");
  state.saveComment(globalTarget, "global");
  await settle();
  expect(listed()).toEqual(["global", "on the file", "on a line", "in the next file"]);

  // Once its lines change, a comment goes above its file's first.
  const line2 = state.store.comments.find((comment) => comment.body === "on a line")!;
  expect(state.lineOf(line2)).toBe(2);
  line = "OTHER";
  await state.load();
  await settle();
  expect(state.lineOf(line2)).toBe(0);
  expect($(".comments-panel").textContent).toContain("lines changed");
  const item = (text: string) =>
    [...document.querySelectorAll<HTMLElement>(".comment-item")].find((e) => e.textContent!.includes(text))!;
  calls.length = 0;
  await click(item("on a line"));
  expect(calls).toContain("scrollToFile");
  expect(calls).not.toContain("scrollToLine");
  await click(item("in the next file"));
  expect(calls).toContain("scrollToLine");
  expect(editor()).toBeNull();

  // One the diff has no place for is edited in the list.
  state.setHiddenKinds(new Set(["docs"] as const));
  await settle();
  await click(item("in the next file"));
  expect(editor()!.closest(".comments-panel")).not.toBeNull();
  expect(editor()!.value).toBe("in the next file");
});

test("a comment on a file or a global one survives a refresh while it is written", async () => {
  for (const target of [wholeFile("a.ts"), globalTarget]) {
    state.compose(target);
    state.setComposerText("still typing");
    line = line === "TWO" ? "OTHER" : "TWO";
    await state.load();
    await settle();
    expect(state.composer()).toMatchObject({ file: target.file, start: 0 });
    expect(state.composerText()).toBe("still typing");
    state.cancelComposer();
  }
});

test("a comment is drawn only where its lines still read the same", async () => {
  const { isShown } = await import("../state.ts");
  state.saveComment({ file: "a.ts", side: "additions", start: 2, end: 2 }, "why?");
  await settle();
  const comment = () => state.store.comments[0]!;
  expect(isShown(state.fileByName("a.ts"), comment())).toBe(true);
  line = "OTHER";
  await state.load();
  await settle();
  expect(isShown(state.fileByName("a.ts"), comment())).toBe(false);
});

test("a viewed mark lasts only as long as the file's changes", async () => {
  expect(state.toggleViewed("a.ts")).toBe(true);
  await state.load();
  await settle();
  expect(state.isViewed("a.ts")).toBe(true);
  line = "CHANGED AGAIN";
  await state.load();
  await settle();
  expect(state.isViewed("a.ts")).toBe(false);
  line = "TWO";
  await state.load();
  await settle();
  expect(state.isViewed("a.ts")).toBe(true);
});

test("a send that failed says so, offers a copy, and keeps the review", async () => {
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  close.mockClear();
  state.saveComment(globalTarget, "hello");
  await settle();
  const working = fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
    url === "/api/submit" ? new Response("{}", { status: 500 }) : working(url, init),
  );
  await key("Enter", mod);
  await settle();
  expect(document.querySelector(".toast")!.textContent).toContain("Copy feedback");
  expect(state.store.submitted).toBe(false);
  expect(state.store.comments.map((comment) => comment.body)).toContain("hello");
  expect(close).not.toHaveBeenCalled();
  state.deleteComments(state.store.comments.map((comment) => comment.id));
  await settle();
});

test("the tab keeps a run's comments over a reload, asks before losing them, and forgets them once sent", async () => {
  const asks = () => {
    const event = new Event("beforeunload", { cancelable: true });
    dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(asks()).toBe(false);
  sessionStorage.setItem("patch:older", "{}");
  state.saveComment(globalTarget, "hello");
  await settle();
  expect(asks()).toBe(true);
  expect(JSON.parse(sessionStorage.getItem("patch:run1")!).comments[0].body).toBe("hello");

  vi.spyOn(window, "close").mockImplementation(() => {});
  state.compose(globalTarget);
  state.setComposerText("and one more thing");
  flush();
  await key("Enter", mod);
  await settle();
  expect(window.close).toHaveBeenCalledOnce();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({
    comments: [{ body: "hello" }, { body: "and one more thing" }],
  });
  expect(sessionStorage.getItem("patch:run1")).toBeNull();
  expect(asks()).toBe(false);
});
