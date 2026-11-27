//! The review as it stands: every comment, in the order the diff has them, in a
//! panel of its own beside the diff. One opens where it is in the diff; one the
//! diff has no place for is written and edited here.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Comment } from "../src/protocol.ts";
import { FileIcon } from "./FileIcon.tsx";
import { Icon } from "./Icon.tsx";
import { SearchField } from "./SearchField.tsx";
import { aboutLabel, Composer, removeComment, Tags } from "./Notes.tsx";
import { preferences } from "./settings.ts";
import { globalTarget, state } from "./state.ts";
import { touchOnly } from "./ui.ts";

const split = (path: string) => {
  const at = path.lastIndexOf("/") + 1;
  return { name: path.slice(at), folder: path.slice(0, Math.max(0, at - 1)) };
};

/** A group's heading: the file, or the review as a whole, and how many comments it has. */
function GroupHead(props: { path: string; count?: number }) {
  return (
    <h3 class="comment-file" title={props.path || undefined}>
      <Show when={props.path} fallback={<Icon name="comment" />}>
        <FileIcon path={props.path} />
      </Show>
      <span class="comment-name">{props.path ? split(props.path).name : "Global"}</span>
      <span class="comment-folder">{split(props.path).folder}</span>
      <Show when={props.count}>
        <span class="comment-count">{props.count}</span>
      </Show>
    </h3>
  );
}

/** The lines a comment is about, as they read when it was written: a few, without their indent. */
function Excerpt(props: { lines: string[] }) {
  const shown = () => {
    const lines = props.lines.slice(0, 3);
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
  };
  return (
    <span class="comment-code" aria-hidden="true">
      <For each={shown()}>{(line) => <span class="comment-code-line">{line || " "}</span>}</For>
      <Show when={props.lines.length > 3}>
        <span class="comment-code-more">{props.lines.length - 3} more lines</span>
      </Show>
    </span>
  );
}

/** The comments whose text or path has the query in it, as the tree matches files. */
export function findComments(query: string): Comment[] {
  const text = query.trim().toLowerCase();
  return state
    .ordered()
    .filter(({ body, file }) => body.toLowerCase().includes(text) || file.toLowerCase().includes(text));
}

export function CommentsPanel(props: { search: string; onOpen: (comment: Comment) => void }) {
  /** What is being written here rather than in the diff. */
  const writing = createMemo(() => {
    const target = state.composer();
    return target && state.lineOf(target) === undefined ? target : undefined;
  });
  const starting = () => (writing()?.id ? undefined : writing());
  const groups = createMemo(() => {
    const found = new Set(findComments(props.search).map((comment) => comment.id));
    // The one being edited stays whatever is searched: its editor is nowhere else.
    const shown = state.ordered().filter(({ id }) => found.has(id) || id === writing()?.id);
    return [...Map.groupBy(shown, (comment) => comment.file)];
  });

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
                <Show when={row.comment.file || row.comment.scope}>
                  <span class="comment-about">
                    <Show when={row.comment.file}>{aboutLabel(row.comment)}</Show>
                    <Tags comment={row.comment} />
                  </span>
                </Show>
                <Show when={row.comment.excerpt.length}>
                  <Excerpt lines={row.comment.excerpt} />
                </Show>
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
            <GroupHead path={target().file} />
            <Composer target={target()} />
          </section>
        )}
      </Show>
      <For each={groups()} keyed={([file]) => file}>
        {(group) => (
          <section class="comment-group">
            <GroupHead path={group()[0]} count={group()[1].length} />
            <ul>
              <For each={group()[1]}>{(comment) => <Row comment={comment} />}</For>
            </ul>
          </section>
        )}
      </For>
      <Show when={state.store.comments.length && !groups().length && !starting()}>
        <p class="empty">No comments match.</p>
      </Show>
      <Show when={!state.store.comments.length && !starting()}>
        <div class="comments-empty">
          <span class="comments-empty-icon">
            <Icon name="comment" />
          </span>
          <strong>No comments yet</strong>
          <p class="empty">
            <Show
              when={!touchOnly()}
              fallback="Tap a line number in the diff, or slide along the numbers for several lines."
            >
              Click a line number's + in the diff, or select lines and{" "}
              {preferences.keyText("comment") ? `press ${preferences.keyText("comment")}` : "run Comment"}.
            </Show>
          </p>
        </div>
      </Show>
    </div>
  );
}

/** The comments panel: its search, a global comment, and every comment. */
export function CommentsSide(props: { onOpen: (comment: Comment) => void; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  // A new comment must not vanish from the list as it is saved.
  createEffect(
    () => {
      const target = state.composer();
      return target && !target.id && state.lineOf(target) === undefined;
    },
    (starting) => {
      if (starting) setQuery("");
    },
  );
  return (
    <aside class="comments-side" id="comments" aria-label="Comments">
      <div class="side-head">
        <h2 class="side-title">
          Comments
          <Show when={state.store.comments.length}>
            <span class="side-count">{state.store.comments.length}</span>
          </Show>
        </h2>
        <Show when={state.store.comments.length || query()}>
          <SearchField
            class="comments-search"
            value={query()}
            onInput={setQuery}
            onEnter={() => {
              const first = query().trim() && findComments(query())[0];
              if (first) props.onOpen(first);
            }}
            placeholder="Search comments"
            label="Search comments"
            title="Filter the comments · Enter opens the first"
          />
        </Show>
        <button
          class="icon-button"
          title={preferences.hint("Global comment", "globalComment")}
          onClick={() => state.compose(globalTarget)}
        >
          <Icon name="plus" />
        </button>
        <button
          class="icon-button"
          title={preferences.hint("Hide the comments", "showComments")}
          onClick={() => props.onClose()}
        >
          <Icon name="x" />
        </button>
      </div>
      <CommentsPanel search={query()} onOpen={props.onOpen} />
    </aside>
  );
}
