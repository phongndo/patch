import type { FileDiffMetadata } from "@pierre/diffs";
import { FileTree, type GitStatus, type GitStatusEntry } from "@pierre/trees";
import { createEffect } from "solid-js";

const status: Record<FileDiffMetadata["type"], GitStatus> = {
  change: "modified",
  new: "added",
  deleted: "deleted",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
};

/** How the tree marks each changed file. Among changes alone most are modified, so `marked` can leave those plain. */
export const treeStatus = (files: readonly FileDiffMetadata[], marked = true): GitStatusEntry[] =>
  files.flatMap((file) =>
    file.type === "change" && !marked ? [] : [{ path: file.name, status: status[file.type] }],
  );

export function Tree(props: {
  paths: readonly string[];
  status: readonly GitStatusEntry[];
  /** Every folder holds changes, so a dot on each says nothing. */
  quietFolders?: boolean;
  expansion: "open" | "closed";
  /** As tall as its rows, for a tree that sits among others in one scrolling list. */
  fit?: boolean;
  onOpen: (path: string) => void;
}) {
  let mount: HTMLDivElement | undefined;
  let tree: FileTree | undefined;
  // The files and marks it shows now; a tree made again starts from them.
  let paths: readonly string[] = [];
  let gitStatus: readonly GitStatusEntry[] = [];
  let known = new Set<string>();

  // New files keep the tree: its folders stay as the reader opened them, and what is
  // selected or focused stays so.
  createEffect(
    () => [props.paths, props.status] as const,
    ([nextPaths, nextStatus]) => {
      paths = nextPaths;
      gitStatus = nextStatus;
      known = new Set(nextPaths);
      if (!tree) return;
      const rows = tree.getVisibleRows(0, tree.getVisibleCount());
      const open = rows.filter((row) => row.kind === "directory" && row.isExpanded).map((row) => row.path);
      tree.resetPaths(nextPaths, { initialExpandedPaths: open });
      tree.setGitStatus(nextStatus);
    },
  );

  // How it looks makes it again.
  createEffect(
    () => [props.quietFolders, props.expansion, props.fit] as const,
    ([quietFolders, expansion, fit]) => {
      if (!mount) return;
      tree = new FileTree({
        paths,
        gitStatus,
        icons: { set: "complete", colored: true },
        // A row is ringed for the keyboard only; a click already fills it.
        unsafeCSS: `${quietFolders ? "[data-item-contains-git-change]>[data-item-section=git]{visibility:hidden}" : ""}
          [data-type=item]:not(:focus-visible)::before{outline-color:transparent!important}
          [data-file-tree-virtualized-scroll]{overscroll-behavior:none}`,
        initialExpansion: expansion,
        flattenEmptyDirectories: true,
        density: "compact",
        onSelectionChange(selected) {
          const path = selected.at(-1);
          if (path && known.has(path)) props.onOpen(path);
        },
      });
      tree.render({ containerWrapper: mount });
      // A tree among others is as tall as its rows, which change as folders open and close.
      const made = tree;
      const measure = () => {
        if (fit && mount) mount.style.height = `${made.getVisibleCount() * made.getItemHeight()}px`;
      };
      const unsubscribe = made.subscribe(measure);
      measure();
      return () => {
        unsubscribe();
        tree?.cleanUp();
        tree = undefined;
        mount?.replaceChildren();
      };
    },
  );

  return <div class="tree" ref={(element) => (mount = element)} />;
}
