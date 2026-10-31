// Renders the Settings sidebar icons (gradient squircles, which the SVG icon
// renderer cannot draw) to 2x PNGs: 22-point tiles, and the 40-point app icon
// on the About page.
// Run: nix shell nixpkgs#librsvg -c node scripts/render-settings-icons.mjs
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const directory = new URL("../src/native/settings-icons/", import.meta.url).pathname;
for (const file of readdirSync(directory).filter((name) => name.endsWith(".svg"))) {
  const source = directory + file;
  const target = source.replace(/\.svg$/, ".png");
  const size = file === "patch.svg" ? "80" : "44";
  execFileSync("rsvg-convert", ["-w", size, "-h", size, source, "-o", target]);
  console.log(target);
}
