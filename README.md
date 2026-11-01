# Patch

A native macOS diff reviewer built with [Vercel Native SDK](https://github.com/vercel-labs/native).
It never writes to your repository.

```sh
nix develop
pnpm install
pnpm dev --repo /path/to/repository
```

Press **⌘K** (or **?**) for every command and its shortcut. **⌘,** opens
Settings, which also lists every shortcut. [Reviewing](docs/reviewing.md) covers
what the UI doesn't show: how Patch remembers what you reviewed, and where it
keeps it.

## Development

| Command                  | Purpose                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `pnpm dev [--repo path]` | Build and run with UI automation enabled                         |
| `pnpm build`             | Compile to `zig-out/bin/patch`                                   |
| `pnpm package`           | Build an ad-hoc signed `zig-out/Patch.app`                       |
| `pnpm test`              | Unit and Git integration tests                                   |
| `pnpm test:ui`           | Native keyboard, mouse and large-diff checks                     |
| `pnpm bench:native`      | Startup and interaction latency ([details](docs/performance.md)) |
| `pnpm check`             | Typecheck, lint and format check                                 |

Outside the dev shell, prefix commands with `nix develop -c`. The flake pins
Node, pnpm and Zig; the macOS build also needs the Xcode command-line tools.
`package.json` and `zig build --help` list everything else.

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
