// Table generator dialog (engine: tablegen.js). Opened from the left panel's
// Tools section. A spreadsheet-like grid with menus, a toolbar, keyboard and
// clipboard support, live LaTeX output and the output options; "Insert into
// editor" puts the table at the cursor (or replaces the table it was loaded
// from) and adds missing \usepackage lines to the preamble.
//
// Keys in the grid: arrows move (Shift extends) · Tab / Shift+Tab next /
// previous cell · Enter or F2 edit, typing replaces · Delete clears ·
// Ctrl/Cmd+B/I/U format · Ctrl/Cmd+Z / Shift+Z or Y undo / redo ·
// Ctrl/Cmd+A select all · Ctrl/Cmd+C/X/V copy, cut, paste (spreadsheet cells,
// CSV or a LaTeX table) · Esc cancels an edit, closes a menu, then the dialog.
"use strict";

const TG_STORE = "tw_tablegen";
const TG = {
  t: null, opts: null, sel: null, anchor: null, editing: null,
  history: [], future: [], source: null, addPackages: true, dragging: false,
};

const TG_ICONS = {
  alignL: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignC: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignR: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 5h8M6 19h8M14 5l-4 14"/>',
  underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>',
  bAll: '<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16M12 4v16"/>',
  bOuter: '<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16M12 4v16" stroke-dasharray="1.5 2.5" opacity=".5"/>',
  bInner: '<rect x="4" y="4" width="16" height="16" stroke-dasharray="1.5 2.5" opacity=".5"/><path d="M4 12h16M12 4v16"/>',
  bHoriz: '<path d="M4 4h16M4 12h16M4 20h16"/><path d="M4 4v16M12 4v16M20 4v16" stroke-dasharray="1.5 2.5" opacity=".5"/>',
  bNone: '<rect x="4" y="4" width="16" height="16" stroke-dasharray="1.5 2.5" opacity=".5"/><path d="M4 12h16M12 4v16" stroke-dasharray="1.5 2.5" opacity=".5"/>',
  merge: '<rect x="3" y="5" width="18" height="14"/><path d="M8 12h8M10 9l-3 3 3 3M14 9l3 3-3 3"/>',
  split: '<rect x="3" y="5" width="18" height="14"/><path d="M12 5v14M6 12h3M15 12h3"/>',
  color: '<path d="M7 18l5-13 5 13M9 13h6"/><path d="M4 21h16" stroke-width="3" class="tg-swatch-line"/>',
  bg: '<path d="M12 4s5 6 5 9a5 5 0 0 1-10 0c0-3 5-9 5-9z"/><path d="M4 21h16" stroke-width="3" class="tg-swatch-line"/>',
  clear: '<path d="M5 19l14-14M8 5h11l-4 14H5"/>',
};

function tgIcon(name) {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TG_ICONS[name]}</svg>`;
}

// ── state, persistence, history ─────────────────────────
function tgLoadStore() {
  try {
    const j = JSON.parse(localStorage.getItem(TG_STORE) || "null");
    if (j && j.t && j.t.cells) { TG.t = j.t; TG.opts = { ...TableGen.DEFAULTS, ...(j.opts || {}) }; TG.addPackages = j.addPackages !== false; return; }
  } catch { /* fall through */ }
  TG.t = TableGen.create(4, 5);
  TG.opts = { ...TableGen.DEFAULTS };
}

function tgSave() {
  try { localStorage.setItem(TG_STORE, JSON.stringify({ t: TG.t, opts: TG.opts, addPackages: TG.addPackages })); } catch { /* ignore */ }
}

function tgMutate(fn) {
  TG.history.push(JSON.stringify(TG.t));
  if (TG.history.length > 200) TG.history.shift();
  TG.future = [];
  const out = fn(TG.t);
  if (out && out !== TG.t && out.cells) TG.t = out;
  tgClampSel();
  tgSave();
  tgRender();
}

function tgUndo(redo) {
  const from = redo ? TG.future : TG.history, to = redo ? TG.history : TG.future;
  if (!from.length) return;
  to.push(JSON.stringify(TG.t));
  TG.t = JSON.parse(from.pop());
  tgClampSel(); tgSave(); tgRender();
}

function tgClampSel() {
  const t = TG.t;
  const fix = (p) => ({ r: Math.max(0, Math.min(t.rows - 1, p.r)), c: Math.max(0, Math.min(t.cols - 1, p.c)) });
  TG.anchor = fix(TG.anchor || { r: 0, c: 0 });
  TG.focus = fix(TG.focus || TG.anchor);
  TG.sel = TableGen.expand(t, { r0: TG.anchor.r, c0: TG.anchor.c, r1: TG.focus.r, c1: TG.focus.c });
}

function tgSelect(a, f) {
  TG.anchor = a; TG.focus = f || a;
  tgClampSel();
  tgPaintSelection();
}

// ── open / close ─────────────────────────────────────────
function tgOpen() {
  if (!TG.t) tgLoadStore();
  TG.source = null;
  $("#tg-banner").hidden = true;
  // the editor's cursor is inside a table: load it for editing
  const hit = tgTableAtCursor();
  if (hit) tgLoadFromEditor(hit, true);
  $("#tg-modal").hidden = false;
  tgSelect({ r: 0, c: 0 });
  tgRender();
  $("#tg-gridwrap").focus();
}

function tgClose() {
  tgCommit();
  tgMenuClose();
  $("#tg-modal").hidden = true;
  if (state.activeFile) $("#source").focus();
}

// ── grid rendering ───────────────────────────────────────
function tgRender() {
  tgRenderGrid();
  tgRenderOutput();
  tgRenderToolbarState();
}

function tgRenderGrid() {
  const t = TG.t;
  const rule = "2px solid var(--text-1)";  // wider than the dotted grid: wins border-collapse
  let h = '<thead><tr><th class="tg-corner" data-all="1"></th>';
  for (let c = 0; c < t.cols; c++) {
    const w = t.colWidth[c] ? ` · ${esc(t.colWidth[c])}` : "";
    h += `<th class="tg-colh" data-col="${c}">${TableGen.colName(c)}<span class="tg-colmeta">${esc(t.colAlign[c])}${w}</span></th>`;
  }
  h += "</tr></thead><tbody>";
  for (let r = 0; r < t.rows; r++) {
    h += `<tr><th class="tg-rowh" data-row="${r}">${r + 1}</th>`;
    for (let c = 0; c < t.cols; c++) {
      const x = t.cells[r][c];
      if (x.hidden) continue;
      const st = [];
      const align = x.align || t.colAlign[c];
      st.push(`text-align:${{ l: "left", c: "center", r: "right" }[align]}`);
      if (x.b) st.push("font-weight:700");
      if (x.i) st.push("font-style:italic");
      if (x.u) st.push("text-decoration:underline");
      if (x.color) st.push(`color:#${x.color}`);
      if (x.bg) st.push(`background:#${x.bg}`);
      const allOf = (row) => t.hlines[row].slice(c, c + x.cs).every(Boolean);
      if (allOf(r)) st.push(`border-top:${rule}`);
      if (allOf(r + x.rs)) st.push(`border-bottom:${rule}`);
      if (t.vlines[c] && TG.opts.style !== "booktabs") st.push(`border-left:${rule}`);
      if (t.vlines[c + x.cs] && TG.opts.style !== "booktabs") st.push(`border-right:${rule}`);
      if (t.colWidth[c]) st.push(`max-width:${esc(t.colWidth[c])};white-space:normal`);
      const span = (x.rs > 1 ? ` rowspan="${x.rs}"` : "") + (x.cs > 1 ? ` colspan="${x.cs}"` : "");
      h += `<td data-r="${r}" data-c="${c}"${span} style="${st.join(";")}">${esc(x.text)}</td>`;
    }
    h += "</tr>";
  }
  $("#tg-grid").innerHTML = h + "</tbody>";
  tgPaintSelection();
}

function tgPaintSelection() {
  const s = TG.sel;
  if (!s) return;
  $("#tg-grid").querySelectorAll("td").forEach((td) => {
    const r = +td.dataset.r, c = +td.dataset.c;
    td.classList.toggle("sel", r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1);
    td.classList.toggle("focus", TG.focus && TableGen.ownerOf(TG.t, TG.focus.r, TG.focus.c).r === r &&
                                 TableGen.ownerOf(TG.t, TG.focus.r, TG.focus.c).c === c);
  });
  $("#tg-grid").querySelectorAll(".tg-colh").forEach((th) => {
    const c = +th.dataset.col;
    th.classList.toggle("sel", c >= s.c0 && c <= s.c1);
  });
  $("#tg-grid").querySelectorAll(".tg-rowh").forEach((th) => {
    const r = +th.dataset.row;
    th.classList.toggle("sel", r >= s.r0 && r <= s.r1);
  });
  const f = $("#tg-grid").querySelector("td.focus");
  if (f) f.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function tgRenderOutput() {
  const out = TableGen.toLatex(TG.t, TG.opts);
  $("#tg-code").innerHTML = highlightCode(out.code, "tex");
  const notes = [...out.notes];
  if (out.packages.length) {
    const missing = tgMissingPackages(out.packages);
    const list = out.packages.map((p) => `<code${missing.includes(p) ? ' class="tg-missing" title="not loaded by the project yet"' : ""}>${esc(p)}</code>`).join(" ");
    notes.unshift(`Needs ${list}` + (missing.length && state.project
      ? ` — <label class="tg-addpk"><input type="checkbox" id="tg-addpk"${TG.addPackages ? " checked" : ""}> add the missing ones to the preamble on insert</label>` : ""));
  }
  $("#tg-notes").innerHTML = notes.map((n) => `<div>${n.includes("<") ? n : esc(n)}</div>`).join("");
  const box = $("#tg-addpk");
  if (box) box.addEventListener("change", () => { TG.addPackages = box.checked; tgSave(); });
  const ins = $("#tg-insert");
  ins.disabled = !state.project || !state.activeFile || isBinary(state.activeFile) || TG.opts.document;
  ins.title = TG.opts.document ? "Turn off “Complete document” to insert into a project file"
    : ins.disabled ? "Open a .tex file to insert into" : "";
  ins.textContent = TG.source ? "Replace table in editor" : "Insert into editor";
  tgRenderOptions();
}

function tgRenderToolbarState() {
  const s = TG.sel, t = TG.t;
  if (!s) return;
  const x = t.cells[TableGen.ownerOf(t, s.r0, s.c0).r][TableGen.ownerOf(t, s.r0, s.c0).c];
  const align = x.align || t.colAlign[s.c0];
  document.querySelectorAll("#tg-toolbar [data-tg]").forEach((b) => {
    const a = b.dataset.tg;
    b.classList.toggle("on", (a === "bold" && x.b) || (a === "italic" && x.i) || (a === "underline" && x.u) ||
      (a === "alignL" && align === "l") || (a === "alignC" && align === "c") || (a === "alignR" && align === "r"));
  });
}

// ── output options ───────────────────────────────────────
function tgRenderOptions() {
  const o = TG.opts;
  const radio = (name, value, label) =>
    `<label><input type="radio" name="tg-${name}" value="${value}"${o[name] === value ? " checked" : ""}> ${label}</label>`;
  const check = (name, label) => `<label><input type="checkbox" name="tg-${name}"${o[name] ? " checked" : ""}> ${label}</label>`;
  const row = (title, body, help) => `<div class="tg-opt"><div class="tg-opt-k">${title}</div><div class="tg-opt-v">${body}${help ? `<div class="tg-help">${help}</div>` : ""}</div></div>`;
  const capFields = o.caption === "none" ? "" :
    `<div class="tg-capfields"><input type="text" id="tg-captext" placeholder="Caption text" value="${esc(o.captionText || "")}">` +
    `<input type="text" id="tg-label" placeholder="tab:my-label" value="${esc(o.label || "")}"></div>`;
  const html =
    row("Style", radio("style", "standard", "Standard") + radio("style", "booktabs", "Booktabs (publication style)")) +
    row("Caption", radio("caption", "none", "None") + radio("caption", "above", "Above") + radio("caption", "below", "Below") + capFields,
        "A caption numbers the table, and its label lets you refer to it in your text.") +
    row("Placement", check("center", "Center horizontally") + check("landscape", "Rotate to a landscape page")) +
    row("Width", radio("width", "natural", "Natural size") + radio("width", "wrap", "Wrap to text width") +
        radio("width", "scale-text", "Scale to text width") + radio("width", "scale-col", "Scale to column width"),
        "Columns are as wide as their text. To wrap one column, set its width (Column menu or right-click its header).") +
    row("Long table", check("longtable", "Split across pages")) +
    row("Code", check("document", "Complete document") + check("escape", "Escape special characters") +
        `<span class="tg-sub">Layout</span>` + radio("layout", "aligned", "Aligned") + radio("layout", "compact", "Compact") + radio("layout", "smart", "Smart"),
        "Characters that LaTeX treats specially, such as <code>%</code> <code>&amp;</code> <code>_</code> <code>#</code> <code>$</code>, are escaped so that they print as typed.");
  const box = $("#tg-options");
  // re-rendering must not drop focus (a radio being changed, a caption being typed)
  const act = document.activeElement && box.contains(document.activeElement) ? document.activeElement : null;
  const focusSel = act ? (act.id ? "#" + act.id : `input[name="${act.name}"][value="${act.value}"]`) : null;
  const caret = act && act.type === "text" ? act.selectionStart : null;
  box.innerHTML = `<div class="tg-opt-title">Output options</div>` + html;
  box.querySelectorAll("input[type=radio], input[type=checkbox]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const key = inp.name.slice(3);
      TG.opts[key] = inp.type === "checkbox" ? inp.checked : inp.value;
      tgSave(); tgRenderOutput(); tgRenderGrid();
    }));
  for (const [id, key] of [["tg-captext", "captionText"], ["tg-label", "label"]]) {
    const el = $("#" + id);
    if (!el) continue;
    el.addEventListener("input", () => { TG.opts[key] = el.value; tgSave(); tgRenderOutput(); });
  }
  const back = focusSel && box.querySelector(focusSel);
  if (back) { back.focus(); if (caret != null) back.setSelectionRange(caret, caret); }
}

// ── editing cells ────────────────────────────────────────
function tgStartEdit(initial) {
  const f = TableGen.ownerOf(TG.t, TG.focus.r, TG.focus.c);
  const td = $("#tg-grid").querySelector(`td[data-r="${f.r}"][data-c="${f.c}"]`);
  if (!td) return;
  const ed = $("#tg-edit"), wrap = $("#tg-gridwrap");
  const a = td.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  Object.assign(ed.style, {
    left: a.left - w.left + wrap.scrollLeft + "px", top: a.top - w.top + wrap.scrollTop + "px",
    width: Math.max(a.width, 120) + "px", minHeight: a.height + "px",
    textAlign: getComputedStyle(td).textAlign,
  });
  const x = TG.t.cells[f.r][f.c];
  ed.value = initial != null ? initial : x.text;
  ed.hidden = false;
  TG.editing = f;
  ed.focus();
  const n = ed.value.length;
  ed.setSelectionRange(n, n);
}

function tgCommit(cancel) {
  const ed = $("#tg-edit");
  if (!TG.editing) return;
  const f = TG.editing;
  TG.editing = null;
  ed.hidden = true;
  if (!cancel && ed.value !== TG.t.cells[f.r][f.c].text) {
    tgMutate((t) => { t.cells[f.r][f.c].text = ed.value.replace(/\n/g, " "); });
  }
  $("#tg-gridwrap").focus();
}

function tgMove(dr, dc, extend) {
  const t = TG.t, f = TG.focus;
  const o = TableGen.ownerOf(t, f.r, f.c), x = t.cells[o.r][o.c];
  // step out of a merged cell from its far edge
  let r = f.r + dr, c = f.c + dc;
  if (dr > 0) r = o.r + x.rs; if (dc > 0) c = o.c + x.cs;
  if (dr < 0) r = o.r - 1; if (dc < 0) c = o.c - 1;
  r = Math.max(0, Math.min(t.rows - 1, r)); c = Math.max(0, Math.min(t.cols - 1, c));
  if (extend) { TG.focus = { r, c }; tgClampSel(); tgPaintSelection(); }
  else tgSelect({ r, c });
  tgRenderToolbarState();
}

function tgTab(back) {
  const t = TG.t, f = TG.focus;
  const o = TableGen.ownerOf(t, f.r, f.c), x = t.cells[o.r][o.c];
  let r = o.r, c = back ? o.c - 1 : o.c + x.cs;
  if (c >= t.cols) { r++; c = 0; }
  if (c < 0) { r--; c = t.cols - 1; }
  if (r >= t.rows) { tgMutate((tt) => TableGen.insertRow(tt, tt.rows)); c = 0; }  // Tab past the end adds a row
  if (r < 0) { r = 0; c = 0; }
  tgSelect(TableGen.ownerOf(TG.t, r, c));
  tgRenderToolbarState();
}

// ── commands ─────────────────────────────────────────────
const tgSelAll = () => ({ r0: 0, c0: 0, r1: TG.t.rows - 1, c1: TG.t.cols - 1 });
const tgWholeCols = () => TG.sel.r0 === 0 && TG.sel.r1 === TG.t.rows - 1;

function tgAlign(a) {
  tgMutate((t) => {
    if (tgWholeCols()) {  // whole columns: change the column, drop per-cell overrides
      for (let c = TG.sel.c0; c <= TG.sel.c1; c++) t.colAlign[c] = a;
      TableGen.setFormat(t, { r0: 0, c0: TG.sel.c0, r1: t.rows - 1, c1: TG.sel.c1 }, "align", "");
    } else {
      TableGen.setFormat(t, TG.sel, "align", a);
    }
  });
}

function tgPickColor(key) {
  const inp = $("#tg-color");
  const t = TG.t, o = TableGen.ownerOf(t, TG.sel.r0, TG.sel.c0);
  const cur = t.cells[o.r][o.c][key];
  inp.value = "#" + (cur || (key === "bg" ? "FFF2CC" : "D92B2B"));
  inp.oninput = null;
  inp.onchange = () => tgMutate((tt) => TableGen.setFormat(tt, TG.sel, key, inp.value.slice(1).toUpperCase()));
  inp.click();
}

async function tgSetColWidth() {
  const c = TG.sel.c0;
  const v = await modal(`Width of column ${TableGen.colName(c)}`, "e.g. 3cm, 0.3\\textwidth — empty for natural width", TG.t.colWidth[c] || "");
  if (v === null) return;
  tgMutate((t) => { for (let k = TG.sel.c0; k <= TG.sel.c1; k++) t.colWidth[k] = (v || "").trim(); });
}

async function tgSetSize() {
  const v = await modal("Table size", "rows × columns, e.g. 6x4", `${TG.t.rows}x${TG.t.cols}`);
  const m = /^\s*(\d+)\s*[x×,*\s]\s*(\d+)\s*$/.exec(v || "");
  if (!m) return;
  tgMutate((t) => TableGen.resize(t, Math.min(200, +m[1]), Math.min(50, +m[2])));
}

function tgNew() {
  tgMutate(() => TableGen.create(4, 5));
  TG.source = null; $("#tg-banner").hidden = true;
  tgSelect({ r: 0, c: 0 }); tgRender();
}

function tgClearCells() {
  tgMutate((t) => {
    for (let r = TG.sel.r0; r <= TG.sel.r1; r++) for (let c = TG.sel.c0; c <= TG.sel.c1; c++) t.cells[r][c].text = "";
  });
}

function tgSelectionTSV() {
  const s = TG.sel, rows = [];
  for (let r = s.r0; r <= s.r1; r++) {
    const row = [];
    for (let c = s.c0; c <= s.c1; c++) row.push(TG.t.cells[r][c].hidden ? "" : TG.t.cells[r][c].text);
    rows.push(row.join("\t"));
  }
  return rows.join("\n");
}

function tgPasteText(text) {
  if (!text) return;
  if (/\\begin\{(tabular|tabularx|longtable|table)/.test(text)) return tgLoadLatex(text);
  const rows = text.includes("\t") || !text.includes(",") ? TableGen.parseTSV(text) : TableGen.parseCSV(text);
  tgMutate((t) => TableGen.pasteGrid(t, rows, TG.sel.r0, TG.sel.c0));
  tgSelect({ r: TG.sel.r0, c: TG.sel.c0 }, { r: TG.sel.r0 + rows.length - 1, c: TG.sel.c0 + Math.max(...rows.map((r) => r.length)) - 1 });
  tgRender();
}

function tgLoadLatex(text, keepSource) {
  let parsed;
  try { parsed = TableGen.parseLatex(text); } catch (e) { alert("Could not read that table: " + e.message); return false; }
  tgMutate(() => parsed.table);
  TG.opts = { ...TableGen.DEFAULTS, ...TG.opts, caption: "none", ...parsed.options };
  if (!keepSource) { TG.source = null; $("#tg-banner").hidden = true; }
  tgSave(); tgSelect({ r: 0, c: 0 }); tgRender();
  return true;
}

// A table environment around the editor's cursor → {from, to, text}
function tgTableAtCursor() {
  if (!state.activeFile || isBinary(state.activeFile) || langFor(state.activeFile) !== "tex") return null;
  const ta = $("#source"), v = ta.value;
  const caret = state.edSel ? state.edSel[0] : ta.selectionStart;
  const envs = ["table", "table*", "sidewaystable", "longtable", "tabularx", "tabular", "tabular*"];
  let best = null;
  for (const env of envs) {
    const open = `\\begin{${env}}`, close = `\\end{${env}}`;
    let from = v.lastIndexOf(open, caret);
    while (from >= 0) {
      const to = v.indexOf(close, from);
      if (to >= 0 && to + close.length >= caret) {
        if (!best || from < best.from) best = { from, to: to + close.length };
        break;
      }
      from = v.lastIndexOf(open, from - 1);
    }
    if (best && /^(table|table\*|sidewaystable|longtable)$/.test(env)) break;  // a float wins
  }
  if (!best) return null;
  const text = v.slice(best.from, best.to);
  return /\\begin\{(tabular|tabularx|tabular\*|longtable)\}/.test(text) ? { ...best, text } : null;
}

function tgLoadFromEditor(hit, quiet) {
  hit = hit || tgTableAtCursor();
  if (!hit) { if (!quiet) alert("Put the editor's cursor inside a table (tabular / table environment) first."); return; }
  if (!tgLoadLatex(hit.text, true)) return;
  const line = $("#source").value.slice(0, hit.from).split("\n").length;
  TG.source = { file: state.activeFile, from: hit.from, to: hit.to, text: hit.text, line };
  const b = $("#tg-banner");
  b.innerHTML = `Editing the table at <code>${esc(state.activeFile)}:${line}</code> — “Replace table in editor” writes it back. ` +
    `<button class="tg-link" id="tg-detach">Start a new table instead</button>`;
  b.hidden = false;
  $("#tg-detach").addEventListener("click", () => { tgNew(); });
  tgRenderOutput();
}

function tgMissingPackages(packages) {
  if (!state.project) return [];
  const { text, at } = rootPreamble();
  return TableGen.missingPackages(at >= 0 ? text.slice(0, at) : text, packages);
}

async function tgInsert() {
  if (!state.activeFile || isBinary(state.activeFile)) return;
  tgCommit();
  const out = TableGen.toLatex(TG.t, { ...TG.opts, document: false });
  const ta = $("#source");
  let code = out.code.replace(/\n$/, "");
  const src = TG.source;
  if (src && src.file === state.activeFile && ta.value.slice(src.from, src.to) === src.text) {
    edInsert(src.from, src.to, code);
    TG.source = { ...src, to: src.from + code.length, text: code };
  } else {
    const [from, to] = state.edSel || [ta.selectionStart, ta.selectionEnd];
    const v = ta.value;
    const before = from > 0 && v[from - 1] !== "\n" ? "\n" : "";
    const after = v[to] && v[to] !== "\n" ? "\n" : "";
    edInsert(from, to, before + code + after);
  }
  const missing = tgMissingPackages(out.packages);
  if (TG.addPackages && missing.length) await tgAddPackages(missing);
  tgClose();
}

async function tgAddPackages(missing) {
  await addToPreamble(`\\usepackage{${missing.join(",")}} % added by the table generator\n`);
}

async function tgCopy() {
  const code = TableGen.toLatex(TG.t, TG.opts).code;
  try { await navigator.clipboard.writeText(code); }
  catch {
    const tmp = document.createElement("textarea");
    tmp.value = code; document.body.appendChild(tmp); tmp.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    tmp.remove();
  }
  flash($("#tg-copy"), "Copied");
}

// ── menus ────────────────────────────────────────────────
function tgMenus() {
  const s = TG.sel;
  const multi = s && (s.r0 !== s.r1 || s.c0 !== s.c1);
  const owner = s && TG.t.cells[TableGen.ownerOf(TG.t, s.r0, s.c0).r][TableGen.ownerOf(TG.t, s.r0, s.c0).c];
  const merged = owner && (owner.rs > 1 || owner.cs > 1);
  const K = navigator.platform && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
  return {
    File: [
      ["New table", tgNew],
      ["Import CSV / TSV file…", () => $("#tg-file").click()],
      ["Load LaTeX code…", () => tgShowLoad()],
      ["Load table at editor cursor", () => tgLoadFromEditor(null, false), !tgTableAtCursor()],
      null,
      ["Copy LaTeX", tgCopy],
    ],
    Edit: [
      ["Undo", () => tgUndo(false), !TG.history.length, K + "Z"],
      ["Redo", () => tgUndo(true), !TG.future.length, K + "⇧Z"],
      null,
      ["Copy cells", () => tgClipboardWrite(tgSelectionTSV()), false, K + "C"],
      ["Paste", () => tgClipboardRead(), false, K + "V"],
      ["Clear cells", tgClearCells, false, "Del"],
      ["Select all", () => { tgSelect({ r: 0, c: 0 }, { r: TG.t.rows - 1, c: TG.t.cols - 1 }); }, false, K + "A"],
    ],
    Table: [
      ["Set size…", tgSetSize],
      ["Transpose", () => tgMutate((t) => TableGen.transpose(t))],
      null,
      ["All borders", () => tgMutate((t) => TableGen.setBorders(t, tgSelAll(), "all"))],
      ["Horizontal rules only", () => tgMutate((t) => { TableGen.setBorders(t, tgSelAll(), "none"); TableGen.setBorders(t, tgSelAll(), "horizontal"); })],
      ["No borders", () => tgMutate((t) => TableGen.setBorders(t, tgSelAll(), "none"))],
      ["Clear all formatting", () => tgMutate((t) => TableGen.clearFormat(t, tgSelAll()))],
    ],
    Column: [
      ["Insert column left", () => tgMutate((t) => TableGen.insertCol(t, s.c0))],
      ["Insert column right", () => tgMutate((t) => TableGen.insertCol(t, s.c1 + 1))],
      ["Delete column", () => tgMutate((t) => { for (let c = s.c1; c >= s.c0; c--) TableGen.deleteCol(t, c); }), TG.t.cols <= 1],
      null,
      ["Align left", () => tgColAlign("l")], ["Align center", () => tgColAlign("c")], ["Align right", () => tgColAlign("r")],
      ["Set column width…", tgSetColWidth],
    ],
    Row: [
      ["Insert row above", () => tgMutate((t) => TableGen.insertRow(t, s.r0))],
      ["Insert row below", () => tgMutate((t) => TableGen.insertRow(t, s.r1 + 1))],
      ["Delete row", () => tgMutate((t) => { for (let r = s.r1; r >= s.r0; r--) TableGen.deleteRow(t, r); }), TG.t.rows <= 1],
    ],
    Cell: [
      ["Merge cells", () => tgMutate((t) => TableGen.merge(t, s)), !multi],
      ["Split cells", () => tgMutate((t) => TableGen.split(t, s.r0, s.c0)), !merged],
      null,
      ["Bold", () => tgMutate((t) => TableGen.toggleFormat(t, s, "b")), false, K + "B"],
      ["Italic", () => tgMutate((t) => TableGen.toggleFormat(t, s, "i")), false, K + "I"],
      ["Underline", () => tgMutate((t) => TableGen.toggleFormat(t, s, "u")), false, K + "U"],
      ["Text colour…", () => tgPickColor("color")],
      ["Background colour…", () => tgPickColor("bg")],
      ["Remove colours", () => tgMutate((t) => { TableGen.setFormat(t, s, "color", ""); TableGen.setFormat(t, s, "bg", ""); })],
      ["Clear formatting", () => tgMutate((t) => TableGen.clearFormat(t, s))],
    ],
    Help: [
      ["Keyboard: arrows move, Shift+arrows select", null, true],
      ["Enter / F2 / typing edits · Esc cancels", null, true],
      ["Tab moves to the next cell (adds a row at the end)", null, true],
      ["Paste cells from a spreadsheet, CSV or LaTeX", null, true],
      ["Right-click a cell or header for more", null, true],
    ],
  };
}

function tgColAlign(a) {
  tgMutate((t) => {
    for (let c = TG.sel.c0; c <= TG.sel.c1; c++) t.colAlign[c] = a;
    TableGen.setFormat(t, { r0: 0, c0: TG.sel.c0, r1: t.rows - 1, c1: TG.sel.c1 }, "align", "");
  });
}

function tgMenuOpen(items, x, y) {
  const box = $("#tg-menu");
  box.innerHTML = items.map((it, i) => it === null ? '<div class="tg-sep"></div>'
    : `<button class="tg-mi" data-i="${i}" role="menuitem"${it[2] ? " disabled" : ""}><span>${esc(it[0])}</span>${it[3] ? `<kbd>${esc(it[3])}</kbd>` : ""}</button>`).join("");
  box.querySelectorAll(".tg-mi").forEach((b) => b.addEventListener("click", () => {
    const it = items[+b.dataset.i];
    tgMenuClose();
    if (it[1]) it[1]();
    $("#tg-gridwrap").focus();
  }));
  const card = $("#tg-modal .tg-card").getBoundingClientRect();
  box.hidden = false;
  box.style.left = Math.min(x - card.left, card.width - box.offsetWidth - 8) + "px";
  box.style.top = Math.min(y - card.top, card.height - box.offsetHeight - 8) + "px";
  const first = box.querySelector(".tg-mi:not([disabled])");
  if (first) first.focus();
}

function tgMenuClose() {
  $("#tg-menu").hidden = true;
  document.querySelectorAll(".tg-menubar button").forEach((b) => b.classList.remove("open"));
}

function tgContextMenu(e) {
  const m = tgMenus();
  const head = e.target.closest(".tg-colh"), rowh = e.target.closest(".tg-rowh");
  const items = head ? m.Column : rowh ? m.Row
    : [...m.Cell.slice(0, 2), null, ...m.Row.slice(0, 2), ...m.Column.slice(0, 2), null, ["Set column width…", tgSetColWidth], ["Clear cells", tgClearCells]];
  tgMenuOpen(items, e.clientX, e.clientY);
}

// ── clipboard ────────────────────────────────────────────
async function tgClipboardWrite(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* permission denied: keyboard copy still works */ }
}

async function tgClipboardRead() {
  try { tgPasteText(await navigator.clipboard.readText()); }
  catch { alert("Press " + (/Mac/.test(navigator.platform) ? "⌘V" : "Ctrl+V") + " in the table to paste."); }
}

// ── load dialog ──────────────────────────────────────────
function tgShowLoad() {
  $("#tg-load").hidden = false;
  $("#tg-load-text").value = "";
  $("#tg-load-text").focus();
}

// ── wiring ───────────────────────────────────────────────
function tgSetupToolbar() {
  const groups = [
    [["alignL", "Align left", () => tgAlign("l")], ["alignC", "Align center", () => tgAlign("c")], ["alignR", "Align right", () => tgAlign("r")]],
    [["bold", "Bold (Ctrl+B)", () => tgMutate((t) => TableGen.toggleFormat(t, TG.sel, "b"))],
     ["italic", "Italic (Ctrl+I)", () => tgMutate((t) => TableGen.toggleFormat(t, TG.sel, "i"))],
     ["underline", "Underline (Ctrl+U)", () => tgMutate((t) => TableGen.toggleFormat(t, TG.sel, "u"))]],
    [["bAll", "All borders", () => tgMutate((t) => TableGen.setBorders(t, TG.sel, "all"))],
     ["bOuter", "Outer border", () => tgMutate((t) => TableGen.setBorders(t, TG.sel, "outer"))],
     ["bInner", "Inner borders", () => tgMutate((t) => TableGen.setBorders(t, TG.sel, "inner"))],
     ["bHoriz", "Horizontal rules", () => tgMutate((t) => TableGen.setBorders(t, TG.sel, "horizontal"))],
     ["bNone", "No borders", () => tgMutate((t) => TableGen.setBorders(t, TG.sel, "none"))]],
    [["merge", "Merge cells", () => tgMutate((t) => TableGen.merge(t, TG.sel))],
     ["split", "Split cells", () => tgMutate((t) => TableGen.split(t, TG.sel.r0, TG.sel.c0))]],
    [["color", "Text colour", () => tgPickColor("color")], ["bg", "Background colour", () => tgPickColor("bg")],
     ["clear", "Clear formatting", () => tgMutate((t) => TableGen.clearFormat(t, TG.sel))]],
  ];
  const bar = $("#tg-toolbar");
  bar.innerHTML = groups.map((g) => `<div class="tg-tgroup">${g.map(([icon, title]) =>
    `<button class="tg-tb" data-tg="${icon}" title="${esc(title)}" aria-label="${esc(title)}">${tgIcon(icon)}</button>`).join("")}</div>`).join("");
  const actions = Object.fromEntries(groups.flat().map(([icon, , fn]) => [icon, fn]));
  bar.querySelectorAll("[data-tg]").forEach((b) => b.addEventListener("click", () => {
    tgCommit();
    actions[b.dataset.tg]();
    $("#tg-gridwrap").focus();
  }));
  const menubar = $("#tg-menubar");
  menubar.innerHTML = ["File", "Edit", "Table", "Column", "Row", "Cell", "Help"]
    .map((n) => `<button data-menu="${n}" aria-haspopup="menu">${n}</button>`).join("");
  menubar.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const was = b.classList.contains("open");
    tgCommit();
    tgMenuClose();
    if (was) return;
    b.classList.add("open");
    const r = b.getBoundingClientRect();
    tgMenuOpen(tgMenus()[b.dataset.menu], r.left, r.bottom + 2);
  }));
}

function tgCellAt(target) {
  const td = target.closest && target.closest("td[data-r]");
  return td ? { r: +td.dataset.r, c: +td.dataset.c } : null;
}

function tgSetupGrid() {
  const wrap = $("#tg-gridwrap"), grid = $("#tg-grid");
  grid.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    tgCommit();
    tgMenuClose();
    const cell = tgCellAt(e.target);
    const colh = e.target.closest(".tg-colh"), rowh = e.target.closest(".tg-rowh");
    if (e.target.closest(".tg-corner")) { tgSelect({ r: 0, c: 0 }, { r: TG.t.rows - 1, c: TG.t.cols - 1 }); }
    else if (colh) { const c = +colh.dataset.col; tgSelect(e.shiftKey ? TG.anchor : { r: 0, c }, { r: TG.t.rows - 1, c }); if (!e.shiftKey) TG.anchor = { r: 0, c }; tgClampSel(); tgPaintSelection(); }
    else if (rowh) { const r = +rowh.dataset.row; tgSelect(e.shiftKey ? TG.anchor : { r, c: 0 }, { r, c: TG.t.cols - 1 }); }
    else if (cell) { if (e.shiftKey) { TG.focus = cell; tgClampSel(); tgPaintSelection(); } else tgSelect(cell); TG.dragging = true; }
    tgRenderToolbarState();
    e.preventDefault();
    wrap.focus();
  });
  grid.addEventListener("mouseover", (e) => {
    if (!TG.dragging) return;
    const cell = tgCellAt(e.target);
    if (cell) { TG.focus = cell; tgClampSel(); tgPaintSelection(); }
  });
  window.addEventListener("mouseup", () => { if (TG.dragging) { TG.dragging = false; tgRenderToolbarState(); } });
  grid.addEventListener("dblclick", (e) => { const cell = tgCellAt(e.target); if (cell) { tgSelect(cell); tgStartEdit(); } });
  grid.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const cell = tgCellAt(e.target);
    const colh = e.target.closest(".tg-colh"), rowh = e.target.closest(".tg-rowh");
    const s = TG.sel;
    // right-click outside the selection selects what was clicked
    if (cell && !(cell.r >= s.r0 && cell.r <= s.r1 && cell.c >= s.c0 && cell.c <= s.c1)) tgSelect(cell);
    if (colh && !(+colh.dataset.col >= s.c0 && +colh.dataset.col <= s.c1 && tgWholeCols())) tgSelect({ r: 0, c: +colh.dataset.col }, { r: TG.t.rows - 1, c: +colh.dataset.col });
    if (rowh && !(+rowh.dataset.row >= s.r0 && +rowh.dataset.row <= s.r1)) tgSelect({ r: +rowh.dataset.row, c: 0 }, { r: +rowh.dataset.row, c: TG.t.cols - 1 });
    tgContextMenu(e);
  });

  wrap.addEventListener("keydown", (e) => {
    if (e.target.id === "tg-edit") return;  // the cell editor handles its own keys
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") { if (!$("#tg-menu").hidden) { handled(); tgMenuClose(); } return; }  // dialog-level Esc
    if (mod && key === "z") { handled(); return tgUndo(e.shiftKey); }
    if (mod && key === "y") { handled(); return tgUndo(true); }
    if (mod && key === "a") { handled(); return tgSelect({ r: 0, c: 0 }, { r: TG.t.rows - 1, c: TG.t.cols - 1 }); }
    if (mod && (key === "b" || key === "i" || key === "u")) { handled(); return tgMutate((t) => TableGen.toggleFormat(t, TG.sel, key)); }
    if (mod) return;  // copy / cut / paste arrive as clipboard events
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[e.key]) { handled(); return tgMove(...moves[e.key], e.shiftKey); }
    if (e.key === "Tab") { handled(); return tgTab(e.shiftKey); }
    if (e.key === "Enter" || e.key === "F2") { handled(); return tgStartEdit(); }
    if (e.key === "Delete" || e.key === "Backspace") { handled(); return tgClearCells(); }
    if (e.key.length === 1 && !e.altKey) { handled(); return tgStartEdit(e.key); }
  });
  wrap.addEventListener("copy", (e) => { if (e.target.id === "tg-edit") return; e.preventDefault(); e.clipboardData.setData("text/plain", tgSelectionTSV()); });
  wrap.addEventListener("cut", (e) => { if (e.target.id === "tg-edit") return; e.preventDefault(); e.clipboardData.setData("text/plain", tgSelectionTSV()); tgClearCells(); });
  wrap.addEventListener("paste", (e) => { if (e.target.id === "tg-edit") return; e.preventDefault(); tgPasteText(e.clipboardData.getData("text/plain")); });

  const ed = $("#tg-edit");
  ed.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") { e.preventDefault(); return tgCommit(true); }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); tgCommit(); return tgMove(1, 0, false); }
    if (e.key === "Tab") { e.preventDefault(); tgCommit(); return tgTab(e.shiftKey); }
  });
  ed.addEventListener("blur", () => setTimeout(() => { if (TG.editing && document.activeElement !== ed) tgCommit(); }, 0));
}

document.addEventListener("DOMContentLoaded", () => {
  tgSetupToolbar();
  tgSetupGrid();
  document.querySelectorAll("[data-tool=tablegen]").forEach((b) => b.addEventListener("click", tgOpen));
  $("#tg-close").addEventListener("click", tgClose);
  $("#tg-copy").addEventListener("click", tgCopy);
  $("#tg-insert").addEventListener("click", tgInsert);
  $("#tg-modal").addEventListener("mousedown", (e) => {
    if (!e.target.closest("#tg-menu") && !e.target.closest(".tg-menubar")) tgMenuClose();
  });
  // Esc at document level: focus may sit on <body> after a click on a label
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("#tg-modal").hidden) return;
    if (!$("#tg-load").hidden) { e.preventDefault(); $("#tg-load").hidden = true; return; }
    if (!$("#tg-menu").hidden) { e.preventDefault(); tgMenuClose(); $("#tg-gridwrap").focus(); return; }
    if (TG.editing) return;
    if (!$("#modal").hidden) return;  // a prompt is open on top
    e.preventDefault();
    tgClose();
  });
  $("#tg-menu").addEventListener("keydown", (e) => {
    const items = [...$("#tg-menu").querySelectorAll(".tg-mi:not([disabled])")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
  });
  $("#tg-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const text = await f.text();
    const rows = /\.tsv$/i.test(f.name) || text.includes("\t") ? TableGen.parseTSV(text) : TableGen.parseCSV(text);
    tgMutate(() => TableGen.fromRows(rows));
    tgSelect({ r: 0, c: 0 }); tgRender();
  });
  $("#tg-load-cancel").addEventListener("click", () => { $("#tg-load").hidden = true; });
  $("#tg-load-ok").addEventListener("click", () => {
    if (tgLoadLatex($("#tg-load-text").value)) $("#tg-load").hidden = true;
  });
});
