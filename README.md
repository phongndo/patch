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

A branch can be reviewed whole or one commit at a time. Beside the repository's
name, where the checked-out branch otherwise shows, the commit count opens the
list of commits with how far each one's review has come; **]C** / **[C** step
through them, and a commit under review is titled by its subject. A commit opens with its message, which takes notes
like any file. A merge shows only what its author changed beyond Git's own
merge (`--remerge-diff`), so a clean merge of the base is just its message.
Reviewing every commit counts in the whole-branch view too: a file is reviewed
there once each commit's change to it is.

Each file is its own pane, titled by its name, as Rex stacks its splits; hunks
share the pane, each headed by the declaration it sits in. Patch gives Git's
function-header drivers to C, C++, Objective-C, Rust, Go, Python and other
languages Git knows, plus its own for Zig, so a header names the function rather
than a `goto` label, an access specifier, or the struct around a method; a
repository's own `.gitattributes` and your global attributes still win. Code is
highlighted for C-family languages (C, C++, CUDA, Objective-C, Java, Kotlin,
Swift, C#, shaders, TableGen), Zig, Rust, Go, TypeScript and JavaScript, Python,
shell, SQL, YAML, JSON, CSS, HTML and Markdown; a comment or string that spans
lines keeps its color, including one a hunk opens inside. Scroll sideways
to pan every line of a long diff together; the status pill at the foot shows
the column the visible code starts at. The file being read pins its header
at the top as a matching pill, so a long file can be folded from anywhere in
it, and a pane cut by either edge still ends round.

Click a line number to leave a note. Drag through line numbers to select a range,
or drag through code for native character selection. Shift-click extends a range;
the floating actions let you comment or copy. Right-click code for line and
selection actions. Ranges stay on their original file and side. Use the comment
icon beside a file for a file note. Check off files as you review them; a reviewed
file folds to its header, and clicking a header folds or unfolds it, leaving the
header where it is on screen. Lockfiles and paths marked `linguist-generated`
open folded, labelled Generated. The notes
panel opens on demand and lists every note in the review, grouped by file; click
one to jump to its line. Noted lines show their line numbers in the accent color. Import patches and copy/export Markdown from the command
palette. Standard clipboard commands work in code and editors.

Settings (**Patch › Settings…**, **⌘,**) opens in its own window: folding of
reviewed and generated files, diff layout, the comparison Patch opens with,
ignoring whitespace, the diff algorithm (Git's default, histogram or patience),
the default base branch, the file rail and pane widths, appearance, and every
keyboard shortcut. **Toggle ignore whitespace** is also in the command palette;
a file whose only changes were whitespace stays listed, folded and marked
Whitespace only, so its review state stays with it. Appearance offers
twelve themes (Noir, Nord, Gruvbox, Tokyo Night, Catppuccin Mocha and Latte,
Rosé Pine and Dawn, Solarized Dark and Light, Dracula, Paper), solid or glass
panes, and your own Background, Text, Accent, Added and Removed colors over any
theme. The theme palettes come from those open-source projects (MIT).

## Reviewing again

Patch remembers what you reviewed by content: a file's change, its blobs on
both sides and the change itself (its removed and added lines, whitespace
aside, as `git patch-id` sees one). When an agent edits a few files and you
refresh, everything else stays reviewed. A file reviewed in another version is
marked changed since review, and **Toggle changes since review** (or the button
above the review) shows only what changed since the version you reviewed;
reviewed files fold away. Where the base moved too, the lines it brought in
keep only a faint wash. The same change on another base, after a rebase, stays
reviewed and says so.

Notes stay with the comparison they were left in and follow their lines as
files change. A note whose lines changed becomes outdated: it moves to the
nearest line and quotes what it was left on. Resolve a note once it is dealt
with; exports leave resolved notes out, quote outdated ones, and group a
branch's notes by commit. After a rebase or amend, `git range-diff` pairs the
new commits with the ones you reviewed, so a commit whose change is unchanged
stays reviewed and its notes move with it; one that was edited shows its
changes since review.

To diff against versions that may never have been committed, Patch keeps every
version it showed you in an object store of its own, beside your progress
under `~/Library/Application Support/computer.patch.app/`, and never writes to
the repository: Git writes there with only Patch's store in view, and reads
with the repository's objects behind it. Progress saved by earlier versions of
Patch is brought in the first time each comparison opens. Empty drafts are not
saved.

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
| `]C` / `[C`            | Next / previous commit of a branch                  |
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
- `src/native/syntax.zig`: languages by extension and the lexer state each line starts in.
- `src/native/theme.zig`: the runtime palette, built-in schemes, and the Rex-style theme derivation.
- `src/native/glass.m`: macOS window glass, tint and appearance, traffic lights, Display P3.
- `src/native/motion.zig`: the pane easing curve.
- `src/native/settings-icons/`: Settings section icons (SVG sources, rendered by `scripts/render-settings-icons.mjs`).
- `assets/icon.svg`: the app icon, full-bleed so packaging insets and masks it to the macOS grid;
  `public/favicon.svg` is the same art with its corners rounded. Both stay in the Native SDK's
  icon dialect: solid `#rrggbb` paints only, no gradients or opacity.
- `src/native/git.zig`: read-only Git subprocesses, bounded concurrency and patch size,
  diff options, the attributes file, `linguist-generated` lookups, commits,
  `range-diff`, and Patch's own object store (snapshots, trees, diffs between them).
- `src/native/patch.zig`: unified patch parsing, aligned split rows, blob ids,
  change hashes, and mapping lines across a diff.
- `src/native/review.zig`: the review store: records of reviewed changes,
  notes and their anchors, and the rules matching them to what is shown.
- `src/native/history.zig`: brings the store to a comparison just read
  (statuses, changes since review, notes moved to their lines, commit progress).
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
