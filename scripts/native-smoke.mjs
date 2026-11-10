import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const binary = resolve("zig-out/bin/patch");
const native = resolve("node_modules/.bin/native");
const directory = await mkdtemp(join(tmpdir(), "patch-native-smoke-"));
const patchPath = join(directory, "large.diff");
const lineCount = 50_000;
const extraFiles = 36;
const fileCount = extraFiles + 2;
await writeFile(
  patchPath,
  `diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -1 +1,${lineCount} @@\n-old\n` +
    Array.from({ length: lineCount }, (_, index) =>
      index === 7 ? `+// ${"long ".repeat(400)}\n` : `+export const value${index} = ${index};\n`,
    ).join(""),
);
await writeFile(
  patchPath,
  (await readFile(patchPath, "utf8")) +
    Array.from(
      { length: extraFiles },
      (_, file) =>
        `diff --git a/zfiles/file${file}.ts b/zfiles/file${file}.ts\n--- a/zfiles/file${file}.ts\n+++ b/zfiles/file${file}.ts\n@@ -1 +1,20 @@\n-old\n` +
        Array.from({ length: 20 }, (_, line) => `+export const value${line} = ${line};\n`).join(""),
    ).join(""),
);
await writeFile(
  patchPath,
  (await readFile(patchPath, "utf8")) +
    "diff --git a/tail.ts b/tail.ts\n--- a/tail.ts\n+++ b/tail.ts\n@@ -1 +1 @@\n-old\n+export const tail = true;\n",
);
let app;
const snapshotPath = join(directory, ".zig-cache/native-sdk-automation/snapshot.txt");
async function command(...args) {
  return (await exec(native, ["automate", ...args], { cwd: directory, timeout: 15_000 })).stdout;
}
async function snapshot() {
  return readFile(snapshotPath, "utf8");
}
function idFor(snapshotText, label) {
  const line = snapshotText.split("\n").find((entry) => entry.includes(`name="${label}"`));
  assert.ok(line, `Missing widget: ${label}`);
  return line.match(/main-canvas#(\d+)/)[1];
}
async function click(label) {
  await command("widget-click", "main-canvas", idFor(await snapshot(), label));
}
async function waitFor(text) {
  await command("assert", "--timeout-ms", "10000", text);
}
function start() {
  app = spawn(binary, ["--background", "--patch", patchPath], {
    cwd: directory,
    env: { ...process.env, PATCH_STATE_DIR: join(directory, "state") },
    stdio: "ignore",
  });
}
async function stop() {
  if (!app || app.exitCode !== null || app.signalCode !== null) return;
  const stopped = new Promise((resolveStopped) => app.once("exit", resolveStopped));
  app.kill("SIGTERM");
  await stopped;
}
try {
  const started = performance.now();
  start();
  await waitFor('role=list name="Changes"');
  let state = await snapshot();
  const list = state.split("\n").find((entry) => entry.includes('role=list name="Changes"'));
  assert.ok(list.includes("virtual=["));
  const rendered = Number(list.match(/rendered=(\d+)/)[1]);
  assert.ok(rendered < 100, `Rendered ${rendered} of ${lineCount} rows`);
  assert.ok(state.includes("dispatch_errors=0"));
  console.log(
    `50,000-line file, ${fileCount} files: ${Math.round(performance.now() - started)} ms to a ready review; ${rendered} mounted rows.`,
  );
  // Long lines pan together: a sideways wheel shifts every code line (no
  // per-line scroller), and the footer reports where the visible code begins.
  const longLine = state.split("\n").find((line) => line.includes('name="New code line 8"'));
  assert.ok(
    longLine && !longLine.includes("scroll=["),
    "Long lines pan with the review, not on their own",
  );
  await command("widget-wheel", "main-canvas", idFor(state, "Changes"), "0", "400");
  await waitFor("From column ");
  console.log("Long code lines pan together, and the footer reports the column.");
  await click("tail.ts");
  await waitFor("export const tail = true;");
  await click("large.ts");
  await waitFor("Comment on new line 1");
  await click("Comment on new line 1");
  await waitFor('role=textbox name="Review note"');
  await command(
    "widget-action",
    "main-canvas",
    idFor(await snapshot(), "Review note"),
    "set_text",
    "Native smoke test note.",
  );
  // The label spells the chord as the platform does.
  await click(process.platform === "darwin" ? "Save note · ⌘↵" : "Save note · Ctrl+Enter");
  await waitFor("Native smoke test note.");
  await click("Mark large.ts reviewed");
  await waitFor(`1/${fileCount}`);
  await stop();
  start();
  await waitFor('role=list name="Changes"');
  await waitFor(`1/${fileCount}`);
  await click("Notes");
  await waitFor("Native smoke test note.");
  // Panes ease open over 240 ms; act once the notes have settled in place.
  await new Promise((settled) => setTimeout(settled, 400));
  await click("Close notes");
  state = await snapshot();
  const scrollId = idFor(state, "Changes");
  await command("profile", "on");
  await command("widget-wheel", "main-canvas", scrollId, "8000");
  state = await snapshot();
  assert.ok(state.includes("dispatch_errors=0"));
  const scroll = state.split("\n").find((entry) => entry.includes('role=list name="Changes"'));
  assert.ok(Number(scroll.match(/start=(\d+)/)[1]) > 0, "Large-diff scroll did not advance");
  console.log(
    "Native line notes, reviewed state, restart persistence, and virtualized scrolling passed.",
  );
  console.log(state.split("\n").find((entry) => entry.startsWith("frame_profile")));
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
