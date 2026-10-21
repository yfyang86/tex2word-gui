// node --test tests/js/*.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../../app/static/outline.js");

const DOC = String.raw`\documentclass{article}
\title{Attention \textbf{Is} Mostly}
\begin{document}
\begin{abstract} x \end{abstract}
% \section{Commented out}
\section{Introduction}\label{sec:intro}
Words about $x$ and \emph{things}.
\subsection[Short]{A long \emph{title}}
\begin{figure}[h]
\caption[Short cap]{Architecture of $f$}\label{fig:arch}
\end{figure}
\begin{equation}\label{eq:att}
a = b + c
\end{equation}
\begin{theorem}[Main result] text \end{theorem}
\begin{verbatim}
\section{Not a section}
\end{verbatim}
\input{sections/method}
\include{chap1.tex}
\import{chap/}{two}
\appendix
\section*{Extra}
\begin{table}\begin{tabular}{l}x\end{tabular}\end{table}
\bibliography{refs, more}
\end{document}`;

test("parse: every kind of item, comments and verbatim skipped", () => {
  const items = O.parse(DOC, "tex");
  const rows = items.map((i) => [i.line, i.depth, i.kind, i.title]);
  assert.deepEqual(rows, [
    [1, 0, "title", "Attention Is Mostly"],
    [3, 0, "abstract", "Abstract"],
    [5, 0, "heading", "Introduction"],
    [7, 1, "heading", "A long title"],
    [8, 2, "figure", "Architecture of $f$"],
    [11, 2, "equation", "a = b + c"],
    [14, 2, "theorem", "Theorem (Main result)"],
    [18, 2, "input", "sections/method.tex"],
    [19, 2, "input", "chap1.tex"],
    [20, 2, "input", "chap/two.tex"],
    [21, 0, "appendix", "Appendix"],
    [22, 0, "heading", "Extra"],
    [23, 1, "table", "Table"],
    [24, 1, "bib", "Bibliography"],
  ]);
  const byKind = (k) => items.find((i) => i.kind === k);
  assert.equal(items[2].label, "sec:intro");
  assert.equal(byKind("figure").label, "fig:arch");
  assert.equal(byKind("equation").label, "eq:att");
  assert.equal(byKind("bib").detail, "refs, more");
  assert.equal(items.find((i) => i.title === "Extra").starred, true);
});

test("parse: a fragment's top heading is depth 0; multi-line titles; no items", () => {
  const items = O.parse("\\subsection{One}\n\\subsubsection{Two\nlines}\n\\subsection{Three}", "tex");
  assert.deepEqual(items.map((i) => [i.depth, i.title]), [[0, "One"], [1, "Two lines"], [0, "Three"]]);
  assert.deepEqual(O.parse("Just text, \\textbf{bold}.", "tex"), []);
  assert.deepEqual(O.parse("", "tex"), []);
});

test("parse: Markdown headings, fenced code ignored", () => {
  const md = "# Top\ntext\n```\n# not a heading\n```\n## Second *em*\n### Third ###";
  assert.deepEqual(O.parse(md, "md").map((i) => [i.line, i.depth, i.title]), [[0, 0, "Top"], [5, 1, "Second em"], [6, 2, "Third"]]);
});

test("activeIndex: the last item at or before the caret line", () => {
  const items = O.parse(DOC, "tex");
  assert.equal(O.activeIndex(items, 0), -1);
  assert.equal(items[O.activeIndex(items, 6)].title, "Introduction");
  assert.equal(items[O.activeIndex(items, 9)].kind, "figure");
  assert.equal(items[O.activeIndex(items, 999)].kind, "bib");
});

test("wordCount: prose only", () => {
  assert.equal(O.wordCount("\\section{Intro} Hello world, it's $x^2$ % not this\n\\cite{key} done.", "tex"), 5);
  assert.equal(O.wordCount("# Title\nSome `code` words here.\n```\nignored stuff\n```", "md"), 4);
  assert.equal(O.wordCount("", "tex"), 0);
  assert.equal(O.wordCount("Grüße, naïve café — 42 times", "tex"), 5);
});

test("plain: commands and braces dropped, math kept", () => {
  assert.equal(O.plain("The \\emph{big} {idea} of $\\alpha$~test\\label{x}"), "The big idea of $\\alpha$ test");
});
