//! Changed files that read better rendered: images, SVG and Markdown, shown
//! above their diff. A file without text (a PNG) is always shown so; one with
//! code (an SVG, Markdown) shows its code, and its header toggles the preview.
//! `/api/media` serves the image kinds (`image_type` in cli/src/server.rs);
//! change both together.

import type { FileDiffMetadata } from "@pierre/diffs";

const image = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const markdown = /\.(md|markdown)$/i;

export type PreviewKind = "image" | "markdown";

/** Longer Markdown is not parsed on the page's thread; its code is still there to read. */
export const MARKDOWN_LIMIT = 1024 * 1024;

/** How a file at `path` is previewed, if it is. */
export const previewKind = (path: string): PreviewKind | undefined =>
  image.test(path) ? "image" : markdown.test(path) ? "markdown" : undefined;

/**
 * Where one side of a changed image is read. `version` names its contents (the diff's object
 * id), so a refreshed review never draws an image the page already holds under the same address.
 */
export const mediaUrl = (key: string, read: number, side: "old" | "new", path: string, version = "") =>
  `/api/media?${new URLSearchParams({ key, read: String(read), side, path, v: version })}`;

/** One side of a changed file, as the preview shows it. */
export interface Pane {
  side: "old" | "new";
  path: string;
  kind: PreviewKind;
  version?: string;
  label: string;
  /** Colored as removed, added, or neither. */
  tone: "del" | "add" | "same";
}

/** The sides worth showing: both when the file changed, else the one there is; none for other files. */
export function previewPanes(file: FileDiffMetadata): Pane[] {
  const oldPath = file.prevName ?? file.name;
  const side = (
    side: Pane["side"],
    path: string,
    version: string | undefined,
    label: string,
    tone: Pane["tone"],
  ) => {
    const kind = previewKind(path);
    // Markdown is read as the diff's text, which a file renamed untouched has none of.
    if (!kind || (kind === "markdown" && !file.hunks.length)) return [];
    return [{ side, path, kind, version, label, tone }];
  };
  if (file.type === "new") return side("new", file.name, file.newObjectId, "Added", "add");
  if (file.type === "deleted") return side("old", oldPath, file.prevObjectId, "Deleted", "del");
  // Renamed with its contents untouched, or only its mode changed: one side says it all.
  const same =
    file.type === "rename-pure" ||
    (file.prevObjectId !== undefined && file.prevObjectId === file.newObjectId);
  if (same)
    return side(
      "new",
      file.name,
      file.newObjectId,
      file.type === "rename-pure" ? "Renamed" : "Unchanged",
      "same",
    );
  return [
    ...side("old", oldPath, file.prevObjectId, "Before", "del"),
    ...side("new", file.name, file.newObjectId, "After", "add"),
  ];
}

/** Whether a file's preview is a choice: it has code to show instead. Without, it is always shown. */
export const previewToggles = (file: FileDiffMetadata) =>
  file.hunks.length > 0 && previewPanes(file).length > 0;

/**
 * Where a file's preview goes above its lines: before on the old side and after on the new, as
 * the lines go, so the diff lays them out as it does lines: side by side when split, before above
 * after when unified. A file with one side has one preview, across the whole diff.
 */
export function previewPlaces(
  file: FileDiffMetadata,
): Array<{ side: "deletions" | "additions"; pane?: Pane["side"] }> {
  const panes = previewPanes(file);
  if (!panes.length) return [];
  if (panes.length === 2)
    return [
      { side: "deletions", pane: "old" },
      { side: "additions", pane: "new" },
    ];
  // One side: shown as that side alone (diff.ts), so its preview goes there.
  return [{ side: panes[0]!.side === "old" ? "deletions" : "additions" }];
}
