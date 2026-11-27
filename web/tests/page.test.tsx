import { flush } from "solid-js";
import { beforeEach, expect, test, vi } from "vitest";
import type { ReviewResponse } from "../../src/protocol.ts";
import { $, click, mount, named, nameOf, press, settle, type } from "./dom.tsx";

vi.mock("../diff.ts", () => ({
  createDiffView: () =>
    new Proxy({}, { get: () => () => undefined }) as unknown as import("../diff.ts").DiffView,
}));
vi.mock("../Tree.tsx", () => ({ Tree: () => <div class="tree" />, treeStatus: () => [] }));

const { App } = await import("../App.tsx");
const { state, globalTarget } = await import("../state.ts");
const { preferences } = await import("../settings.ts");
const { setScopeOpen } = await import("../ui.ts");
const { toast } = await import("@ui-sdk/solid/toast");

const pull = {
  number: 7,
  title: "Fix it",
  author: "ann",
  head: "fix",
  base: "main",
  draft: false,
  state: "open",
};
const commits = [
  { sha: "c3", short: "c3", subject: "third", author: "ann", when: "now" },
  { sha: "c2", short: "c2", subject: "second", author: "ann", when: "now" },
  { sha: "c1", short: "c1", subject: "first", author: "ann", when: "now" },
];
const asked: string[] = [];
let reviewed: Partial<ReviewResponse> | undefined;
/** The history `/api/commits` pages through, and how many commits a page holds. */
let history = commits;
let pageSize = 100;

/** A page of the history, or of what a search finds in it, as the server answers. */
function commitPage(url: string) {
  const params = new URL(url, "http://patch").searchParams;
  const at = Number(params.get("after") ?? 0);
  const query = (params.get("q") ?? "").toLowerCase();
  const list = history.filter((commit) =>
    `${commit.sha} ${commit.subject} ${commit.author}`.toLowerCase().includes(query),
  );
  const next = at + pageSize < list.length ? String(at + pageSize) : undefined;
  return { commits: list.slice(at, at + pageSize), ...(next ? { next } : {}) };
}

beforeEach(async () => {
  asked.length = 0;
  reviewed = undefined;
  history = commits;
  pageSize = 100;
  setScopeOpen(false);
  toast.dismiss();
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    const body = url.startsWith("/api/scopes")
      ? { branches: ["main", "dev", "feature"], base: "main" }
      : url.startsWith("/api/commits")
        ? commitPage(url)
        : url.startsWith("/api/prs")
          ? { pulls: [pull] }
          : reviewed && url.startsWith("/api/review")
            ? { repository: "demo", branch: "feature", scopeKey: "k", patch: "", session: "run", ...reviewed }
            : { error: "none" };
    return new Response(JSON.stringify(body), { status: "error" in body ? 500 : 200 });
  });
  mount(() => <App />);
  await settle();
});

const write = async (body: string) => {
  state.saveComment(globalTarget, body);
  flush();
  await settle();
};
const clear = async () => {
  state.deleteComments(state.store.comments.map((comment) => comment.id));
  await settle();
};
const finish = () =>
  [...document.querySelectorAll("button")].find((e) => e.textContent?.startsWith("Finish"))!;

test("Finish needs changes to pass or something to send, and counts comments", async () => {
  await clear();
  // There are no files here: nothing to pass.
  expect(finish().disabled).toBe(true);
  await write("hello");
  expect(finish().disabled).toBe(false);
  expect(finish().querySelector(".count")!.textContent).toBe("1");
  await clear();
  expect(finish().disabled).toBe(true);
});

test("Refresh is offered only once the repository changed", async () => {
  const refresh = () =>
    [...document.querySelectorAll(".bar button")].find((e) => e.textContent === "Refresh");
  expect(refresh()).toBeUndefined();
  (globalThis.EventSource as unknown as { last: EventTarget }).last.dispatchEvent(new Event("changed"));
  await settle();
  asked.length = 0;
  await click(refresh() as HTMLElement);
  expect(asked.some((url) => url.startsWith("/api/review"))).toBe(true);
  expect(refresh()).toBeUndefined();
});

test("the totals open from a press and are named", async () => {
  await click($(".summary"));
  expect(nameOf($(".breakdown[data-open]"))).toBe("Changed lines");
  await press(document.activeElement!, "Escape");
  expect(document.querySelector(".breakdown[data-open]")).toBeNull();
});

test("the files and the comments sit side by side, and the comments can be hidden", async () => {
  expect($(".sidebar .side-body")).toBeTruthy();
  expect($(".comments-side .comments-panel")).toBeTruthy();
  expect($(".side-body").tabIndex).toBe(-1);
  await click($('.bar [aria-pressed="true"]'));
  expect($(".app").classList.contains("no-comments")).toBe(true);
  await click($('.bar [aria-pressed="false"]'));
  expect($(".app").classList.contains("no-comments")).toBe(false);
});

const picker = async () => {
  if (!document.querySelector(".scope-menu[data-open]")) await click($(".scope-trigger"));
  await settle();
  return $<HTMLInputElement>(".scope-menu input");
};
const rows = () => [...document.querySelectorAll<HTMLElement>('.scope-menu[data-open] [role="option"]')];
const labels = () => rows().map((row) => row.querySelector(".palette-label")!.textContent);
const highlighted = () =>
  document.querySelector(".scope-menu [data-highlighted] .palette-label")?.textContent;
const checked = () =>
  rows()
    .filter((row) => row.getAttribute("aria-current") === "true")
    .map((row) => row.querySelector(".palette-label")!.textContent);
const shownTab = () => $('.scope-menu [role="tab"][aria-selected="true"]').textContent!.trim();
const isOpen = () => document.querySelector(".scope-menu[data-open]") !== null;

test("the scope picker is named, opens on its search, and lists each thing to review once", async () => {
  const search = await picker();
  expect(nameOf($(".scope-menu"))).toBe("Choose what to review");
  expect(document.activeElement).toBe(search);
  expect(nameOf(search)).toBe("Search views and branches");
  // Main is what Branch compares against already.
  expect(labels()).toEqual(["Branch", "Uncommitted", "Staged", "dev", "feature"]);
  expect(rows()[0]!.querySelector(".palette-detail")!.textContent).toBe("vs main");
  expect(highlighted()).toBe("Branch");
  await type(search, "fea");
  expect(labels()).toEqual(["feature"]);
  await press(search, "Enter");
  expect(asked).toContain("/api/review?scope=all&base=feature");
  expect(isOpen()).toBe(false);
});

test("its views are found by name and chosen from the keyboard", async () => {
  await type(await picker(), "un");
  await press($(".scope-menu input"), "Enter");
  expect(asked).toContain("/api/review?scope=uncommitted");
});

test("the arrows switch its tabs only while nothing is typed, and the field keeps focus", async () => {
  const search = await picker();
  await press(search, "ArrowRight");
  expect(shownTab()).toBe("Commits");
  expect(labels()).toEqual(["third", "second", "first"]);
  await press(search, "ArrowRight");
  expect(shownTab()).toBe("Pull requests");
  await press(search, "ArrowRight");
  expect(shownTab()).toBe("Changes");
  await type(search, "fea");
  expect((await press(search, "ArrowRight")).defaultPrevented).toBe(false);
  expect(shownTab()).toBe("Changes");
  expect(document.activeElement).toBe(search);
});

test("Shift with Enter starts a run of commits, Escape drops it, and Enter reviews it", async () => {
  const search = await picker();
  await press(search, "ArrowRight");
  await press(search, "Enter", { shiftKey: true });
  expect(isOpen()).toBe(true);
  expect(checked()).toEqual(["third"]);
  await press(search, "Escape");
  expect(isOpen()).toBe(true);
  expect(checked()).toEqual([]);
  await press(search, "Enter", { shiftKey: true });
  await press(search, "ArrowDown");
  await press(search, "ArrowDown");
  expect($(".scope-menu .palette-foot").textContent).toContain("review 3 commits");
  await press(search, "Enter");
  expect(asked).toContain("/api/review?scope=commits&from=c1&to=c3");
  expect(isOpen()).toBe(false);
});

test("it opens on the tab of what is under review, and Shift-click extends from that commit", async () => {
  reviewed = { scope: { kind: "commits", from: "c3", to: "c3" }, label: "Commit c3" };
  await state.load();
  await picker();
  expect(shownTab()).toBe("Commits");
  expect(checked()).toEqual(["third"]);
  expect(highlighted()).toBe("third");
  rows()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
  await settle();
  expect(asked).toContain("/api/review?scope=commits&from=c2&to=c3");
});

test("a chosen base is what it compares against, and stays so while another view is reviewed", async () => {
  reviewed = { scope: { kind: "all", base: "dev" }, base: "dev", label: "feature vs dev", branch: "feature" };
  await state.load();
  await picker();
  expect(checked()).toEqual(["Branch"]);
  expect(rows()[0]!.querySelector(".palette-detail")!.textContent).toBe("vs dev");
  expect(labels()).toEqual(["Branch", "Uncommitted", "Staged", "main"]);
  reviewed = { scope: { kind: "staged" }, label: "feature · staged", branch: "feature" };
  await state.load();
  await settle();
  expect(checked()).toEqual(["Staged"]);
  await click(rows()[0]!);
  expect(asked).toContain("/api/review?scope=all&base=dev");
});

test("its key opens and closes it, also while typing, and a view's own key works inside it", async () => {
  const toggle = () => press(document.activeElement ?? document.body, "o", { code: "KeyO", ctrlKey: true });
  $<HTMLInputElement>(".side-search").focus();
  expect((await toggle()).defaultPrevented).toBe(true);
  expect(isOpen()).toBe(true);
  await toggle();
  expect(isOpen()).toBe(false);
  preferences.bind("reviewStaged", "Alt+S");
  await toggle();
  expect(rows()[2]!.querySelector("kbd")!.textContent).toBe("Alt+S");
  await press($(".scope-menu input"), "s", { code: "KeyS", altKey: true });
  expect(asked).toContain("/api/review?scope=staged");
  preferences.bind("reviewStaged", undefined);
});

test("commits come a page at a time: arrowing to the last asks for the next, until the first commit", async () => {
  pageSize = 2;
  const search = await picker();
  await press(search, "ArrowRight");
  expect(labels()).toEqual(["third", "second"]);
  expect(named("button", "Load more")).toBeTruthy();
  await press(search, "ArrowDown");
  await settle();
  expect(labels()).toEqual(["third", "second", "first"]);
  expect(asked).toContain("/api/commits?q=&after=2");
  expect($(".scope-menu .menu-more").textContent).toBe("The first commit.");
});

test("the commit under review is highlighted once its page arrives, not the newest", async () => {
  reviewed = { scope: { kind: "commits", from: "c2", to: "c2" }, label: "Commit c2" };
  await state.load();
  await picker();
  expect(checked()).toEqual(["second"]);
  expect(highlighted()).toBe("second");
  await press($(".scope-menu input"), "Escape");
  // The tests after it start on the branch.
  reviewed = { scope: { kind: "all" }, label: "feature" };
  await state.load();
  await settle();
});

test("each opening lists commits afresh, also on a tab shown in an earlier one", async () => {
  const search = await picker();
  await press(search, "ArrowRight");
  expect(labels()).toEqual(["third", "second", "first"]);
  await press(search, "Escape");
  expect(isOpen()).toBe(false);
  history = [{ sha: "c4", short: "c4", subject: "fourth", author: "ann", when: "now" }, ...commits];
  asked.length = 0;
  await press(await picker(), "ArrowRight");
  expect(asked).toContain("/api/commits?q=");
  expect(labels()).toEqual(["fourth", "third", "second", "first"]);
});

test("a run whose first end a search no longer lists is still reviewed, by both its ends", async () => {
  const search = await picker();
  await press(search, "ArrowRight");
  await press(search, "Enter", { shiftKey: true });
  expect(checked()).toEqual(["third"]);
  await type(search, "first");
  await settle(260);
  expect(labels()).toEqual(["first"]);
  await press(search, "Enter");
  expect(asked).toContain("/api/review?scope=commits&from=c3&to=c1");
  expect(isOpen()).toBe(false);
});

test("scrolling the list to its end asks for the next page, once", async () => {
  pageSize = 2;
  const search = await picker();
  await press(search, "ArrowRight");
  expect(labels()).toEqual(["third", "second"]);
  asked.length = 0;
  // The panel scrolls, not the list in it. Nothing is laid out here, so it is always at its end.
  const panel = $(".scope-panel");
  panel.dispatchEvent(new Event("scroll"));
  panel.dispatchEvent(new Event("scroll"));
  await settle();
  expect(asked.filter((url) => url.startsWith("/api/commits"))).toEqual(["/api/commits?q=&after=2"]);
  expect(labels()).toEqual(["third", "second", "first"]);
});

test("the button loads more too, and a run of commits can span the pages", async () => {
  pageSize = 2;
  const search = await picker();
  await press(search, "ArrowRight");
  expect(labels()).toEqual(["third", "second"]);
  await click(named("button", "Load more"));
  await settle();
  expect(labels()).toEqual(["third", "second", "first"]);
  await press(search, "Enter", { shiftKey: true });
  await press(search, "ArrowDown");
  await press(search, "ArrowDown");
  await press(search, "Enter");
  expect(asked).toContain("/api/review?scope=commits&from=c1&to=c3");
});

test("a search of commits is the server's: all it finds, in its order, even what the label lacks", async () => {
  history = [...commits, { sha: "beef", short: "beef", subject: "fourth", author: "bob", when: "then" }];
  pageSize = 3;
  const search = await picker();
  await press(search, "ArrowRight");
  await type(search, "bob");
  // Until the server answers, nothing the last list had is offered for it.
  expect(labels()).toEqual([]);
  await settle(260);
  expect(asked).toContain("/api/commits?q=bob");
  expect(labels()).toEqual(["fourth"]);
  expect($(".scope-menu .menu-label").textContent).toBe("Found in the history of feature");
});

test("the palette's commit and pull request commands open the picker on their tab", async () => {
  await press(document.body, "k", { code: "KeyK", ctrlKey: true });
  await type(named("combobox", "Search commands") as HTMLInputElement, "review a commit");
  await press(named("combobox", "Search commands"), "Enter");
  await settle();
  expect(isOpen()).toBe(true);
  expect(shownTab()).toBe("Commits");
  expect(labels()).toEqual(["third", "second", "first"]);
  await press($(".scope-menu input"), "Escape");
});

test("pull requests load when shown, and one can be chosen", async () => {
  await picker();
  await click(named("tab", "Pull requests"));
  await settle();
  expect(asked).toContain("/api/prs?q=");
  await click(rows()[0]!);
  expect(asked).toContain("/api/review?scope=pr&pr=7");
});

test("until GitHub answers a search, only pull requests that match are offered", async () => {
  await picker();
  await click(named("tab", "Pull requests"));
  await settle();
  const search = $<HTMLInputElement>(".scope-menu input");
  await type(search, "zzzz");
  expect(labels()).toEqual([]);
  await press(search, "Enter");
  expect(isOpen()).toBe(true);
  // GitHub searches more than the title.
  await settle(320);
  expect(labels()).toEqual(["Fix it"]);
});

test("losing the connection shows one toast that Escape can't dismiss", async () => {
  const source = (globalThis.EventSource as unknown as { last: { readyState: number; onerror: () => void } })
    .last;
  source.readyState = 2;
  source.onerror();
  source.onerror();
  await settle();
  const toasts = document.querySelectorAll<HTMLElement>('[data-slot="toast"]');
  expect(toasts).toHaveLength(1);
  expect(toasts[0]!.textContent).toContain("Patch stopped");
  expect(toasts[0]!.textContent).toContain("Copy feedback");
  await press(toasts[0]!, "Escape");
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1);
});

test("when Patch can't be reached, choosing what to review says so, not the browser's error", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await picker();
  await settle();
  expect($(".scope-menu .menu-error").textContent).toBe(
    "Can't reach this Patch review. Check the connection, or start a new review.",
  );
  await press(document.activeElement!, "Escape");
});

test("a page that goes for good says which it is, and whether anything is unsent", async () => {
  const sent: string[] = [];
  navigator.sendBeacon = (url) => Boolean(sent.push(String(url)));
  const hide = (persisted: boolean) => dispatchEvent(Object.assign(new Event("pagehide"), { persisted }));
  await clear();
  hide(true);
  expect(sent).toEqual([]);
  hide(false);
  await write("hello");
  hide(false);
  const page = (globalThis.EventSource as unknown as { last: { url: string } }).last.url.split("page=")[1]!;
  expect(page).toBeTruthy();
  expect(sent).toEqual([`/api/leave?page=${page}`, `/api/leave?page=${page}&unsent=1`]);
  await clear();
});

test("a stream the browser gave up on is opened again as the same page", async () => {
  const sources = globalThis.EventSource as unknown as {
    last: { url: string; readyState: number; onerror: () => void; onopen: () => void };
  };
  const first = sources.last;
  vi.useFakeTimers();
  first.readyState = 2;
  first.onerror();
  vi.advanceTimersByTime(2000);
  vi.useRealTimers();
  expect(sources.last).not.toBe(first);
  expect(sources.last.url).toBe(first.url);
  await settle();
  sources.last.onopen();
  await settle();
  expect(document.querySelector('[data-slot="toast"]:not([data-ending-style])')).toBeNull();
});

test("the resizer is a named separator for the sidebar", () => {
  const resizer = named("separator", "Resize the sidebar");
  expect(document.getElementById(resizer.getAttribute("aria-controls")!)?.tagName).toBe("ASIDE");
});

const listed = () => [...document.querySelectorAll(".comment-body")].map((body) => body.textContent);
const loaded = async () => {
  reviewed = {
    scope: { kind: "all" },
    patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
  };
  await state.load();
  await settle();
};

test("viewed binary files need review again when their contents change", async () => {
  const loadImage = async (oid: string) => {
    reviewed = {
      scope: { kind: "all" },
      patch: `diff --git a/img.png b/img.png\nindex 1111111..${oid} 100644\nBinary files a/img.png and b/img.png differ\n`,
    };
    await state.load();
    await settle();
  };
  await loadImage("2222222");
  state.toggleViewed("img.png");
  await loadImage("2222222");
  expect(state.isViewed("img.png")).toBe(true);
  await loadImage("3333333");
  expect(state.isViewed("img.png")).toBe(false);
});

test("a viewed new file needs review again when only its mode changes", async () => {
  const loadScript = async (mode: string) => {
    reviewed = {
      scope: { kind: "all" },
      patch: `diff --git a/run.sh b/run.sh\nnew file mode ${mode}\nindex 0000000..1111111\n--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1 @@\n+echo hi\n`,
    };
    await state.load();
    await settle();
  };
  await loadScript("100644");
  state.toggleViewed("run.sh");
  await loadScript("100644");
  expect(state.isViewed("run.sh")).toBe(true);
  await loadScript("100755");
  expect(state.isViewed("run.sh")).toBe(false);
});

test("panels of different widths keep them while the diff has room", async () => {
  const sidebar = named("separator", "Resize the sidebar");
  const comments = named("separator", "Resize the comments");
  try {
    const free = innerWidth - 320;
    preferences.update({ sidebarWidth: free - 230, commentsWidth: 200 });
    await settle();
    expect(Number(sidebar.getAttribute("aria-valuenow"))).toBe(free - 230);
    expect(Number(comments.getAttribute("aria-valuenow"))).toBe(200);
    expect(Number(sidebar.getAttribute("aria-valuemax"))).toBe(free - 200);
    expect(Number(comments.getAttribute("aria-valuemax"))).toBe(230);
  } finally {
    preferences.reset();
    await settle();
  }
});

test("both panels leave space for the diff when resized", async () => {
  const sidebar = named("separator", "Resize the sidebar");
  const comments = named("separator", "Resize the comments");
  try {
    await press(sidebar, "End");
    await press(comments, "End");
    const panelWidth = (element: HTMLElement) => Number(element.getAttribute("aria-valuenow"));
    expect(innerWidth - panelWidth(sidebar) - panelWidth(comments)).toBeGreaterThanOrEqual(320);
  } finally {
    preferences.reset();
    await settle();
  }
});

test("changing the saved layout updates the active review", async () => {
  try {
    preferences.update({ layout: "split" });
    await settle();
    expect(named("button", "Switch to unified")).toBeTruthy();
    preferences.update({ layout: "unified" });
    await settle();
    expect(named("button", "Switch to split")).toBeTruthy();
  } finally {
    preferences.update({ layout: "auto" });
  }
});

test("comments are searched by their text and file, apart from the files", async () => {
  await clear();
  await loaded();
  await write("Rename this");
  await write("Add a test");
  state.saveComment({ file: "src/a.ts", side: "additions", start: 1, end: 1 }, "Why?");
  await settle();
  const files = $<HTMLInputElement>(".sidebar .side-search");
  const search = $<HTMLInputElement>(".comments-search");
  await type(files, "nothing");
  expect(nameOf(search)).toBe("Search comments");
  expect(search.value).toBe("");
  expect(listed()).toEqual(["Rename this", "Add a test", "Why?"]);
  await type(search, "rename");
  expect(listed()).toEqual(["Rename this"]);
  await type(search, "SRC/A");
  expect(listed()).toEqual(["Why?"]);
  await type(search, "zzzz");
  expect(listed()).toEqual([]);
  expect($(".comments-panel .empty").textContent).toBe("No comments match.");
  expect(files.value).toBe("nothing");
  await type(files, "");
  search.focus();
  await press(search, "Escape");
  expect(listed()).toHaveLength(3);
  await clear();
  expect($(".comments-panel .empty").textContent).toContain("line number");
});

test("a page with comments reached by another run keeps them to copy, and never reads the other review", async () => {
  await loaded();
  await write("about this review");
  const source = (globalThis.EventSource as unknown as { last: EventTarget }).last;
  asked.length = 0;
  source.dispatchEvent(new MessageEvent("session", { data: "another run" }));
  await settle();
  expect(asked.some((url) => url.startsWith("/api/review"))).toBe(false);
  expect($('[data-slot="toast"]').textContent).toContain("Patch restarted for another review.");
  expect(state.store.comments.map((comment) => comment.body)).toEqual(["about this review"]);
  await clear();
});

test("a page reached by another run of Patch reads its review again, and only then", async () => {
  await loaded();
  const source = (globalThis.EventSource as unknown as { last: EventTarget }).last;
  const hello = (session: string) => source.dispatchEvent(new MessageEvent("session", { data: session }));
  asked.length = 0;
  hello("run");
  await settle();
  expect(asked.some((url) => url.startsWith("/api/review"))).toBe(false);
  hello("another run");
  await settle();
  expect(asked.some((url) => url.startsWith("/api/review"))).toBe(true);
});

test("a search never hides what is being written, and Enter opens the first found", async () => {
  await clear();
  await write("Rename this");
  await write("Add a test");
  const search = $<HTMLInputElement>(".comments-search");
  const editor = () => document.querySelector<HTMLTextAreaElement>(".comments-panel textarea");
  await type(search, "test");
  await press(search, "Enter");
  expect(editor()!.value).toBe("Add a test");
  await type(search, "zzzz");
  expect(editor()!.value).toBe("Add a test");
  await click($('[title="Global comment"]'));
  expect(search.value).toBe("");
  expect(editor()!.value).toBe("");
  state.cancelComposer();
  await clear();
});

test("the search key opens the palette searching the code", async () => {
  await press(document.body, "f", { code: "KeyF", ctrlKey: true, shiftKey: true });
  expect(named("combobox", "Search commands")).toHaveProperty("value", "/");
  await press(named("combobox", "Search commands"), "Escape");
});

// Last: the page is done after it.
test("one press finishes a review without comments, and closes", async () => {
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  await clear();
  reviewed = {
    scope: { kind: "all" },
    patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
  };
  await state.load();
  await settle();
  const sent: unknown[] = [];
  const working = fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url !== "/api/submit") return working(url, init);
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  });
  await click(finish());
  await settle();
  // Named by the run it was drawn from, which alone takes it.
  expect(sent).toEqual([{ comments: [], session: "run" }]);
  expect(close).toHaveBeenCalledOnce();
  expect(finish().disabled).toBe(true);
});
