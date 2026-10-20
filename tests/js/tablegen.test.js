// node --test tests/js/*.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../../app/static/tablegen.js");

const sel = (r0, c0, r1, c1) => ({ r0, c0, r1, c1 });
function sample() {
  const t = G.create(3, 3);
  G.pasteGrid(t, [["Model", "Acc", "F1"], ["Ours", "0.9", "0.8"], ["Base", "0.7", "0.6"]]);
  return t;
}
const lines = (code) => code.trim().split("\n");

test("create: shape and defaults", () => {
  const t = G.create(4, 5);
  assert.equal(t.cells.length, 4);
  assert.equal(t.cells[0].length, 5);
  assert.equal(t.hlines.length, 5);
  assert.equal(t.vlines.length, 6);
  assert.deepEqual(t.colAlign, ["l", "l", "l", "l", "l"]);
});

test("the default empty table matches tablesgenerator's skeleton", () => {
  const code = G.toLatex(G.create(4, 5)).code;
  assert.deepEqual(lines(code), [
    "\\begin{table}[htbp]", "\\centering", "\\begin{tabular}{lllll}",
    " &  &  &  &  \\\\", " &  &  &  &  \\\\", " &  &  &  &  \\\\", " &  &  &  & ",
    "\\end{tabular}", "\\end{table}",
  ]);
});

test("merge, expand and split", () => {
  const t = sample();
  G.merge(t, sel(1, 1, 2, 2));
  const o = t.cells[1][1];
  assert.equal(o.rs, 2); assert.equal(o.cs, 2);
  assert.equal(o.text, "0.9 0.8 0.7 0.6");
  assert.ok(t.cells[2][2].hidden && t.cells[1][2].hidden);
  assert.deepEqual(G.ownerOf(t, 2, 2), { r: 1, c: 1 });
  // a selection that cuts a merge grows to include it
  assert.deepEqual(G.expand(t, sel(0, 2, 1, 2)), sel(0, 1, 2, 2));
  G.split(t, 2, 2);
  assert.ok(!t.cells[2][2].hidden && t.cells[1][1].rs === 1);
});

test("insert / delete rows and columns keep rules, merges and alignment consistent", () => {
  const t = sample();
  G.setBorders(t, sel(0, 0, 2, 2), "all");
  t.colAlign = ["l", "c", "r"];
  G.merge(t, sel(1, 0, 2, 0));       // vertical merge in column A
  G.insertRow(t, 2);                 // inside the merge: it is split
  assert.equal(t.rows, 4);
  assert.equal(t.cells[1][0].rs, 1);
  assert.deepEqual(t.hlines[3], [true, true, true]);
  G.insertCol(t, 1);
  assert.equal(t.cols, 4);
  assert.deepEqual(t.colAlign, ["l", "c", "c", "r"]);
  assert.equal(t.vlines.length, 5);
  G.deleteCol(t, 1); G.deleteRow(t, 2);
  assert.equal(t.rows, 3); assert.equal(t.cols, 3);
  assert.deepEqual(t.colAlign, ["l", "c", "r"]);
  // never below 1×1
  const one = G.create(1, 1);
  G.deleteRow(one, 0); G.deleteCol(one, 0);
  assert.equal(one.rows, 1); assert.equal(one.cols, 1);
});

test("borders: all / outer / inner / none / horizontal", () => {
  const t = G.create(2, 2);
  G.setBorders(t, sel(0, 0, 1, 1), "outer");
  assert.deepEqual(t.hlines, [[true, true], [false, false], [true, true]]);
  assert.deepEqual(t.vlines, [true, false, true]);
  G.setBorders(t, sel(0, 0, 1, 1), "inner");
  assert.deepEqual(t.hlines[1], [true, true]);
  assert.deepEqual(t.vlines, [true, true, true]);
  G.setBorders(t, sel(0, 0, 1, 1), "none");
  assert.ok(t.hlines.flat().every((v) => !v) && t.vlines.every((v) => !v));
  G.setBorders(t, sel(0, 0, 1, 1), "horizontal");
  assert.ok(t.hlines.flat().every(Boolean) && t.vlines.every((v) => !v));
});

test("standard output: rules, bars, partial \\cline, formatting, colours", () => {
  const t = sample();
  G.setBorders(t, sel(0, 0, 2, 2), "all");
  G.toggleFormat(t, sel(0, 0, 0, 2), "b");
  t.cells[1][0].i = true; t.cells[1][0].u = true;
  t.cells[2][0].color = "D92B2B";
  t.cells[0][0].bg = "FFCC00";
  G.merge(t, sel(1, 2, 2, 2));
  const out = G.toLatex(t);
  const L = lines(out.code);
  assert.equal(L[2], "\\begin{tabular}{|l|l|l|}");
  assert.equal(L[3], "\\hline");
  assert.match(L[4], /^\\cellcolor\[HTML\]\{FFCC00\}\\textbf\{Model\} & \\textbf\{Acc\} *& \\textbf\{F1\} \\\\ \\hline$/);
  assert.match(L[5], /\\textit\{\\underline\{Ours\}\}.*\\multirow\{2\}\{\*\}\{0\.8 0\.6\} \\\\ \\cline\{1-2\}$/);
  assert.match(L[6], /^\\textcolor\[HTML\]\{D92B2B\}\{Base\} *& 0\.7 *& {2}\\\\ \\hline$/);
  assert.deepEqual(out.packages, ["multirow", "xcolor", "colortbl"]);
});

test("booktabs output uses rules and drops vertical bars with a note", () => {
  const t = sample();
  G.setBorders(t, sel(0, 0, 2, 2), "outer");
  G.setBorders(t, sel(0, 0, 0, 2), "outer");
  const out = G.toLatex(t, { style: "booktabs" });
  const L = lines(out.code);
  assert.equal(L[2], "\\begin{tabular}{lll}");
  assert.equal(L[3], "\\toprule");
  assert.match(L[4], /\\\\ \\midrule$/);
  assert.match(L[6], /\\\\ \\bottomrule$/);
  assert.deepEqual(out.packages, ["booktabs"]);
  assert.ok(out.notes.some((n) => /vertical/.test(n)));
  G.setBorders(t, sel(1, 1, 1, 2), "horizontal");
  assert.match(G.toLatex(t, { style: "booktabs" }).code, /\\cmidrule\{2-3\}/);
});

test("alignment overrides become \\multicolumn with the column's bars", () => {
  const t = sample();
  t.colAlign = ["l", "c", "c"];
  t.vlines = [true, false, true, true];
  t.cells[1][1].align = "r";
  t.cells[0][0].align = "c";
  const L = lines(G.toLatex(t).code);
  assert.equal(L[2], "\\begin{tabular}{|lc|c|}");
  assert.match(L[3], /^\\multicolumn\{1\}\{\|c\}\{Model\}/);
  assert.match(L[4], /& \\multicolumn\{1\}\{r\|\}\{0\.9\} +&/);  // the bar right of column B
  G.merge(t, sel(2, 0, 2, 1));
  assert.match(G.toLatex(t).code, /\\multicolumn\{2\}\{\|l\|\}\{Base 0\.7\}/);
});

test("merged block spanning rows and columns", () => {
  const t = G.create(3, 3);
  G.pasteGrid(t, [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]]);
  t.cells[0][0].bg = "EEEEEE";
  G.merge(t, sel(0, 0, 1, 1));
  t.cells[0][0].align = "c";
  const L = lines(G.toLatex(t, { layout: "compact" }).code);
  assert.equal(L[3], "\\multicolumn{2}{c}{\\cellcolor[HTML]{EEEEEE}\\multirow{2}{*}{a b d e}} & c \\\\");
  // the row below repeats the column span (and the background) without text
  assert.equal(L[4], "\\multicolumn{2}{c}{\\cellcolor[HTML]{EEEEEE}} & f \\\\");
});

test("escaping is on by default and can be turned off", () => {
  const t = G.create(1, 2);
  G.pasteGrid(t, [["50% & $5_x {y} #1", "a\\b ~^"]]);
  const on = lines(G.toLatex(t).code)[3];
  assert.equal(on, "50\\% \\& \\$5\\_x \\{y\\} \\#1 & a\\textbackslash{}b \\textasciitilde{}\\textasciicircum{}");
  t.cells[0][0].text = "$x^2$";
  assert.match(G.toLatex(t, { escape: false }).code, /\$x\^2\$ & /);
});

test("caption above / below with a label from the caption", () => {
  const t = sample();
  const above = lines(G.toLatex(t, { caption: "above", captionText: "Main results" }).code);
  assert.deepEqual(above.slice(1, 4), ["\\centering", "\\caption{Main results}", "\\label{tab:main-results}"]);
  const below = lines(G.toLatex(t, { caption: "below", label: "tab:x" }).code);
  assert.deepEqual(below.slice(-3), ["\\caption{Caption}", "\\label{tab:x}", "\\end{table}"]);
});

test("width options: wrap (tabularx), scale to text / column width, column widths", () => {
  const t = sample();
  t.colAlign = ["l", "c", "r"];
  const wrap = G.toLatex(t, { width: "wrap" });
  assert.match(wrap.code, /\\begin\{tabularx\}\{\\textwidth\}\{X>\{\\centering\\arraybackslash\}X>\{\\raggedleft\\arraybackslash\}X\}/);
  assert.deepEqual(wrap.packages, ["array", "tabularx"]);
  const sc = G.toLatex(t, { width: "scale-text" });
  assert.match(sc.code, /\\resizebox\{\\textwidth\}\{!\}\{%\n\\begin\{tabular\}/);
  assert.match(sc.code, /\\end\{tabular\}%\n\}\n\\end\{table\}/);
  assert.match(G.toLatex(t, { width: "scale-col" }).code, /\\resizebox\{\\columnwidth\}/);
  t.colWidth[0] = "3cm"; t.colWidth[1] = "2cm";
  assert.match(G.toLatex(t).code, /\{p\{3cm\}>\{\\centering\\arraybackslash\}p\{2cm\}r\}/);
});

test("placement: no centering, landscape float", () => {
  const t = sample();
  assert.ok(!G.toLatex(t, { center: false }).code.includes("\\centering"));
  const ls = G.toLatex(t, { landscape: true });
  assert.match(ls.code, /^\\begin\{sidewaystable\}\n/);
  assert.deepEqual(ls.packages, ["rotating"]);
});

test("long table: no float, caption row, landscape via pdflscape, scaling refused", () => {
  const t = sample();
  G.setBorders(t, sel(0, 0, 2, 2), "outer");
  const lt = G.toLatex(t, { longtable: true, caption: "above", captionText: "Long", width: "scale-text" });
  const L = lines(lt.code);
  assert.equal(L[0], "\\begin{longtable}{|lll|}");
  assert.equal(L[1], "\\caption{Long}\\label{tab:long} \\\\");
  assert.match(L[L.length - 2], /\\\\ \\hline$/);
  assert.ok(!lt.code.includes("resizebox"));
  assert.ok(lt.notes.some((n) => /long table/.test(n)));
  assert.match(G.toLatex(t, { longtable: true, landscape: true }).code, /^\\begin\{landscape\}\n\\begin\{longtable\}/);
});

test("layouts: aligned pads columns, compact does not, smart picks", () => {
  const t = sample();
  const al = lines(G.toLatex(t, { layout: "aligned" }).code);
  assert.equal(al[3], "Model & Acc & F1 \\\\");
  assert.equal(al[4], "Ours  & 0.9 & 0.8 \\\\");
  const co = lines(G.toLatex(t, { layout: "compact" }).code);
  assert.equal(co[4], "Ours & 0.9 & 0.8 \\\\");
  t.cells[0][0].text = "x".repeat(120);
  assert.equal(lines(G.toLatex(t, { layout: "smart" }).code)[4], "Ours & 0.9 & 0.8 \\\\");
});

test("complete document wraps the table with its packages", () => {
  const t = sample();
  G.merge(t, sel(1, 0, 2, 0));
  const L = lines(G.toLatex(t, { document: true, style: "booktabs" }).code);
  assert.deepEqual(L.slice(0, 4), ["\\documentclass{article}", "\\usepackage{booktabs}", "\\usepackage{multirow}", "\\begin{document}"]);
  assert.equal(L[L.length - 1], "\\end{document}");
});

test("TSV and CSV import", () => {
  assert.deepEqual(G.parseTSV("a\tb\r\nc\td\n"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(G.parseCSV('x,"y, z","q ""q"""\n1,2,3\n'), [["x", "y, z", 'q "q"'], ["1", "2", "3"]]);
  assert.deepEqual(G.parseCSV("a;b;c\n1;2;3"), [["a", "b", "c"], ["1", "2", "3"]]);
  assert.deepEqual(G.parseCSV('"multi\nline",x'), [["multi\nline", "x"]]);
  const t = G.fromRows([["a"], ["b", "c", "d"]]);
  assert.equal(t.rows, 2); assert.equal(t.cols, 3);
});

test("paste grows the table and replaces merges it lands on", () => {
  const t = G.create(2, 2);
  G.merge(t, sel(0, 0, 1, 1));
  G.pasteGrid(t, [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]], 0, 0);
  assert.equal(t.rows, 3); assert.equal(t.cols, 3);
  assert.equal(t.cells[0][0].rs, 1);
  assert.equal(t.cells[2][2].text, "9");
});

test("column spec parser", () => {
  const p = G.parseColspec("|l|>{\\centering\\arraybackslash}p{2cm}@{}*{2}{c}|X r");
  assert.deepEqual(p.cols, [
    { align: "l", width: "" }, { align: "c", width: "2cm" }, { align: "c", width: "" },
    { align: "c", width: "" }, { align: "l", width: "" }, { align: "r", width: "" },
  ]);
  assert.deepEqual(p.bars, [true, true, false, false, true, false, false]);
});

test("parse a real-world booktabs table (BERT, arXiv:1810.04805)", () => {
  const src = String.raw`\begin{table}[t]
\begin{center}
\begin{tabular}{@{}lcccc@{}}
  \toprule
  \multicolumn{1}{c}{System} & \multicolumn{2}{c}{Dev} & \multicolumn{2}{c}{Test} \\
  & EM & F1 & EM & F1 \\
  \midrule
  Human & 86.3 & 89.0 & 86.9& 89.5 \\
  \#1 Single - MIR-MRC (F-Net) & - & - & 74.8 & 78.0 \\
  \bottomrule
\end{tabular}
\end{center}
\caption{\label{tab:squad2_results} SQuAD 2.0 results.}
\end{table}`;
  const { table: t, options } = G.parseLatex(src);
  assert.equal(options.style, "booktabs");
  assert.equal(options.caption, "below");
  assert.equal(options.label, "tab:squad2_results");
  assert.equal(options.captionText, "SQuAD 2.0 results.");
  assert.equal(t.rows, 4); assert.equal(t.cols, 5);
  assert.deepEqual(t.colAlign, ["l", "c", "c", "c", "c"]);
  assert.equal(t.cells[0][0].align, "c");
  assert.equal(t.cells[0][1].cs, 2);
  assert.ok(t.cells[0][2].hidden);
  assert.equal(t.cells[3][0].text, "#1 Single - MIR-MRC (F-Net)");
  assert.deepEqual([t.hlines[0], t.hlines[2], t.hlines[4]].map((h) => h.every(Boolean)), [true, true, true]);
  assert.ok(!t.hlines[1].some(Boolean));
});

test("parse lines, multirow, cell colours and formatting", () => {
  const src = String.raw`\begin{tabular}{|l|c|}\hline
\multirow{2}{*}{\textbf{A}} & \cellcolor[HTML]{FFCC00}\textcolor[HTML]{D92B2B}{x} \\ \cline{2-2}
 & \textit{y} \\ \hline
\end{tabular}`;
  const t = G.parseLatex(src).table;
  assert.equal(t.cells[0][0].rs, 2);
  assert.equal(t.cells[0][0].b, true);
  assert.equal(t.cells[0][1].bg, "FFCC00");
  assert.equal(t.cells[0][1].color, "D92B2B");
  assert.equal(t.cells[1][1].i, true);
  assert.equal(t.cells[1][1].text, "y");  // the empty cell under \multirow still takes its &
  assert.deepEqual(t.hlines[1], [false, true]);
  assert.deepEqual(t.vlines, [true, true, true]);
  assert.throws(() => G.parseLatex("no table here"), /no tabular/);
});

test("random tables survive generate → parse → generate unchanged", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const words = ["a", "b c", "3.5", "x & y", "50%", "", "long text here"];
  for (let k = 0; k < 60; k++) {
    const t = G.create(2 + rnd(4), 2 + rnd(4));
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) t.cells[r][c].text = words[rnd(words.length)];
    t.colAlign = t.colAlign.map(() => "lcr"[rnd(3)]);
    for (let n = 0; n < 4; n++) {
      const r0 = rnd(t.rows), c0 = rnd(t.cols);
      const s = sel(r0, c0, Math.min(t.rows - 1, r0 + rnd(2)), Math.min(t.cols - 1, c0 + rnd(2)));
      const op = rnd(7);
      if (op === 0) G.merge(t, s);
      else if (op === 1) G.setBorders(t, s, ["all", "outer", "inner", "none", "horizontal"][rnd(5)]);
      else if (op === 2) G.toggleFormat(t, s, "bi u".split("")[rnd(3)] === " " ? "u" : "bi"[rnd(2)]);
      else if (op === 3) G.setFormat(t, s, "bg", ["", "FFCC00", "EEEEEE"][rnd(3)]);
      else if (op === 4) G.setFormat(t, s, "align", ["", "l", "c", "r"][rnd(4)]);
      else if (op === 5) G.setFormat(t, s, "color", ["", "D92B2B"][rnd(2)]);
    }
    const opts = { style: rnd(2) ? "booktabs" : "standard", caption: ["none", "above", "below"][rnd(3)],
                   captionText: "T & U", layout: "compact" };
    const first = G.toLatex(t, opts).code;
    const back = G.parseLatex(first);
    const again = G.toLatex(back.table, { ...opts, ...back.options }).code;
    assert.equal(again, first, `round trip ${k}:\n${first}`);
  }
});

test("missingPackages reads the preamble (and xcolor[table] provides colortbl)", () => {
  const pre = "\\usepackage{booktabs, multirow}\n% \\usepackage{xcolor}\n\\usepackage[table]{xcolor}\n\\usepackage{tabularx}";
  assert.deepEqual(G.missingPackages(pre, ["booktabs", "xcolor", "colortbl", "array", "graphicx"]), ["graphicx"]);
});

test("column names", () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(G.colName), ["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
});
