// UI chrome: theme toggle, shortcuts dialog, and around the editor: line-number gutter, current-line band,
// status bar and the left panel's file outline. Loaded after app.js; follows the
// editor through its DOM events and the "tw:source" event app.js fires whenever
// the editor's text is replaced or re-highlighted. TexOutline (outline.js) and
// FileIcons (icons.js) do the pure work.
"use strict";

const UX = {
  rows: null,        // the editor's text, split into logical lines
  heights: [],       // rendered height of each logical line (wrapping included)
  tops: [],          // top of each line inside the textarea (padding included)
  width: 0, font: "",
  mirror: null,
  frame: 0,
  gutterKey: "",     // what the gutter currently shows
  file: undefined,   // the file the chrome last showed
  outline: [], outlineFor: null, outlineTimer: 0, activeItem: -1,
  wordsTimer: 0,
};
const OUTLINE_OPEN_KEY = "tw_outline_open";

// ── geometry: where each logical line sits in the wrapping textarea ──
// A hidden mirror with the textarea's box lays out lines to measure their
// height. Only lines that changed are re-measured, unless the width or font
// changed; the tops are a running sum.
function uxMirror(ta, cs) {
  if (!UX.mirror) {
    UX.mirror = document.createElement("div");
    UX.mirror.setAttribute("aria-hidden", "true");
    document.body.appendChild(UX.mirror);
  }
  const m = UX.mirror.style;
  for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize",
                   "paddingRight", "paddingLeft", "whiteSpace", "overflowWrap", "wordBreak", "boxSizing"]) m[p] = cs[p];
  m.position = "absolute"; m.visibility = "hidden"; m.left = "-9999px"; m.top = "0";
  m.paddingTop = m.paddingBottom = "0";
  m.height = "auto"; m.width = ta.clientWidth + "px";
  return UX.mirror;
}

function uxHeights(rows, ta, cs) {
  const mirror = uxMirror(ta, cs);
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const d = document.createElement("div");
    d.textContent = r || "\u200b";
    frag.appendChild(d);
  }
  mirror.replaceChildren(frag);
  const out = [...mirror.children].map((d) => d.getBoundingClientRect().height);
  mirror.replaceChildren();
  return out;
}

function uxMeasure(force) {
  const ta = $("#source"), wrap = $("#code-wrap");
  if (!ta || wrap.hidden) return false;
  const cs = getComputedStyle(ta);
  const width = ta.clientWidth, font = cs.fontSize + cs.fontFamily + cs.paddingLeft + cs.paddingRight;
  const rows = ta.value.split("\n");
  const old = UX.rows;
  if (force || !old || width !== UX.width || font !== UX.font) {
    UX.heights = uxHeights(rows, ta, cs);
  } else {
    const n = rows.length, m = old.length;
    let p = 0;
    while (p < n && p < m && rows[p] === old[p]) p++;
    if (p === n && n === m) return false;                // nothing changed
    let q = 0;
    while (q < n - p && q < m - p && rows[n - 1 - q] === old[m - 1 - q]) q++;
    const fresh = uxHeights(rows.slice(p, n - q), ta, cs);
    UX.heights = UX.heights.slice(0, p).concat(fresh, UX.heights.slice(m - q));
  }
  UX.rows = rows; UX.width = width; UX.font = font;
  const tops = new Array(rows.length);
  let y = parseFloat(cs.paddingTop) || 0;
  for (let i = 0; i < rows.length; i++) { tops[i] = y; y += UX.heights[i]; }
  UX.tops = tops;
  const digits = Math.max(2, String(rows.length).length);
  wrap.style.setProperty("--gutter", `${digits * 7.6 + 18}px`);
  return true;
}

// First line whose bottom is below `y`.
function uxLineAtY(y) {
  const t = UX.tops;
  let lo = 0, hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Only the numbers in view (plus a margin) are in the DOM.
function uxRenderGutter(force) {
  const ta = $("#source"), inner = $("#ed-gutter-in");
  const n = UX.tops.length;
  if (!n) { inner.innerHTML = ""; UX.gutterKey = ""; return; }
  const top = ta.scrollTop, h = ta.clientHeight || 600;
  const first = Math.max(0, uxLineAtY(top - h) );
  const last = Math.min(n - 1, uxLineAtY(top + 2 * h));
  const key = `${first}:${last}:${UX.tops[first]}:${UX.tops[last]}:${n}`;
  if (!force && key === UX.gutterKey) return;
  UX.gutterKey = key;
  const html = [];
  for (let i = first; i <= last; i++) html.push(`<div class="ln" data-line="${i}" style="top:${UX.tops[i]}px">${i + 1}</div>`);
  inner.innerHTML = html.join("");
}

function uxCaret() {
  const ta = $("#source");
  const v = ta.value;
  const pos = ta.selectionStart, end = ta.selectionEnd;
  const before = v.slice(0, pos);
  const line = before.split("\n").length - 1;
  const col = pos - (before.lastIndexOf("\n") + 1) + 1;
  const endLine = line + (v.slice(pos, end).split("\n").length - 1);
  return { line, col, endLine, selected: end - pos };
}

function uxPaintCaret() {
  const ta = $("#source"), band = $("#ed-curline"), inner = $("#ed-gutter-in");
  if (!ta || $("#code-wrap").hidden) return;
  uxRenderGutter(false);
  inner.style.transform = `translateY(${-ta.scrollTop}px)`;
  const c = uxCaret();
  const top = UX.tops[c.line];
  if (top != null && c.endLine === c.line) {
    band.hidden = false;
    band.style.top = `${top - ta.scrollTop}px`;
    band.style.height = `${UX.heights[c.line]}px`;
  } else band.hidden = true;
  inner.querySelectorAll(".ln.cur").forEach((e) => e.classList.remove("cur"));
  for (const el of inner.children) {
    const i = +el.dataset.line;
    if (i >= c.line && i <= c.endLine) el.classList.add("cur");
  }
  $("#st-pos").textContent = `Ln ${c.line + 1}, Col ${c.col}`;
  const sel = $("#st-sel");
  sel.hidden = !c.selected;
  if (c.selected) sel.textContent = `${c.selected} selected` + (c.endLine > c.line ? ` · ${c.endLine - c.line + 1} lines` : "");
  uxMarkOutline(c.line);
}

function uxRefresh(force) {
  cancelAnimationFrame(UX.frame);
  UX.frame = requestAnimationFrame(() => {
    if (uxMeasure(force)) uxRenderGutter(true);
    uxPaintCaret();
  });
}

// ── status bar ──
function uxStatus() {
  const bar = $("#ed-status");
  const path = state.activeFile;
  const binary = !path || isBinary(path);
  bar.hidden = !path || $("#code-wrap").hidden;
  if (bar.hidden) return;
  const text = $("#source").value;
  const lines = text.length ? text.split("\n").length : 0;
  $("#st-lines").textContent = `${lines} line${lines === 1 ? "" : "s"}`;
  const kind = FileIcons.kindOf(path);
  $("#st-kind").innerHTML = `${FileIcons.svg(kind, 12)}${esc(FileIcons.label(kind))}`;
  const root = renderMain();
  const st = $("#st-root");
  if (binary || !/\.(tex|ltx)$/i.test(path)) st.textContent = "";
  else if (path === root) st.textContent = "Main file";
  else st.innerHTML = root ? `Previewed via <code>${esc(root)}</code>` : "";
  clearTimeout(UX.wordsTimer);
  UX.wordsTimer = setTimeout(() => {
    const n = TexOutline.wordCount($("#source").value, langFor(path));
    $("#st-words").textContent = `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
  }, 250);
}

// ── outline ──
const OL_ICONS = {
  heading: '<path d="M4 6h16M4 12h10M4 18h7"/>',
  figure: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  algorithm: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  listing: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  equation: '<path d="M18 4H6l6 8-6 8h12"/>',
  theorem: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  abstract: '<path d="M4 6h16M4 10h16M4 14h16M4 18h10"/>',
  input: '<path d="M15 10l5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  bib: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  appendix: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  title: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
};

function olIcon(kind) {
  return `<svg class="ol-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${OL_ICONS[kind] || OL_ICONS.heading}</svg>`;
}

// An \input target → a project path (LaTeX resolves from the root's folder,
// tex2word from the including file's), or null.
function olResolve(target) {
  const have = new Set((state.files || []).map((f) => f.path));
  const dir = (state.activeFile || "").includes("/") ? state.activeFile.slice(0, state.activeFile.lastIndexOf("/") + 1) : "";
  const bare = target.replace(/\.tex$/, "");
  for (const c of [target, dir + target, bare, dir + bare]) {
    const p = c.replace(/^\.\//, "");
    if (have.has(p)) return p;
  }
  return null;
}

function uxOutline(now) {
  clearTimeout(UX.outlineTimer);
  const run = () => {
    const tree = $("#outline-tree");
    const path = state.activeFile;
    const lang = path && !isBinary(path) ? langFor(path) : null;
    $("#outline-file").textContent = path ? path.split("/").pop() : "";
    if (!lang) {
      UX.outline = [];
      $("#outline-count").textContent = "";
      tree.innerHTML = `<div class="ol-empty">${path ? "No outline for this file type." : "Open a file to see its outline."}</div>`;
      return;
    }
    const text = $("#source").value;
    if (UX.outlineFor === path + "\0" + text) return;
    UX.outlineFor = path + "\0" + text;
    UX.outline = TexOutline.parse(text, lang);
    UX.activeItem = -1;
    $("#outline-count").textContent = UX.outline.length || "";
    if (!UX.outline.length) {
      tree.innerHTML = `<div class="ol-empty">No sections, floats or equations in this file yet.</div>`;
      return;
    }
    tree.innerHTML = UX.outline.map((it, i) => {
      const meta = it.kind === "input"
        ? (olResolve(it.target) ? "open" : "missing")
        : it.label ? esc(it.label) : `L${it.line + 1}`;
      const tip = `${it.title}${it.label ? `  ·  \\label{${it.label}}` : ""}  ·  line ${it.line + 1}` +
        (it.kind === "input" ? (olResolve(it.target) ? "  ·  click to open" : "  ·  file not in the project") : "");
      return `<div class="ol-item kind-${esc(it.kind)}${it.starred ? " starred" : ""}" role="treeitem" data-i="${i}" ` +
        `style="--depth:${Math.min(it.depth, 6)}" title="${esc(tip)}">${olIcon(it.kind)}` +
        `<span class="ol-title">${esc(it.title)}</span><span class="ol-meta${meta === "missing" ? " missing" : ""}">${meta}</span></div>`;
    }).join("");
    uxMarkOutline(uxCaret().line);
  };
  if (now) run(); else UX.outlineTimer = setTimeout(run, 200);
}

function uxMarkOutline(line) {
  if (!UX.outline.length) return;
  const i = TexOutline.activeIndex(UX.outline, line);
  if (i === UX.activeItem) return;
  UX.activeItem = i;
  const tree = $("#outline-tree");
  tree.querySelectorAll(".ol-item.active").forEach((e) => e.classList.remove("active"));
  const el = i >= 0 && tree.querySelector(`.ol-item[data-i="${i}"]`);
  if (el) {
    el.classList.add("active");
    const top = el.offsetTop - tree.offsetTop, bottom = top + el.offsetHeight;
    if (top < tree.scrollTop || bottom > tree.scrollTop + tree.clientHeight) tree.scrollTop = Math.max(0, top - tree.clientHeight / 3);
  }
}

function uxSetOutlineOpen(open) {
  $("#pane-outline").classList.toggle("closed", !open);
  $("#outline-toggle").setAttribute("aria-expanded", String(open));
  $("#outline-toggle .chev").classList.toggle("open", open);
  try { localStorage.setItem(OUTLINE_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode */ }
}

// The editor's text changed or another file opened.
function uxOnSource() {
  const switched = state.activeFile !== UX.file;
  UX.file = state.activeFile;
  uxRefresh(switched);
  uxStatus();
  uxOutline(switched);
}

document.addEventListener("DOMContentLoaded", () => {
  const ta = $("#source");
  document.addEventListener("tw:source", uxOnSource);
  ta.addEventListener("scroll", () => uxPaintCaret());
  for (const ev of ["keyup", "mouseup", "focus", "select"]) ta.addEventListener(ev, () => uxPaintCaret());
  document.addEventListener("selectionchange", () => { if (document.activeElement === ta) uxPaintCaret(); });
  new ResizeObserver(() => uxRefresh(false)).observe($("#code-wrap"));
  // gutter: click a number to select that line
  $("#ed-gutter").addEventListener("mousedown", (e) => {
    const ln = e.target.closest(".ln");
    if (!ln) return;
    e.preventDefault();
    const line = +ln.dataset.line;
    const v = ta.value;
    let from = 0;
    for (let i = 0; i < line; i++) from = v.indexOf("\n", from) + 1;
    let to = v.indexOf("\n", from);
    to = to < 0 ? v.length : to + 1;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(from, to);
    uxPaintCaret();
  });
  // outline
  let open = true;
  try { open = localStorage.getItem(OUTLINE_OPEN_KEY) !== "0"; } catch { /* private mode */ }
  uxSetOutlineOpen(open);
  $("#outline-toggle").addEventListener("click", () => uxSetOutlineOpen($("#pane-outline").classList.contains("closed")));
  $("#outline-tree").addEventListener("click", (e) => {
    const el = e.target.closest(".ol-item");
    if (!el) return;
    const it = UX.outline[+el.dataset.i];
    if (!it) return;
    if (it.kind === "input") {
      const p = olResolve(it.target);
      if (p) { openFile(p); return; }
    }
    _scrollEditorToLine(it.line, true);
    uxPaintCaret();
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => uxRefresh(true));
});

// ── theme menu (System / Light / Dark) ──
const THEME_NAMES = { system: "System", light: "Light", dark: "Dark" };
function uxThemeButton() {
  const b = $("#btn-theme");
  if (!b || !window.TwTheme) return;
  const c = TwTheme.get(), eff = TwTheme.effective();
  b.dataset.choice = c;
  b.title = `Theme: ${THEME_NAMES[c]}${c === "system" ? ` (${eff} now)` : ""}`;
  document.querySelectorAll("#theme-menu [data-theme-choice]").forEach((item) =>
    item.setAttribute("aria-checked", String(item.dataset.themeChoice === c)));
  $("#tm-sys").textContent = `(${TwTheme.system()})`;
}

function uxThemeMenu(open) {
  const menu = $("#theme-menu"), b = $("#btn-theme");
  menu.hidden = !open;
  b.setAttribute("aria-expanded", String(open));
  if (open) (menu.querySelector('[aria-checked="true"]') || menu.querySelector("button")).focus();
}

// ── keyboard shortcuts dialog ──
function uxShortcuts(open) {
  const m = $("#shortcuts-modal");
  m.hidden = !open;
  if (open) $("#shortcuts-close").focus();
}

function uxTyping(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

document.addEventListener("DOMContentLoaded", () => {
  uxThemeButton();
  document.addEventListener("tw:theme", uxThemeButton);
  $("#btn-theme").addEventListener("click", () => uxThemeMenu($("#theme-menu").hidden));
  $("#theme-menu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-theme-choice]");
    if (!item) return;
    TwTheme.set(item.dataset.themeChoice);
    uxThemeMenu(false);
    $("#btn-theme").focus();
  });
  $("#theme-menu").addEventListener("keydown", (e) => {
    const items = [...$("#theme-menu").querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === "Escape" || e.key === "Tab") { if (e.key === "Escape") e.preventDefault(); uxThemeMenu(false); if (e.key === "Escape") $("#btn-theme").focus(); }
  });
  document.addEventListener("mousedown", (e) => {
    if (!$("#theme-menu").hidden && !e.target.closest(".theme-wrap")) uxThemeMenu(false);
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (mac) document.querySelectorAll("kbd.mod").forEach((k) => { k.textContent = "⌘"; });
  $("#btn-shortcuts").addEventListener("click", () => uxShortcuts(true));
  $("#shortcuts-close").addEventListener("click", () => uxShortcuts(false));
  $("#shortcuts-modal").addEventListener("mousedown", (e) => { if (e.target.id === "shortcuts-modal") uxShortcuts(false); });
  document.addEventListener("keydown", (e) => {
    if (!$("#shortcuts-modal").hidden && e.key === "Escape") { e.preventDefault(); uxShortcuts(false); return; }
    // Ctrl/Cmd+S saves the open file instead of the browser's "save page"
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyS") {
      if ($("#view-workspace").hidden) return;
      e.preventDefault();
      if (state.activeFile && !isBinary(state.activeFile)) saveActive(true);
      return;
    }
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !uxTyping(document.activeElement) &&
        ![...document.querySelectorAll(".modal")].some((m) => !m.hidden)) {
      e.preventDefault();
      uxShortcuts(true);
    }
  });
});

// ── preview: a figure whose image is missing gets a clear placeholder ──
const UX_IMG_MISSING = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest("#preview-doc") || img.dataset.missing) return;
  img.dataset.missing = "1";
  const box = document.createElement("span");
  box.className = "fig-missing";
  box.title = "The figure's file is not in the project (upload it from the files panel)";
  box.innerHTML = `${UX_IMG_MISSING}<span>Image not found</span><code>${esc(img.getAttribute("alt") || "")}</code>`;
  img.replaceWith(box);
}, true);
