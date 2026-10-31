import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import type { ReviewMode, ReviewSource } from "../src/review/types.ts";

function git(cwd: string, args: string[], allowDifference = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (!error || (allowDifference && error.code === 1)) resolve(stdout);
        else reject(new Error(stderr.trim() || error.message));
      },
    );
  });
}

const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--unified=5"];

export async function readGitReview(
  directory: string,
  mode: ReviewMode = "working",
  base = "main",
): Promise<ReviewSource> {
  const root = (await git(resolve(directory), ["rev-parse", "--show-toplevel"])).trim();
  const branch = (await git(root, ["branch", "--show-current"])).trim() || "detached HEAD";
  let head: string | undefined;
  try {
    head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    /* Unborn branch. */
  }
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  let patch: string;
  if (mode === "branch") {
    if (!head) throw new Error("Make an initial commit before comparing branches.");
    const revision = (
      await git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])
    ).trim();
    patch = await git(root, ["diff", ...diffFlags, `${revision}...${head}`, "--"]);
  } else if (mode === "staged") {
    patch = await git(root, ["diff", ...diffFlags, "--cached", head ?? emptyTree, "--"]);
  } else {
    patch = await git(root, ["diff", ...diffFlags, head ?? emptyTree, "--"]);
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    // Bounded subprocesses keep large repositories responsive.
    const pieces = new Array<string>(untracked.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, untracked.length) }, async () => {
        while (cursor < untracked.length) {
          const index = cursor++;
          const path = untracked[index];
          if (path)
            pieces[index] = await git(
              root,
              ["diff", "--no-index", ...diffFlags, "--", "/dev/null", path],
              true,
            );
        }
      }),
    );
    patch += pieces.join("");
  }
  if (Buffer.byteLength(patch) > 64 * 1024 * 1024)
    throw new Error("This change exceeds the 64 MB review limit.");
  return {
    patch,
    repository: basename(root),
    branch: mode === "working" ? "working tree" : mode === "staged" ? "index" : branch,
    base: mode === "branch" ? base : branch,
    title:
      mode === "branch"
        ? "Branch changes"
        : mode === "staged"
          ? "Staged changes"
          : "Working changes",
    kind: "git",
    mode,
  };
}
