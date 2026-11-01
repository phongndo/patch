# Performance loop

Run from the dev shell with no other build or UI test running:

```sh
pnpm bench:native            # measure
pnpm bench:native --assert   # fail on a missed budget
```

The benchmark launches disposable instances with `--background`, drives real
input, and writes `zig-out/performance/latest.json`. Save a copy before a
change and compare the same cases after. Keep a change only when the gain
survives repetition and `pnpm test:ui` still passes. The budgets and every
flag are in `scripts/benchmark-native.mjs`.

```sh
# A/B against an older binary
node scripts/benchmark-native.mjs --binary /tmp/patch-before --output zig-out/performance/before.json

# A real diff from disk
node scripts/benchmark-native.mjs --patch-file /path/to/change.diff --case patch_file --all-interactions

# Packaged app through Launch Services
node scripts/benchmark-native.mjs --launch-services --production --startup-only --binary zig-out/Patch.app/Contents/MacOS/patch --assert

# Correctness, separate from timing: dirty updates vs full redraws, pixel by pixel
node scripts/benchmark-native.mjs --case none --all-interactions --verify-rendering
```

Don't view the SDK's screenshots directly; see [AGENTS.md](../AGENTS.md).

## Reading the numbers

- `input_ms` (SDK input timestamp to presentation) is interaction latency.
- `driver_ms` is the automation round trip. Never report it as latency.
- `observed_ready_ms` includes snapshot polling, so it is an upper bound.
- Subprocess launches skip Launch Services and read about 80 ms faster than
  opening the app.

Startup is at the platform floor: in October 2026 an empty AppKit bundle
opened through Launch Services as fast as Patch did.

## SDK workarounds

`build.zig` patches build-local copies of the pinned SDK (never `node_modules`
or `zig-pkg`) and fails if an anchor moves. Each patch has a `-D` option to
turn it off for A/B runs; `zig build --help` lists them, and the comments in
`build.zig` explain each one. `zig build test-native-host` checks them against
the original drawing.

## Tried and discarded

So nobody retries these without a new idea:

- GPU compositor, text layout caching, transformed raster caching,
  transparent-paint skipping, syntax-run batching: no repeatable end-to-end win.
- Splitting the rounded pane fill into interior plus edge bands: faster, but
  CoreGraphics antialiases a clipped straight edge differently (off by one
  level).
- Moving rasters on scroll instead of redrawing: correct, but scroll latency
  didn't change.
- Not tried yet: scrolling by copying retained pixels.
