import { flush } from "solid-js";
import { beforeEach, expect, test, vi } from "vitest";
import { $, click, mount, named, nameOf, press, settle, type } from "./dom.tsx";

vi.mock("../diff.ts", () => ({
  createDiffView: () =>
    new Proxy({}, { get: () => () => undefined }) as unknown as import("../diff.ts").DiffView,
}));
vi.mock("../Tree.tsx", () => ({ Tree: () => <div class="tree" /> }));

const { App } = await import("../App.tsx");
const { state } = await import("../state.ts");
const { toast } = await import("@ui-sdk/solid/toast");

const pull = { number: 7, title: "Fix it", author: "ann", head: "fix", base: "main", draft: false };
const asked: string[] = [];

beforeEach(async () => {
  asked.length = 0;
  toast.dismiss();
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    const body = url.startsWith("/api/scopes")
      ? { branches: ["main", "dev", "feature"], base: "main", since: "main", commits: [] }
      : url.startsWith("/api/prs")
        ? [pull]
        : { error: "none" };
    return new Response(JSON.stringify(body), { status: "error" in body ? 500 : 200 });
  });
  mount(() => <App />);
  await settle();
});

const write = async (body: string) => {
  state.saveGeneral(body);
  flush();
  await settle();
};
const clear = async () => {
  state.deleteComments(state.store.comments.map((comment) => comment.id));
  await settle();
};
const finish = () =>
  [...document.querySelectorAll("button")].find((e) => e.textContent?.startsWith("Finish"))!;

test("Finish focuses Approve with nothing written, and only Send feedback with comments", async () => {
  await clear();
  const focused: string[] = [];
  document.addEventListener("focusin", (event) => {
    const button = (event.target as HTMLElement).closest(".finish button");
    if (button) focused.push(button.textContent!.trim());
  });
  await click(finish());
  expect(focused).toEqual(["Approve"]);
  await press(document.activeElement!, "Escape");
  expect(document.activeElement).toBe(finish());

  await write("hello");
  focused.length = 0;
  await click(finish());
  expect(focused).toEqual(["Send feedback"]);
  await press(document.activeElement!, "Escape");
  await clear();
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

test("the sidebar's views are tabs, and the file list stays mounted", async () => {
  const files = named("tab", "Files");
  const comments = named("tab", "Comments");
  const tree = $(".tree");
  expect(files.getAttribute("aria-selected")).toBe("true");
  expect($(".side-body").tabIndex).toBe(-1);
  files.focus();
  await press(files, "ArrowRight");
  expect(comments.getAttribute("aria-selected")).toBe("true");
  expect($(".comments-panel")).toBeTruthy();
  await press(comments, "ArrowLeft");
  expect($(".tree")).toBe(tree);
  expect(document.querySelector(".comments-panel")).toBeNull();
});

test("the scope picker is named, and its branches filter and choose from the keyboard", async () => {
  await click($(".scope-trigger"));
  expect(nameOf($(".scope-menu"))).toBe("Choose what to review");
  const search = named("combobox", "Find a branch to compare against") as HTMLInputElement;
  const options = () =>
    [...document.querySelectorAll('.scope-menu [role="option"]')].map((e) => e.textContent);
  expect(options()).toEqual(["main", "dev", "feature"]);
  expect($('.scope-menu [role="option"][aria-current="true"]').textContent).toBe("main");
  expect(document.querySelector(".scope-menu [data-highlighted]")).toBeNull();
  await type(search, "fea");
  expect(options()).toEqual(["feature"]);
  await press(search, "Enter");
  expect(asked).toContain("/api/review?scope=all&base=feature");
  expect(document.querySelector(".scope-menu[data-open]")).toBeNull();
});

test("its tabs load pull requests when shown, and one can be chosen", async () => {
  await click($(".scope-trigger"));
  await click(named("tab", "Pull requests"));
  await settle(320);
  await click($('.scope-menu [role="option"]'));
  expect(asked).toContain("/api/review?scope=pr&pr=7");
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

test("the resizer is a named separator for the sidebar", () => {
  const resizer = named("separator", "Resize the sidebar");
  expect(document.getElementById(resizer.getAttribute("aria-controls")!)?.tagName).toBe("ASIDE");
});
