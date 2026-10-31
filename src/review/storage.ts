import type { Review, ReviewProgress } from "./types";

export function readPreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`patch:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(key: string, value: string): boolean {
  try {
    localStorage.setItem(`patch:${key}`, value);
    return true;
  } catch {
    return false;
  }
}
export function readProgress(id: string): ReviewProgress {
  try {
    const value: unknown = JSON.parse(readPreference(`review:${id}`, "null"));
    if (typeof value !== "object" || value === null) return { reviewed: [], notes: [] };
    const progress = value as Partial<ReviewProgress>;
    return {
      reviewed: Array.isArray(progress.reviewed)
        ? progress.reviewed.filter((value) => typeof value === "string")
        : [],
      notes: Array.isArray(progress.notes)
        ? progress.notes.filter(
            (note) =>
              note &&
              typeof note.id === "string" &&
              typeof note.file === "string" &&
              typeof note.text === "string" &&
              note.range &&
              Number.isSafeInteger(note.range.start) &&
              Number.isSafeInteger(note.range.end) &&
              note.range.start >= 0 &&
              note.range.end >= note.range.start &&
              (note.range.side === undefined ||
                ["additions", "deletions"].includes(note.range.side)),
          )
        : [],
    };
  } catch {
    return { reviewed: [], notes: [] };
  }
}
export function formatReview(review: Review, progress: ReviewProgress): string {
  const lines = [
    `# Review: ${review.source.repository}`,
    "",
    `${review.source.base} → ${review.source.branch}`,
    "",
    `${progress.reviewed.length}/${review.files.length} files reviewed · +${review.additions} −${review.deletions}`,
    "",
  ];
  for (const file of review.files) {
    const notes = progress.notes.filter((note) => note.file === file.id);
    lines.push(
      `## ${file.path}`,
      "",
      progress.reviewed.includes(file.id) ? "Reviewed." : "Not reviewed.",
      "",
    );
    for (const note of notes) {
      const location =
        note.range.start === 0
          ? "File"
          : `L${note.range.start}${note.range.end > note.range.start ? `–${note.range.end}` : ""} (${note.range.side === "deletions" ? "before" : "after"})`;
      lines.push(`**${location}**`, "", note.text, "");
    }
  }
  return lines.join("\n");
}
