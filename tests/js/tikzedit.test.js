// node --test tests/js/*.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../app/static/tikzedit.js");

const PRE = String.raw`\documentclass{article}
\usepackage{tikz}
\usetikzlibrary{arrows.meta, positioning} % libraries
%\usetikzlibrary{calc}
\definecolor{brand}{RGB}{200,40,40}
\definecolor[named]{ink}{gray}{0.2}
\colorlet{soft}{brand!20}
\tikzset{box/.style={draw=brand, thick, label={[red]above:{x}}}}
\tikzstyle{old}=[draw, circle]
\newcommand{\foo}{bar}
`;

test("pictures: nesting, comments and unclosed openings", () => {
  const doc = "a\n\\begin{tikzpicture}\n\\node{\\begin{tikzpicture}\\end{tikzpicture}};\n\\end{tikzpicture}\n% \\begin{tikzpicture}\n\\begin{tikzpicture}";
  const ps = T.pictures(doc);
  assert.equal(ps.length, 2);
  assert.deepEqual(ps.map((p) => p.depth), [0, 1]);
  assert.equal(doc.slice(ps[0].from, ps[0].to).endsWith("\\end{tikzpicture}"), true);
});

test("pictureAt: outermost picture around the caret, edges included", () => {
  const doc = "x \\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture} y";
  const from = doc.indexOf("\\begin"), to = doc.indexOf(" y");
  for (const caret of [from, from + 5, doc.indexOf("draw"), to]) {
    const hit = T.pictureAt(doc, caret);
    assert.ok(hit, "caret " + caret);
    assert.deepEqual([hit.from, hit.to], [from, to]);
    assert.equal(hit.text, doc.slice(from, to));
  }
  assert.equal(T.pictureAt(doc, 0), null);
  assert.equal(T.pictureAt(doc, doc.length), null);
});

test("definitions: TikZ-related preamble commands only, comments skipped", () => {
  assert.deepEqual(T.definitions(PRE), [
    "\\usetikzlibrary{arrows.meta, positioning}",
    "\\definecolor{brand}{RGB}{200,40,40}",
    "\\definecolor[named]{ink}{gray}{0.2}",
    "\\colorlet{soft}{brand!20}",
    "\\tikzset{box/.style={draw=brand, thick, label={[red]above:{x}}}}",
    "\\tikzstyle{old}=[draw, circle]",
  ]);
  assert.deepEqual(T.definitions("\\tikzset{unbalanced"), []);
  assert.deepEqual(T.definitions("\\tikzsetfoo{x}"), []);
});

test("compose: context first, then the picture; empty picture by default", () => {
  const pic = "\\begin{tikzpicture}\\node{A};\\end{tikzpicture}";
  const { source, context } = T.compose(PRE, pic);
  assert.equal(context.length, 6);
  assert.ok(source.startsWith(T.CONTEXT_NOTE + "\n\\usetikzlibrary"));
  assert.ok(source.endsWith("\n\n" + pic + "\n"));
  assert.deepEqual(T.compose("", null), { source: T.EMPTY_PICTURE + "\n", context: [] });
});

test("extract: the picture back, plus definitions the preamble lacks", () => {
  const pic = "\\begin{tikzpicture}\\node[box]{A};\\end{tikzpicture}";
  const { source, context } = T.compose(PRE, pic);
  // untouched → same picture, nothing added
  assert.deepEqual(T.extract(source, context), { picture: pic, count: 1, added: [] });
  // a new library and style above the picture, whitespace changes in a known one
  const edited = source
    .replace("\\colorlet{soft}{brand!20}", "\\colorlet{soft}{ brand!20 }\n\\usetikzlibrary{calc}")
    .replace(pic, "\\tikzset{dot/.style={fill}}\n" + pic.replace("A", "B"));
  const out = T.extract(edited, context);
  assert.equal(out.picture, pic.replace("A", "B"));
  assert.deepEqual(out.added, ["\\colorlet{soft}{ brand!20 }", "\\usetikzlibrary{calc}", "\\tikzset{dot/.style={fill}}"]);
  // several pictures: first to last; none → null
  const two = pic + "\n\n" + pic;
  assert.deepEqual(T.extract(two, []), { picture: two, count: 2, added: [] });
  assert.equal(T.extract("\\draw (0,0);", []), null);
});

test("preambleAdditions: libraries deduplicated, tikz loaded when missing", () => {
  assert.deepEqual(T.preambleAdditions(PRE, ["\\usetikzlibrary{calc, positioning}", "\\tikzset{dot/.style={fill}}"]),
    ["\\usetikzlibrary{calc}", "\\tikzset{dot/.style={fill}}"]);
  assert.deepEqual(T.preambleAdditions(PRE, ["\\usetikzlibrary{positioning}"]), []);
  assert.deepEqual(T.preambleAdditions("\\documentclass{article}\n", []), ["\\usepackage{tikz}"]);
  // a commented-out library does not count as loaded
  assert.deepEqual(T.preambleAdditions(PRE, ["\\usetikzlibrary{calc}"]), ["\\usetikzlibrary{calc}"]);
});

test("loadsTikz: tikz itself or a package built on it", () => {
  assert.equal(T.loadsTikz("\\usepackage[dvipsnames]{xcolor,tikz}"), true);
  assert.equal(T.loadsTikz("\\usepackage{pgfplots}"), true);
  assert.equal(T.loadsTikz("\\usepackage{tikz-cd}"), true);
  assert.equal(T.loadsTikz("% \\usepackage{tikz}\n\\usepackage{amsmath}"), false);
  assert.equal(T.loadsTikz("\\usepackage{tikzducks}"), false);
});

test("libraries: every \\usetikzlibrary, in order, once", () => {
  assert.deepEqual(T.libraries("\\usetikzlibrary{a, b}\n\\usetikzlibrary{b,c}"), ["a", "b", "c"]);
});
