# Design direction

Patch should feel polished and calm, with a structure that serves review.

Exact values (sizes, radii, timings, colors) live in code, mostly
`src/native/theme.zig` and `src/native/view.zig`. This page is the reasoning
behind them; don't copy numbers here.

## Principles

- **Color belongs to change.** Red and green only ever mean removed and added;
  strings use straw, moves a quiet blue wash. Everything else stays neutral.
- **Quiet until it matters.** Earlier-review state (changed since review,
  base-only lines, commit progress) is a small mark or faint wash, never a
  banner.
- **Each file is a pane:** the window is the ground between them, and hunks
  are headed by their enclosing declaration.
- **Folding never scrolls.** The header you clicked stays where it was; what
  follows closes up or opens out beneath it.

## Preserved behavior

Mouse selection, keyboard review, character copying, range comments, stable
draft anchors, native context menus and viewport-sized rendering are part of
the design. Visual passes must keep them working (`pnpm test:ui`).
