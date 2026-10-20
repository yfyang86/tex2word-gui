# Sprint 03 — smart autocompletion

## Goal

Context-aware completion while typing LaTeX, without a language server.
A full LSP (e.g. texlab) would need a server process and a bundled client;
the project's "no build step" rule and its in-browser editor make a focused
client-side engine the better fit. The engine knows the whole project because
the browser already holds every text file.

## Engine (`app/static/complete.js`, DOM-free, unit-tested in node)

**Project index** (rebuilt ~400 ms after edits; 3–20 ms on the arXiv corpus):
labels with what they label (section title, figure/table caption, equation,
theorem kind, list item), bibliography from `.bib`, `.bbl` and `\bibitem`
(author, year, title), user macros with arity (`\newcommand`, `\def`,
`\DeclareMathOperator`, …; `.sty` macros ranked lower), user environments and
theorems, loaded packages, project files, command frequency.

**Contexts**

| You type | You get |
| --- | --- |
| `\fr` | commands: catalog (~280) + project macros + commands used in the project; math-only commands rank first inside math, text commands outside |
| `\begin{fi` | environments with full block snippets (figure, table, align, itemize, …, project theorems) |
| `\end{` | the innermost open environment first |
| `\ref{`, `\eqref{`, `\cref{a,` … | labels, showing kind + title + `file:line` |
| `\cite{`, `\citep[p.~3]{x,` … | keys, searchable by author/title, showing "Vaswani et al. · 2017 · Attention…" |
| `\input{` / `\includegraphics{` / `\bibliography{` | project files (`\input` paths relative to the including file, as the engine resolves them) |
| `\usepackage{` / `\documentclass{` | packages / classes |

Never inside comments or right after a `\\` line break. Ranking: exact >
prefix > word start > substring > fuzzy (fuzzy dropped when there are enough
good matches), plus frequency and most-recently-accepted boosts (persisted).

**Snippets** — `${1:placeholder}` tabstops; multi-line blocks re-indented to
the current line.

## Editor UI (`app/static/app.js`)

- Popup at the caret: ↑/↓ (Ctrl+N/P), Enter/Tab to accept, Esc to close,
  **Ctrl+Space** to open on demand. Commands pop up after the first letter;
  arguments as soon as the brace is typed.
- Tab / Shift+Tab move through snippet stops; a stop inside `\ref{}`/`\cite{}`
  opens the key list immediately.
- Enter right after `\begin{env}` adds the matching `\end{env}` (only if it is
  not already closed).
- Argument completions add the closing brace unless one (or a key-list comma)
  is already there.
- Insertions go through `execCommand("insertText")`, so **undo keeps working**.
- **Diagnostics**: `\ref`/`\cite` keys that exist nowhere in the project get a
  wavy red underline in the highlight layer (citations are only checked when
  the project has a bibliography source).

## Tests

- `tests/js/complete.test.js` — index (label kinds/titles/lines, commented
  labels ignored, `.bib` field forms, `\bibitem` author/title/year, macro
  arity, envs, packages), every context, comment/line-break exclusions,
  ranking and details, math-awareness, macro snippets, `\end{` order, block
  snippets, brace closing, file paths, `inMath` delimiters, `needsEnd`,
  snippet expansion, scoring order, MRU, catalog shape.
- `tests/e2e/complete.e2e.js` — labels across files, citations by title,
  `\frac` snippet with tabstops and undo, project macro + list block,
  auto-`\end` (and not when already closed), `\end{` order, lone `\`
  stays quiet, Ctrl+Space, unknown-key underline with an aligned overlay.
