//! Every comment in this review: general comments about the whole change,
//! then line comments grouped by file. Searchable, editable, and deletable one
//! at a time or as a selection.

import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { Comment } from "../src/protocol.ts";
import { isPageShortcut } from "./hotkeys.ts";
import { Icon } from "./Icon.tsx";
import { lineLabel } from "./Notes.tsx";
import { preferences } from "./settings.ts";
import { isGeneral, isShown, state } from "./state.ts";

/** A line comment whose lines are no longer in the diff on screen; it is still sent as written. */
export const moved = (comment: Comment) =>
  !isGeneral(comment) && !isShown(state.fileByName(comment.file), comment);

/** Writes or edits a general comment in place. */
function GeneralEditor(props: { id?: string }) {
  const body = () => state.generalText();
  let input: HTMLTextAreaElement | undefined;
  onSettled(() => {
    requestAnimationFrame(() => input?.focus());
  });
  const save = () => {
    if (body().trim()) state.saveGeneral(body().trim(), props.id);
    else if (props.id) state.deleteComment(props.id);
    else state.cancelGeneral();
  };
  return (
    <form
      class="general-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <textarea
        ref={(element) => (input = element)}
        rows={3}
        placeholder="About the whole change"
        value={body()}
        onInput={(event) => state.setGeneralText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (isPageShortcut(event)) return;
          event.stopPropagation();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            state.cancelGeneral();
          }
        }}
      />
      <footer>
        <span class="hint">⌘↵ save · Esc cancel</span>
        <button type="button" class="button quiet" onClick={() => state.cancelGeneral()}>
          Cancel
        </button>
        <button type="submit" class="button primary" disabled={!body().trim() && !props.id}>
          {props.id ? "Save" : "Add"}
        </button>
      </footer>
    </form>
  );
}

export function CommentsPanel(props: {
  query: string;
  onOpen: (comment: Comment) => void;
  onEdit: (comment: Comment) => void;
}) {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  // "new" while a general comment is being written; an id while one is edited.
  const writing = () => {
    const open = state.general();
    return open && (open.id ?? "new");
  };

  const visible = createMemo(() => {
    const text = props.query.trim().toLowerCase();
    return state.store.comments.filter(
      (comment) =>
        !text ||
        comment.file.toLowerCase().includes(text) ||
        comment.body.toLowerCase().includes(text) ||
        comment.excerpt.some((line) => line.toLowerCase().includes(text)),
    );
  });
  const general = createMemo(() => visible().filter(isGeneral));
  const groups = createMemo(() => [
    ...Map.groupBy(
      visible()
        .filter((comment) => !isGeneral(comment))
        .toSorted((a, b) => a.file.localeCompare(b.file) || a.start - b.start),
      (comment) => comment.file,
    ),
  ]);

  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected());
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setSelected(next);
  };
  const clear = () => setSelected(new Set<string>());
  const chosen = () =>
    [...selected()].filter((id) => state.store.comments.some((comment) => comment.id === id));

  function Row(row: { comment: Comment }) {
    const comment = () => row.comment;
    const edit = () => (isGeneral(comment()) ? state.composeGeneral(comment().id) : props.onEdit(comment()));
    return (
      <Show when={writing() !== comment().id} fallback={<GeneralEditor id={comment().id} />}>
        <li class={{ "comment-row": true, selected: selected().has(comment().id) }}>
          <input
            type="checkbox"
            class="comment-check"
            title="Select"
            checked={selected().has(comment().id)}
            onChange={(event) => toggle([comment().id], event.currentTarget.checked)}
          />
          <button
            class="comment-item"
            title={
              isGeneral(comment())
                ? "Edit"
                : moved(comment())
                  ? "Its lines are no longer in the diff; it will be sent as written"
                  : "Show in the diff"
            }
            onClick={() => (isGeneral(comment()) ? edit() : !moved(comment()) && props.onOpen(comment()))}
          >
            <Show when={!isGeneral(comment()) || comment().scope}>
              <span class="comment-line">
                <Show when={!isGeneral(comment())}>
                  {lineLabel(comment().start, comment().end, comment().side)}
                </Show>
                <Show when={moved(comment())}>
                  <span class="tag warning">not in the diff</span>
                </Show>
                <Show when={comment().scope}>
                  <span class="tag">{comment().scope}</span>
                </Show>
              </span>
            </Show>
            <Show when={comment().excerpt[0]?.trim()}>
              <code class="comment-excerpt">{comment().excerpt[0]!.trim()}</code>
            </Show>
            <span class="comment-body">{comment().body}</span>
          </button>
          <span class="comment-actions">
            <Show when={!moved(comment())}>
              <button class="icon-button" title="Edit" onClick={edit}>
                <Icon name="pencil" />
              </button>
            </Show>
            <button class="icon-button" title="Delete" onClick={() => state.deleteComment(comment().id)}>
              <Icon name="trash" />
            </button>
          </span>
        </li>
      </Show>
    );
  }

  return (
    <div class="comments-panel">
      <div class="comment-groups">
        <section class="comment-group">
          <header class="comment-file general">
            <span class="comment-file-name">General</span>
            <span class="count">{general().length || ""}</span>
            <button
              class="icon-button"
              title={preferences.hint("Add a general comment, about the whole change", "generalComment")}
              onClick={() => state.composeGeneral()}
            >
              <Icon name="plus" />
            </button>
          </header>
          <Show when={writing() === "new"}>
            <GeneralEditor />
          </Show>
          <ul>
            <For each={general()}>{(comment) => <Row comment={comment} />}</For>
          </ul>
        </section>

        <For each={groups()}>
          {([file, comments]) => {
            const ids = () => comments.map((comment) => comment.id);
            const all = () => ids().every((id) => selected().has(id));
            return (
              <section class="comment-group">
                <header class="comment-file">
                  <input
                    type="checkbox"
                    title="Select this file's comments"
                    checked={all()}
                    onChange={() => toggle(ids(), !all())}
                  />
                  <button class="comment-file-name" title={file} onClick={() => props.onOpen(comments[0]!)}>
                    {file}
                  </button>
                  <span class="count">{comments.length}</span>
                </header>
                <ul>
                  <For each={comments}>{(comment) => <Row comment={comment} />}</For>
                </ul>
              </section>
            );
          }}
        </For>

        <Show when={!groups().length && !general().length && writing() !== "new"}>
          <p class="empty">
            {props.query.trim()
              ? "No comments match the search."
              : `No line comments yet. Click a line number's + in the diff, or select lines and ${
                  preferences.keyText("comment") ? `press ${preferences.keyText("comment")}` : "run Comment"
                }.`}
          </p>
        </Show>
      </div>

      <footer class="comment-bar">
        <Show
          when={chosen().length}
          fallback={
            <>
              <button
                class="link"
                disabled={!visible().length}
                onClick={() =>
                  toggle(
                    visible().map((c) => c.id),
                    true,
                  )
                }
              >
                Select all
              </button>
            </>
          }
        >
          <span class="comment-bar-count">{chosen().length} selected</span>
          <button
            class="link danger"
            onClick={() => {
              state.deleteComments(chosen());
              clear();
            }}
          >
            Delete
          </button>
          <button class="icon-button" title="Clear the selection" onClick={clear}>
            <Icon name="x" />
          </button>
        </Show>
      </footer>
    </div>
  );
}
