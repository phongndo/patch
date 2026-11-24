import { onSettled, Show } from "solid-js";
import { isPageShortcut } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import { state, type Target } from "./state.ts";

export const lineLabel = (start: number, end: number, side: string) =>
  `${start === end ? `Line ${start}` : `Lines ${start}–${end}`}${side === "deletions" ? " (old)" : ""}`;

export function CommentCard(props: { id: string }) {
  const comment = () => state.store.comments.find((comment) => comment.id === props.id);
  return (
    <Show when={comment()}>
      {(comment) => (
        <article class="note">
          <header>
            <span class="note-where">{lineLabel(comment().start, comment().end, comment().side)}</span>
            <span class="note-actions">
              <button class="icon-button" title="Edit" onClick={() => state.compose({ ...comment() })}>
                <Icon name="pencil" />
              </button>
              <button class="icon-button" title="Delete" onClick={() => state.deleteComment(comment().id)}>
                <Icon name="trash" />
              </button>
            </span>
          </header>
          <p class="note-body">{comment().body}</p>
        </article>
      )}
    </Show>
  );
}

export function Composer(props: { target: Target }) {
  const body = () => state.composerText();
  let input: HTMLTextAreaElement | undefined;

  onSettled(() => {
    requestAnimationFrame(() => input?.focus({ preventScroll: true }));
  });

  const save = () => {
    if (body().trim()) state.saveComment(props.target, body().trim());
    else if (props.target.id) state.deleteComment(props.target.id);
    else state.cancelComposer();
  };

  return (
    <form
      class="note composer"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <header>
        <span class="note-where">{lineLabel(props.target.start, props.target.end, props.target.side)}</span>
      </header>
      <textarea
        ref={(element) => (input = element)}
        rows={3}
        placeholder="Leave a comment"
        value={body()}
        onInput={(event) => state.setComposerText(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Keys typed here belong to the comment, not to the diff around it.
          if (isPageShortcut(event)) return;
          event.stopPropagation();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            state.cancelComposer();
          }
        }}
      />
      <footer>
        <span class="hint">⌘↵ save · Esc cancel</span>
        <button type="button" class="button quiet" onClick={() => state.cancelComposer()}>
          Cancel
        </button>
        <button type="submit" class="button primary" disabled={!body().trim() && !props.target.id}>
          {props.target.id ? "Save" : "Comment"}
        </button>
      </footer>
    </form>
  );
}
