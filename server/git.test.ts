import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readGitReview } from "./git.ts";
import { parseReview } from "../src/review/parse.ts";
import { formatReview } from "../src/review/storage.ts";

const execute = promisify(execFile);
// Exercise the native Git reader against the same integration fixtures.
const readReview = process.env.PATCH_TEST_NATIVE
  ? async (path: string, mode = "working", base = "main") => {
      const { stdout } = await execute(
        new URL("../zig-out/bin/patch", import.meta.url).pathname,
        ["--inspect-repository", path, mode, base],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as Awaited<ReturnType<typeof readGitReview>>;
    }
  : readGitReview;
async function repository() {
  const path = await mkdtemp(join(tmpdir(), "patch-git-"));
  const git = async (...args: string[]) =>
    (
      await execute(
        "git",
        ["-c", "user.name=Patch Test", "-c", "user.email=patch@example.invalid", ...args],
        { cwd: path },
      )
    ).stdout;
  await git("init", "-q", "-b", "main");
  return { path, git, clean: () => rm(path, { recursive: true, force: true }) };
}

test("working and staged reviews differ, include new Unicode paths, and leave Git untouched", async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo.path, "cache.ts"), "export const ttl = 10;\n");
    await repo.git("add", ".");
    await repo.git("commit", "-qm", "Initial");
    await writeFile(join(repo.path, "cache.ts"), "export const ttl = 20;\n");
    await repo.git("add", ".");
    await writeFile(join(repo.path, "cache.ts"), "export const ttl = 30;\n");
    await writeFile(join(repo.path, "a file λ.ts"), "export const ready = true;\n");
    const statusBefore = await repo.git("status", "--porcelain=v1", "-z");
    const indexBefore = await readFile(join(repo.path, ".git/index"));
    const working = await parseReview(await readReview(repo.path));
    const staged = await parseReview(await readReview(repo.path, "staged"));
    assert.equal(working.files.length, 2);
    assert.ok(working.files.some((file) => file.path === "a file λ.ts"));
    assert.ok(
      working.files
        .find((file) => file.path === "cache.ts")
        ?.diff.additionLines.join("")
        .includes("30"),
    );
    assert.equal(staged.files.length, 1);
    assert.ok(staged.files[0]?.diff.additionLines.join("").includes("20"));
    assert.equal(await repo.git("status", "--porcelain=v1", "-z"), statusBefore);
    assert.deepEqual(await readFile(join(repo.path, ".git/index")), indexBefore);
  } finally {
    await repo.clean();
  }
});

test("branch review preserves renames and omits working tree edits", async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo.path, "before.ts"), "export const ready = true;\n");
    await repo.git("add", ".");
    await repo.git("commit", "-qm", "Initial");
    await repo.git("checkout", "-qb", "feature");
    await repo.git("mv", "before.ts", "after.ts");
    await repo.git("commit", "-qm", "Rename");
    await writeFile(join(repo.path, "after.ts"), "not committed\n");
    const review = await parseReview(await readReview(repo.path, "branch", "main"));
    assert.equal(review.files.length, 1);
    assert.equal(review.files[0]?.path, "after.ts");
    assert.equal(review.files[0]?.diff.prevName, "before.ts");
    assert.equal(review.files[0]?.additions, 0);
    await assert.rejects(readReview(repo.path, "branch", "--not-a-revision"));
  } finally {
    await repo.clean();
  }
});

test("new repositories, deleted files, and binary changes remain reviewable", async () => {
  const repo = await repository();
  try {
    assert.equal((await parseReview(await readReview(repo.path))).files.length, 0);
    await writeFile(join(repo.path, "remove.ts"), "export const old = true;\n");
    await repo.git("add", ".");
    await repo.git("commit", "-qm", "Initial");
    await rm(join(repo.path, "remove.ts"));
    await writeFile(join(repo.path, "image.bin"), Buffer.from([0, 1, 2, 0, 255, 36]));
    const review = await parseReview(await readReview(repo.path));
    assert.equal(review.files.length, 2);
    assert.equal(review.files.find((file) => file.path === "remove.ts")?.deletions, 1);
    assert.equal(review.files.find((file) => file.path === "image.bin")?.diff.hunks.length, 0);
  } finally {
    await repo.clean();
  }
});

test("review export retains line ranges and never claims unreviewed files are reviewed", async () => {
  const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n";
  const review = await parseReview({
    patch,
    repository: "test",
    branch: "feature",
    base: "main",
    title: "Working changes",
    kind: "patch",
  });
  const file = review.files[0];
  assert.ok(file);
  const markdown = formatReview(review, {
    reviewed: [],
    notes: [
      {
        id: "note",
        file: file.id,
        range: { start: 1, end: 1, side: "deletions" },
        text: "Keep this behavior.",
      },
    ],
  });
  assert.match(markdown, /0\/1 files reviewed/);
  assert.match(markdown, /Not reviewed\./);
  assert.match(markdown, /L1 \(before\)/);
  assert.match(markdown, /Keep this behavior\./);
  const again = await parseReview({
    patch,
    repository: "other",
    branch: "feature",
    base: "main",
    title: "Working changes",
    kind: "patch",
  });
  assert.notEqual(review.id, again.id);
  await assert.rejects(
    parseReview({
      patch: "not a patch",
      repository: "test",
      branch: "after",
      base: "before",
      title: "Invalid",
      kind: "patch",
    }),
    /No file changes/,
  );
});

test("review export counts only distinct files in the comparison", async () => {
  const review = await parseReview({
    patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-before\n+after\n",
    repository: "test",
    branch: "after",
    base: "before",
    title: "Test",
    kind: "patch",
  });
  const id = review.files[0]!.id;
  assert.match(
    formatReview(review, { reviewed: [id, id, "missing"], notes: [] }),
    /1\/1 files reviewed/,
  );
});
