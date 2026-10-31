# Patch

A native macOS diff reviewer built with [Vercel Native SDK](https://github.com/vercel-labs/native).
Pierre icons, a compact file tree, and a continuous, virtualized diff. Git access is read-only.

```sh
nix develop
pnpm install
pnpm dev --repo /path/to/repository
```

Click the repository at the top of the file rail to switch repositories; the
button beside it reads newer changes. The comparison control at the foot of the
rail chooses what to review: Working compares HEAD with the index and working
tree, including untracked files; Staged reads only the index; the third segment
is the checked-out branch, compared from the merge base with its base. Clicking
it opens a picker for both sides (Base and Head, with a swap): type to filter,
↑↓ to choose, ⇥ to switch side, ↩ to compare. Drag the gap beside the rail or
the notes to resize them; both ease open and closed.

Each hunk is its own pane, titled by the declaration it sits in. Scroll sideways
to pan every line of a long diff together; the footer shows the column the
visible code starts at. The file being read pins its header at the top, so a
long file can be folded from anywhere in it.

Click a line number to leave a note. Drag through line numbers to select a range,
or drag through code for native character selection. Shift-click extends a range;
the floating actions let you comment or copy. Right-click code for line and
selection actions. Ranges stay on their original file and side. Use the comment
icon beside a file for a file note. Check off files as you review them; a reviewed
file folds to its header, and clicking a header folds or unfolds it. The notes
panel opens on demand and lists every note in the review, grouped by file; click
one to jump to its line. Noted lines show their line numbers in the accent color. Import patches and copy/export Markdown from the command
palette. Standard clipboard commands work in code and editors.

Settings (**Patch › Settings…**, **⌘,**) opens in its own window: folding,
diff layout, the comparison Patch opens with, the default base branch, the file
rail and pane widths, appearance, and every keyboard shortcut. Appearance offers
twelve themes (Noir, Nord, Gruvbox, Tokyo Night, Catppuccin Mocha and Latte,
Rosé Pine and Dawn, Solarized Dark and Light, Dracula, Paper), solid or glass
panes, and your own Background, Text, Accent, Added and Removed colors over any
theme. The theme palettes come from those open-source projects (MIT).

Notes and reviewed files are saved locally for the exact repository and patch
snapshot, under `~/Library/Application Support/computer.patch.app/`. A changed
patch starts a fresh review. Empty drafts are not saved.

## Keyboard review

Press **⌘K**, **⌘⇧P**, **:**, or **?** to search commands and see their shortcuts.
The **⌘** toolbar button opens the same palette. Search by a changed file's name
or path to open it directly from the command palette.
**⌘P** opens the fuzzy file picker; use arrows or **Ctrl-N / Ctrl-P** and Return.
Vim keys work in the review pane. Typing in a search field or note stays normal.
**Esc** returns focus to the diff and preserves an unfinished note; **c** resumes
it. **⌘Return** saves the note. Its original file and line remain anchored while
you navigate. The × button explicitly discards a draft.

| Keys                   | Action                                              |
| ---------------------- | --------------------------------------------------- |
| `j` / `k`              | Next / previous line                                |
| `h` / `l`              | Old / new side of a split diff                      |
| `J` / `K`, `]f` / `[f` | Next / previous file                                |
| `]c` / `[c`            | Next / previous change block                        |
| `]u` / `[u`            | Next / previous unreviewed file                     |
| `r`                    | Toggle reviewed                                     |
| `R`                    | Mark reviewed and move to the next unreviewed file  |
| `u`                    | Undo reviewed state                                 |
| `c` / `i`, `C`         | Comment on the current line / file                  |
| `/`, `⌘F`              | Find in diff                                        |
| `n` / `N`              | Next / previous search match, wrapping at the ends  |
| `gg` / `G`             | First / last line of the review                     |
| `42G`                  | Go to source line 42 in the current file            |
| `Ctrl-D` / `Ctrl-U`    | Half page down / up                                 |
| `Ctrl-F` / `Ctrl-B`    | Page down / up                                      |
| `Ctrl-E` / `Ctrl-Y`    | Scroll a line without moving the cursor             |
| `H` / `M` / `L`        | Top / middle / bottom of the visible diff           |
| `zz` / `zt` / `zb`     | Center / top / bottom alignment of the current line |
| `za` / `zM` / `zR`     | Fold the current file / fold all / unfold all       |
| `⌘\`                   | Toggle split / unified view                         |
| `⌘B`, `⌘⇧N`            | Toggle the file rail / notes                        |
| `⌘R`, `⌘O`             | Refresh / open repository                           |

Motions accept counts: `5j`, `2]c`, and `3J`. An incomplete sequence expires after
1.2 seconds; Esc cancels it immediately. Search visits matching lines; hunk
metadata and file headers are skipped by line movements. Review undo is scoped
to the current snapshot. Draft notes stay in memory until refresh or app exit.

## Commands

| Command                     | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `pnpm dev [--repo path]`    | Build and run with native UI automation enabled             |
| `pnpm review [--repo path]` | Build and open the native reviewer                          |
| `pnpm build`                | Compile to `zig-out/bin/patch`                              |
| `pnpm package`              | Build an ad-hoc signed `zig-out/Patch.app`                  |
| `pnpm test`                 | Keyboard/parser tests and native/Node Git integration tests |
| `pnpm test:ui`              | Native keyboard, mouse selection, and 50,000-line checks    |
| `pnpm bench:native`         | Measure native startup and interaction latency              |
| `pnpm check`                | tsrs, Oxlint, and Oxfmt                                     |
| `pnpm icons:sync`           | Refresh the embedded Pierre SVG icons                       |
| `pnpm dev:web`              | Run the original React/Vite reviewer                        |
| `pnpm build:web`            | Build the React reviewer                                    |

Prefix commands with `nix develop -c` when outside the development shell. The
flake pins Node 24, pnpm, and Zig 0.16. Building the native macOS target requires
Xcode command-line tools. The web reviewer also runs on Linux.

## Implementation

- `src/main.zig`: native application state, asynchronous Git loading, notes, storage.
- `src/native/keyboard.zig`: Vim sequences, counts, commands, and allocation-free fuzzy matching.
- `src/native/view.zig`: Native SDK canvas widgets and windowed file/diff lists.
- `src/native/theme.zig`: the runtime palette, built-in schemes, and the Rex-style theme derivation.
- `src/native/glass.m`: macOS window glass, tint and appearance, traffic lights, Display P3.
- `src/native/motion.zig`: the pane easing curve.
- `src/native/settings-icons/`: Settings section icons (SVG sources, rendered by `scripts/render-settings-icons.mjs`).
- `src/native/git.zig`: read-only Git subprocesses, bounded concurrency and patch size.
- `src/native/patch.zig`: unified patch parsing and aligned split rows.
- `src/native/icons/`: Pierre vectors embedded into the native binary; Apache-2.0.
- `src/review/`, `src/routes/`, `server/`: React + TypeScript + Vite/TanStack Router version.

The desktop UI uses Native SDK widgets, Metal presentation, and native dialogs;
its manifest excludes the WebView layer. Git reads and parsing happen off the UI
thread. Only visible lines and files are built. Input is limited to 64 MB.
UI smoke tests use isolated patches and launch with `--background` to preserve
the active application's keyboard focus.
The [performance loop](docs/performance.md) documents timing boundaries, budgets,
focused A/B runs, and native rendering verification.
The window's chrome uses macOS visual-effect material behind an alpha-capable
Metal canvas. Floating actions and the command palette use canvas backdrop blur;
the code pane keeps its own opaque surface for readability.

The SDK's Zig source is pinned to the same revision as `@native-sdk/cli` 0.11.0
because that npm release omits a file referenced by its Zig build. `build.zig.zon`
fetches the complete, hash-verified source. TypeScript dependencies remain pinned
in `pnpm-lock.yaml`, including Pierre Diffs, Trees, Highlights, and Icons.
