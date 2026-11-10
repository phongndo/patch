import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CodeViewHandle, SelectedLineRange } from "@pierre/diffs/react";
import { Icon, Mark } from "./Icon";
import { DiffSurface, DiffVersionHeader } from "./DiffSurface";
import { FileNavigation } from "./FileNavigation";
import { ExportDialog, OpenDialog, ShortcutsDialog } from "./Dialogs";
import { NotesPanel } from "./NotesPanel";
import type { CommentTarget } from "./NotesPanel";
import { parseInWorker } from "./parser";
import { readPreference, readProgress, writePreference } from "./storage";
import type { Note, Review, ReviewMode, ReviewSource } from "./types";

type Modal = "open" | "export" | "shortcuts" | null;

export function Reviewer() {
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async (read: (signal: AbortSignal) => Promise<ReviewSource>) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      const source = await read(controller.signal);
      const next = await parseInWorker(source, controller.signal);
      if (!controller.signal.aborted) setReview(next);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : "Unable to open these changes.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);

  const loadGit = useCallback(
    (mode: ReviewMode) => {
      void load(async (signal) => {
        const response = await fetch(`/api/review?mode=${mode}`, { signal });
        if (!response.headers.get("content-type")?.includes("application/json"))
          throw new Error(
            "The local Git server is unavailable. Start the web reviewer with pnpm dev:web or pnpm review:web.",
          );
        const source = (await response.json()) as ReviewSource & { error?: string };
        if (!response.ok) throw new Error(source.error ?? "Unable to read local changes.");
        return source;
      });
    },
    [load],
  );

  const loadExample = useCallback(() => {
    void load(async () => ({
      patch: (await import("./example.diff?raw")).default,
      repository: "acme / toolkit",
      branch: "feat/cache-expiration",
      base: "main",
      title: "Add expiration to the cache",
      kind: "example",
    }));
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (new URLSearchParams(location.search).has("demo")) loadExample();
      else loadGit("working");
    });
    return () => {
      cancelled = true;
      pending.current?.abort();
    };
  }, [loadExample, loadGit]);

  if (!review)
    return (
      <div className="startup full-screen">
        <div className="startup-brand">
          <Mark />
          <span>patch</span>
        </div>
        <div className="empty-state">
          {busy ? (
            <>
              <div className="loading-indicator" />
              <h1>Opening your changes</h1>
              <p>One moment.</p>
            </>
          ) : (
            <>
              <Icon name="folder" size={32} />
              <h1>Something to look over?</h1>
              <p className="startup-error" role="alert">
                {error}
              </p>
              <button className="button primary" onClick={() => setOpen(true)}>
                <Icon name="open" size={16} />
                Open changes
              </button>
              <button className="text-button" onClick={loadExample}>
                Try an example
              </button>
            </>
          )}
        </div>
        {open && (
          <OpenDialog
            onClose={() => setOpen(false)}
            onLocal={loadGit}
            onImport={(source) => void load(async () => source)}
            onExample={loadExample}
          />
        )}
      </div>
    );

  return (
    <Workspace
      key={review.id}
      review={review}
      busy={busy}
      error={error}
      onClearError={() => setError("")}
      onLocal={loadGit}
      onImport={(source) => void load(async () => source)}
      onExample={loadExample}
    />
  );
}

function Workspace({
  review,
  busy,
  error,
  onClearError,
  onLocal,
  onImport,
  onExample,
}: {
  review: Review;
  busy: boolean;
  error: string;
  onClearError(): void;
  onLocal(mode: ReviewMode): void;
  onImport(source: ReviewSource): void;
  onExample(): void;
}) {
  const [activeId, setActiveId] = useState(
    () =>
      (review.source.kind === "example"
        ? review.files.find((file) => file.path === "src/lib/cache.ts")?.id
        : undefined) ??
      review.files[0]?.id ??
      "",
  );
  const [progress, setProgress] = useState(() => readProgress(review.id));
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [mode, setMode] = useState<"split" | "unified">(() =>
    readPreference("layout", innerWidth < 800 ? "unified" : "split") === "unified"
      ? "unified"
      : "split",
  );
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    readPreference("theme", "light") === "dark" ? "dark" : "light",
  );
  const [modal, setModal] = useState<Modal>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const viewer = useRef<CodeViewHandle<Note, undefined>>(null);
  const pendingJump = useRef<Note | null>(null);
  const index = review.files.findIndex((file) => file.id === activeId);
  const active = review.files[index];
  const isReviewed = progress.reviewed.includes(activeId);
  const fileNotes = useMemo(
    () => progress.notes.filter((note) => note.file === activeId),
    [progress.notes, activeId],
  );
  const filteredFiles = useMemo(() => {
    const value = deferredQuery.toLocaleLowerCase();
    return review.files.filter((file) => file.path.toLocaleLowerCase().includes(value));
  }, [review.files, deferredQuery]);
  const fileIds = useMemo(() => new Set(review.files.map((file) => file.id)), [review.files]);
  const reviewedCount = useMemo(
    () => progress.reviewed.filter((id) => fileIds.has(id)).length,
    [progress.reviewed, fileIds],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePreference("theme", theme);
  }, [theme]);
  useEffect(() => {
    writePreference("layout", mode);
  }, [mode]);
  useEffect(() => {
    const save = () =>
      setStorageFailed(!writePreference(`review:${review.id}`, JSON.stringify(progress)));
    const timer = setTimeout(save, 250);
    const onPageHide = () => {
      writePreference(`review:${review.id}`, JSON.stringify(progress));
    };
    addEventListener("pagehide", onPageHide);
    return () => {
      clearTimeout(timer);
      removeEventListener("pagehide", onPageHide);
      onPageHide();
    };
  }, [review.id, progress]);

  const selectFile = useCallback((id: string) => {
    setActiveId(id);
    setSidebarOpen(false);
  }, []);
  const toggleReviewed = useCallback(() => {
    if (!activeId) return;
    setProgress((current) => ({
      ...current,
      reviewed: current.reviewed.includes(activeId)
        ? current.reviewed.filter((id) => id !== activeId)
        : [...current.reviewed, activeId],
    }));
  }, [activeId]);
  const comment = useCallback(
    (range: SelectedLineRange) => {
      if (!activeId) return;
      setTarget({ file: activeId, range });
      setNotesOpen(true);
    },
    [activeId],
  );
  const navigateNote = useCallback(
    (note: Note) => {
      selectFile(note.file);
      setNotesOpen(true);
      if (note.file === activeId)
        viewer.current?.scrollTo({
          type: "line",
          id: note.file,
          lineNumber: Math.max(1, note.range.start),
          side: note.range.side,
          align: "center",
        });
      else pendingJump.current = note;
    },
    [activeId, selectFile],
  );
  useEffect(() => {
    const note = pendingJump.current;
    if (!note || note.file !== activeId) return;
    const frame = requestAnimationFrame(() => {
      viewer.current?.scrollTo({
        type: "line",
        id: note.file,
        lineNumber: Math.max(1, note.range.start),
        side: note.range.side,
        align: "center",
      });
      pendingJump.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const element = event.composedPath()[0];
      if (
        element instanceof HTMLElement &&
        (element.matches("input, textarea, select") || element.isContentEditable)
      )
        return;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        modal ||
        document.querySelector("dialog[open]")
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "j" || key === "k") {
        const next = review.files[index + (key === "j" ? 1 : -1)];
        if (next) selectFile(next.id);
      } else if (key === "r") toggleReviewed();
      else if (key === "c") comment({ start: 0, end: 0, side: "additions" });
      else if (key === "/") {
        setSidebarOpen(true);
        requestAnimationFrame(() => search.current?.focus());
      } else if (key === "?") setModal("shortcuts");
      else return;
      event.preventDefault();
    };
    addEventListener("keydown", handleKey);
    return () => removeEventListener("keydown", handleKey);
  }, [review.files, index, selectFile, toggleReviewed, comment, modal]);

  const closeModal = () => setModal(null);
  return (
    <div className={`workspace ${notesOpen ? "has-notes" : ""}`} data-theme={theme}>
      <header className="topbar">
        <div className="identity">
          <Mark />
          <span className="wordmark">patch</span>
          <span className="identity-slash">/</span>
          <span className="repository" title={review.source.repository}>
            {review.source.repository}
          </span>
          {review.source.kind === "example" && <span className="example-badge">Example</span>}
        </div>
        <div className="branch-comparison">
          <Icon name="branch" size={14} />
          <span>{review.source.base}</span>
          <span className="compare-arrow">←</span>
          <span>{review.source.branch}</span>
        </div>
        <div className="top-actions">
          <button className="button secondary" onClick={() => setModal("open")} disabled={busy}>
            <Icon name="open" size={15} />
            <span>Open changes</span>
          </button>
          <button
            className="button primary"
            onClick={() => setModal("export")}
            disabled={!review.files.length}
          >
            <span>Export review</span>
            <Icon name="right" size={15} />
          </button>
        </div>
      </header>

      <div className="workspace-body">
        {sidebarOpen && (
          <button
            className="sidebar-scrim"
            aria-label="Close file navigation"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`} aria-label="File navigation">
          <div className="sidebar-top">
            <div className="section-label">
              CHANGED FILES<span className="count-badge">{review.files.length}</span>
            </div>
            <div className="change-totals">
              <span className="addition">+{review.additions}</span>
              <span className="deletion">−{review.deletions}</span>
            </div>
          </div>
          <div className="file-search">
            <Icon name="search" size={15} />
            <input
              ref={search}
              aria-label="Filter files"
              placeholder="Filter files…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>/</kbd>
          </div>
          <div className="tree-container">
            <FileNavigation
              files={review.files}
              activeId={activeId}
              reviewed={progress.reviewed}
              query={deferredQuery}
              onSelect={selectFile}
            />
            {query && filteredFiles.length === 0 && (
              <p className="no-results">No files match “{query}”.</p>
            )}
          </div>
          <div className="review-progress">
            <div>
              <span>
                {reviewedCount === review.files.length && review.files.length > 0
                  ? "All files reviewed"
                  : "Your progress"}
              </span>
              <span>
                <strong>{reviewedCount}</strong> / {review.files.length}
              </span>
            </div>
            <progress
              className="progress-track"
              aria-label="Files reviewed"
              value={reviewedCount}
              max={review.files.length || 1}
            />
            <span className="progress-caption">One file at a time.</span>
          </div>
          <div className="sidebar-bottom">
            <span>
              <span className="status-dot" />
              Local review
            </span>
            <div>
              <button
                className="icon-button"
                aria-label={theme === "light" ? "Use dark theme" : "Use light theme"}
                title={theme === "light" ? "Dark theme" : "Light theme"}
                onClick={() => setTheme((value) => (value === "light" ? "dark" : "light"))}
              >
                <Icon name={theme === "light" ? "moon" : "sun"} size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts (?)"
                onClick={() => setModal("shortcuts")}
              >
                <Icon name="keyboard" size={17} />
              </button>
            </div>
          </div>
        </aside>

        <main className="review-main">
          <div className="review-heading">
            <div>
              <div className="review-eyebrow">
                <span className="eyebrow-line" />
                {review.source.kind === "example"
                  ? "EXAMPLE REVIEW"
                  : review.source.kind === "patch"
                    ? "PATCH REVIEW"
                    : "LOCAL CHANGES"}
              </div>
              <h1>{review.source.title}</h1>
              <p>
                {review.files.length} files changed<span>·</span>
                <span className="addition">{review.additions} additions</span>
                <span className="deletion">{review.deletions} deletions</span>
              </p>
            </div>
            <div className="heading-actions">
              {review.source.kind === "git" && (
                <button
                  className={`icon-button ${busy ? "spinning" : ""}`}
                  aria-label="Refresh changes"
                  title="Refresh changes"
                  onClick={() => onLocal(review.source.mode ?? "working")}
                  disabled={busy}
                >
                  <Icon name="refresh" size={17} />
                </button>
              )}
              <button
                className={`button secondary notes-toggle ${notesOpen ? "is-active" : ""}`}
                onClick={() => setNotesOpen((value) => !value)}
                aria-expanded={notesOpen}
              >
                <Icon name="note" size={15} />
                Notes<span className="count-badge">{progress.notes.length}</span>
              </button>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button className="icon-button" aria-label="Dismiss error" onClick={onClearError}>
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
          {storageFailed && (
            <div className="error-banner" role="alert">
              Browser storage is unavailable. Export your review before closing this page.
            </div>
          )}
          {busy && <output className="load-progress" aria-label="Loading changes" />}
          {active ? (
            <>
              <div className="diff-card">
                <div className="file-toolbar">
                  <button
                    className="icon-button mobile-files"
                    aria-label="Show files"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <Icon name="panel" size={17} />
                  </button>
                  <div className="file-path" title={active.path}>
                    <Icon name="files" size={16} />
                    <span className="path-directory">
                      {active.path.includes("/")
                        ? `${active.path.slice(0, active.path.lastIndexOf("/") + 1)}`
                        : ""}
                    </span>
                    <strong>{active.path.split("/").at(-1)}</strong>
                    <span className={`file-status ${active.diff.type}`}>
                      {active.diff.type === "new"
                        ? "A"
                        : active.diff.type === "deleted"
                          ? "D"
                          : active.diff.prevName
                            ? "R"
                            : "M"}
                    </span>
                  </div>
                  <div className="file-toolbar-actions">
                    <div className="layout-switch" aria-label="Diff layout">
                      <button
                        className={mode === "split" ? "is-selected" : ""}
                        onClick={() => setMode("split")}
                        aria-label="Split diff"
                        aria-pressed={mode === "split"}
                        title="Split diff"
                      >
                        <Icon name="split" size={15} />
                      </button>
                      <button
                        className={mode === "unified" ? "is-selected" : ""}
                        onClick={() => setMode("unified")}
                        aria-label="Unified diff"
                        aria-pressed={mode === "unified"}
                        title="Unified diff"
                      >
                        <Icon name="unified" size={15} />
                      </button>
                    </div>
                    <span className="toolbar-divider" />
                    <button
                      className={`reviewed-button ${isReviewed ? "is-reviewed" : ""}`}
                      onClick={toggleReviewed}
                      aria-pressed={isReviewed}
                      title="Mark reviewed (R)"
                    >
                      <span className="review-checkbox">
                        {isReviewed && <Icon name="check" size={12} />}
                      </span>
                      <span>{isReviewed ? "Reviewed" : "Mark reviewed"}</span>
                      <kbd>R</kbd>
                    </button>
                  </div>
                </div>
                <DiffVersionHeader
                  file={active}
                  mode={mode}
                  before={review.source.base}
                  after={review.source.branch}
                />
                <DiffSurface
                  file={active}
                  notes={fileNotes}
                  mode={mode}
                  theme={theme}
                  onComment={comment}
                  onOpenNote={navigateNote}
                  viewerRef={viewer}
                />
              </div>
              <div className="file-pagination">
                <span>
                  File <strong>{index + 1}</strong> of {review.files.length}
                </span>
                <div>
                  <button
                    className="pagination-button"
                    disabled={index <= 0}
                    onClick={() => {
                      const file = review.files[index - 1];
                      if (file) selectFile(file.id);
                    }}
                  >
                    <Icon name="left" size={15} />
                    Previous<kbd>K</kbd>
                  </button>
                  <button
                    className="pagination-button"
                    disabled={index === review.files.length - 1}
                    onClick={() => {
                      const file = review.files[index + 1];
                      if (file) selectFile(file.id);
                    }}
                  >
                    Next file
                    <Icon name="right" size={15} />
                    <kbd>J</kbd>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state clean-tree">
              <div className="empty-icon">
                <Icon name="check" size={28} />
              </div>
              <h2>A clean slate.</h2>
              <p>
                {review.source.mode === "staged"
                  ? "There are no staged changes to review."
                  : "There are no changes in this comparison."}
              </p>
              <button className="button secondary" onClick={() => setModal("open")}>
                Open changes
                <Icon name="right" size={15} />
              </button>
            </div>
          )}
          <footer className="review-footer">
            <span>
              <span className="status-dot" />
              {storageFailed ? "Review kept in memory" : "Your review stays on this device"}
            </span>
            <span className="footer-shortcuts">
              <kbd>J</kbd>
              <kbd>K</kbd> navigate
              <span className="footer-separator" />
              <kbd>C</kbd> add note
            </span>
          </footer>
        </main>
        <NotesPanel
          key={target?.noteId ?? "new"}
          open={notesOpen}
          files={review.files}
          notes={progress.notes}
          target={target}
          onTarget={setTarget}
          onClose={() => setNotesOpen(false)}
          onSave={(note) =>
            setProgress((current) => ({
              ...current,
              notes: [...current.notes.filter((value) => value.id !== note.id), note],
            }))
          }
          onDelete={(id) =>
            setProgress((current) => ({
              ...current,
              notes: current.notes.filter((note) => note.id !== id),
            }))
          }
          onNavigate={navigateNote}
        />
      </div>
      {modal === "open" && (
        <OpenDialog
          repository={review.source.repository}
          onClose={closeModal}
          onLocal={onLocal}
          onImport={onImport}
          onExample={onExample}
        />
      )}
      {modal === "export" && (
        <ExportDialog review={review} progress={progress} onClose={closeModal} />
      )}
      {modal === "shortcuts" && <ShortcutsDialog onClose={closeModal} />}
    </div>
  );
}
