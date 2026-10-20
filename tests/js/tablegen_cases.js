// Prints {name: latex} for tests/test_tablegen.py, which runs each through tex2word.
"use strict";
const G = require("../../app/static/tablegen.js");
const sel = (r0, c0, r1, c1) => ({ r0, c0, r1, c1 });

function base() {
  const t = G.create(4, 3);
  G.pasteGrid(t, [["Model", "Acc", "F1"], ["Ours", "0.91", "0.88"], ["Base", "0.72", "0.70"], ["Tiny", "50%", "x & y"]]);
  G.toggleFormat(t, sel(0, 0, 0, 2), "b");
  t.colAlign = ["l", "c", "c"];
  return t;
}

const cases = {};
{ const t = base(); G.setBorders(t, sel(0, 0, 3, 2), "all");
  cases.standard_all_borders = G.toLatex(t, { caption: "above", captionText: "Main results", label: "tab:main" }).code; }
{ const t = base(); G.setBorders(t, sel(0, 0, 3, 2), "outer"); G.setBorders(t, sel(0, 0, 0, 2), "outer");
  cases.booktabs = G.toLatex(t, { style: "booktabs", caption: "below", captionText: "Booktabs" }).code; }
{ const t = base(); G.merge(t, sel(1, 0, 2, 0)); G.merge(t, sel(0, 1, 0, 2)); t.cells[0][1].align = "c";
  t.cells[3][2].bg = "FFCC00"; t.cells[3][1].color = "D92B2B";
  cases.merges_and_colours = G.toLatex(t, { style: "booktabs" }).code; }
{ const t = base(); cases.wrap = G.toLatex(t, { width: "wrap" }).code; }
{ const t = base(); cases.scale = G.toLatex(t, { width: "scale-text" }).code; }
{ const t = base(); cases.longtable = G.toLatex(t, { longtable: true, caption: "above", captionText: "Long" }).code; }
{ const t = base(); cases.landscape = G.toLatex(t, { landscape: true }).code; }
{ const t = base(); t.colWidth = ["3cm", "", "2cm"]; cases.widths = G.toLatex(t, { document: true }).code; }
process.stdout.write(JSON.stringify(cases));
