"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../../app/static/bib.js");

const E = (key, o = {}) => ({
  key, type: o.type || "article", line: o.line || 1, cited: o.cited || 0,
  display: { author_list: o.author || "", title: o.title || "", year: o.year || "", venue: o.venue || "" },
  fields: Object.entries(o.fields || {}).map(([name, value]) => ({ name, value })),
});

const lib = [
  E("lecun2015", { author: "LeCun, Bengio, Hinton", title: "Deep learning", year: "2015", venue: "Nature", line: 1, cited: 2 }),
  E("vaswani", { author: "Vaswani, Shazeer", title: "Attention Is All You Need", year: "2017", type: "misc", line: 9,
    fields: { eprint: "1706.03762" } }),
  E("schroedinger", { author: "Schrödinger", title: "Quantisierung", year: "", line: 20 }),
];

test("search: words, fields, quotes, accents", () => {
  const hits = (q) => lib.filter((e) => B.match(e, q)).map((e) => e.key);
  assert.deepEqual(hits(""), ["lecun2015", "vaswani", "schroedinger"]);
  assert.deepEqual(hits("deep nature"), ["lecun2015"]);
  assert.deepEqual(hits("author:hinton"), ["lecun2015"]);
  assert.deepEqual(hits("year:2017"), ["vaswani"]);
  assert.deepEqual(hits('"all you"'), ["vaswani"]);
  assert.deepEqual(hits("schrodinger"), ["schroedinger"]);
  assert.deepEqual(hits("1706.03762"), ["vaswani"]);
  assert.deepEqual(hits("eprint:1706"), ["vaswani"]);
  assert.deepEqual(hits("type:misc"), ["vaswani"]);
  assert.deepEqual(hits("deep author:vaswani"), []);
});

test("sort by column, empties last, stable by line", () => {
  assert.deepEqual(B.sort(lib, "year", "asc").map((e) => e.key), ["lecun2015", "vaswani", "schroedinger"]);
  assert.deepEqual(B.sort(lib, "year", "desc").map((e) => e.key), ["vaswani", "lecun2015", "schroedinger"]);
  assert.deepEqual(B.sort(lib, "title", "asc").map((e) => e.key), ["vaswani", "lecun2015", "schroedinger"]);
  assert.deepEqual(B.sort(lib, "cited", "desc")[0].key, "lecun2015");
});

test("citeEdit: new command, or join an open \\cite", () => {
  assert.deepEqual(B.citeEdit("See .", 4, 4, ["a"], "citep"), { from: 4, to: 4, insert: "\\citep{a}", joined: false });
  const t = "See \\cite{x} now";
  assert.deepEqual(B.citeEdit(t, 11, 11, ["y", "z"], "cite"), { from: 11, to: 11, insert: ",y,z", joined: true });
  assert.equal(B.citeEdit(t, 11, 11, ["x"], "cite"), null);           // already cited there
  const empty = "\\citep[p.~2]{}";
  assert.equal(B.citeEdit(empty, 13, 13, ["k"]).insert, "k");
  const sel = "replace ME please";
  assert.deepEqual(B.citeEdit(sel, 8, 10, ["k"], "cite"), { from: 8, to: 10, insert: "\\cite{k}", joined: false });
});

test("keyToQuery and field groups", () => {
  assert.equal(B.keyToQuery("vaswani2017attention"), "vaswani 2017 attention");
  assert.equal(B.keyToQuery("LeCun15:deep_nets"), "Le Cun 15 deep nets");
  const spec = { article: { required: ["author", "title", "journal", "year/date"], optional: ["volume", "doi"] } };
  assert.deepEqual(B.fieldGroups("article", spec, ["title", "doi", "keywords"]), {
    required: [["author"], ["title"], ["journal"], ["year", "date"]], optional: ["volume", "doi"], other: ["keywords"] });
  assert.deepEqual(B.fieldGroups("weird", spec, ["x"]), { required: [], optional: [], other: ["x"] });
});
