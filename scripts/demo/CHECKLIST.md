# What each change should look like

Check each in split and unified (the toggle in the bar, or ⌘\ / Ctrl+\), wrapped and not
(⌃Z on a Mac, Alt+Z elsewhere), light and dark.

## Previews

Before goes over the old lines and after over the new: side by side when split, before above
after when unified. Every preview runs edge to edge, with the 4px change bar, and the shorter
side of a split row fills to the end of the longer one. Nothing is padded between a file's last
row and the next header.

| File                                         | Expect                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `images/logo.png`                            | Before red disc, after blue; 160 × 160 → 192 × 192; transparent corners on the checkerboard                                                                  |
| `images/banner.png`                          | Wide gradients, 600 × 120 → 640 × 140                                                                                                                        |
| `images/hero.png`                            | Added, 1600 × 900 scaled into the frame, one image across the diff                                                                                           |
| `images/tall.png`                            | Added, 120 × 1200 scaled down to fit the frame's height                                                                                                      |
| `images/favicon-16.png`                      | 16 × 16 pixel art, red → green                                                                                                                               |
| `images/photo.jpg`, `images/legacy.bmp`      | JPEG and BMP draw like PNG                                                                                                                                   |
| `images/spinner.gif`                         | Added GIF                                                                                                                                                    |
| `images/old-screenshot.png`                  | Deleted: only the old image, across the diff                                                                                                                 |
| `images/team/avatar.png`                     | Moved, unchanged: one "Renamed" image across the diff                                                                                                        |
| `images/broken.png`                          | No NUL in it, so Git diffs it as text: still previewed, "This image could not be shown…"; its header's `</>` shows the mangled text                          |
| `images/huge.png`                            | Over 32 MB: the same message, quickly; it is never read whole                                                                                                |
| `images/My Logo (v2).png`, `images/café.png` | Spaces, brackets and accents in a name still load                                                                                                            |
| `images/x and b/y.png`                       | Named right, though Git's binary line splits two ways; before and after load                                                                                 |
| `svg/check.svg`                              | Opens as a preview, grey → green; its header's `</>` shows the code, the eye goes back                                                                       |
| `svg/spark.svg`, `svg/viewbox-only.svg`      | Added; the second has no size of its own and draws at 300 × 150                                                                                              |
| `svg/evil.svg`                               | A red circle; no alert, no request to example.com (open the network panel)                                                                                   |
| `svg/old-arrow.svg`, `svg/favorite.svg`      | Deleted; moved unchanged                                                                                                                                     |
| `svg/badge.txt`                              | An SVG renamed to text and changed: its preview, of the old side alone, opens across the diff; a comment on the whole file sits under it                     |
| `svg/illustration.svg`                       | Preview of 60 dots, one changes colour; its code has "More lines" both ways                                                                                  |
| `README.md`, `docs/long.md`, `docs/api.md`   | Open as code; the eye renders before and after                                                                                                               |
| `docs/guide.md`                              | Added: one rendered document across the diff                                                                                                                 |
| `docs/hostile.md`                            | Rendered: no alert, no frame, no form, no style, no request; the tracker shows its alt text; only the web link links                                         |
| `docs/deep.md`                               | Nested past what the renderer can follow: its preview says \"could not be rendered\" at once; its code is there                                              |
| `docs/slow.md`                               | A thousand nested levels, rendered off the page's thread: the page stays responsive while it renders, and a renderer that runs past three seconds is stopped |
| `docs/archive/history.md`                    | Moved unchanged: a header and nothing else                                                                                                                   |

## Code

| File                                                    | Expect                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/resize.ts`                                         | Rewritten whole: no "More lines" row at its end                                                                                                                                                                                                                                                                                               |
| `src/server.ts`                                         | "16 unchanged lines", "123 unchanged lines" and "Rest of the file": one click anywhere on a row opens all of it                                                                                                                                                                                                                               |
| `src/routes.ts`                                         | 2,000 lines, four hunks far apart: each gap has one icon, its count, and at its right the function the next hunk is in (`export function route91(request: Request)`); the row lights as one block and says "· show all", and one click anywhere on it opens the whole gap; "Show whole files" (palette or Settings) unfolds every gap at once |
| `src/ambiguous.ts`                                      | Changed three lines before its end: "More lines" shows, and expanding it finds nothing (a patch cannot tell)                                                                                                                                                                                                                                  |
| `src/no-newline.ts`                                     | "No newline at end of file"                                                                                                                                                                                                                                                                                                                   |
| `src/wide.ts`                                           | Unwrapped, scrolls sideways; wrapped, wraps                                                                                                                                                                                                                                                                                                   |
| `src/legacy.ts`, `src/removed.ts`, `src/new-feature.ts` | Moved; deleted; added                                                                                                                                                                                                                                                                                                                         |
| `src/generated/schema.gen.ts`, `bun.lock`               | Generated: start folded                                                                                                                                                                                                                                                                                                                       |
| `scripts/build.sh`                                      | Only made executable                                                                                                                                                                                                                                                                                                                          |
| `tests/resize.test.ts`                                  | Listed under Tests                                                                                                                                                                                                                                                                                                                            |
| `src/latin1.txt`                                        | Not UTF-8: added, reading `caf�`; the review still loads                                                                                                                                                                                                                                                                                      |
| `data/archive.zip`                                      | Binary, not an image: a header and nothing else                                                                                                                                                                                                                                                                                               |

## Everywhere

- The wheel scrolls the page wherever the pointer is, over images and rendered Markdown too.
- Where a split side has fewer lines, its empty rows are plain, the gutter too: no grey bars.
- With scrollbars always shown (System Settings › Appearance), no empty track under any file.
- A whole-file comment on an image or a preview sits under it; line comments on a file shown as
  its preview move to the comments panel and come back with its code.
