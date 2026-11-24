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

| Harness       | Type     | Installed as                                           |
| ------------- | -------- | ------------------------------------------------------ |
| Claude Code   | `/patch` | a mod and its fallback skill, `~/.claude/skills/patch` |
| Codex         | `$patch` | a hook in `~/.codex/hooks.json`, and Amp's skill       |
| Pi            | `/patch` | `~/.pi/agent/extensions/patch.ts`                      |
| OpenCode 2    | `/patch` | `~/.config/opencode/plugins/patch.ts`                  |
| Gemini CLI    | `/patch` | `~/.gemini/commands/patch.toml`                        |
| Cursor, Droid | `/patch` | `~/.cursor/commands`, `~/.factory/commands`            |
| Amp           | `$patch` | `~/.agents/skills/patch/SKILL.md`                      |

In the first four the command opens the review itself: no model runs until you
send feedback, which arrives as your next message, and the session stays free
meanwhile. In the others the model waits on the command.

Codex asks you to trust the hook once. Until you do, `$patch` is the skill, and
Codex's default sandbox blocks the local port it needs; allow it to escalate.

`patchr review [dir] [--base <ref>] [--uncommitted | --staged] [--remote | --local]`
is what the command runs. By default it shows what a pull request would: the branch since
it left its base, plus uncommitted and untracked files. A review is one pass:
comment, send, and the next `/patch` starts empty. Comments live in the tab: a
reload keeps them, closing with any unsent asks first, and if Patch is cut off
(an agent's timeout) the tab can still copy them. Feedback the agent's harness
refuses is kept in `~/.local/state/patch/unsent`, and its path is shown.

⌘K opens the command palette, which has every command, file, comment and
setting. ⌘/ comments on the selected lines or the line under the pointer, ⌃J and
⌃K step through changes, ⌃N and ⌃P through comments and ⌥↓ and ⌥↑ through files,
⌘⇧V marks the file viewed and ⌘↵ finishes. Off a Mac the motions are on Alt. Settings › Shortcuts lists them all; any command can be given a key.

Settings (⌘, or the gear at the bottom of the sidebar) cover themes, fonts and
sizes, layout, the diff, and every keyboard shortcut. They are kept in
`~/.config/patch/settings.json` and apply to every review.

There are 416 themes for light and dark: Pierre's own and its other built-ins,
the most-downloaded MIT and Apache-licensed theme extensions from Zed's
registry (Catppuccin, Tokyo Night, GitHub, Dracula, Nord, Rosé Pine, Kanagawa,
Everforest, Gruvbox Material and more), and 251 Base16 schemes behind a switch.
Community themes load only when chosen. `bun scripts/fetch-themes.ts` refreshes
them into `web/themes/community`, with their sources and licenses in
`NOTICE.md` there, and `bun scripts/themes.ts` rebuilds the list.

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
