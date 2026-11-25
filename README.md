# Patch

`/patch` opens your agent's changes in the browser as a diff. You comment on
lines, press Finish, and the tab closes. The agent gets every comment on stdout as
`file:line`, with the lines it is about. Type `/patch` again once it is done.
Patch never writes to your repository.

```sh
npx -y @phongndo/patchr install
```

Or without Node:

```sh
curl -fsSL https://github.com/phongndo/patch/releases/latest/download/install.sh | sh
```

Either one adds `/patch` to every agent harness you have. Restart open sessions
and type it. `patchr update` updates Patch, `patchr uninstall` removes it, and
`patchr install --dry-run` lists what would be written. Run `install` again
after adding a harness. Patch runs on macOS and Linux, on arm64 and x64.

<details>
<summary>mise, Homebrew and Nix</summary>

```sh
mise use -g github:phongndo/patch && mise exec -- patchr install
brew install phongndo/tap/patchr && "$(brew --prefix)/bin/patchr" install
nix profile add github:phongndo/patch && ~/.nix-profile/bin/patchr install
```

Their upgrades reach your harnesses too, with a mise from October 2026 or later:
after one, the next review updates the files Patch wrote, unless you edited
them. mise takes a release as the latest once it's a day old; name a newer
version, as in `github:phongndo/patch@0.1.0`, to get it sooner. For one version
with Nix, use its tag: `github:phongndo/patch/v0.1.0`.

</details>

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
comment, finish, and the next `/patch` starts empty. Finishing with no comments
tells the agent the review passed; closing the tab ends it without saying so.
Comments live in the tab: a reload keeps them, closing with any unsent asks
first, and if Patch is cut off (an agent's timeout) the tab can still copy them.
A tab that sleeps, is suspended or loses its connection doesn't end the review,
and `/patch` opens it again if it is gone. Feedback the agent's harness
refuses is kept in `~/.local/state/patch/unsent`, and its path is shown.

⌘K opens the command palette, which has every command, file, comment and
setting, and ⌘O chooses what to review: ← → switch its tabs and ⇧↵ starts a run
of commits. ⌘/ comments on the selected lines or the line under the pointer, a
file's header on the whole file, and the Comments list adds a global one. ⌃J
and ⌃K step through changes, ⌃N and ⌃P through comments and ⌥↓ and ⌥↑ through
files, ⌘⇧V marks the file viewed and ⌘↵ finishes. Off a Mac the motions are on
Alt. Settings › Shortcuts lists them all; any command can be given a key.

Settings (⌘, or the palette) cover themes, fonts and sizes, layout, the diff,
and every keyboard shortcut. They are kept in `~/.config/patch/settings.json`
and apply to every review.

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

`nix develop` has Bun and Rust; run `bun install` once.

| Command                 | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `bun run dev`           | Review this repo with the working copy, live       |
| `bun run build`         | Compile `cli/target/release/patchr`                |
| `bun run install:local` | Build, then `patchr install` that                  |
| `bun run test`          | Rust, server and installer tests                   |
| `bun run test:web`      | The page's tests                                   |
| `bun run check`         | tsrs, oxlint, oxfmt, rustfmt and Clippy            |
| `hk install`            | Check commits and pushes; `hk fix` formats         |
| `bun run bump 0.2.0`    | Set the version, for `gh workflow run release.yml` |

The CLI is `cli/` (Rust). The page is `web/`: Solid 2,
[Pierre](https://pierre.computer) Diffs, Trees and Icons, UI SDK for the
popover and segmented controls, and TanStack Hotkeys.
