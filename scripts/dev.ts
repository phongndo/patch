// Reviews this repository with the working copy: rebuilds the page as it changes
// and restarts the CLI when its Rust does. It ends with the review, and takes
// everything it started along. Arguments go to `patchr review`.
import { watch } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const bin = join(root, "node_modules/.bin");
const patchr = join(root, "cli/target/debug/patchr");
type Child = Bun.Subprocess<"ignore", "inherit", "inherit">;
const running = new Set<Child>();

function start(command: string[], env: Record<string, string> = {}): Child {
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    onExit: () => void running.delete(child),
  });
  running.add(child);
  return child;
}

async function stop(code: number): Promise<never> {
  const children = [...running];
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exited));
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void stop(130));
}

/** One port for every restart, so the open tab finds the new server. */
const port = await new Promise<number>((done) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => done(typeof address === "object" ? (address?.port ?? 0) : 0));
  });
});

let review: Child | undefined;
let restarting = false;

function open(first: boolean) {
  const args = ["review", "--dev", "--local", ...(first ? [] : ["--no-open"]), ...process.argv.slice(2)];
  const child = start([patchr, ...args], { PATCH_PORT: String(port) });
  review = child;
  void child.exited.then((code) => {
    if (review === child && !restarting) void stop(code);
  });
}

const build = () => start(["cargo", "build", "--manifest-path", "cli/Cargo.toml"]).exited;

let building = false;
let again = false;
async function rebuild() {
  again = true;
  if (building) return;
  building = true;
  while (again) {
    again = false;
    if ((await build()) !== 0 || again) continue;
    restarting = true;
    review?.kill();
    await review?.exited;
    open(false);
    restarting = false;
  }
  building = false;
}

// The page first: the CLI embeds its folder.
// The page is served from disk here, so it is not compressed for embedding (vite.config.ts).
const page = { PATCH_DEV: "1" };
if ((await start([join(bin, "vite"), "build"], page).exited) !== 0 || (await build()) !== 0) await stop(1);
start([join(bin, "vite"), "build", "--watch"], page);
open(true);

let soon: Timer | undefined;
for (const folder of ["cli/src", "cli/harness"]) {
  watch(join(root, folder), { recursive: true }, () => {
    clearTimeout(soon);
    soon = setTimeout(() => void rebuild(), 100);
  });
}
