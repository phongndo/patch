//! The review as it stands: every comment, in the order the diff has them. One opens
//! where it is in the diff; one the diff has no place for is written and edited here.

import { createMemo, For, Show } from "solid-js";
import type { Comment } from "../src/protocol.ts";
import { Icon } from "./Icon.tsx";
import { aboutLabel, Composer, removeComment, Tags } from "./Notes.tsx";
import { preferences } from "./settings.ts";
import { state } from "./state.ts";

const split = (path: string) => {
  const at = path.lastIndexOf("/") + 1;
  return { name: path.slice(at), folder: path.slice(0, Math.max(0, at - 1)) };
};

function FileName(props: { path: string }) {
  return (
    <h3 class="comment-file" title={props.path}>
      {split(props.path).name}
      <span class="comment-folder">{split(props.path).folder}</span>
    </h3>
  );
}

export function CommentsPanel(props: { onOpen: (comment: Comment) => void }) {
  const groups = createMemo(() => [...Map.groupBy(state.ordered(), (comment) => comment.file)]);
  /** What is being written here rather than in the diff. */
  const writing = createMemo(() => {
    const target = state.composer();
    return target && state.lineOf(target) === undefined ? target : undefined;
  });
  const starting = () => (writing()?.id ? undefined : writing());

  function Row(row: { comment: Comment }) {
    const editing = () => (writing()?.id === row.comment.id ? writing() : undefined);
    return (
      <li>
        <Show
          when={editing()}
          fallback={
            <article class="note comment-card">
              <button
                class="comment-item"
                title={state.lineOf(row.comment) === undefined ? "Edit" : "Show in the diff"}
                onClick={() => props.onOpen(row.comment)}
              >
                <span class="comment-about">
                  {aboutLabel(row.comment)}
                  <Tags comment={row.comment} />
                </span>
                <span class="comment-body">{row.comment.body}</span>
              </button>
              <button
                class="icon-button note-delete"
                title="Delete"
                onClick={() => removeComment(row.comment.id)}
              >
                <Icon name="trash" />
              </button>
            </article>
          }
        >
          {(target) => <Composer target={target()} />}
        </Show>
      </li>
    );
  }

  return (
    <div class="comments-panel">
      <Show when={starting()}>
        {(target) => (
          <section class="comment-group">
            <Show when={target().file}>
              <FileName path={target().file} />
            </Show>
            <Composer target={target()} />
          </section>
        )}
      </Show>
      <For each={groups()} keyed={([file]) => file}>
        {(group) => (
          <section class="comment-group">
            <Show when={group()[0]}>
              <FileName path={group()[0]} />
            </Show>
            <ul>
              <For each={group()[1]}>{(comment) => <Row comment={comment} />}</For>
            </ul>
          </section>
        )}
      </For>
      <Show when={!state.store.comments.length && !starting()}>
        <p class="empty">
          Click a line number's + in the diff, or select lines and{" "}
          {preferences.keyText("comment") ? `press ${preferences.keyText("comment")}` : "run Comment"}.
        </p>
      </Show>
    </div>
  );
}
