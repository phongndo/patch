import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const binary = resolve("zig-out/bin/patch");
const native = resolve("node_modules/.bin/native");
const directory = await mkdtemp(join(tmpdir(), "patch-mouse-smoke-"));
const patchPath = join(directory, "mouse.diff");
await writeFile(
  patchPath,
  `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,80 +1,80 @@
` +
    Array.from({ length: 80 }, (_, i) => `-old line ${i + 1}\n+new line ${i + 1}\n`).join("") +
    "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-before\n+after\n",
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
function widgetLine(state, label) {
  const source = label.match(/^(New|Old) code line (\d+)$/);
  const line = state
    .replace(/\n(?=" bounds=)/g, "\\n")
    .split("\n")
    .find((entry) => {
      if (entry.includes(`name="${label}"`)) return true;
      if (!source || !entry.includes("role=text ")) return false;
      const name = entry.match(/\bname=("(?:\\.|[^"\\])*")/);
      return (
        name && JSON.parse(name[1]).trimEnd() === `${source[1].toLowerCase()} line ${source[2]}`
      );
    });
  assert.ok(line, `Missing widget: ${label}`);
  return line;
}
function widget(state, label) {
  return widgetLine(state, label).match(/main-canvas#(\d+)/)[1];
}
async function click(label) {
  await command("widget-click", "main-canvas", widget(await snapshot(), label));
}
async function key(chord) {
  await command("widget-key", "main-canvas", chord);
}
async function drag(label, x1, x2, y1, y2) {
  await command(
    "widget-drag",
    "main-canvas",
    widget(await snapshot(), label),
    ...[x1, x2, y1, y2].map(String),
  );
}
// Read the system clipboard the app wrote to: pbpaste on macOS, and the X11
// or Wayland clipboard elsewhere (the Linux dev shell provides xclip).
const paste =
  process.platform === "darwin"
    ? ["/usr/bin/pbpaste", []]
    : process.env.WAYLAND_DISPLAY
      ? ["wl-paste", ["--no-newline"]]
      : ["xclip", ["-selection", "clipboard", "-out"]];
async function clipboard() {
  return (await exec(...paste)).stdout;
}
try {
  await waitFor('role=list name="Changes"');
  await drag("Comment on new line 2", 0.5, 0.5, 0.5, 2.5);
  await waitFor('name="Selection actions"');
  await click("Copy selected code");
  assert.equal(await clipboard(), "new line 2\nnew line 3\nnew line 4\n");
  await click("Comment on selected lines");
  await waitFor('role=textbox name="Review note"');
  await waitFor("a.ts:2–4");
  await command(
    "widget-action",
    "main-canvas",
    widget(await snapshot(), "Review note"),
    "set_text",
    "Mouse range note.",
  );
  await key("escape");
  await key("cmd+alt+down");
  await key("enter");
  await waitFor("a.ts:2–4");
  await waitFor('text="Mouse range note."');
  await key("cmd+enter");
  await click("a.ts");
  await waitFor("Mouse range note.");
  await click("Close notes");
  await click("a.ts");
  await drag("Comment on old line 5", 0.5, 0.5, 0.5, -1.5);
  await waitFor('name="Selection actions"');
  await click("Copy selected code");
  assert.equal(await clipboard(), "old line 3\nold line 4\nold line 5\n");
  await key("escape");
  await absent('name="Selection actions"');
  console.log(
    "Forward/reverse gutter ranges, both sides, range copying, and draft anchors passed.",
  );
  // Aim through the scroll target using absolute code coordinates; the source
  // itself stays a passive, selectable native text leaf.
  const state = await snapshot();
  function bounds(label) {
    return widgetLine(state, label)
      .match(/bounds=\(([-\d.]+),([-\d.]+) ([-\d.]+)x([-\d.]+)\)/)
      .slice(1)
      .map(Number);
  }
  const listBounds = bounds("Changes");
  const codeBounds = bounds("New code line 2");
  const startX = codeBounds[0] + 32;
  const endX = codeBounds[0] + 64;
  const startY = codeBounds[1] + 7;
  const endY = startY + 48;
  await drag(
    "Changes",
    (startX - listBounds[0]) / listBounds[2],
    (endX - listBounds[0]) / listBounds[2],
    (startY - listBounds[1]) / listBounds[3],
    (endY - listBounds[1]) / listBounds[3],
  );
  await waitFor('name="Selection actions"');
  await key("cmd+c");
  const nativeCopy = await clipboard();
  await click("Copy selected code");
  assert.equal(
    await clipboard(),
    nativeCopy,
    "Popover copy must preserve the native character selection",
  );
  assert.ok(
    nativeCopy.includes("new line 3"),
    `Missing middle line: ${JSON.stringify(nativeCopy)}`,
  );
  assert.ok(
    !nativeCopy.startsWith("new line 2"),
    `Expected a partial first line: ${JSON.stringify(nativeCopy)}`,
  );
  console.log(`Native character selection and popover copy agree: ${JSON.stringify(nativeCopy)}`);
  const selectedState = await snapshot();
  const selectedCell = widgetLine(selectedState, "New code line 3").match(/parent=#(\d+)/)[1];
  await command("widget-context-menu", "main-canvas", selectedCell, "1");
  assert.equal(await clipboard(), nativeCopy, "Context-menu selection copy must match");
  await drag("Comment on old line 9", 0.5, 0.5, 0.5, 1.5);
  await waitFor('name="9–10"');
  await key("cmd+c");
  assert.equal(
    await clipboard(),
    "old line 9\nold line 10\n",
    "Keyboard copy must work for gutter ranges",
  );
  await key("escape");
  const contextCell = widgetLine(await snapshot(), "Old code line 7").match(/parent=#(\d+)/)[1];
  await command("widget-context-menu", "main-canvas", contextCell, "1");
  assert.equal(await clipboard(), "old line 7");
  await command("widget-context-menu", "main-canvas", contextCell, "0");
  await waitFor("a.ts:7");
  await click("Cancel note");
  await click("Close notes");
  console.log(
    "Native context-menu dispatch, replacing a selection, and gutter keyboard copy passed.",
  );
  if (process.env.PATCH_KEEP_SMOKE) console.log(`Mouse artifacts: ${directory}`);
  assert.ok((await snapshot()).includes("dispatch_errors=0"));
} catch (error) {
  console.error((await snapshot().catch(() => "No snapshot")).slice(-16000));
  throw error;
} finally {
  if (app.exitCode === null) {
    const stopped = new Promise((resolveStopped) => app.once("exit", resolveStopped));
    app.kill("SIGTERM");
    await stopped;
  }
  if (!process.env.PATCH_KEEP_SMOKE) await rm(directory, { recursive: true, force: true });
}
