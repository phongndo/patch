// Black-box checks of a `patchr review` server: start it on a scratch repo,
// talk HTTP like the page does, submit, and read stdout like an agent does.
// PATCHR is the command to test, for example "cli/target/release/patchr" or
// "bun src/cli.ts" (default).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const command = (process.env.PATCHR ?? "bun src/cli.ts").split(" ");
command[command.length - 1] =
  command.length === 1 ? resolve(command[0]!) : resolve(command[command.length - 1]!);

// The TypeScript server predates --local; it is always local.
const local = command.some((part) => part.endsWith("cli.ts")) ? [] : ["--local"];

let repo: string;
let state: string;

const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
  }).stdout.toString();

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "patch-contract-"));
  state = await mkdtemp(join(tmpdir(), "patch-state-"));
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "a.ts"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "gone.txt"), "bye\n");
  git("add", ".");
  git("commit", "-qm", "init");
  git("switch", "-qc", "feature");
  await writeFile(join(repo, "a.ts"), "one\nTWO\nthree\n");
  git("commit", "-qam", "change two");
  await writeFile(join(repo, "a.ts"), "one\nTWO\nthree\nfour\n");
  await writeFile(join(repo, "with space.txt"), "hello\n");
  // Removed from the index but back on disk: must show once.
  git("rm", "-q", "--cached", "gone.txt");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

async function start(...args: string[]) {
  const child = Bun.spawn([...command, "review", "--no-open", ...local, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      PATCH_BROWSER: "none",
      PATCH_PORT: "0",
      XDG_STATE_HOME: state,
      SSH_CONNECTION: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stderr.getReader();
  let text = "";
  while (!/Patch is open at (\S+)/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`patchr exited early: ${text}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const url = new URL(text.match(/Patch is open at (\S+)/)![1]!);
  const stdout = new Response(child.stdout).text();
  return { child, url, origin: url.origin, stdout };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("patchr review", () => {
  test("serves the review, guards every route, and returns feedback on stdout", async () => {
    const { child, origin, stdout } = await start();
    try {
      const review = await (await fetch(`${origin}/api/review`)).json();
      expect(review.repository).toStartWith("patch-contract-");
      expect(review.label).toBe("feature vs main");
      expect(review.scope).toEqual({ kind: "all" });
      expect(review.patch).toContain("+TWO");
      expect(review.patch).toContain("+four");
      expect(review.patch).toContain("with space.txt");
      const names = [...review.patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map(
        (m: RegExpMatchArray) => m[1],
      );
      expect(names.filter((name) => name === "gone.txt")).toHaveLength(0);
      expect(git("status", "--porcelain")).toContain("D  gone.txt"); // The index is untouched.

      // Context reads: a spaced path works, traversal and unknown files do not.
      const key = encodeURIComponent(review.scopeKey);
      const spaced = await fetch(
        `${origin}/api/file?key=${key}&side=new&path=${encodeURIComponent("with space.txt")}`,
      );
      expect(await spaced.text()).toBe("hello\n");
      const old = await fetch(`${origin}/api/file?key=${key}&side=old&path=a.ts`);
      expect(await old.text()).toBe("one\ntwo\nthree\n");
      expect((await fetch(`${origin}/api/file?key=${key}&side=new&path=..%2Fx`)).status).toBe(404);

      // Other origins, plain-text posts and unknown hosts are refused.
      expect((await post(`${origin}/api/submit`, {}, { origin: "http://evil.test" })).status).toBe(403);
      expect(
        (await fetch(`${origin}/api/submit`, { method: "POST", body: '{"decision":"approve"}' })).status,
      ).toBe(403);
      // Missing assets are 404, page routes are the page.
      expect((await fetch(`${origin}/a/missing.js`)).status).toBe(404);
      const page = await fetch(`${origin}/some/route`);
      expect(page.headers.get("content-type")).toContain("text/html");

      // Scopes: branches, the branch's commits, and one commit on its own.
      const scopes = await (await fetch(`${origin}/api/scopes`)).json();
      expect(scopes.base).toBe("main");
      expect(scopes.since).toBe("main");
      expect(scopes.branches).toEqual(expect.arrayContaining(["main", "feature"]));
      expect(scopes.commits.map((c: { subject: string }) => c.subject)).toEqual(["change two"]);
      const sha = scopes.commits[0].sha;
      const commit = await (await fetch(`${origin}/api/review?scope=commits&from=${sha}&to=${sha}`)).json();
      expect(commit.label).toBe(`Commit ${sha.slice(0, 7)}`);
      expect(commit.patch).toContain("+TWO");
      expect(commit.patch).not.toContain("+four");
      expect((await fetch(`${origin}/api/review?scope=commits&from=--output%3Dx&to=HEAD`)).status).toBe(422);

      // A draft saves and comes back with the next review.
      const draft = {
        comments: [
          {
            id: "c1",
            file: "a.ts",
            side: "additions",
            start: 2,
            end: 2,
            body: "Lowercase this.",
            excerpt: ["TWO"],
          },
        ],
        note: "Close.",
        viewed: [],
      };
      expect(
        (
          await fetch(`${origin}/api/draft?key=${review.draftKey}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(draft),
          })
        ).ok,
      ).toBe(true);
      const again = await (await fetch(`${origin}/api/review?scope=uncommitted`)).json();
      expect(again.draft.comments[0].body).toBe("Lowercase this.");
      expect(again.label).toBe("feature · uncommitted");

      expect(
        (await post(`${origin}/api/submit?key=${review.draftKey}`, { decision: "comment", ...draft })).ok,
      ).toBe(true);
      const out = await stdout;
      expect(await child.exited).toBe(0);
      expect(out).toContain("# Review feedback (patch-contract-");
      expect(out).toContain("### a.ts:2");
      expect(out).toContain("```ts\nTWO\n```");
      expect(out).toContain("Lowercase this.");
      expect(out).toContain("## General\n\n- Close.");
      expect(existsSync(join(state, "patch", "drafts", `${review.draftKey}.json.submitted`))).toBe(true);
    } finally {
      child.kill();
    }
  }, 20_000);

  test("approval with nothing to say is one line", async () => {
    const { child, origin, stdout } = await start("--uncommitted");
    try {
      await post(`${origin}/api/submit`, { decision: "approve", comments: [], note: "", viewed: [] });
      expect((await stdout).trim()).toBe(
        "The user reviewed the changes in Patch and approved them with no comments.",
      );
    } finally {
      child.kill();
    }
  });

  test("settings are saved for the next review and written into the page", async () => {
    const first = await start("--uncommitted");
    try {
      const saved = await fetch(`${first.origin}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ colorScheme: "dark", sidebarSide: "right" }),
      });
      expect(saved.ok).toBe(true);
      const bad = await fetch(`${first.origin}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "[1, 2]",
      });
      expect(bad.status).toBe(400);
    } finally {
      first.child.kill();
    }
    const second = await start("--uncommitted");
    try {
      expect(await (await fetch(`${second.origin}/api/settings`)).json()).toEqual({
        colorScheme: "dark",
        sidebarSide: "right",
      });
      const page = await (await fetch(`${second.origin}/`)).text();
      expect(page).toContain('window.__PATCH_SETTINGS__={"colorScheme":"dark","sidebarSide":"right"}');
    } finally {
      second.child.kill();
    }
  });

  test("a page that leaves ends the review as closed, not approved, and drops the draft", async () => {
    const { child, origin, stdout } = await start("--uncommitted");
    const review = await (await fetch(`${origin}/api/review`)).json();
    await fetch(`${origin}/api/draft?key=${review.draftKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comments: [], note: "", viewed: ["a.ts"] }),
    });
    const draft = join(state, "patch", "drafts", `${review.draftKey}.json`);
    expect(existsSync(draft)).toBe(true);
    try {
      const live = new AbortController();
      const stream = await fetch(`${origin}/api/live`, { signal: live.signal });
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      await post(`${origin}/api/leave`, {});
      live.abort();
      const started = performance.now();
      expect(await stdout).toContain("closed without feedback");
      expect(performance.now() - started).toBeLessThan(15_000);
      await child.exited;
      expect(existsSync(draft)).toBe(false);
    } finally {
      child.kill();
    }
  }, 20_000);

  test("an adapter's review finds the repository near a file, and closing it prints nothing", async () => {
    const other = await mkdtemp(join(tmpdir(), "patch-other-"));
    Bun.spawnSync(["git", "init", "-q", other]);
    const near = join(other, "not", "yet", "here.ts");
    const { child, origin, stdout } = await start("--typed", "--uncommitted", "--near", near);
    try {
      const review = await (await fetch(`${origin}/api/review`)).json();
      expect(review.repository).toStartWith("patch-other-");
      expect(review.scope).toEqual({ kind: "uncommitted" });
      const live = new AbortController();
      await fetch(`${origin}/api/live`, { signal: live.signal });
      await post(`${origin}/api/leave`, {});
      live.abort();
      expect(await stdout).toBe("");
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
      await rm(other, { recursive: true, force: true });
    }
  }, 20_000);

  test("what the user typed cannot reach an adapter's flags", async () => {
    for (const typed of ["--base", "--near x", "--codex t", "'unmatched"]) {
      const child = Bun.spawnSync([...command, "review", "--typed", typed, "--near", repo], {
        cwd: repo,
        env: { ...process.env, XDG_STATE_HOME: state },
      });
      expect(child.exitCode).toBe(2);
      expect(child.stdout.toString()).toBe("");
    }
  });

  test("the draft holds submitted feedback until the adapter delivers it", async () => {
    const submission = { decision: "comment", comments: [], note: "Keep me.", viewed: [] };
    const { child, origin, stdout } = await start("--typed", "--uncommitted");
    await post(`${origin}/api/submit`, submission);
    const { receipt, text } = JSON.parse(await stdout);
    expect(text).toContain("Keep me.");
    await child.exited;

    // Never delivered: the next review brings it back.
    const again = await start("--typed", "--uncommitted");
    const review = await (await fetch(`${again.origin}/api/review`)).json();
    again.child.kill();
    expect(review.draftKey).toBe(receipt);
    expect(review.draft.note).toBe("Keep me.");

    const draft = join(state, "patch", "drafts", `${receipt}.json`);
    const delivered = (key: string) =>
      Bun.spawnSync([...command, "hook", "delivered", key], {
        env: { ...process.env, XDG_STATE_HOME: state },
      });
    delivered("../drafts/x");
    expect(existsSync(draft)).toBe(true);
    delivered(receipt);
    expect(existsSync(draft)).toBe(false);
    expect(existsSync(`${draft}.submitted`)).toBe(true);
  }, 20_000);

  test("Codex: one review per thread, and no feedback is lost", async () => {
    const thread = crypto.randomUUID();
    const bin = await mkdtemp(join(tmpdir(), "patch-bin-"));
    await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PATCH_BROWSER: "none",
      PATCH_PORT: "0",
      XDG_STATE_HOME: state,
      SSH_CONNECTION: "",
    };
    const hook = async (prompt: string) => {
      const child = Bun.spawn([...command, "hook", "codex"], {
        cwd: repo,
        env,
        stdin: new Blob([JSON.stringify({ session_id: thread, prompt, cwd: repo })]),
        stdout: "pipe",
      });
      const text = await new Response(child.stdout).text();
      return text ? JSON.parse(text) : undefined;
    };
    const open = async () => {
      const { decision, reason } = await hook("$patch --no-open --local");
      expect(decision).toBe("block");
      return reason as string;
    };
    const url = (reason: string) => reason.match(/http\S+/)![0];
    const kept = async () =>
      (await readdir(join(state, "patch", "codex"))).filter((file) => file.endsWith(".md")).length;
    try {
      // Two at once still open one page.
      const [first, second] = await Promise.all([open(), open()]);
      expect(url(first)).toBe(url(second));
      expect([first, second].filter((reason) => reason.includes("already open")).length).toBe(1);

      // A review that died is not taken for an open one.
      const port = new URL(url(first)).port;
      Bun.spawnSync(["pkill", "-9", "-f", `codex ${thread}`]);
      const squatter = Bun.serve({
        port: Number(port),
        hostname: "127.0.0.1",
        fetch: () => new Response(""),
      });
      let reason = await open();
      squatter.stop(true);
      expect(reason).not.toContain("already");
      expect(url(reason)).not.toBe(url(first));

      for (const [index, note] of ["FIRST", "SECOND"].entries()) {
        if (index > 0) reason = await open();
        await post(`${url(reason)}api/submit`, { decision: "comment", comments: [], note, viewed: [] });
        for (let i = 0; i < 100 && (await kept()) <= index; i++) await Bun.sleep(50);
      }
      const context = (await hook("Continue.")).hookSpecificOutput.additionalContext as string;
      expect(context.indexOf("FIRST")).toBeGreaterThan(-1);
      expect(context.indexOf("SECOND")).toBeGreaterThan(context.indexOf("FIRST"));
      expect(await hook("Continue.")).toBeUndefined();
      expect(await kept()).toBe(0);
    } finally {
      Bun.spawnSync(["pkill", "-9", "-f", `codex ${thread}`]);
      await rm(bin, { recursive: true, force: true });
    }
  }, 30_000);

  test("an open page hears when the repository changes", async () => {
    const { child, origin } = await start("--uncommitted");
    try {
      const live = new AbortController();
      const stream = await fetch(`${origin}/api/live`, { signal: live.signal });
      const reader = stream.body!.getReader();
      // Let the first check record the current state, then change a file that is already modified.
      await Bun.sleep(3500);
      await writeFile(join(repo, "a.ts"), "one\nTWO\nthree\nfour\nfive\n");
      let text = "";
      const deadline = Date.now() + 10_000;
      while (!text.includes("event: changed") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      live.abort();
      expect(text).toContain("event: changed");
      await writeFile(join(repo, "a.ts"), "one\nTWO\nthree\nfour\n");
    } finally {
      child.kill();
    }
  }, 20_000);

  test("on the base branch, the commits are its recent history", async () => {
    const saved = repo;
    repo = await mkdtemp(join(tmpdir(), "patch-contract-main-"));
    try {
      git("init", "-q", "-b", "main");
      await writeFile(join(repo, "a.txt"), "1\n");
      git("add", ".");
      git("commit", "-qm", "first");
      await writeFile(join(repo, "a.txt"), "2\n");
      git("commit", "-qam", "second");
      const { child, origin } = await start();
      try {
        const scopes = await (await fetch(`${origin}/api/scopes`)).json();
        expect(scopes.base).toBe("main");
        expect(scopes.since).toBeUndefined();
        expect(scopes.commits.map((c: { subject: string }) => c.subject)).toEqual(["second", "first"]);
        const sha = scopes.commits[1].sha;
        const root = await (await fetch(`${origin}/api/review?scope=commits&from=${sha}&to=${sha}`)).json();
        expect(root.patch).toContain("+1"); // The first commit diffs against the empty tree.
      } finally {
        child.kill();
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
      repo = saved;
    }
  });

  test("a bad base fails before serving", async () => {
    const child = Bun.spawn([...command, "review", "--no-open", ...local, "--base", "nope"], {
      cwd: repo,
      env: { ...process.env, PATCH_BROWSER: "none", XDG_STATE_HOME: state },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("not a commit");
  });
});
