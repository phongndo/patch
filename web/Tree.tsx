import type { FileDiffMetadata } from "@pierre/diffs";
import { FileTree, type GitStatus } from "@pierre/trees";
import { createEffect } from "solid-js";

/** Most files in a diff are modified, so only the others are marked. */
const status: Record<Exclude<FileDiffMetadata["type"], "change">, GitStatus> = {
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
        gitStatus: files.flatMap((file) =>
          file.type === "change" ? [] : [{ path: file.name, status: status[file.type] }],
        ),
        icons: { set: "complete", colored: true },
        // Every folder here holds changes, so a dot on each says nothing.
        // A row is ringed for the keyboard only; a click already fills it.
        unsafeCSS: `[data-item-contains-git-change]>[data-item-section=git]{visibility:hidden}
          [data-type=item]:not(:focus-visible)::before{outline-color:transparent!important}`,
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
