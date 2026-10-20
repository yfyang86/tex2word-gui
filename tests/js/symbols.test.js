// node --test tests/js/*.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../../app/static/symbols.js");
const T = require("../../app/static/complete.js");

const SVG = fs.readFileSync(path.join(__dirname, "../../app/static/symbols.svg"), "utf8");

test("symbol table is well formed", () => {
  assert.ok(S.LIST.length >= 200);
  const seen = new Set();
  for (const s of S.LIST) {
    assert.ok(s.cmd && s.glyph && s.group, JSON.stringify(s));
    assert.ok("mtb".includes(s.where), s.cmd);
    assert.ok(!seen.has(s.cmd), "duplicate " + s.cmd);
    seen.add(s.cmd);
    assert.ok(S.GROUPS.includes(s.group));
  }
});

test("every symbol has a sprite in symbols.svg (regenerate with scripts/build_symbols.py)", () => {
  const ids = new Set([...SVG.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  const missing = S.LIST.map((s) => S.symbolId(s.cmd)).filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
  assert.match(SVG, /SIL Open Font License/);  // font attribution stays with the outlines
});

test("symbolId is unique and URL-fragment safe", () => {
  const ids = S.LIST.map((s) => S.symbolId(s.cmd));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^s-[A-Za-z0-9_]+$/);
  assert.equal(S.symbolId("mathbb{R}"), "s-mathbb_7bR_7d");
});

test("symbols join the completion catalog with their sprite", () => {
  const ix = T.buildIndex({});
  const r = T.complete("$\\impl", 6, ix, {});
  const it = r.items.find((i) => i.label === "\\implies");
  assert.ok(it, "\\implies offered");
  assert.equal(it.sym, "s-implies");
  // math-only symbols rank low in text, text symbols are offered in text
  assert.ok(T.complete("Section \\textreg", 16, ix, {}).items.some((i) => i.label === "\\textregistered"));
  // symbols with arguments keep their snippet
  const sum = T.complete("$\\sum", 5, ix, {}).items.find((i) => i.label === "\\sum");
  assert.equal(sum.insert, "\\sum_{${1:i=1}}^{${2:n}}");
});
