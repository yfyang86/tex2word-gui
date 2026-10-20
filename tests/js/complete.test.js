// node --test tests/js/*.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../app/static/complete.js");

const FILES = {
  "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath,natbib}
\usepackage[table]{xcolor}
\newcommand{\vect}[1]{\mathbf{#1}}
\newcommand\R{\mathbb{R}}
\DeclareMathOperator*{\argmax}{arg\,max}
\def\half#1{\frac{#1}{2}}
\newtheorem{lemma}{Lemma}
\newenvironment{note}[1]{}{}
\begin{document}
\section{Intro}\label{sec:intro}
% \label{sec:commented}
Text \vect{x} and \vect{y}.
\begin{figure}
  \centering
  \caption{A {\em nice} plot}\label{fig:plot}
\end{figure}
\begin{equation}\label{eq:main} x \end{equation}
\begin{lemma}\label{lem:a} ok \end{lemma}
\begin{enumerate}\item\label{it:one} one\end{enumerate}
\end{document}`,
  "sections/method.tex": "\\subsection{Method details}\n\\label{sec:method}\n",
  "refs.bib": String.raw`@article{vaswani2017,
  title = {Attention Is {All} You Need},
  author = {Vaswani, Ashish and Shazeer, Noam},
  year = 2017,
}
@inproceedings{devlin2019, author="Devlin, Jacob", title="{BERT}: Pre-training", year={2019}}
@string{foo = "bar"}
@comment{ignore me}
`,
  "figs/plot.png": "",
  "figs/diagram.pdf": "",
  "other.bib": "@book{knuth1984, title={The TeXbook}, author={Knuth, Donald}, year={1984}}",
};
const IX = T.buildIndex(FILES);

function at(src, opts) {  // "|" marks the caret
  const caret = src.indexOf("|");
  return T.complete(src.replace("|", ""), caret, IX, { file: "main.tex", ...(opts || {}) });
}
const labels = (r) => r.items.map((i) => i.label);

test("index: labels know what they label", () => {
  const by = Object.fromEntries(IX.labels.map((l) => [l.key, l]));
  assert.equal(by["sec:intro"].kind, "section");
  assert.equal(by["sec:intro"].title, "Intro");
  assert.equal(by["sec:method"].kind, "subsection");
  assert.equal(by["sec:method"].title, "Method details");
  assert.equal(by["fig:plot"].kind, "figure");
  assert.equal(by["fig:plot"].title, "A nice plot");
  assert.equal(by["eq:main"].kind, "equation");
  assert.equal(by["lem:a"].kind, "lemma");
  assert.equal(by["it:one"].kind, "item");
  assert.equal(by["sec:commented"], undefined, "commented-out labels are ignored");
  assert.equal(by["fig:plot"].line, 16);
});

test("index: bibliography entries from .bib files", () => {
  const by = Object.fromEntries(IX.cites.map((c) => [c.key, c]));
  assert.deepEqual(Object.keys(by).sort(), ["devlin2019", "knuth1984", "vaswani2017"]);
  assert.equal(by.vaswani2017.title, "Attention Is All You Need");
  assert.equal(by.vaswani2017.year, "2017");
  assert.equal(by.devlin2019.title, "BERT: Pre-training");
  assert.equal(by.devlin2019.file, "refs.bib");
});

test("index: \\bibitem entries carry author, title and year", () => {
  const ix = T.buildIndex({ "m.tex": String.raw`\begin{thebibliography}{9}
\bibitem{ba2016}
Jimmy~Lei Ba, Jamie~Ryan Kiros, and Geoffrey~E Hinton.
\newblock Layer normalization.
\newblock {\em arXiv preprint}, 2016.

\bibitem[Knuth(1984)]{knuth} D. Knuth. \newblock The {\TeX}book.
\end{thebibliography}` });
  const [a, b] = ix.cites;
  assert.equal(a.key, "ba2016");
  assert.equal(a.title, "Layer normalization");
  assert.equal(a.year, "2016");
  assert.match(a.author, /^Jimmy Lei Ba/);
  assert.equal(b.key, "knuth");
  assert.equal(b.title, "The TeXbook");
});

test("index: project macros, environments and packages", () => {
  assert.equal(IX.macros.get("vect").args, 1);
  assert.equal(IX.macros.get("R").args, 0);
  assert.equal(IX.macros.get("argmax").math, true);
  assert.equal(IX.macros.get("half").args, 1);
  assert.ok(IX.envs.has("lemma") && IX.envs.get("note").args === 1);
  assert.ok(["amsmath", "natbib", "xcolor"].every((p) => IX.packages.has(p)));
});

test("context: which argument is being completed", () => {
  assert.equal(at("\\ref{|").kind, "label");
  assert.equal(at("\\eqref{eq|}").kind, "label");
  assert.equal(at("\\Cref{a,|").kind, "label");
  assert.equal(at("\\citep[see][p.~3]{|").kind, "cite");
  assert.equal(at("\\parencite{|").kind, "cite");
  assert.equal(at("\\begin{|").kind, "env");
  assert.equal(at("\\end{|").kind, "end");
  assert.equal(at("\\input{|").kind, "file-tex");
  assert.equal(at("\\includegraphics[width=3cm]{|").kind, "file-img");
  assert.equal(at("\\bibliography{|").kind, "file-bib");
  assert.equal(at("\\usepackage[utf8]{|").kind, "package");
  assert.equal(at("\\documentclass{|").kind, "class");
  assert.equal(at("\\sec|").kind, "cmd");
});

test("context: no completion in comments, after a line break, or in plain text", () => {
  assert.equal(at("text % \\ref{|"), null);
  assert.equal(at("a \\\\|"), null);
  assert.equal(at("plain words|"), null);
  assert.equal(at("50\\% done \\ref{|").kind, "label");  // an escaped % is not a comment
});

test("labels and citations rank by the query and show details", () => {
  const r = at("\\ref{fig|");
  assert.equal(r.items[0].label, "fig:plot");
  assert.match(r.items[0].detail, /figure · A nice plot/);
  assert.equal(r.items[0].source, "main.tex:16");
  const c = at("\\cite{vas|}");
  assert.equal(c.items[0].label, "vaswani2017");
  assert.match(c.items[0].detail, /Vaswani et al\. · 2017 · Attention/);
  // citations also match on the title / author
  assert.equal(at("\\cite{texbook|").items[0].label, "knuth1984");
  assert.equal(c.close, "", "a closing brace is already there");
  assert.equal(at("\\ref{fig|").close, "}", "…otherwise it is added");
  assert.equal(at("\\cite{a|,b}").close, "", "…but not inside a key list");
  // a comma list completes the last key only
  const multi = at("\\cite{vaswani2017, dev|");
  assert.equal(multi.items[0].label, "devlin2019");
  assert.equal(multi.query, "dev");
});

test("commands are math-aware", () => {
  const inMath = labels(at("$x = \\al|$"));
  assert.equal(inMath[0], "\\alpha");
  const text = labels(at("Some \\te|"));
  assert.ok(text.indexOf("\\textbf") < text.indexOf("\\text") || !text.includes("\\text"),
            "text commands outrank math-only ones in text");
  assert.equal(labels(at("\\begin{equation} \\fr|"))[0], "\\frac");
  assert.equal(labels(at("$a$ then \\emp|"))[0], "\\emph");  // the $…$ is closed
});

test("project macros are offered with argument snippets", () => {
  const r = at("\\ve|");
  const v = r.items.find((i) => i.label === "\\vect");
  assert.ok(v && r.items.indexOf(v) < 3, "\\vect near the top");
  assert.equal(v.insert, "\\vect{${1:#1}}");
  assert.equal(v.source, "main.tex:4");
});

test("\\end{ offers the innermost open environment first", () => {
  const r = at("\\begin{itemize}\\item a\\begin{lemma} b \\end{|");
  assert.equal(r.items[0].label, "lemma");
  assert.equal(r.items[0].insert, "lemma}");
});

test("environments insert a full block with tabstops", () => {
  const fig = at("\\begin{fig|").items.find((i) => i.label === "figure");
  const sn = T.expandSnippet(fig.insert);
  assert.match(sn.text, /^figure\}\[htbp\]\n\t\\centering\n/);
  assert.match(sn.text, /\n\\end\{figure\}$/);
  assert.equal(sn.text.slice(sn.stops[0].start, sn.stops[0].end), "htbp");
  const proj = at("\\begin{not|").items.find((i) => i.label === "note");
  assert.match(proj.insert, /^note\}\{\$\{1:#1\}\}\n/);
  // a closing brace already typed is replaced, not doubled
  const src = "\\begin{fig}";
  const r = T.complete(src, src.indexOf("}"), IX, {});
  assert.equal(r.to, src.length);
});

test("file arguments complete project paths (relative to the including file)", () => {
  assert.deepEqual(labels(at("\\input{|")), ["sections/method"]);
  const nested = T.complete("\\input{", 7, IX, { file: "sections/method.tex" });
  assert.deepEqual(labels(nested), ["../main"]);
  assert.deepEqual(labels(at("\\includegraphics{|")).sort(), ["figs/diagram.pdf", "figs/plot.png"]);
  assert.deepEqual(labels(at("\\bibliography{|")).sort(), ["other", "refs"]);
  assert.equal(labels(at("\\usepackage{boo|"))[0], "booktabs");
});

test("inMath handles the usual delimiters", () => {
  const m = (s) => T.inMath(s.replace("|", ""), s.indexOf("|"));
  assert.equal(m("$a|"), true);
  assert.equal(m("$a$ b|"), false);
  assert.equal(m("\\(x|"), true);
  assert.equal(m("\\[x\\] y|"), false);
  assert.equal(m("$$ x |"), true);
  assert.equal(m("\\begin{align} x &|"), true);
  assert.equal(m("\\begin{align*} x \\end{align*} t|"), false);
  assert.equal(m("cost \\$5 and |"), false);  // escaped dollar
  assert.equal(m("$x\n\ny|"), false);          // math cannot cross a paragraph break
  assert.equal(m("% $\ntext|"), false);         // commented-out dollar
});

test("needsEnd detects an unclosed \\begin", () => {
  const src = "\\begin{itemize}\n";
  assert.equal(T.needsEnd(src, src.length, "itemize"), true);
  const closed = "\\begin{itemize}\n\\item a\n\\end{itemize}";
  assert.equal(T.needsEnd(closed, 15, "itemize"), false);
  const nested = "\\begin{itemize}\n\\begin{itemize}\\end{itemize}\n";
  assert.equal(T.needsEnd(nested, 15, "itemize"), true);
  assert.equal(T.needsEnd("\\begin{a}\n% \\end{a}\n", 9, "a"), true);
});

test("expandSnippet: tabstops, placeholders, final position", () => {
  const s = T.expandSnippet("\\frac{${1:num}}{${2:den}}$0 after");
  assert.equal(s.text, "\\frac{num}{den} after");
  assert.deepEqual(s.stops, [{ start: 6, end: 9 }, { start: 11, end: 14 }]);
  assert.equal(s.final, 15);
  assert.equal(T.expandSnippet("plain").final, 5);
  assert.deepEqual(T.expandSnippet("${2:b} ${1:a}").stops, [{ start: 2, end: 3 }, { start: 0, end: 1 }]);
  assert.equal(T.indentSnippet("a\nb\nc", "  "), "a\n  b\n  c");
});

test("scoring: exact > prefix > word start > substring > fuzzy", () => {
  const s = (q, n) => T.score(q, n);
  assert.ok(s("sec", "sec") > s("sec", "section"));
  assert.ok(s("section", "section") > s("sec", "subsection"));
  assert.ok(s("sec", "section") > s("sec", "subsection"));
  assert.ok(s("plot", "fig:plot") > s("plt", "fig:plot"));
  assert.ok(s("plt", "fig:plot") > 0);
  assert.equal(s("zz", "section"), -1);
});

test("accepted items float up (MRU)", () => {
  const plain = labels(at("\\ref{|"));
  const last = plain[plain.length - 1];
  const boosted = labels(at("\\ref{|", { mru: { ["label:" + last]: 5 } }));
  assert.equal(boosted[0], last);
});

test("relPath", () => {
  assert.equal(T.relPath("main.tex", "a/b.tex"), "a/b.tex");
  assert.equal(T.relPath("a/x.tex", "a/b.tex"), "b.tex");
  assert.equal(T.relPath("a/x.tex", "c/d.tex"), "../c/d.tex");
});

test("the catalog is well formed", () => {
  for (const [name, args, desc, where] of T.CATALOG) {
    assert.ok(name && typeof args === "string" && desc && "tmb".includes(where), name);
  }
  for (const [name, body] of T.ENVIRONMENTS) assert.ok(name && typeof body === "string", name);
});

test("\\begin and \\end are commands that open the environment list", () => {
  const r = at("\\beg|");
  assert.equal(r.items[0].label, "\\begin");
  assert.equal(r.items[0].insert, "\\begin{${1}}");
});

test("macros: optional arguments, xparse signatures, definition preview", () => {
  const ix = T.buildIndex({ "m.tex": String.raw`
\newcommand{\norm}[2][2]{\left\| #2 \right\|_{#1}}
\NewDocumentCommand{\pair}{s o m m}{(#3, #4)}
\def\half#1{\frac{#1}{2}}
\DeclareMathOperator{\Tr}{tr}` });
  const norm = ix.macros.get("norm");
  assert.deepEqual(norm.sig, ["o", "m"]);
  assert.equal(T.macroSnippet(norm), "{${1:#2}}");          // the optional [#1] is left out
  assert.equal(T.macroSnippet(ix.macros.get("pair")), "{${1:#3}}{${2:#4}}");
  assert.equal(ix.macros.get("half").body, "\\frac{#1}{2}");
  const item = T.complete("$\\nor", 5, ix, {}).items.find((i) => i.label === "\\norm");
  assert.match(item.detail, /2 args \(1 optional\) → \\left\\\| #2/);
  assert.equal(ix.macros.get("Tr").body, "tr");
});

test("colours complete with swatches (base + project colours)", () => {
  const ix = T.buildIndex({ "m.tex": String.raw`\definecolor{brand}{HTML}{D92B2B}
\definecolor{soft}{rgb}{0.5,0.5,1}\colorlet{accent}{brand!60}` });
  const r = T.complete("\\textcolor{", 11, ix, {});
  assert.equal(r.kind, "color");
  const by = Object.fromEntries(r.items.map((i) => [i.label, i]));
  assert.equal(by.brand.swatch, "#d92b2b");
  assert.equal(by.soft.swatch, "#8080ff");
  assert.equal(by.accent.swatch, "#d92b2b");
  assert.equal(by.red.swatch, "#ff0000");
  assert.equal(r.items[0].label === "accent" || r.items[0].label === "brand" || r.items[0].label === "soft", true);
  assert.equal(T.colorCss("cmyk", "0,1,1,0"), "#ff0000");
  assert.equal(T.colorCss("wave", "500"), "");
});

test("\\label{ suggests a prefixed name from the caption or heading", () => {
  const ix = T.buildIndex({});
  const fig = "\\begin{figure}\\caption{Training loss of the model}\\label{";
  assert.deepEqual(T.complete(fig, fig.length, ix, {}).items.map((i) => i.label), ["fig:training-loss-model", "fig:"]);
  const sec = "\\section{Related Work}\n\\label{";
  assert.equal(T.complete(sec, sec.length, ix, {}).items[0].label, "sec:related-work");
  const eq = "\\begin{equation} x \\label{";
  assert.deepEqual(T.complete(eq, eq.length, ix, {}).items.map((i) => i.label), ["eq:"]);
  // an existing key gets a numeric suffix
  const taken = T.buildIndex({ "a.tex": "\\section{Related Work}\\label{sec:related-work}" });
  assert.equal(T.labelSuggestions(sec, sec.length, taken)[0], "sec:related-work-2");
});

test("envBlock / envNames for Tab expansion of a bare environment word", () => {
  assert.equal(T.envBlock("itemize", IX), "\\begin{itemize}\n\t\\item ${1}\n\\end{itemize}");
  assert.match(T.envBlock("figure", IX), /^\\begin\{figure\}\[\$\{1:htbp\}\]\n\t\\centering/);
  assert.equal(T.envBlock("note", IX), "\\begin{note}{${1:#1}}\n\t${1}\n\\end{note}");
  const names = T.envNames(IX);
  assert.ok(names.has("align*") && names.has("lemma") && !names.has("prose"));
});
