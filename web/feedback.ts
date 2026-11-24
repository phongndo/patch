//! The feedback as Markdown, for a page whose review is gone. It reads as
//! `cli/src/feedback.rs` writes it, but the page does not know where the
//! repository is; tests/contract.test.ts compares the two.

import type { Comment } from "../src/protocol.ts";

function fenceFor(lines: readonly string[]) {
  let fence = "```";
  while (lines.some((line) => line.includes(fence))) fence += "`";
  return fence;
}

const language = (file: string) => /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? "";

export function feedbackText(all: readonly Comment[], repository: string): string {
  const comments = all.filter((comment) => comment.body.trim());
  const out = [
    `# Review feedback (${repository})`,
    "",
    "The user reviewed the changes and left feedback. Address every comment, then summarize what you changed.",
  ];
  const general = comments.filter((comment) => !comment.file);
  if (general.length) {
    out.push("", "## General", "");
    for (const { body } of general) out.push(`- ${body.trim().replaceAll("\n", "\n  ")}`);
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  let current = "";
  for (const comment of comments
    .filter(({ file }) => file)
    .toSorted((a, b) => order(a.file.toLowerCase(), b.file.toLowerCase()) || a.start - b.start)) {
    if (comment.file !== current) out.push("", `## ${comment.file}`);
    current = comment.file;
    const lines = comment.start === comment.end ? comment.start : `${comment.start}-${comment.end}`;
    const side = comment.side === "deletions" ? " (old side, removed lines)" : "";
    const scope = comment.scope ? ` (in ${comment.scope})` : "";
    out.push("", `### ${comment.file}:${lines}${side}${scope}`);
    if (comment.excerpt.length) {
      const fence = fenceFor(comment.excerpt);
      out.push("", fence + language(comment.file), ...comment.excerpt, fence);
    }
    out.push("", comment.body.trim());
  }
  return out.join("\n");
}

/** Copies text. A remote review's page is plain HTTP, where `navigator.clipboard` is missing. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard)
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  const focused = document.activeElement;
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  return copied;
}
