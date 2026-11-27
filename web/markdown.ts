//! Markdown rendered for review, loaded the first time a preview needs it. The
//! text comes from the repository, so only what Markdown itself makes is kept:
//! an allowlist of tags and attributes, no classes or styles that could borrow
//! the page's look, and nothing that loads from elsewhere. Links to the web open
//! in a new tab, other ones go nowhere, and an image not inlined in the file
//! keeps only its alt text.

import DOMPurify from "dompurify";
import { parseMarkdown } from "./markdown.parse.ts";

/** How long a document may take to parse before it is given up on; some take forever. */
const PARSE_TIME = 3000;

const tags = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote", "pre", "code",
  "em", "strong", "del", "s", "sub", "sup", "kbd", "mark", "small", "abbr",
  "ul", "ol", "li", "a", "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "details", "summary", "dl", "dt", "dd", "span", "div",
]; // prettier-ignore
const attributes = ["href", "title", "alt", "src", "align", "colspan", "rowspan", "start", "open"];
const external = /^(https?:|mailto:)/i;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node instanceof HTMLAnchorElement) {
    if (!external.test(node.getAttribute("href") ?? "")) node.removeAttribute("href");
    else {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  }
  // An image would be fetched as the page opens: from elsewhere, it would tell that site so.
  // Without its address it shows its alt text.
  if (node instanceof HTMLImageElement && !(node.getAttribute("src") ?? "").startsWith("data:image/"))
    node.removeAttribute("src");
});

/**
 * Markdown as safe HTML. It is parsed in a worker, which is stopped if it runs past PARSE_TIME:
 * deeply nested lists make the parser all but hang, and the page must not hang with it. The
 * result is sanitized here, where the DOM is.
 */
export function renderMarkdown(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" });
    const done = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("The document took too long to render."));
    }, PARSE_TIME);
    worker.onmessage = (event: MessageEvent<{ html?: string }>) => {
      done();
      if (typeof event.data.html === "string") resolve(sanitize(event.data.html));
      else reject(new Error("The document could not be rendered."));
    };
    worker.onerror = () => {
      done();
      reject(new Error("The document could not be rendered."));
    };
    worker.postMessage(text);
  });
}

/** The same at once, on this thread: for tests, which have no workers. */
export const renderMarkdownNow = (text: string) => sanitize(parseMarkdown(text));

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: attributes,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
