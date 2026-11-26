// Black-box checks of a `patchr review` server: start it on a scratch repo,
// talk HTTP like the page does, submit, and read stdout like an agent does.
// PATCHR is the command to test, for example "cli/target/release/patchr" or
// "bun src/cli.ts" (default).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type { Comment } from "../src/protocol.ts";
import { feedbackText } from "../web/feedback.ts";

const command = (process.env.PATCHR ?? "bun src/cli.ts").split(" ");
command[command.length - 1] =
  command.length === 1 ? resolve(command[0]!) : resolve(command[command.length - 1]!);

// The TypeScript server predates --local; it is always local.
const local = command.some((part) => part.endsWith("cli.ts")) ? [] : ["--local"];

// A development build hurries through its waits; a release build does not.
const hurry = command[0]!.includes("/debug/");

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
      PATCH_TEST_HURRY: "1",
      XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: state,
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

const globalComment = (body: string): Comment => ({
  id: "g",
  file: "",
  side: "additions",
  start: 0,
  end: 0,
  body,
  excerpt: [],
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("patchr review", () => {
  test("a review writes nothing to the repository", async () => {
    git("config", "core.splitIndex", "true");
    git("status"); // settles what Git itself would refresh
    const files = async () => {
      const paths = Array.from(new Bun.Glob("**/*").scanSync({ cwd: repo, dot: true, onlyFiles: true }));
      const bytes = paths
        .toSorted()
        .map(async (path) => [path, Bun.hash(await Bun.file(join(repo, path)).bytes())]);
      return Promise.all(bytes);
    };
    const before = await files();
    const { child, origin } = await start();
    const review = await (await fetch(`${origin}/api/review`)).json();
    expect(review.patch).toContain("with space.txt"); // untracked, so it went through the index
    child.kill();
    await child.exited;
    git("config", "--unset", "core.splitIndex");
    const after = await files();
    const config = ([path]: unknown[]) => path !== ".git/config";
    expect(after.filter(config)).toEqual(before.filter(config));
  });

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

      // Unchanged files are read from the base commit; changed, untracked and unknown ones are not served.
      expect(await (await fetch(`${origin}/api/unchanged?key=${key}`)).json()).toEqual(["gone.txt"]);
      const whole = (path: string) =>
        fetch(`${origin}/api/unchanged/file?key=${key}&path=${encodeURIComponent(path)}`);
      expect(await (await whole("gone.txt")).text()).toBe("bye\n");
      for (const path of ["a.ts", "with space.txt", "../x", ".git/config"])
        expect((await whole(path)).status).toBe(404);
      expect((await fetch(`${origin}/api/unchanged?key=nope`)).status).toBe(422);

      // Grep reads only what the page may open: the changed files as they are now, and the
      // others as reviewed. Capitals match only capitals.
      const grep = async (q: string) =>
        (await fetch(`${origin}/api/grep?key=${key}&q=${encodeURIComponent(q)}`)).json();
      expect(await grep("bye")).toEqual([{ file: "gone.txt", line: 1, text: "bye" }]);
      expect(await grep("two")).toEqual([{ file: "a.ts", line: 2, text: "TWO" }]);
      expect(await grep("hello")).toEqual([{ file: "with space.txt", line: 1, text: "hello" }]);
      expect(await grep("BYE")).toEqual([]);
      expect(await grep("b")).toEqual([]);
      expect(await grep("--output=x")).toEqual([]);

      // Other origins, plain-text posts and unknown hosts are refused.
      expect((await post(`${origin}/api/submit`, {}, { origin: "http://evil.test" })).status).toBe(403);
      expect((await fetch(`${origin}/api/submit`, { method: "POST", body: '{"comments":[]}' })).status).toBe(
        403,
      );
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

      // Every view of one run is the same session; the server keeps no comments.
      const again = await (await fetch(`${origin}/api/review?scope=uncommitted`)).json();
      expect(again.label).toBe("feature · uncommitted");
      expect(again.session).toBe(review.session);
      expect(Object.keys(again)).not.toContain("draft");
      expect((await fetch(`${origin}/api/draft?key=x`, { method: "PUT" })).ok).toBe(false);

      const comments: Comment[] = [
        {
          id: "c1",
          file: "b.ts",
          side: "deletions",
          start: 4,
          end: 5,
          body: "Why gone?\nIt was used.",
          excerpt: ["```", "x"],
          scope: "PR #1",
        },
        {
          id: "c2",
          file: "a.ts",
          side: "additions",
          start: 2,
          end: 2,
          body: "Lowercase this.",
          excerpt: ["TWO"],
        },
        globalComment("Close.\nBut not there."),
        { id: "c4", file: "Makefile", side: "additions", start: 1, end: 1, body: " ", excerpt: [] },
        {
          id: "c5",
          file: "a.ts",
          side: "deletions",
          start: 0,
          end: 0,
          body: "Split this file.",
          excerpt: [],
        },
      ];
      expect((await post(`${origin}/api/submit`, { comments })).ok).toBe(true);
      const out = await stdout;
      expect(await child.exited).toBe(0);
      expect(out).toContain("# Review feedback (patch-contract-");
      expect(out).toContain("### 2. a.ts (the whole file)\n\nSplit this file.");
      expect(out).toContain("### 3. a.ts:2");
      expect(out).toContain("### 4. b.ts:4-5 (old side, removed lines) (in PR #1)");
      expect(out).toContain("```ts\nTWO\n```");
      expect(out).toContain("Lowercase this.");
      expect(out).toContain("## Global\n\n1. Close.\n   But not there.");
      // A page that lost its review copies the same text, but not where the repository is.
      const copied = feedbackText(comments, review.repository);
      expect(copied).toBe(out.trim().replace(/^Paths are relative to .*\n/m, ""));
      // It was read, so nothing of it stays behind.
      expect(existsSync(join(state, "patch", "unsent"))).toBe(false);
    } finally {
      child.kill();
    }
  }, 20_000);

  test("a review with nothing to say passed, in one line, and a malformed one did not", async () => {
    const { child, origin, stdout } = await start("--uncommitted");
    try {
      expect((await post(`${origin}/api/submit`, {})).status).toBe(400);
      await post(`${origin}/api/submit`, { comments: [] });
      expect((await stdout).trim()).toBe(
        "The user reviewed the changes in Patch and has no comments. The review passed.",
      );
    } finally {
      child.kill();
    }
  });

  test("in an adapter a pass sends nothing, so no turn starts, and stderr says it passed", async () => {
    const { child, origin, stdout } = await start("--typed", "--uncommitted");
    try {
      await post(`${origin}/api/submit`, { comments: [] });
      expect(await stdout).toBe("");
      let stderr = "";
      for await (const piece of child.stderr) stderr += new TextDecoder().decode(piece);
      expect(stderr).toContain("The review passed.");
      expect(await child.exited).toBe(0);
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

  test("the page's script comes as the browser takes it, and the same whichever way", async () => {
    const review = await start("--uncommitted");
    try {
      const page = await (await fetch(`${review.origin}/`)).text();
      const script = page.match(/src="(\/a\/[^"]+\.js)"/)?.[1];
      if (!script) return; // A page built for the tests alone has no script.
      const get = async (encoding: string) => {
        const response = await fetch(`${review.origin}${script}`, {
          headers: { "accept-encoding": encoding },
          decompress: false,
        });
        expect(response.ok).toBe(true);
        expect(response.headers.get("vary")).toBe("accept-encoding");
        expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        const bytes = Buffer.from(await response.arrayBuffer());
        const coding = response.headers.get("content-encoding");
        const decode = coding === "br" ? brotliDecompressSync : coding === "gzip" ? gunzipSync : Buffer.from;
        const text = decode(bytes).toString();
        return { coding, text };
      };
      const plain = await get("identity");
      expect(plain.coding).toBeNull();
      // A release build serves the copies Vite compressed; a development build gzips as it goes.
      for (const [offered, allowed] of [
        ["br, gzip", hurry ? ["gzip"] : ["br"]],
        ["gzip", ["gzip"]],
        ["br;q=0, gzip", ["gzip"]],
        ["br", hurry ? [null] : ["br"]],
      ] as const) {
        const answer = await get(offered);
        expect(allowed as readonly (string | null)[]).toContain(answer.coding);
        expect(answer.text).toBe(plain.text);
      }
    } finally {
      review.child.kill();
    }
  });

  test("a repository whose path holds a newline shows its untracked files", async () => {
    const parent = await mkdtemp(join(tmpdir(), "patch-new\nline-"));
    try {
      const odd = join(parent, "repo");
      const run = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: odd });
      await Bun.write(join(odd, "kept.txt"), "kept\n");
      run("init", "-q", "-b", "main");
      run("add", ".");
      run("commit", "-qm", "init");
      await writeFile(join(odd, "fresh.txt"), "fresh\n");
      const review = await start(odd, "--uncommitted");
      try {
        const body = (await (await fetch(`${review.origin}/api/review`)).json()) as { patch: string };
        expect(body.patch).toContain("+++ b/fresh.txt");
      } finally {
        review.child.kill();
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  /** An open page: its stream, held until it drops. Bun closes one that nothing refers to. */
  const visit = async (origin: string, page: string) => {
    const gone = new AbortController();
    const stream = await fetch(`${origin}/api/live?page=${page}`, { signal: gone.signal });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    await reader.read();
    return async () => {
      gone.abort();
      await reader.read().catch(() => {});
      await Bun.sleep(100); // until the server saw it
    };
  };
  const leave = (origin: string, page: string, unsent = false) =>
    post(`${origin}/api/leave?page=${page}${unsent ? "&unsent=1" : ""}`, {});
  const soon = 2000;
  const alive = async (child: { exited: Promise<number> }, ms = soon) =>
    (await Promise.race([child.exited.then(() => "ended"), Bun.sleep(ms).then(() => "alive")])) === "alive";

  // Waiting, mostly: these run at once.
  for (const order of ["its stream drops first", "it says so first"])
    test.concurrent(`a closed tab ends its review at once, not approved: ${order}`, async () => {
      const { child, origin, stdout } = await start("--uncommitted");
      try {
        const drop = await visit(origin, "a");
        if (order.startsWith("its")) await drop();
        await leave(origin, "a");
        const started = performance.now();
        if (order.startsWith("it ")) await drop();
        expect(await stdout).toContain("closed without feedback");
        expect(performance.now() - started).toBeLessThan(soon);
        await child.exited;
      } finally {
        child.kill();
      }
    }, 20_000);

  test.concurrent("a tab closed before it connected ends its review at once", async () => {
    const { child, origin } = await start("--uncommitted");
    try {
      await (await fetch(origin)).text();
      await leave(origin, "a");
      expect(await alive(child)).toBe(false);
    } finally {
      child.kill();
    }
  }, 20_000);

  test.concurrent("a reload keeps its review, and closing the page it brought ends it", async () => {
    const { child, origin } = await start("--uncommitted");
    try {
      // As a browser does it: the new page is asked for, then the old one goes.
      await (await fetch(origin)).text();
      const first = await visit(origin, "a");
      await (await fetch(origin)).text();
      await first();
      await leave(origin, "a");
      expect(await alive(child)).toBe(true);
      const second = await visit(origin, "b");
      await second();
      await leave(origin, "b");
      expect(await alive(child)).toBe(false);
    } finally {
      child.kill();
    }
  }, 20_000);

  test.concurrent("a tab closed with comments unsent can be opened again", async () => {
    const { child, origin } = await start("--uncommitted");
    try {
      const first = await visit(origin, "a");
      await first();
      await leave(origin, "a", true);
      // Longer than a tab with nothing unsent gets.
      expect(await alive(child, hurry ? 650 : 5000)).toBe(true);
      await (await fetch(origin)).text();
      await visit(origin, "b");
      expect(await alive(child, hurry ? soon : 9000)).toBe(true);
    } finally {
      child.kill();
    }
  }, 30_000);

  test.concurrent("a page that goes quiet keeps its review, also after another page was closed", async () => {
    const { child, origin } = await start("--uncommitted");
    try {
      const [first, second] = [await visit(origin, "a"), await visit(origin, "b")];
      await first();
      await leave(origin, "a");
      await second();
      expect(await alive(child, hurry ? soon : 10_000)).toBe(true);
      const back = await visit(origin, "b");
      await back();
      await leave(origin, "b");
      expect(await alive(child)).toBe(false);
    } finally {
      child.kill();
    }
  }, 30_000);

  test.concurrent("a review whose page is lost is opened again, and an open one is not", async () => {
    const opened = join(state, `opened-${crypto.randomUUID()}`);
    const browser = `${opened}.sh`;
    await writeFile(browser, `#!/bin/sh\necho "$1" >> '${opened}'\n`, { mode: 0o755 });
    // Over SSH, it would open none.
    const env = { ...process.env, PATCH_BROWSER: browser, PATCH_TEST_HURRY: "1", SSH_CONNECTION: undefined };
    const child = Bun.spawn([...command, "review", ...local], {
      cwd: repo,
      env: { ...env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      let said = "";
      for await (const chunk of child.stderr) {
        said += new TextDecoder().decode(chunk);
        if (/open at \S+\s/.test(said)) break;
      }
      const url = said.match(/open at (\S+)/)![1]!;
      const times = async () => {
        await Bun.sleep(300);
        return (
          await Bun.file(opened)
            .text()
            .catch(() => "")
        )
          .split("\n")
          .filter(Boolean).length;
      };
      const reopen = () => Bun.spawn([...command, "hook", "reopen", url], { env }).exited;
      await reopen();
      expect(await times()).toBe(1); // still on its way
      const drop = await visit(url.slice(0, -1), "a");
      await Bun.sleep(hurry ? 1200 : 11_000);
      await reopen();
      expect(await times()).toBe(1);
      await drop();
      await reopen();
      expect(await times()).toBe(2);
    } finally {
      child.kill();
    }
  }, 30_000);

  test.concurrent("an adapter's review finds the repository near a file, and closing it prints nothing", async () => {
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

  test.concurrent("an open page hears when the repository changes", async () => {
    const { child, origin } = await start("--uncommitted");
    try {
      const live = new AbortController();
      const stream = await fetch(`${origin}/api/live`, { signal: live.signal });
      const reader = stream.body!.getReader();
      // Let the first check record the current state, then change a file that is already modified.
      await Bun.sleep(hurry ? 500 : 3500);
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

  test("what the user typed cannot reach an adapter's flags", async () => {
    for (const typed of ["--base", "--near x", "--codex t", "'unmatched"]) {
      const child = Bun.spawnSync([...command, "review", "--typed", typed, "--near", repo], {
        cwd: repo,
        env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state },
      });
      expect(child.exitCode).toBe(2);
      expect(child.stdout.toString()).toBe("");
    }
  });

  test("submitted feedback is kept until the adapter delivers it, and never comes back as comments", async () => {
    const submission = { comments: [globalComment("Keep me.")] };
    const { child, origin, stdout } = await start("--typed", "--uncommitted");
    await post(`${origin}/api/submit`, submission);
    const { receipt, text, file } = JSON.parse(await stdout);
    expect(text).toContain("Keep me.");
    await child.exited;

    expect(file).toBe(join(state, "patch", "unsent", `${receipt}.md`));
    expect(await Bun.file(file).text()).toContain("Keep me.");
    expect((await stat(join(file, ".."))).mode & 0o077).toBe(0);
    // The next review knows nothing of it.
    const again = await start("--typed", "--uncommitted");
    expect(await (await fetch(`${again.origin}/api/review`)).text()).not.toContain("Keep me.");
    again.child.kill();

    const delivered = (key: string) =>
      Bun.spawnSync([...command, "hook", "delivered", key], {
        env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state },
      });
    delivered(`../unsent/${receipt}`);
    delivered("x/../../unsent/../../x1x");
    expect(existsSync(file)).toBe(true);
    delivered(receipt);
    expect(existsSync(file)).toBe(false);
  }, 20_000);

  test("a review ends once: a second submission is told so", async () => {
    const { child, origin, stdout } = await start("--uncommitted");
    try {
      const submission = { comments: [globalComment("Once.")] };
      const [first, second] = await Promise.all([
        post(`${origin}/api/submit`, submission),
        post(`${origin}/api/submit`, submission),
      ]);
      expect([first.status, second.status].toSorted()).toEqual([200, 409]);
      expect((await stdout).match(/Once\./g)).toHaveLength(1);
    } finally {
      child.kill();
    }
  });

  test("feedback nobody reads any more is kept, and stderr says where", async () => {
    const child = Bun.spawn(
      ["sh", "-c", `"$0" review --no-open ${local.join(" ")} --uncommitted | true`, command.at(-1)!],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATCH_BROWSER: "none",
          PATCH_PORT: "0",
          XDG_STATE_HOME: state,
          XDG_CONFIG_HOME: state,
          SSH_CONNECTION: "",
        },
        stderr: "pipe",
      },
    );
    const reader = child.stderr.getReader();
    let text = "";
    const until = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`ended without ${pattern}: ${text}`);
        text += new TextDecoder().decode(value);
      }
      return text.match(pattern)![1]!;
    };
    const origin = new URL(await until(/open at (\S+)/)).origin;
    await post(`${origin}/api/submit`, { comments: [globalComment("Nobody reads.")] });
    const file = await until(/kept in (\S+)/);
    expect(await Bun.file(file).text()).toContain("Nobody reads.");
    await child.exited;
  }, 20_000);

  test("Codex: one review per thread, and no feedback is lost", async () => {
    const thread = crypto.randomUUID();
    const bin = await mkdtemp(join(tmpdir(), "patch-bin-"));
    // Refuses every message, so it is kept; and notes each call, so a pass can be seen to make none.
    await writeFile(join(bin, "codex"), `#!/bin/sh\necho "$1" >> "${bin}/calls"\nexit 1\n`, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PATCH_BROWSER: "none",
      PATCH_PORT: "0",
      XDG_STATE_HOME: state,
      XDG_CONFIG_HOME: state,
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
        await post(`${url(reason)}api/submit`, { comments: [globalComment(note)] });
        for (let i = 0; i < 100 && (await kept()) <= index; i++) await Bun.sleep(50);
      }
      const context = (await hook("Continue.")).hookSpecificOutput.additionalContext as string;
      expect(context.indexOf("FIRST")).toBeGreaterThan(-1);
      expect(context.indexOf("SECOND")).toBeGreaterThan(context.indexOf("FIRST"));
      expect(await hook("Continue.")).toBeUndefined();
      expect(await kept()).toBe(0);

      // A pass queues nothing: the thread gets no turn.
      const calls = async () => (await Bun.file(join(bin, "calls")).text()).split("\n").filter(Boolean);
      const before = (await calls()).length;
      reason = await open();
      await post(`${url(reason)}api/submit`, { comments: [] });
      const ended = () =>
        fetch(url(reason)).then(
          () => false,
          () => true,
        );
      for (let i = 0; i < 100 && !(await ended()); i++) await Bun.sleep(50);
      expect(await ended()).toBe(true);
      expect((await calls()).length).toBe(before);
      expect(await kept()).toBe(0);
    } finally {
      Bun.spawnSync(["pkill", "-9", "-f", `codex ${thread}`]);
      await rm(bin, { recursive: true, force: true });
    }
  }, 30_000);

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

  // 127.0.0.2 stands in for the tailnet address, and a fake `tailscale` for Tailscale.
  const tailnetTestable = (() => {
    if (local.length === 0) return false;
    try {
      Bun.listen({ hostname: "127.0.0.2", port: 0, socket: { data() {} } }).stop(true);
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!tailnetTestable)("on a tailnet, the link lets in its owner's devices alone", async () => {
    const bin = await mkdtemp(join(tmpdir(), "patch-tailscale-"));
    const whois = join(bin, "whois.json");
    await writeFile(
      join(bin, "tailscale"),
      `#!/bin/sh
case "$1" in
status) printf '{"BackendState":"Running","Self":{"DNSName":"box.tail.ts.net.","UserID":1,"Tags":%s,"TailscaleIPs":["127.0.0.2"]}}' "\${FAKE_TAGS:-null}";;
whois) cat '${whois}';;
esac
`,
      { mode: 0o755 },
    );
    const children: Bun.Subprocess[] = [];
    const review = async (tags = "null") => {
      const child = Bun.spawn([...command, "review", "--no-open"], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_TAGS: tags,
          PATCH_BROWSER: "none",
          PATCH_PORT: "0",
          XDG_STATE_HOME: state,
          XDG_CONFIG_HOME: state,
          SSH_CONNECTION: "",
          PATCH_REMOTE: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      children.push(child);
      // Both lines, then the stream is let go of, not cancelled: patchr still writes to it.
      const reader = child.stderr.getReader();
      let said = "";
      while (!/on this machine it is also at \S+\n/.test(said)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`patchr exited early: ${said}`);
        said += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const link = new URL(said.match(/open at (\S+)/)![1]!);
      const local = new URL(said.match(/on this machine it is also at (\S+)/)![1]!);
      return { child, link, local, port: Number(link.port) };
    };
    // Raw HTTP, so the Host header and the address it reaches are the test's.
    const ask = async (
      port: number,
      path: string,
      headers: Record<string, string> = {},
      ip = "127.0.0.2",
      from?: string,
    ) => {
      const { request } = await import("node:http");
      return new Promise<{ status: number; cookie: string; body: string }>((done, fail) => {
        const req = request(
          {
            host: ip,
            port,
            path,
            localAddress: from,
            headers: { host: `box.tail.ts.net:${port}`, ...headers },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              done({
                status: res.statusCode!,
                cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0]!,
                body,
              }),
            );
          },
        );
        req.on("error", fail);
        req.end();
      });
    };
    try {
      const first = await review();
      const { link, port } = first;
      const secret = link.searchParams.get("t")!;
      expect(link.hostname).toBe("box.tail.ts.net");

      // Loopback, at the same port, takes the link too: other users of the machine reach it.
      const loopback = { host: `127.0.0.1:${port}` };
      expect(first.local.port).toBe(String(port));
      expect(first.local.searchParams.get("t")).toBe(secret);
      expect((await ask(port, "/api/review", loopback, "127.0.0.1")).status).toBe(403);
      expect((await ask(port, "/api/reopen", loopback, "127.0.0.1")).status).toBe(200);
      const here = await ask(port, `/?t=${secret}`, loopback, "127.0.0.1");
      expect(here.status).toBe(303);
      expect((await ask(port, "/api/review", { ...loopback, cookie: here.cookie }, "127.0.0.1")).status).toBe(
        200,
      );

      // Another account's device, or a tagged one, can't trade the link, nor use it as the cookie.
      for (const other of [
        '{"Node":{},"UserProfile":{"ID":2}}',
        '{"Node":{"Tags":["tag:ci"]},"UserProfile":{"ID":1}}',
        "",
      ]) {
        await writeFile(whois, other);
        const traded = await ask(port, `/?t=${secret}`);
        expect(traded.status).toBe(403);
        expect(traded.cookie).toBe("");
      }
      expect((await ask(port, "/api/review", { cookie: `patch_session_${port}=${secret}` })).status).toBe(
        403,
      );

      // The owner's device trades it for a pass that works only with this machine's names.
      await writeFile(whois, '{"Node":{},"UserProfile":{"ID":1}}');
      const traded = await ask(port, `/?t=${secret}`);
      expect(traded.status).toBe(303);
      expect(traded.cookie).toStartWith(`patch_session_${port}=`);
      expect(traded.cookie).not.toContain(secret);
      expect((await ask(port, "/api/review")).status).toBe(403);
      expect((await ask(port, "/api/review", { cookie: traded.cookie })).status).toBe(200);
      // From another address the same pass is no good.
      const elsewhere = await ask(port, "/api/review", { cookie: traded.cookie }, "127.0.0.2", "127.0.0.3");
      expect(elsewhere.status).toBe(403);
      expect(
        (await ask(port, "/api/review", { cookie: traded.cookie, host: `127.0.0.1:${port}` })).status,
      ).toBe(403);
      expect((await ask(port, "/api/review", { cookie: traded.cookie, host: `evil:${port}` })).status).toBe(
        403,
      );
      expect((await ask(port, `/?t=wrong`)).status).toBe(403);
      const foreign = await ask(port, `/?t=${secret}`, { origin: "http://other.invalid" });
      expect(foreign.status).toBe(403);
      expect(foreign.cookie).toBe("");

      // Nothing from one review opens the next. A tagged machine lets any device trade its link.
      const second = await review('["tag:ci"]');
      await writeFile(whois, '{"Node":{},"UserProfile":{"ID":2}}');
      expect((await ask(second.port, "/api/review", { cookie: traded.cookie })).status).toBe(403);
      expect((await ask(second.port, `/?t=${secret}`)).status).toBe(403);
      const next = await ask(second.port, `/?t=${second.link.searchParams.get("t")}`);
      expect(next.status).toBe(303);
      expect((await ask(second.port, "/api/review", { cookie: next.cookie })).status).toBe(200);
      // One browser holds both, as cookies go by host and not by port.
      const jar = `${traded.cookie}; ${next.cookie}`;
      expect((await ask(port, "/api/review", { cookie: jar })).status).toBe(200);
      expect((await ask(second.port, "/api/review", { cookie: jar })).status).toBe(200);
    } finally {
      for (const child of children) child.kill();
      await rm(bin, { recursive: true, force: true });
    }
  });

  test("a bad base fails before serving", async () => {
    const child = Bun.spawn([...command, "review", "--no-open", ...local, "--base", "nope"], {
      cwd: repo,
      env: { ...process.env, PATCH_BROWSER: "none", XDG_STATE_HOME: state, XDG_CONFIG_HOME: state },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("not a commit");
  });
});
