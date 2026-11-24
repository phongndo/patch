import { expect, test } from "vitest";
import { search, segments, type Searchable } from "../search.ts";

const files = [
  "web/diff.ts",
  "web/settings.ts",
  "web/SettingsDialog.tsx",
  "web/hotkeys.ts",
  "cli/src/server.rs",
  "cli/src/harness.rs",
  "cli/harness/claude/register.ts",
  "tests/contract.test.ts",
  "web/tests/settings.test.tsx",
  "README.md",
].map((label): Searchable => ({ label, path: true }));
const find = (query: string, entries: readonly Searchable[] = files) =>
  search(entries, query).map(({ entry }) => entry.label);

test("a file's name counts more than its folders", () => {
  expect(find("harness")[0]).toBe("cli/src/harness.rs");
  expect(find("set")[0]).toBe("web/settings.ts");
  expect(find("test").slice(0, 2)).toEqual(["tests/contract.test.ts", "web/tests/settings.test.tsx"]);
});

test("word starts and camel humps are found by their letters", () => {
  expect(find("sd")[0]).toBe("web/SettingsDialog.tsx");
  expect(find("diff.ts")[0]).toBe("web/diff.ts");
});

test("words match in any order and all must", () => {
  expect(find("rs server")).toEqual(["cli/src/server.rs"]);
  expect(find("claude reg")[0]).toBe("cli/harness/claude/register.ts");
  expect(find("server tsx")).toEqual([]);
});

test("capitals match only capitals", () => {
  expect(find("SETTINGS")).toEqual([]);
  expect(find("Settings")).toEqual(["web/SettingsDialog.tsx"]);
  expect(find("READ")).toEqual(["README.md"]);
});

test("one slip is forgiven, but only when nothing else matches", () => {
  expect(find("setings")[0]).toBe("web/settings.ts"); // Left out: an ordinary match.
  expect(find("hotkyes")[0]).toBe("web/hotkeys.ts");
  expect(find("contrract")[0]).toBe("tests/contract.test.ts");
  expect(find("hxotkeys")[0]).toBe("web/hotkeys.ts");
  expect(find("zzzz")).toEqual([]);
});

test("letters scattered over a label are not a match", () => {
  expect(find("oea", [{ label: "Show or hide the sidebar, whatever else" }])).toEqual([]);
});

test("other words find an entry whole, and a label beats them", () => {
  const entries = [
    { label: "Appearance…", words: "dark light system" },
    { label: "Dark theme…" },
    { label: "Wrap long lines" },
  ];
  expect(find("dark", entries)).toEqual(["Dark theme…", "Appearance…"]);
});

test("marks cover what matched", () => {
  const [best] = search(files, "hot ts");
  expect(
    segments(best!.entry.label, best!.marks)
      .filter((part) => part.marked)
      .map((part) => part.text),
  ).toEqual(["hot", "ts"]);
  expect(segments("ab", new Set())).toEqual([{ text: "ab", marked: false }]);
});

test("thousands of long paths rank within a keystroke", () => {
  const many = Array.from({ length: 4000 }, (_, index) => ({
    label: `packages/group-${index % 40}/src/components/feature/Widget${index}Controller.tsx`,
    path: true,
  }));
  const started = performance.now();
  expect(find("widget3999", many)[0]).toContain("Widget3999");
  expect(performance.now() - started).toBeLessThan(400);
});
