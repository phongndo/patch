// Checks Patch's highlighter (syntaxmate, through src/native/syntaxmate.zig)
// against vscode-textmate, the tokenizer Shiki and VS Code run: both tokenize
// each file given (directories are walked) with Patch's grammars, and every
// token's byte range and scopes must agree.
//
//   node scripts/compare-textmate.mjs path/to/files...
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vt from "@shikijs/vscode-textmate";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";

const root = new URL("../", import.meta.url).pathname;
const files = process.argv.slice(2).flatMap(function walk(path) {
  return statSync(path).isDirectory()
    ? readdirSync(path).flatMap((name) => walk(join(path, name)))
    : [path];
});
if (files.length === 0) throw new Error("usage: compare-textmate.mjs FILE|DIR...");

// The Zig side: each file's language, then its tokens.
const { stdout } = await promisify(execFile)(
  "zig",
  ["build", "bench-highlight", "--", "--scopes", ...files],
  { cwd: root, maxBuffer: 1 << 30 },
);
const zig = new Map();
let current;
for (const line of stdout.split("\n")) {
  if (line.startsWith("F ")) {
    const [, path, scope] = line.split(" ");
    current = { scope, lines: [] };
    zig.set(path, current);
  } else if (current && line) current.lines.push(line);
}

// The bundled grammars and their injections, from grammars.zig.
const table = readFileSync(join(root, "src/native/grammars.zig"), "utf8");
const names = [
  ...table
    .slice(table.indexOf("pub const Language"))
    .split("};")[0]
    .matchAll(/^\s+(?:@")?([^",\s]+)"?,$/gm),
].map((m) => m[1]);
const rows = [
  ...table
    .slice(table.indexOf("pub const grammars"))
    .split("pub const extensions")[0]
    .matchAll(/\.scope = "([^"]+)"(?:.*?\.injections = &\.\{ ([^}]*) \})?/g),
];
const fileOf = new Map(rows.map((m, i) => [m[1], names[i]]));
const injections = new Map(
  rows
    .filter((m) => m[2])
    .map((m) => [
      m[1],
      m[2].split(", ").map((t) => rows[names.indexOf(t.replace(/^\.(@")?|"$/g, ""))][1]),
    ]),
);
const grammarDir = join(root, "node_modules/tm-grammars/grammars");
const registry = new vt.Registry({
  onigLib: await createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined")).then(
    (engine) => ({
      createOnigScanner: (patterns) => engine.createScanner(patterns),
      createOnigString: (text) => engine.createString(text),
    }),
  ),
  loadGrammar(scope) {
    const name = fileOf.get(scope);
    if (!name) return null;
    const local = join(root, "src/native/grammars", `${name}.json`);
    return JSON.parse(
      readFileSync(existsSync(local) ? local : join(grammarDir, `${name}.json`), "utf8"),
    );
  },
  getInjections: (scope) => injections.get(scope),
});

const encoder = new TextEncoder();
function reference(scope, path) {
  const grammar = registry.loadGrammar(scope);
  let state = vt.INITIAL;
  const out = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      out.push(`L${index}`);
      // highlight.zig leaves longer lines plain, as VS Code does.
      if (encoder.encode(line).length > 20_000) return;
      const result = grammar.tokenizeLine(line, state);
      state = result.ruleStack;
      const bytes = (at) => encoder.encode(line.slice(0, Math.min(at, line.length))).length;
      for (const token of result.tokens) {
        const start = bytes(token.startIndex);
        const end = bytes(token.endIndex);
        if (end > start) out.push(`${start} ${end} ${token.scopes.join(" ")}`);
      }
    });
  return out;
}

// Syntaxmate joins neighbouring tokens whose scopes are the same, where
// vscode-textmate can leave them apart (a string's quotes and body, say, when
// no capture names them). Nothing that colors tokens can tell the two apart,
// so both sides are joined before comparing.
function joined(lines) {
  const out = [];
  let last = null;
  for (const line of lines) {
    if (line.startsWith("L")) {
      out.push(line);
      last = null;
      continue;
    }
    const [start, end, ...scopes] = line.split(" ");
    const names = scopes.join(" ");
    if (last && last.end === start && last.names === names) {
      last.end = end;
      out[out.length - 1] = `${last.start} ${end} ${names}`;
    } else {
      last = { start, end, names };
      out.push(line);
    }
  }
  return out;
}

let same = 0;
let differ = 0;
for (const [path, { scope, lines: raw }] of zig) {
  const lines = joined(raw);
  const expected = joined(reference(scope, path));
  const at = expected.findIndex((line, i) => line !== lines[i]);
  if (at === -1 && expected.length === lines.length) {
    same++;
    continue;
  }
  differ++;
  console.log(
    `${path} (${scope}) differs:\n  vscode-textmate: ${expected[at]}\n  Patch:           ${lines[at]}`,
  );
}
console.log(`${same} files agree, ${differ} differ; ${files.length - zig.size} have no language`);
process.exitCode = differ > 0 ? 1 : 0;
