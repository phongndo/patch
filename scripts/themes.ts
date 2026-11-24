// Lists every theme the page offers with the few colors it needs to paint its
// own chrome and draw a tile: Pierre Highlights' bundled themes, and the
// community themes vendored in web/themes/community (scripts/fetch-themes.ts).
// Community themes load only when chosen, through web/themes.loaders.gen.ts.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Style = Record<string, unknown>;
interface ZedTheme {
  name: string;
  appearance: string;
  style: Style;
}

const root = join(import.meta.dir, "..");
const bundledDir = join(root, "node_modules", "@pierre", "highlights", "dist", "themes");
const communityDir = join(root, "web", "themes", "community");

function entry(id: string, group: string, theme: ZedTheme) {
  const s = theme.style;
  const color = (...keys: string[]) =>
    keys.map((key) => s[key]).find((value) => typeof value === "string") as string | undefined;
  return {
    id,
    name: theme.name,
    dark: theme.appearance !== "light",
    group,
    colors: {
      editor:
        color("editor.background", "background") ?? (theme.appearance === "light" ? "#ffffff" : "#1e1e1e"),
      chrome:
        color("background", "editor.background") ?? (theme.appearance === "light" ? "#ffffff" : "#1e1e1e"),
      text: color("editor.foreground", "text") ?? (theme.appearance === "light" ? "#333333" : "#cccccc"),
      line: color("editor.active_line.background") ?? null,
      add: color("created", "version_control.added") ?? null,
      del: color("deleted", "version_control.deleted") ?? null,
      accent: color("modified", "text.accent", "info") ?? null,
    },
    // The eight terminal colors: the palette the theme tiles show as dots.
    palette: ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
      .map((name) => s[`terminal.ansi.${name}`])
      .filter((value): value is string => typeof value === "string"),
  };
}

const entries: ReturnType<typeof entry>[] = [];
const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

// Pierre Highlights' bundled themes: Pierre's own first, then the rest.
const bundled = (await readdir(bundledDir)).filter((f) => f.endsWith(".js") && !f.startsWith("loader"));
const builtins: ReturnType<typeof entry>[] = [];
for (const file of bundled) {
  const id = file.slice(0, -3);
  const theme = (await import(join(bundledDir, file))).default as ZedTheme;
  builtins.push(entry(id, id.startsWith("pierre-") ? "pierre" : "builtin", theme));
}
// Pierre's own first, then the rest by name, so a family's variants sit together.
entries.push(
  ...builtins.toSorted(
    (a, b) => Number(b.group === "pierre") - Number(a.group === "pierre") || byName(a.name, b.name),
  ),
);

// Community themes: one family per file, each split into its themes.
const taken = new Set(entries.map((theme) => theme.name.toLowerCase()));
const loaders: string[] = [];
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
// NOTICE.md lists extensions most-downloaded first: that is their order here,
// with each extension's themes by name. Base16 goes last, by name.
const notice = await readFile(join(communityDir, "NOTICE.md"), "utf8");
const rank = new Map([...notice.matchAll(/^- .*? \(([^)]+)\):/gm)].map((match, index) => [match[1]!, index]));
const extensionOf = (file: string) => file.split("--")[0]!;
const files = (await readdir(communityDir))
  .filter((f) => f.endsWith(".json"))
  .toSorted((a, b) => (rank.get(extensionOf(a)) ?? 1e9) - (rank.get(extensionOf(b)) ?? 1e9) || byName(a, b));
const community: Array<{ theme: ReturnType<typeof entry>; loader: string }> = [];
for (const file of files) {
  const extension = file.split("--")[0]!;
  let family: { themes?: ZedTheme[] };
  try {
    family = JSON.parse(await readFile(join(communityDir, file), "utf8"));
  } catch {
    continue;
  }
  for (const theme of family.themes ?? []) {
    if (!theme?.name || !theme.style || taken.has(theme.name.toLowerCase())) continue;
    // Variants that differ only in italics or window blur look identical as tiles.
    if (/no italics|blurred|\bblur\b/i.test(theme.name)) continue;
    taken.add(theme.name.toLowerCase());
    const id = `${extension}:${slug(theme.name)}`;
    community.push({
      theme: entry(id, extension === "base16" ? "base16" : "community", theme),
      loader: `  ${JSON.stringify(id)}: () => import("./themes/community/${file}").then((m) => pick(m.default, ${JSON.stringify(theme.name)})),`,
    });
  }
}
// Within an extension, its themes by name; files were already in rank order.
const extensionRank = (id: string) => rank.get(id.split(":")[0]!) ?? 1e9;
for (const { theme, loader } of community.toSorted(
  (a, b) => extensionRank(a.theme.id) - extensionRank(b.theme.id) || byName(a.theme.name, b.theme.name),
)) {
  entries.push(theme);
  loaders.push(loader);
}

await writeFile(
  join(root, "web", "themes.gen.ts"),
  `// Generated by scripts/themes.ts.
export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  /** "pierre", "builtin", "community" or "base16". */
  group: string;
  colors: { editor: string; chrome: string; text: string; line: string | null; add: string | null; del: string | null; accent: string | null };
  palette: string[];
}

export const themes: Theme[] = [
${entries.map((theme) => `  ${JSON.stringify(theme)},`).join("\n")}
];
`,
);

await writeFile(
  join(root, "web", "themes.loaders.gen.ts"),
  `// Generated by scripts/themes.ts. Community themes, each loaded only when chosen.
type Family = { themes: Array<{ name: string }> };
const pick = (family: Family, name: string) => family.themes.find((theme) => theme.name === name)!;

export const communityThemes: Record<string, () => Promise<object>> = {
${loaders.join("\n")}
};
`,
);
// Pierre's two defaults, small enough to ship in the page without the catalog.
const pick = (id: string) => entries.find((theme) => theme.id === id)!;
await writeFile(
  join(root, "web", "themes.defaults.gen.ts"),
  `// Generated by scripts/themes.ts.\nimport type { Theme } from "./themes.gen.ts";\n\nexport const defaultLight: Theme = ${JSON.stringify(pick("pierre-light"))};\nexport const defaultDark: Theme = ${JSON.stringify(pick("pierre-dark"))};\n`,
);
console.error(`${entries.length} themes, ${loaders.length} from the community`);
