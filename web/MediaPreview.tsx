//! A changed file rendered, as the reviewer reads it: before and after side by
//! side, or the one side an added or deleted file has. An image sits in a frame
//! of fixed height, so the diff's layout is known before it arrives, and is read
//! only once it scrolls near (`loading="lazy"`); an SVG is drawn in an `<img>`,
//! where nothing in it runs. Markdown is rendered once its renderer, loaded on
//! first use, and its text have come.

import type { FileDiffMetadata } from "@pierre/diffs";
import { createMemo, createSignal, For, Loading, Match, Show, Switch } from "solid-js";
import { loadSideText } from "./api.ts";
import { MARKDOWN_LIMIT, mediaUrl, previewPanes, type Pane } from "./media.ts";

/** The read of the review a preview belongs to: what `/api/media` serves it from. */
export interface ReviewRead {
  key: string;
  read: number;
}

/** Why an image did not draw, as the server says it (asked without the bytes), or its own fault. */
async function whyNot(url: string): Promise<string> {
  const response = await fetch(url, { method: "HEAD" }).catch(() => undefined);
  switch (response?.status) {
    case 413:
      return "Over 32 MB: too large to preview.";
    case 409:
      return "Changed since the review was read. Refresh to see it.";
    case 200:
      return "Not an image the browser can draw.";
    default:
      return "This image could not be read.";
  }
}

function ImageFrame(props: { pane: Pane; review: ReviewRead; onSize: (size: string) => void }) {
  const [failed, setFailed] = createSignal<string>();
  const url = () =>
    mediaUrl(props.review.key, props.review.read, props.pane.side, props.pane.path, props.pane.version);
  return (
    <Show
      when={!failed()}
      fallback={
        <div class="media-frame media-failed">
          <span>{failed()}</span>
        </div>
      }
    >
      <a class="media-frame" href={url()} target="_blank" rel="noopener" title="Open full size">
        <img
          src={url()}
          alt={`${props.pane.label}: ${props.pane.path}`}
          loading="lazy"
          decoding="async"
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth && naturalHeight) props.onSize(`${naturalWidth} × ${naturalHeight}`);
          }}
          onError={() => void whyNot(url()).then(setFailed)}
        />
      </a>
    </Show>
  );
}

function MarkdownFrame(props: { pane: Pane; review: ReviewRead }) {
  const rendered = createMemo(async (): Promise<{ html: string } | { failed: string }> => {
    try {
      const [{ renderMarkdown }, read] = await Promise.all([
        import("./markdown.ts"),
        loadSideText(props.review.key, props.pane.side, props.pane.path, MARKDOWN_LIMIT),
      ]);
      if (read.status === 413) return { failed: "This document is too long to preview; its code is below." };
      if (read.text === undefined) return { failed: "This file could not be read." };
      return { html: await renderMarkdown(read.text) };
    } catch {
      // The renderer gave up (a document nested past what it can follow), or did not load.
      return { failed: "This document could not be rendered; its code is below." };
    }
  });
  const html = () => {
    const result = rendered();
    return "html" in result ? result.html : undefined;
  };
  const failed = () => {
    const result = rendered();
    return "failed" in result ? result.failed : undefined;
  };
  return (
    <Loading fallback={<div class="markdown-body media-waiting">Rendering…</div>}>
      <Show when={html()} fallback={<div class="markdown-body media-waiting">{failed()}</div>}>
        {(markup) => <div class="markdown-body" innerHTML={markup()} />}
      </Show>
    </Loading>
  );
}

function PreviewPane(props: { pane: Pane; review: ReviewRead }) {
  const [size, setSize] = createSignal<string>();
  return (
    <figure class={["media-pane", `media-${props.pane.tone}`]}>
      <figcaption>
        <span class="media-label">{props.pane.label}</span>
        <Show when={size()}>
          <span class="media-size">{size()}</span>
        </Show>
      </figcaption>
      <Switch>
        <Match when={props.pane.kind === "image"}>
          <ImageFrame pane={props.pane} review={props.review} onSize={setSize} />
        </Match>
        <Match when={props.pane.kind === "markdown"}>
          <MarkdownFrame pane={props.pane} review={props.review} />
        </Match>
      </Switch>
    </figure>
  );
}

/** A file's preview: every side it has, or only `side`. */
export function MediaPreview(props: { file: FileDiffMetadata; review: ReviewRead; side?: "old" | "new" }) {
  const panes = () => previewPanes(props.file).filter((pane) => !props.side || pane.side === props.side);
  return (
    <div class="media">
      <For each={panes()}>{(pane) => <PreviewPane pane={pane} review={props.review} />}</For>
    </div>
  );
}
