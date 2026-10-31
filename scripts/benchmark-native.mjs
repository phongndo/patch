import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const binary = resolve(option("--binary", "zig-out/bin/patch"));
const native = resolve("node_modules/.bin/native");
const runs = Number(option("--runs", "5"));
const warmups = Number(option("--warmups", "1"));
const production = args.includes("--production");
const launchServices = args.includes("--launch-services");
const output = resolve(option("--output", "zig-out/performance/latest.json"));
const traceOutput = output.replace(/\.json$/, "") + ".draw-trace.log";
const directory = await mkdtemp(join(tmpdir(), "patch-performance-"));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const number = (state, field) => Number(state.match(new RegExp(`\\b${field}=([0-9.]+)`))?.[1] ?? 0);
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ];
const summary = (values) => ({
  median: percentile(values, 0.5),
  p90: percentile(values, 0.9),
  min: Math.min(...values),
  max: Math.max(...values),
});
const results = {
  binary,
  runs,
  warmups,
  production,
  launchServices,
  measuredAt: new Date().toISOString(),
  launches: {},
  interactions: {},
};
let app;
let work;
let stderr;
let traceStderr = "";
let launchedPid;
let launchLog;
let launchedFixture;

function patch(lines, files = 1) {
  return Array.from(
    { length: files },
    (_, file) =>
      `diff --git a/file${file}.ts b/file${file}.ts\n--- a/file${file}.ts\n+++ b/file${file}.ts\n@@ -1 +1,${lines} @@\n-old\n` +
      Array.from({ length: lines }, (_, line) => `+export const value${line} = ${line};\n`).join(
        "",
      ),
  ).join("");
}
async function snapshot() {
  if (launchServices) stderr = await readFile(launchLog, "utf8").catch(() => "");
  if (production) return "";
  return readFile(join(work, ".zig-cache/native-sdk-automation/snapshot.txt"), "utf8").catch(
    () => "",
  );
}
async function until(predicate, timeout = 15_000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const state = await snapshot();
    if (predicate(state)) return state;
    if (number(state, "dispatch_errors") > 0)
      throw new Error(
        `Runtime error: ${state
          .split("\n")
          .filter((line) => line.includes("error event="))
          .join("\n")}\n${stderr.slice(-1500)}`,
      );
    if (app && app.exitCode !== null)
      throw new Error(`App exited (${app.exitCode}): ${stderr.slice(-2000)}`);
    await delay(3);
  }
  throw new Error(`Benchmark timeout: ${stderr.slice(-3000)}`);
}
async function command(...params) {
  return (await exec(native, ["automate", ...params], { cwd: work, timeout: 20_000 })).stdout;
}
function widget(state, name) {
  const entry = state.split("\n").find((line) => line.includes(`name="${name}"`));
  assert.ok(entry, `Missing widget: ${name}`);
  return entry.match(/main-canvas#(\d+)/)[1];
}
async function stop() {
  if (launchServices) {
    // Match our unique fixture before signalling a process launched by macOS.
    // In particular, never terminate another open instance of Patch.
    if (launchedPid) {
      const commandLine = (
        await exec("/bin/ps", ["-p", String(launchedPid), "-o", "command="]).catch(() => ({
          stdout: "",
        }))
      ).stdout.trim();
      if (commandLine.startsWith(`${binary} `) && commandLine.endsWith(launchedFixture)) {
        try {
          process.kill(launchedPid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            process.kill(launchedPid, 0);
          } catch {
            break;
          }
          await delay(5);
        }
      }
      launchedPid = undefined;
    }
    return;
  }
  if (!app || app.exitCode !== null) return;
  const stopped = new Promise((done) => app.once("exit", done));
  app.kill("SIGTERM");
  await stopped;
}
async function launch(name, fixture, iteration) {
  work = join(directory, `${name}-${iteration}`);
  await mkdir(work);
  stderr = "";
  if (args.includes("--draw-trace"))
    traceStderr += `\npatch-benchmark: launch ${name}-${iteration}\n`;
  const spawnWall = Date.now() * 1e6;
  const started = performance.now();
  const appArgs = ["--background", name === "repository" ? "--repo" : "--patch", fixture];
  if (launchServices) {
    launchLog = join(work, "launch.stderr");
    launchedFixture = fixture;
    await exec("/usr/bin/open", [
      "-g",
      "-n",
      "-a",
      dirname(dirname(dirname(binary))),
      "--env",
      "NATIVE_SDK_WINDOW_TIMING=1",
      "--env",
      `PATCH_STATE_DIR=${join(work, "state")}`,
      "--stderr",
      launchLog,
      "--stdout",
      "/dev/null",
      "--args",
      ...appArgs,
    ]);
    const processes = (await exec("/bin/ps", ["-axo", "pid=,command="])).stdout;
    launchedPid = Number(
      processes
        .split("\n")
        .find((line) => {
          const commandLine = line.trim().replace(/^\d+\s+/, "");
          return commandLine.startsWith(`${binary} `) && commandLine.endsWith(fixture);
        })
        ?.trim()
        .match(/^\d+/)?.[0],
    );
    assert.ok(launchedPid, "Could not identify our Launch Services instance");
  } else {
    app = spawn(binary, appArgs, {
      cwd: work,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        NATIVE_SDK_WINDOW_TIMING: "1",
        PATCH_STATE_DIR: join(work, "state"),
        ...(args.includes("--verify-rendering") ? { NATIVE_SDK_GPU_VERIFY_INCREMENTAL: "1" } : {}),
        ...(args.includes("--draw-trace")
          ? { NATIVE_SDK_GPU_DRAW_TRACE: "1", NATIVE_SDK_GPU_DRAW_TRACE_KINDS: "1" }
          : {}),
      },
    });
    app.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (args.includes("--draw-trace")) traceStderr += chunk;
    });
  }
  const state = await until((text) => {
    if (!production)
      return text.includes('role=list name="Changes"') && text.includes("gpu_nonblank=true");
    const loaded = stderr.match(/patch-perf: review_ready wall_ns=(\d+)/);
    const built = stderr.match(/launch first_view_built wall_ns=(\d+)/);
    return (
      /window \d+ shown .* wall_ns=/.test(stderr) &&
      loaded &&
      built &&
      (Number(loaded[1]) <= Number(built[1]) ||
        /patch-perf: review_presented wall_ns=/.test(stderr))
    );
  });
  const ready = performance.now() - started;
  const shown = stderr.match(/window \d+ shown .* wall_ns=(\d+)/);
  const laps = Object.fromEntries(
    [...stderr.matchAll(/launch (\w+) wall_ns=(\d+)/g)].map((match) => [
      match[1],
      (Number(match[2]) - spawnWall) / 1e6,
    ]),
  );
  const loaded = stderr.match(/patch-perf: review_ready wall_ns=(\d+)/);
  const reviewReady = loaded ? (Number(loaded[1]) - spawnWall) / 1e6 : null;
  const view = state.split("\n").find((line) => line.includes('role=list name="Changes"'));
  assert.equal(number(state, "dispatch_errors"), 0, stderr);
  const firstFrameHasReview = reviewReady !== null && reviewReady <= laps.first_view_built;
  const presented = stderr.match(/patch-perf: review_presented wall_ns=(\d+)/);
  const visible = shown ? (Number(shown[1]) - spawnWall) / 1e6 : null;
  return {
    ready,
    shown: visible,
    reviewReady,
    firstFrameHasReview,
    reviewVisible: firstFrameHasReview
      ? visible
      : presented
        ? (Number(presented[1]) - spawnWall) / 1e6
        : null,
    laps,
    mounted: view ? Number(view.match(/rendered=(\d+)/)[1]) : null,
    nodes: production ? null : number(state, "widget_nodes"),
  };
}
async function interaction(params) {
  const before = number(await snapshot(), "gpu_input_count");
  const started = performance.now();
  await command(...params);
  const state = await until(
    (text) =>
      number(text, "gpu_input_count") > before &&
      number(text, "gpu_timestamp_ns") >= number(text, "gpu_input_timestamp_ns"),
  );
  assert.equal(number(state, "dispatch_errors"), 0);
  return {
    elapsed: performance.now() - started,
    input: number(state, "gpu_input_latency_ns") / 1e6,
    state,
  };
}
async function profile(name, actions) {
  if (args.includes("--interaction") && option("--interaction") !== name) return;
  actions = actions.slice(0, Number(option("--samples", String(actions.length))));
  if (args.includes("--draw-trace")) traceStderr += `\npatch-benchmark: profile ${name}\n`;
  await command("profile", "on");
  const samplePath = join(tmpdir(), `patch-performance-scroll-${app.pid}.sample`);
  const sampler =
    name === "scroll" && args.includes("--sample")
      ? exec("/usr/bin/sample", [String(app.pid), "2", "-file", samplePath], {
          timeout: 10_000,
        }).then(
          () => {
            results.sample = { path: samplePath };
          },
          async () => {
            results.sample = { unavailable: true, reason: "The macOS sampler did not complete" };
            await rm(samplePath, { force: true });
          },
        )
      : null;
  const elapsed = [];
  const input = [];
  for (const action of actions) {
    const measured = await interaction(action);
    elapsed.push(measured.elapsed);
    input.push(measured.input);
  }
  const state = await snapshot();
  assert.ok(
    !stderr.includes("verify MISMATCH"),
    stderr
      .split("\n")
      .filter((line) => line.includes("verify"))
      .slice(-6)
      .join("\n"),
  );
  if (args.includes("--verify-rendering")) {
    const checks = [...stderr.matchAll(/incremental verify .* checks=(\d+) mismatches=(\d+)/g)];
    assert.ok(
      checks.length && checks.every((check) => Number(check[2]) === 0),
      "Native pixel verifier must run without mismatches",
    );
    results.rendering = { checks: Number(checks.at(-1)[1]), mismatches: 0 };
  }
  const stages = Object.fromEntries(
    [...state.matchAll(/(\w+)_(p50|p90|max)_us=(\d+)/g)].map((match) => [
      `${match[1]}_${match[2]}_ms`,
      Number(match[3]) / 1000,
    ]),
  );
  results.interactions[name] = { input_ms: summary(input), driver_ms: summary(elapsed), stages };
  await command("profile", "off");
  if (sampler) await sampler;
}
try {
  assert.ok(
    !production || args.includes("--startup-only"),
    "Production binaries support --startup-only; interaction runs need automation",
  );
  assert.ok(
    !launchServices || production,
    "Launch Services needs --production --startup-only and a packaged binary",
  );
  const fixtures = {
    small: patch(30),
    large: patch(50_000),
    many_files: patch(Number(option("--lines", "20")), Number(option("--files", "250"))),
  };
  // A real diff from disk, measured as the `patch_file` case.
  if (args.includes("--patch-file"))
    fixtures.patch_file = await readFile(resolve(option("--patch-file")), "utf8");
  const cases = option("--case", [...Object.keys(fixtures), "repository"].join(",")).split(",");
  assert.ok(
    Number.isInteger(runs) && runs > 0 && Number.isInteger(warmups) && warmups >= 0,
    "Runs and warmups must be nonnegative integers, with at least one run",
  );
  if (args.includes("--samples"))
    assert.ok(
      Number.isInteger(Number(option("--samples"))) && Number(option("--samples")) > 0,
      "Samples must be a positive integer",
    );
  assert.ok(
    cases.every((name) => name === "none" || name === "repository" || name in fixtures),
    "Unknown benchmark case",
  );
  if (cases.includes("repository")) {
    const repo = join(directory, "repository");
    await mkdir(repo);
    await exec("git", ["init", "--quiet", repo]);
    for (let file = 0; file < 100; file++)
      await writeFile(join(repo, `file${file}.ts`), "export const before = true;\n");
    await exec("git", ["-C", repo, "add", "."]);
    await exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=Patch Benchmark",
      "-c",
      "user.email=benchmark@patch.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    ]);
    for (let file = 0; file < 100; file++)
      await writeFile(join(repo, `file${file}.ts`), "export const after = true;\n");
    fixtures.repository = null;
  }
  for (const [name, source] of Object.entries(fixtures))
    if (source !== null) await writeFile(join(directory, `${name}.diff`), source);
  for (const name of Object.keys(fixtures)) {
    if (!cases.includes(name)) continue;
    const fixture = join(directory, name === "repository" ? name : `${name}.diff`);
    const preflight = [];
    for (let run = 0; run < warmups; run++) {
      preflight.push(await launch(name, fixture, `warmup-${run}`));
      await stop();
    }
    const samples = [];
    for (let run = 0; run < runs; run++) {
      samples.push(await launch(name, fixture, run));
      await stop();
    }
    const reviewTimes = samples
      .map((sample) => sample.reviewVisible)
      .filter((value) => value !== null);
    results.launches[name] = {
      observed_ready_ms: summary(samples.map((sample) => sample.ready)),
      visible_ms: summary(samples.map((sample) => sample.shown).filter((value) => value !== null)),
      review_visible_ms: reviewTimes.length ? summary(reviewTimes) : null,
      preflight,
      samples,
    };
    const measured = results.launches[name];
    console.log(
      `${name}: window ${measured.visible_ms.median.toFixed(1)} ms; first review ${measured.review_visible_ms?.median.toFixed(1) ?? "unmeasured"} ms; ${production ? "milestones" : "snapshot"} observed ${measured.observed_ready_ms.median.toFixed(1)} ms.`,
    );
  }
  if (!args.includes("--startup-only")) {
    await launch(
      "interactions",
      join(directory, args.includes("--patch-file") ? "patch_file.diff" : "large.diff"),
      0,
    );
    const list = widget(await snapshot(), "Changes");
    await profile(
      "scroll",
      Array.from({ length: 30 }, () => ["widget-wheel", "main-canvas", list, "120"]),
    );
    await profile(
      "keyboard",
      Array.from({ length: 30 }, () => ["widget-key", "main-canvas", "j"]),
    );
    await profile(
      "palette",
      Array.from({ length: 12 }, () => ["widget-key", "main-canvas", "cmd+k"]),
    );
    if (args.includes("--all-interactions")) {
      const key = async (chord) => command("widget-key", "main-canvas", chord);
      const keys = (chords) =>
        chords.map((chord) => ["widget-key", "main-canvas", chord === " " ? "space" : chord]);
      if ((await snapshot()).includes('role=textbox name="Command search"')) await key("escape");
      await key("cmd+k");
      await profile("palette_typing", keys([..."review", ...Array(6).fill("backspace")]));
      await profile(
        "palette_navigation",
        keys(Array.from({ length: 20 }, (_, i) => (i % 2 ? "up" : "down"))),
      );
      await key("escape");
      await profile("review_toggle", keys(Array(12).fill("r")));
      await profile("sidebar_toggle", keys(Array(12).fill("cmd+b")));
      if (!(await snapshot()).includes('role=textbox name="Find file"')) await key("cmd+b");
      await profile("notes_toggle", keys(Array(12).fill("cmd+shift+n")));
      if ((await snapshot()).includes('name="Close notes"')) await key("cmd+shift+n");
      await profile("split_toggle", keys(Array(12).fill("cmd+backslash")));
      if ((await snapshot()).includes('name="Switch to split diff"')) await key("cmd+backslash");
      await key("c");
      await profile("note_typing", keys([..."instant notes", ...Array(13).fill("backspace")]));
      await key("escape");
      await key("cmd+f");
      await profile("diff_search", keys([..."value123", ...Array(8).fill("backspace")]));
      await key("escape");
      await stop();
      await launch("file_interactions", join(directory, "many_files.diff"), 0);
      await profile(
        "file_navigation",
        keys(Array.from({ length: 20 }, (_, i) => (i % 2 ? "shift+k" : "shift+j"))),
      );
      await command("widget-click", "main-canvas", widget(await snapshot(), "Find file"));
      await profile("file_filter", keys([..."file12", ...Array(6).fill("backspace")]));
      await key("escape");
      await stop();
      await launch("mouse_interactions", join(directory, "small.diff"), 0);
      const mouseState = await snapshot();
      const gutter = widget(mouseState, "Comment on new line 2");
      const alternatingDrags = (drag) =>
        Array.from({ length: 20 }, (_, index) =>
          index % 2 ? ["widget-key", "main-canvas", "escape"] : drag,
        );
      await profile(
        "gutter_selection",
        alternatingDrags(["widget-drag", "main-canvas", gutter, "0.5", "0.5", "0.5", "2.5"]),
      );
      await key("escape");
      const bounds = (name) =>
        mouseState
          .split("\n")
          .find((line) => line.includes(`name="${name}"`))
          .match(/bounds=\(([-\d.]+),([-\d.]+) ([-\d.]+)x([-\d.]+)\)/)
          .slice(1)
          .map(Number);
      const [listX, listY, listW, listH] = bounds("Changes");
      const [gutterX, gutterY] = bounds("Comment on new line 2");
      await profile(
        "code_selection",
        alternatingDrags([
          "widget-drag",
          "main-canvas",
          widget(mouseState, "Changes"),
          String((gutterX + 48 + 24 - listX) / listW),
          String((gutterX + 48 + 80 - listX) / listW),
          String((gutterY + 7 - listY) / listH),
          String((gutterY + 55 - listY) / listH),
        ]),
      );
    }
    results.resident_mb =
      Number((await exec("/bin/ps", ["-p", String(app.pid), "-o", "rss="])).stdout.trim()) / 1024;
    if (args.includes("--interaction"))
      assert.ok(
        Object.hasOwn(results.interactions, option("--interaction")),
        "Unknown interaction, or --all-interactions is required for this interaction",
      );
    for (const [name, measured] of Object.entries(results.interactions))
      console.log(
        `${name}: input-to-present median ${measured.input_ms.median.toFixed(1)} ms; p90 ${measured.input_ms.p90.toFixed(1)} ms.`,
      );
  }
  await mkdir(dirname(output), { recursive: true });
  results.binary_sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  await writeFile(output, JSON.stringify(results, null, 2) + "\n");
  if (args.includes("--draw-trace")) await writeFile(traceOutput, traceStderr);
  console.log(`Results: ${output}`);
  if (args.includes("--assert")) {
    for (const [name, measured] of Object.entries(results.launches)) {
      assert.ok(
        measured.visible_ms.p90 <= 250,
        `${name}: window should become visible within 250 ms`,
      );
      assert.ok(
        measured.review_visible_ms && measured.review_visible_ms.p90 <= 250,
        `${name}: first review should present within 250 ms`,
      );
      assert.ok(
        measured.observed_ready_ms.p90 <= 350,
        `${name}: review snapshot should be observable within 350 ms`,
      );
    }
    if (results.interactions.scroll)
      assert.ok(
        results.interactions.scroll.input_ms.p90 <= 16.7,
        "Scrolling should present within one 60 Hz frame",
      );
    if (results.interactions.palette)
      assert.ok(
        results.interactions.palette.input_ms.p90 <= 33.4,
        "Palette should present within two 60 Hz frames",
      );
    for (const [name, measured] of Object.entries(results.interactions)) {
      const budget =
        name.startsWith("palette") || (name.endsWith("_toggle") && name !== "review_toggle")
          ? 33.4
          : 16.7;
      assert.ok(measured.input_ms.p90 <= budget, `${name}: p90 should present within ${budget} ms`);
    }
  }
} catch (error) {
  results.error = error.message;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(results, null, 2) + "\n");
  if (args.includes("--draw-trace")) await writeFile(traceOutput, traceStderr);
  throw error;
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
