//! Markdown parsed to HTML, unsanitized: markdown.ts sanitizes it, where the DOM is. Shared by
//! the worker that parses previews and by tests, which have no workers.

import { Marked } from "marked";

const marked = new Marked({
  gfm: true,
  async: false,
  // A task's box is shown as ticked or not; nothing in a preview is a control.
  renderer: { checkbox: ({ checked }) => (checked ? "☑ " : "☐ ") },
});

export const parseMarkdown = (text: string) => marked.parse(text) as string;
