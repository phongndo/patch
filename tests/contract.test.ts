// Black-box checks of a `patchr review` server: start it on a scratch repo,
// talk HTTP like the page does, submit, and read stdout like an agent does.
// PATCHR is the command to test, for example "cli/target/release/patchr" or
// "bun src/cli.ts" (default).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      expect(out).toContain("## Overall\n\nClose.");
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

  test("a page that leaves ends the review as closed, not approved", async () => {
    const { child, origin, stdout } = await start("--uncommitted");
    try {
      const live = new AbortController();
      const stream = await fetch(`${origin}/api/live`, { signal: live.signal });
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      await post(`${origin}/api/leave`, {});
      live.abort();
      const started = performance.now();
      expect(await stdout).toContain("closed without feedback");
      expect(performance.now() - started).toBeLessThan(15_000);
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
