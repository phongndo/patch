// Measures how fast Patch opens a review, on a fixed fixture with a large change:
// the CLI from launch to its diff answered, the page from navigation to its first
// file drawn in headless Chromium, the script it fetched by then, the CLI's peak
// memory and the page's JS heap. Prints one line of JSON.
//   bun scripts/bench.ts [--runs 7] [--patchr cli/target/release/patchr]
// Chromium comes from $CHROMIUM, else `nix shell nixpkgs#chromium`.
import { $ } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1]! : fallback;
};
const runs = Number(flag("--runs", "7"));
const patchr = resolve(flag("--patchr", join(root, "cli/target/release/patchr")));
// Everything the run writes, removed when it ends: the fixture, the browser's profile, and
// the reviews' home, so no setting or state of the user's is read or written.
const work = mkdtempSync(join(tmpdir(), "patch-bench-"));
const fixture = join(work, "repo");
const FIXTURE_COMMIT = "27b51a7";

/** The same change every run: a clone at a fixed commit, then the same edits. */
async function makeFixture() {
  // None of the user's Git settings, such as signing or hooks, reach the fixture's commits.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  await $`git clone -q --no-local ${root} ${fixture}`.env(env).quiet();
  const git = (...args: string[]) =>
    $`git -C ${fixture} -c user.name=b -c user.email=b@b ${args}`.env(env).quiet();
  await git("checkout", "-q", "-B", "main", FIXTURE_COMMIT);
  // The base the review finds is main, whichever branch the source checkout is on.
  await git("update-ref", "refs/remotes/origin/main", FIXTURE_COMMIT);
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git("checkout", "-q", "-b", "work");
  const files = (await $`git -C ${fixture} ls-files`.env(env).text())
    .split("\n")
    .filter((f) => /\.(ts|tsx|rs|css|md|json)$/.test(f) && !f.includes("lock"))
    .sort();
  const edit = async (file: string, salt: number) => {
    const path = join(fixture, file);
    const lines = readFileSync(path, "utf8").split("\n");
    for (let i = salt % 7; i < lines.length; i += 23) lines[i] = `${lines[i]} // edit ${salt}`;
    lines.splice(Math.min(5, lines.length), 0, `// inserted ${salt}`);
    await Bun.write(path, lines.join("\n"));
  };
  // Committed on the branch, then edited again uncommitted, then untracked files.
  for (const [i, file] of files.slice(0, 120).entries()) await edit(file, i);
  await git("commit", "-qam", "branch work");
  for (const [i, file] of files.slice(80, 160).entries()) await edit(file, 1000 + i);
  for (let i = 0; i < 25; i++)
    await Bun.write(join(fixture, `new/file-${i}.ts`), readFileSync(join(fixture, files[i]!), "utf8"));
  // As a repository is when its files are older than its index: files written in the second
  // the index was would be read again on every diff.
  await Bun.sleep(1100);
  await git("update-index", "-q", "--really-refresh");
  await git("status", "--porcelain");
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

type Review = { child: Bun.Subprocess; url: string; started: number };
/** Reviews still running, ended however the run ends. */
const live = new Set<Bun.Subprocess>();
async function startReview(): Promise<Review> {
  const started = performance.now();
  const child = Bun.spawn([patchr, "review", fixture, "--local", "--no-open"], {
    env: {
      ...process.env,
      PATCH_BROWSER: "none",
      XDG_CONFIG_HOME: join(work, "config"),
      XDG_STATE_HOME: join(work, "state"),
      HOME: join(work, "home"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  live.add(child);
  const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!/open at (\S+)/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`patchr exited: ${text}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { child, url: text.match(/open at (\S+)/)![1]!, started };
}

/** Peak memory in MB on Linux; macOS has no peak for another process, so its memory now. */
function peakRss(pid: number) {
  if (process.platform === "linux") {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return Number(status.match(/VmHWM:\s+(\d+)/)![1]) / 1024;
  }
  const kb = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return Number(kb) / 1024;
}

async function stop(review: Review) {
  review.child.kill();
  await review.child.exited;
  live.delete(review.child);
}

/** Launch to /api/review answered in full. */
async function cliRun() {
  const review = await startReview();
  const response = await fetch(new URL("/api/review", review.url), {
    headers: { "accept-encoding": "gzip" },
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`review failed: ${response.status}`);
  const ms = performance.now() - review.started;
  await stop(review);
  return ms;
}

// A minimal Chrome DevTools Protocol client.
class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, (message: any) => void>();
  #listeners = new Set<(message: any) => void>();
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
      } else for (const listen of this.#listeners) listen(message);
    };
  }
  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise((done, fail) => ((ws.onopen = done), (ws.onerror = fail)));
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((done, fail) =>
      this.#pending.set(id, (message) =>
        message.error ? fail(new Error(`${method}: ${message.error.message}`)) : done(message.result),
      ),
    );
  }
  on(listen: (message: any) => void) {
    this.#listeners.add(listen);
    return () => this.#listeners.delete(listen);
  }
  close() {
    this.#ws.close();
  }
}

async function launchChromium() {
  const binary =
    process.env.CHROMIUM ??
    (await $`nix shell nixpkgs#chromium -c sh -c 'readlink -f $(command -v chromium)'`.text()).trim();
  const child = Bun.spawn(
    [
      binary,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(work, "chrome")}`,
      "--no-first-run",
      "--window-size=1600,1000",
      "--disable-gpu",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!/ws:\/\/\S+/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`chromium exited: ${text}`);
    text += new TextDecoder().decode(value);
  }
  void (async () => {
    while (!(await reader.read()).done);
  })();
  return { child, cdp: await Cdp.connect(text.match(/ws:\/\/\S+/)![0]) };
}

const RENDERED = `(() => {
  for (const host of document.querySelectorAll("diffs-container"))
    if (host.shadowRoot?.querySelector("[data-line]")) return true;
  return false;
})()`;

async function pageRun(cdp: Cdp) {
  const review = await startReview();
  const { browserContextId } = await cdp.send("Target.createBrowserContext");
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  // Script bytes over the wire, the page's and its workers'.
  const scripts = new Map<string, number>();
  const urls = new Set<string>();
  const off = cdp.on((message) => {
    const key = `${message.sessionId}:${message.params?.requestId}`;
    if (message.method === "Network.responseReceived") {
      const { type, response } = message.params;
      if (type === "Script" || /\.js(\?|$)/.test(response.url)) urls.add(key);
    } else if (message.method === "Network.loadingFinished") {
      if (urls.has(key)) scripts.set(key, message.params.encodedDataLength);
    } else if (message.method === "Target.attachedToTarget") {
      void cdp.send("Network.enable", {}, message.params.sessionId).catch(() => {});
      void cdp.send("Runtime.runIfWaitingForDebugger", {}, message.params.sessionId).catch(() => {});
    }
  });
  await cdp.send(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    sessionId,
  );
  const started = performance.now();
  await cdp.send("Page.navigate", { url: review.url }, sessionId);
  let rendered = 0;
  while (performance.now() - started < 30_000) {
    const { result } = await cdp.send(
      "Runtime.evaluate",
      { expression: RENDERED, returnByValue: true },
      sessionId,
    );
    if (result.value === true) {
      rendered = performance.now() - started;
      break;
    }
    await Bun.sleep(5);
  }
  if (!rendered) throw new Error("the page never drew a file");
  const scriptKb = [...scripts.values()].reduce((a, b) => a + b, 0) / 1024;
  // Settle, then the heap after a collection.
  await Bun.sleep(1500);
  await cdp.send("HeapProfiler.collectGarbage", {}, sessionId);
  const { usedSize } = await cdp.send("Runtime.getHeapUsage", {}, sessionId);
  const rss = peakRss(review.child.pid);
  off();
  await cdp.send("Target.closeTarget", { targetId });
  await cdp.send("Target.disposeBrowserContext", { browserContextId });
  await stop(review);
  return { rendered, scriptKb, heapMb: usedSize / 1024 / 1024, rss };
}

const cli: number[] = [];
const pages: Awaited<ReturnType<typeof pageRun>>[] = [];
try {
  await makeFixture();
  await cliRun(); // Warm the disk cache.
  for (let i = 0; i < runs; i++) cli.push(await cliRun());
  const chrome = await launchChromium();
  try {
    await pageRun(chrome.cdp);
    for (let i = 0; i < runs; i++) pages.push(await pageRun(chrome.cdp));
  } finally {
    chrome.cdp.close();
    chrome.child.kill();
    await chrome.child.exited;
  }
} finally {
  for (const child of live) child.kill();
  await Promise.all([...live].map((child) => child.exited));
  rmSync(work, { recursive: true, force: true });
}
const metrics = {
  cli_ms: median(cli),
  render_ms: median(pages.map((p) => p.rendered)),
  script_kb: median(pages.map((p) => p.scriptKb)),
  cli_rss_mb: median(pages.map((p) => p.rss)),
  heap_mb: median(pages.map((p) => p.heapMb)),
};
const baselineFile = join(root, ".hillclimb.baseline.json");
if (argv.includes("--baseline") || !existsSync(baselineFile))
  await Bun.write(baselineFile, JSON.stringify(metrics));
const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as typeof metrics;
const ratios = Object.entries(metrics).map(([key, value]) => value / baseline[key as keyof typeof metrics]);
const score = 100 * Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length);
console.log(
  JSON.stringify({
    score: Number(score.toFixed(1)),
    ...Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, Number(v.toFixed(1))])),
  }),
);
