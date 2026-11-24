# Patch

`/patch` opens your agent's changes in the browser as a diff. You comment on
lines, press Send, and the tab closes. The agent gets every comment on stdout as
`file:line`, with the lines it is about. Patch never writes to your repository.

```sh
nix develop                         # Bun and Rust, pinned in flake.nix
bun install
bun run build                       # cli/target/release/patchr: one 5 MB binary with the page inside
cli/target/release/patchr install   # adds /patch to every harness it finds, and patchr to ~/.local/bin
```

`patchr install --dry-run` lists what it would write; `patchr uninstall` removes it.

| Harness       | Type     | Installed as                                |
| ------------- | -------- | ------------------------------------------- |
| Claude Code   | `/patch` | `~/.claude/skills/patch/SKILL.md`           |
| Pi            | `/patch` | `~/.pi/agent/prompts/patch.md`              |
| OpenCode      | `/patch` | `~/.config/opencode/commands/patch.md`      |
| Gemini CLI    | `/patch` | `~/.gemini/commands/patch.toml`             |
| Cursor, Droid | `/patch` | `~/.cursor/commands`, `~/.factory/commands` |
| Codex, Amp    | `$patch` | `~/.agents/skills/patch/SKILL.md`           |

Codex's default sandbox blocks the local port Patch serves on; allow the
command to escalate, or run Codex with a sandbox that permits loopback.

`patchr review [dir] [--base <ref>] [--uncommitted | --staged] [--remote | --local]`
is what the command runs. By default it shows what a pull request would: the branch since
it left its base, plus uncommitted and untracked files. A review is one pass:
comment, send, and the next `/patch` starts fresh. A draft only carries comments
over a run that was cut off (an agent's timeout), for 12 hours.

Settings (⌘, or the gear at the bottom of the sidebar) cover themes (Pierre
Highlights' 75, for light and dark), fonts and sizes, layout, the diff, and
every keyboard shortcut. They are kept in `~/.config/patch/settings.json` and
apply to every review.

## Remote review

Over SSH, or with `--remote`, Patch serves the page on the machine's Tailscale
address (the first free port from 8766) behind a link that holds a one-time
secret, and prints that link instead of opening a browser. Open it on your
laptop or phone; the agent on the remote machine gets the feedback. `--local`
keeps the page on 127.0.0.1 for `ssh -L` forwarding instead.

## Development

| Command         | Purpose                                         |
| --------------- | ----------------------------------------------- |
| `bun run dev`   | Rebuild the page on change and review this repo |
| `bun run build` | Compile `dist/patchr`                           |
| `bun test src`  | Git, feedback, server and installer tests       |
| `bun run check` | tsrs, oxlint and oxfmt                          |

The server is `src/` (Bun, no dependencies). The page is `web/`: Solid 2,
[Pierre](https://pierre.computer) Diffs, Trees and Icons, UI SDK for the
popover and segmented controls, and TanStack Hotkeys.
