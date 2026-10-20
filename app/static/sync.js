// Source ⇄ preview sync and segment patching — pure helpers (no DOM access),
// shared by app.js and the node unit tests (tests/js/sync.test.js).
//
// The server tags the preview with sync anchors: elements carrying
// data-src="<fileIndex>:<line>" (1-based line) placed at the start of text
// lines, headings, list items, captions and display blocks, across every file
// pulled in by \input/\include. These helpers turn those anchors into
// positions: editor (file, line) → preview y, and preview y → (file, line).
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TexSync = api;
})(typeof self !== "undefined" ? self : this, function () {
  function parseSrc(value, files) {
    const m = /^(\d+):(\d+)$/.exec(value || "");
    if (!m) return null;
    const fi = +m[1];
    return { file: files ? files[fi] : fi, line: +m[2] };
  }

  // Anchors of one file sorted by line (stable: document order breaks ties).
  function forFile(anchors, file) {
    return anchors
      .map((a, i) => ({ ...a, order: i }))
      .filter((a) => a.file === file)
      .sort((a, b) => a.line - b.line || a.order - b.order);
  }

  // Editor → preview. `anchors`: [{file, line, y}] in document order;
  // `includes`: [{file, line, target}] (an \input on that line).
  // Returns the y to scroll to (plus the anchor used), or null.
  function editorToPreview(anchors, file, line, includes) {
    const inc = (includes || []).find((e) => e.file === file && e.line === line);
    if (inc) {
      const first = forFile(anchors, inc.target)[0];
      if (first) return { y: first.y, anchor: first };
    }
    const list = forFile(anchors, file);
    if (!list.length) return null;
    let lo = null, hi = null;
    for (const a of list) {
      if (a.line <= line) lo = a;
      else { hi = a; break; }
    }
    if (!lo) return { y: hi.y, anchor: hi };
    if (hi && hi.y > lo.y && hi.line > lo.line) {
      const frac = (line - lo.line) / (hi.line - lo.line);
      return { y: lo.y + frac * (hi.y - lo.y), anchor: lo };
    }
    return { y: lo.y, anchor: lo };
  }

  // Preview → editor. `anchors`: [{file, line, y}] (any order); `y`: the click.
  // Picks the nearest anchor at or above the click and interpolates towards
  // the next anchor below it in the same file.
  function previewToEditor(anchors, y) {
    if (!anchors.length) return null;
    let lo = null;
    for (const a of anchors) {
      if (a.y <= y + 2 && (!lo || a.y >= lo.y)) lo = a;
    }
    if (!lo) {  // above the first anchor: the first one
      lo = anchors.reduce((m, a) => (a.y < m.y ? a : m), anchors[0]);
      return { file: lo.file, line: lo.line };
    }
    let hi = null;
    for (const a of anchors) {
      if (a.file === lo.file && a.line > lo.line && a.y > lo.y && (!hi || a.y < hi.y)) hi = a;
    }
    let line = lo.line;
    if (hi) {
      const frac = Math.max(0, Math.min(1, (y - lo.y) / (hi.y - lo.y)));
      line = Math.min(hi.line - 1, lo.line + Math.floor(frac * (hi.line - lo.line)));
      line = Math.max(lo.line, line);
    }
    return { file: lo.file, line };
  }

  // Segment patching. `oldKeys`: keys of the segments currently shown, in
  // order; `segments`: the new [[key, html|null], …]. Returns, per new
  // segment, the old index to reuse or -1 (create from html), and the old
  // indices no longer used. null → html is missing for an unknown key (the
  // client lost sync; ask for a full render).
  function planPatch(oldKeys, segments) {
    const pool = new Map();
    oldKeys.forEach((k, i) => {
      if (!pool.has(k)) pool.set(k, []);
      pool.get(k).push(i);
    });
    const take = [];
    for (const [key, html] of segments) {
      const q = pool.get(key);
      if (q && q.length) take.push(q.shift());
      else if (html == null) return null;
      else take.push(-1);
    }
    const used = new Set(take.filter((i) => i >= 0));
    const remove = oldKeys.map((_, i) => i).filter((i) => !used.has(i));
    return { take, remove };
  }

  return { parseSrc, forFile, editorToPreview, previewToEditor, planPatch };
});
