import solid from "@solidjs/vite-plugin";
import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { defineConfig, type Plugin } from "vite";

/**
 * Writes a Brotli and a gzip copy beside every asset worth compressing, so the
 * CLI embeds them and never compresses the page while it is waiting for it.
 * index.html is left alone: the CLI writes the settings into it. The development
 * loop (scripts/dev.ts, PATCH_DEV) serves the page from disk and skips this.
 */
function precompressed(): Plugin {
  let outDir = "";
  const brotli = promisify(brotliCompress);
  const gzipped = promisify(gzip);
  return {
    name: "patch:precompressed",
    apply: () => !process.env.PATCH_DEV,
    configResolved: (config) => void (outDir = resolve(config.root, config.build.outDir)),
    async closeBundle() {
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(js|css|svg|json|wasm)$/.test(entry.name))
        .map((entry) => join(entry.parentPath, entry.name));
      await Promise.all(
        files.map(async (path) => {
          const bytes = await readFile(path);
          if (bytes.length <= 1024) return;
          const params = {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
          };
          await Promise.all([
            gzipped(bytes, { level: 9 }).then((packed) => writeFile(`${path}.gz`, packed)),
            brotli(bytes, { params }).then((packed) => writeFile(`${path}.br`, packed)),
          ]);
        }),
      );
    },
  };
}

/**
 * Pierre Diffs can highlight with Shiki or with Pierre Highlights. Patch uses
 * Highlights, so Shiki's lazily loaded grammars and engines (about 250 chunks,
 * twice over for the page and the workers) are swapped for an empty module.
 */
function withoutShikiGrammars(): Plugin {
  const stubbed = new Set(["shiki/langs", "shiki/wasm", "shiki/engine/oniguruma", "shiki/engine/javascript"]);
  const id = "\0patch:no-shiki";
  const unavailable = `() => { throw new Error("Patch highlights with Pierre Highlights; Shiki is not bundled."); }`;
  return {
    name: "patch:without-shiki-grammars",
    enforce: "pre",
    resolveId: (source) => (stubbed.has(source) ? id : undefined),
    load: (source) =>
      source === id
        ? `export const bundledLanguages = {};
export const createOnigurumaEngine = ${unavailable};
export const createJavaScriptRegexEngine = ${unavailable};
export default {};`
        : undefined,
  };
}

/**
 * The worker pool resolves its themes before it starts its workers, through two
 * dynamic imports: the theme catalog, then the theme. The page names them up
 * front for the default themes, so they are fetched while the script loads.
 */
function preloadDefaultThemes(): Plugin {
  // The same themes web/diff.ts waits for.
  const wanted = /@pierre\/highlights\/dist\/themes\/(loader|pierre-dark|pierre-light)\.js$/;
  return {
    name: "patch:preload-default-themes",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        const chunks = Object.values(bundle ?? {}).filter(
          (chunk) => chunk.type === "chunk" && wanted.test(chunk.facadeModuleId ?? ""),
        );
        return chunks.map((chunk) => ({
          tag: "link",
          attrs: { rel: "modulepreload", crossorigin: true, href: `/${chunk.fileName}` },
          injectTo: "head",
        }));
      },
    },
  };
}

export default defineConfig({
  root: "web",
  plugins: [withoutShikiGrammars(), solid(), preloadDefaultThemes(), precompressed()],
  optimizeDeps: { exclude: ["@ui-sdk/core"] },
  worker: { format: "es", plugins: () => [withoutShikiGrammars()] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2023",
    reportCompressedSize: false,
    // Hashed names let the server cache every asset forever.
    assetsDir: "a",
  },
});
