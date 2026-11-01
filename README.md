# Patch

A native diff reviewer for macOS, Linux and Windows, built with [Vercel Native SDK](https://github.com/vercel-labs/native).
It never writes to your repository.

```sh
nix develop
pnpm install
pnpm dev --repo /path/to/repository
```

Press **⌘K** (or **?**) for every command and its shortcut. **⌘,** opens
Settings, which also lists every shortcut. On Linux and Windows, Ctrl takes
the place of ⌘. [Reviewing](docs/reviewing.md) covers
what the UI doesn't show: how Patch remembers what you reviewed, and where it
keeps it.

## Development

| Command                  | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `pnpm dev [--repo path]` | Build and run with UI automation enabled                          |
| `pnpm build`             | Compile to `zig-out/bin/patch`                                    |
| `pnpm package`           | Build an ad-hoc signed `zig-out/Patch.app`                        |
| `pnpm package:linux`     | Build a Linux install tree in `zig-out/patch-linux`               |
| `pnpm package:windows`   | Cross-build `patch.exe` and its folder in `zig-out/patch-windows` |
| `pnpm test`              | Unit and Git integration tests                                    |
| `pnpm test:ui`           | Native keyboard, mouse and large-diff checks                      |
| `pnpm bench:native`      | Startup and interaction latency ([details](docs/performance.md))  |
| `pnpm check`             | Typecheck, lint and format check                                  |

Outside the dev shell, prefix commands with `nix develop -c`. The flake pins
Node, pnpm and Zig; the macOS build also needs the Xcode command-line tools.
`package.json` and `zig build --help` list everything else.

## Platforms

- **macOS** presents through Metal, with the window's glass and blur.
- **Linux** builds natively; the flake's Linux shell adds GTK 4 and pkg-config,
  and Xvfb and the clipboard tools for `pnpm test:ui` (run it under
  `xvfb-run -a` without a display). Every frame is drawn on the CPU, so the
  window and palettes are opaque, without glass or blur.
- **Windows** cross-compiles from macOS or Linux
  (`zig build -Dtarget=x86_64-windows-gnu`) and presents through Direct2D,
  opaque like Linux. Git must be on `PATH`. It has not been run on Windows yet.

Each Zig module under `src/native/` opens with a comment saying what it is
for. `src/review/`, `src/routes/` and `server/` are the older React reviewer
(`pnpm dev:web`).

- [Design direction](docs/design.md)
- [Performance loop](docs/performance.md)

## Licenses

Pierre icons are Apache-2.0. The theme palettes come from their open-source
projects (MIT). Tree-sitter and its grammars are MIT, except the Elixir and
HCL grammars (Apache-2.0); `src/native/queries/hcl/` comes from Helix
(MPL-2.0).
