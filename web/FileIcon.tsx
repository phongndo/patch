//! A file's icon as the file tree draws it: its language's, in its color. The
//! tree's sprite sheet is put in the page once, the first time one is drawn.

import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";

const { resolveIcon } = createFileTreeIconResolver({ set: "complete", colored: true });

/** The tree's color for each kind of file, by its icon's token. */
const tones: Record<string, string> = {
  ...Object.fromEntries(["npm", "postcss", "ruby", "svelte", "yml"].map((token) => [token, "red"])),
  git: "vermilion",
  ...Object.fromEntries(
    ["claude", "html", "json", "rust", "svg", "swift", "zig", "zip"].map((token) => [token, "orange"]),
  ),
  ...Object.fromEntries(["babel", "browserslist", "javascript"].map((token) => [token, "yellow"])),
  ...Object.fromEntries(["bash", "markdown", "svgo", "vue"].map((token) => [token, "green"])),
  ...Object.fromEntries(["mcp", "prettier", "table"].map((token) => [token, "teal"])),
  ...Object.fromEntries(["go", "oxc", "react", "tailwind"].map((token) => [token, "cyan"])),
  ...Object.fromEntries(
    ["biome", "c", "cpp", "docker", "python", "typescript", "vscode", "webpack"].map((token) => [
      token,
      "blue",
    ]),
  ),
  ...Object.fromEntries(
    ["bootstrap", "css", "eslint", "terraform", "wasm"].map((token) => [token, "indigo"]),
  ),
  ...Object.fromEntries(["astro", "database", "vite"].map((token) => [token, "purple"])),
  ...Object.fromEntries(["graphql", "image", "sass"].map((token) => [token, "pink"])),
  bun: "mauve",
};

let sprites = false;
function addSprites() {
  if (sprites) return;
  sprites = true;
  const holder = document.createElement("div");
  holder.innerHTML = getBuiltInSpriteSheet("complete");
  const sheet = holder.firstElementChild;
  if (sheet) document.body.append(sheet);
}

export function FileIcon(props: { path: string }) {
  addSprites();
  const icon = () => resolveIcon("file-tree-icon-file", props.path);
  return (
    <svg
      class="file-icon"
      data-tone={tones[icon().token ?? ""] ?? "gray"}
      viewBox={icon().viewBox ?? "0 0 16 16"}
      width="16"
      height="16"
      aria-hidden="true"
    >
      <use href={`#${icon().name}`} />
    </svg>
  );
}
