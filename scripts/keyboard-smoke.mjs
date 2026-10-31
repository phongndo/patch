import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const binary = resolve(process.env.PATCH_BINARY ?? "zig-out/bin/patch");
const native = resolve("node_modules/.bin/native");
const directory = await mkdtemp(join(tmpdir(), "patch-keyboard-smoke-"));
const patchPath = join(directory, "keys.diff");
await writeFile(
  patchPath,
  `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 export const one = 1;
-old alpha
+needle alpha
 export const three = 3;
@@ -20,3 +20,3 @@
 export const twenty = 20;
-old beta
+needle beta
 export const end = 22;
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,3 +1,3 @@
 export const beginning = 1;
-before
+after
 export const ending = 3;
`,
);
const app = spawn(binary, ["--background", "--patch", patchPath], {
  cwd: directory,
  env: { ...process.env, PATCH_STATE_DIR: join(directory, "state") },
  stdio: "ignore",
});
const snapshotPath = join(directory, ".zig-cache/native-sdk-automation/snapshot.txt");
async function command(...args) {
  return (await exec(native, ["automate", ...args], { cwd: directory, timeout: 15_000 })).stdout;
}
async function snapshot() {
  return readFile(snapshotPath, "utf8");
}
async function waitFor(text) {
  await command("assert", "--timeout-ms", "7000", text);
}
async function absent(text) {
  await command("assert", "--absent", "--timeout-ms", "7000", text);
}
async function key(chord) {
  await command("widget-key", "main-canvas", chord);
}
async function keys(sequence) {
  for (const char of sequence) await key(char);
}
function idFor(state, label) {
  const line = state.split("\n").find((entry) => entry.includes(`name="${label}"`));
  assert.ok(line, `Missing widget: ${label}`);
  return line.match(/main-canvas#(\d+)/)[1];
}
async function setText(label, text) {
  await command("widget-action", "main-canvas", idFor(await snapshot(), label), "set_text", text);
}
try {
  await waitFor('role=list name="Changes"');
  await keys("gg");
  await waitFor("Line 1 · new");
  await key("j");
  await waitFor("Line 2 · new");
  await key("h");
  await waitFor("Line 2 · old");
  await key("l");
  await waitFor("Line 2 · new");
  await keys("gg3j");
  await waitFor("Line 20 · new");
  await keys("gg]c");
  await waitFor("Line 2 · new");
  await keys("]c");
  await waitFor("Line 21 · new");
  await keys("[c");
  await waitFor("Line 2 · new");
  const reviewPane = idFor(await snapshot(), "Review pane");
  await key("shift+j");
  await waitFor("Line 1 · new");
  assert.equal(
    idFor(await snapshot(), "Review pane"),
    reviewPane,
    "Keyboard file navigation must preserve the focused review pane",
  );
  await key("shift+k");
  await waitFor("Line 1 · new");
  assert.equal(idFor(await snapshot(), "Review pane"), reviewPane);
  console.log("Vim motions, counts, side selection, change jumps, and file jumps passed.");

  await key("/");
  await waitFor('role=textbox name="Find in diff"');
  assert.ok(!(await snapshot()).includes('text="/"'), "Search opener leaked into the query");
  await setText("Find in diff", "needle");
  await key("enter");
  await waitFor("Line 2 · new");
  await key("n");
  await waitFor("Line 21 · new");
  await key("shift+n");
  await waitFor("Line 2 · new");
  await key("escape");

  await key("cmd+k");
  await waitFor('role=textbox name="Command search"');
  assert.match(
    await snapshot(),
    /gpu_alpha_mode=premultiplied/,
    "Glass requires an alpha-capable canvas",
  );
  const paletteState = await snapshot();
  const boundsFor = (label) => {
    const line = paletteState.split("\n").find((entry) => entry.includes(`name="${label}"`));
    return line
      .match(/bounds=\(([-\d.]+),([-\d.]+) ([-\d.]+)x([-\d.]+)\)/)
      .slice(1)
      .map(Number);
  };
  const queryBounds = boundsFor("Command search");
  const resultBounds = boundsFor("Results");
  const footerBounds = boundsFor("Palette hints");
  assert.ok(
    queryBounds[1] + queryBounds[3] <= resultBounds[1],
    "Palette search overlaps its results",
  );
  assert.ok(
    resultBounds[1] + resultBounds[3] <= footerBounds[1],
    "Palette footer overlaps its results",
  );
  await command("widget-wheel", "main-canvas", idFor(await snapshot(), "Results"), "600");
  const results = (await snapshot()).split("\n").find((entry) => entry.includes('name="Results"'));
  assert.ok(Number(results.match(/start=(\d+)/)[1]) > 0, "Command palette wheel did not scroll");
  await setText("Command search", "split");
  await key("enter");
  await absent('role=textbox name="Command search"');
  await waitFor('name="Switch to split diff"');
  await key("cmd+backslash");
  await waitFor('name="Switch to unified diff"');
  await key("cmd+p");
  await waitFor('role=textbox name="File picker"');
  await setText("File picker", "b.ts");
  await key("enter");
  await absent('role=textbox name="File picker"');
  await waitFor("Line 1 · new");
  await key("j");
  await waitFor("Line 2 · new");
  console.log("Diff search, repeated matches, command palette, and fuzzy file picker passed.");

  await key("c");
  await waitFor('role=textbox name="Review note"');
  const editor = (await snapshot())
    .split("\n")
    .find((entry) => entry.includes('name="Review note"'));
  assert.ok(!editor.includes('text="c"'), "Comment opener leaked into the editor");
  for (const char of "jkrn") await command("widget-key", "main-canvas", char, char);
  await waitFor('text="jkrn"');
  await key("escape");
  await key("k");
  await waitFor("Line 1 · new");
  await key("c");
  await waitFor('role=textbox name="Review note"');
  assert.ok((await snapshot()).includes('text="jkrn"'), "Escape discarded the note draft");
  await setText("Review note", "Keyboard review note.");
  await key("cmd+enter");
  await absent('role=textbox name="Review note"');
  await waitFor("Keyboard review note.");
  await key("r");
  await waitFor('name="1/2"');
  await key("shift+r");
  await waitFor('name="1/2"');
  await key("shift+r");
  await waitFor('name="2/2"');
  await key("u");
  await waitFor('name="1/2"');
  console.log(
    "Comment typing safety, Escape focus return, keyboard save, review-and-advance, and undo passed.",
  );

  await key("cmd+k");
  await waitFor('role=textbox name="Command search"');
  await setText("Command search", "next");
  await key("ctrl+n");
  await key("ctrl+p");
  await command("widget-key", "main-canvas", "x", "x");
  await waitFor('text="nextx"');
  await key("escape");
  await absent('role=textbox name="Command search"');
  await key("cmd+k");
  await setText("Command search", "a.ts");
  await key("enter");
  await absent('role=textbox name="Command search"');
  await waitFor("Line 1 · new");
  await key("j");
  await waitFor("Line 2 · new");
  console.log("The command palette searches and opens changed files alongside commands.");
  assert.ok((await snapshot()).includes("dispatch_errors=0"));
  console.log("All keyboard UI checks passed.");
} catch (error) {
  console.error(
    (await snapshot().catch(() => "No native snapshot"))
      .split("\n")
      .filter((line) =>
        /error event=|focused=true|Review note|Command search|Line \d|Find in diff|File picker/.test(
          line,
        ),
      )
      .join("\n")
      .slice(-6000),
  );
  throw error;
} finally {
  if (app.exitCode === null) {
    const stopped = new Promise((resolveStopped) => app.once("exit", resolveStopped));
    app.kill("SIGTERM");
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
