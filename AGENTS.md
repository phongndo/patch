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
