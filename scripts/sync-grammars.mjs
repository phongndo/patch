// Writes src/native/grammars.zig: which tm-grammars grammars Patch bundles,
// the files each one claims (from GitHub Linguist's language list), and which
// grammars inject into which; and src/native/grammars/markdown-fences.json,
// which fences code in Markdown for the languages its grammar leaves out. Run after bumping tm-grammars in package.json
// and build.zig.zon together, then `pnpm format`.
import { readFile, writeFile } from "node:fs/promises";
import { grammars, injections } from "tm-grammars";
import * as linguist from "linguist-languages";

const root = new URL("../", import.meta.url);
const version = JSON.parse(
  await readFile(new URL("node_modules/tm-grammars/package.json", root), "utf8"),
).version;
const zon = await readFile(new URL("build.zig.zon", root), "utf8");
if (!zon.includes(`tm-grammars-${version}.tgz`))
  throw new Error(`build.zig.zon does not pin tm-grammars ${version}`);
const linguistVersion = JSON.parse(
  await readFile(new URL("node_modules/linguist-languages/package.json", root), "utf8"),
).version;

// Copyleft grammars would bind the app's own license; leave them out.
const copyleft = new Set(["GPL-3.0", "GNU"]);
// Framework injections that would otherwise reach every Markdown file.
const dropped = new Set(["markdown-vue"]);
const injectTargetsDropped = {
  "vue-directives": ["text.html.markdown"],
  "vue-interpolations": ["text.html.markdown"],
};

const all = [...grammars, ...injections].filter(
  (g) => !copyleft.has(g.license) && !dropped.has(g.name),
);
all.sort((a, b) => (a.name < b.name ? -1 : 1));
const byName = new Map(all.map((g) => [g.name, g]));
const byScope = new Map(all.map((g) => [g.scopeName, g]));
const excluded = [...grammars, ...injections]
  .filter((g) => copyleft.has(g.license))
  .map((g) => g.name);

// Markdown's grammar colors fenced code in some 60 languages. A grammar of
// our own, injected the way markdown-nix is, fences the rest by name.
const grammarFile = (g) =>
  g.local
    ? new URL(`src/native/grammars/${g.name}.json`, root)
    : new URL(`node_modules/tm-grammars/grammars/${g.name}.json`, root);
const markdown = JSON.parse(await readFile(grammarFile(byName.get("markdown")), "utf8"));
const fenced = new Set(
  JSON.stringify(markdown.repository)
    .match(/"include":"source\.[^"#]+"/g)
    .map((m) => m.slice(11, -1)),
);
fenced.add("source.nix");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\#-]/g, "\\$&");
// One pattern finds a fence naming any of these languages, so Markdown pays
// for one regex per line; the language's own rule then reads the name where
// it stopped (\G), and its `while` ends the code at the closing fence.
const fenceLanguages = all
  .filter((g) => !g.injectionSelector && !fenced.has(g.scopeName) && g.name !== "markdown")
  .map((g) => ({
    g,
    names: [g.name, ...(g.aliases ?? [])].filter((n) => /^[\x21-\x7e]+$/.test(n)),
  }));
const info = "((\\s+|[,:?{])[^`~]*)?$";
const fenceGrammar = {
  name: "markdown-fences",
  scopeName: "markdown.fences.codeblock",
  injectTo: ["text.html.markdown"],
  injectionSelector: "L:text.html.markdown",
  patterns: [
    {
      begin: `(^|\\G)(\\s*)(\`{3,}|~{3,})\\s*(?=(?i:${fenceLanguages
        .flatMap((l) => l.names)
        .map(escape)
        .join("|")})${info})`,
      beginCaptures: { 3: { name: "punctuation.definition.markdown" } },
      end: "(^|\\G)(\\2|\\s{0,3})(\\3)\\s*$",
      endCaptures: { 3: { name: "punctuation.definition.markdown" } },
      name: "markup.fenced_code.block.markdown",
      patterns: fenceLanguages.map(({ g, names }) => ({
        begin: `\\G(?i:(${names.map(escape).join("|")}))${info}`,
        beginCaptures: {
          1: { name: "fenced_code.block.language.markdown" },
          2: { name: "fenced_code.block.language.attributes.markdown" },
        },
        contentName: `meta.embedded.block.${g.name}`,
        patterns: [{ include: g.scopeName }],
        while: "(^|\\G)(?!\\s*([`~]{3,})\\s*$)",
      })),
    },
  ],
};
await writeFile(
  new URL("src/native/grammars/markdown-fences.json", root),
  JSON.stringify(fenceGrammar, null, 2) + "\n",
);
all.push({
  name: "markdown-fences",
  displayName: "Markdown fences",
  scopeName: fenceGrammar.scopeName,
  injectionSelector: fenceGrammar.injectionSelector,
  local: true,
});
all.sort((a, b) => (a.name < b.name ? -1 : 1));
byName.set(
  "markdown-fences",
  all.find((g) => g.name === "markdown-fences"),
);
byScope.set(fenceGrammar.scopeName, byName.get("markdown-fences"));

// Each grammar's JSON says which scopes it injects into.
const injectedInto = new Map();
for (const g of all) {
  const json = JSON.parse(await readFile(grammarFile(g), "utf8"));
  if (json.scopeName !== g.scopeName) throw new Error(`${g.name}: scope ${json.scopeName}`);
  for (const target of json.injectTo ?? []) {
    if (injectTargetsDropped[g.name]?.includes(target)) continue;
    const host = byScope.get(target);
    if (!host) continue;
    if (!injectedInto.has(host.name)) injectedInto.set(host.name, []);
    injectedInto.get(host.name).push(g.name);
  }
}

// Ties between languages that claim the same extension or file name go to
// the earlier one here, then to the language that lists it first.
const popular = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "php",
  "ruby",
  "swift",
  "kotlin",
  "objective-c",
  "scala",
  "shellscript",
  "html",
  "css",
  "scss",
  "json",
  "yaml",
  "toml",
  "markdown",
  "sql",
  "perl",
  "lua",
  "r",
  "dart",
  "elixir",
  "erlang",
  "haskell",
  "ocaml",
  "clojure",
  "common-lisp",
  "zig",
  "nix",
  "xml",
  "verilog",
  "fortran-free-form",
  "matlab",
  "julia",
  "groovy",
  "powershell",
  "make",
  "docker",
  "cmake",
  "terraform",
  "hcl",
];
const rank = (name) => {
  const index = popular.indexOf(name);
  return index === -1 ? popular.length : index;
};
// Claims Linguist can't settle, and what it calls by other names.
const overrides = {
  extensions: {
    h: "cpp",
    m: "objective-c",
    mm: "objective-cpp",
    pl: "perl",
    v: "verilog",
    inc: "php",
    s: "asm",
    asm: "asm",
    nasm: "asm",
    S: "asm",
    ml: "ocaml",
    mli: "ocaml",
    cl: "common-lisp",
    l: "common-lisp",
    lisp: "common-lisp",
    el: "emacs-lisp",
    scm: "scheme",
    ss: "scheme",
    rkt: undefined,
    fs: "fsharp",
    fsx: "fsharp",
    fsi: "fsharp",
    t: "perl",
    pm: "perl",
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    jsx: "jsx",
    md: "markdown",
    sv: "system-verilog",
    svh: "system-verilog",
    vh: "verilog",
    glsl: "glsl",
    vert: "glsl",
    frag: "glsl",
    hlsl: "hlsl",
    metal: "cpp",
    cu: "cpp",
    cuh: "cpp",
    zon: "zig",
    mips: "mipsasm",
    riscv: "riscv",
    ll: "llvm",
    wat: "wasm",
    wast: "wasm",
    tf: "terraform",
    tfvars: "terraform",
    hcl: "hcl",
    nomad: "hcl",
    sh: "shellscript",
    bash: "shellscript",
    zsh: "shellscript",
    r: "r",
    sql: "sql",
    props: "xml",
    targets: "xml",
    csproj: "xml",
    fsproj: "xml",
    vcxproj: "xml",
    plist: "xml",
    svg: "xml",
    xaml: "xml",
    d: "d",
    sc: "scala",
    prisma: "prisma",
    ex: "elixir",
    exs: "elixir",
    vue: "vue",
    svelte: "svelte",
    astro: "astro",
    lock: undefined,
    json5: "json5",
    jsonl: "jsonl",
    ndjson: "jsonl",
    hjson: "hjson",
    tex: "latex",
    sty: "latex",
    cls: "latex",
    vb: "vb",
    bas: "vb",
    vbs: "vb",
    f: "fortran-fixed-form",
    for: "fortran-fixed-form",
    f77: "fortran-fixed-form",
    log: "log",
    beancount: "beancount",
    service: "systemd",
    socket: "systemd",
    timer: "systemd",
    mount: "systemd",
    target: "systemd",
    path: "systemd",
    mdc: "mdc",
    qss: "qss",
    wy: "wenyan",
    dax: "dax",
    logo: "logo",
    narrat: "narrat",
    fsl: "jssm",
    ara: "ara",
    tasl: "tasl",
    rel: "rel",
    spl: "splunk",
    gradle: "groovy",
    editorconfig: "ini",
    gitconfig: "ini",
    mustache: "handlebars",
    njk: "jinja",
    tmlanguage: "xml",
    tmsnippet: "xml",
    tmpreferences: "xml",
    tmcommand: "xml",
    tmtheme: "xml",
  },
  basenames: {
    "CMakeLists.txt": "cmake",
    Dockerfile: "docker",
    Containerfile: "docker",
    Makefile: "make",
    makefile: "make",
    GNUmakefile: "make",
    BUILD: "python",
    "BUILD.bazel": "python",
    WORKSPACE: "python",
    "WORKSPACE.bazel": "python",
    "MODULE.bazel": "python",
    "flake.lock": "json",
    "Cargo.lock": "toml",
    "uv.lock": "toml",
    "poetry.lock": "toml",
    ".envrc": "shellscript",
    PKGBUILD: "shellscript",
    Justfile: "just",
    justfile: "just",
    CODEOWNERS: "codeowners",
    ".env": "dotenv",
    "git-rebase-todo": "git-rebase",
    COMMIT_EDITMSG: "git-commit",
    MERGE_MSG: "git-commit",
    qmldir: "qmldir",
    ".editorconfig": "ini",
    ".gitconfig": "ini",
    ".gitmodules": "ini",
    ".npmrc": "ini",
  },
  interpreters: { sh: "shellscript", bash: "shellscript", zsh: "shellscript", node: "javascript" },
};

const claims = { extensions: new Map(), basenames: new Map(), interpreters: new Map() };
function claim(table, key, name, first, source) {
  if (!key || !byName.has(name)) return;
  const list = claims[table].get(key) ?? [];
  list.push({ name, first, source });
  claims[table].set(key, list);
}
const normal = (s) => s.toLowerCase().replace(/[\s_]+/g, "-");
const matched = new Set();
for (const language of Object.values(linguist)) {
  let grammar = byScope.get(language.tmScope);
  if (!grammar) {
    const keys = [language.name, ...(language.aliases ?? [])].map(normal);
    grammar = all.find((g) => [g.name, ...(g.aliases ?? [])].some((a) => keys.includes(normal(a))));
  }
  if (!grammar || grammar.injectionSelector) continue;
  matched.add(grammar.name);
  (language.extensions ?? []).forEach((ext, i) =>
    claim("extensions", ext.slice(1), grammar.name, i === 0, language.name),
  );
  for (const file of language.filenames ?? [])
    claim("basenames", file, grammar.name, true, language.name);
  for (const exe of language.interpreters ?? [])
    claim("interpreters", exe, grammar.name, true, language.name);
}

function settle(table) {
  const result = new Map();
  for (const [key, list] of claims[table]) {
    if (table === "extensions" && key.toLowerCase() !== key && claims[table].has(key.toLowerCase()))
      continue;
    list.sort(
      (a, b) =>
        Number(b.first) - Number(a.first) ||
        rank(a.name) - rank(b.name) ||
        (a.name < b.name ? -1 : 1),
    );
    result.set(table === "extensions" ? key.toLowerCase() : key, list[0].name);
  }
  for (const [key, name] of Object.entries(overrides[table])) {
    const k = table === "extensions" ? key.toLowerCase() : key;
    if (name === undefined) result.delete(k);
    else if (!byName.has(name)) throw new Error(`override ${key}: no grammar ${name}`);
    else result.set(k, name);
  }
  return [...result].sort(([a], [b]) => (a < b ? -1 : 1));
}
const extensions = settle("extensions");
const basenames = settle("basenames");
const interpreters = settle("interpreters");

// Zig's keywords and primitive type names can't be bare enum tags.
const reserved = new Set(
  "addrspace align allowzero and anyframe anytype asm break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable var volatile while bool type void".split(
    " ",
  ),
);
const tag = (name) =>
  /^[a-z_][a-z0-9_]*$/.test(name) && !reserved.has(name) ? name : `@"${name}"`;
const str = (s) => JSON.stringify(s);
const pairs = (rows) => rows.map(([k, v]) => `    .{ ${str(k)}, .${tag(v)} },`).join("\n");
const out = `//! The TextMate grammars Patch bundles: tm-grammars ${version}, less the
//! GPL ones (${excluded.join(", ")}), with the files each language claims
//! from GitHub Linguist (linguist-languages ${linguistVersion}). Generated by
//! scripts/sync-grammars.mjs; build.zig embeds each grammar's JSON.

/// Every bundled grammar, by its tm-grammars name.
pub const Language = enum(u16) {
${all.map((g) => `    ${tag(g.name)},`).join("\n")}
};

pub const Grammar = struct {
    scope: []const u8,
    /// Its display name.
    title: []const u8,
    /// Grammars whose injection selectors apply inside this one.
    injections: []const Language = &.{},
    /// Its JSON is in src/native/grammars/, not tm-grammars.
    local: bool = false,
};

/// Indexed by \`Language\`.
pub const grammars = [_]Grammar{
${all
  .map((g) => {
    const inj = injectedInto.get(g.name);
    const extra = inj ? `, .injections = &.{ ${inj.map((n) => `.${tag(n)}`).join(", ")} }` : "";
    const local = g.local ? ", .local = true" : "";
    return `    .{ .scope = ${str(g.scopeName)}, .title = ${str(g.displayName ?? g.name)}${extra}${local} },`;
  })
  .join("\n")}
};

/// Lowercase extensions without their dot.
pub const extensions = [_]struct { []const u8, Language }{
${pairs(extensions)}
};

/// Whole file names.
pub const basenames = [_]struct { []const u8, Language }{
${pairs(basenames)}
};

/// Programs a \`#!\` line names.
pub const interpreters = [_]struct { []const u8, Language }{
${pairs(interpreters)}
};
`;
await writeFile(new URL("src/native/grammars.zig", root), out);
const unclaimed = all.filter(
  (g) =>
    !g.injectionSelector &&
    !matched.has(g.name) &&
    !extensions.some(([, n]) => n === g.name) &&
    !basenames.some(([, n]) => n === g.name),
);
console.log(
  `${all.length} grammars, ${extensions.length} extensions, ${basenames.length} file names, ${interpreters.length} interpreters`,
);
console.log(`no files claimed: ${unclaimed.map((g) => g.name).join(" ")}`);
