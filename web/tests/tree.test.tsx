import { expect, test } from "vitest";
import { Tree } from "../Tree.tsx";
import { mount, settle } from "./dom.tsx";

/** The rows of the tree drawn, inside the shadow root it draws them in. */
async function rows(paths: string[]) {
  mount(() => <Tree paths={paths} status={[]} expansion="open" onOpen={() => {}} />);
  await settle(50);
  const host = [...document.querySelectorAll(".tree *")].find((element) => element.shadowRoot);
  return [...(host?.shadowRoot?.querySelectorAll<HTMLElement>("[data-type=item]") ?? [])];
}

const visible = (row: HTMLElement) =>
  [...row.querySelectorAll("[data-truncate-content=visible]")].map((text) => text.textContent);

test("a name cut in the middle keeps its last word with the extension", async () => {
  const found = await rows(["test/max-backedge-taken-count-guard-info-switch.ll", "lib/ScalarEvolution.cpp"]);
  const row = (name: string) => found.find((row) => row.getAttribute("aria-label") === name)!;
  expect(visible(row("max-backedge-taken-count-guard-info-switch.ll"))).toEqual([
    "max-backedge-taken-count-guard-info-",
    "switch.ll",
  ]);
  expect(visible(row("ScalarEvolution.cpp"))).toEqual(["Scalar", "Evolution.cpp"]);
});

test("a run of four folders or more keeps its ends, the ones between one piece", async () => {
  const found = await rows(["clang/test/CodeGen/RISCV/policy/vadd.c", "llvm/lib/Analysis/a.cpp"]);
  const row = (label: string) => found.find((row) => row.getAttribute("aria-label") === label)!;
  const long = row("clang / test / CodeGen / RISCV / policy");
  expect(long.querySelector("[data-item-flattened-between]")!.textContent).toContain(
    "test / CodeGen / RISCV",
  );
  expect(visible(long)).toEqual(["clang", "test / CodeGen / RISCV", "policy"]);
  // Three are each their own, given way in order by the page's styles.
  expect(row("llvm / lib / Analysis").querySelector("[data-item-flattened-between]")).toBeNull();
});

test("a clipped row shows its whole path when the pointer comes to it, a whole one none", async () => {
  const found = await rows(["lib/Transforms/Scalar/LoopStrengthReduce.cpp", "lib/Transforms/Scalar/a.cpp"]);
  const row = (name: string) => found.find((row) => row.getAttribute("aria-label") === name)!;
  // Nothing is laid out here: the long name is made wider than its room.
  for (const text of row("LoopStrengthReduce.cpp").querySelectorAll("[data-truncate-content=visible]")) {
    Object.defineProperty(text, "scrollWidth", { value: 120 });
    Object.defineProperty(text, "clientWidth", { value: 40 });
  }
  const point = (target: HTMLElement) =>
    target.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, composed: true }));
  point(row("LoopStrengthReduce.cpp"));
  expect(row("LoopStrengthReduce.cpp").title).toBe("lib/Transforms/Scalar/LoopStrengthReduce.cpp");
  point(row("a.cpp"));
  expect(row("a.cpp").hasAttribute("title")).toBe(false);
});
