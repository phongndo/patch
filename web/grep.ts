//! Searches the text of the review: here the lines the diff shows, and while
//! exploring every file whole, which the server searches (`/api/grep`). Capitals
//! in what is searched for match only capitals.

import type { FileDiffMetadata } from "@pierre/diffs";
import type { Side } from "../src/protocol.ts";

export interface Hit {
  file: string;
  line: number;
  /** The side the line is on; a whole file's lines are on the new one. */
  side: Side;
  text: string;
}

/** The most hits a search shows. */
export const hitLimit = 300;

export function matcher(text: string): (line: string) => number {
  const exact = text !== text.toLowerCase();
  return (line) => (exact ? line : line.toLowerCase()).indexOf(exact ? text : text.toLowerCase());
}

const clean = (line: string) => line.replace(/\r?\n$/, "");

/** Lines the diff shows with `text` in them: unchanged and added ones on the new side, removed ones on the old. */
export function searchDiff(files: readonly FileDiffMetadata[], text: string): Hit[] {
  const find = matcher(text);
  const hits: Hit[] = [];
  const add = (file: string, side: Side, line: number, content: string | undefined) => {
    if (content !== undefined && hits.length < hitLimit && find(content) >= 0)
      hits.push({ file, side, line, text: clean(content) });
  };
  for (const file of files)
    for (const hunk of file.hunks) {
      for (let index = 0; index < hunk.additionCount; index++)
        add(
          file.name,
          "additions",
          hunk.additionStart + index,
          file.additionLines[hunk.additionLineIndex + index],
        );
      for (const part of hunk.hunkContent) {
        if (part.type !== "change") continue;
        for (let index = 0; index < part.deletions; index++) {
          const at = part.deletionLineIndex + index;
          add(
            file.name,
            "deletions",
            hunk.deletionStart + at - hunk.deletionLineIndex,
            file.deletionLines[at],
          );
        }
      }
    }
  return hits;
}
