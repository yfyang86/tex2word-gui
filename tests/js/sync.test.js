// node --test tests/js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../app/static/sync.js");

const A = [  // document order; main.tex includes sec.tex between lines 10 and 12
  { file: "main.tex", line: 5, y: 0 },
  { file: "main.tex", line: 8, y: 100 },
  { file: "sec.tex", line: 1, y: 200 },
  { file: "sec.tex", line: 11, y: 400 },
  { file: "main.tex", line: 12, y: 600 },
];

test("parseSrc maps indices to file names", () => {
  assert.deepEqual(S.parseSrc("1:42", ["a", "b"]), { file: "b", line: 42 });
  assert.equal(S.parseSrc("junk", ["a"]), null);
});

test("editor → preview interpolates between anchors of the same file", () => {
  assert.equal(S.editorToPreview(A, "sec.tex", 6, []).y, 300);
  assert.equal(S.editorToPreview(A, "sec.tex", 1, []).y, 200);
  assert.equal(S.editorToPreview(A, "sec.tex", 50, []).y, 400);  // past the last anchor
  // main.tex line 10 lies between 8 and 12 in main (other files in between are skipped)
  assert.equal(S.editorToPreview(A, "main.tex", 10, []).y, 350);
  assert.equal(S.editorToPreview(A, "main.tex", 1, []).y, 0);     // before the first: first
  assert.equal(S.editorToPreview(A, "nowhere.tex", 3, []), null);
});

test("editor → preview on an \\input line jumps into the included file", () => {
  const inc = [{ file: "main.tex", line: 10, target: "sec.tex" }];
  assert.equal(S.editorToPreview(A, "main.tex", 10, inc).y, 200);
});

test("preview → editor finds the file and interpolates the line", () => {
  assert.deepEqual(S.previewToEditor(A, 300), { file: "sec.tex", line: 6 });
  assert.deepEqual(S.previewToEditor(A, 200), { file: "sec.tex", line: 1 });
  assert.deepEqual(S.previewToEditor(A, 500), { file: "sec.tex", line: 11 }); // no later sec anchor
  assert.deepEqual(S.previewToEditor(A, 650), { file: "main.tex", line: 12 });
  assert.deepEqual(S.previewToEditor(A, -50), { file: "main.tex", line: 5 });
  assert.equal(S.previewToEditor([], 10), null);
});

test("preview → editor never returns a line at or past the next anchor", () => {
  const B = [{ file: "f", line: 1, y: 0 }, { file: "f", line: 3, y: 10 }];
  assert.deepEqual(S.previewToEditor(B, 7.5), { file: "f", line: 2 });  // (2px tolerance near the next anchor)
});

test("planPatch reuses unchanged segments and creates the rest", () => {
  const p = S.planPatch(["a", "b", "c"], [["a", null], ["x", "<p>x</p>"], ["c", null]]);
  assert.deepEqual(p, { take: [0, -1, 2], remove: [1] });
});

test("planPatch handles duplicates, moves and deletions", () => {
  const p = S.planPatch(["a", "a", "b"], [["b", null], ["a", null]]);
  assert.deepEqual(p, { take: [2, 0], remove: [1] });
});

test("planPatch signals lost sync when html is missing for an unknown key", () => {
  assert.equal(S.planPatch(["a"], [["z", null]]), null);
});
