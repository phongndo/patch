import { memo, useEffect, useMemo, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { ReviewFile } from "./types";

interface Props {
  files: ReviewFile[];
  activeId: string;
  reviewed: string[];
  query: string;
  onSelect(id: string): void;
}

export const FileNavigation = memo(function FileNavigation({
  files,
  activeId,
  reviewed,
  query,
  onSelect,
}: Props) {
  const lookup = useMemo(() => {
    const map = new Map<string, ReviewFile>();
    for (const file of files)
      map.set(map.has(file.path) ? `${file.path} (${file.id.split(":")[0]})` : file.path, file);
    return map;
  }, [files]);
  const latest = useRef({ onSelect, reviewed });
  useEffect(() => {
    latest.current = { onSelect, reviewed };
  }, [onSelect, reviewed]);
  const { model } = useFileTree({
    paths: [...lookup.keys()],
    initialExpansion: "open",
    initialSelectedPaths: [...lookup]
      .filter(([, file]) => file.id === activeId)
      .map(([path]) => path),
    density: "default",
    icons: { set: "minimal", colored: false },
    fileTreeSearchMode: "hide-non-matches",
    onSelectionChange(paths) {
      const file = lookup.get(paths.at(-1) ?? "");
      if (file) latest.current.onSelect(file.id);
    },
    renderRowDecoration({ row }) {
      const file = lookup.get(row.path);
      if (!file) return null;
      if (latest.current.reviewed.includes(file.id))
        return { text: "✓", title: "Reviewed", parts: [{ text: "✓", color: "var(--accent)" }] };
      return {
        text: `+${file.additions} −${file.deletions}`,
        parts: [
          { text: `+${file.additions}`, color: "var(--green)" },
          { text: ` −${file.deletions}`, color: "var(--red)" },
        ],
      };
    },
    unsafeCSS: `
      :host { --trees-fg-override: var(--text); --trees-bg-override: transparent; --trees-accent-override: var(--accent); --trees-selected-bg-override: var(--selected); --trees-selected-fg-override: var(--accent-text); --trees-font-size-override: 12px; --trees-font-family-override: var(--font-sans); --trees-border-radius-override: 5px; --trees-bg-muted-override: var(--hover); --trees-selected-focused-border-color-override: transparent; --trees-focus-ring-color-override: var(--accent); }
      [role=treeitem] { min-height: 33px; }
    `,
  });
  useEffect(() => {
    model.setSearch(query || null);
  }, [model, query]);
  useEffect(() => {
    const path = [...lookup].find(([, file]) => file.id === activeId)?.[0];
    if (path) {
      model.getItem(path)?.select();
      model.scrollToPath(path, { offset: "nearest" });
    }
  }, [model, lookup, activeId]);
  useEffect(() => {
    model.setGitStatus([]);
  }, [model, reviewed]);
  return <FileTree className="file-tree" model={model} aria-label="Changed files" />;
});
