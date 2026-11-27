//! Parses a preview's Markdown off the page's thread (markdown.ts), so a document the parser all
//! but hangs on is stopped without the page.

import { parseMarkdown } from "./markdown.parse.ts";

self.onmessage = (event: MessageEvent<string>) => {
  try {
    self.postMessage({ html: parseMarkdown(event.data) });
  } catch {
    // Nested past what it can follow, the parser runs out of stack.
    self.postMessage({});
  }
};
