import solid from "@solidjs/vite-plugin";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  root: "web",
  plugins: [withoutShikiGrammars(), solid()],
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
