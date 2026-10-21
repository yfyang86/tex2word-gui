# Live editing — three sprints

A block of work on the editing loop: verify the new engine, give the editor
room, make the preview follow the source across files, make it fast, and help
while typing.

| Sprint | Theme | Status |
| --- | --- | --- |
| [01](sprint-01-engine-and-panels.md) | tex2word 1.0.8 verification, e2e harness, collapsible/resizable panels | done |
| [02](sprint-02-sync-and-quick-preview.md) | Multi-file source map, cross-file sync, quick/full preview | done |
| [03](sprint-03-autocomplete.md) | Smart LaTeX autocompletion + reference diagnostics | done |
| [04](sprint-04-tab-and-symbols.md) | Tab completion key map, symbol palette + SVG previews, environments, macros, colours, label names | done |
| [05](sprint-05-table-generator.md) | Visual LaTeX table generator (left panel tool), edit tables in place | done |
| [06](sprint-06-tikz-editor.md) | Embedded TikZ editor (left panel tool), edit pictures in place | done |
| [07](sprint-07-ux-polish.md) | File-type icons, file outline, line numbers + status bar, dark theme, narrow layout, shortcuts | done |

## How it is tested

| Layer | Command | What it covers |
| --- | --- | --- |
| Python | `uv run pytest -q` | source map, instrumentation invisibility, quick ≡ full, API |
| JS unit | `node --test tests/js/*.test.js` | `sync.js`, `complete.js`, `symbols.js`, `tablegen.js`, `tikzedit.js`, `icons.js`, `outline.js` (no browser needed) |
| End-to-end | `NODE_PATH=$(npm root -g) node tests/e2e/run.js` | the real UI in Chromium via Playwright |

The e2e runner boots the app on a throwaway SQLite DB (`TEX2WORD_DB`) using
`.venv/bin/python` (override with `PYTHON=`), and needs `playwright` resolvable
plus a Chromium build (`PW_CHROMIUM=/path/to/chrome` to pick one). Pass a
substring to run one spec: `node tests/e2e/run.js sync`.

## Engine notes (tex2word 1.0.8)

Found while building this; worth reporting upstream. The web app mirrors the
engine's behaviour in each case rather than "fixing" it, so the preview keeps
matching the `.docx`.

1. **Nested `\input` paths resolve relative to the *including* file's folder**,
   not the main file's (as LaTeX does). `sections/a.tex` containing
   `\input{sections/b}` looks for `sections/sections/b.tex` and silently drops
   it. Projects that follow LaTeX's rule lose content.
2. **A `\label` goes to the most recent labelable block anywhere before it.**
   `\caption{\label{tab:x} …}` inside a table attaches `tab:x` to the
   *previous heading*, overwriting that heading's own label.
3. **Citations inside tables, figure captions, theorems and footnote-like
   containers are never formatted** — the citation pass only walks
   paragraphs, headings, quotes and lists, so those show as `[key]`.
4. **A `.bbl` is only used when the project has exactly one.** arXiv
   bundles often ship two (e.g. BERT: `main.bbl` + `lumiere.bbl`), and every
   citation then renders as its raw key.
5. `tex2word/pipeline.py` triggers a `SyntaxWarning: invalid escape sequence '\d'`
   (a docstring that should be raw).

## Follow-ups (not scheduled)

- Run the e2e suite in CI (needs a Playwright/Chromium install step).
- Quick mode re-renders all blocks' HTML (≈50 ms on a 100-section paper);
  per-block HTML caching keyed on numbering state would cut that further.
- Diagnostics beyond unknown `\ref`/`\cite` keys (duplicate labels,
  unbalanced environments) and hover cards for labels/citations.
