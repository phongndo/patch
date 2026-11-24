import type { FileDiffMetadata } from "@pierre/diffs";
import { FileTree, type GitStatus } from "@pierre/trees";
import { createEffect } from "solid-js";

const status: Record<FileDiffMetadata["type"], GitStatus> = {
  change: "modified",
  new: "added",
  deleted: "deleted",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
};

export function Tree(props: { files: FileDiffMetadata[]; search: string; onOpen: (path: string) => void }) {
  let mount: HTMLDivElement | undefined;
  let tree: FileTree | undefined;

  createEffect(
    () => props.files,
    (files) => {
      if (!mount) return;
      const known = new Set(files.map((file) => file.name));
      tree = new FileTree({
        paths: files.map((file) => file.name),
        gitStatus: files.map((file) => ({ path: file.name, status: status[file.type] })),
        initialExpansion: "open",
        flattenEmptyDirectories: true,
        density: "compact",
        onSelectionChange(paths) {
          const path = paths.at(-1);
          if (path && known.has(path)) props.onOpen(path);
        },
      });
      tree.render({ containerWrapper: mount });
      return () => {
        tree?.cleanUp();
        tree = undefined;
        mount?.replaceChildren();
      };
    },
  );

  createEffect(
    () => props.search,
    (value) => tree?.setSearch(value || null),
    { defer: true },
  );

  return <div class="tree" ref={(element) => (mount = element)} />;
}
