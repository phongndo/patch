# Agent notes

- Patch must never write to the reviewed repository: Git commands are read-only
  and run with `GIT_OPTIONAL_LOCKS=0`; untracked files are diffed through a
  throwaway index (`cli/src/git.rs`).
- The CLI is Rust (`cli/`). `src/protocol.ts` and `cli/src/protocol.rs` are the
  same JSON shapes; change both, and run `tests/contract.test.ts` against the
  binary.
- In remote mode every request needs the session cookie and an exact Host; keep
  both checks when adding routes.
- stdout of `patchr review` is the agent's input. Everything for humans goes to
  stderr.
- The page is Solid 2. Read `node_modules/solid-js/CHEATSHEET.md` before
  changing it; 1.x patterns (single-argument `createEffect`, `onMount`,
  `classList`, `produce`) are gone.
- Parsed diffs stay out of Solid stores: the highlighter workers cannot clone
  store proxies.
- Keep docs short and only for what the code can't tell you. Explain a module in
  a `//!` comment at its top, not in Markdown.
- Before using UI SDK, follow the `ui-sdk` skill and read
  `node_modules/@ui-sdk/solid/docs/llms.txt`. The page has no agent bridge on
  purpose: an agent must not approve its own review.
