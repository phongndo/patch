// Black-box checks of `patchr install`, `update`, `uninstall` and what a review
// does after an upgrade, in a home folder of their own. PATCHR is the binary.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const built = resolve(process.env.PATCHR ?? "cli/target/release/patchr");
let root: string;
let home: string;
let bin: string;

const file = (path: string) => join(home, path);
const text = (path: string) => readFile(file(path), "utf8");

async function write(path: string, content: string) {
  await mkdir(dirname(file(path)), { recursive: true });
  await writeFile(file(path), content);
}

function run(command: string[], env: Record<string, string> = {}, cwd = home) {
  const done = Bun.spawnSync(command, {
    cwd,
    env: { HOME: home, PATH: process.env.PATH!, PATCH_BROWSER: "none", ...env },
    stdin: "ignore",
  });
  return { code: done.exitCode, out: done.stderr.toString() + done.stdout.toString() };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "patch-install-")));
  home = join(root, "home");
  bin = join(home, ".local/bin/patchr");
  for (const dir of [".claude", ".codex", ".pi/agent", ".gemini"]) {
    await mkdir(file(dir), { recursive: true });
  }
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("installs for the harnesses that are here, by the binary's full path", async () => {
  const { code, out } = run([built, "install"]);
  expect(code).toBe(0);
  expect(out).toMatch(/✓ Claude Code +\/patch/);
  expect(out).toMatch(/✓ Codex +\$patch +trust the hook/);
  expect(out).toContain("add ~/.local/bin to your PATH");
  expect(out).not.toContain("Cursor");
  expect((await lstat(bin)).mode & 0o777).toBe(0o755);
  const gemini = Bun.TOML.parse(await text(".gemini/commands/patch.toml")) as { prompt: string };
  expect(gemini.prompt).toContain(`!{${bin} review {{args}}}`);
  expect(await text(".claude/skills/patch/skills/patch/SKILL.md")).toContain(`Bash(${bin}:*)`);
  expect(await text(".codex/hooks.json")).toContain(`'${bin}' hook codex`);

  // Again from its own place: nothing to trust, nothing to say about PATH.
  const again = run([bin, "install"], { PATH: `${dirname(bin)}:${process.env.PATH}` });
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("trust the hook");
  expect(again.out).not.toContain("PATH");
});

test("--dry-run writes nothing", () => {
  expect(run([built, "install", "--dry-run"]).out).toContain("~/.pi/agent/extensions/patch.ts");
  expect(existsSync(bin)).toBe(false);
  expect(existsSync(file(".local"))).toBe(false);
  expect(existsSync(file(".pi/agent/extensions"))).toBe(false);
});

test("keeps the user's own file, and one harness's failure to itself", async () => {
  await write(".gemini/commands/patch.toml", "mine");
  await write(".pi/agent/extensions", "a file where a folder should be");
  const { code, out } = run([built, "install"]);
  expect(code).toBe(2);
  expect(out).toContain("kept your own ~/.gemini/commands/patch.toml");
  expect(out).toMatch(/✗ Pi /);
  expect(out).toMatch(/✓ Claude Code/);
  expect(await text(".gemini/commands/patch.toml")).toBe("mine");
});

test("says what it works with when no harness is here", async () => {
  await rm(home, { recursive: true });
  await mkdir(home);
  const { code, out } = run([built, "install"]);
  expect(code).toBe(0);
  expect(out).toContain("No agent harness found. Patch works with Claude Code, Codex,");
});

test("uninstall removes everything install wrote", async () => {
  run([built, "install"]);
  expect(run([bin, "uninstall"]).code).toBe(0);
  for (const path of [
    ".local/bin/patchr",
    ".claude/skills/patch",
    ".agents/skills/patch",
    ".local/state/patch/installed.json",
  ]) {
    expect(existsSync(file(path))).toBe(false);
  }
  expect(existsSync(file(".codex/hooks.json"))).toBe(false);
  const left = Array.from(new Bun.Glob("**/*").scanSync({ cwd: home, dot: true, onlyFiles: true }));
  expect(left).toEqual([".local/state/patch/install.lock"]);
});

test("another program called patchr is neither replaced nor removed", async () => {
  await write(".local/bin/patchr", "#!/bin/sh\necho theirs\n");
  const installed = run([built, "install"]);
  expect(installed.code).toBe(2);
  expect(installed.out).toContain("~/.local/bin/patchr is another program");
  expect(existsSync(file(".pi/agent/extensions"))).toBe(false);
  expect(run([built, "uninstall"]).out).toContain("another program");
  expect(await text(".local/bin/patchr")).toContain("theirs");
});

test("edited files and the user's own beside Patch's survive install and uninstall", async () => {
  await write(".claude/skills/patch/hooks/hooks.json", '{"hooks":{}}');
  run([built, "install"]);
  expect(await text(".claude/skills/patch/hooks/hooks.json")).toBe('{"hooks":{}}');
  expect(existsSync(file(".claude/skills/patch/hooks/register.ts"))).toBe(false);

  const pi = ".pi/agent/extensions/patch.ts";
  await write(pi, (await text(pi)) + "// mine, for patchr\n");
  expect(run([bin, "install"]).out).toMatch(/- Pi +kept your own/);
  expect(await text(pi)).toContain("// mine");
  expect(run([bin, "uninstall"]).out).toContain(`kept     ~/${pi}`);
  expect(run([built, "install"]).out).toMatch(/- Pi +kept your own/);
  expect(await text(pi)).toContain("// mine");
  expect(await text(".claude/skills/patch/hooks/hooks.json")).toBe('{"hooks":{}}');
});

test("a failure is never hidden by what worked", async () => {
  await write(".agents/skills", "a file where a folder should be");
  for (const _ of ["first", "again"]) {
    const { code, out } = run([built, "install"]);
    expect(code).toBe(2);
    expect(out).toMatch(/✗ Codex /);
  }
  await rm(file(".agents"), { recursive: true });
  // The record of what was written can't be kept.
  await write("state", "");
  expect(run([built, "install"], { XDG_STATE_HOME: file("state") }).code).toBe(2);
});

test("the next review after an upgrade refreshes untouched files only", async () => {
  const hash = (content: string) => new Bun.CryptoHasher("sha256").update(content).digest("hex");
  run([built, "install"]);
  const [pi, gemini] = [".pi/agent/extensions/patch.ts", ".gemini/commands/patch.toml"];
  const current = await text(pi);
  // What an older version would have left: its files, and its record of them.
  const state = ".local/state/patch/installed.json";
  const record = JSON.parse(await text(state));
  await write(pi, "// patchr, older");
  record.files[file(pi)] = hash("// patchr, older");
  await write(state, JSON.stringify(record));
  await write(gemini, "# patchr, edited");

  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  const review = async (command: string) => {
    const child = Bun.spawn([command, "review", "--no-open", "--local"], {
      cwd: repo,
      env: { HOME: home, PATH: process.env.PATH!, PATCH_BROWSER: "none" },
      stderr: "pipe",
    });
    const reader = child.stderr.getReader();
    let said = "";
    while (!said.includes("Patch is open at")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`patchr exited early: ${said}`);
      said += new TextDecoder().decode(value);
    }
    child.kill();
    await child.exited;
  };
  // A build that isn't the installed one leaves the installed files alone.
  await review(built);
  expect(await text(pi)).toBe("// patchr, older");
  await review(bin);
  expect(await text(pi)).toBe(current);
  expect(await text(gemini)).toBe("# patchr, edited");
});

test("update runs the install script, or the manager that owns the binary", async () => {
  run([built, "install"]);
  const script = join(root, "install.sh");
  await writeFile(script, "echo from-the-script\n");
  const url = { PATCH_INSTALL_SCRIPT: `file://${script}` };
  expect(run([bin, "update"], url).out).toContain("from-the-script");
  expect(run([bin, "update"], { PATCH_INSTALL_SCRIPT: "file:///nowhere" }).code).toBe(2);

  // mise's folders, with an upgrade that moves its `global` link to a newer file.
  const tool = join(root, "mise/installs/github-phongndo-patch");
  for (const version of ["0.1.0", "0.2.0"]) {
    await mkdir(join(tool, version), { recursive: true });
    await copyFile(built, join(tool, version, "patchr"));
  }
  const point = (link: string, version: string) =>
    Bun.spawnSync(["ln", "-sfn", `./${version}`, join(tool, link)]);
  point("latest", "0.2.0");
  point("global", "0.1.0");
  const tools = join(root, "tools");
  await mkdir(tools);
  const upgrade = `#!/bin/sh
case "$1" in
  upgrade) echo "mise ran: $* in $PWD"; echo 0.2.0 > "${root}/selected"; [ ! -e "${tool}/global" ] || ln -sfn ./0.2.0 "${tool}/global" ;;
  which) echo "${tool}/$(cat "${root}/selected")/patchr" ;;
esac
`;
  await writeFile(join(tools, "mise"), upgrade, { mode: 0o755 });
  const env = { ...url, PATH: `${tools}:${process.env.PATH}` };

  run([join(tool, "0.1.0/patchr"), "install"]);
  expect(await readlink(bin)).toBe(join(tool, "global/patchr"));
  const linked = run([bin, "update"], env, root);
  expect(linked.out).toContain(`mise ran: upgrade --global github:phongndo/patch in ${home}`);
  expect(linked.out).toContain("Installed Patch");
  expect(linked.code).toBe(0);
  expect(await realpath(bin)).toBe(join(tool, "0.2.0/patchr"));

  // A mise without `global`: a copy of what it selects, which stays mise's to update.
  await rm(join(tool, "global"));
  run([join(tool, "0.1.0/patchr"), "install"]);
  expect((await lstat(bin)).isSymbolicLink()).toBe(false);
  const copied = run([bin, "update"], env, root);
  expect(copied.out).toContain(`mise ran: upgrade github:phongndo/patch in ${home}`);
  expect(copied.out).not.toContain("from-the-script");
  expect(copied.code).toBe(0);
  expect(JSON.parse(await text(".local/state/patch/installed.json")).copied_from).toBe(
    join(tool, "0.2.0/patchr"),
  );
});
