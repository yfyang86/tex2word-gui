# Sprint 07 — Workspace UX polish

## Goal

Make the workspace easier to read and navigate. An audit (screenshots of every
screen at desktop and narrow widths) found:

- one icon for every file type, and a red dot on the main file that read like
  "unsaved";
- no outline of the open file, only of the whole document (Structure tab);
- no line numbers;
- a squeezed editor at narrow widths;
- unlabelled report settings and a wrapping assistant header;
- broken-image icons for missing figures;
- no dark theme and no list of shortcuts;
- no Ctrl/Cmd+S.

## What changed

**File tree** (`icons.js`)
- A glyph and colour per file type: LaTeX, BibTeX, package/class, Markdown,
  TikZ, image, PDF/EPS, data, text; folders open/closed.
- An explicit `MAIN` badge on the document root (tooltip says what it means)
  and an amber unsaved dot on the edited file.
- The editor header shows the file icon, the folder part of the path dimmed
  and the same badge.

**File outline** (`outline.js`, left panel, foldable and remembered)
- Lists the open file's `\part` … `\subparagraph`, `\title`, `abstract`,
  floats (with their caption and `\label`), equations, theorem-like
  environments, `\input` / `\include` / `\subfile` / `\import`, `\appendix`
  and the bibliography. Markdown files list their headings.
- Comments and verbatim are skipped; nesting is relative to the file's own top
  heading, so a chapter file starts at depth 0.
- Clicking an item jumps to it (with the line flash); an `\input` item opens
  its file (or shows "missing"). The item the caret is in is highlighted as
  you move.

**Editor** (`ux.js`)
- A line-number gutter that follows soft-wrapped lines. Only changed lines are
  re-measured and only the visible numbers are drawn, so a 3,300-line file
  types as fast as before (≈65 ms per key, the existing highlighter's cost).
  Click a number to select the line.
- A current-line band and highlighted number.
- A status bar: `Ln, Col`, selection size, lines, words (prose only), "Main
  file" / "Previewed via main.tex", file type.
- **Ctrl/Cmd+S** saves the file.

**Theme** (`theme.js`, `tokens.css`)
- Dark palette for every token, following the system by default. A top-bar
  menu offers Light / Dark / System (ticked, with the system's current value),
  remembered per browser and applied before first paint. (The first version
  cycled System → Light → Dark, so on a light computer the first click changed
  nothing visible.)
- Hard-coded colours became tokens (`--on-primary`, `--overlay`, `--sel-bg`,
  …). The TikZ editor opens in the matching scheme.

**Polish**
- **Narrow windows:** the right panel folds below 1100 px and the files panel
  below 820 px, without changing the saved layout. Opening one by hand keeps
  it open.
- **Missing images:** a missing figure in the preview shows a labelled
  placeholder ("Image not found · figures/x.png") instead of a broken image.
- **Report settings:** a foldable "Conversion settings" card with labelled
  fields and a one-line summary when folded.
- **Assistant header:** a single line, with a "no API key" pill and the details
  in the tooltip.
- **Project cards:** relative times ("updated 5 min ago", exact time on hover)
  and an icon and colour per kind (TeX / arXiv / Markdown).
- **Shortcuts:** a keyboard-shortcuts dialog (top-bar button, or `?` when not
  typing).
- **Favicon:** the brand mark as `favicon.svg` plus a 16/32/48 px
  `favicon.ico` (drawn by `scripts/build_favicon.py`), also served at
  `/favicon.ico`, so browsers stop logging a 404.
- **Caching:** the page and `/static/*` are sent with `Cache-Control: no-cache`,
  so a new release's CSS and JS are picked up (a cheap 304 when unchanged).
  The TikZ editor's hashed assets are cached for good.

## Tests

- `tests/js/icons.test.js`: kinds by extension, glyph markup, labels.
- `tests/js/outline.test.js`:
  - every item kind;
  - comments and verbatim;
  - multi-line titles, fragment depth;
  - Markdown;
  - the caret → item lookup;
  - word count;
  - title cleaning.
- `tests/e2e/ux.e2e.js` (7):
  - file icons, main badge, unsaved dot and Ctrl+S saving;
  - outline content, jump, live highlight, live update, opening `\input`,
    folding remembered;
  - gutter numbers with a wrapped line, click-to-select, status bar, scroll
    alignment;
  - the theme menu: one click to dark, the ticked choice, keyboard use,
    persistence, following the system;
  - the `?` dialog, but not while typing;
  - narrow-window folding;
  - settings summary, missing-image placeholder, relative times.
- `tests/test_static.py`: favicon (ICO with several sizes, SVG link) and
  cache headers.
