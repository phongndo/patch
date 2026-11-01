# Patch design direction

Patch should feel as if Superlogical had built a code-review tool: the polish and
aesthetic of Rex, with a structure that serves review rather than a terminal.

## Reference

Rex Beta 0.1.0 (1696). Its design tokens ship in the app bundle
(`SuperUI_SuperDesignTokens.bundle/themes.json`, the `static-noir` theme, and
`MaterialStyles-*.json`); geometry was measured from window captures. Patch
takes values from those sources rather than approximating them.

## Surfaces

- A dark tinted window holds the file rail and the review. The review has no
  pane of its own: its title strip and the ground between files are the
  window itself, and each file is its own rounded pane on it (radius
  10, 6 points apart, 8 points from the window's edge), as Rex stacks its
  splits.
- The window keeps a plain titled frame (macOS rounds toolbar windows more
  steeply) and seats the traffic lights at Rex's 25 × 25 points.
- The canvas is tagged Display P3, so static-noir's P3 values render as Rex does:
  success `(167, 208, 141)`, danger `(255, 58, 48)`, the palette's red selection
  `(199, 12, 8)`, and the success/danger containers behind changed lines.
- Content dims when Patch is in the background, matching Rex's inactive window.

## Appearance

- Colors are a runtime palette (`src/native/theme.zig`). Noir carries the values
  measured from Rex's static-noir; every other theme is derived the way Rex
  derives its own: each surface and text tier is a fixed mix of the background
  toward the foreground, by appearance, and syntax uses the theme's ANSI colors.
- Built-in themes: Noir, Nord, Gruvbox, Tokyo Night, Catppuccin Mocha and Latte,
  Rosé Pine and Dawn, Solarized Dark and Light, Dracula, and Paper.
- Panes are Solid or Glass. Glass follows Rex's Modern material: the theme
  ground at about half strength over the window's blur, with a faint edge.
- Background, Text, Accent, Added and Removed can be set over any theme in
  Settings › Appearance; an empty field keeps the theme's own color.

## Structure for review

- The title band carries the rail toggle beside the traffic lights and the
  review's view controls (split or unified, notes, commands) right-aligned to
  the rail's edge, all 28-point controls; when the rail narrows, the extras fold
  into a "…" menu, and as the rail closes they ease back beside the toggle.
- The rail lists the repository and its reload at the top, directories as Rex's
  small medium-weight group headers, files as flat capsule rows on a 32-point
  rhythm, and the comparison control at its foot: Working, Staged, and the
  checked-out branch. In a narrow rail it becomes one capsule with a menu.
- The branch segment opens a picker in the palette's language: Base and Head
  sides with a swap, a filter, branches newest first, keycaps at the foot.
- Panes resize from the gaps between them, within Rex's measured range, and
  ease open and closed (240 ms, Core Animation's default curve) with a real
  layout every frame.
- Files fold to their headers, a short pane each (22 points of the row's 24,
  so folded files read as a list of full rows); reviewed files fold as they
  are marked, and generated or whitespace-only files open folded, the header
  saying which in the tertiary ink. Folding or unfolding never scrolls: the
  file's header stays where it was on screen and what follows closes up or
  opens out beneath it. The file being read pins its header at the top of the
  review as a 24-point slice of its own pane, in the pane's color, so the
  header reads as the pane's rounded top and folds from anywhere; the status
  is the same at the foot, closing the pane it cuts (or, past the last file,
  a short pane of its own). No row draws under either, so glass panes stay
  even.
- What an earlier review says is quiet until it matters: a changed-since-review
  file carries an amber mark in the rail and an amber label on its header,
  and the strip above the review offers to show only those changes. Lines
  there that the base brought in keep only a faint wash. In a branch, the
  repository row's quiet second word becomes the commit count (the branch
  is already named by the comparison control), opening the list of commits,
  each marked reviewed, partly reviewed, or changed since review.

## The diff

Color belongs to change. Each file pane is titled by the file's name, as a Rex
split is by its command; inside it, each hunk is headed by its enclosing
declaration. Changed lines tint
their gutter numbers, paired edits mark the changed run inside the line, and
code uses the theme's ANSI palette with strings in straw so green only ever
means "added". Long lines pan sideways together, and the status pill reports
the column the visible code starts at. The pill carries the cursor's line, the
find field and its matches, a pending key, or a pan; with nothing to say it
shows only while a pane runs past the foot, to close it.

## Notes

The notes pane lists every note in the review, grouped by file in review order;
a file's name jumps to it and a note to its line. Noted lines carry accent line
numbers in the diff.

## Floating surfaces

The command palette follows Rex's: 330 points wide, 75 points from the top, a
capsule search field, 28-point rows with the red selection, one shortcut per
row, and keycap hints at its foot. Notices float as a frosted capsule at the
foot of the review. Settings is its own window, laid out like Rex's, with
gradient squircle section icons.

## Preserved behavior

Mouse selection, keyboard review, character copying, range comments, stable
draft anchors, native context menus and viewport-sized rendering are part of
the design; visual passes must keep them working (`pnpm test:ui`).
