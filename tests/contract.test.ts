// Black-box checks of a `patchr review` server: start it on a scratch repo,
// talk HTTP like the page does, submit, and read stdout like an agent does.
// PATCHR is the command to test, for example "cli/target/release/patchr" or
// "bun src/cli.ts" (default).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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

const start = (...args: string[]) => startWith({}, ...args);

async function startWith(env: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn([...command, "review", "--no-open", ...local, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      ...env,
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

      // Scopes: branches; then the history, and one commit on its own.
      const scopes = await (await fetch(`${origin}/api/scopes`)).json();
      expect(scopes.base).toBe("main");
      expect(scopes.branches).toEqual(expect.arrayContaining(["main", "feature"]));
      const listed = await (await fetch(`${origin}/api/commits`)).json();
      expect(listed.commits.map((c: { subject: string }) => c.subject)).toEqual(["change two", "init"]);
      expect(listed.next).toBeUndefined();
      const sha = listed.commits[0].sha;
      const commit = await (await fetch(`${origin}/api/review?scope=commits&from=${sha}&to=${sha}`)).json();
      expect(commit.label).toBe(`Commit ${sha.slice(0, 7)}`);
      expect(commit.patch).toContain("+TWO");
      expect(commit.patch).not.toContain("+four");
      // A run named newest first is the same run.
      const [newest, oldest] = listed.commits.map((c: { sha: string }) => c.sha);
      const backwards = await (
        await fetch(`${origin}/api/review?scope=commits&from=${newest}&to=${oldest}`)
      ).json();
      expect(backwards.label).toBe(`Commits ${oldest.slice(0, 7)}–${newest.slice(0, 7)}`);
      expect(backwards.patch).toContain("+TWO");
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
      // Comments written on a page another run drew are refused, and the review goes on.
      const elsewhere = await post(`${origin}/api/submit`, { comments, session: "another run" });
      expect(elsewhere.status).toBe(409);
      expect((await elsewhere.json()).error).toBe("These comments are about another review.");
      expect((await post(`${origin}/api/submit`, { comments, session: review.session })).ok).toBe(true);
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

  test("a changed image is served as it is, one side at a time, and nothing else is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patch-media-"));
    try {
      const run = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
      // Not UTF-8, with a NUL: read as text, these would not survive.
      const bytes = (...values: number[]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, ...values]);
      const [before, staged, now] = [bytes(1), bytes(2), bytes(3)];
      await Bun.write(join(dir, "logo.png"), before);
      await Bun.write(
        join(dir, "icon.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n',
      );
      await Bun.write(join(dir, "secret.png"), bytes(9)); // Unchanged: never served.
      await Bun.write(join(dir, "mode.png"), bytes(4)); // Only made executable.
      await mkdir(join(dir, "x and b"), { recursive: true });
      await Bun.write(join(dir, "x and b/y.png"), bytes(5)); // Its binary line splits two ways.
      await Bun.write(
        join(dir, "doc.md"),
        `# Doc\n\n${"Long enough to be over a tiny budget. ".repeat(10)}\n`,
      );
      run("init", "-q", "-b", "main");
      run("add", ".");
      run("commit", "-qm", "init");
      await Bun.write(join(dir, "logo.png"), staged);
      run("add", "logo.png");
      await Bun.write(join(dir, "logo.png"), now);
      await Bun.write(join(dir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n');
      await chmod(join(dir, "mode.png"), 0o755);
      await Bun.write(join(dir, "x and b/y.png"), bytes(6));
      await Bun.write(
        join(dir, "doc.md"),
        `# Doc, changed\n\n${"Long enough to be over a tiny budget. ".repeat(10)}\n`,
      );
      // Staged under a name Git could take for an index stage (":2:logo.png").
      await Bun.write(join(dir, "2:logo.png"), bytes(7));
      await Bun.write(join(dir, "2:note.txt"), "staged note\n");
      run("add", "2:logo.png", "2:note.txt");
      // Over the limit: refused without being read whole.
      await Bun.write(join(dir, "huge.png"), new Uint8Array(32 * 1024 * 1024 + 1));

      // Asked for by the read of the review the page drew.
      let reading = 0;
      const read = async (origin: string, key: string, side: string, path: string, headers = {}) =>
        fetch(`${origin}/api/media?${new URLSearchParams({ key, side, path, read: String(reading) })}`, {
          headers,
        });
      const review = async (origin: string, query = "") => {
        const body = await (await fetch(`${origin}/api/review${query}`)).json();
        reading = body.read;
        return body as { scopeKey: string; read: number; patch: string };
      };
      const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

      const worktree = await start(dir, "--uncommitted");
      try {
        const { origin } = worktree;
        const { scopeKey: key } = await review(origin);
        const old = await read(origin, key, "old", "logo.png");
        expect(old.headers.get("content-type")).toBe("image/png");
        expect(await bytesOf(old)).toEqual(before);
        expect(await bytesOf(await read(origin, key, "new", "logo.png"))).toEqual(now);
        expect((await read(origin, key, "new", "huge.png")).status).toBe(413);
        expect((await read(origin, key, "old", "huge.png")).status).toBe(404); // Not on that side.
        for (const path of ["secret.png", "../logo.png", "nope.png"])
          expect((await read(origin, key, "new", path)).status).toBe(404);
        expect((await read(origin, key, "both", "logo.png")).status).toBe(404);
        expect((await read(origin, "nope", "new", "logo.png")).status).toBe(404);

        // An SVG opened on its own runs nothing; the browser is told when it has it already.
        const svg = await read(origin, key, "new", "icon.svg");
        expect(svg.headers.get("content-type")).toBe("image/svg+xml");
        expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
        expect(svg.headers.get("content-security-policy")).toContain("sandbox");
        expect(svg.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(await svg.text()).toContain("<rect/>");
        const tag = svg.headers.get("etag")!;
        expect((await read(origin, key, "new", "icon.svg", { "if-none-match": tag })).status).toBe(304);

        // Git's own record of each file's paths, which the page names files by.
        // Read again with nothing changed: the same read, so what the page drew stays good.
        const first = reading;
        const { files } = (await review(origin)) as unknown as { files: unknown[] };
        expect(reading).toBe(first);
        expect(files).toContainEqual({ old: "x and b/y.png", new: "x and b/y.png" });
        expect(files).toContainEqual({ new: "huge.png" });
        // A file whose mode alone changed, and one whose name its binary line cannot be split by.
        expect(await bytesOf(await read(origin, key, "old", "mode.png"))).toEqual(bytes(4));
        expect(await bytesOf(await read(origin, key, "new", "mode.png"))).toEqual(bytes(4));
        expect(await bytesOf(await read(origin, key, "old", "x and b/y.png"))).toEqual(bytes(5));
        expect(await bytesOf(await read(origin, key, "new", "x and b/y.png"))).toEqual(bytes(6));
        // HEAD says the same without the bytes.
        const head = await fetch(
          `${origin}/api/media?${new URLSearchParams({ key, side: "new", path: "huge.png", read: String(reading) })}`,
          { method: "HEAD" },
        );
        expect(head.status).toBe(413);

        // Markdown is read only up to what its preview would render.
        const doc = (max: number) =>
          fetch(
            `${origin}/api/file?${new URLSearchParams({ key, side: "new", path: "doc.md", max: String(max) })}`,
          );
        expect((await doc(64)).status).toBe(413);
        expect(await (await doc(1024 * 1024)).text()).toStartWith("# Doc, changed");

        // Changed since the review was read: refused, not drawn as if the diff had it.
        await Bun.write(join(dir, "logo.png"), bytes(8));
        expect((await read(origin, key, "new", "logo.png")).status).toBe(409);
        // From an older read of the review: refused too.
        const stale = reading;
        await review(origin);
        reading = stale;
        expect((await read(origin, key, "old", "logo.png")).status).toBe(409);
      } finally {
        worktree.child.kill();
      }

      // Staged, the new side is the index.
      const index = await start(dir, "--staged");
      try {
        const { scopeKey: key } = await review(index.origin);
        expect(await bytesOf(await read(index.origin, key, "new", "logo.png"))).toEqual(staged);
        // Read at index stage 0, not taken for stage 2 of "logo.png".
        expect(await bytesOf(await read(index.origin, key, "new", "2:logo.png"))).toEqual(bytes(7));
        const note = await fetch(
          `${index.origin}/api/file?${new URLSearchParams({ key, side: "new", path: "2:note.txt" })}`,
        );
        expect(await note.text()).toBe("staged note\n");
        expect((await read(index.origin, key, "new", "icon.svg")).status).toBe(404); // Not staged.
      } finally {
        index.child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a file that is not UTF-8 does not fail the review", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patch-latin1-"));
    try {
      const run = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
      await Bun.write(join(dir, "kept.txt"), "kept\n");
      run("init", "-q", "-b", "main");
      run("add", ".");
      run("commit", "-qm", "init");
      // Latin-1 "café", and a damaged image with no NUL, which Git diffs as text.
      await Bun.write(join(dir, "latin1.txt"), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      await Bun.write(
        join(dir, "broken.png"),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]),
      );
      const review = await start(dir, "--uncommitted");
      try {
        const response = await fetch(`${review.origin}/api/review`);
        expect(response.status).toBe(200);
        const { patch, scopeKey } = (await response.json()) as { patch: string; scopeKey: string };
        expect(patch).toContain("+caf\uFFFD");
        const side = await fetch(
          `${review.origin}/api/file?${new URLSearchParams({ key: scopeKey, side: "new", path: "latin1.txt" })}`,
        );
        expect(await side.text()).toBe("caf\uFFFD\n");
      } finally {
        review.child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a pull request is read as one snapshot, from where it branched off, and never through a link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patch-pr-"));
    const bin = await mkdtemp(join(tmpdir(), "patch-bin-"));
    try {
      Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
      // The commits: where it branched off, the base's tip since (moved on), and its head.
      const [branched, tip, head] = ["a", "b", "c"].map((digit) => digit.repeat(40));
      const id = (name: string) => name.padEnd(40, "0");
      // Each commit's trees, as GitHub's Git API lists them: a folder at a time.
      const trees: Record<string, object[]> = {
        [id("rootold")]: [
          { path: "logo.png", mode: "100644", type: "blob", sha: id("1"), size: 3 },
          { path: "link.png", mode: "120000", type: "blob", sha: id("9"), size: 12 },
          { path: "mode.png", mode: "100644", type: "blob", sha: id("5"), size: 4 },
          { path: "x and b", mode: "040000", type: "tree", sha: id("folderold") },
        ],
        [id("rootnew")]: [
          { path: "logo.png", mode: "100644", type: "blob", sha: id("3"), size: 3 },
          { path: "link.png", mode: "120000", type: "blob", sha: id("8"), size: 12 },
          { path: "mode.png", mode: "100755", type: "blob", sha: id("5"), size: 4 },
          { path: "x and b", mode: "040000", type: "tree", sha: id("foldernew") },
        ],
        [id("folderold")]: [{ path: "y.png", mode: "100644", type: "blob", sha: id("6"), size: 3 }],
        [id("foldernew")]: [{ path: "y.png", mode: "100644", type: "blob", sha: id("7"), size: 3 }],
      };
      for (const [tree, entries] of Object.entries(trees))
        await writeFile(join(bin, `tree-${tree}`), JSON.stringify({ tree: entries, truncated: false }));
      await writeFile(join(bin, `commit-${branched}`), id("rootold"));
      await writeFile(join(bin, `commit-${head}`), id("rootnew"));
      const blobs = { "1": "OLD", "2": "TIP", "3": "NEW", "5": "MODE", "6": "Y-OLD", "7": "Y-NEW" };
      for (const [digit, text] of Object.entries(blobs))
        await writeFile(join(bin, `blob-${id(digit)}`), text);
      const files = [
        { filename: "link.png", previous_filename: null, status: "modified" },
        { filename: "logo.png", previous_filename: null, status: "modified" },
        { filename: "mode.png", previous_filename: null, status: "changed" },
        // A binary file its patch's header line cannot name: "a/x and b/y.png and b/x and b/y.png".
        { filename: "x and b/y.png", previous_filename: null, status: "modified" },
      ];
      await writeFile(join(bin, "compared"), JSON.stringify({ base: branched, files }));
      await writeFile(
        join(bin, "view.json"),
        JSON.stringify({ number: 7, title: "Logo", url: "u", baseRefOid: tip, headRefOid: head }),
      );
      await writeFile(
        join(bin, "patch"),
        [
          "diff --git a/link.png b/link.png",
          "index 9999999..8888888 120000",
          "Binary files a/link.png and b/link.png differ",
          "diff --git a/logo.png b/logo.png",
          "index 1000000..3000000 100644",
          "Binary files a/logo.png and b/logo.png differ",
          "diff --git a/mode.png b/mode.png",
          "old mode 100644",
          "new mode 100755",
          "diff --git a/x and b/y.png b/x and b/y.png",
          "index 6000000..7000000 100644",
          "Binary files a/x and b/y.png and b/x and b/y.png differ",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(bin, "gh"),
        [
          "#!/bin/sh",
          'args="$*"',
          `echo "$args" >> "${bin}/calls"`,
          'case "$args" in',
          `  "pr view"*) cat "${bin}/view.json" ;;`,
          `  *merge_base_commit*) cat "${bin}/compared" ;;`,
          `  *vnd.github.diff*) cat "${bin}/patch" ;;`,
          `  */git/blobs/*) cat "${bin}/blob-\${args##*/}" ;;`,
          `  */git/commits/*) sha="\${args##*/git/commits/}"; cat "${bin}/commit-\${sha%% *}" ;;`,
          `  */git/trees/*) cat "${bin}/tree-\${args##*/}" ;;`,
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
      const review = await startWith({ PATH: `${bin}:${process.env.PATH}` }, dir);
      try {
        const body = await (await fetch(`${review.origin}/api/review?scope=pr&pr=7`)).json();
        expect(body.label).toBe("PR #7 Logo");
        // The page names files as GitHub compared them, not as their header lines split.
        expect(body.files).toContainEqual({ old: "x and b/y.png", new: "x and b/y.png" });
        const media = async (side: string, path: string) => {
          const query = new URLSearchParams({ key: body.scopeKey, side, path, read: String(body.read) });
          const response = await fetch(`${review.origin}/api/media?${query}`);
          return response.ok ? response.text() : response.status;
        };
        // Its old side is where it branched off ("OLD"), never the base's tip since ("TIP").
        expect(await media("old", "logo.png")).toBe("OLD");
        expect(await media("new", "logo.png")).toBe("NEW");
        expect(await media("old", "x and b/y.png")).toBe("Y-OLD");
        expect(await media("new", "x and b/y.png")).toBe("Y-NEW");
        expect(await media("old", "mode.png")).toBe("MODE");
        expect(await media("new", "mode.png")).toBe("MODE");
        // A link has no image of its own, whatever it points at.
        for (const side of ["old", "new"]) expect(await media(side, "link.png")).toBe(404);
        const calls = await Bun.file(join(bin, "calls")).text();
        // The diff, where it branched off and its files' names, all for the commits read first;
        // never `gh pr diff`, which gives whatever the pull request is by then.
        expect(calls).toContain(`compare/${tip}...${head}`);
        expect(calls).not.toContain("pr diff");
        expect(calls).not.toContain("/contents");
      } finally {
        review.child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });

  test("a read that finds what the last did is the same read; one that does not, is not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patch-reads-"));
    try {
      const run = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
      await Bun.write(join(dir, "m.png"), new Uint8Array([0x89, 0, 1]));
      run("init", "-q", "-b", "main");
      run("add", ".");
      run("commit", "-qm", "one");
      await chmod(join(dir, "m.png"), 0o755); // Its mode alone changes: no id in the patch.
      const review = await start(dir, "--uncommitted");
      try {
        const read = async () =>
          (await (await fetch(`${review.origin}/api/review`)).json()) as {
            read: number;
            patch: string;
            scopeKey: string;
          };
        // Read at once from two tabs: one read.
        const [first, second] = await Promise.all([read(), read()]);
        expect(second.read).toBe(first.read);
        expect((await read()).read).toBe(first.read);
        // The same patch, over other bytes: the image changed on both sides, its mode change kept.
        await chmod(join(dir, "m.png"), 0o644);
        await Bun.write(join(dir, "m.png"), new Uint8Array([0x89, 0, 2]));
        run("commit", "-qam", "two");
        await chmod(join(dir, "m.png"), 0o755);
        const third = await read();
        expect(third.patch).toBe(first.patch);
        expect(third.read).not.toBe(first.read);
        const old = await fetch(
          `${review.origin}/api/media?${new URLSearchParams({ key: third.scopeKey, side: "old", path: "m.png", read: String(third.read) })}`,
        );
        expect(new Uint8Array(await old.arrayBuffer())).toEqual(new Uint8Array([0x89, 0, 2]));
        const stale = await fetch(
          `${review.origin}/api/media?${new URLSearchParams({ key: third.scopeKey, side: "old", path: "m.png", read: String(first.read) })}`,
        );
        expect(stale.status).toBe(409);
      } finally {
        review.child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a blank context line keeps its space, whatever the user's Git configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patch-blank-"));
    try {
      const run = (...args: string[]) =>
        Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
      await Bun.write(join(dir, "a.txt"), "one\n\n\n\n");
      run("init", "-q", "-b", "main");
      run("config", "diff.suppressBlankEmpty", "true");
      run("add", ".");
      run("commit", "-qm", "init");
      await Bun.write(join(dir, "a.txt"), "ONE\n\n\n\n");
      const review = await start(dir, "--uncommitted");
      try {
        const { patch } = (await (await fetch(`${review.origin}/api/review`)).json()) as { patch: string };
        // Without it, the page would take the hunk for the whole file.
        expect(patch).toContain("+ONE\n \n \n \n");
      } finally {
        review.child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
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
        const listed = await (await fetch(`${origin}/api/commits`)).json();
        expect(listed.commits.map((c: { subject: string }) => c.subject)).toEqual(["second", "first"]);
        const sha = listed.commits[1].sha;
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

  test("the history comes a page at a time from the HEAD the first pinned, and a search finds it all", async () => {
    const saved = repo;
    repo = await mkdtemp(join(tmpdir(), "patch-contract-history-"));
    try {
      git("init", "-q", "-b", "main");
      // 250 commits at once: odd ones by Ann about Loops, even ones by Bob.
      const stream = Array.from({ length: 250 }, (_, at) => {
        const n = at + 1;
        const [who, what] = n % 2 ? ["Ann", "Fix Loops"] : ["Bob", "tidy"];
        const message = `${what} ${n}`;
        return [
          "commit refs/heads/main",
          `committer ${who} <${who.toLowerCase()}@t> ${1_700_000_000 + n} +0000`,
          `data ${message.length}`,
          message,
          "",
        ].join("\n");
      }).join("");
      Bun.spawnSync(["git", "fast-import", "--quiet"], { cwd: repo, stdin: Buffer.from(stream) });
      git("reset", "-q", "--hard", "main");
      const { child, origin } = await start();
      try {
        const page = async (query = "", after?: string) => {
          const params = new URLSearchParams({ q: query, ...(after ? { after } : {}) });
          return (await (await fetch(`${origin}/api/commits?${params}`)).json()) as {
            commits: { sha: string; subject: string; author: string; short: string; when: string }[];
            next?: string;
          };
        };
        // Browsing: newest first, a hundred at a time, with no commit twice and none left out.
        const first = await page();
        expect(first.commits).toHaveLength(100);
        expect(first.commits[0]!.subject).toBe("tidy 250");
        expect(first.commits[0]!.author).toBe("Bob");
        expect(first.commits[0]!.short).toBe(first.commits[0]!.sha.slice(0, 7));
        // A commit made now does not move the pages after the first.
        git("commit", "-q", "--allow-empty", "-m", "made meanwhile");
        const second = await page("", first.next);
        const third = await page("", second.next);
        expect(third.next).toBeUndefined();
        const subjects = [...first.commits, ...second.commits, ...third.commits].map(
          (commit) => commit.subject,
        );
        expect(subjects).toHaveLength(250);
        expect(new Set(subjects).size).toBe(250);
        expect(subjects.at(-1)).toBe("Fix Loops 1");
        // Searching: every word, in any order; capitals match only capitals; pages resume.
        const found = await page("loops ann");
        expect(found.commits.map((commit) => commit.subject).slice(0, 2)).toEqual([
          "Fix Loops 249",
          "Fix Loops 247",
        ]);
        expect(found.commits).toHaveLength(100);
        const rest = await page("loops ann", found.next);
        expect(rest.commits).toHaveLength(25);
        expect(rest.next).toBeUndefined();
        expect((await page("LOOPS")).commits).toHaveLength(0);
        expect((await page("Loops 13")).commits.map((commit) => commit.subject)).toEqual(
          [213, 139, 137, 135, 133, 131, 113, 13].map((n) => `Fix Loops ${n}`),
        );
        // An id finds its commit first, wherever it is.
        const oldest = third.commits.at(-1)!;
        expect((await page(oldest.sha.slice(0, 10))).commits[0]!.subject).toBe("Fix Loops 1");
        // A commit made since is found too: the history read is built on, not read again.
        git("commit", "-q", "--allow-empty", "-m", "Loops made later");
        expect((await page("later")).commits.map((commit) => commit.subject)).toEqual(["Loops made later"]);
        expect((await page("loops ann", found.next)).commits).toHaveLength(25);
        // Hex digits that name a tag, not a commit's id, are searched for like any other words.
        git("tag", "abcdef1", oldest.sha);
        expect((await page("abcdef1")).commits).toEqual([]);
        // A cursor is the server's own.
        expect((await fetch(`${origin}/api/commits?after=HEAD:0`)).status).toBe(422);
      } finally {
        child.kill();
      }
      // A shallow clone deepened while it is reviewed: its searches find the history it gained.
      const source = repo;
      repo = join(source, "shallow");
      Bun.spawnSync(["git", "clone", "-q", "--depth=2", `file://${source}`, repo]);
      const shallow = await start();
      try {
        const found = async () =>
          ((await (await fetch(`${shallow.origin}/api/commits?q=loops`)).json()) as { commits: unknown[] })
            .commits;
        expect(await found()).toHaveLength(1);
        git("fetch", "-q", "--deepen=10");
        expect(await found()).toHaveLength(6);
      } finally {
        shallow.child.kill();
      }
      repo = source;
    } finally {
      await rm(repo, { recursive: true, force: true });
      repo = saved;
    }
  });

  test("pull requests come a page at a time by GitHub's cursor, and a number finds a merged one", async () => {
    const bin = await mkdtemp(join(tmpdir(), "patch-bin-"));
    try {
      const pull = (number: number, state = "OPEN") => ({
        number,
        title: `Change ${number}`,
        state,
        isDraft: false,
        updatedAt: "2026-01-01T00:00:00Z",
        headRefName: `b${number}`,
        baseRefName: "main",
        author: number === 3 ? null : { login: "ann" },
      });
      const page = (numbers: number[], after: string | null) =>
        JSON.stringify({
          nodes: numbers.map((n) => pull(n)),
          pageInfo: { hasNextPage: after !== null, endCursor: after },
        });
      await writeFile(join(bin, "first"), page([9, 8], "C1"));
      await writeFile(join(bin, "second"), page([3], null));
      // A search's hits that are issues come back empty.
      await writeFile(
        join(bin, "found"),
        JSON.stringify({ nodes: [pull(8), {}], pageInfo: { hasNextPage: false, endCursor: null } }),
      );
      await writeFile(join(bin, "merged"), JSON.stringify(pull(1, "MERGED")));
      await writeFile(
        join(bin, "gh"),
        [
          "#!/bin/sh",
          'args="$*"',
          `echo "$args" >> "${bin}/calls"`,
          'case "$args" in',
          '  *nameWithOwner*) echo "acme/widgets" ;;',
          '  "repo view"*) echo "https://ghe.example/acme/widgets" ;;',
          `  *"pullRequest(number"*) cat "${bin}/merged" ;;`,
          `  *"after=C1"*) cat "${bin}/second" ;;`,
          `  *pullRequests*) cat "${bin}/first" ;;`,
          `  *search*) cat "${bin}/found" ;;`,
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
      // The repository is on GitHub Enterprise: every request goes there, which `gh` names.
      git("remote", "add", "work", "https://GHE.example/acme/widgets.git");
      const review = await startWith({ PATH: `${bin}:${process.env.PATH}` });
      try {
        const page = async (query = "", after?: string) => {
          const params = new URLSearchParams({ q: query, ...(after ? { after } : {}) });
          return (await (await fetch(`${review.origin}/api/prs?${params}`)).json()) as {
            pulls: { number: number; author: string; state: string }[];
            next?: string;
          };
        };
        const first = await page();
        expect(first.pulls.map((pull) => pull.number)).toEqual([9, 8]);
        expect(first.next).toBe("C1");
        const second = await page("", first.next);
        expect(second.pulls).toEqual([
          expect.objectContaining({ number: 3, author: "ghost", state: "open" }),
        ]);
        expect(second.next).toBeUndefined();
        // A number is also that pull request, first, merged or not; a search spells the repository out.
        const found = await page("#1");
        expect(found.pulls.map((pull) => [pull.number, pull.state])).toEqual([
          [1, "merged"],
          [8, "open"],
        ]);
        const calls = await Bun.file(join(bin, "calls")).text();
        expect(calls).toContain("q=repo:acme/widgets is:pr is:open #1 sort:updated-desc");
        // A date only a merged one has chooses merged ones: not only the open.
        await page("merged:>=2025-01-01 fix");
        expect(await Bun.file(join(bin, "calls")).text()).toContain(
          "q=repo:acme/widgets is:pr merged:>=2025-01-01 fix sort:",
        );
        // Typed state and order are the user's.
        await page("is:merged sort:created-asc fix");
        expect(await Bun.file(join(bin, "calls")).text()).toContain(
          "q=repo:acme/widgets is:pr is:merged sort:created-asc fix --jq",
        );
        const made = (await Bun.file(join(bin, "calls")).text()).split("\n");
        expect(made.filter((call) => call.startsWith("repo view"))).toHaveLength(1);
        const api = made.filter((call) => call.startsWith("api "));
        expect(api.filter((call) => !call.startsWith("api --hostname ghe.example "))).toEqual([]);
      } finally {
        review.child.kill();
      }
    } finally {
      git("remote", "remove", "work");
      await rm(bin, { recursive: true, force: true });
    }
  });

  test("a commit whose files a partial clone lacks is read from GitHub, or refused at once; what is here stays usable", async () => {
    const saved = repo;
    const source = await mkdtemp(join(tmpdir(), "patch-contract-source-"));
    const bin = await mkdtemp(join(tmpdir(), "patch-bin-"));
    repo = source;
    try {
      git("init", "-q", "-b", "main");
      git("config", "uploadpack.allowFilter", "true");
      await writeFile(join(repo, "a.txt"), "1\n");
      await writeFile(join(repo, "b.txt"), "kept\n");
      await writeFile(join(repo, "c.txt"), "gone\n");
      git("add", ".");
      git("commit", "-qm", "first");
      await writeFile(join(repo, "a.txt"), "2\n");
      git("commit", "-qam", "second");
      await writeFile(join(repo, "a.txt"), "3\n");
      git("rm", "-q", "c.txt");
      git("commit", "-qam", "third");
      const clone = (filter: string, into: string) =>
        Bun.spawnSync(["git", "clone", "-q", `--filter=${filter}`, `file://${source}`, join(source, into)]);
      clone("tree:0", "trees");
      repo = join(source, "clone");
      clone("blob:none", "clone");
      // Only the checked-out commit's contents came: "1", "2" and c.txt are left behind.
      const [, second, first] = git("log", "--format=%H").trim().split("\n");
      const parent = git("rev-parse", `${second}^`).trim();
      const id = (name: string) => name.padEnd(40, "0");
      await writeFile(
        join(bin, `tree-${id("a")}`),
        JSON.stringify({ tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: id("1"), size: 2 }] }),
      );
      await writeFile(
        join(bin, `tree-${id("b")}`),
        JSON.stringify({ tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: id("2"), size: 2 }] }),
      );
      await writeFile(join(bin, `commit-${parent}`), id("a"));
      await writeFile(join(bin, `commit-${second}`), id("b"));
      await writeFile(join(bin, `blob-${id("1")}`), "1\n");
      await writeFile(join(bin, `blob-${id("2")}`), "2\n");
      const files = [{ filename: "a.txt", previous_filename: null, status: "modified" }];
      await writeFile(join(bin, "compared"), JSON.stringify({ base: parent, files }));
      await writeFile(
        join(bin, "patch"),
        "diff --git a/a.txt b/a.txt\nindex 1000000..2000000 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-1\n+2\n",
      );
      // GitHub, as `gh` answers it: first for a repository without a GitHub remote, then with one.
      const gh = (answers: string[]) =>
        writeFile(
          join(bin, "gh"),
          [
            "#!/bin/sh",
            'args="$*"',
            `echo "$args" >> "${bin}/calls"`,
            'case "$args" in',
            ...answers,
            "esac",
          ].join("\n"),
          { mode: 0o755 },
        );
      await gh([
        '  *) echo "none of the git remotes configured for this repository point to a known GitHub host." >&2; exit 1 ;;',
      ]);
      const path = { PATH: `${bin}:${process.env.PATH}` };
      const ask = (origin: string) => fetch(`${origin}/api/review?scope=commits&from=${second}&to=${second}`);
      const offline = await startWith(path);
      try {
        const started = performance.now();
        const answer = await ask(offline.origin);
        expect(answer.status).toBe(422);
        const { error } = await answer.json();
        expect(error).toContain("partial clone lacks some of the files");
        expect(error).toContain(`git diff ${parent.slice(0, 12)} ${second!.slice(0, 12)}`);
        expect(error).toContain("This repository has no GitHub remote.");
        expect(performance.now() - started).toBeLessThan(5000);
        // Its pull requests say the same, not what `gh` said.
        expect((await (await fetch(`${offline.origin}/api/prs`)).json()).error).toBe(
          "This repository has no GitHub remote.",
        );
      } finally {
        offline.child.kill();
      }
      // The first commit alone, by GitHub's diff of one commit: there is nothing to compare it with.
      const added = (name: string) => ({ filename: name, previous_filename: null, status: "added" });
      await writeFile(join(bin, "root"), JSON.stringify(["a.txt", "b.txt", "c.txt"].map(added)));
      await writeFile(
        join(bin, "rootpatch"),
        ["a.txt", "b.txt", "c.txt"]
          .map(
            (name) =>
              `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+${name}\n`,
          )
          .join(""),
      );
      await gh([
        `  *"{repo}/commits/${first} --jq"*) cat "${bin}/root" ;;`,
        `  *"vnd.github.diff repos/{owner}/{repo}/commits/"*) cat "${bin}/rootpatch" ;;`,
        `  *merge_base_commit*) cat "${bin}/compared" ;;`,
        `  *vnd.github.diff*) cat "${bin}/patch" ;;`,
        `  */git/blobs/*) cat "${bin}/blob-\${args##*/}" ;;`,
        `  */git/commits/*) sha="\${args##*/git/commits/}"; cat "${bin}/commit-\${sha%% *}" ;;`,
        `  */git/trees/*) cat "${bin}/tree-\${args##*/}" ;;`,
        "  *) exit 1 ;;",
      ]);
      const online = await startWith(path);
      try {
        const body = await (await ask(online.origin)).json();
        expect(body.label).toBe(`Commit ${second!.slice(0, 7)}`);
        expect(body.patch).toContain("+2");
        expect(body.files).toEqual([{ old: "a.txt", new: "a.txt" }]);
        expect(await Bun.file(join(bin, "calls")).text()).toContain(`compare/${parent}...${second}`);
        // Neither side's contents are here: both come from GitHub, by the commits reviewed.
        const side = async (name: string) => {
          const query = new URLSearchParams({ key: body.scopeKey, side: name, path: "a.txt" });
          return (await fetch(`${online.origin}/api/file?${query}`)).text();
        };
        expect(await side("old")).toBe("1\n");
        expect(await side("new")).toBe("2\n");
        // Of the files it leaves alone, those here can be opened; a search, which needs them
        // all, is refused rather than left to wait on Git.
        const key = new URLSearchParams({ key: body.scopeKey });
        expect(await (await fetch(`${online.origin}/api/unchanged?${key}`)).json()).toEqual(["b.txt"]);
        const kept = await fetch(`${online.origin}/api/unchanged/file?${key}&path=b.txt`);
        expect(await kept.text()).toBe("kept\n");
        const grep = await fetch(`${online.origin}/api/grep?${key}&q=kept`);
        expect((await grep.json()).error).toBe("This partial clone lacks some of the files to search.");
        // The first commit alone, from GitHub.
        const root = await (
          await fetch(`${online.origin}/api/review?scope=commits&from=${first}&to=${first}`)
        ).json();
        expect(root.label).toBe(`Commit ${first!.slice(0, 7)}`);
        expect(root.files).toHaveLength(3);
        expect(root.patch).toContain("+b.txt");
        // Every request goes to the repository's host.
        const calls = (await Bun.file(join(bin, "calls")).text())
          .split("\n")
          .filter((call) => call.startsWith("api "));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.filter((call) => !call.startsWith("api --hostname github.com "))).toEqual([]);
      } finally {
        online.child.kill();
      }
      // A clone without trees can't list the commit's files either: GitHub has them.
      repo = join(source, "trees");
      const treeless = await startWith(path);
      try {
        const body = await (await ask(treeless.origin)).json();
        expect(body.label).toBe(`Commit ${second!.slice(0, 7)}`);
        expect(body.patch).toContain("+2");
      } finally {
        treeless.child.kill();
      }
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
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

  test.skipIf(!Bun.which("jj")).each([
    ["not colocated", "--no-colocate", "older"],
    ["colocated", "--colocate", "behind"],
  ])(
    "a Jujutsu workspace %s is read through its Git repository, and nothing is written, not even a time",
    async (_, colocation, index) => {
      const dir = await mkdtemp(join(tmpdir(), "patch-jj-"));
      const env = { ...process.env, JJ_CONFIG: "/dev/null", JJ_USER: "t", JJ_EMAIL: "t@t" };
      const jj = (...args: string[]) => {
        const run = Bun.spawnSync(["jj", ...args], { cwd: dir, env });
        if (run.exitCode !== 0) throw new Error(run.stderr.toString());
        return run.stdout.toString();
      };
      try {
        // Not colocated, there is no `.git` beside the files, only the repository inside `.jj`.
        jj("git", "init", colocation!);
        await writeFile(join(dir, "a.ts"), "one\ntwo\n");
        // An empty file: the object a new file's intent-to-add writes is already in the repository.
        await writeFile(join(dir, "empty"), "");
        jj("commit", "-m", "init");
        jj("bookmark", "create", "main", "-r", "@-");
        await writeFile(join(dir, "a.ts"), "one\nTWO\n");
        jj("commit", "-m", "change two");
        await writeFile(join(dir, "a.ts"), "one\nTWO\nthree\n");
        await writeFile(join(dir, "new.txt"), "new\n");
        const files = async () => {
          const paths = Array.from(new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true, onlyFiles: true }));
          return Promise.all(
            paths.toSorted().map(async (path) => {
              const file = join(dir, path);
              return [path, Bun.hash(await Bun.file(file).bytes()), (await stat(file)).mtimeMs];
            }),
          );
        };
        // An index jj must rebuild, from an older jj or behind the last operation: any read rebuilds
        // it, and the rebuilt one must not land in the repository.
        const kept = join(dir, ".jj/repo/index");
        if (index === "older")
          for (const segment of await readdir(join(kept, "segments")))
            await writeFile(join(kept, "segments", segment), "");
        else {
          const [head] = await readdir(join(dir, ".jj/repo/op_heads/heads"));
          await rm(join(kept, "op_links", head!));
        }
        const before = await files();
        const review = await startWith({ JJ_CONFIG: "/dev/null" }, dir);
        try {
          const get = async (path: string) => (await fetch(`${review.origin}${path}`)).json();
          // The branch: the commits since main and the files on disk, which jj has not snapshotted.
          const all = await get("/api/review");
          expect(all.vcs).toBe("jj");
          expect(all.label).toEndWith("vs main");
          expect(all.patch).toContain("-two");
          expect(all.patch).toContain("+three");
          expect(all.patch).toContain("new.txt");
          expect(all.patch).not.toContain(".jj");
          // The working copy: only what is on disk since its parent.
          const copy = await get("/api/review?scope=uncommitted");
          expect(copy.label).toEndWith("· working copy");
          expect(copy.patch).toContain("+three");
          expect(copy.patch).not.toContain("-two");
          expect((await get("/api/review?scope=staged")).error).toContain("no staging area");
          expect((await get("/api/scopes")).branches).toEqual(["main"]);
          const history = await get("/api/commits");
          expect(history.commits.map((commit: { subject: string }) => commit.subject)).toEqual([
            "change two",
            "init",
          ]);
        } finally {
          review.child.kill();
          await review.child.exited;
        }
        expect(await files()).toEqual(before);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!Bun.which("jj"))(
    "a Jujutsu merge, a base at the root, and two operations at once are each said plainly, and nothing is written",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "patch-jj-"));
      const env = { ...process.env, JJ_CONFIG: "/dev/null", JJ_USER: "t", JJ_EMAIL: "t@t" };
      const jj = (...args: string[]) => {
        const run = Bun.spawnSync(["jj", ...args], { cwd: dir, env });
        if (run.exitCode !== 0) throw new Error(run.stderr.toString());
        return run.stdout.toString().trim();
      };
      try {
        jj("git", "init", "--no-colocate");
        await writeFile(join(dir, "a.txt"), "a\n");
        jj("commit", "-m", "a");
        await writeFile(join(dir, "b.txt"), "b\n");
        jj("describe", "-m", "b");
        const b = jj("log", "--no-graph", "-r", "@", "-T", "change_id");
        jj("new", "@-", "-m", "c");
        await writeFile(join(dir, "c.txt"), "c\n");
        const c = jj("log", "--no-graph", "-r", "@", "-T", "change_id");
        // The working copy merges the two.
        jj("new", b, c);
        await writeFile(join(dir, "wc.txt"), "wc\n");
        const review = await startWith({ JJ_CONFIG: "/dev/null" }, dir);
        try {
          const get = async (path: string) => (await fetch(`${review.origin}${path}`)).json();
          expect((await get("/api/review?scope=uncommitted")).error).toContain("merges several commits");
          // Everything since the root commit is every file, never only what is on disk.
          const all = await get(`/api/review?scope=all&base=${encodeURIComponent("root()")}`);
          for (const name of ["a.txt", "b.txt", "wc.txt"]) expect(all.patch).toContain(`+++ b/${name}`);
          // Two operations at once: refused, and the folder that records them left as it was.
          jj("--at-op=@-", "describe", "-m", "elsewhere");
          const heads = join(dir, ".jj/repo/op_heads/heads");
          const before = (await stat(heads)).mtimeMs;
          expect((await get("/api/review")).error).toContain("two operations at once");
          expect((await stat(heads)).mtimeMs).toBe(before);
        } finally {
          review.child.kill();
          await review.child.exited;
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("a GitLab merge request is read as one snapshot, by the project its remote names, from outside the repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patch-mr-"));
    const bin = await mkdtemp(join(tmpdir(), "patch-bin-"));
    try {
      Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
      Bun.spawnSync(["git", "remote", "add", "origin", "git@gitlab.example:acme/web/widgets.git"], {
        cwd: dir,
      });
      const [base, head] = ["a", "c"].map((digit) => digit.repeat(40));
      const request = (iid: number, state = "opened") => ({
        iid,
        title: `Change ${iid}`,
        state,
        draft: iid === 8,
        updated_at: "2026-01-01T00:00:00Z",
        source_branch: `b${iid}`,
        target_branch: "main",
        author: { username: "ann" },
        diff_refs: { base_sha: base, start_sha: "b".repeat(40), head_sha: head },
      });
      const diffs = [
        {
          old_path: "a.ts",
          new_path: "a.ts",
          a_mode: "100644",
          b_mode: "100644",
          diff: "@@ -1 +1 @@\n-one\n+ONE\n",
        },
        {
          old_path: "old.txt",
          new_path: "moved.txt",
          a_mode: "100644",
          b_mode: "100644",
          diff: "",
          renamed_file: true,
        },
        {
          old_path: "n.txt",
          new_path: "n.txt",
          a_mode: "0",
          b_mode: "100644",
          diff: "@@ -0,0 +1 @@\n+n\n",
          new_file: true,
        },
      ];
      const project = "projects/acme%2Fweb%2Fwidgets";
      await writeFile(join(bin, "mr.json"), JSON.stringify(request(7)));
      await writeFile(join(bin, "merged.json"), JSON.stringify(request(1, "merged")));
      await writeFile(join(bin, "first.json"), JSON.stringify([9, 8].map((iid) => request(iid))));
      await writeFile(join(bin, "compare.json"), JSON.stringify({ diffs, compare_timeout: false }));
      await writeFile(
        join(bin, "tree.json"),
        JSON.stringify([
          { id: "1".repeat(40), name: "a.ts", type: "blob", mode: "100644" },
          { id: "9".repeat(40), name: "link.ts", type: "blob", mode: "120000" },
        ]),
      );
      await writeFile(join(bin, "blob"), "ONE\n");
      await writeFile(
        join(bin, "glab"),
        [
          "#!/bin/sh",
          'args="$*"',
          `echo "$PWD $args" >> "${bin}/calls"`,
          'case "$args" in',
          `  *"merge_requests/7") cat "${bin}/mr.json" ;;`,
          `  *"merge_requests/1") cat "${bin}/merged.json" ;;`,
          `  *"merge_requests?"*"page=1"*) cat "${bin}/first.json" ;;`,
          `  *"merge_requests?"*) echo "[]" ;;`,
          `  *"repository/compare?from=${base}&to=${head}&straight=true"*) cat "${bin}/compare.json" ;;`,
          `  *"repository/tree?ref=${head}"*) cat "${bin}/tree.json" ;;`,
          `  *"repository/blobs/${"1".repeat(40)}/raw"*) cat "${bin}/blob" ;;`,
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
      // A host named for GitLab is sent `glab`'s credentials only once `glab` is set up for it.
      const untrusted = await startWith({ PATH: `${bin}:${process.env.PATH}`, GITLAB_HOST: "" }, dir);
      try {
        const refused = await (await fetch(`${untrusted.origin}/api/review?scope=pr&pr=7`)).json();
        expect(refused.error).toBeDefined();
        expect(await Bun.file(join(bin, "calls")).text()).not.toContain(" api ");
      } finally {
        untrusted.child.kill();
      }
      const review = await startWith(
        { PATH: `${bin}:${process.env.PATH}`, GITLAB_HOST: "gitlab.example" },
        dir,
      );
      try {
        const body = await (await fetch(`${review.origin}/api/review?scope=pr&pr=7`)).json();
        expect(body.label).toBe("MR !7 Change 7");
        expect(body.forge).toBe("gitlab");
        // GitLab's hunks with Git's header written for each file.
        expect(body.patch).toBe(
          [
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-one\n+ONE\n",
            "diff --git a/old.txt b/moved.txt\nsimilarity index 100%\nrename from old.txt\nrename to moved.txt\n",
            "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+n\n",
          ].join(""),
        );
        const side = async (path: string) => {
          const query = new URLSearchParams({ key: body.scopeKey, side: "new", path });
          const response = await fetch(`${review.origin}/api/file?${query}`);
          return response.ok ? response.text() : response.status;
        };
        expect(await side("a.ts")).toBe("ONE\n");
        const pulls = async (query: string) =>
          (await fetch(`${review.origin}/api/prs?${new URLSearchParams({ q: query })}`)).json();
        const first = await pulls("");
        expect(first.forge).toBe("gitlab");
        expect(first.pulls.map((pull: { number: number }) => pull.number)).toEqual([9, 8]);
        expect(first.pulls[1].draft).toBe(true);
        // A number is that merge request, first, merged or not.
        const found = await pulls("!1");
        expect(
          found.pulls.map((pull: { number: number; state: string }) => [pull.number, pull.state]),
        ).toEqual([
          [1, "merged"],
          [9, "open"],
          [8, "open"],
        ]);
        expect((await (await fetch(`${review.origin}/api/scopes`)).json()).forge).toBe("gitlab");
        const calls = (await Bun.file(join(bin, "calls")).text()).trim().split("\n");
        // Every request names the project and host its remote does, never asks `glab` to find them
        // (which may write to the repository's config), and runs outside the repository.
        for (const call of calls) {
          expect(call.startsWith(dir)).toBe(false);
          // Besides where its configuration is, which names the hosts it is set up for.
          if (!call.endsWith(" config path"))
            expect(call).toContain(`api --hostname gitlab.example ${project}/`);
        }
        expect(calls.join("\n")).not.toContain(":fullpath");
      } finally {
        review.child.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
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
