import { parsePatchFiles } from "@pierre/diffs";
import type { Review, ReviewSource } from "./types";

export async function parseReview({ patch, ...source }: ReviewSource): Promise<Review> {
  const bytes = new TextEncoder().encode(patch);
  if (bytes.length > 64 * 1024 * 1024) throw new Error("This patch exceeds the 64 MB limit.");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${source.repository}\0${patch}`),
  );
  const id = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  const patches = patch.trim() ? parsePatchFiles(patch, id, true) : [];
  const files = patches.flatMap((entry, patchIndex) =>
    entry.files.map((diff, fileIndex) => ({
      id: `${patchIndex}:${fileIndex}:${diff.name}`,
      path: diff.name,
      additions: diff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: diff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
      diff,
    })),
  );
  if (patch.trim() && files.length === 0) {
    throw new Error("No file changes found. Open a unified .diff or .patch file.");
  }
  files.sort((left, right) => {
    const a = left.path.split("/");
    const b = right.path.split("/");
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] === b[index]) continue;
      const directoryA = index < a.length - 1;
      const directoryB = index < b.length - 1;
      if (directoryA !== directoryB) return directoryA ? -1 : 1;
      return (a[index] ?? "").localeCompare(b[index] ?? "", undefined, { numeric: true });
    }
    return a.length - b.length;
  });
  return {
    id,
    source,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
