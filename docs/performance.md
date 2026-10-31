# Native performance loop

Run from the project dev shell, with no other build or UI test running:

```sh
pnpm bench:native
pnpm bench:native --assert
```

The benchmark launches disposable instances with `--background`, drives real
native widget input, and terminates only its own processes. It creates patches
with 30 lines, 50,000 lines, and 250 changed files, plus a real Git working tree
with 100 changed files. It measures scrolling, keyboard motions, palette opening,
typing and navigation, review toggles, note typing, search, file navigation and
filtering, gutter selection, and native character selection.

Results are written to `zig-out/performance/latest.json`. Keep a copy before each
change and compare the same cases afterward. Retain a change only when the gain
survives repetition and the relevant interaction checks still pass.

## Measurement boundaries

- `visible_ms`: subprocess spawn to the SDK's window-shown milestone.
- `review_visible_ms`: that first visible frame, when the app's review-ready
  milestone precedes construction of the frame; otherwise the first presented
  review frame. Missing milestones stay null and fail the startup gate.
- `observed_ready_ms`: the first automation snapshot containing a nonblank
  review. Snapshot publication and polling add delay; this is an upper bound.
- `input_ms`: SDK input timestamp to the frame's presentation timestamp.
- `driver_ms`: the automation command's complete IPC round trip. Do not present
  this as interaction latency.
- Frame profiles attribute work to rebuild, layout, reconciliation, planning,
  encoding, and native drawing. Their rolling samples can include idle frames.

The default is one warmup and five measured launches per case. Warmup results
are retained under `preflight`, including any first-execution OS verification
delay. These are warm-cache background subprocess launches on this Mac; they
do not certify reboot-cold Finder startup or a measured Dock animation.

Subprocess launches skip Launch Services, so they read about 80 ms faster than
opening the app. Measured through `--launch-services` on the packaged app (M4
Max, October 2026), the window and first review appear in 170–195 ms. About
72 ms of that passes before `main`, then AppKit setup takes about 47 ms and window
creation about 34 ms. An empty AppKit bundle that only creates one window takes
185–192 ms through the same `open` path, so startup is at the platform floor.
Unused frameworks linked by the SDK cost about 0.3 ms before `main`.

Interaction budgets assume 60 Hz. This Mac's built-in display runs at 120 Hz,
where one frame is 8.3 ms.

## Target budgets and focused runs

`--assert` requires p90 window/review visibility within 250 ms, snapshot readiness
within 350 ms, scrolling and ordinary input within 16.7 ms, and palette and panel
changes within 33.4 ms. Review toggles retain the 16.7 ms budget.
The budget remains red while an interaction misses its target.

```sh
# Reuse an existing automation-enabled binary, including an A/B copy.
node scripts/benchmark-native.mjs --binary /tmp/patch-before --output zig-out/performance/before.json
node scripts/benchmark-native.mjs --case none --all-interactions --output zig-out/performance/after.json
node scripts/benchmark-native.mjs --case many_files --files 36 --runs 1 --startup-only

# A real diff from disk: startup as the `patch_file` case, and interactions on it.
node scripts/benchmark-native.mjs --patch-file /path/to/change.diff --case patch_file --all-interactions

# Production startup uses presentation milestones without automation snapshots.
node scripts/benchmark-native.mjs --production --startup-only --binary zig-out/Patch.app/Contents/MacOS/patch --assert

# Include macOS Launch Services by opening a new, background bundle instance.
node scripts/benchmark-native.mjs --launch-services --production --startup-only --binary zig-out/Patch.app/Contents/MacOS/patch --assert

# Correctness verification is deliberately separate from timed runs.
node scripts/benchmark-native.mjs --case none --all-interactions --verify-rendering

# Attribution only; these runs have extra overhead.
node scripts/benchmark-native.mjs --case none --sample
node scripts/benchmark-native.mjs --case none --draw-trace
```

Never view the SDK's uncompressed screenshots directly. Follow [AGENTS.md](../AGENTS.md)
and recompress a needed capture with `sips` before inspecting it.

## Implementation constraints

Git reading/parsing starts alongside AppKit initialization. Completed work is
adopted before building the first view; unfinished work stays asynchronous.
Code rows use syntax-highlighted native paragraphs. Printable ASCII lines with
a conservative fit bound avoid horizontal scroll containers; long lines, tabs,
and Unicode retain them. The SDK's general code component handles unusually long
lines. Empty split cells and ordinary rows avoid unused layers, and unchanged
cells inherit their opaque pane background. The file
and diff lists remain virtualized within the SDK's fixed 1,024-widget budget.
The native smoke fixture includes 38 files to catch the former widget overflow,
and checks horizontal scrolling on a long line. Keyboard and mouse checks cover
native character selection, exact copies, context actions, and draft anchors.
Tests and benchmarks isolate saved progress with `PATCH_STATE_DIR`; normal
launches use the platform application data directory.

The command palette frosts its own surface instead of blurring the full window.
The macOS window keeps its native visual-effect material and transparent Metal
surface. The code pane remains opaque for readability.

`build.zig` generates a build-local overlay of the pinned macOS SDK host. It never
modifies `node_modules` or `zig-pkg`, and fails if an expected source anchor changes.
Each workaround has an explicit build option for A/B measurements:
`-Dcanonical-transforms=false`, `-Dopaque-blur=false`, and
`-Dcoretext-lines=false`, and `-Dretain-identical-commands=false`. Transform
canonicalization accepts only near-identity matrices whose worst displacement is
at most 1/1024 point over the whole command extent; genuine icon transforms remain
intact. `zig build test-native-host` checks that bound, large-coordinate cases,
real transforms, and nonfinite inputs. Opaque blur results use an equivalent row
copy. Single printable ASCII runs use CoreText only when they fit; wrapping,
controls, Unicode, and tight height constraints keep the original TextKit path.
The host tests compare 576 complete bitmaps against that original draw sequence,
including fractional origins, alpha, fonts, wrapping, and clipping.

An upsert with a decoded dictionary identical to the retained command keeps its
existing raster. This avoids rebuilding hundreds of unchanged text rasters when
upstream float differences disappear during decoding. Every dictionary field
participates in equality, so changed commands still invalidate their rasters.

`build.zig` also points the SDK's Zig module at a build-local copy of its
sources with a patched frame planner (`-Dblur-damage-footprint=false` turns it
off). The pinned planner repaints the whole surface whenever damage reaches a
backdrop blur's read footprint, so every keystroke in the frosted palette
redrew the full window. The overlay widens the scissor to the reached
footprints instead; inside it the list replays in draw order, so each blur
samples the backdrop a full repaint would give it. A widened area over half the
surface keeps the full repaint. In three interleaved A/B runs, palette typing
fell from 23 to 9 ms median, palette navigation from 25 to 11 ms, and the
selection popover's p90 from 16 to 11 ms, with other interactions unchanged.
The full verifier passes with no mismatches.

The overlay first allowed any widened size. A scissor whose edge crossed the
code pane's rounded corner then differed from a full redraw by one alpha level
in one pixel: that oversized fill is drawn directly under the scissor clip, not
blitted from the raster cache. The half-surface limit avoids that case in the
current flows. The underlying risk applies to any direct-drawn curve crossed
by a scissor edge, including the SDK's own incremental updates.

Incremental rendering verification compares native dirty updates against full
redraws, pixel by pixel. It runs separately from latency measurements.
The experimental GPU compositor, text layout caching, transformed raster caching,
transparent-paint skipping, and syntax-run batching did not produce repeatable
end-to-end wins and were discarded.

Three later experiments were also discarded (October 2026, measured on the
1,009,257-line Bun Rust port diff):

- Splitting the large rounded pane fill into a plain interior and four clipped
  edge bands was 2.7 times faster, but 712 of 2,400 byte comparisons against the
  original fill differed by one level. CoreGraphics antialiases a straight edge
  differently under a clip, even a pixel-aligned one.
- Reusing a command's raster when an upsert only moves it. Scroll offsets are
  whole points (120, 240, 360), but f32 layout noise of about 1/20,000 point
  made each move slightly fractional, so only about 20 of 260 rasters per scroll
  frame qualified at first. Storing any move within 1/1024 point of whole
  device pixels as the exact shift let about 156 of 262 rasters per frame move
  instead of redrawing. All 5,000+ moved rasters matched fresh ones byte for byte,
  and the incremental verifier passed. Traced drawing fell about 0.9 ms per
  frame, but untraced host drawing did not change. Scroll latency was 22.8 ms
  before and 23.1 ms after on the Bun diff, and 15.7 ms before and 16.2 ms after
  on the 50,000-line fixture (medians of three interleaved runs).
- Planning costs about 2.1 ms per scroll frame: render plan 0.69 ms, resource and
  effect plans 0.61 ms, damage 0.40 ms, text layout 0.28 ms. Only the resource and
  effect plans looked skippable, and they may drive image uploads.

Scrolling by copying retained pixels has not been tried. Moves are already
whole device pixels once noise is removed, so offsets need no rounding. The
planner would have to prove that only translated content changed inside the
viewport.
