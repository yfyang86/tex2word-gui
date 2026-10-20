# Sprint 02 — multi-file sync, quick/full preview

## Gaps

1. Source ⇄ preview sync matched *headings by text* inside the active file.
   With `\input` it broke: `main.tex` has no headings to match, a click in the
   preview always moved the *active* editor even when the text came from
   another file, and repeated heading titles mismatched.
2. Clicking a chapter file made it the render root, so the preview showed the
   fragment on its own (no numbering, no refs, no preamble macros).
3. Every refresh re-ran the whole engine — including building a `.docx` the
   preview threw away — and replaced the whole preview DOM.

## Approach

### Source map (`app/sourcemap.py`)

- **Flatten with origins.** Reproduce tex2word's
  `flatten_inputs(strip_comments(root))` byte for byte (its own regexes and
  resolution rules), recording each character's `(file, line)`.
- **Instrument.** Insert invisible markers (Unicode private-use runs encoding
  `(chunk serial, index)`) only where it is safe: start of text lines, inside
  heading and caption braces, after `\item`, before top-level display blocks.
  Never in math, verbatim, TikZ, tables or brace groups; never in the preamble.
  A marker that would join the end of a paragraph goes at the end of the
  previous line (the engine then still trims trailing whitespace).
- **Render.** Markers become `<span data-src="file:line">`; anything left is
  stripped. A *marker-only* paragraph becomes a zero-height `p.srcmark`.
- **Safety.** With markers stripped, the HTML is identical to an
  uninstrumented render (checked on the fixtures and the three arXiv papers).
  If the engine ever fails on an instrumented source, the preview re-parses
  the plain source and simply has no source map.

### Render root

`_effective_main` keeps standalone files (`\documentclass`/`\begin{document}`)
as roots and resolves a fragment to the root that includes it. In the UI the
root is *sticky*: opening a fragment keeps the current root and does not
re-render; opening a standalone file makes it the root.

### Sync (`app/static/sync.js`, pure, unit-tested)

- Editor → preview: anchors of the active file sorted by line, interpolated
  between the neighbours around the caret line; a caret on an `\input` line
  jumps to the included file's first anchor.
- Preview → editor: the nearest anchor above the click, interpolated towards
  the next anchor of the *same file*; opens that file and puts the caret on
  the line. Both directions flash the target (block / line band).
- Without a source map (LaTeXML frontend, fallback) the old heading sync runs.

### Quick vs full (`app/livepreview.py`)

- **Full** — the whole instrumented project is parsed (parse-only: no
  `.docx`, ≈2× faster than before) and rendered.
- **Quick** — the body is chunked at top-level blank lines. Chunks whose text
  is unchanged keep their cached IR blocks; changed chunks are parsed together
  in one small document (cached preamble + changed chunks + any body chunk
  with definitions or the `\appendix` switch as context), spliced in, then
  labels, references and numbering are recomputed over the whole document.
- **Falls back to full, with a reason**, when a local parse could differ:
  preamble or document end changed; the edit touches a definition, counter,
  bibliography, title/abstract, acronym/glossary, conditional or
  `enumitem` `resume`; the engine's citation order changed or a new citation
  form appeared; an edit sits inside a span tied together by a label the
  engine attached outside its chunk (engine note 2); a re-parsed chunk's
  labels don't land in its own blocks; too many chunks changed; separators
  were not recovered.
- **Segments.** The reply lists `[key, html]` per top-level element (key =
  content hash). With `base_rev` the server omits html the client already
  holds; the browser swaps only changed blocks (scroll position and untouched
  MathML stay put).
- **Reconcile.** 4 s after a burst of quick updates the client runs a full
  parse and patches whatever differs, so drift cannot persist.
- The header shows a **Quick | Full** toggle (persisted) and a status like
  `quick · 77 ms · 1/176`; its tooltip says how many chunks were re-parsed or
  why a quick request ran as full. The refresh button is always a full render.

## Numbers

| Document | Full (before) | Full (now) | Quick |
| --- | --- | --- | --- |
| synthetic, 100 sections / 118 KB | ≈2.3 s | 1.2 s | 0.13 s (7 ms parse), 513 → 25 KB reply |
| arXiv 1810.04805 (BERT), 20 files | — | ≈0.55 s | ≈0.05–0.08 s |

## Tests

- `tests/test_sourcemap.py` — flattening equals the engine's (incl. imports,
  missing files, self-include); origins through comments; markers never in
  math/verbatim/TikZ/tables/groups/preamble; chunks balanced; instrumented ≡
  plain render on varied documents; anchors carry the right file and line and
  appear in order; fallback when the engine rejects markers; fragment → root.
- `tests/test_livepreview.py` — no-op quick resends nothing; one edit → one
  chunk, one segment; numbering/refs stay global; body macros and the appendix
  switch reach re-parsed chunks; anchors move with line shifts; every fallback
  rule; seeded random edit sequences equal fresh full renders; base-rev
  handling; session bound; API round trip.
- During development a fuzzer ran 240 random edits over three arXiv papers
  with zero mismatches against full renders.
- `tests/js/sync.test.js`, `tests/e2e/sync.e2e.js` — sticky root, editor click
  scrolls the preview in a sub-file, preview click opens the right file and
  line (both ways), quick patches only the edited node and reconcile keeps the
  rest, full mode replaces the DOM, mode persistence, fallback tooltip.
