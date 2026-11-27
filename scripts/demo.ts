// Builds a repository with one of every kind of change Patch shows (images, SVG, Markdown, code,
// renames, odd names, hostile files, the edges of "More lines") and reviews it with the dev loop,
// so a regression shows at a glance. CHECKLIST.md in it says what each file should look like.
//
//   bun run demo [dir]          build it (default: a new folder in $TMPDIR) and review it
//                               (an existing dir is replaced only if it is an earlier demo)
//   bun run demo --no-review    only build it
import { deflateSync } from "node:zlib";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const given = args.find((arg) => !arg.startsWith("--"));
const dir = given ? resolve(given) : mkdtempSync(join(tmpdir(), "patch-demo-"));
/** Marks a folder this script made, which alone it will empty to make again. */
const MARK = ".git/patch-demo";

// ---------------------------------------------------------------------------------------------
// Images, made here so the demo needs nothing installed. JPEG and GIF are small fixtures.

type Rgba = [number, number, number, number];
type Pixel = (x: number, y: number, w: number, h: number) => Rgba;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(w: number, h: number, pixel: Pixel): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y, w, h).map(Math.round), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, w);
  new DataView(header.buffer).setUint32(4, h);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return concat(
    pngSignature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  );
}

function bmp(w: number, h: number, pixel: Pixel): Uint8Array {
  const row = Math.ceil((w * 3) / 4) * 4;
  const out = new Uint8Array(54 + row * h);
  const view = new DataView(out.buffer);
  out.set([0x42, 0x4d]);
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, h - 1 - y, w, h);
      out.set([b, g, r].map(Math.round), 54 + y * row + x * 3);
    }
  return out;
}

const mix = (a: number[], b: number[], t: number) => a.map((value, i) => value + (b[i]! - value) * t);
const gradient =
  (from: number[], to: number[]): Pixel =>
  (x, y, w, h) =>
    [...mix(from, to, (x / w + y / h) / 2), 255] as Rgba;
const disc =
  (color: number[]): Pixel =>
  (x, y, w, h) => {
    const d = Math.hypot(x - w / 2, y - h / 2) / (Math.min(w, h) / 2);
    return [...color, d < 0.9 ? 255 : d < 1 ? 255 * (1 - (d - 0.9) / 0.1) : 0] as Rgba;
  };
const waves =
  (shift: number): Pixel =>
  (x, y) => {
    const v = (Math.sin(x / 23 + shift) + Math.cos(y / 17) + Math.sin((x + y) / 31)) / 3;
    return [40 + 90 * (v + 1), 70 + 60 * (1 - v), 160 + 40 * v, 255];
  };
const pixelArt =
  (on: number[]): Pixel =>
  (x, y) =>
    (Math.abs(x - 7.5) + Math.abs(y - 7.5) < 6 ? [...on, 255] : [0, 0, 0, 0]) as Rgba;
const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "demo", name)));

// ---------------------------------------------------------------------------------------------
// Text.

const lines = (count: number, line: (n: number) => string) =>
  Array.from({ length: count }, (_, i) => line(i + 1)).join("\n") + "\n";

const checkSvg = (
  fill: string,
  gradient = false,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96">
${gradient ? '  <defs>\n    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0" stop-color="#34d399"/>\n      <stop offset="1" stop-color="#059669"/>\n    </linearGradient>\n  </defs>\n' : ""}  <circle cx="12" cy="12" r="10" fill="${gradient ? "url(#g)" : fill}"/>
  <path d="M7 12.5l3 3 7-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
</svg>
`;

const illustration = (accent: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240" width="400" height="240">\n  <rect width="400" height="240" fill="#0f172a"/>\n` +
  Array.from({ length: 60 }, (_, i) => {
    const x = 20 + (i % 12) * 31;
    const y = 30 + Math.floor(i / 12) * 42;
    const fill = i === 30 ? accent : `hsl(${(i * 37) % 360} 70% 60%)`;
    return `  <circle cx="${x}" cy="${y}" r="${8 + (i % 5) * 2}" fill="${fill}" opacity="0.85"/>`;
  }).join("\n") +
  "\n</svg>\n";

const readme = {
  old: "# Lumen\n\nA tiny image toolkit.\n\n## Install\n\n    npm install lumen\n\n## Usage\n\nCall `lumen.resize()` with a path.\n\n- Fast\n- Small\n",
  now: `# Lumen

A tiny, **fast** image toolkit for Node and the browser.

> Lumen resizes, crops and converts images without native dependencies.

## Install

\`\`\`sh
npm install lumen
\`\`\`

## Usage

\`\`\`ts
import { resize } from "lumen";

const thumb = await resize("photo.png", { width: 320 });
\`\`\`

| Function    | What it does       | Since |
| ----------- | ------------------ | ----- |
| \`resize()\`  | Scales to a width  | 0.1   |
| \`crop()\`    | Cuts a region      | 0.2   |
| \`convert()\` | Changes the format | 0.2   |

## Roadmap

- [x] Resize
- [x] Crop
- [ ] AVIF output

See the [guide](docs/guide.md) or the [website](https://example.com).
`,
};

const longDoc = (changed: boolean) =>
  "# Design notes\n\n" +
  Array.from({ length: 40 }, (_, i) => {
    const n = i + 1;
    const body =
      changed && n === 20
        ? "This section was **rewritten**: the cache is now keyed by content, not by path.\n\n- [x] keyed by content\n- [ ] evicted by size"
        : `Section ${n} explains one decision in a few sentences, so the document is long enough to scroll.`;
    return `## ${n}. Topic ${n}\n\n${body}\n`;
  }).join("\n");

/**
 * About 2,000 lines of routes, changed in four places far apart: an import at the top, a rewritten
 * function near line 640, one deleted near line 1,300, and a constant near the end. Between them
 * are gaps of hundreds of lines, to expand a step at a time or all at once.
 */
function routes(changed: boolean): string {
  const out = [
    "// Routes for the image service: one small handler per route.",
    'import { respond, type Request } from "./server";',
    changed ? 'import { cache, log } from "./support";' : 'import { log } from "./support";',
    "",
  ];
  for (let n = 1; n <= 284; n++) {
    if (changed && n === 186) continue; // removed in the change
    const body =
      changed && n === 92
        ? [
            "  // Rewritten: answers from the cache, and says how long it took.",
            "  const started = performance.now();",
            `  const hit = cache.get(request.url) ?? respond(request, { route: ${n} });`,
            "  log(`route ${n} in ${performance.now() - started}ms`);",
            "  return hit;",
          ]
        : [`  log("route ${n}");`, `  return respond(request, { route: ${n} });`];
    out.push(
      `/** Handles /route/${n}. */`,
      `export function route${n}(request: Request) {`,
      `  if (!request.url.startsWith("/route/${n}")) return undefined;`,
      ...body,
      "}",
      "",
    );
  }
  out.push(
    `export const routeCount = ${changed ? 283 : 284};`,
    `export const version = "${changed ? "2.0.0" : "1.9.4"}";`,
  );
  for (let n = 1; n <= 12; n++) out.push(`export const reserved${n} = ${n};`);
  return out.join("\n") + "\n";
}

const server = (changed: boolean) =>
  lines(200, (n) => {
    if (n === 20)
      return changed ? "const port = Number(process.env.PORT ?? 8080); // changed" : "const port = 8080;";
    if (n === 150)
      return changed
        ? "  return respond(request, { cache: true }); // changed"
        : "  return respond(request);";
    return n % 10 === 1 ? `// section ${n}` : `export const value${n} = ${n};`;
  });

// ---------------------------------------------------------------------------------------------
// The repository.

function put(path: string, contents: string | Uint8Array) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}
function git(...gitArgs: string[]) {
  const done = Bun.spawnSync(
    ["git", "-c", "user.name=Demo", "-c", "user.email=demo@patch.invalid", ...gitArgs],
    {
      cwd: dir,
      stderr: "pipe",
    },
  );
  if (done.exitCode !== 0) throw new Error(`git ${gitArgs.join(" ")}: ${done.stderr.toString()}`);
}

/** Moves a file as Git sees it, into a folder made for it. */
function move(from: string, to: string) {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  git("mv", from, to);
}

// Checked before anything is removed: a folder given by mistake is left as it is.
if (given && existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, MARK))) {
  console.error(`${dir} is not empty and not a Patch demo; pick a new folder.`);
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
git("init", "-q", "-b", "main");
writeFileSync(join(dir, MARK), "Made by scripts/demo.ts, which may replace it.\n");

// Before.
put("CHECKLIST.md", readFileSync(join(import.meta.dir, "demo", "CHECKLIST.md")));
put("images/logo.png", png(160, 160, disc([230, 90, 60])));
put("images/banner.png", png(600, 120, gradient([250, 200, 80], [240, 110, 60])));
put("images/old-screenshot.png", png(400, 240, gradient([200, 200, 210], [120, 120, 140])));
put("images/avatar.png", png(96, 96, gradient([90, 200, 140], [30, 90, 160])));
put("images/favicon-16.png", png(16, 16, pixelArt([230, 60, 60])));
put("images/photo.jpg", fixture("photo-old.jpg"));
put("images/legacy.bmp", bmp(120, 80, gradient([30, 30, 200], [200, 30, 30])));
put("images/x and b/y.png", png(96, 96, gradient([60, 180, 240], [120, 60, 200])));
put("svg/check.svg", checkSvg("#9ca3af"));
put(
  "svg/old-arrow.svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96"><path d="M5 12h14M13 6l6 6-6 6" stroke="#64748b" stroke-width="2" fill="none"/></svg>\n',
);
put(
  "svg/star.svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z" fill="#facc15"/></svg>\n',
);
put("svg/illustration.svg", illustration("#f43f5e"));
put("svg/badge.svg", checkSvg("#f59e0b"));
put("README.md", readme.old);
put("docs/old-notes.md", "# Old notes\n\nThese notes are gone in the change.\n");
put("docs/history.md", "# History\n\nMoved, word for word, into docs/archive/.\n");
put("docs/long.md", longDoc(false));
put(
  "docs/api.md",
  lines(60, (n) => (n === 1 ? "# API" : n === 60 ? "Last line, before." : `Line ${n} of the API reference.`)),
);
put("src/resize.ts", "export function resize(path: string, width: number) {\n  return { path, width };\n}\n");
put("src/server.ts", server(false));
put("src/routes.ts", routes(false));
put(
  "src/ambiguous.ts",
  lines(12, (n) => (n === 9 ? "export const mode = 'old';" : `export const line${n} = ${n};`)),
);
put("src/no-newline.ts", "export const a = 1;\nexport const b = 2;");
put(
  "src/wide.ts",
  `export const wide = "${"a very long line that does not wrap unless wrapping is on, ".repeat(6)}";\n`,
);
put("src/legacy.js", "module.exports = { legacy: true };\n");
put("src/removed.ts", "export const removed = true;\n");
put("scripts/build.sh", "#!/bin/sh\necho build\n");
put(
  "tests/resize.test.ts",
  'import { resize } from "../src/resize";\n\ntest("resize", () => resize("a.png", 10));\n',
);
put(
  "bun.lock",
  lines(40, (n) => `"package-${n}": "1.0.${n}",`),
);
put("data/archive.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3, 0xff, 0xfe]));
git("add", "-A");
git("commit", "-qm", "Before");

// After: the change under review, left uncommitted.
put("images/logo.png", png(192, 192, disc([60, 120, 230])));
put("images/banner.png", png(640, 140, gradient([120, 90, 240], [60, 200, 220])));
put("images/hero.png", png(1600, 900, waves(0)));
put("images/tall.png", png(120, 1200, gradient([250, 120, 80], [80, 60, 200])));
put("images/favicon-16.png", png(16, 16, pixelArt([60, 200, 120])));
put("images/photo.jpg", fixture("photo-new.jpg"));
put("images/spinner.gif", fixture("spinner.gif"));
put("images/legacy.bmp", bmp(120, 80, gradient([30, 200, 30], [30, 30, 200])));
put("images/broken.png", concat(pngSignature, new TextEncoder().encode("not really a PNG")));
put("images/huge.png", concat(pngSignature, new Uint8Array(32 * 1024 * 1024)));
put("images/My Logo (v2).png", png(128, 128, disc([200, 80, 200])));
put("images/café.png", png(128, 128, disc([200, 160, 60])));
// Its binary line, "Binary files a/x and b/y.png and b/x and b/y.png differ", splits two ways.
put("images/x and b/y.png", png(96, 96, gradient([240, 180, 60], [200, 60, 120])));
rmSync(join(dir, "images/old-screenshot.png"));
move("images/avatar.png", "images/team/avatar.png");
put("svg/check.svg", checkSvg("", true));
put(
  "svg/spark.svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96">\n  <path d="M12 1l2.6 8.4L23 12l-8.4 2.6L12 23l-2.6-8.4L1 12l8.4-2.6z" fill="#a78bfa"/>\n</svg>\n',
);
put(
  "svg/viewbox-only.svg",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">\n  <rect width="200" height="100" rx="16" fill="#38bdf8"/>\n</svg>\n',
);
put(
  "svg/evil.svg",
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" width="96" height="96" onload="alert(\'svg onload\')">\n  <script>alert("svg script")</script>\n  <image href="https://example.com/tracker.png" width="24" height="24"/>\n  <circle cx="12" cy="12" r="10" fill="#ef4444"/>\n</svg>\n',
);
rmSync(join(dir, "svg/old-arrow.svg"));
move("svg/star.svg", "svg/favorite.svg");
put("svg/illustration.svg", illustration("#22c55e"));
// Renamed to text and changed: only its old side is an image.
move("svg/badge.svg", "svg/badge.txt");
put("svg/badge.txt", checkSvg("#f59e0b").replace("<circle", "<!-- now text -->\n  <circle"));
put("README.md", readme.now);
put(
  "docs/guide.md",
  '# Guide\n\n## Cropping\n\n```ts\ncrop("photo.png", { x: 10, y: 10, width: 200, height: 100 });\n```\n\n1. Pick a region.\n2. Call `crop()`.\n3. Save the result.\n',
);
rmSync(join(dir, "docs/old-notes.md"));
move("docs/history.md", "docs/archive/history.md");
put(
  "docs/hostile.md",
  '# Hostile\n\n<script>alert("markdown script")</script>\n\n<img src="https://example.com/tracker.png" alt="tracker"> <img src="x" onerror="alert(1)" alt="onerror">\n\n<iframe src="https://example.com"></iframe>\n\n<div style="background:url(https://example.com/bg.png)">styled</div>\n\n<form action="https://example.com"><input name="q"><button>Send</button></form>\n\n[javascript link](javascript:alert(1)) · [relative link](../README.md) · [web link](https://example.com)\n\n<p class="overlay">borrows the page\'s class</p>\n',
);
put("docs/long.md", longDoc(true));
// Nested deeper than the renderer can follow: it gives up at once.
put("docs/deep.md", `# Deep\n\n${">".repeat(20000)} quoted\n`);
// Under the size a preview reads (1 MB), but nested a thousand deep: rendered off the page's thread.
put("docs/slow.md", Array.from({ length: 1000 }, (_, i) => `${"  ".repeat(i)}- item`).join("\n") + "\n");
put(
  "docs/api.md",
  lines(60, (n) =>
    n === 1 ? "# API reference" : n === 60 ? "Last line, after." : `Line ${n} of the API reference.`,
  ),
);
put(
  "src/resize.ts",
  "export interface ResizeOptions {\n  width: number;\n  height?: number;\n}\n\nexport async function resize(path: string, options: ResizeOptions) {\n  const height = options.height ?? Math.round(options.width * 0.75);\n  return { path, width: options.width, height };\n}\n",
);
put("src/server.ts", server(true));
put("src/routes.ts", routes(true));
put(
  "src/ambiguous.ts",
  lines(12, (n) => (n === 9 ? "export const mode = 'new';" : `export const line${n} = ${n};`)),
);
put("src/no-newline.ts", "export const a = 1;\nexport const b = 3;");
put(
  "src/wide.ts",
  `export const wide = "${"a very long line that does not wrap unless wrapping is on, ".repeat(8)}";\n`,
);
move("src/legacy.js", "src/legacy.ts");
rmSync(join(dir, "src/removed.ts"));
// Latin-1, not UTF-8: "café" with a single é byte.
put("src/latin1.txt", new Uint8Array([...new TextEncoder().encode("caf"), 0xe9, 0x0a]));
put("src/new-feature.ts", 'export function newFeature() {\n  return "added in this change";\n}\n');
put(
  "src/generated/schema.gen.ts",
  lines(2000, (n) => `export const field${n}: string = "generated ${n}";`),
);
chmodSync(join(dir, "scripts/build.sh"), 0o755);
put(
  "tests/resize.test.ts",
  'import { resize } from "../src/resize";\n\ntest("resize keeps the ratio", async () => {\n  expect((await resize("a.png", { width: 400 })).height).toBe(300);\n});\n',
);
put(
  "bun.lock",
  lines(40, (n) => `"package-${n}": "1.${n % 3 === 0 ? 1 : 0}.${n}",`),
);
put("data/archive.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9, 0xff, 0xfe]));

console.error(`Patch demo: ${dir} (see CHECKLIST.md there)`);
if (args.includes("--no-review")) process.exit(0);
const review = Bun.spawn(["bun", join(root, "scripts/dev.ts"), dir], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await review.exited);
