import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Review, ReviewMode, ReviewProgress, ReviewSource } from "./types";
import { formatReview } from "./storage";
import { Icon } from "./Icon";

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "dialog-wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function OpenDialog({
  onClose,
  onLocal,
  onImport,
  onExample,
  repository,
}: {
  onClose(): void;
  onLocal(mode: ReviewMode): void;
  onImport(source: ReviewSource): void;
  onExample(): void;
  repository?: string;
}) {
  const [tab, setTab] = useState("local");
  const [patch, setPatch] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) {
      setError("Choose a patch smaller than 64 MB.");
      return;
    }
    try {
      const patch = await file.text();
      onImport({
        patch,
        repository: file.name,
        branch: "after",
        base: "before",
        title: file.name,
        kind: "patch",
      });
      onClose();
    } catch {
      setError("This file could not be read.");
    }
  }
  return (
    <Dialog title="Open changes" onClose={onClose}>
      <div className="dialog-tabs">
        <button className={tab === "local" ? "selected" : ""} onClick={() => setTab("local")}>
          <Icon name="branch" size={15} />
          Local repository
        </button>
        <button className={tab === "patch" ? "selected" : ""} onClick={() => setTab("patch")}>
          <Icon name="files" size={15} />
          Patch file
        </button>
      </div>
      {tab === "local" ? (
        <>
          <p className="dialog-description">
            Read changes from <strong>{repository ?? "the local repository"}</strong>. Your files
            stay untouched.
          </p>
          <div className="source-options">
            {(
              [
                ["working", "Working tree", "Saved changes, including new files."],
                ["staged", "Staged changes", "Only changes in the Git index."],
                ["branch", "Branch changes", "Committed changes since the configured base branch."],
              ] as const
            ).map(([mode, title, description]) => (
              <button
                key={mode}
                onClick={() => {
                  onLocal(mode);
                  onClose();
                }}
              >
                <Icon name={mode === "staged" ? "check" : "branch"} />
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
                <Icon name="right" size={16} />
              </button>
            ))}
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!patch.trim()) return;
            onImport({
              patch,
              repository: "Imported patch",
              branch: "after",
              base: "before",
              title: "Imported patch",
              kind: "patch",
            });
            onClose();
          }}
        >
          <div
            className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void readFile(event.dataTransfer.files[0]);
            }}
          >
            <Icon name="upload" size={24} />
            <p>Drop a .diff or .patch file</p>
            <button
              type="button"
              className="button secondary small"
              onClick={() => input.current?.click()}
            >
              Choose a file
            </button>
            <input
              ref={input}
              type="file"
              accept=".diff,.patch,text/plain"
              className="sr-only"
              aria-label="Choose patch file"
              onChange={(event) => void readFile(event.target.files?.[0])}
            />
          </div>
          <label className="field-label" htmlFor="patch-text">
            Or paste a unified diff
          </label>
          <textarea
            id="patch-text"
            className="patch-input"
            placeholder={"diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ ..."}
            value={patch}
            onChange={(event) => setPatch(event.target.value)}
            spellCheck={false}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button primary full-width" disabled={!patch.trim()}>
            Open patch
            <Icon name="right" size={16} />
          </button>
        </form>
      )}
      <div className="dialog-footnote">
        <span>Just looking around?</span>
        <button
          className="text-button"
          onClick={() => {
            onExample();
            onClose();
          }}
        >
          Open an example
          <Icon name="right" size={14} />
        </button>
      </div>
    </Dialog>
  );
}

export function ExportDialog({
  review,
  progress,
  onClose,
}: {
  review: Review;
  progress: ReviewProgress;
  onClose(): void;
}) {
  const markdown = formatReview(review, progress);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
    } catch {
      ref.current?.select();
      setError("Copy is unavailable. The review is selected so you can copy it manually.");
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "patch-review.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Dialog title="Your review, ready to go." onClose={onClose} wide>
      <p className="dialog-description">
        {progress.reviewed.length} of {review.files.length} files reviewed · {progress.notes.length}{" "}
        {progress.notes.length === 1 ? "note" : "notes"}. Copy the Markdown into your editor, agent,
        or pull request.
      </p>
      <textarea
        ref={ref}
        className="export-preview"
        aria-label="Review Markdown"
        readOnly
        value={markdown}
        spellCheck={false}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button secondary" onClick={download}>
          <Icon name="download" size={16} />
          Download .md
        </button>
        <button className="button primary" onClick={() => void copy()}>
          <Icon name={copied ? "check" : "copy"} size={16} />
          {copied ? "Copied" : "Copy review"}
        </button>
      </div>
    </Dialog>
  );
}

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog title="A few useful keys" onClose={onClose}>
      <div className="shortcut-list">
        {[
          ["J / K", "Next / previous file"],
          ["R", "Mark file reviewed"],
          ["C", "Add a file note"],
          ["/", "Filter files"],
          ["?", "Keyboard shortcuts"],
          ["Esc", "Close a dialog"],
        ].map(([key, label]) => (
          <div key={key}>
            <span>{label}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
      <p className="dialog-description">
        Select lines and click the + in the gutter to leave a note on that code.
      </p>
    </Dialog>
  );
}
