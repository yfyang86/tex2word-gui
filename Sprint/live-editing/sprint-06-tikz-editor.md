# Sprint 06 — TikZ editor

## Goal

Visual editing of TikZ figures from the left panel (Tools → TikZ editor, or
the curve icon on the collapsed rail), by embedding
[TikZ Editor](https://github.com/DominikPeters/tikz-editor) by Dominik Peters
(MIT) rather than writing our own. It should open on the figure the cursor is
in, render it the way the document does, and write it back without disturbing
anything around it.

## What it does

- **Open.** With the cursor inside a `tikzpicture` (anywhere: inside a
  `figure`, nested pictures, comments ignored), the dialog opens on that
  picture: "Editing the picture at `main.tex:12`", button "Replace in editor".
  Otherwise it opens on an empty picture that is inserted at the cursor.
- **Context.** The render root's preamble is scanned for the definitions a
  picture depends on (`\usetikzlibrary`, `\usepgflibrary`,
  `\usepgfplotslibrary`, `\tikzset`, `\tikzstyle`, `\pgfkeys`,
  `\pgfplotsset`, `\definecolor`, `\colorlet`). They are put above the picture
  in the editor's source under a `% from the preamble` comment, so styles,
  colours and libraries resolve as in the document.
- **Edit.** The full upstream editor: canvas drawing tools, drag to move with
  the code updated in place (formatting kept), inspector, objects and styles
  panels, live source with completion.
- **Write back.** Only the picture goes back (first `\begin{tikzpicture}` to
  the last matching `\end`), replacing the original if it is unchanged in the
  editor, else inserted at the cursor. Definitions added above the picture
  in the editor (e.g. a new `\usetikzlibrary{calc}` or `\tikzset{…}`) are
  added to the preamble with `% added by the TikZ editor`; libraries already
  loaded are dropped, and `\usepackage{tikz}` is added when nothing loads
  TikZ. One editor undo step for the picture.
- **Cancel / Esc** closes; with unsaved changes it asks first. The editor
  stays loaded between openings, so reopening is instant.
- **Not installed.** Without the bundle the dialog explains how to build it.

## How it is built

The editor is a React + Vite monorepo; its build is ~53 MB (mostly lazily
loaded font outlines; a figure loads a few MB), so it is **built, not
committed**:

- `scripts/build_tikz_editor.sh` fetches a **pinned upstream commit**
  (`PINNED_REF`), applies `tools/tikz-editor-embed/patches/`, installs with
  `npm ci --ignore-scripts`, and builds `tools/tikz-editor-embed/` (copied in as
  `apps/embed`) into `app/static/vendor/tikz-editor/` with the upstream
  `LICENSE` and a `BUILD.json` (version, commit, date). The Dockerfile runs it
  in a Node stage.
- `tools/tikz-editor-embed/` is a shell like upstream's `apps/web`: the same
  browser platform adapter, a relative base path, and `src/bridge.ts`, which
  talks to the host page over `postMessage` (`ready` / `load` / `loaded` /
  `change` / `get` / `source`; same-origin, parent window only). The editor's
  workspace (open tabs) lives in memory, so every opening starts clean;
  settings and panel layout persist as upstream.
- `app/tikzeditor.py` reports the bundle in `/api/config`
  (`tools.tikz_editor`), and the server sends its pages with a strict
  Content-Security-Policy: the editor shares the app's origin and renders the
  project's TikZ (imported arXiv sources included) to SVG, so only the
  bundle's own scripts may run and nothing is fetched elsewhere.
- Host side: `app/static/tikzedit.js` (DOM-free: find pictures, collect and
  compose definitions, extract the result, preamble additions) and
  `app/static/tikzedit-ui.js` (the dialog). `addToPreamble()` /
  `rootPreamble()` moved into `app.js`, shared with the table generator.

## Tests

- `tests/js/tikzedit.test.js` — picture search (nesting, comments, caret at
  the edges), definition parsing (balanced braces, optional args, old
  `\tikzstyle`), compose/extract round trip, added definitions, preamble
  additions, TikZ detection.
- `tests/test_tikzeditor.py` — bundle detection and `BUILD.json`, the
  `/api/config` entry, the CSP on bundle pages only.
- `tests/e2e/tikzedit.e2e.js` — not-installed message; new figure inserted
  with `\usepackage{tikz}` and a new library added; editing a picture inside a
  float in place (context loaded, float kept, styles not duplicated, new
  library added); a picture in a chapter file gets the root preamble and new
  definitions land there; cancel asks before discarding. The bundle cases are skipped
  when the bundle is not built.

## Upstream notes

1. **Node text renders huge** at the pinned commit (and on tikz.dev/editor on
   2026-10-20): `.svgLayer :global(svg) { width: 100%; height: 100% }` in
   `CanvasPanel.module.css` also matches the nested `<svg>` that holds each
   node's text, so CSS stretches it to the canvas. Patched here
   (`patches/0001-nested-svg-size.patch`, outermost `<svg>` only); worth
   reporting upstream.
2. The store is not a package export; the embed aliases
   `@tikz-editor/app/store/store` and `…/settings/useSettingsStore` to their
   source files. An official embed API (load source, observe changes) would
   make this sturdier across upgrades.

## Follow-ups

- Dark theme for the dialog once the app has one (the bridge already passes
  `colorScheme`).
- `tikz-cd`, `circuitikz` and other environments the editor may support.
- Run the e2e suite (and the bundle build) in CI.
