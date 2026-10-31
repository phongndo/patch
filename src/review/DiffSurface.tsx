import { memo, useMemo } from "react";
import { canUseWASM } from "@pierre/diffs";
import type {
  CodeViewDiffItem,
  CodeViewHandle,
  CodeViewReactOptions,
  SelectedLineRange,
} from "@pierre/diffs/react";
import { CodeView } from "@pierre/diffs/react";
import type { RefObject } from "react";
import type { Note, ReviewFile } from "./types";
import { Icon } from "./Icon";
import "./themes";

interface Props {
  file: ReviewFile;
  notes: Note[];
  mode: "split" | "unified";
  theme: "light" | "dark";
  onComment(range: SelectedLineRange): void;
  onOpenNote(note: Note): void;
  viewerRef: RefObject<CodeViewHandle<Note, undefined> | null>;
}

const diffCSS = `
  :host { --diffs-font-family: var(--font-mono); --diffs-font-size: 12px; --diffs-line-height: 24px; --diffs-bg: var(--surface); }
  [data-diffs] { font-family: var(--font-mono); font-size: 12px; line-height: 24px; }
  [data-line-number-content] { opacity: .8; }
`;

export function DiffVersionHeader({
  file,
  mode,
  before,
  after,
}: {
  file: ReviewFile;
  mode: "split" | "unified";
  before: string;
  after: string;
}) {
  const onlyAfter = file.diff.type === "new";
  const onlyBefore = file.diff.type === "deleted";
  const split = mode === "split" && !onlyAfter && !onlyBefore;
  return (
    <div className={`diff-columns ${split ? "split" : "unified"}`}>
      <span>
        <span className={`version-dot ${onlyAfter ? "after" : "before"}`} />
        {onlyAfter ? "After" : onlyBefore || split ? "Before" : "Changes"}
        <span className="version-ref">
          {onlyAfter ? after : onlyBefore || split ? before : `${before} → ${after}`}
        </span>
      </span>
      {split && (
        <span>
          <span className="version-dot after" />
          After<span className="version-ref">{after}</span>
        </span>
      )}
    </div>
  );
}

export const DiffSurface = memo(function DiffSurface({
  file,
  notes,
  mode,
  theme,
  onComment,
  onOpenNote,
  viewerRef,
}: Props) {
  const options = useMemo<CodeViewReactOptions<Note, undefined>>(
    () => ({
      theme: { light: "patch-light", dark: "patch-dark" },
      themeType: theme,
      preferredHighlighter: canUseWASM() ? "highlights" : "shiki-js",
      diffStyle: mode,
      diffIndicators: "bars",
      lineDiffType: "word-alt",
      disableFileHeader: true,
      hunkSeparators: "line-info",
      overflow: "scroll",
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: "number",
      unsafeCSS: diffCSS,
      itemMetrics: { lineHeight: 24 },
    }),
    [mode, theme],
  );
  const items = useMemo<CodeViewDiffItem<Note>[]>(
    () => [
      {
        id: file.id,
        type: "diff",
        fileDiff: file.diff,
        annotations: notes.map((note) => ({
          lineNumber: note.range.end,
          side: note.range.endSide ?? note.range.side ?? "additions",
          metadata: note,
        })),
      },
    ],
    [file, notes],
  );

  if (file.diff.hunks.length === 0) {
    return (
      <div className="empty-state file-empty">
        <Icon name="files" size={28} />
        <h2>{file.diff.prevName ? "File renamed" : "No text changes"}</h2>
        <p>
          {file.diff.prevName
            ? `${file.diff.prevName} → ${file.path}`
            : "Binary contents and file mode changes are shown in the file list."}
        </p>
      </div>
    );
  }
  return (
    <CodeView
      key={file.id}
      ref={viewerRef}
      className="diff-surface"
      items={items}
      options={options}
      renderGutterUtility={(getLine) => (
        <button
          className="gutter-note-button"
          data-utility-button=""
          type="button"
          aria-label="Add line note"
          title="Add line note"
          onClick={() => {
            const line = getLine();
            if (!line) return;
            const range = viewerRef.current?.getSelectedLines()?.range;
            const side = "side" in line && line.side === "deletions" ? "deletions" : "additions";
            onComment(
              range &&
                range.side === side &&
                line.lineNumber >= range.start &&
                line.lineNumber <= range.end
                ? range
                : {
                    start: line.lineNumber,
                    end: line.lineNumber,
                    side,
                  },
            );
          }}
        >
          <Icon name="plus" size={13} />
        </button>
      )}
      renderAnnotation={(...args) => (
        <button className="line-note" onClick={() => onOpenNote(args[0].metadata)}>
          <Icon name="note" size={14} />
          <span>{args[0].metadata.text}</span>
        </button>
      )}
    />
  );
});
