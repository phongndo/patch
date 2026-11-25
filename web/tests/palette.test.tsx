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
vi.mock("../Tree.tsx", () => ({ Tree: () => <div class="tree" /> }));

const { App } = await import("../App.tsx");
const { actionNames, definitionOf } = await import("../commands.ts");
const { preferences, defaults } = await import("../settings.ts");
const { state, wholeChange, wholeFile } = await import("../state.ts");
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
const submitted: unknown[] = [];

beforeEach(async () => {
  calls.length = 0;
  submitted.length = 0;
  line = "TWO";
  sessionStorage.clear();
  ui.setPalette(undefined);
  ui.setSettingsOpen(false);
  ui.setScopeOpen(false);
  ui.setFilterOpen(false);
  ui.setSidebarView("files");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/submit") submitted.push(JSON.parse(String(init?.body)));
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
  state.saveComment(wholeChange, "rename the widget");
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
  state.compose(wholeChange);
  state.setComposerText("hello");
  ui.setSidebarView("comments");
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
  state.compose(wholeChange);
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
  ui.setSidebarView("comments");
  await settle();
  for (const leave of [
    () => press(editor()!, "Escape"),
    () => press(editor()!, "Enter", mod),
    () => click($(".composer [type=submit]")),
  ]) {
    await click(button("Overall comment"));
    state.setComposerText("keep me");
    await settle();
    await leave();
    expect(listed()).toEqual(["keep me"]);
    expect(editor()).toBeNull();
    state.deleteComments(state.store.comments.map((comment) => comment.id));
    await settle();
  }
  await click(button("Overall comment"));
  await press(editor()!, "Escape");
  expect(editor()).toBeNull();
  expect(listed()).toEqual([]);
});

test("an input method's Escape stays in the editor", async () => {
  ui.setSidebarView("comments");
  state.compose(wholeChange);
  state.setComposerText("か");
  await settle();
  await press(editor()!, "Escape", { isComposing: true });
  expect(editor()).not.toBeNull();
});

test("what is deleted, discarded or emptied can be put back", async () => {
  ui.setSidebarView("comments");
  state.saveComment(wholeChange, "first");
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

  await click(button("Overall comment"));
  state.setComposerText("never mind");
  await settle();
  await click(button("Discard"));
  expect(listed()).toEqual(["first"]);
  await click(button("Undo"));
  expect(listed()).toEqual(["first", "never mind"]);
});

test("comments are listed as the diff has them, and each opens where it can be read", async () => {
  ui.setSidebarView("comments");
  state.saveComment({ file: "a.ts", side: "additions", start: 2, end: 2 }, "on a line");
  state.saveComment({ file: "b.md", side: "additions", start: 1, end: 1 }, "in the next file");
  state.saveComment(wholeFile("a.ts"), "on the file");
  state.saveComment(wholeChange, "overall");
  await settle();
  expect(listed()).toEqual(["overall", "on the file", "on a line", "in the next file"]);

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

test("a comment on a file or the whole change survives a refresh while it is written", async () => {
  for (const target of [wholeFile("a.ts"), wholeChange]) {
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
  state.saveComment(wholeChange, "hello");
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
  state.saveComment(wholeChange, "hello");
  await settle();
  expect(asks()).toBe(true);
  expect(JSON.parse(sessionStorage.getItem("patch:run1")!).comments[0].body).toBe("hello");

  vi.spyOn(window, "close").mockImplementation(() => {});
  state.compose(wholeChange);
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
