// Vendors popular community themes from Zed's extension registry into
// web/themes/community: the most-downloaded theme extensions on GitHub whose
// license allows redistribution. Run it by hand to refresh; the files are
// committed, with their sources and licenses in NOTICE.md.
//
//   bun scripts/fetch-themes.ts [count]
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const count = Number(process.argv[2] ?? 40);
const out = join(import.meta.dir, "..", "web", "themes", "community");
const permissive = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "MIT-0",
]);

async function gh(path: string): Promise<unknown> {
  const child = Bun.spawn(["gh", "api", path], { stdout: "pipe", stderr: "pipe" });
  const [body, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`gh api ${path} failed`);
  return JSON.parse(body);
}

const registry = (await (
  await fetch("https://api.zed.dev/extensions?provides=themes&max_schema_version=1", {
    headers: { "user-agent": "patch-theme-sync" },
  })
).json()) as {
  data: Array<{ id: string; name: string; repository: string; download_count: number; authors: string[] }>;
};

const candidates = registry.data
  .filter((extension) => extension.repository.startsWith("https://github.com/"))
  .toSorted((a, b) => b.download_count - a.download_count);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const notice = [
  "# Community themes",
  "",
  "Vendored from Zed's extension registry by `scripts/fetch-themes.ts`.",
  "",
];
let kept = 0;

for (const extension of candidates) {
  if (kept >= count) break;
  const repo = extension.repository
    .replace("https://github.com/", "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  try {
    const meta = (await gh(`repos/${repo}`)) as { license?: { spdx_id?: string }; default_branch: string };
    const license = meta.license?.spdx_id ?? "";
    if (!permissive.has(license)) {
      console.error(`skip ${extension.id}: license ${license || "none"}`);
      continue;
    }
    const listing = (await gh(`repos/${repo}/contents/themes?ref=${meta.default_branch}`)) as Array<{
      name: string;
      download_url: string;
      size: number;
    }>;
    const files = listing.filter((file) => file.name.endsWith(".json") && file.size < 400_000);
    if (!files.length) continue;
    for (const file of files) {
      const body = await (await fetch(file.download_url)).text();
      JSON.parse(body); // Only valid JSON is kept.
      await writeFile(join(out, `${extension.id}--${file.name}`), body);
    }
    notice.push(
      `- ${extension.name} (${extension.id}): https://github.com/${repo}, ${license}, by ${extension.authors.join(", ")}`,
    );
    kept++;
    console.error(`kept ${extension.id} (${files.length} files, ${license})`);
  } catch (error) {
    console.error(`skip ${extension.id}: ${error instanceof Error ? error.message : error}`);
  }
}
await writeFile(join(out, "NOTICE.md"), `${notice.join("\n")}\n`);
console.error(`${kept} extensions`);
