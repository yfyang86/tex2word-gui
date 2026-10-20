# Sprint 05 — Table generator

## Goal

A visual LaTeX table builder in the spirit of
[tablesgenerator.com](https://www.tablesgenerator.com/latex_tables), opened
from the left panel (Tools → Table generator, or the table icon on the
collapsed rail), that writes straight into the project — and can edit a table
that is already in the document.

## What it does

**Grid.** Click, Shift+click or drag to select; click a column / row header
(or the corner) to select it. Typing replaces a cell; Enter, F2 or a double
click edits it (Enter commits and moves down, Tab / Shift+Tab move to the
next / previous cell and Tab past the end adds a row, Esc cancels). Arrows
move, Shift+arrows extend, Delete clears, Ctrl/Cmd+B/I/U format, Ctrl/Cmd+Z
and Shift+Z / Y undo and redo (200 steps), Ctrl/Cmd+A selects all.
Ctrl/Cmd+C/X/V copy, cut and paste cells as TSV — so cells pasted from Excel,
Google Sheets or LibreOffice land in the grid (growing it), and pasted CSV or
a whole LaTeX table is understood too. Right-click a cell or header for the
common actions.

**Menus.** File (new, import CSV/TSV, load LaTeX code, load the table at the
editor cursor, copy) · Edit · Table (size, transpose, all / horizontal / no
borders, clear formatting) · Column (insert, delete, align, set width) · Row ·
Cell (merge, split, bold / italic / underline, text and background colour,
clear) · Help.

**Toolbar.** Align left / center / right (whole columns change the column
spec, otherwise a per-cell `\multicolumn{1}{…}`), bold, italic, underline;
borders: all, outer, inner, horizontal only, none; merge / split; text colour,
background colour, clear formatting. The grid draws the rules it will emit.

**Output options** (as on tablesgenerator): style standard / booktabs;
caption none / above / below with caption text and label (the label defaults
to `tab:<slug of caption>`); center horizontally; rotate to a landscape page;
width natural / wrap to text width (`tabularx`) / scale to text width or
column width (`\resizebox`); long table (`longtable`); complete document;
escape special characters; layout aligned / compact / smart. The LaTeX updates
live; notes list the packages it needs (missing ones highlighted) and explain
anything dropped (e.g. vertical rules in booktabs).

**Into the project.** "Insert into editor" puts the table at the cursor
(replacing the selection). If the cursor was inside a table when the tool
opened, that table is loaded (banner: "Editing the table at main.tex:12") and
the button becomes "Replace table in editor". Missing `\usepackage` lines are
added before `\begin{document}` of the render root (even when you are editing a
chapter file), with an opt-out checkbox. Everything is one editor undo step
per change. The last table and options are remembered per browser.

## Engine (`app/static/tablegen.js`, DOM-free)

Model: cells with text, bold/italic/underline, alignment override, text and
background colour, row/column spans (merged ranges owned by their top-left
cell); horizontal rules per cell edge; vertical rules per column boundary
(LaTeX column specs make those column-wide). Operations: merge (expands to
whole merges), split, insert/delete rows and columns (splitting merges they
cut), resize, borders, formatting, transpose, paste.

Export: `\hline` / `\cline{a-b}` (booktabs: `\toprule` / `\midrule` /
`\bottomrule` / `\cmidrule{a-b}`), rules never cross a merged block,
`\multicolumn` (keeps the column's bars), `\multirow`, both combined (rows
below repeat the column span and background), `\cellcolor[HTML]`,
`\textcolor[HTML]`, `p{width}` columns with `\centering`/`\raggedleft`
(array), escaping of `\ & % $ # _ { } ~ ^`.

Import: TSV, CSV (quotes, `;` detection, multi-line fields), and LaTeX —
`tabular` / `tabularx` / `tabular*` / `longtable` (in a float or not), column
specs (`l c r p{} m{} b{} X | >{\centering…} @{} *{n}{…}`), all rule
commands, `\multicolumn`, `\multirow`, `\cellcolor`, `\textcolor`, `\textbf` …,
caption, label, booktabs/width/landscape detection. Generate → parse →
generate is exact (property-tested on random tables).

## Tests

- `tests/js/tablegen.test.js` (24) — model operations, every export option,
  escaping, layouts, document wrapper, TSV/CSV, column specs, a real arXiv
  booktabs table, rules/multirow/colour parsing, 60 random round trips,
  preamble package detection.
- `tests/test_tablegen.py` — generated tables (all borders, booktabs, merges +
  colours, tabularx, `\resizebox`, longtable, landscape, column widths /
  complete document) converted by **tex2word**: valid `.docx`, no errors,
  merged cells, cell shading, booktabs flag, caption and label survive.
- `tests/e2e/tablegen.e2e.js` (8) — open from the panel and the rail;
  typing / Tab / Enter / Esc; paste, bold (Ctrl+B does not toggle the files
  panel), merge, centre, borders, undo / redo, copy as TSV; context menu,
  menus, options and their persistence; insert + packages + preview + editor
  undo; edit the table at the cursor and replace it; load LaTeX and import
  CSV; packages added to `main.tex` while editing a chapter.

## Notes

- Landscape floats use `sidewaystable` (rotating). tex2word converts the table
  but reports the environment as unknown (it is treated as transparent).
