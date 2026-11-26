# Contributing

## Setup

You need [Bun](https://bun.sh) and Rust. `nix develop` provides both.

```sh
bun install
```

## Develop

```sh
bun run dev            # review this repo in the browser, reloading as you edit
bun run install:local  # optional: use your build as your agents' /patch
```

The CLI lives in `cli/` (Rust) and the page in `web/` (Solid 2). See
[AGENTS.md](AGENTS.md) for the rules every change must keep.

## Check

```sh
bun run test      # CLI, server and installer tests
bun run test:web  # page tests
bun run check     # typecheck, lint and format
```

`hk install` runs these checks when you commit and push, and `hk fix` formats.
