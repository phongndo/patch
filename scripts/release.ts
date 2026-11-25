// Makes what a release publishes, all from the same binaries:
//
//   bun scripts/release.ts bump <version>             sets the version everywhere
//   bun scripts/release.ts check [tag]                versions agree
//   bun scripts/release.ts notes <commit>             release notes, from the commits
//   bun scripts/release.ts package <target> <binary>  one archive and its checksum
//   bun scripts/release.ts npm                        npm packages, from the archives
//   bun scripts/release.ts formula                    Homebrew's formula, from the checksums
//   bun scripts/release.ts nix                        nix/release.json, from the checksums
//
// Output goes to dist/release. See .github/workflows/release.yml.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist/release");

/** Rust's name for each platform, and npm's. */
const TARGETS = {
  "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
  "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
  "aarch64-unknown-linux-musl": { os: "linux", cpu: "arm64" },
  "x86_64-unknown-linux-musl": { os: "linux", cpu: "x64" },
} as const;

const read = (path: string) => readFileSync(join(root, path), "utf8");
const json = (path: string) => JSON.parse(read(path));
const version: string = json("package.json").version;
const tag = `v${version}`;

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command: string[], cwd = root): string {
  const done = Bun.spawnSync(command, { cwd, stderr: "inherit" });
  if (!done.success) fail(`${command.join(" ")} failed`);
  return done.stdout.toString();
}

function check(expected?: string) {
  const crate = (text: string) => /name = "patchr"\nversion = "([^"]+)"/.exec(text)?.[1];
  const versions = {
    "package.json": version,
    "cli/Cargo.toml": crate(read("cli/Cargo.toml")),
    "cli/Cargo.lock": crate(read("cli/Cargo.lock")),
    "cli/harness/claude/plugin.json": json("cli/harness/claude/plugin.json").version,
    ...(expected && { tag: expected.replace(/^v/, "") }),
  };
  if (new Set(Object.values(versions)).size > 1) fail(`versions differ: ${JSON.stringify(versions)}`);
  console.log(version);
}

function bump(to: string) {
  if (!/^\d+\.\d+\.\d+$/.test(to)) fail(`not a version: ${to}`);
  if (Bun.semver.order(to, version) !== 1) fail(`${to} is not after ${version}`);
  check();
  const set = (path: string, from: string) => {
    const text = read(path);
    if (text.split(from).length !== 2) fail(`expected one ${JSON.stringify(from)} in ${path}`);
    writeFileSync(join(root, path), text.replace(from, from.replace(version, to)));
  };
  set("package.json", `"version": "${version}"`);
  set("cli/harness/claude/plugin.json", `"version": "${version}"`);
  for (const path of ["cli/Cargo.toml", "cli/Cargo.lock"])
    set(path, `name = "patchr"\nversion = "${version}"`);
  console.log(
    `${version} -> ${to}. Next: git commit -am "chore: release ${to}", push, gh workflow run release.yml`,
  );
}

/** Commits since the version before, by what they mean to a user. */
function notes(commit: string) {
  const tags = run(["git", "tag", "--list", "v*.*.*"]).split("\n");
  const older = tags.filter(
    (each) => /^v\d+\.\d+\.\d+$/.test(each) && Bun.semver.order(each.slice(1), version) < 0,
  );
  const previous = older.toSorted((a, b) => Bun.semver.order(a.slice(1), b.slice(1))).at(-1);
  const install = [
    "```sh\nnpx -y patchr install\n```",
    `Or see [other ways](https://github.com/phongndo/patch#readme). Update with \`patchr update\`.`,
  ];
  if (!previous) return console.log(["The first release.", ...install].join("\n\n"));
  // A tag is its source plus one commit, so its parent is what was released.
  const log = run(["git", "log", "--reverse", "--format=%h %s", `${previous}^..${commit}`]);
  const sections = { Breaking: [], New: [], Fixed: [], Faster: [] } as Record<string, string[]>;
  for (const line of log.split("\n")) {
    const [, hash, type, scope, breaking, text] = /^(\w+) (\w+)(?:\(([^)]+)\))?(!?): (.+)$/.exec(line) ?? [];
    const named = { feat: "New", fix: "Fixed", perf: "Faster" }[type ?? ""];
    const section = breaking ? "Breaking" : named;
    if (section) sections[section]!.push(`- ${scope ? `**${scope}:** ` : ""}${text} (${hash})`);
  }
  const listed = Object.entries(sections).filter(([, lines]) => lines.length > 0);
  const parts = listed.map(([name, lines]) => `## ${name}\n\n${lines.join("\n")}`);
  const compare = `https://github.com/phongndo/patch/compare/${previous}...${tag}`;
  console.log([...parts, ...install, `[Every change](${compare})`].join("\n\n"));
}

/** The libraries a binary needs must be on any machine with that system. */
function checkLinks(target: string, binary: string) {
  if (target.endsWith("darwin")) {
    const libraries = run(["otool", "-L", binary]).split("\n").slice(1).filter(Boolean);
    const foreign = libraries.filter((line) => !/^\s+(\/usr\/lib|\/System\/Library)\//.test(line));
    if (foreign.length) fail(`links libraries macOS does not have:\n${foreign.join("\n")}`);
  } else if (/INTERP/.test(run(["readelf", "--program-headers", "--wide", binary]))) {
    fail("is not statically linked");
  }
}

/** A package's license files, or the license it names when it ships none. */
function license(name: string, dir: string, named: string): string {
  const files = readdirSync(dir).filter((entry) => /^(licen[cs]e|copying|notice|unlicense)/i.test(entry));
  const texts = files
    .map((file) => join(dir, file))
    .filter((file) => statSync(file).isFile())
    .map((file) => readFileSync(file, "utf8").trim());
  return [`# ${name}`, ...(texts.length ? texts : [`License: ${named}`])].join("\n\n");
}

/** The page's packages and theirs. */
function pagePackages(): string[] {
  const found = new Map<string, string>();
  const visit = (name: string, from: string) => {
    let dir = from;
    while (!existsSync(join(dir, "node_modules", name, "package.json"))) {
      if (dir === root) return; // optional, and not installed here
      dir = resolve(dir, "..");
    }
    const folder = join(dir, "node_modules", name);
    if (found.has(folder)) return;
    const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    found.set(folder, license(`${name} ${manifest.version}`, folder, manifest.license));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, folder);
  };
  for (const name of [...Object.keys(json("package.json").dependencies), "@pierre/icons", "geist"]) {
    visit(name, root);
  }
  return [...found.values()];
}

/** The crates linked into the binary. */
function crates(target: string): string[] {
  const manifest = join(root, "cli/Cargo.toml");
  const cargo = "cargo metadata --locked --format-version 1 --filter-platform".split(" ");
  const metadata = JSON.parse(run([...cargo, target, "--manifest-path", manifest]));
  const nodes = new Map<string, any>(metadata.resolve.nodes.map((node: any) => [node.id, node]));
  const linked = new Set<string>();
  const visit = (id: string) => {
    if (linked.has(id)) return;
    linked.add(id);
    for (const { pkg, dep_kinds } of nodes.get(id).deps) {
      if (dep_kinds.some(({ kind }: { kind: string | null }) => kind === null)) visit(pkg);
    }
  };
  visit(metadata.resolve.root);
  linked.delete(metadata.resolve.root);
  return metadata.packages
    .filter((each: any) => linked.has(each.id))
    .map((each: any) =>
      license(`${each.name} ${each.version}`, resolve(each.manifest_path, ".."), each.license),
    );
}

/** Licenses of what the binary contains. */
function notices(target: string): string {
  const parts = [read("web/themes/community/NOTICE.md").trim(), ...pagePackages(), ...crates(target)];
  return parts.join(`\n\n${"-".repeat(72)}\n\n`) + "\n";
}

function pack(target: string, binary: string) {
  if (!(target in TARGETS)) fail(`unknown target ${target}`);
  checkLinks(target, resolve(binary));
  const name = `patchr-${tag}-${target}`;
  const dir = join(out, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(resolve(binary), join(dir, "patchr"));
  chmodSync(join(dir, "patchr"), 0o755);
  for (const file of ["README.md", "LICENSE"]) cpSync(join(root, file), join(dir, file));
  writeFileSync(join(dir, "THIRD_PARTY_NOTICES.md"), notices(target));
  run(["tar", "-czf", `${name}.tar.gz`, name], out);
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(join(out, `${name}.tar.gz`))).digest("hex");
  writeFileSync(join(out, `${name}.tar.gz.sha256`), `${hash}  ${name}.tar.gz\n`);
  rmSync(dir, { recursive: true });
  console.log(join(out, `${name}.tar.gz`));
}

function checksum(asset: string): string {
  const [hash, name] = readFileSync(join(out, `${asset}.sha256`), "utf8")
    .trim()
    .split(/\s+/);
  if (name !== asset || !/^[0-9a-f]{64}$/.test(hash ?? "")) fail(`bad checksum for ${asset}`);
  return hash!;
}

/** One package per platform, and `patchr`, which depends on whichever one fits. */
function npm() {
  const dir = join(out, "npm");
  rmSync(dir, { recursive: true, force: true });
  const common = {
    version,
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/phongndo/patch.git" },
    homepage: "https://github.com/phongndo/patch#readme",
    publishConfig: { access: "public" },
  };
  const write = (folder: string, manifest: object) =>
    writeFileSync(join(folder, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const optionalDependencies: Record<string, string> = {};
  for (const [target, { os, cpu }] of Object.entries(TARGETS)) {
    const archive = `patchr-${tag}-${target}`;
    // A local check may have built only its own platform.
    if (!existsSync(join(out, `${archive}.tar.gz`))) {
      if (process.env.CI) fail(`missing ${archive}.tar.gz`);
      continue;
    }
    const name = `@phongndo/patchr-${os}-${cpu}`;
    const folder = join(dir, `patchr-${os}-${cpu}`);
    mkdirSync(join(folder, "bin"), { recursive: true });
    run(["tar", "-xzf", join(out, `${archive}.tar.gz`), "--strip-components=1", "-C", folder]);
    cpSync(join(folder, "patchr"), join(folder, "bin/patchr"));
    rmSync(join(folder, "patchr"));
    writeFileSync(
      join(folder, "README.md"),
      `The ${os} ${cpu} binary of [patchr](https://www.npmjs.com/package/patchr).\n`,
    );
    write(folder, {
      name,
      description: `Patch's binary for ${os} ${cpu}`,
      ...common,
      os: [os],
      cpu: [cpu],
      files: ["bin", "THIRD_PARTY_NOTICES.md"],
    });
    optionalDependencies[name] = version;
  }
  const main = join(dir, "patchr");
  cpSync(join(root, "npm"), main, { recursive: true });
  for (const file of ["README.md", "LICENSE"]) cpSync(join(root, file), join(main, file));
  write(main, {
    name: "patchr",
    description: json("package.json").description,
    keywords: ["code-review", "diff", "claude-code", "codex", "pi", "opencode", "gemini-cli", "cursor"],
    ...common,
    bin: { patchr: "bin/patchr.js" },
    files: ["bin"],
    engines: { node: ">=18" },
    optionalDependencies,
  });
  console.log(dir);
}

function formula() {
  const branch = (cpu: string, target: string) => {
    const asset = `patchr-${tag}-${target}.tar.gz`;
    return `    on_${cpu} do
      url "https://github.com/phongndo/patch/releases/download/${tag}/${asset}"
      sha256 "${checksum(asset)}"
    end`;
  };
  const system = (name: string, rust: string) => `  on_${name} do
${branch("arm", `aarch64-${rust}`)}
${branch("intel", `x86_64-${rust}`)}
  end`;
  const text = `class Patchr < Formula
  desc "Browser diff review loop for coding agents"
  homepage "https://github.com/phongndo/patch"
  version "${version}"
  license "MIT"

${system("macos", "apple-darwin")}

${system("linux", "unknown-linux-musl")}

  def install
    bin.install "patchr"
  end

  def caveats
    <<~EOS
      Add /patch to your agent harnesses with:
        #{opt_bin}/patchr install
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/patchr --version")
  end
end
`;
  writeFileSync(join(out, "patchr.rb"), text);
  console.log(join(out, "patchr.rb"));
}

/** What flake.nix downloads: Nix users get the release rather than a build. */
function nix() {
  const asset = (target: string) => {
    const name = `patchr-${tag}-${target}.tar.gz`;
    return {
      url: `https://github.com/phongndo/patch/releases/download/${tag}/${name}`,
      sha256: checksum(name),
    };
  };
  const systems = Object.entries(TARGETS).map(([target, { os, cpu }]) => [
    `${cpu === "arm64" ? "aarch64" : "x86_64"}-${os}`,
    asset(target),
  ]);
  mkdirSync(join(root, "nix"), { recursive: true });
  const release = { version, systems: Object.fromEntries(systems) };
  writeFileSync(join(root, "nix/release.json"), JSON.stringify(release, null, 2) + "\n");
  console.log("nix/release.json");
}

const [command, ...args] = process.argv.slice(2);
if (command === "check") check(args[0]);
else if (command === "bump" && args[0]) bump(args[0]);
else if (command === "notes" && args[0]) notes(args[0]);
else if (command === "package" && args.length === 2) pack(args[0]!, args[1]!);
else if (command === "npm") npm();
else if (command === "formula") formula();
else if (command === "nix") nix();
else fail("expected bump, check, notes, package, npm, formula or nix; see the top of scripts/release.ts");
