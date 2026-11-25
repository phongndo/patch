//! A comment and the editor it is written in. Both go wherever the comment does:
//! in the diff, or in the sidebar when the diff has no place for it.

import { toast } from "@ui-sdk/solid/toast";
import { onSettled, Show } from "solid-js";
import type { Comment } from "../src/protocol.ts";
import { isPageShortcut } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import { displayKey } from "./settings.ts";
import { isGeneral, state, type Target } from "./state.ts";

/** What a comment is about within its file. */
export const aboutLabel = ({ file, side, start, end }: Target) => {
  if (isGeneral({ file })) return "Overall";
  if (start === 0) return "Whole file";
  return `${start === end ? `Line ${start}` : `Lines ${start}–${end}`}${side === "deletions" ? " (old)" : ""}`;
};

/** Deletes at once: putting it back is cheaper than asking first. */
export function removeComment(id: string) {
  const restore = state.deleteComment(id);
  if (restore)
    toast.info("Comment deleted.", { id: "deleted", action: { label: "Undo", onAction: restore } });
}

export function Tags(props: { comment: Comment }) {
  return (
    <>
      <Show when={state.isMoved(props.comment)}>
        <span class="tag warning" title="It is sent with the lines as they were">
          {state.fileByName(props.comment.file) ? "lines changed" : "not in the diff"}
        </span>
      </Show>
      <Show when={props.comment.scope}>
        <span class="tag">{props.comment.scope}</span>
      </Show>
    </>
  );
}

/** The lines as they were, for a comment the diff no longer shows beside them. */
function Excerpt(props: { comment: Comment }) {
  return (
    <Show when={state.isMoved(props.comment) && props.comment.excerpt.length}>
      <pre class="note-excerpt">{props.comment.excerpt.join("\n")}</pre>
    </Show>
  );
}

const commentOf = (id: string | undefined) => state.store.comments.find((comment) => comment.id === id);

export function CommentCard(props: { id: string; onEdit: (comment: Comment) => void }) {
  const comment = () => commentOf(props.id);
  return (
    <Show when={comment()}>
      {(comment) => (
        <article class="note">
          <header>
            <span class="note-about">{aboutLabel(comment())}</span>
            <Tags comment={comment()} />
            <button
              class="icon-button note-delete"
              title="Delete"
              onClick={() => removeComment(comment().id)}
            >
              <Icon name="trash" />
            </button>
          </header>
          <Excerpt comment={comment()} />
          <button class="note-body" title="Edit" onClick={() => props.onEdit(comment())}>
            {comment().body}
          </button>
        </article>
      )}
    </Show>
  );
}

const seen = new WeakSet<Target>();

/** A comment's card with its text open. Every way out of it keeps the text; only Delete doesn't. */
export function Composer(props: { target: Target }) {
  const body = () => state.composerText();
  const existing = () => commentOf(props.target.id);
  let input: HTMLTextAreaElement | undefined;

  onSettled(() => {
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      // Opened under the last line on screen, it would be below the fold. Only then: the
      // diff draws it again later, when the reader may be elsewhere.
      if (seen.has(props.target)) return;
      seen.add(props.target);
      input?.form?.scrollIntoView?.({ block: "nearest" });
    });
  });

  const keep = () => {
    if (body().trim()) state.saveComment(props.target, body().trim());
    else discard();
  };
  const discard = () => {
    const id = body().trim() ? state.saveComment(props.target, body().trim()) : props.target.id;
    state.cancelComposer();
    if (id) removeComment(id);
  };

  return (
    <form
      class="note composer"
      onSubmit={(event) => {
        event.preventDefault();
        keep();
      }}
    >
      <header>
        <span class="note-about">{aboutLabel(props.target)}</span>
        <Show when={existing()}>{(comment) => <Tags comment={comment()} />}</Show>
        <span class="note-actions">
          <button
            type="button"
            class="icon-button"
            title={props.target.id ? "Delete" : "Discard"}
            onClick={discard}
          >
            <Icon name={props.target.id ? "trash" : "x"} />
          </button>
          <button
            type="submit"
            class="icon-button save"
            title={`Save (${displayKey("Mod+Enter")})`}
            disabled={!body().trim()}
          >
            <Icon name="check" />
          </button>
        </span>
      </header>
      <Show when={existing()}>{(comment) => <Excerpt comment={comment()} />}</Show>
      <textarea
        ref={(element) => (input = element)}
        class={{ starting: !props.target.id }}
        rows={2}
        aria-label="Comment"
        placeholder="Leave a comment"
        value={body()}
        onInput={(event) => state.setComposerText(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Keys typed here belong to the comment, not to the diff around it.
          if (isPageShortcut(event)) return;
          event.stopPropagation();
          if ((event.key === "Enter" && (event.metaKey || event.ctrlKey)) || event.key === "Escape") {
            // An input method's own Escape or Enter ends its word.
            if (event.isComposing) return;
            event.preventDefault();
            keep();
          }
        }}
      />
    </form>
  );
}
