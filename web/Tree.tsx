import type { FileDiffMetadata } from "@pierre/diffs";
import { FileTree, type GitStatus, type GitStatusEntry } from "@pierre/trees";
import { createEffect } from "solid-js";

/**
 * How rows give way when they are narrower than their names. A run of folders shown as one row
 * keeps its deepest folder, which tells it from its neighbours, and then its first, which says
 * where it starts: the ones between give way first, down to a letter, or with four folders or
 * more, as one piece down to "…". A name is cut before its last word. Both shapes come from
 * patches/@pierre%2Ftrees@1.0.0.patch. Text fades into the cut, along an eased
 * curve rather than a straight one. Levels past the second indent less, so a deep file keeps
 * room for its name; each guide still sits under its folder's chevron.
 */
const FITTING = `
  [data-item-flattened-subitems] { display: flex; min-width: 0; max-width: 100%; }
  /* Each gives way about a thousand times sooner than the one it yields to, which makes it all
     but in turn: the share of a pixel the others take is slack (1px more, up to the name's own
     width), never a cut. A folder keeps a letter or two, or all of a shorter name; without
     calc-size, down to "…". */
  [data-item-flattened-subitem] {
    flex: 0 1000000 auto; overflow: hidden;
    min-width: 0; min-width: calc-size(max-content, min(size, 1.3em));
  }
  /* Four folders or more: the ones between are one piece, cut from its start, down to "…". */
  [data-item-flattened-between] { flex: 0 1000000 auto; overflow: hidden; min-width: .8em; }
  :is([data-item-flattened-subitem], [data-item-flattened-between]) > [data-truncate-container] {
    width: calc(100% + 1px); max-width: max-content;
  }
  [data-item-flattened-subitem]:first-child {
    flex-shrink: 1000; min-width: calc-size(max-content, min(size, 1.8em));
  }
  [data-item-flattened-subitem]:last-child {
    flex-shrink: 1; min-width: calc-size(max-content, min(size, 3.5em));
  }
  [data-truncate-container] {
    --truncate-marker-fade-width: .9em;
    --truncate-marker-opacity: 55%;
    --truncate-middle-marker-opacity: 60%;
  }
  [data-truncate-variant=default] [data-truncate-marker]:is(::before, ::after) {
    mask-image: linear-gradient(var(--truncate-internal-fade-dir), #000 0%, rgb(0 0 0 / .86) 22%,
      rgb(0 0 0 / .6) 44%, rgb(0 0 0 / .32) 66%, rgb(0 0 0 / .1) 86%, transparent 100%);
  }
  [data-item-section=spacing-item]:nth-child(n + 3) { margin-right: 1px; }
`;

/**
 * Shows a clipped row's whole path when the pointer rests on it; a row shown whole needs none.
 * On each move, not over: moving from row to row inside the tree's shadow root is no "over" for
 * the page. A row is measured once each time the pointer comes to it.
 */
let titled: HTMLElement | undefined;
function titleClipped(event: PointerEvent) {
  const row = event
    .composedPath()
    .find((node): node is HTMLElement => node instanceof HTMLElement && node.matches("[data-type=item]"));
  if (!row || row === titled) return;
  titled = row;
  const clipped = [...row.querySelectorAll<HTMLElement>("[data-truncate-content=visible]")].some(
    (text) => text.scrollWidth > text.clientWidth + 0.5,
  );
  const path = row.dataset.itemPath?.replace(/\/$/, "");
  if (clipped && path) row.title = path;
  else row.removeAttribute("title");
}

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
          [data-file-tree-virtualized-scroll]{overscroll-behavior:none}
          ${FITTING}`,
        initialExpansion: expansion,
        flattenEmptyDirectories: true,
        density: "compact",
        onSelectionChange(selected) {
          const path = selected.at(-1);
          if (path && known.has(path)) props.onOpen(path);
        },
      });
      // A tree among others is as tall as its rows, which change as folders open and close.
      const made = tree;
      const target = mount;
      const measure = () => {
        if (fit) target.style.height = `${made.getVisibleCount() * made.getItemHeight()}px`;
      };
      const unsubscribe = made.subscribe(measure);
      measure();
      // Being as tall as its rows, it draws every one of them: one among others draws them
      // only once it nears the part of the list on screen, and keeps its height until then.
      let near: IntersectionObserver | undefined;
      if (fit) {
        near = new IntersectionObserver(
          (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            near?.disconnect();
            made.render({ containerWrapper: target });
          },
          { root: target.closest(".side-body"), rootMargin: "100% 0px" },
        );
        near.observe(target);
      } else made.render({ containerWrapper: target });
      return () => {
        near?.disconnect();
        unsubscribe();
        tree?.cleanUp();
        tree = undefined;
        mount?.replaceChildren();
      };
    },
  );

  return (
    <div
      class="tree"
      ref={(element) => (mount = element)}
      onPointerMove={titleClipped}
      onPointerLeave={() => (titled = undefined)}
    />
  );
}
