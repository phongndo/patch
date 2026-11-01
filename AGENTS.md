# Agent notes

## Screenshots

Native SDK automation writes uncompressed PNGs to
`.zig-cache/native-sdk-automation/` (a 1708×1063 screenshot is about 7 MB).
Every image you view stays in the conversation and is resent with each request,
and requests over about 30 MB start failing with `{"detail":"Bad Request"}`.

Never view those files directly. Recompress first, then view the copy:

```sh
sips -s format png .zig-cache/native-sdk-automation/screenshot-main-canvas.png --out /tmp/patch-shot.png
```

That brings a screenshot to about 300 KB. Only look at a screenshot when you
need to see the UI, not to confirm that a build ran.

## Docs

Keep docs short and only for what the code and the app can't tell you.

- Don't describe UI features, shortcuts or settings in Markdown. The command
  palette and Settings list them from the code, so they can't go stale.
- Don't copy values (sizes, colors, budgets, flags, file lists) into docs.
  Point at the file that holds them.
- Explain a module in a `//!` comment at the top of the file, and a
  workaround in a comment beside it, not in `docs/`.
- Don't update docs as a side effect of a change. Edit a doc only when the
  change makes something in it wrong.
- Experiment logs belong in commit messages, not docs. `docs/performance.md`
  keeps one line per discarded idea so it isn't retried.
