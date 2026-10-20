"use strict";

const STARTER_TEX = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath, amssymb}
\title{Untitled}
\begin{document}
\maketitle

\section{Introduction}
Edit this source, then click \textbf{Convert project}.
The mass-energy relation is $E=mc^2$.
\end{document}
`;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const codeify = (s) => esc(s).replace(/(\\[A-Za-z@]+|\$[^$]*\$)/g, "<code>$1</code>");

// ── Lightweight syntax highlighting (overlay behind the textarea) ──
const TEX_RE = /(%[^\n]*)|(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\\n])*\$)|(\\(?:[a-zA-Z]*ref|[cC]ref|labelcref|autoref|[a-zA-Z]*cite[a-zA-Z]*)\*?(?:\[[^\]\n]*\]){0,2}\{[^{}\n]*\})|(\\[a-zA-Z@]+\*?|\\.)|([{}\[\]])/g;
const MD_RE = /(^#{1,6} .*)|(^```[\s\S]*?^```|`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\$[^$\n]+\$)|(^\s*(?:[-*+]|\d+\.) )|(\[[^\]\n]*\]\([^)\n]*\))|(^>.*)/gm;

function highlightWith(text, re, classes) {
  let out = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    let cls = "";
    for (let i = 1; i < m.length; i++) { if (m[i] !== undefined) { cls = classes[i - 1]; break; } }
    out += typeof cls === "function" ? cls(m[0]) : `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;  // guard against zero-width loops
  }
  return out + esc(text.slice(last));
}

// \ref{…}/\cite{…}: keys that exist nowhere in the project get a wavy underline.
function highlightRefCmd(tok) {
  const open = tok.indexOf("{");
  const head = tok.slice(0, open), body = tok.slice(open + 1, -1);
  const isCite = /cite/i.test(head.match(/^\\[a-zA-Z]*/)[0]);
  const keys = state.cIndex ? TexComplete.knownKeys(state.cIndex) : null;
  const known = keys && (isCite ? keys.cites : keys.labels);
  const name = head.match(/^\\[a-zA-Z]*\*?/)[0];
  const opts = head.slice(name.length);
  const parts = body.split(/(,)/).map((p) => {
    const k = p.trim();
    if (p === "," || !k || !known || known.has(k) || (isCite && k === "*")) return esc(p);
    return `<span class="hl-undef">${esc(p)}</span>`;
  }).join("");
  return `<span class="hl-cmd">${esc(name)}</span>${esc(opts)}<span class="hl-brace">{</span>${parts}<span class="hl-brace">}</span>`;
}

function langFor(path) {
  if (!path) return null;
  const p = path.toLowerCase();
  if (p.endsWith(".md") || p.endsWith(".markdown")) return "md";
  if (/\.(tex|cls|sty|tikz|bib)$/.test(p)) return "tex";
  return null;
}

function highlightCode(text, lang) {
  if (lang === "tex") return highlightWith(text, TEX_RE, ["hl-comment", "hl-math", highlightRefCmd, "hl-cmd", "hl-brace"]);
  if (lang === "md") return highlightWith(text, MD_RE, ["hl-head", "hl-code", "hl-bold", "hl-italic", "hl-math", "hl-list", "hl-link", "hl-quote"]);
  return esc(text);
}

function updateHighlight() {
  const el = $("#highlight");
  if (!el) return;
  const text = $("#source").value;
  el.innerHTML = highlightCode(text, langFor(state.activeFile)) + "\n";
}

function syncHighlightScroll() {
  const src = $("#source"), hl = $("#highlight");
  hl.scrollTop = src.scrollTop;
  hl.scrollLeft = src.scrollLeft;
}

// ── Source ⇄ preview location sync ──────────────────────
// Rough, structure-aware scroll sync: match source headings to the preview's
// heading anchors (by text) and interpolate by line between them, so it adapts
// to font/window size (it scrolls to real elements, not a naive ratio).
function _normHeading(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function _headingKey(line, lang) {
  if (lang === "tex") {
    const m = line.match(/\\(?:part|chapter|(?:sub)*section|subparagraph|paragraph|title)\*?\s*(?:\[[^\]]*\])?\s*\{/);
    if (!m) return null;
    // scan from the opening brace to its balanced close (handles \textbf{…} etc.)
    let depth = 0, start = m.index + m[0].length, end = -1;
    for (let i = start - 1; i < line.length; i++) {
      if (line[i] === "{") depth++;
      else if (line[i] === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) return null;  // unbalanced (title spans lines) — skip
    return _normHeading(line.slice(start, end).replace(/\\[a-zA-Z]+/g, "").replace(/[{}]/g, ""));
  } else if (lang === "md") {
    const m = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) return _normHeading(m[1].replace(/[*_`]/g, ""));
  }
  return null;
}

// Ordered [{line, anchor}] pairs linking source heading lines to preview anchors.
function _syncPairs() {
  const lang = langFor(state.activeFile);
  if (!lang || !state.preview) return [];
  const lines = $("#source").value.split("\n");
  const srcHeads = [];
  for (let i = 0; i < lines.length; i++) {
    const k = _headingKey(lines[i], lang);
    if (k) srcHeads.push({ line: i, key: k });
  }
  const prev = (state.preview.outline || [])
    .filter((o) => o.type === "heading")
    .map((o) => ({ anchor: o.anchor, key: _normHeading(o.text) }));
  const pairs = [];
  let pi = 0;
  for (const s of srcHeads) {
    let j = -1;
    for (let k = pi; k < prev.length; k++) { if (prev[k].key === s.key) { j = k; break; } }
    if (j >= 0) { pairs.push({ line: s.line, anchor: prev[j].anchor }); pi = j + 1; }
  }
  return pairs;
}

function _topWithin(el, container) {
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

function _caretLine(ta) {
  return ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
}

function _lineStartIndex(text, line) {
  let idx = 0;
  const parts = text.split("\n");
  for (let i = 0; i < line && i < parts.length; i++) idx += parts[i].length + 1;
  return idx;
}

// Pixel offset of a logical line in the wrapping textarea, via a hidden mirror
// that replicates its box — so font size and wrapping are accounted for.
let _mirror = null;
function _measureLineTop(ta, line) {
  if (!_mirror) { _mirror = document.createElement("div"); document.body.appendChild(_mirror); }
  const cs = getComputedStyle(ta), m = _mirror.style;
  for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
                   "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
                   "whiteSpace", "overflowWrap", "wordBreak", "boxSizing"]) m[p] = cs[p];
  m.position = "absolute"; m.visibility = "hidden"; m.left = "-9999px"; m.top = "0";
  m.height = "auto"; m.width = ta.clientWidth + "px";
  _mirror.textContent = ta.value.slice(0, _lineStartIndex(ta.value, line));
  const marker = document.createElement("span");
  marker.textContent = "​";
  _mirror.appendChild(marker);
  return marker.offsetTop;
}

function _scrollEditorToLine(line, flash) {
  const ta = $("#source");
  line = Math.max(0, line);
  const idx = _lineStartIndex(ta.value, line);
  try { ta.focus({ preventScroll: true }); ta.setSelectionRange(idx, idx); } catch (_) {}
  const top = _measureLineTop(ta, line);
  ta.scrollTop = Math.max(0, top - ta.clientHeight * 0.3);
  syncHighlightScroll();
  if (flash) flashEditorLine(top - ta.scrollTop);
}

// A transient band over the target line (no selection: typing stays safe).
function flashEditorLine(y) {
  const wrap = $("#code-wrap");
  const band = document.createElement("div");
  band.className = "line-flash";
  band.style.top = y + "px";
  wrap.appendChild(band);
  setTimeout(() => band.remove(), 1100);
}

// Sync anchors (data-src="fileIndex:line") in the preview → [{el, file, line}].
function previewAnchors() {
  if (state.anchors) return state.anchors;
  const files = (state.preview && state.preview.source_map && state.preview.source_map.files) || [];
  state.anchors = [...$("#preview-doc").querySelectorAll("[data-src]")]
    .map((el) => ({ el, ...TexSync.parseSrc(el.dataset.src, files) }))
    .filter((a) => a.file != null);
  return state.anchors;
}

function hasSourceMap() {
  return !!(state.preview && state.preview.source_map && previewAnchors().length);
}

function _withY(anchors, container) {
  const base = container.getBoundingClientRect().top - container.scrollTop;
  return anchors.map((a) => ({ ...a, y: a.el.getBoundingClientRect().top - base }));
}

function flashPreviewBlock(el) {
  const pv = $("#preview-doc");
  let seg = el;
  while (seg && seg.parentElement !== pv) seg = seg.parentElement;
  if (!seg) return;
  seg.classList.remove("sync-flash"); void seg.offsetWidth;  // restart the animation
  seg.classList.add("sync-flash");
  setTimeout(() => seg.classList.remove("sync-flash"), 1200);
}

// Editor caret → preview, via the source map (works across \input files).
function syncEditorToPreview(e) {
  if (!state.previewVisible || !state.preview || isBinary(state.activeFile)) return;
  if (!hasSourceMap()) return headingSyncEditorToPreview();
  const pv = $("#preview-doc"), ta = $("#source");
  const files = state.preview.source_map.files;
  const includes = (state.preview.source_map.includes || [])
    .map(([f, line, t]) => ({ file: files[f], line, target: files[t] }));
  const locate = () => TexSync.editorToPreview(_withY(previewAnchors(), pv),
                                                state.activeFile, _caretLine(ta) + 1, includes);
  const hit = locate();
  if (!hit) return;
  pv.scrollTo({ top: Math.max(0, hit.y - pv.clientHeight * 0.3) });
  // off-screen blocks may only get their real size once scrolled into view
  requestAnimationFrame(() => {
    const again = locate();
    if (again) pv.scrollTo({ top: Math.max(0, again.y - pv.clientHeight * 0.3) });
    if (e && e.type === "click") flashPreviewBlock(hit.anchor.el);
  });
}

// Click in the preview → open the right file at the right line.
async function syncPreviewToEditor(e) {
  if (!state.preview) return;
  if (e.target.closest("a[href]")) return;  // let links (refs) behave as links
  if (!hasSourceMap()) return headingSyncPreviewToEditor(e);
  const pv = $("#preview-doc");
  const y = e.clientY - pv.getBoundingClientRect().top + pv.scrollTop;
  const hit = TexSync.previewToEditor(_withY(previewAnchors(), pv), y);
  if (!hit) return;
  if (hit.file !== state.activeFile) {
    if (!fileMeta(hit.file)) return;
    await openFile(hit.file, { line: hit.line });
  } else {
    _scrollEditorToLine(hit.line - 1, true);
  }
}

// Fallback without a source map: match source headings to preview headings.
function headingSyncEditorToPreview() {
  if (!state.previewVisible || !state.preview || isBinary(state.activeFile)) return;
  const pv = $("#preview-doc"), ta = $("#source");
  const line = _caretLine(ta);
  const pairs = _syncPairs();
  let target;
  if (pairs.length) {
    let lo = null, hi = null;
    for (const p of pairs) { if (p.line <= line) lo = p; else { hi = p; break; } }
    if (!lo) { target = 0; }
    else {
      const elLo = document.getElementById(lo.anchor);
      if (!elLo) return;
      target = _topWithin(elLo, pv);
      const elHi = hi && document.getElementById(hi.anchor);
      if (elHi) {
        const frac = (line - lo.line) / Math.max(1, hi.line - lo.line);
        target += frac * (_topWithin(elHi, pv) - target);
      }
    }
  } else {
    const total = Math.max(1, ta.value.split("\n").length - 1);
    target = (line / total) * (pv.scrollHeight - pv.clientHeight);
  }
  pv.scrollTo({ top: Math.max(0, target - 12), behavior: "smooth" });
}

function headingSyncPreviewToEditor(e) {
  if (!state.preview || isBinary(state.activeFile)) return;
  const pv = $("#preview-doc"), ta = $("#source");
  const pairs = _syncPairs()
    .map((p) => ({ ...p, el: document.getElementById(p.anchor) }))
    .filter((p) => p.el);
  let line;
  if (pairs.length) {
    const y = e.clientY;
    let lo = null, hi = null;
    for (const p of pairs) { if (p.el.getBoundingClientRect().top <= y + 4) lo = p; else { hi = p; break; } }
    if (!lo) { line = 0; }
    else {
      line = lo.line;
      if (hi) {
        const loT = lo.el.getBoundingClientRect().top, hiT = hi.el.getBoundingClientRect().top;
        const frac = (y - loT) / Math.max(1, hiT - loT);
        line = Math.round(lo.line + frac * (hi.line - lo.line));
      }
    }
  } else {
    const rel = pv.scrollTop + (e.clientY - pv.getBoundingClientRect().top);
    line = Math.round((rel / Math.max(1, pv.scrollHeight)) * (ta.value.split("\n").length - 1));
  }
  _scrollEditorToLine(line);
}

// ── Editor autocompletion (engine: complete.js) ─────────
// Popup at the caret with context-aware candidates; snippets with tabstops
// (Tab / Shift+Tab to move, Esc to leave); Enter after \begin{env} adds the
// matching \end{env}. Ctrl+Space opens the list on demand.
const MRU_KEY = "tw_ac_mru";

function loadMru() {
  try { return JSON.parse(localStorage.getItem(MRU_KEY) || "{}") || {}; } catch { return {}; }
}

function bumpMru(item) {
  const k = item.kind + ":" + item.label;
  state.acMru[k] = (state.acMru[k] || 0) + 1;
  try { localStorage.setItem(MRU_KEY, JSON.stringify(state.acMru)); } catch { /* ignore */ }
}

// Rebuild the project symbol index (labels, bib keys, macros, files) soon.
function refreshCompletionIndex(now) {
  clearTimeout(state.cIndexTimer);
  const build = () => {
    const files = {};
    for (const f of state.files || []) files[f.path] = f.is_binary ? "" : (state.contents[f.path] ?? "");
    state.cIndex = TexComplete.buildIndex(files);
    updateHighlight();
  };
  if (now) build(); else state.cIndexTimer = setTimeout(build, 400);
}

function _caretCoords(ta, idx) {
  _measureLineTop(ta, 0);  // sizes the shared mirror like the textarea
  _mirror.textContent = ta.value.slice(0, idx);
  const marker = document.createElement("span");
  marker.textContent = "​";
  _mirror.appendChild(marker);
  return { left: marker.offsetLeft, top: marker.offsetTop, height: marker.offsetHeight || 20 };
}

function edInsert(from, to, text) {
  const ta = $("#source");
  state.edInserting = true;
  ta.focus();
  ta.setSelectionRange(from, to);
  let ok = false;
  try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
  if (!ok) {  // keeps working where execCommand is unavailable (no native undo then)
    ta.setRangeText(text, from, to, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  state.edInserting = false;
}

// Key map of the editor (textarea #source). One place decides every key:
//
//   popup open      ↑/↓ or Ctrl+P/N move · PgUp/PgDn jump · Tab or Enter accept
//                   Shift+Tab move up · Esc close · ←/→/Home/End close and move
//   snippet active  Tab / Shift+Tab next / previous stop · Esc leave the snippet
//   otherwise       Tab: indent a multi-line selection, expand an environment
//                   name typed alone on a line ("itemize" → \begin…\end),
//                   complete a unique match or open the list, else indent
//                   Shift+Tab outdent · Ctrl/Cmd+Space open the list
//                   Esc then Tab: move focus out of the editor (no keyboard trap)
//                   Enter after \begin{env}: add the matching \end{env}
// Modified Tab (Ctrl/Cmd/Alt+Tab) and IME composition are never intercepted.
const INDENT = "  ";

function edAcUpdate(force, argsOnly) {
  const ta = $("#source");
  if (!state.activeFile || isBinary(state.activeFile) || langFor(state.activeFile) !== "tex") return edAcClose();
  if (!state.cIndex) refreshCompletionIndex(true);
  const caret = ta.selectionStart;
  const res = TexComplete.complete(ta.value, caret, state.cIndex,
                                   { file: state.activeFile, mru: state.acMru, limit: 50 });
  if (!res || !res.items.length || (argsOnly && res.kind === "cmd")) return edAcClose();
  // commands open after the first letter (or on demand); brace arguments at once
  if (!force && !state.edAc && res.kind === "cmd" && !res.query) return edAcClose();
  if (res.items.length === 1 && res.items[0].label === (res.kind === "cmd" ? "\\" : "") + res.query && !force) return edAcClose();
  state.edAc = { ...res, index: 0 };
  edAcRender();
}

function symbolIcon(id) {
  return `<svg class="sym-svg" aria-hidden="true"><use href="/static/symbols.svg#${esc(id)}"/></svg>`;
}

function edAcRender() {
  const box = $("#ed-ac"), ac = state.edAc, ta = $("#source");
  if (!ac) { box.hidden = true; return; }
  const q = ac.query.toLowerCase();
  const mark = (label) => {
    const plain = label.replace(/^\\/, "");
    const i = q ? plain.toLowerCase().indexOf(q) : -1;
    const pre = label.length - plain.length;
    if (i < 0) return esc(label);
    return esc(label.slice(0, pre + i)) + "<b>" + esc(label.slice(pre + i, pre + i + q.length)) + "</b>" + esc(label.slice(pre + i + q.length));
  };
  const icon = (it) => it.sym ? symbolIcon(it.sym)
    : it.swatch ? `<span class="ed-ac-swatch" style="background:${esc(it.swatch)}"></span>` : "";
  box.innerHTML = ac.items.map((it, i) =>
    `<div class="ed-ac-item${i === ac.index ? " active" : ""}" data-i="${i}" role="option">` +
    `<span class="ed-ac-kind k-${esc(it.kind)}">${esc(it.kind === "macro" ? "cmd" : it.kind === "newlabel" ? "label" : it.kind)}</span>` +
    `<span class="ed-ac-icon">${icon(it)}</span>` +
    `<span class="ed-ac-label">${mark(it.label)}</span>` +
    `<span class="ed-ac-detail">${esc(it.detail || "")}</span>` +
    (it.source ? `<span class="ed-ac-src">${esc(it.source)}</span>` : "") + `</div>`).join("") +
    `<div class="ed-ac-foot">Tab/Enter accept · ↑↓ choose · Esc close</div>`;
  box.querySelectorAll(".ed-ac-item").forEach((el) =>
    el.addEventListener("mousedown", (e) => { e.preventDefault(); edAcAccept(+el.dataset.i); }));
  const c = _caretCoords(ta, ac.from);
  const wrap = $("#code-wrap").getBoundingClientRect();
  box.hidden = false;
  const left = Math.max(4, Math.min(c.left - ta.scrollLeft, wrap.width - box.offsetWidth - 8));
  let top = c.top - ta.scrollTop + c.height + 2;
  if (top + box.offsetHeight > wrap.height - 4) top = Math.max(4, c.top - ta.scrollTop - box.offsetHeight - 2);
  box.style.left = left + "px";
  box.style.top = top + "px";
  const act = box.querySelector(".ed-ac-item.active");
  if (act) act.scrollIntoView({ block: "nearest" });
}

function edAcClose() { state.edAc = null; const b = $("#ed-ac"); if (b) b.hidden = true; }

// Insert a snippet (``${n:placeholder}`` stops) over [from, to): tabs become the
// editor's indent unit, continuation lines follow the current line's indent.
// An outer snippet survives an inner plain insertion (e.g. a label picked in a
// \ref{…} stop); a new snippet with stops replaces it.
function edInsertSnippet(from, to, snippet) {
  const ta = $("#source");
  const lineStart = ta.value.lastIndexOf("\n", from - 1) + 1;
  const indent = /^[ \t]*/.exec(ta.value.slice(lineStart))[0];
  const snip = TexComplete.expandSnippet(snippet.replace(/\t/g, INDENT));
  const text = TexComplete.indentSnippet(snip.text, indent);
  const shift = (pos) => pos + (snip.text.slice(0, pos).split("\n").length - 1) * indent.length;
  const outer = state.snippet;
  edInsert(from, to, text);
  const stops = snip.stops.map((st) => ({ start: from + shift(st.start), end: from + shift(st.end) }));
  const final = from + shift(snip.final);
  if (stops.length) {
    state.snippet = { stops, cur: -1, len: ta.value.length, final };
    edSnippetGo(1);
    return;
  }
  ta.setSelectionRange(final, final);
  if (outer) { state.snippet = outer; edSnippetTrack(); }
  edAcUpdate(false, true);  // e.g. \ref → straight into the label list
}

function edAcAccept(i) {
  const ac = state.edAc;
  if (!ac) return;
  const it = ac.items[i];
  edAcClose();
  bumpMru(it);
  edInsertSnippet(ac.from, ac.to, it.insert + (ac.close || ""));
}

function edSnippetGo(dir) {
  const sn = state.snippet, ta = $("#source");
  if (!sn) return;
  sn.cur += dir;
  if (sn.cur < 0) sn.cur = 0;
  if (sn.cur >= sn.stops.length) {  // past the last stop: leave the snippet
    ta.setSelectionRange(sn.final, sn.final);
    state.snippet = null;
    return;
  }
  const st = sn.stops[sn.cur];
  ta.setSelectionRange(st.start, st.end);
  edAcUpdate(false, true);  // a stop inside \cite{…}/\ref{…} lists keys right away
}

// Keep snippet stops aligned with edits made inside the current stop.
function edSnippetTrack() {
  const sn = state.snippet, ta = $("#source");
  if (!sn || sn.cur < 0) return;
  const delta = ta.value.length - sn.len;
  sn.len = ta.value.length;
  const st = sn.stops[sn.cur];
  const caret = ta.selectionStart;
  if (caret < st.start || caret > st.end + Math.max(0, delta)) { state.snippet = null; return; }
  st.end = Math.max(st.start, st.end + delta);
  for (let k = sn.cur + 1; k < sn.stops.length; k++) { sn.stops[k].start += delta; sn.stops[k].end += delta; }
  sn.final += delta;
}

function edOnInput(e) {
  if (state.edInserting) return;
  edSnippetTrack();
  const t = e && e.inputType;
  if (state.edAc || (t && (t.startsWith("insert") || t.startsWith("delete")))) {
    const d = e && e.data;
    if (state.edAc || (d && /[a-zA-Z@{,]/.test(d.slice(-1)))) edAcUpdate(false);
  }
  refreshCompletionIndex(false);
}

// Tab with nothing open: environment word → block, or complete. True if handled.
function edTabComplete() {
  const ta = $("#source"), v = ta.value, caret = ta.selectionStart;
  if (langFor(state.activeFile) !== "tex" || TexComplete.inComment(v, caret)) return false;
  if (!state.cIndex) refreshCompletionIndex(true);
  const lineStart = v.lastIndexOf("\n", caret - 1) + 1;
  const word = /^([ \t]*)([A-Za-z]+\*?)$/.exec(v.slice(lineStart, caret));
  if (word && !/^[A-Za-z*]/.test(v[caret] || "") && TexComplete.envNames(state.cIndex).has(word[2])) {
    bumpMru({ kind: "env", label: word[2] });
    edInsertSnippet(lineStart + word[1].length, caret, TexComplete.envBlock(word[2], state.cIndex));
    return true;
  }
  const res = TexComplete.complete(v, caret, state.cIndex, { file: state.activeFile, mru: state.acMru, limit: 50 });
  if (!res || !res.items.length) return false;
  const top = res.items[0];
  const typed = (res.kind === "cmd" ? "\\" : "") + res.query;
  if (top.label === typed && top.insert === top.label && !res.close) return false;  // already complete
  state.edAc = { ...res, index: 0 };
  if (res.items.length === 1 || top.label === typed) return edAcAccept(0), true;
  edAcRender();  // several candidates: show them; Tab again accepts
  return true;
}

// Indent (dir > 0) or outdent the selected lines; Tab with a caret inserts INDENT.
function edIndent(dir) {
  const ta = $("#source"), v = ta.value;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (dir > 0 && !v.slice(s, e).includes("\n")) { edInsert(s, e, INDENT); return; }
  const a = v.lastIndexOf("\n", s - 1) + 1;
  let b = v.indexOf("\n", e > s && v[e - 1] === "\n" ? e - 1 : e);
  if (b < 0) b = v.length;
  const lines = v.slice(a, b).split("\n");
  const out = lines.map((l) => dir > 0 ? (l ? INDENT + l : l) : l.replace(/^(?: {1,2}|\t)/, ""));
  const joined = out.join("\n");
  if (joined === v.slice(a, b)) return;
  edInsert(a, b, joined);
  if (s === e) {
    const p = Math.max(a, s - (lines[0].length - out[0].length));
    ta.setSelectionRange(p, p);
  } else {
    ta.setSelectionRange(a, a + joined.length);
  }
}

function edKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return;  // IME composition owns the keys
  const ac = state.edAc, ta = $("#source");
  const mods = e.ctrlKey || e.metaKey || e.altKey;
  const tab = e.key === "Tab" && !mods;
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;  // e.g. Shift of Shift+Tab
  const escArmed = state.tabEscape;
  state.tabEscape = false;
  if ((e.ctrlKey || e.metaKey) && e.code === "Space") { e.preventDefault(); return edAcUpdate(true); }
  if (ac) {
    const n = ac.items.length;
    const move = (d) => { e.preventDefault(); ac.index = (ac.index + d + n) % n; edAcRender(); };
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) return move(1);
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) return move(-1);
    if (e.key === "PageDown") return move(Math.min(8, n - 1 - ac.index) || 0);
    if (e.key === "PageUp") return move(-Math.min(8, ac.index) || 0);
    if (tab && e.shiftKey) return move(-1);
    if (tab || (e.key === "Enter" && !mods && !e.shiftKey)) { e.preventDefault(); return edAcAccept(ac.index); }
    if (e.key === "Escape") { e.preventDefault(); return edAcClose(); }
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || (e.key === "Enter" && e.shiftKey)) edAcClose();
  }
  if (state.snippet) {
    if (tab) { e.preventDefault(); return edSnippetGo(e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") { state.snippet = null; return; }
  }
  if (e.key === "Escape") { state.tabEscape = true; return; }  // the next Tab leaves the editor
  if (tab) {
    if (escArmed) return;  // let the browser move focus
    e.preventDefault();
    if (e.shiftKey) return edIndent(-1);
    const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n");
    if (!multi && ta.selectionStart === ta.selectionEnd && edTabComplete()) return;
    return edIndent(1);
  }
  // Enter right after \begin{env}: add the matching \end{env} below
  if (e.key === "Enter" && !e.shiftKey && !mods &&
      langFor(state.activeFile) === "tex" && ta.selectionStart === ta.selectionEnd) {
    const caret = ta.selectionStart, v = ta.value;
    const lineStart = v.lastIndexOf("\n", caret - 1) + 1;
    const line = v.slice(lineStart, caret);
    const m = /\\begin\{([^}]+)\}(?:\[[^\]]*\]|\{[^}]*\})*\s*$/.exec(line);
    const rest = v.slice(caret, v.indexOf("\n", caret) < 0 ? v.length : v.indexOf("\n", caret));
    if (m && !rest.trim() && !TexComplete.inComment(v, caret) && TexComplete.needsEnd(v, caret, m[1])) {
      e.preventDefault();
      const indent = /^[ \t]*/.exec(line)[0];
      edInsert(caret, caret, `\n${indent}${INDENT}\n${indent}\\end{${m[1]}}`);
      const pos = caret + 1 + indent.length + INDENT.length;
      ta.setSelectionRange(pos, pos);
    }
  }
}

// ── Symbol palette ──────────────────────────────────────
// A searchable grid of common symbols (symbols.js / symbols.svg). Clicking one
// inserts it at the editor's caret; a math-only symbol typed outside math is
// wrapped in $…$. Esc closes the palette and returns to the editor.
function symPaletteToggle(force) {
  const panel = $("#sym-panel");
  const open = force === undefined ? panel.hidden : force;
  panel.hidden = !open;
  $("#btn-symbols").classList.toggle("active", open);
  if (open) {
    const ta = $("#source");
    if (document.activeElement === ta) state.edSel = [ta.selectionStart, ta.selectionEnd];
    symPaletteRender();
    $("#sym-search").focus();
  }
}

function symPaletteRender() {
  const q = $("#sym-search").value.trim().toLowerCase().replace(/^\\/, "");
  const group = state.symGroup || "All";
  const recent = Object.entries(state.acMru).filter(([k]) => k.startsWith("sym:"))
    .sort((a, b) => b[1] - a[1]).map(([k]) => k.slice(4));
  const tabs = ["All", ...(recent.length ? ["Recent"] : []), ...TexSymbols.GROUPS];
  $("#sym-tabs").innerHTML = tabs.map((g) =>
    `<button class="sym-tab${g === group ? " active" : ""}" data-g="${esc(g)}">${esc(g)}</button>`).join("");
  $("#sym-tabs").querySelectorAll(".sym-tab").forEach((b) => b.addEventListener("click", () => {
    state.symGroup = b.dataset.g;
    $("#sym-search").value = "";  // picking a group starts a fresh browse
    symPaletteRender();
  }));
  let list = TexSymbols.LIST;
  if (group === "Recent") list = recent.map((c) => TexSymbols.BY_CMD.get(c)).filter(Boolean);
  else if (group !== "All") list = list.filter((s) => s.group === group);
  if (q) list = list.filter((s) => s.cmd.toLowerCase().includes(q) || s.group.toLowerCase().includes(q));
  const grid = $("#sym-grid");
  grid.innerHTML = list.map((s) =>
    `<button class="sym-btn" data-cmd="${esc(s.cmd)}" title="\\${esc(s.cmd)}${s.pkg ? " (" + esc(s.pkg) + ")" : ""}">` +
    `${symbolIcon(TexSymbols.symbolId(s.cmd))}</button>`).join("") ||
    `<div class="muted" style="padding:10px">No symbol matches.</div>`;
  const hint = $("#sym-hint");
  const show = (b) => {
    const sy = TexSymbols.BY_CMD.get(b.dataset.cmd);
    hint.innerHTML = `<code>\\${esc(sy.cmd)}</code> · ${esc(sy.group.toLowerCase())}` +
      (sy.pkg ? ` · <code>${esc(sy.pkg)}</code>` : "") + (sy.where === "m" ? " · math" : sy.where === "t" ? " · text" : "");
  };
  grid.querySelectorAll(".sym-btn").forEach((b) => {
    b.addEventListener("click", () => symInsert(TexSymbols.BY_CMD.get(b.dataset.cmd)));
    b.addEventListener("mouseenter", () => show(b));
    b.addEventListener("focus", () => show(b));
  });
}

function symInsert(sym) {
  if (!sym || !state.activeFile || isBinary(state.activeFile)) return;
  const ta = $("#source");
  const [from, to] = state.edSel || [ta.selectionStart, ta.selectionEnd];
  let snip = "\\" + sym.cmd + (sym.snippet || "");
  if (sym.where === "m" && !TexComplete.inMath(ta.value, from)) snip = "$" + snip + "$";
  bumpMru({ kind: "sym", label: sym.cmd });
  edInsertSnippet(from, to, snip);
  state.edSel = [ta.selectionStart, ta.selectionEnd];
  if (!$("#sym-panel").hidden) symPaletteRender();  // refresh the Recent row
}

// ── App state ───────────────────────────────────────────
const state = {
  project: null,   // detail object {id, name, main_path, files: [...]}
  files: [],       // file metas [{path, is_binary, size, content?}]
  activeFile: null,
  dirty: false,
  contents: {},    // path -> in-memory content (may differ from server until saved)
  rtab: "report",  // report | structure | assistant
  preview: null,   // last preview payload
  previewMode: "quick", // quick (incremental) | full — auto-refresh strategy
  previewRev: null, // server revision of the segments currently shown
  previewStale: false,
  previewInflight: false,
  previewQueued: null,
  reconcileTimer: null,
  rootFile: null,  // sticky render root (a file with \documentclass)
  anchors: null,   // cached sync anchors [{el, file, line}]
  previewVisible: false,
  splitRatio: 0.55,// source fraction of the editor split
  previewTimer: null,
  lastReport: null,// last conversion report (context for "fix")
  provider: null,  // {name, model, has_key} selected provider
  providers: [],   // all configured providers
  allProjects: [], // gallery cache
  gallerySearch: "",
  galleryFilter: "all",
  ac: null,        // assistant autocomplete: {kind, items, index, start}
  skills: [],      // slash-command skills (from /api/skills)
  conversation: null, // active chat session {id, messages:[...]}
  collapsed: new Set(), // collapsed folder paths in the file tree
  layout: null,    // side panels {files,report: {width, collapsed}} (localStorage)
  cIndex: null,    // editor completion index (TexComplete.buildIndex)
  cIndexTimer: null,
  edAc: null,      // open editor completion popup {items, index, from, to, kind}
  edInserting: false,
  snippet: null,   // active snippet {stops: [{start,end}], cur, len, final}
  tabEscape: false,// Esc was pressed: the next Tab moves focus out of the editor
  edSel: null,     // editor selection saved on blur (symbol palette inserts there)
  symGroup: "All", // symbol palette tab
  acMru: loadMru(),// accepted completions → ranking boost
  authEnabled: false,
  token: localStorage.getItem("tw_token") || null,
  user: null,      // {username, role}
};

// ── Auth helpers ────────────────────────────────────────
function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

// Append the session token to a media/download URL (img/href can't set headers).
function withToken(url) {
  if (!state.authEnabled || !state.token) return url;
  return url + (url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(state.token);
}

function handleUnauthorized() {
  if (!state.authEnabled) return;
  state.token = null;
  localStorage.removeItem("tw_token");
  showLogin();
}

async function api(method, path, body) {
  const opts = { method, headers: { ...authHeaders() } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (r.status === 401) { handleUnauthorized(); }
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `${method} ${path} failed (${r.status})`);
  return j;
}

document.addEventListener("DOMContentLoaded", () => {
  $("#login-form").addEventListener("submit", doLogin);
  $("#btn-logout").addEventListener("click", logout);
  document.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => runAssistant(b.dataset.act)));
  $("#ask-send").addEventListener("click", submitAsk);
  $("#ask-input").addEventListener("input", () => { acUpdate(); autoGrowAsk(); });
  $("#ask-input").addEventListener("keydown", acKeydown);
  $("#ask-input").addEventListener("blur", () => setTimeout(acClose, 120));
  $("#assistant-provider").addEventListener("change", (e) => {
    state.provider = state.providers.find((p) => p.name === e.target.value) || null;
    renderProviderMeta();
  });
  $("#btn-new-chat").addEventListener("click", newConversation);
  $("#btn-memory").addEventListener("click", openMemory);
  $("#btn-about").addEventListener("click", openAbout);
  $("#about-close").addEventListener("click", () => $("#about-modal").hidden = true);
  $("#about-modal").addEventListener("click", (e) => {
    if (e.target === $("#about-modal")) $("#about-modal").hidden = true;
  });
  $("#memory-cancel").addEventListener("click", () => $("#memory-modal").hidden = true);
  $("#memory-save").addEventListener("click", saveMemory);
  $("#crumb-home").addEventListener("click", showProjects);
  $("#btn-new").addEventListener("click", newProject);
  $("#btn-import-md").addEventListener("click", importMarkdown);
  $("#btn-import-arxiv").addEventListener("click", importArxiv);
  $("#btn-coverage").addEventListener("click", showCoverage);
  $("#cov-back").addEventListener("click", showProjects);
  $("#gallery-search").addEventListener("input", (e) => {
    state.gallerySearch = e.target.value;
    renderGallery();
  });
  document.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      state.galleryFilter = b.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("active", x === b));
      renderGallery();
    }));
  $("#btn-upload").addEventListener("click", () => $("#archive-input").click());
  $("#archive-input").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";          // allow re-selecting the same file
    if (f) uploadArchive(f);
  });
  $("#btn-add-file").addEventListener("click", () => addFile());
  $("#btn-upload-asset").addEventListener("click", () => $("#asset-input").click());
  $("#asset-input").addEventListener("change", (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (f) uploadAsset(f);
  });
  $("#btn-import-tex").addEventListener("click", importMarkdownFile);
  $("#btn-save").addEventListener("click", () => saveActive(true));
  $("#btn-save-settings").addEventListener("click", saveSettings);
  $("#btn-convert").addEventListener("click", convertProject);
  $("#source").addEventListener("input", (e) => {
    if (!state.activeFile) return;
    state.contents[state.activeFile] = $("#source").value;
    updateHighlight();
    setDirty(true);
    markPreviewStale();
    edOnInput(e);
  });
  $("#source").addEventListener("keydown", edKeydown);
  $("#source").addEventListener("blur", () => {
    const ta = $("#source");
    state.edSel = [ta.selectionStart, ta.selectionEnd];  // where the symbol palette inserts
    setTimeout(edAcClose, 150);
  });
  $("#source").addEventListener("focus", () => { state.edSel = null; });
  $("#btn-symbols").addEventListener("click", () => symPaletteToggle());
  $("#sym-close").addEventListener("click", () => { symPaletteToggle(false); $("#source").focus(); });
  $("#sym-search").addEventListener("input", symPaletteRender);
  $("#sym-panel").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); symPaletteToggle(false); $("#source").focus(); }
    if (e.key === "Enter" && e.target.id === "sym-search") {
      e.preventDefault();
      const first = $("#sym-grid .sym-btn");
      if (first) first.click();
    }
  });
  $("#source").addEventListener("mousedown", () => { edAcClose(); });
  $("#source").addEventListener("scroll", () => { syncHighlightScroll(); edAcClose(); });
  // rough source ⇄ preview location sync (click the editor / click the preview)
  $("#source").addEventListener("click", syncEditorToPreview);
  $("#source").addEventListener("keyup", (e) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Enter"].includes(e.key)) syncEditorToPreview();
  });
  $("#preview-doc").addEventListener("click", syncPreviewToEditor);
  $("#btn-toggle-preview").addEventListener("click", () => togglePreview());
  $("#btn-refresh-preview").addEventListener("click", () => requestPreview("full"));
  document.querySelectorAll("[data-pmode]").forEach((b) =>
    b.addEventListener("click", () => setPreviewMode(b.dataset.pmode)));
  setPreviewMode(loadPreviewMode());
  setupSplitDivider();
  setupPanels();
  document.querySelectorAll("[data-rtab]").forEach((b) =>
    b.addEventListener("click", () => setReportTab(b.dataset.rtab)));
  boot();
});

// ── Boot / auth gate ────────────────────────────────────
async function boot() {
  loadHealth();
  let cfg = null;
  try { cfg = await api("GET", "/api/config"); } catch { /* shown elsewhere */ }
  state.authEnabled = !!(cfg && cfg.auth && cfg.auth.enabled);
  if (state.authEnabled) {
    if (!state.token) { showLogin(); return; }
    try {
      state.user = await api("GET", "/api/auth/me");  // validates the token
    } catch { showLogin(); return; }
  }
  startApp();
}

function startApp() {
  $("#login-overlay").hidden = true;
  renderSession();
  loadProvider();
  loadSkills();
  showProjects();
}

function renderSession() {
  const slot = $("#session-chip");
  if (!slot) return;
  if (state.authEnabled && state.user) {
    slot.hidden = false;
    $("#session-user").textContent = `${state.user.username} · ${state.user.role}`;
  } else {
    slot.hidden = true;
  }
}

function showLogin() {
  $("#login-overlay").hidden = false;
  $("#login-error").hidden = true;
  $("#login-user").value = "";
  $("#login-pass").value = "";
  $("#login-user").focus();
}

async function doLogin(e) {
  e.preventDefault();
  const username = $("#login-user").value.trim();
  const password = $("#login-pass").value;
  const err = $("#login-error");
  err.hidden = true;
  try {
    const res = await api("POST", "/api/auth/login", { username, password });
    state.token = res.token;
    state.user = res.user;
    localStorage.setItem("tw_token", res.token);
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("tw_token");
  showLogin();
}

async function loadHealth() {
  try {
    const j = await api("GET", "/api/health");
    state.appVersion = j.app_version || null;
    state.engineVersion = j.tex2word_version || null;
    $("#version-chip").textContent = `tex2word ${j.tex2word_version}`;
  } catch { $("#version-chip").textContent = "engine offline"; }
}

function openAbout() {
  const app = state.appVersion ? `v${state.appVersion}` : "—";
  const eng = state.engineVersion ? `tex2word ${state.engineVersion}` : "unknown";
  $("#about-version").textContent = state.appVersion ? `version ${app}` : "version —";
  $("#about-app").textContent = app;
  $("#about-engine").textContent = eng;
  $("#about-modal").hidden = false;
}

async function loadProvider() {
  try {
    const cfg = await api("GET", "/api/config");
    state.providers = cfg.providers || [];
    const name = cfg.default_provider;
    state.provider = state.providers.find((p) => p.name === name) || state.providers[0] || null;
  } catch { state.providers = []; state.provider = null; }
  renderProviderPicker();
  renderProviderMeta();
}

function renderProviderPicker() {
  const sel = $("#assistant-provider");
  if (!sel) return;
  if (!state.providers.length) { sel.hidden = true; return; }
  sel.hidden = false;
  sel.innerHTML = state.providers.map((p) =>
    `<option value="${esc(p.name)}"${state.provider && p.name === state.provider.name ? " selected" : ""}>${esc(p.name)}${p.has_key ? "" : " (no key)"}</option>`
  ).join("");
}

function renderProviderMeta() {
  const meta = $("#assistant-meta");
  if (!meta) return;
  if (state.provider) {
    const ok = state.provider.has_key;
    meta.innerHTML = `<span class="dot ${ok ? "" : "off"}"></span>tex-copilot · ${esc(state.provider.name)} · ${esc(state.provider.model)}${ok ? "" : " · no key"}`;
  } else {
    meta.innerHTML = `<span class="dot off"></span>tex-copilot · no provider configured`;
  }
}

// ── Router ──────────────────────────────────────────────
function setScreen(name) {
  $("#view-projects").hidden = name !== "projects";
  $("#view-workspace").hidden = name !== "workspace";
  $("#view-coverage").hidden = name !== "coverage";
}

// ── Coverage dashboard ──────────────────────────────────
async function showCoverage() {
  setCrumb("Coverage");
  setScreen("coverage");
  $("#cov-aggregate").innerHTML = "";
  $("#cov-table").innerHTML = `<div class="muted">Converting all projects…</div>`;
  let data;
  try {
    data = await api("GET", "/api/coverage");
  } catch (e) {
    $("#cov-table").innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
    return;
  }
  renderCoverage(data);
}

function covCard(value, label, cls) {
  return `<div class="cov-card ${cls || ""}"><div class="v">${esc(String(value))}</div><div class="k">${esc(label)}</div></div>`;
}

function renderCoverage(data) {
  const a = data.aggregate;
  const cov = Math.round((a.coverage || 0) * 100);
  $("#cov-aggregate").innerHTML =
    covCard(a.projects, "projects") +
    covCard(a.converted, "converted", "good") +
    covCard(a.aborted, "aborted", a.aborted ? "bad" : "") +
    covCard(`${cov}%`, "math OMML coverage") +
    covCard(`${a.valid}/${a.converted}`, "valid .docx") +
    covCard(a.warnings, "warnings", a.warnings ? "warn" : "") +
    covCard(a.errors, "errors", a.errors ? "bad" : "");

  if (!data.rows.length) {
    $("#cov-table").innerHTML = `<div class="empty">No projects yet.</div>`;
    return;
  }
  const rows = data.rows.map((r) => {
    if (r.aborted) {
      return `<tr><td class="name">${esc(r.label)}</td>
        <td colspan="6"><span class="pill bad">aborted</span> <span class="muted">${esc(r.error || "")}</span></td></tr>`;
    }
    const pct = Math.round((r.coverage || 0) * 100);
    return `<tr>
      <td class="name">${esc(r.label)}</td>
      <td><span class="cov-bar"><i style="width:${pct}%"></i></span><span class="num">${pct}%</span></td>
      <td class="num">${r.omml}/${r.image}/${r.raw}</td>
      <td class="num">${r.warnings}</td>
      <td class="num">${r.errors}</td>
      <td>${r.valid ? '<span class="pill ok">valid</span>' : '<span class="pill bad">invalid</span>'}</td>
      <td class="num">${r.seconds}s</td>
    </tr>`;
  }).join("");
  $("#cov-table").innerHTML = `
    <table class="cov-table">
      <thead><tr>
        <th>Project</th><th>Coverage</th><th>OMML/img/raw</th>
        <th>Warn</th><th>Err</th><th>Valid</th><th>Time</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function showProjects() {
  state.project = null;
  setCrumb();
  setScreen("projects");
  const grid = $("#project-grid");
  grid.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    state.allProjects = await api("GET", "/api/projects");
  } catch (e) {
    grid.innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
    return;
  }
  renderGallery();
}

function renderGallery() {
  const grid = $("#project-grid");
  const q = (state.gallerySearch || "").toLowerCase();
  const filter = state.galleryFilter || "all";
  let items = state.allProjects || [];
  items = items.filter((p) => {
    if (filter === "archived") return p.archived;
    if (p.archived) return false;
    if (filter === "favourite") return p.favourite;
    if (filter !== "all") return p.kind === filter;
    return true;
  });
  if (q) items = items.filter((p) => p.name.toLowerCase().includes(q));
  if (!items.length) {
    grid.innerHTML = `<div class="empty">${(state.allProjects || []).length ? "No matching projects." : "No projects yet. Click <b>New project</b> to start."}</div>`;
    return;
  }
  grid.innerHTML = "";
  for (const p of items) grid.appendChild(projectCard(p));
}

function projectCard(p) {
  const el = document.createElement("div");
  el.className = "project-card" + (p.archived ? " archived" : "");
  const time = esc((p.updated_at || "").replace("T", " ").replace("+00:00", " UTC"));
  el.innerHTML = `
    <div class="rail"></div>
    <div class="body">
      <div class="row">
        <div class="ic">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><polyline points="16 18 22 12 16 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="8 6 2 12 8 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.main_path)}</div>
        </div>
      </div>
      <div class="tags">
        <span class="tag-chip">${esc(p.kind)}</span>
        <span class="tag-muted">${p.file_count} file${p.file_count === 1 ? "" : "s"}</span>
        <span class="tag-time">updated ${time}</span>
      </div>
    </div>
    <div class="actions">
      <button class="card-act star ${p.favourite ? "on" : ""}" title="Favourite">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="${p.favourite ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/></svg>
      </button>
      <button class="card-act rename" title="Rename">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="card-act arch" title="${p.archived ? "Unarchive" : "Archive"}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="4" rx="1" stroke="currentColor" stroke-width="2"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <button class="card-act del" title="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`;
  el.querySelector(".body").addEventListener("click", () => openProject(p.id));
  const patch = async (body) => {
    const upd = await api("PATCH", `/api/projects/${p.id}`, body);
    Object.assign(p, upd);
    renderGallery();
  };
  el.querySelector(".star").addEventListener("click", (e) => { e.stopPropagation(); patch({ favourite: !p.favourite }); });
  el.querySelector(".arch").addEventListener("click", (e) => { e.stopPropagation(); patch({ archived: !p.archived }); });
  el.querySelector(".rename").addEventListener("click", async (e) => {
    e.stopPropagation();
    const name = await modal("Rename project", "Project name", p.name);
    if (name && name !== p.name) patch({ name });
  });
  el.querySelector(".del").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete project "${p.name}"? This cannot be undone.`)) return;
    await api("DELETE", `/api/projects/${p.id}`);
    state.allProjects = state.allProjects.filter((x) => x.id !== p.id);
    renderGallery();
  });
  return el;
}

async function newProject() {
  const name = await modal("New project", "Project name", "Untitled paper");
  if (!name) return;
  const p = await api("POST", "/api/projects", {
    name, kind: "tex", main_path: "main.tex", files: { "main.tex": STARTER_TEX },
  });
  openProject(p.id);
}

async function importMarkdown() {
  const got = await markdownDialog();
  if (!got) return;
  try {
    const p = await api("POST", "/api/projects/import/markdown", got);
    openProject(p.id);
  } catch (e) { alert("Import failed: " + e.message); }
}

async function uploadArchive(file) {
  const grid = $("#project-grid");
  grid.innerHTML = `<div class="muted">Importing <b>${esc(file.name)}</b>…</div>`;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/projects/import/archive", { method: "POST", body: fd, headers: authHeaders() });
    if (r.status === 401) handleUnauthorized();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || `upload failed (${r.status})`);
    openProject(j.id);
  } catch (e) {
    await showProjects();
    alert("Upload failed: " + e.message);
  }
}

async function importArxiv() {
  const id = await modal("Import from arXiv", "arXiv id, e.g. 2406.10817", "");
  if (!id) return;
  const grid = $("#project-grid");
  grid.innerHTML = `<div class="muted">Fetching arXiv:${esc(id)} source…</div>`;
  try {
    const p = await api("POST", "/api/projects/import/arxiv", { arxiv_id: id });
    openProject(p.id);
  } catch (e) {
    await showProjects();
    alert("arXiv import failed: " + e.message);
  }
}

// ── Workspace ───────────────────────────────────────────
async function openProject(id) {
  const p = await api("GET", `/api/projects/${id}`);
  state.project = p;
  state.files = p.files.slice();
  state.collapsed = new Set();
  state.contents = {};
  for (const f of p.files) if (!f.is_binary) state.contents[f.path] = f.content || "";
  applySettings(p.settings);
  resetPreviewState();
  state.rootFile = p.main_path;
  state.cIndex = null;
  edAcClose(); state.snippet = null;
  state.lastReport = null;
  setCrumb(p.name);
  setScreen("workspace");
  clearResult();
  state.conversation = null;
  loadConversation();
  state.previewVisible = false;
  $("#preview-doc").innerHTML = "";
  $("#preview-stale").hidden = true;
  $("#preview-status").textContent = "";
  $("#btn-toggle-preview").textContent = "Show preview";
  applySplit();
  setReportTab("report");
  renderStructure();
  renderFiles();
  openFile(p.files.some((f) => f.path === p.main_path) ? p.main_path : (p.files[0] && p.files[0].path));
}

const TEX_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex:none"><polyline points="16 18 22 12 16 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="8 6 2 12 8 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const IMG_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex:none;color:var(--accent-service)"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" stroke-width="2"/><polyline points="21 15 16 10 5 21" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex:none;color:var(--text-3)"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const PLUS_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const REN_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DEL_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

function fileMeta(path) { return (state.files || []).find((f) => f.path === path); }
function isBinary(path) { const m = fileMeta(path); return !!(m && m.is_binary); }

// Build a nested {dirs: Map, files: [meta]} tree from the flat file paths.
function buildFileTree(files) {
  const root = { dirs: new Map(), files: [], path: "", name: "" };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts[i];
      if (!node.dirs.has(d)) {
        node.dirs.set(d, { dirs: new Map(), files: [], path: parts.slice(0, i + 1).join("/"), name: d });
      }
      node = node.dirs.get(d);
    }
    node.files.push(f);
  }
  return root;
}

function countTreeFiles(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countTreeFiles(d);
  return n;
}

function renderFiles() {
  refreshCompletionIndex(false);  // the file set may have changed
  const list = $("#file-list");
  list.innerHTML = "";
  renderTree(list, buildFileTree(state.files || []), 0);
  refreshOptionPickers();
}

function renderTree(container, node, depth) {
  const pad = 8 + depth * 14;
  for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const collapsed = state.collapsed.has(d.path);
    const row = document.createElement("div");
    row.className = "folder-row";
    row.style.paddingLeft = pad + "px";
    row.innerHTML =
      `<svg class="chev${collapsed ? "" : " open"}" width="12" height="12" viewBox="0 0 24 24" fill="none"><polyline points="9 6 15 12 9 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
      FOLDER_ICON +
      `<span class="fname">${esc(d.name)}</span><span class="fcount">${countTreeFiles(d)}</span>` +
      `<button class="ficon fadd" title="New file in this folder">${PLUS_ICON}</button>`;
    row.addEventListener("click", () => toggleFolder(d.path));
    row.querySelector(".fadd").addEventListener("click", (e) => { e.stopPropagation(); addFile(d.path + "/"); });
    container.appendChild(row);
    if (!collapsed) renderTree(container, d, depth + 1);
  }
  for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    container.appendChild(fileRow(f, depth));
  }
}

function fileRow(f, depth) {
  const path = f.path;
  const row = document.createElement("div");
  row.className = "file-row" + (path === state.activeFile ? " active" : "");
  row.style.paddingLeft = (8 + depth * 14 + 18) + "px";  // align icon under folder icon
  const isMain = path === renderMain();
  row.innerHTML =
    (f.is_binary ? IMG_ICON : TEX_ICON) +
    `<span class="fname">${esc(path.split("/").pop())}</span>` +
    (isMain ? '<span class="main-dot" title="rendered as the main file"></span>' : "") +
    `<button class="ficon fren" title="Rename">${REN_ICON}</button>` +
    `<button class="ficon fdel" title="Delete file">${DEL_ICON}</button>`;
  row.addEventListener("click", () => openFile(path));
  row.querySelector(".fren").addEventListener("click", (e) => { e.stopPropagation(); renameFile(path); });
  row.querySelector(".fdel").addEventListener("click", (e) => { e.stopPropagation(); deleteFile(path); });
  return row;
}

function toggleFolder(p) {
  if (state.collapsed.has(p)) state.collapsed.delete(p); else state.collapsed.add(p);
  renderFiles();
}

async function renameFile(path) {
  if (isBinary(path)) { alert("Rename isn't supported for binary files yet."); return; }
  const np = (await modal("Rename file", "New path", path) || "").trim();
  if (!np || np === path) return;
  if (fileMeta(np)) { alert("A file with that path already exists."); return; }
  const content = state.contents[path] ?? "";
  try {
    await api("PUT", `/api/projects/${state.project.id}/files/${np}`, { content });
    await api("DELETE", `/api/projects/${state.project.id}/files/${path}`);
  } catch (e) { alert("Rename failed: " + e.message); return; }
  state.contents[np] = content; delete state.contents[path];
  const m = fileMeta(path); if (m) m.path = np;
  if (state.project.main_path === path) {
    try { await api("PATCH", `/api/projects/${state.project.id}`, { main_path: np }); } catch {}
    state.project.main_path = np;
  }
  if (state.activeFile === path) state.activeFile = np;
  if (state.rootFile === path) state.rootFile = np;
  markPreviewStale();
  renderFiles();
  if (state.activeFile === np) { $("#editor-tab").textContent = np; }
}

async function openFile(path, opts) {
  if (!path) {
    state.activeFile = null; $("#editor-tab").textContent = "—";
    $("#source").value = ""; updateHighlight(); return;
  }
  if (state.dirty && state.activeFile && state.activeFile !== path) await saveActive(false);
  edAcClose(); state.snippet = null;
  state.activeFile = path;
  $("#editor-tab").textContent = path;
  $("#btn-import-tex").hidden = langFor(path) !== "md";  // Markdown → "Import to TeX"
  setDirty(false);
  if (isBinary(path)) {
    showAsset(path);
  } else {
    $("#asset-view").hidden = true;
    $("#code-wrap").hidden = false;
    $("#btn-save").style.display = "";
    $("#source").value = state.contents[path] ?? "";
    updateHighlight();
    $("#source").scrollTop = 0; syncHighlightScroll();
  }
  // a standalone .tex becomes the render root; fragments keep the current one
  const prevRoot = state.rootFile;
  if (/\.tex$/i.test(path) && !isBinary(path) && isRootSource(state.contents[path])) state.rootFile = path;
  renderFiles();
  if (opts && opts.line) _scrollEditorToLine(opts.line - 1, true);
  if (state.previewVisible && state.rootFile !== prevRoot) requestPreview("full");
}

function showAsset(path) {
  $("#code-wrap").hidden = true;
  $("#btn-save").style.display = "none";
  const view = $("#asset-view");
  view.hidden = false;
  const url = withToken(`/api/projects/${state.project.id}/files/${path.split("/").map(encodeURIComponent).join("/")}/raw`);
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) {
    view.innerHTML = `<img src="${esc(url)}" alt="${esc(path)}">`;
  } else {
    view.innerHTML = `<div class="muted"><b>${esc(path)}</b><br>binary file (${fmtSize(fileMeta(path))}) — not previewable here.<br><a href="${esc(url)}" target="_blank" rel="noopener">Open / download</a></div>`;
  }
}

function fmtSize(meta) {
  const n = (meta && meta.size) || 0;
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

async function saveActive(showFeedback) {
  if (!state.activeFile || isBinary(state.activeFile)) return;
  const path = state.activeFile;
  await api("PUT", `/api/projects/${state.project.id}/files/${path}`, { content: state.contents[path] });
  setDirty(false);
  if (showFeedback) flash($("#btn-save"), "Saved");
}

// A .tex path for a .md file, deduped against existing files (-1, -2, …).
function uniqueTexName(mdPath) {
  const slash = mdPath.lastIndexOf("/");
  const dir = slash >= 0 ? mdPath.slice(0, slash + 1) : "";
  const base = mdPath.slice(dir.length).replace(/\.(md|markdown)$/i, "");
  let cand = `${dir}${base}.tex`, i = 1;
  while (fileMeta(cand)) cand = `${dir}${base}-${i++}.tex`;
  return cand;
}

// Convert the active Markdown file to a new .tex file in the project.
async function importMarkdownFile() {
  const md = state.activeFile;
  if (!md || langFor(md) !== "md") return;
  const target = await modal("Import to TeX", "New .tex file name", uniqueTexName(md));
  if (!target) return;
  if (fileMeta(target)) { alert("A file with that path already exists."); return; }
  const markdown = state.contents[md] ?? "";
  const title = md.slice(md.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
  let latex;
  try {
    ({ latex } = await api("POST", "/api/markdown/to-tex", { markdown, title }));
  } catch (e) { alert("Conversion failed: " + e.message); return; }
  try {
    await api("PUT", `/api/projects/${state.project.id}/files/${target}`, { content: latex });
  } catch (e) { alert("Could not create the file: " + e.message); return; }
  state.contents[target] = latex;
  state.files.push({ path: target, is_binary: false, size: latex.length });
  renderFiles();
  openFile(target);
}

async function addFile(prefill) {
  const path = await modal("Add file", "File path (e.g. sections/method.tex)",
                           typeof prefill === "string" ? prefill : "");
  if (!path) return;
  if (fileMeta(path)) return openFile(path);
  await api("PUT", `/api/projects/${state.project.id}/files/${path}`, { content: "" });
  state.contents[path] = "";
  state.files.push({ path, is_binary: false, size: 0 });
  renderFiles();
  openFile(path);
}

async function uploadAsset(file) {
  const dflt = `figures/${file.name}`;
  const path = await modal("Upload image", "Target path in the project", dflt);
  if (!path) return;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const meta = await api2("POST",
      `/api/projects/${state.project.id}/assets/${path.split("/").map(encodeURIComponent).join("/")}`, fd);
    state.files = state.files.filter((f) => f.path !== path);
    state.files.push(meta);
    delete state.contents[path];
    markPreviewStale();
    renderFiles();
    openFile(path);
  } catch (e) { alert("Upload failed: " + e.message); }
}

// like api() but for multipart FormData bodies
async function api2(method, path, formData) {
  const r = await fetch(path, { method, body: formData, headers: authHeaders() });
  if (r.status === 401) handleUnauthorized();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `${method} ${path} failed (${r.status})`);
  return j;
}

async function deleteFile(path) {
  if (path === state.project.main_path) { alert("Can't delete the main file."); return; }
  if (!confirm(`Delete file "${path}"?`)) return;
  await api("DELETE", `/api/projects/${state.project.id}/files/${path}`);
  delete state.contents[path];
  state.files = state.files.filter((f) => f.path !== path);
  if (state.activeFile === path) state.activeFile = null;
  if (state.rootFile === path) state.rootFile = state.project.main_path;
  markPreviewStale();
  renderFiles();
  openFile(state.files.map((f) => f.path).sort()[0]);
}

function readOptions() {
  return {
    number_by_section: $("#opt-section").checked,
    columns: parseInt($("#opt-columns").value, 10) || 1,
    language: $("#opt-lang").value.trim() || null,
    frontend: "pure",
    citation_mode: $("#opt-citation").value,
    csl: $("#opt-csl").value || null,
    math_image_fallback: $("#opt-mathimg").checked,
    reference_doc: $("#opt-refdoc").value || null,
  };
}

function applySettings(s) {
  s = s || {};
  $("#opt-section").checked = !!s.number_by_section;
  $("#opt-columns").value = s.columns || 1;
  $("#opt-lang").value = s.language || "";
  $("#opt-citation").value = s.citation_mode || "static";
  $("#opt-mathimg").checked = !!s.math_image_fallback;
  // .csl / reference_doc set after the pickers are populated
  state.pendingCsl = s.csl || "";
  state.pendingRefdoc = s.reference_doc || "";
}

// populate the .csl and template (.docx) pickers from the project's files
function refreshOptionPickers() {
  const fill = (sel, wrap, re, pending) => {
    const opts = (state.files || []).map((f) => f.path).filter((p) => re.test(p)).sort();
    const cur = pending !== undefined ? pending : sel.value;
    sel.innerHTML = '<option value="">none</option>' +
      opts.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    if (opts.includes(cur)) sel.value = cur;
    wrap.hidden = opts.length === 0;
  };
  fill($("#opt-csl"), $("#opt-csl-wrap"), /\.csl$/i, state.pendingCsl);
  fill($("#opt-refdoc"), $("#opt-refdoc-wrap"), /\.docx$/i, state.pendingRefdoc);
  state.pendingCsl = undefined; state.pendingRefdoc = undefined;
}

async function saveSettings() {
  if (!state.project) return;
  try {
    await api("PUT", `/api/projects/${state.project.id}/settings`, { settings: readOptions() });
    flash($("#btn-save-settings"), "Saved");
  } catch (e) { alert("Save failed: " + e.message); }
}

// The render/convert root is sticky: opening a file that can stand on its own
// (\documentclass / \begin{document}) makes it the root; opening a fragment
// pulled in by \input keeps the current root, so the whole document stays in
// the preview while you edit a chapter.
function isRootSource(text) {
  const code = (text || "").replace(/(^|[^\\])%[^\n]*/g, "$1");
  return /\\documentclass|\\begin\{document\}/.test(code);
}

function effectiveMain() {
  return state.rootFile || null;
}

function renderMain() {
  return state.rootFile || (state.project && state.project.main_path);
}

// Poll an async conversion job until it finishes (or we give up).
async function pollJob(jobId) {
  for (let i = 0; i < 600; i++) {            // ~5 min ceiling at 500ms
    const job = await api("GET", `/api/jobs/${jobId}`);
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("conversion timed out");
}

async function convertProject() {
  const btn = $("#btn-convert");
  clearError();
  if (state.dirty) await saveActive(false);
  btn.disabled = true;
  const label = btn.innerHTML;
  btn.innerHTML = `<span class="spin"></span> Converting…`;
  try {
    const { job_id } = await api("POST",
      `/api/projects/${state.project.id}/convert/async`,
      { options: readOptions(), main_path: effectiveMain() });
    const job = await pollJob(job_id);
    if (job.status === "error") showError(job.error || "conversion failed");
    else renderReport(job);
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

// ── Source / preview split ──────────────────────────────
function applySplit() {
  const src = $("#source-pane"), pv = $("#preview-pane"), div = $("#split-divider");
  if (state.previewVisible) {
    src.style.flex = `0 0 ${Math.round(state.splitRatio * 100)}%`;
    pv.style.flex = "1 1 0%";
    pv.hidden = false; div.hidden = false;
  } else {
    src.style.flex = "1 1 100%";
    pv.hidden = true; div.hidden = true;
  }
}

async function togglePreview(force) {
  state.previewVisible = force === undefined ? !state.previewVisible : force;
  $("#btn-toggle-preview").textContent = state.previewVisible ? "Hide preview" : "Show preview";
  applySplit();
  if (state.previewVisible) await ensurePreview();
}

function setupSplitDivider() {
  const div = $("#split-divider"), split = $("#split");
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    let r = (e.clientX - rect.left) / rect.width;
    r = Math.max(0.2, Math.min(0.85, r));
    state.splitRatio = r;
    applySplit();
  };
  const stop = () => {
    dragging = false; div.classList.remove("dragging"); split.classList.remove("dragging");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", stop);
  };
  div.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true; div.classList.add("dragging"); split.classList.add("dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  });
}

// ── Collapsible / resizable side panels ─────────────────
// Widths and collapsed flags persist per browser (localStorage, best-effort).
const PANEL_LIMITS = { files: [160, 480], report: [280, 720] };
const PANEL_DEFAULT = { files: 230, report: 380 };
const LAYOUT_KEY = "tw_layout";

function loadLayout() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null"); } catch { saved = null; }
  const narrow = window.innerWidth < 1100;
  return {
    files: { width: PANEL_DEFAULT.files, collapsed: false, ...(saved && saved.files) },
    report: { width: PANEL_DEFAULT.report, collapsed: !saved && narrow, ...(saved && saved.report) },
  };
}

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout)); } catch { /* private mode */ }
}

function clampPanel(name, w) {
  const [lo, hi] = PANEL_LIMITS[name];
  return Math.round(Math.max(lo, Math.min(hi, w)));
}

function applyLayout() {
  for (const name of ["files", "report"]) {
    const pane = $(`#pane-${name}`), cfg = state.layout[name];
    if (!pane) continue;
    pane.classList.toggle("collapsed", !!cfg.collapsed);
    pane.style.width = cfg.collapsed ? "" : clampPanel(name, cfg.width) + "px";
    const rz = document.querySelector(`[data-resize="${name}"]`);
    if (rz) rz.classList.toggle("hidden-edge", !!cfg.collapsed);
  }
}

function setPanelCollapsed(name, collapsed) {
  state.layout[name].collapsed = collapsed;
  applyLayout();
  saveLayout();
}

function togglePanel(name) { setPanelCollapsed(name, !state.layout[name].collapsed); }

function setupPanels() {
  state.layout = loadLayout();
  applyLayout();
  document.querySelectorAll("[data-collapse]").forEach((b) =>
    b.addEventListener("click", () => setPanelCollapsed(b.dataset.collapse, true)));
  document.querySelectorAll("[data-expand]").forEach((b) =>
    b.addEventListener("click", () => {
      setPanelCollapsed(b.dataset.expand, false);
      if (b.dataset.tab) setReportTab(b.dataset.tab);
    }));
  document.querySelectorAll("[data-resize]").forEach((handle) => {
    const name = handle.dataset.resize;
    handle.addEventListener("dblclick", () => togglePanel(name));
    handle.addEventListener("mousedown", (e) => {
      if (state.layout[name].collapsed) return;
      e.preventDefault();
      const pane = $(`#pane-${name}`), ws = $("#view-workspace");
      const startX = e.clientX, startW = pane.getBoundingClientRect().width;
      const sign = name === "files" ? 1 : -1;   // the right pane grows leftwards
      handle.classList.add("dragging"); ws.classList.add("resizing");
      const onMove = (ev) => {
        state.layout[name].width = clampPanel(name, startW + sign * (ev.clientX - startX));
        applyLayout();
      };
      const stop = () => {
        handle.classList.remove("dragging"); ws.classList.remove("resizing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", stop);
        saveLayout();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", stop);
    });
  });
  // Ctrl/Cmd+B → files; Ctrl/Cmd+Alt+B → right panel (VS Code's side-bar keys).
  document.addEventListener("keydown", (e) => {
    if ($("#view-workspace").hidden || !$("#tg-modal").hidden) return;  // the table generator owns Ctrl+B (bold)
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.code !== "KeyB") return;
    e.preventDefault();
    togglePanel(e.altKey ? "report" : "files");
  });
}

function markPreviewStale() {
  state.previewStale = true;
  clearTimeout(state.reconcileTimer);
  if (!state.previewVisible) return;
  $("#preview-stale").hidden = false;
  clearTimeout(state.previewTimer);
  const quick = state.previewMode === "quick" && state.preview;
  state.previewTimer = setTimeout(() => requestPreview(quick ? "quick" : "full"),
                                  quick ? QUICK_DELAY : FULL_DELAY);
}

function setReportTab(tab) {
  state.rtab = tab;
  document.querySelectorAll("[data-rtab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.rtab === tab));
  $("#tab-report").hidden = tab !== "report";
  $("#tab-structure").hidden = tab !== "structure";
  $("#tab-assistant").hidden = tab !== "assistant";
  document.querySelectorAll(".rail-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
}

// ── Assistant ───────────────────────────────────────────
// Slash commands ("skills") come from the server; these are the offline default.
const DEFAULT_SKILLS = [
  { cmd: "fix", desc: "Fix conversion warnings in this file" },
  { cmd: "polish", desc: "Improve the writing quality" },
  { cmd: "explain", desc: "Explain what this LaTeX does" },
];

async function loadSkills() {
  try {
    const list = await api("GET", "/api/skills");
    state.skills = list.map((s) => ({ cmd: s.name, desc: s.description || s.title }));
  } catch { state.skills = DEFAULT_SKILLS.slice(); }
}

// Parse a leading slash command; returns {action, rest}. Plain text → "ask".
function parseCommand(text) {
  const m = text.match(/^\/([\w-]+)\s*([\s\S]*)$/);
  if (m && (state.skills || []).some((c) => c.cmd === m[1])) {
    return { action: m[1], rest: m[2].trim() };
  }
  return { action: "ask", rest: text };
}

// Send the prompt: dispatch a leading slash command, else "ask".
function submitAsk() {
  acClose();
  const v = $("#ask-input").value.trim();
  if (!v) return;
  const { action, rest } = parseCommand(v);
  runAssistant(action, action === "ask" ? v : (rest || null));
}

// ── Autocomplete (@file and /command) ───────────────────
// Inspect the text before the cursor and return the active token, or null.
function currentToken(input) {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const slash = before.match(/^\/(\w*)$/);          // /command, only at the start
  if (slash) return { kind: "/", query: slash[1], start: 0, end: pos };
  const at = before.match(/(?:^|\s)@([^\s@]*)$/);    // @mention anywhere
  if (at) return { kind: "@", query: at[1], start: pos - at[1].length - 1, end: pos };
  return null;
}

function acCandidates(tok) {
  const q = tok.query.toLowerCase();
  if (tok.kind === "/") {
    return (state.skills || [])
      .filter((c) => c.cmd.startsWith(q))
      .map((c) => ({ label: "/" + c.cmd, insert: "/" + c.cmd + " ", hint: c.desc }));
  }
  return (state.files || [])
    .filter((f) => !f.is_binary && f.path.toLowerCase().includes(q))
    .slice(0, 8)
    .map((f) => ({ label: f.path, insert: "@" + f.path + " ", hint: "file" }));
}

function acUpdate() {
  const input = $("#ask-input");
  const tok = currentToken(input);
  if (!tok) return acClose();
  const items = acCandidates(tok);
  if (!items.length) return acClose();
  state.ac = { kind: tok.kind, items, index: 0, start: tok.start, end: tok.end };
  acRender();
}

function acRender() {
  const menu = $("#ac-menu");
  const ac = state.ac;
  if (!ac) { menu.hidden = true; return; }
  menu.innerHTML = ac.items.map((it, i) =>
    `<div class="ac-item${i === ac.index ? " active" : ""}" data-i="${i}">` +
    `<span class="ac-label">${esc(it.label)}</span><span class="ac-hint">${esc(it.hint)}</span></div>`
  ).join("");
  menu.querySelectorAll(".ac-item").forEach((el) => {
    el.addEventListener("mousedown", (e) => { e.preventDefault(); acAccept(+el.dataset.i); });
  });
  menu.hidden = false;
}

function acAccept(i) {
  const ac = state.ac;
  if (!ac) return;
  const it = ac.items[i];
  const input = $("#ask-input");
  const v = input.value;
  input.value = v.slice(0, ac.start) + it.insert + v.slice(ac.end);
  const caret = ac.start + it.insert.length;
  input.setSelectionRange(caret, caret);
  acClose();
  input.focus();
}

function acClose() { state.ac = null; $("#ac-menu").hidden = true; }

function acKeydown(e) {
  const ac = state.ac;
  if (ac) {
    // autocomplete navigation takes priority while the menu is open
    if (e.key === "ArrowDown") { e.preventDefault(); ac.index = (ac.index + 1) % ac.items.length; return acRender(); }
    if (e.key === "ArrowUp") { e.preventDefault(); ac.index = (ac.index - 1 + ac.items.length) % ac.items.length; return acRender(); }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return acAccept(ac.index); }
    if (e.key === "Escape") { e.preventDefault(); return acClose(); }
  }
  // multi-line input: Enter inserts a newline; Shift+Enter (or the Ask button) sends
  if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); submitAsk(); }
}

// Grow the chat textarea with its content, up to ~20% of the window height.
function autoGrowAsk() {
  const ta = $("#ask-input");
  const cap = Math.max(80, Math.round(window.innerHeight * 0.2));
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, cap) + "px";
}

function resolveContext(instruction) {
  if (!instruction || !state.project) return [];
  const tokens = (instruction.match(/@([^\s,;]+)/g) || []).map((t) => t.slice(1));
  const out = [], seen = new Set();
  for (const tok of tokens) {
    const meta = (state.files || []).find((f) =>
      !f.is_binary && (f.path === tok || f.path.split("/").pop() === tok));
    if (!meta || seen.has(meta.path)) continue;
    seen.add(meta.path);
    out.push({ path: meta.path, content: state.contents[meta.path] || "" });
  }
  return out;
}

// Consume an SSE stream of {delta}/{done}/{error} events from `url`.
async function streamAssistant(url, payload, onDelta, onDone, onError) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
    });
  } catch (e) { onError(e.message); return; }
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    onError(j.detail || `assistant failed (${res.status})`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (msg.error) { onError(msg.error); return; }
      else if (msg.done) { onDone(msg); return; }
      else if (msg.delta) onDelta(msg.delta);
    }
  }
}

// Quick action buttons (Fix/Polish/Explain) and the ask box both post a chat turn.
function runAssistant(action, instruction) {
  if (action === "ask") return sendChat(instruction || "", null);
  return sendChat("", action);  // a skill button: no free-text, just the skill
}

// Load the project's most recent conversation (no create) on open.
async function loadConversation() {
  state.conversation = null;
  if (!state.project) return;
  try {
    const list = await api("GET", `/api/projects/${state.project.id}/conversations`);
    if (list.length) state.conversation = await api("GET", `/api/conversations/${list[0].id}`);
  } catch { /* leave null */ }
  renderTranscript();
}

// Ensure a conversation exists; create one lazily on the first turn.
async function ensureConversation() {
  if (state.conversation) return state.conversation;
  try {
    state.conversation = await api("POST",
      `/api/projects/${state.project.id}/conversations`, { title: "Chat" });
  } catch { return null; }
  return state.conversation;
}

async function openMemory() {
  if (!state.project) return;
  try {
    const r = await api("GET", `/api/projects/${state.project.id}/memory`);
    $("#memory-text").value = r.memory || "";
  } catch { $("#memory-text").value = ""; }
  $("#memory-modal").hidden = false;
  $("#memory-text").focus();
}

async function saveMemory() {
  if (!state.project) return;
  try {
    await api("PUT", `/api/projects/${state.project.id}/memory`,
      { memory: $("#memory-text").value });
    $("#memory-modal").hidden = true;
  } catch (e) { alert("Could not save memory: " + e.message); }
}

async function newConversation() {
  if (!state.project) return;
  try {
    state.conversation = await api("POST",
      `/api/projects/${state.project.id}/conversations`, { title: "Chat" });
  } catch { return; }
  renderTranscript();
}

function renderTranscript() {
  const slot = $("#assistant-slot");
  const conv = state.conversation;
  if (!conv || !conv.messages || !conv.messages.length) {
    slot.innerHTML = `<div class="placeholder">Start a chat — ask a question, use <b>@file</b> for context, or run <b>/fix</b> · <b>/polish</b> · <b>/explain</b>.</div>`;
    return;
  }
  slot.innerHTML = "";
  for (const m of conv.messages) slot.appendChild(messageBubble(m));
  slot.scrollTop = slot.scrollHeight;
}

function messageBubble(m) {
  const el = document.createElement("div");
  el.className = `chat-msg ${m.role}` + (m.is_code ? " code" : "");
  const tag = m.skill ? `<span class="chat-skill">/${esc(m.skill)}</span>` : "";
  const body = document.createElement("div");
  body.className = "chat-body";
  body.textContent = m.content;
  el.innerHTML = `<div class="chat-role">${m.role === "user" ? "you" : "tex-copilot"} ${tag}</div>`;
  el.appendChild(body);
  if (m.role === "assistant" && m.is_code && m.content) {
    const btn = document.createElement("button");
    btn.className = "btn-accent assistant-apply";
    btn.textContent = "Review & apply";
    btn.addEventListener("click", () => applyToFile(m.content));
    el.appendChild(btn);
  }
  return el;
}

async function sendChat(content, skill) {
  if (!state.project) return;
  const text = (content || "").trim();
  if (!text && !skill) return;
  const conv = await ensureConversation();
  if (!conv) { $("#assistant-slot").innerHTML = `<div class="banner error">could not start a conversation</div>`; return; }

  const context = resolveContext(text);
  const source = state.activeFile ? (state.contents[state.activeFile] || "") : "";
  // optimistic user bubble + a pending assistant bubble
  conv.messages.push({ role: "user", content: text || `/${skill}`, skill });
  const pending = { role: "assistant", content: "", is_code: false };
  conv.messages.push(pending);
  renderTranscript();
  $("#ask-input").value = "";
  autoGrowAsk();
  const slot = $("#assistant-slot");
  const out = slot.lastElementChild.querySelector(".chat-body");

  await streamAssistant(
    `/api/conversations/${conv.id}/message/stream`,
    { content: text, source, skill: skill || null,
      provider: state.provider ? state.provider.name : null, context },
    (delta) => { pending.content += delta; out.textContent = pending.content; slot.scrollTop = slot.scrollHeight; },
    (meta) => { pending.is_code = !!meta.is_code; renderTranscript(); },
    (err) => { out.classList.add("error-bubble"); out.textContent = err || "assistant error"; },
  );
}

// Line-level diff (LCS) → array of {type: "ctx"|"add"|"del", text}.
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: "ctx", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: A[i] }); i++; }
    else { out.push({ type: "add", text: B[j] }); j++; }
  }
  while (i < n) out.push({ type: "del", text: A[i++] });
  while (j < m) out.push({ type: "add", text: B[j++] });
  return out;
}

// Show a diff of the current file vs the assistant's proposal; apply on accept.
function applyToFile(text) {
  if (!state.activeFile) return;
  const current = state.contents[state.activeFile] || "";
  if (current === text) { writeToFile(text); return; }
  const rows = lineDiff(current, text).map((d) => {
    const sym = d.type === "add" ? "+" : d.type === "del" ? "−" : " ";
    return `<div class="dl ${d.type}"><span class="dg">${sym}</span>${esc(d.text) || "&nbsp;"}</div>`;
  }).join("");
  const slot = $("#assistant-slot");
  const box = document.createElement("div");
  box.className = "diff-box";
  box.innerHTML =
    `<div class="diff-head">Proposed changes to <code>${esc(state.activeFile)}</code></div>` +
    `<div class="diff-body">${rows}</div>` +
    `<div class="diff-actions"></div>`;
  const acts = box.querySelector(".diff-actions");
  const accept = document.createElement("button");
  accept.className = "btn-accent"; accept.textContent = "Accept";
  accept.addEventListener("click", () => { writeToFile(text); box.remove(); });
  const reject = document.createElement("button");
  reject.className = "btn-secondary"; reject.textContent = "Reject";
  reject.addEventListener("click", () => box.remove());
  acts.append(accept, reject);
  slot.appendChild(box);
  box.scrollIntoView({ block: "nearest" });
}

function writeToFile(text) {
  if (!state.activeFile) return;
  state.contents[state.activeFile] = text;
  $("#source").value = text;
  updateHighlight();
  setDirty(true);
  markPreviewStale();
}

// ── Live preview: full / quick renders + segment patching ──
// Full: the server re-parses the whole project. Quick: it re-parses only the
// chunks you edited (or says why it fell back to full). Either way the reply
// carries keyed segments; we swap only the blocks whose key changed, so the
// preview keeps its scroll position and untouched math is never re-laid-out.
// After a burst of quick updates, a background full render reconciles.
const PREVIEW_MODE_KEY = "tw_preview_mode";
const QUICK_DELAY = 300, FULL_DELAY = 900, RECONCILE_DELAY = 4000;
const PRIORITY = { quick: 1, reconcile: 2, full: 3 };

function loadPreviewMode() {
  try { return localStorage.getItem(PREVIEW_MODE_KEY) === "full" ? "full" : "quick"; } catch { return "quick"; }
}

function setPreviewMode(mode) {
  state.previewMode = mode;
  try { localStorage.setItem(PREVIEW_MODE_KEY, mode); } catch { /* private mode */ }
  document.querySelectorAll("[data-pmode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.pmode === mode));
}

function resetPreviewState() {
  state.preview = null; state.previewRev = null; state.previewStale = false;
  state.anchors = null;
  clearTimeout(state.previewTimer); clearTimeout(state.reconcileTimer);
}

// kind: "full" (replace everything) | "reconcile" (full parse, patch) | "quick"
async function requestPreview(kind) {
  if (!state.project || !state.previewVisible) return;
  if (state.previewInflight) {
    if (!state.previewQueued || PRIORITY[kind] > PRIORITY[state.previewQueued]) state.previewQueued = kind;
    return;
  }
  clearTimeout(state.previewTimer);
  if (kind !== "reconcile") clearTimeout(state.reconcileTimer);
  const pid = state.project.id;
  const patch = kind !== "full" && state.preview && state.previewRev != null;
  const body = {
    options: readOptions(), main_path: effectiveMain(),
    mode: kind === "quick" ? "quick" : "full",
    base_rev: patch ? state.previewRev : null,
  };
  state.previewInflight = true;
  const doc = $("#preview-doc");
  if (!state.preview) doc.innerHTML = `<div class="placeholder">Rendering preview…</div>`;
  $("#preview-status").textContent = kind === "quick" ? "updating…" : "rendering…";
  try {
    if (state.dirty) await saveActive(false);
    const data = await api("POST", `/api/projects/${pid}/preview`, body);
    if (!state.project || state.project.id !== pid) return;  // switched project meanwhile
    if (!applyPreview(data, patch)) {
      state.previewQueued = "full";  // lost sync with the server: start over
    } else if (data.mode === "quick" && !state.previewQueued) {
      state.reconcileTimer = setTimeout(() => requestPreview("reconcile"), RECONCILE_DELAY);
    }
  } catch (e) {
    state.preview = null; state.previewRev = null;
    doc.innerHTML = `<div class="banner error" style="margin:14px">${esc(e.message)}</div>`;
    $("#preview-status").textContent = "";
  } finally {
    state.previewInflight = false;
    const next = state.previewQueued;
    state.previewQueued = null;
    if (next) requestPreview(next);
  }
}

function withTokenHtml(html) {
  // server-embedded figure URLs (/…/raw) need the session token under auth
  if (state.authEnabled && state.token) {
    return html.replace(/\/raw"/g, `/raw?access_token=${encodeURIComponent(state.token)}"`);
  }
  return html;
}

function htmlToElement(html) {
  const t = document.createElement("template");
  t.innerHTML = withTokenHtml(html);
  return t.content.firstElementChild;
}

// Apply a preview payload; returns false if a patch could not be applied.
function applyPreview(data, patch) {
  const pv = $("#preview-doc");
  const segs = data.segments || [];
  let changed = segs.length;
  if (patch) {
    const kids = [...pv.children];
    const plan = TexSync.planPatch(kids.map((el) => el.dataset.k || ""), segs);
    if (!plan) return false;
    plan.remove.forEach((i) => kids[i].remove());
    changed = 0;
    segs.forEach(([, html], i) => {
      let el = plan.take[i] >= 0 ? kids[plan.take[i]] : htmlToElement(html);
      if (plan.take[i] < 0) changed++;
      if (pv.children[i] !== el) pv.insertBefore(el, pv.children[i] || null);
    });
  } else {
    const top = pv.scrollTop;
    pv.innerHTML = withTokenHtml(segs.map(([, h]) => h).join("")) ||
      `<div class="placeholder">Empty document.</div>`;
    pv.scrollTop = top;
  }
  // Large docs: let the browser skip laying out off-screen blocks
  // (content-visibility) so hundreds of MathML nodes don't all render at once.
  pv.classList.toggle("virtualized", pv.children.length > 60);
  state.preview = data;
  state.previewRev = data.rev;
  state.previewStale = false;
  state.anchors = null;
  if (data.main_path) state.rootFile = data.main_path;
  $("#preview-stale").hidden = true;
  renderPreviewStatus(data, changed);
  renderStructure();
  renderFiles();
  return true;
}

function renderPreviewStatus(data, changed) {
  const st = $("#preview-status");
  const t = data.timings ? `${Math.round(data.timings.total_ms)} ms` : "";
  const blocks = (data.segments || []).length;
  const parts = [data.mode || "full", t];
  if (data.mode === "quick") parts.push(`${changed}/${blocks}`);
  st.textContent = parts.filter(Boolean).join(" · ");
  const detail = data.chunks ? `${data.chunks.reparsed} of ${data.chunks.total} chunks re-parsed, ` +
    `${changed} of ${blocks} blocks updated` : "";
  st.title = data.reason ? `Ran a full render: ${data.reason}.` : detail;
  st.classList.toggle("fell-back", !!data.reason);
}

async function ensurePreview(force) {
  if (state.preview && !force && !state.previewStale) return;
  await requestPreview("full");
}

function renderStructure() {
  const slot = $("#structure-slot");
  if (!state.preview) {
    slot.innerHTML = `<div class="placeholder">Open the <b>Preview</b> tab to build the document outline.</div>`;
    return;
  }
  const s = state.preview.statistics;
  const outline = state.preview.outline || [];
  const items = outline.map((o) => {
    const lvl = o.type === "heading" ? Math.min(3, o.level || 1) : 2;
    const badge = o.type === "heading" ? "" : `<span class="outline-badge">${esc(o.type)}</span>`;
    const label = o.type === "heading" ? esc(o.text) : esc(o.text);
    return `<div class="outline-item lvl-${lvl} kind-${esc(o.type)}" data-anchor="${esc(o.anchor)}">
      <span class="num">${esc(o.number || "")}</span>
      <span class="lbl">${label}</span>${badge}
    </div>`;
  }).join("") || `<div class="muted">No structure detected.</div>`;

  slot.innerHTML = `
    <div class="card">
      <h3>Statistics</h3>
      <div class="stat-row" style="margin-bottom:8px">
        <div class="stat"><b>${s.words}</b><span>words</span></div>
        <div class="stat"><b>${s.headings}</b><span>sections</span></div>
      </div>
      <div class="stat-row">
        <div class="stat"><b>${s.equations}</b><span>equations</span></div>
        <div class="stat"><b>${s.figures}</b><span>figures</span></div>
        <div class="stat"><b>${s.tables}</b><span>tables</span></div>
      </div>
    </div>
    <div class="card">
      <h3>Outline</h3>
      <div class="outline-list">${items}</div>
    </div>`;

  slot.querySelectorAll(".outline-item").forEach((el) =>
    el.addEventListener("click", () => jumpTo(el.dataset.anchor)));
}

async function jumpTo(anchor) {
  if (!state.previewVisible) await togglePreview(true);
  const target = $("#preview-doc").querySelector(`#${CSS.escape(anchor)}`);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── Report rendering ────────────────────────────────────
function clearResult() { $("#result-slot").innerHTML = `<div class="placeholder">Convert the project to see the report and download the&nbsp;.docx.</div>`; clearError(); }
function clearError() { $("#error-slot").innerHTML = ""; }
function showError(m) { $("#error-slot").innerHTML = `<div class="banner error">${esc(m)}</div>`; }

function renderReport(res) {
  const rep = res.report;
  state.lastReport = rep;  // context for the assistant's "Fix" action
  const cov = Math.round((rep.coverage || 0) * 100);
  const entries = rep.entries || [];
  const entriesHtml = entries.length
    ? entries.map((e) => `<div class="entry"><span class="tag ${esc(e.severity)}">${esc(e.severity)}</span><span class="msg"><b>${esc(e.construct)}</b> — ${codeify(e.message)}</span></div>`).join("")
    : `<div class="muted">No warnings or errors. Clean conversion.</div>`;
  $("#result-slot").innerHTML = `
    <div class="card">
      <h3>Download</h3>
      <a href="${esc(withToken(res.download_url))}" download="${esc(res.filename)}">
        <button class="btn-accent" style="width:100%">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          ${esc(res.filename)}
        </button>
      </a>
    </div>
    <div class="card">
      <h3>Math coverage</h3>
      <div class="coverage-num">${cov}%</div>
      <div class="coverage-bar"><i style="width:${cov}%"></i></div>
      <div class="muted" style="margin-top:8px">${esc(rep.summary || "")}</div>
    </div>
    <div class="card">
      <h3>Math constructs</h3>
      <div class="stat-grid">
        <div class="stat"><b>${rep.math.omml}</b><span>OMML</span></div>
        <div class="stat"><b>${rep.math.image}</b><span>image</span></div>
        <div class="stat"><b>${rep.math.raw}</b><span>raw</span></div>
      </div>
    </div>
    <div class="card">
      <h3>Diagnostics · ${rep.counts.warnings} warn · ${rep.counts.errors} err</h3>
      ${entriesHtml}
    </div>`;
}

// ── UI helpers ──────────────────────────────────────────
function setDirty(v) { state.dirty = v; $("#dirty-dot").hidden = !v; }
function setCrumb(name) {
  const c = $("#crumb");
  c.innerHTML = `<span class="crumb-link" id="crumb-home">Documents</span>`;
  c.querySelector("#crumb-home").addEventListener("click", showProjects);
  if (name) {
    c.insertAdjacentHTML("beforeend",
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polyline points="9 18 15 12 9 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><strong>${esc(name)}</strong>`);
  }
}
function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
}

// import-markdown dialog → {name, markdown} | null
function markdownDialog() {
  return new Promise((resolve) => {
    const m = $("#import-modal"), nameEl = $("#import-name"), mdEl = $("#import-md");
    nameEl.value = ""; mdEl.value = "";
    m.hidden = false;
    nameEl.focus();
    const done = (val) => { m.hidden = true; cleanup(); resolve(val); };
    const onOk = () => {
      const name = nameEl.value.trim(), markdown = mdEl.value.trim();
      if (!name || !markdown) { alert("Name and Markdown are both required."); return; }
      done({ name, markdown });
    };
    const onCancel = () => done(null);
    function cleanup() {
      $("#import-ok").removeEventListener("click", onOk);
      $("#import-cancel").removeEventListener("click", onCancel);
    }
    $("#import-ok").addEventListener("click", onOk);
    $("#import-cancel").addEventListener("click", onCancel);
  });
}

// minimal promise-based prompt modal
function modal(title, placeholder, value) {
  return new Promise((resolve) => {
    const m = $("#modal"), input = $("#modal-input");
    $("#modal-title").textContent = title;
    input.placeholder = placeholder || "";
    input.value = value || "";
    m.hidden = false;
    input.focus();
    const done = (val) => { m.hidden = true; cleanup(); resolve(val); };
    const onOk = () => done(input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => { if (e.key === "Enter") onOk(); if (e.key === "Escape") onCancel(); };
    function cleanup() {
      $("#modal-ok").removeEventListener("click", onOk);
      $("#modal-cancel").removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
    }
    $("#modal-ok").addEventListener("click", onOk);
    $("#modal-cancel").addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
  });
}
