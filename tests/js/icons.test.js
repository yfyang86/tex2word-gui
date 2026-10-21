// node --test tests/js/*.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../../app/static/icons.js");

test("kindOf: by extension, case-insensitive, with a fallback", () => {
  const cases = { "main.tex": "tex", "a/B.TEX": "tex", "refs.bib": "bib", "x.bbl": "bib", "my.sty": "sty", "ieee.cls": "sty",
    "README.md": "md", "fig.tikz": "tikz", "f/plot.PNG": "image", "x.svg": "image", "draw.pdf": "pdf", "a.eps": "pdf",
    "data.csv": "data", "notes.txt": "text", "Makefile": "file", ".latexmkrc": "file", "noext.": "file" };
  for (const [path, kind] of Object.entries(cases)) assert.equal(I.kindOf(path), kind, path);
});

test("svg: one glyph per kind, coloured by class, unknown kinds fall back", () => {
  for (const kind of [...Object.keys(I.KINDS), "file", "folder", "folder-open"]) {
    const s = I.svg(kind, 16);
    assert.match(s, new RegExp(`class="ft-icon ft-${kind}"`));
    assert.match(s, /width="16" height="16"/);
    assert.match(s, /stroke="currentColor"/);
  }
  assert.equal(I.svg("nope").includes("ft-nope"), true);
  assert.equal(I.forPath("a.bib").includes("ft-bib"), true);
});

test("label: a readable name for every kind", () => {
  for (const kind of Object.keys(I.KINDS)) assert.ok(I.label(kind).length > 2, kind);
  assert.equal(I.label("whatever"), "File");
});
