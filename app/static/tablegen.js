// LaTeX table generator — the engine (pure functions, no DOM).
// app/static/tablegen-ui.js is the editor UI; tests/js/tablegen.test.js and
// tests/test_tablegen.py (which runs the output through tex2word) cover it.
//
// Model
//   t = { rows, cols, cells[r][c], colAlign[c] ("l"|"c"|"r"), colWidth[c] ("" | "3cm"),
//         hlines[0..rows][c] (rule above row r, per column), vlines[0..cols] (column bars) }
//   cell = { text, b, i, u, align ("" = column's), color ("" | "RRGGBB"), bg, rs, cs, hidden }
//   A merged range is owned by its top-left cell (rs × cs); the cells it
//   covers are `hidden`.
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TableGen = api;
})(typeof self !== "undefined" ? self : this, function () {
  const blankCell = () => ({ text: "", b: false, i: false, u: false, align: "", color: "", bg: "", rs: 1, cs: 1, hidden: false });

  function create(rows = 4, cols = 5) {
    rows = Math.max(1, rows | 0); cols = Math.max(1, cols | 0);
    return {
      rows, cols,
      cells: Array.from({ length: rows }, () => Array.from({ length: cols }, blankCell)),
      colAlign: Array(cols).fill("l"), colWidth: Array(cols).fill(""),
      hlines: Array.from({ length: rows + 1 }, () => Array(cols).fill(false)),
      vlines: Array(cols + 1).fill(false),
    };
  }

  const clone = (t) => JSON.parse(JSON.stringify(t));

  function norm(sel) {
    return { r0: Math.min(sel.r0, sel.r1), r1: Math.max(sel.r0, sel.r1),
             c0: Math.min(sel.c0, sel.c1), c1: Math.max(sel.c0, sel.c1) };
  }

  // The owner (top-left) of the merge covering (r, c).
  function ownerOf(t, r, c) {
    for (let rr = r; rr >= 0; rr--) {
      for (let cc = c; cc >= 0; cc--) {
        const x = t.cells[rr][cc];
        if (!x.hidden && rr + x.rs > r && cc + x.cs > c) return { r: rr, c: cc };
      }
    }
    return { r, c };
  }

  // Grow a selection until it no longer cuts through a merged range.
  function expand(t, sel) {
    let s = norm(sel), changed = true;
    while (changed) {
      changed = false;
      for (let r = s.r0; r <= s.r1; r++) {
        for (let c = s.c0; c <= s.c1; c++) {
          const o = ownerOf(t, r, c), x = t.cells[o.r][o.c];
          const n = { r0: Math.min(s.r0, o.r), c0: Math.min(s.c0, o.c),
                      r1: Math.max(s.r1, o.r + x.rs - 1), c1: Math.max(s.c1, o.c + x.cs - 1) };
          if (n.r0 !== s.r0 || n.c0 !== s.c0 || n.r1 !== s.r1 || n.c1 !== s.c1) { s = n; changed = true; }
        }
      }
    }
    return s;
  }

  function unmergeAll(t, sel) {
    const s = norm(sel);
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) {
      const x = t.cells[r][c];
      if (!x.hidden && (x.rs > 1 || x.cs > 1)) split(t, r, c);
    }
  }

  function merge(t, sel) {
    const s = expand(t, sel);
    if (s.r0 === s.r1 && s.c0 === s.c1) return t;
    const texts = [];
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) {
      const x = t.cells[r][c];
      if (!x.hidden && x.text.trim()) texts.push(x.text.trim());
    }
    unmergeAll(t, s);
    const owner = t.cells[s.r0][s.c0];
    owner.text = texts.join(" ");
    owner.rs = s.r1 - s.r0 + 1; owner.cs = s.c1 - s.c0 + 1;
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) {
      if (r === s.r0 && c === s.c0) continue;
      Object.assign(t.cells[r][c], blankCell(), { hidden: true });
    }
    return t;
  }

  function split(t, r, c) {
    const o = ownerOf(t, r, c), x = t.cells[o.r][o.c];
    for (let rr = o.r; rr < o.r + x.rs; rr++) for (let cc = o.c; cc < o.c + x.cs; cc++) {
      if (rr !== o.r || cc !== o.c) t.cells[rr][cc] = blankCell();
    }
    x.rs = 1; x.cs = 1;
    return t;
  }

  // Unmerge anything crossing row boundary `at` (between at-1 and at) / column boundary.
  function cutRows(t, at) {
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
      const x = t.cells[r][c];
      if (!x.hidden && x.rs > 1 && r < at && r + x.rs > at) split(t, r, c);
    }
  }
  function cutCols(t, at) {
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
      const x = t.cells[r][c];
      if (!x.hidden && x.cs > 1 && c < at && c + x.cs > at) split(t, r, c);
    }
  }

  function insertRow(t, at) {
    at = Math.max(0, Math.min(t.rows, at));
    cutRows(t, at);
    t.cells.splice(at, 0, Array.from({ length: t.cols }, blankCell));
    // the new row inherits the rule pattern of the row it is inserted next to
    t.hlines.splice(at + 1, 0, t.hlines[at].slice());
    t.rows++;
    return t;
  }

  function deleteRow(t, at) {
    if (t.rows <= 1) return t;
    cutRows(t, at); cutRows(t, at + 1);
    t.cells.splice(at, 1);
    t.hlines.splice(at + 1, 1);
    t.rows--;
    return t;
  }

  function insertCol(t, at) {
    at = Math.max(0, Math.min(t.cols, at));
    cutCols(t, at);
    t.cells.forEach((row) => row.splice(at, 0, blankCell()));
    t.colAlign.splice(at, 0, t.colAlign[Math.min(at, t.cols - 1)] || "l");
    t.colWidth.splice(at, 0, "");
    t.hlines.forEach((h) => h.splice(at, 0, h[Math.min(at, t.cols - 1)] || false));
    t.vlines.splice(at, 0, t.vlines[at]);
    t.cols++;
    return t;
  }

  function deleteCol(t, at) {
    if (t.cols <= 1) return t;
    cutCols(t, at); cutCols(t, at + 1);
    t.cells.forEach((row) => row.splice(at, 1));
    t.colAlign.splice(at, 1); t.colWidth.splice(at, 1);
    t.hlines.forEach((h) => h.splice(at, 1));
    t.vlines.splice(at + 1, 1);
    t.cols--;
    return t;
  }

  function resize(t, rows, cols) {
    while (t.rows < rows) insertRow(t, t.rows);
    while (t.rows > rows && t.rows > 1) deleteRow(t, t.rows - 1);
    while (t.cols < cols) insertCol(t, t.cols);
    while (t.cols > cols && t.cols > 1) deleteCol(t, t.cols - 1);
    return t;
  }

  // Visible (owner) cells of a selection.
  function eachCell(t, sel, fn) {
    const s = norm(sel);
    for (let r = s.r0; r <= s.r1; r++) for (let c = s.c0; c <= s.c1; c++) {
      if (!t.cells[r][c].hidden) fn(t.cells[r][c], r, c);
    }
  }

  function setFormat(t, sel, key, value) {
    eachCell(t, sel, (x) => { x[key] = value; });
    return t;
  }

  function toggleFormat(t, sel, key) {
    let all = true;
    eachCell(t, sel, (x) => { if (!x[key]) all = false; });
    return setFormat(t, sel, key, !all);
  }

  function clearFormat(t, sel) {
    eachCell(t, sel, (x) => Object.assign(x, { b: false, i: false, u: false, align: "", color: "", bg: "" }));
    return t;
  }

  // Borders on a selection: "all" | "outer" | "inner" | "none" | "horizontal".
  function setBorders(t, sel, mode) {
    const s = norm(sel);
    for (let r = s.r0; r <= s.r1 + 1; r++) {
      const outer = r === s.r0 || r === s.r1 + 1;
      for (let c = s.c0; c <= s.c1; c++) {
        if (mode === "none") t.hlines[r][c] = false;
        else if (mode === "all" || mode === "horizontal") t.hlines[r][c] = true;
        else if (mode === "outer" && outer) t.hlines[r][c] = true;
        else if (mode === "inner" && !outer) t.hlines[r][c] = true;
      }
    }
    if (mode === "horizontal") return t;
    // vertical rules are whole-column in LaTeX (the column spec)
    for (let c = s.c0; c <= s.c1 + 1; c++) {
      const outer = c === s.c0 || c === s.c1 + 1;
      if (mode === "none") t.vlines[c] = false;
      else if (mode === "all") t.vlines[c] = true;
      else if (mode === "outer" && outer) t.vlines[c] = true;
      else if (mode === "inner" && !outer) t.vlines[c] = true;
    }
    return t;
  }

  function transpose(t) {
    const u = create(t.cols, t.rows);
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
      const x = { ...t.cells[r][c] };
      if (!x.hidden) { const rs = x.rs; x.rs = x.cs; x.cs = rs; }
      u.cells[c][r] = x;
    }
    for (let r = 0; r <= t.rows; r++) for (let c = 0; c < t.cols; c++) {
      // a rule above row r becomes a bar left of column r
      if (t.hlines[r][c]) u.vlines[r] = true;
    }
    for (let c = 0; c <= t.cols; c++) if (t.vlines[c]) u.hlines[c].fill(true);
    return u;
  }

  // Paste a block of text rows at (r, c), growing the table to fit.
  function pasteGrid(t, rows, r = 0, c = 0) {
    const h = rows.length, w = Math.max(0, ...rows.map((x) => x.length));
    if (!h || !w) return t;
    resize(t, Math.max(t.rows, r + h), Math.max(t.cols, c + w));
    unmergeAll(t, { r0: r, c0: c, r1: r + h - 1, c1: c + w - 1 });
    rows.forEach((row, i) => row.forEach((text, j) => { t.cells[r + i][c + j].text = text; }));
    return t;
  }

  function fromRows(rows) {
    const t = create(Math.max(1, rows.length), Math.max(1, ...rows.map((x) => x.length)));
    return pasteGrid(t, rows, 0, 0);
  }

  // ── Import ──────────────────────────────────────────────────────────────
  function parseTSV(text) {
    const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
    return lines.map((l) => l.split("\t"));
  }

  function parseCSV(text, delim) {
    const src = text.replace(/\r\n?/g, "\n");
    const d = delim || (src.split("\n")[0].split(";").length > src.split("\n")[0].split(",").length ? ";" : ",");
    const rows = [[]];
    let cur = "", q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"' && cur === "") q = true;
      else if (ch === d) { rows[rows.length - 1].push(cur); cur = ""; }
      else if (ch === "\n") { rows[rows.length - 1].push(cur); cur = ""; rows.push([]); }
      else cur += ch;
    }
    rows[rows.length - 1].push(cur);
    if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
    return rows;
  }

  // Split at depth-0 occurrences of a token (respects {…} groups and \-escapes).
  function splitTop(s, token) {
    const out = [];
    let depth = 0, last = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\") {
        if (token === "\\\\" && s[i + 1] === "\\" && depth === 0) {
          out.push(s.slice(last, i)); i++;
          // skip an optional [2pt] after \\
          const m = /^\s*\[[^\]]*\]/.exec(s.slice(i + 1));
          if (m) i += m[0].length;
          last = i + 1;
          continue;
        }
        i++;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === token && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
    }
    out.push(s.slice(last));
    return out;
  }

  function group(s, i) {  // {…} starting at s[i] (after whitespace)
    while (/\s/.test(s[i] || "")) i++;
    if (s[i] !== "{") return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
    }
    return null;
  }

  function optional(s, i) {  // […] at s[i] (after whitespace)
    while (/\s/.test(s[i] || "")) i++;
    if (s[i] !== "[") return null;
    const j = s.indexOf("]", i);
    return j < 0 ? null : { value: s.slice(i + 1, j), end: j + 1 };
  }

  // Column spec → {cols: [{align, width}], bars: [bool × (n+1)]}.
  // Understands l c r p{} m{} b{} X, | bars, >{\centering…} prefixes,
  // @{}/!{}/<{} (ignored) and *{n}{…} repetition.
  function parseColspec(spec) {
    const s = spec.replace(/\*\{(\d+)\}\{([^{}]*)\}/g, (_, n, x) => x.repeat(+n));
    const cols = [], bars = [false];
    let pending = "";
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (ch === "|") { bars[cols.length] = true; i++; continue; }
      if (">@!<".includes(ch)) {
        const g = group(s, i + 1);
        if (ch === ">" && g) pending = /\\centering/.test(g.value) ? "c" : /\\raggedleft/.test(g.value) ? "r" : pending;
        i = g ? g.end : i + 1;
        continue;
      }
      if ("lcrX".includes(ch) || "pmb".includes(ch)) {
        let width = "";
        i++;
        if ("pmb".includes(ch)) { const g = group(s, i); if (g) { width = g.value.trim(); i = g.end; } }
        cols.push({ align: pending || (ch === "c" || ch === "r" ? ch : "l"), width });
        pending = "";
        bars[cols.length] = false;
        continue;
      }
      i++;
    }
    for (let k = 0; k <= cols.length; k++) bars[k] = !!bars[k];
    return { cols, bars };
  }

  const UNESCAPE = [[/\\textbackslash\{\}/g, "\\"], [/\\textasciitilde\{\}/g, "~"], [/\\textasciicircum\{\}/g, "^"],
                    [/\\([&%$#_{}])/g, "$1"]];

  // Parse a LaTeX table (a table float, longtable, tabular, tabularx, …) → {table, options}
  function parseLatex(src) {
    const opts = {};
    const cap = /\\caption\s*(?:\[[^\]]*\])?\s*\{/.exec(src);
    if (cap) { const g = group(src, cap.index + cap[0].length - 1); if (g) opts.captionText = unescape(g.value.replace(/\\label\{[^}]*\}/, "").trim()); }
    const lab = /\\label\{([^}]*)\}/.exec(src);
    if (lab) opts.label = lab[1];
    const envm = /\\begin\{(tabularx|tabular\*|tabular|longtable|tabu|array)\}/.exec(src);
    if (!envm) throw new Error("no tabular / longtable environment found");
    const env = envm[1];
    let i = envm.index + envm[0].length;
    if (env === "tabularx" || env === "tabular*") { const w = group(src, i); if (w) i = w.end; opts.width = "wrap"; }
    if (env === "longtable") { opts.longtable = true; const o = optional(src, i); if (o) i = o.end; }
    const o2 = optional(src, i);
    if (o2) i = o2.end;
    const specG = group(src, i);
    if (!specG) throw new Error("missing column specification");
    const endIdx = src.indexOf(`\\end{${env}}`, specG.end);
    let body = src.slice(specG.end, endIdx < 0 ? src.length : endIdx);
    if (env === "longtable") body = body.replace(/\\caption\s*(?:\[[^\]]*\])?\s*\{[^}]*\}\s*(\\label\{[^}]*\})?\s*\\\\/g, "")
      .replace(/\\end(firsthead|head|foot|lastfoot)/g, "");
    const { cols, bars } = parseColspec(specG.value);
    if (/\\(toprule|midrule|bottomrule|cmidrule)/.test(body)) opts.style = "booktabs";
    if (/\\resizebox\s*\{\\textwidth\}/.test(src)) opts.width = "scale-text";
    if (/\\resizebox\s*\{\\columnwidth\}/.test(src)) opts.width = "scale-col";
    if (/\\begin\{(sidewaystable|landscape)\}/.test(src)) opts.landscape = true;
    if (cap) opts.caption = cap.index < envm.index ? "above" : "below";

    const rawRows = splitTop(body, "\\\\");
    const rows = [];  // [{cells:[…], before:[bool per col] }]
    const ruleRe = /^\s*(\\hline|\\toprule|\\midrule|\\bottomrule|\\cline\s*\{(\d+)-(\d+)\}|\\cmidrule\s*(?:\([^)]*\))?\s*\{(\d+)-(\d+)\})/;
    let pending = null;
    const ncol = Math.max(1, cols.length);
    const takeRules = (s) => {
      const segs = Array(ncol).fill(false);
      let m;
      while ((m = ruleRe.exec(s))) {
        if (m[2] || m[4]) { for (let k = +(m[2] || m[4]) - 1; k < +(m[3] || m[5]); k++) if (k < ncol) segs[k] = true; }
        else segs.fill(true);
        s = s.slice(m[0].length);
      }
      return { segs, rest: s };
    };
    for (const rr of rawRows) {
      const { segs, rest } = takeRules(rr);
      pending = pending ? pending.map((v, k) => v || segs[k]) : segs;
      if (!rest.trim()) continue;  // only rules: they belong above the next row
      rows.push({ text: rest, before: pending });
      pending = null;
    }
    const after = pending || Array(ncol).fill(false);

    const t = create(Math.max(1, rows.length), ncol);
    cols.forEach((cd, c) => { t.colAlign[c] = cd.align; t.colWidth[c] = cd.width; });
    t.vlines = bars.slice(0, ncol + 1);
    while (t.vlines.length < ncol + 1) t.vlines.push(false);
    rows.forEach((row, r) => { t.hlines[r] = row.before.slice(); });
    t.hlines[rows.length] = after.slice();
    const covered = new Set();  // "r,c" covered by a multirow from above
    rows.forEach((row, r) => {
      let c = 0;
      for (let raw of splitTop(row.text, "&")) {
        if (c >= ncol) break;
        raw = raw.trim();
        let m = /^\\multicolumn\s*\{(\d+)\}/.exec(raw);
        if (covered.has(`${r},${c}`)) {  // under a \multirow: an empty placeholder cell
          c += m ? +m[1] : 1;
          continue;
        }
        const cell = t.cells[r][c];
        let cs = 1, rs = 1;
        if (m) {
          cs = +m[1];
          const sp = group(raw, m[0].length), ct = sp && group(raw, sp.end);
          const pc = sp ? parseColspec(sp.value).cols[0] : null;
          if (pc && pc.align !== t.colAlign[c]) cell.align = pc.align;
          raw = ct ? ct.value.trim() : "";
        }
        raw = takeCellFormat(raw, cell);
        m = /^\\multirow\s*(?:\[[^\]]*\])?\s*\{(-?\d+)\}\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/.exec(raw);
        if (m) {
          rs = Math.abs(+m[1]);
          const ct = group(raw, m[0].length);
          raw = ct ? ct.value.trim() : "";
        }
        raw = takeCellFormat(raw, cell);
        cell.text = unescape(raw);
        if (rs > 1 || cs > 1) {
          const rr = Math.min(rs, t.rows - r), cc = Math.min(cs, ncol - c);
          if (rr > 1 || cc > 1) {
            const bg = cell.bg, keep = { ...cell };
            merge(t, { r0: r, c0: c, r1: r + rr - 1, c1: c + cc - 1 });
            Object.assign(t.cells[r][c], keep, { rs: rr, cs: cc, hidden: false });
            t.cells[r][c].bg = bg;
            for (let a = r + 1; a < r + rr; a++) for (let b = c; b < c + cc; b++) covered.add(`${a},${b}`);
          }
        }
        c += cs;
      }
    });
    return { table: t, options: opts };
  }

  function takeCellFormat(raw, cell) {
    let m, again = true;
    while (again) {
      again = false;
      raw = raw.trim();
      if ((m = /^\\cellcolor\s*(?:\[HTML\])?\s*\{([0-9A-Fa-f]{6}|[a-zA-Z]+)\}/.exec(raw))) {
        cell.bg = /^[0-9A-Fa-f]{6}$/.test(m[1]) ? m[1].toUpperCase() : (NAMED[m[1]] || "");
        raw = raw.slice(m[0].length); again = true; continue;
      }
      for (const [cmd, key] of [["textbf", "b"], ["textit", "i"], ["emph", "i"], ["underline", "u"]]) {
        const re = new RegExp(`^\\\\${cmd}\\s*\\{`);
        if (re.test(raw)) {
          const g = group(raw, raw.indexOf("{"));
          if (g && g.end === raw.length) { cell[key] = true; raw = g.value; again = true; }
        }
      }
      if ((m = /^\\textcolor\s*(?:\[HTML\])?\s*\{([0-9A-Fa-f]{6}|[a-zA-Z]+)\}/.exec(raw))) {
        const g = group(raw, m[0].length);
        if (g && g.end === raw.length) {
          cell.color = /^[0-9A-Fa-f]{6}$/.test(m[1]) ? m[1].toUpperCase() : (NAMED[m[1]] || "");
          raw = g.value; again = true;
        }
      }
    }
    return raw.trim();
  }

  function unescape(s) {
    for (const [re, rep] of UNESCAPE) s = s.replace(re, rep);
    return s;
  }

  const NAMED = { red: "FF0000", green: "00FF00", blue: "0000FF", yellow: "FFFF00", black: "000000",
                  white: "FFFFFF", gray: "808080", orange: "FF8000", cyan: "00FFFF", magenta: "FF00FF" };

  // ── Export ──────────────────────────────────────────────────────────────
  const DEFAULTS = {
    style: "standard",        // "standard" | "booktabs"
    caption: "none",          // "none" | "above" | "below"
    captionText: "", label: "",
    center: true, landscape: false,
    width: "natural",         // "natural" | "wrap" | "scale-text" | "scale-col"
    longtable: false,
    document: false, escape: true,
    layout: "aligned",        // "aligned" | "compact" | "smart"
    position: "htbp",
  };

  function escapeTex(s) {
    return s.replace(/[\\&%$#_{}~^]/g, (ch) => ({
      "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
    })[ch] || "\\" + ch);
  }

  function slug(s) {
    return s.toLowerCase().replace(/\\[a-z]+/g, " ").replace(/[^a-z0-9]+/g, " ").trim()
      .split(" ").filter(Boolean).slice(0, 3).join("-");
  }

  function alignedSpec(align, width, wrapX) {
    const pre = { c: "\\centering", r: "\\raggedleft", l: "" }[align] || "";
    if (width) return pre ? `>{${pre}\\arraybackslash}p{${width}}` : `p{${width}}`;
    if (wrapX) return pre ? `>{${pre}\\arraybackslash}X` : "X";
    return align || "l";
  }

  // LaTeX for a table → {code, packages: [name…], notes: [string…]}
  function toLatex(t, options) {
    const o = { ...DEFAULTS, ...(options || {}) };
    const bt = o.style === "booktabs";
    const wrap = o.width === "wrap" && !o.longtable;
    const scale = (o.width === "scale-text" || o.width === "scale-col") && !o.longtable;
    const pk = new Set(), notes = [];
    if (bt) pk.add("booktabs");
    const bar = (j) => (!bt && t.vlines[j] ? "|" : "");

    let spec = bar(0);
    for (let c = 0; c < t.cols; c++) {
      spec += alignedSpec(t.colAlign[c], t.colWidth[c], wrap) + bar(c + 1);
      if ((t.colWidth[c] && t.colAlign[c] !== "l") || (wrap && !t.colWidth[c] && t.colAlign[c] !== "l")) pk.add("array");
    }
    if (bt && t.vlines.some(Boolean)) notes.push("Booktabs tables have no vertical rules; they were left out.");
    if (o.longtable && (o.width === "scale-text" || o.width === "scale-col" || o.width === "wrap")) {
      notes.push("A long table cannot be scaled or wrapped to the text width; natural width is used.");
    }

    // which (r, c) belong to a vertical merge that crosses the rule above row r
    const crossed = (r, c) => {
      if (r === 0 || r === t.rows) return false;
      const a = ownerOf(t, r - 1, c), b = ownerOf(t, r, c);
      return a.r === b.r && a.c === b.c;
    };
    const ruleLine = (r) => {
      const segs = t.hlines[r].map((v, c) => v && !crossed(r, c));
      if (!segs.some(Boolean)) return "";
      if (segs.every(Boolean)) return bt ? (r === 0 ? "\\toprule" : r === t.rows ? "\\bottomrule" : "\\midrule") : "\\hline";
      const out = [];
      for (let c = 0; c < t.cols; c++) {
        if (!segs[c]) continue;
        let e = c;
        while (e + 1 < t.cols && segs[e + 1]) e++;
        out.push(`${bt ? "\\cmidrule" : "\\cline"}{${c + 1}-${e + 1}}`);
        c = e;
      }
      return out.join(" ");
    };

    const content = (x) => {
      let s = o.escape ? escapeTex(x.text) : x.text;
      if (s && x.u) s = `\\underline{${s}}`;
      if (s && x.i) s = `\\textit{${s}}`;
      if (s && x.b) s = `\\textbf{${s}}`;
      if (s && x.color) { s = `\\textcolor[HTML]{${x.color}}{${s}}`; pk.add("xcolor"); }
      return s;
    };
    const bg = (x) => {
      if (!x.bg) return "";
      pk.add("xcolor"); pk.add("colortbl");
      return `\\cellcolor[HTML]{${x.bg}}`;
    };

    const rowsOut = [];  // per row: [{text, span}]
    for (let r = 0; r < t.rows; r++) {
      const cells = [];
      for (let c = 0; c < t.cols; c++) {
        const own = ownerOf(t, r, c), x = t.cells[own.r][own.c];
        if (own.c !== c) continue;  // covered horizontally by a multicolumn
        const top = own.r === r;
        let s = top ? content(x) : "";
        if (top && x.rs > 1) { s = `\\multirow{${x.rs}}{*}{${s}}`; pk.add("multirow"); }
        s = bg(x) + s;
        const align = x.align || t.colAlign[c];
        if (x.cs > 1 || (x.align && x.align !== t.colAlign[c])) {
          const ms = (c === 0 ? bar(0) : "") + (x.cs > 1 || !t.colWidth[c] ? align : alignedSpec(align, t.colWidth[c], false)) + bar(c + x.cs);
          s = `\\multicolumn{${x.cs}}{${ms}}{${s}}`;
        }
        cells.push(s);
      }
      rowsOut.push(cells);
    }

    // layout: pad columns when aligned (cells line up by position)
    let layout = o.layout;
    const compactRows = rowsOut.map((cells) => cells.join(" & "));
    if (layout === "smart") layout = compactRows.some((l) => l.length > 100) ? "compact" : "aligned";
    let lines;
    if (layout === "aligned") {
      const w = [];
      rowsOut.forEach((cells) => cells.forEach((s, k) => { w[k] = Math.max(w[k] || 0, s.length); }));
      lines = rowsOut.map((cells) => cells.map((s, k) => (k === cells.length - 1 ? s : s.padEnd(w[k]))).join(" & "));
    } else {
      lines = compactRows;
    }

    const body = [];
    const first = ruleLine(0);
    if (first) body.push(first);
    lines.forEach((line, r) => {
      const last = r === t.rows - 1;
      const rule = ruleLine(r + 1);
      const end = last && !rule && !o.longtable ? "" : " \\\\";
      body.push(line + end + (rule ? " " + rule : ""));
    });

    const cap = o.captionText || "Caption";
    const label = o.label || (o.captionText ? "tab:" + slug(o.captionText) : "tab:my-label");
    const capLines = [`\\caption{${o.escape ? escapeTex(cap) : cap}}`, `\\label{${label}}`];
    const out = [];
    if (o.longtable) {
      pk.add("longtable");
      if (o.landscape) { pk.add("pdflscape"); out.push("\\begin{landscape}"); }
      out.push(`\\begin{longtable}{${spec}}`);
      if (o.caption === "above") out.push(capLines.join("") + " \\\\");
      out.push(...body);
      if (o.caption === "below") out.push(capLines.join("") + " \\\\");
      out.push("\\end{longtable}");
      if (o.landscape) out.push("\\end{landscape}");
    } else {
      const fl = o.landscape ? "sidewaystable" : "table";
      if (o.landscape) pk.add("rotating");
      out.push(`\\begin{${fl}}` + (o.landscape ? "" : `[${o.position}]`));
      if (o.center) out.push("\\centering");
      if (o.caption === "above") out.push(...capLines);
      let open = wrap ? `\\begin{tabularx}{\\textwidth}{${spec}}` : `\\begin{tabular}{${spec}}`;
      let close = wrap ? "\\end{tabularx}" : "\\end{tabular}";
      if (wrap) pk.add("tabularx");
      if (scale) {
        pk.add("graphicx");
        out.push(`\\resizebox{${o.width === "scale-text" ? "\\textwidth" : "\\columnwidth"}}{!}{%`);
        close += "%\n}";
      }
      out.push(open, ...body, close);
      if (o.caption === "below") out.push(...capLines);
      out.push(`\\end{${fl}}`);
    }

    // packages in a stable order
    const ORDER = ["booktabs", "multirow", "array", "tabularx", "graphicx", "xcolor", "colortbl", "longtable", "rotating", "pdflscape"];
    const packages = ORDER.filter((p) => pk.has(p));
    let code = out.join("\n");
    if (o.document) {
      code = ["\\documentclass{article}", ...packages.map((p) => `\\usepackage{${p}}`), "\\begin{document}", "", code, "", "\\end{document}"].join("\n");
    }
    return { code: code + "\n", packages, notes };
  }

  // Which of `packages` the preamble does not load yet.
  function missingPackages(preamble, packages) {
    const code = (preamble || "").replace(/(^|[^\\])%.*$/gm, "$1");
    const loaded = new Set();
    for (const m of code.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
      m[2].split(",").forEach((p) => loaded.add(p.trim()));
      if (/\btable\b/.test(m[1] || "") && m[2].includes("xcolor")) loaded.add("colortbl");
    }
    if (loaded.has("tabularx")) loaded.add("array");  // tabularx loads array
    return packages.filter((p) => !loaded.has(p));
  }

  function colName(c) {
    let s = "";
    c += 1;
    while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }

  return {
    create, clone, norm, ownerOf, expand, merge, split, insertRow, deleteRow, insertCol, deleteCol,
    resize, setFormat, toggleFormat, clearFormat, setBorders, transpose, pasteGrid, fromRows,
    parseTSV, parseCSV, parseLatex, parseColspec, toLatex, missingPackages, escapeTex, colName, DEFAULTS,
  };
});
