# Reviewing

How review state works. The command palette (**⌘K**) is the reference for
everything you can do; this page covers behavior you can't see from it.

## Review state follows content

A reviewed file is remembered by its change (the blobs on both sides, and the
change itself as `git patch-id` sees it), not by when or where you saw it. So:

- After an agent edits a few files and you refresh, everything else stays
  reviewed.
- A file reviewed hunk by hunk reopens only the hunks that changed.
- A file reviewed in an earlier version is marked _changed since review_;
  **Toggle changes since review** shows only what changed since then.
- The same change on a new base, after a rebase, stays reviewed.
- In a branch, `git range-diff` pairs rewritten commits with the ones you
  reviewed, so an unchanged commit stays reviewed and its notes move with it.
- A merge commit shows only what its author changed beyond Git's own merge
  (`--remerge-diff`).

## Notes

Notes belong to the comparison they were left in and follow their lines as
files change. When a note's lines change, it becomes _outdated_: it moves to
the nearest line and quotes what it was left on. Exports leave resolved notes
out and quote outdated ones.

## Storage

Progress, notes, and every version Patch has shown you live under
`~/Library/Application Support/computer.patch.app/` on macOS,
`~/.local/share/computer.patch.app/` (or `$XDG_DATA_HOME`) on Linux, and
`%LOCALAPPDATA%\computer.patch.app\Data\` on Windows (`PATCH_STATE_DIR`
overrides it). Patch keeps its own Git object store there so it can diff
against versions that were never committed; it never writes to the
repository.
