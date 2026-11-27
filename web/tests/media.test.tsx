import { parsePatchFiles } from "@pierre/diffs";
import { expect, test, vi } from "vitest";
import { renderMarkdownNow as renderMarkdown } from "../markdown.ts";
import { previewPanes, previewPlaces, previewToggles } from "../media.ts";
import { withRecordedPaths } from "../state.ts";

const files = (patch: string) => parsePatchFiles(patch).flatMap((parsed) => parsed.files);
const panes = (patch: string) =>
  files(patch).map((file) => previewPanes(file).map(({ side, path, label }) => `${side}:${path}:${label}`));

test("an image shows the sides it has, and a file without a preview none", () => {
  const patch = [
    "diff --git a/logo.png b/logo.png",
    "index 38ed7ed..fc40ece 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/new.png b/new.png",
    "new file mode 100644",
    "index 0000000..abb43db",
    "Binary files /dev/null and b/new.png differ",
    "diff --git a/old.png b/renamed.png",
    "similarity index 100%",
    "rename from old.png",
    "rename to renamed.png",
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  expect(panes(patch)).toEqual([
    ["old:logo.png:Before", "new:logo.png:After"],
    ["new:new.png:Added"],
    ["new:renamed.png:Renamed"],
    [],
  ]);
  // Without code to show instead, an image's preview is no choice.
  expect(files(patch).map(previewToggles)).toEqual([false, false, false, false]);
  // Only renamed, it is one image across the whole diff, as a new file is, in either layout.
  const renamed = files(patch)[2]!;
  expect(previewPlaces(renamed)).toEqual([{ side: "additions" }]);
});

test("SVG and Markdown have code, so their preview is a toggle", () => {
  const changed = (name: string) =>
    [
      `diff --git a/${name} b/${name}`,
      "index 1111111..2222222 100644",
      `--- a/${name}`,
      `+++ b/${name}`,
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
  for (const name of ["icon.svg", "README.md"]) {
    const [file] = files(changed(name));
    expect(previewPanes(file!).map((pane) => pane.label)).toEqual(["Before", "After"]);
    expect(previewToggles(file!)).toBe(true);
    // Before over the old lines and after over the new: side by side when split, stacked when
    // unified, as the lines are.
    expect(previewPlaces(file!)).toEqual([
      { side: "deletions", pane: "old" },
      { side: "additions", pane: "new" },
    ]);
  }
});

test("a file with one side has one preview, on that side", () => {
  const [gone] = files(
    [
      "diff --git a/x.png b/x.png",
      "deleted file mode 100644",
      "Binary files a/x.png and /dev/null differ",
      "",
    ].join("\n"),
  );
  expect(previewPlaces(gone!)).toEqual([{ side: "deletions" }]);
});

test("Markdown renders, and nothing in it runs or reaches outside the page", () => {
  const html = renderMarkdown(
    [
      "# Title",
      "",
      "A [link](https://example.com), a [relative](docs/x.md) and a [bad](javascript:alert(1)) one.",
      "",
      '<script>alert(1)</script><img src="https://evil.test/t.png" alt="tracker" onerror="alert(1)">',
      '<iframe src="https://evil.test"></iframe><div style="background:url(https://evil.test)">x</div>',
      '<p class="overlay toast">y</p><video poster="https://evil.test/p.png"></video><input type="text">',
      '<svg><image href="https://evil.test/i.png"/></svg><form action="https://evil.test"><button>z</button></form>',
      "",
      "- [x] done",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n"),
  );
  const page = document.createElement("div");
  page.innerHTML = html;
  expect(page.querySelector("h1")?.textContent).toBe("Title");
  expect(page.querySelector("table")).not.toBeNull();
  const links = [...page.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href"), a.target]);
  expect(links).toEqual([
    ["link", "https://example.com", "_blank"],
    ["relative", null, ""],
    ["bad", null, ""],
  ]);
  expect(
    page.querySelector("script, iframe, video, svg, image, form, button, [style], [onerror], [class]"),
  ).toBeNull();
  // Nothing is a control: a task's box is shown as it was ticked.
  expect(page.querySelector("input")).toBeNull();
  expect(page.textContent).toContain("☑ done");
  expect(page.querySelector("img")?.hasAttribute("src")).toBe(false);
  expect(page.querySelector("img")?.alt).toBe("tracker");
});

test("a diff that holds both files whole offers no more lines; one that may not, does", async () => {
  const { completeWhole } = await import("../state.ts");
  const file = (lines: string[]) => files(lines.join("\n") + "\n")[0]!;
  // Every line, from the first to the end: the last hunk ends on fewer than three context lines.
  const whole = completeWhole(
    file([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
    ]),
  );
  expect(whole.isPartial).toBe(false);
  expect(whole.additionLines.join("")).toBe("one\nTWO\nthree\n");
  expect(whole.deletionLines.join("")).toBe("one\ntwo\nthree\n");
  // Three lines of context after the change: the file may go on.
  const tail = completeWhole(
    file([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,4 +1,4 @@",
      "-one",
      "+ONE",
      " two",
      " three",
      " four",
    ]),
  );
  expect(tail.isPartial).toBe(true);
  // Not from the first line: what came before is not in the patch.
  const later = completeWhole(
    file([
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -5,2 +5,2 @@",
      " five",
      "-six",
      "+SIX",
    ]),
  );
  expect(later.isPartial).toBe(true);
});

test("a small change in a large file opens; a large diff starts folded", async () => {
  const { opensCollapsed } = await import("../state.ts");
  const header = ["diff --git a/big.ts b/big.ts", "--- a/big.ts", "+++ b/big.ts"];
  // One line changed at line 1,990 of a long file: the diff shows a handful of lines.
  const small = files(
    [...header, "@@ -1987,7 +1987,7 @@", " a", " b", " c", "-d", "+D", " e", " f", " g", ""].join("\n"),
  )[0]!;
  expect(opensCollapsed(small)).toBe(false);
  expect(opensCollapsed({ ...small, name: "schema.gen.ts" })).toBe(true);
  expect(opensCollapsed({ ...small, name: "schema.gen.ts" }, false)).toBe(false);
  // Two thousand lines added: the diff itself is large.
  const added = [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,2000 @@",
  ];
  for (let n = 1; n <= 2000; n++) added.push(`+line ${n}`);
  expect(opensCollapsed(files(added.join("\n") + "\n")[0]!)).toBe(true);
});

test("a binary file is named as Git recorded it, not as its header line splits", () => {
  const [file] = files(
    [
      "diff --git a/x and b/y.png b/x and b/y.png",
      "index 2e5eb1a..d13ec87 100644",
      "Binary files a/x and b/y.png and b/x and b/y.png differ",
      "",
    ].join("\n"),
  );
  expect(file!.name).not.toBe("x and b/y.png"); // What the parser makes of it.
  const named = withRecordedPaths(file!, { old: "x and b/y.png", new: "x and b/y.png" });
  expect([named.name, named.prevName]).toEqual(["x and b/y.png", undefined]);
  expect(previewPanes(named).map((pane) => pane.path)).toEqual(["x and b/y.png", "x and b/y.png"]);
});

test("a file whose preview has only its old side shows it, and its whole-file notes, on that side", () => {
  // An SVG renamed to text and changed: only the old side is an image.
  const [file] = files(
    [
      "diff --git a/old.svg b/new.txt",
      "similarity index 80%",
      "rename from old.svg",
      "rename to new.txt",
      "index 1111111..2222222 100644",
      "--- a/old.svg",
      "+++ b/new.txt",
      "@@ -1 +1 @@",
      "-<svg/>",
      "+text",
      "",
    ].join("\n"),
  );
  expect(previewPanes(file!).map(({ side, path }) => `${side}:${path}`)).toEqual(["old:old.svg"]);
  expect(previewPlaces(file!)).toEqual([{ side: "deletions" }]);
});

test("a document the renderer does not finish is given up on, and its renderer stopped", async () => {
  const { renderMarkdown } = await import("../markdown.ts");
  // A renderer that never answers, as one all but hung on a document would.
  let stopped = false;
  vi.stubGlobal(
    "Worker",
    class {
      onmessage = null;
      onerror = null;
      postMessage() {}
      terminate() {
        stopped = true;
      }
    },
  );
  vi.useFakeTimers();
  try {
    const rendered = renderMarkdown("- a");
    const failed = expect(rendered).rejects.toThrow("too long to render");
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    expect(stopped).toBe(true);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
