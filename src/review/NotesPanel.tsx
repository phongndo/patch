import { useEffect, useRef, useState } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import type { Note, ReviewFile } from "./types";
import { Icon } from "./Icon";

export interface CommentTarget {
  file: string;
  range: SelectedLineRange;
}
export function locationLabel(range: SelectedLineRange) {
  return range.start === 0
    ? "File note"
    : `L${range.start}${range.end > range.start ? `–${range.end}` : ""} · ${range.side === "deletions" ? "before" : "after"}`;
}

export function NotesPanel({
  open,
  files,
  notes,
  target,
  onTarget,
  onClose,
  onSave,
  onDelete,
  onNavigate,
}: {
  open: boolean;
  files: ReviewFile[];
  notes: Note[];
  target: CommentTarget | null;
  onTarget(target: CommentTarget | null): void;
  onClose(): void;
  onSave(note: Note): void;
  onDelete(id: string): void;
  onNavigate(note: Note): void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const file = files.find((file) => file.id === target?.file);
  useEffect(() => {
    if (target && open) textarea.current?.focus();
  }, [target, open]);
  function submit() {
    if (!target || !draft.trim()) return;
    onSave({
      id: editing ?? crypto.randomUUID(),
      file: target.file,
      range: target.range,
      text: draft.trim(),
    });
    setDraft("");
    setEditing(null);
    onTarget(null);
  }
  return (
    <aside className="notes-panel" aria-label="Review notes" hidden={!open}>
      <div className="notes-heading">
        <h2>
          Review notes <span>{notes.length}</span>
        </h2>
        <button className="icon-button" aria-label="Close notes" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="notes-content">
        {target && file && (
          <form
            className="note-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="note-context">
              <span title={file.path}>{file.path.split("/").at(-1)}</span>
              <span>{locationLabel(target.range)}</span>
            </div>
            <textarea
              ref={textarea}
              aria-label="Review note"
              placeholder="What should change, and why?"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="composer-actions">
              <button
                type="button"
                className="text-button muted"
                onClick={() => {
                  onTarget(null);
                  setDraft("");
                  setEditing(null);
                }}
              >
                Cancel
              </button>
              <button className="button primary small" disabled={!draft.trim()} type="submit">
                {editing ? "Save changes" : "Add note"}
              </button>
            </div>
          </form>
        )}
        {notes.map((note) => {
          const file = files.find((file) => file.id === note.file);
          return (
            <article className="note-card" key={note.id}>
              <button className="note-location" onClick={() => onNavigate(note)} title={file?.path}>
                <Icon name="files" size={13} />
                <span>{file?.path.split("/").at(-1)}</span>
                <span>{locationLabel(note.range)}</span>
              </button>
              <p>{note.text}</p>
              <div className="note-actions">
                <span className="note-author">
                  <span className="avatar">Y</span>You
                </span>
                <button
                  className="text-button"
                  onClick={() => {
                    setEditing(note.id);
                    setDraft(note.text);
                    onTarget({ file: note.file, range: note.range });
                  }}
                >
                  Edit
                </button>
                <button
                  className="icon-button"
                  aria-label="Delete note"
                  onClick={() => onDelete(note.id)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </article>
          );
        })}
        {notes.length === 0 && !target && (
          <div className="notes-empty">
            <div className="empty-icon">
              <Icon name="note" size={24} />
            </div>
            <h3>Keep the useful bits.</h3>
            <p>
              Select a line to leave a precise note, or press <kbd>C</kbd> to comment on the file.
            </p>
          </div>
        )}
      </div>
      <div className="notes-footer">
        <span className="status-dot" />
        Saved on this device
      </div>
    </aside>
  );
}
