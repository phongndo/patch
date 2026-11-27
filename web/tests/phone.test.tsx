// A phone: a touch screen too narrow for two columns. Its view is its own, never the settings
// every device shares.
import { flush } from "solid-js";
import { beforeEach, expect, test, vi } from "vitest";
import { $, click, mount, settle } from "./dom.tsx";

window.matchMedia = ((query: string) => ({
  matches: query.includes("max-width: 860px") || query.includes("hover: none"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;

vi.mock("../diff.ts", () => ({
  createDiffView: () =>
    new Proxy({}, { get: () => () => undefined }) as unknown as import("../diff.ts").DiffView,
}));
vi.mock("../Tree.tsx", () => ({ Tree: () => <div class="tree" />, treeStatus: () => [] }));

const { App } = await import("../App.tsx");
const { state, globalTarget } = await import("../state.ts");
const { palette, setPalette, setOwnComments, setOwnFiles, setOwnLayout } = await import("../ui.ts");

const saved: string[] = [];
beforeEach(async () => {
  saved.length = 0;
  setPalette(undefined);
  setOwnFiles(false);
  setOwnComments(false);
  setOwnLayout("auto");
  state.deleteComments(state.store.comments.map((comment) => comment.id));
  flush();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/settings" && init?.method === "PUT") saved.push(String(init.body));
    const body = url.startsWith("/api/review")
      ? { repository: "demo", branch: "feature", scopeKey: "k", patch: "", session: "run" }
      : { error: "none" };
    return new Response(JSON.stringify(body), { status: "error" in body ? 500 : 200 });
  });
  mount(() => <App />);
  await settle();
});

const bar = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".bar button")].find((button) =>
    (button.getAttribute("aria-label") ?? button.title).startsWith(label),
  )!;
const app = () => $(".app").classList;

test("the files, the comments and the layout are the phone's own, and saved nowhere", async () => {
  expect(app().contains("no-sidebar")).toBe(true);
  expect(app().contains("no-comments")).toBe(true);
  await click(bar("Show the sidebar"));
  expect(app().contains("no-sidebar")).toBe(false);
  // The drawers take turns: one opening closes the other.
  await click(bar("Show the comments"));
  expect(app().contains("no-comments")).toBe(false);
  expect(app().contains("no-sidebar")).toBe(true);
  await click(bar("Switch to split"));
  expect(bar("Switch to unified")).toBeTruthy();
  await settle(400);
  expect(saved).toEqual([]);
});

test("the comments say what they are, group what is about the whole change, and tell a finger what to do", async () => {
  await click(bar("Show the comments"));
  expect($(".comments-empty").textContent).toContain("Tap a line number in the diff");
  // With nothing to search, there is no search.
  expect(document.querySelector(".comments-search")).toBeNull();
  state.saveComment(globalTarget, "Looks good");
  flush();
  await settle();
  expect($(".comments-side .side-title").textContent).toBe("Comments1");
  expect($(".comment-file").textContent).toBe("Global1");
  expect($(".comments-search")).toBeTruthy();
});

test("pulling down from the bar opens the palette; a pull in the diff does not", async () => {
  const touch = (target: Element, type: string, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientY: y }] });
    target.dispatchEvent(event);
  };
  const pull = async (target: Element) => {
    touch(target, "touchstart", 20);
    for (const y of [40, 60, 80, 100]) touch(target, "touchmove", y);
    touch(target, "touchend", 100);
    await settle();
  };
  await pull($("main.diff"));
  expect(palette()).toBeUndefined();
  await pull($(".bar"));
  expect(palette()).toEqual([]);
});
