//! Every comment in the draft: general comments about the whole change, then
//! line comments grouped by file. Filtered by state, searchable, and with
//! actions on one comment or on a selection of them.

import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { Comment } from "../src/protocol.ts";
import { Icon } from "./Icon.tsx";
import { lineLabel } from "./Notes.tsx";
import { isGeneral, isShown, state } from "./state.ts";

type Filter = "all" | "open" | "stale" | "resolved";
const filters: Array<{ value: Filter; label: string; hint: string; empty: string }> = [
  { value: "all", label: "All", hint: "Every comment", empty: "No comments yet." },
  { value: "open", label: "Open", hint: "Comments that will be sent", empty: "No open comments." },
  {
    value: "stale",
    label: "Stale",
    hint: "Open comments whose lines are not in the diff on screen",
    empty: "No stale comments.",
  },
  { value: "resolved", label: "Done", hint: "Resolved: kept, but not sent", empty: "No resolved comments." },
];

/** A line comment whose lines are no longer in the diff on screen. */
const stale = (comment: Comment) => !isGeneral(comment) && !isShown(state.fileByName(comment.file), comment);

const matches = (comment: Comment, value: Filter) =>
  value === "all" ||
  (value === "resolved"
    ? Boolean(comment.resolved)
    : !comment.resolved && (value === "open" || stale(comment)));

/** Writes or edits a general comment in place. */
function GeneralEditor(props: { id?: string; onDone: () => void }) {
  const [body, setBody] = createSignal(
    () => state.store.comments.find((comment) => comment.id === props.id)?.body ?? "",
  );
  let input: HTMLTextAreaElement | undefined;
  onSettled(() => {
    requestAnimationFrame(() => input?.focus());
  });
  const save = () => {
    if (body().trim()) state.saveGeneral(body().trim(), props.id);
    else if (props.id) state.deleteComment(props.id);
    props.onDone();
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
        onInput={(event) => setBody(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onDone();
          }
        }}
      />
      <footer>
        <span class="hint">⌘↵ save · Esc cancel</span>
        <button type="button" class="button quiet" onClick={() => props.onDone()}>
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
  const [filter, setFilter] = createSignal<Filter>("all");
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  // "new" while a general comment is being written; an id while one is edited.
  const [writing, setWriting] = createSignal<string>();

  const counts = createMemo(() => {
    const out: Record<Filter, number> = { all: 0, open: 0, stale: 0, resolved: 0 };
    for (const comment of state.store.comments)
      for (const { value } of filters) if (matches(comment, value)) out[value]++;
    return out;
  });

  const visible = createMemo(() => {
    const text = props.query.trim().toLowerCase();
    return state.store.comments
      .filter((comment) => matches(comment, filter()))
      .filter(
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
  const staleIds = () => state.store.comments.filter((c) => !c.resolved && stale(c)).map((c) => c.id);

  function Row(row: { comment: Comment }) {
    const comment = () => row.comment;
    const edit = () => (isGeneral(comment()) ? setWriting(comment().id) : props.onEdit(comment()));
    return (
      <Show
        when={writing() !== comment().id}
        fallback={<GeneralEditor id={comment().id} onDone={() => setWriting(undefined)} />}
      >
        <li
          class={{
            "comment-row": true,
            selected: selected().has(comment().id),
            resolved: Boolean(comment().resolved),
          }}
        >
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
                : stale(comment())
                  ? "Its lines are not in the diff on screen"
                  : "Show in the diff"
            }
            onClick={() => (isGeneral(comment()) ? edit() : !stale(comment()) && props.onOpen(comment()))}
          >
            <Show when={!isGeneral(comment()) || comment().resolved || comment().scope}>
              <span class="comment-line">
                <Show when={!isGeneral(comment())}>
                  {lineLabel(comment().start, comment().end, comment().side)}
                </Show>
                <Show when={comment().resolved}>
                  <span class="tag">done</span>
                </Show>
                <Show when={!comment().resolved && stale(comment())}>
                  <span class="tag stale">stale</span>
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
            <button
              class="icon-button"
              title={comment().resolved ? "Reopen" : "Resolve (kept, but not sent)"}
              onClick={() => state.setResolved([comment().id], !comment().resolved)}
            >
              <Icon name="checkCircle" />
            </button>
            <Show when={!stale(comment())}>
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
      <div class="comment-filters" role="tablist" aria-label="Show comments">
        <For each={filters}>
          {(option) => (
            <button
              role="tab"
              aria-selected={filter() === option.value ? "true" : "false"}
              class="comment-filter"
              title={option.hint}
              onClick={() => {
                setFilter(option.value);
                clear();
              }}
            >
              {option.label}
              <span class="count">{counts()[option.value]}</span>
            </button>
          )}
        </For>
      </div>

      <div class="comment-groups">
        <section class="comment-group">
          <header class="comment-file general">
            <span class="comment-file-name">General</span>
            <span class="count">{general().length || ""}</span>
            <button
              class="icon-button"
              title="Add a general comment, about the whole change"
              onClick={() => setWriting("new")}
            >
              <Icon name="plus" />
            </button>
          </header>
          <Show when={writing() === "new"}>
            <GeneralEditor onDone={() => setWriting(undefined)} />
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
              : filter() === "all"
                ? "No line comments yet. Click a line number's + in the diff, or select lines and press c."
                : filters.find((option) => option.value === filter())!.empty}
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
              <Show when={staleIds().length}>
                <button class="link danger" onClick={() => state.deleteComments(staleIds())}>
                  Delete {staleIds().length} stale
                </button>
              </Show>
            </>
          }
        >
          <span class="comment-bar-count">{chosen().length} selected</span>
          <button
            class="link"
            onClick={() => {
              state.setResolved(chosen(), true);
              clear();
            }}
          >
            Resolve
          </button>
          <button
            class="link"
            onClick={() => {
              state.setResolved(chosen(), false);
              clear();
            }}
          >
            Reopen
          </button>
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
