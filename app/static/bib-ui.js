// Reference manager: the left panel's References section (search + click to
// cite) and the manager dialog (table, entry editor, add by DOI / arXiv / ISBN,
// online search, paste BibTeX, cleanup, keys, duplicates, settings).
//
// The server does the BibTeX work (app/bib_api.py over app/bibtex.py) and the
// online lookups (app/bibfetch.py); every change comes back as the new file
// text, which goes into the editor like any other edit. BibUI (bib.js) holds
// the pure helpers.
"use strict";

const BIB = {
  data: null, error: "", sources: null,
  open: false, sel: null, draft: null, tab: "fields",
  filter: "all", query: "", sort: { col: "line", dir: "asc" },
  side: "entry", sideData: null,
  search: { q: "", source: "crossref", results: [], picked: new Set(), forKey: null, busy: false },
  panelQuery: "", loadedFor: null,
};
const BIB_OPEN_KEY = "tw_refs_open";
const BIB_ICON = {
  warn: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  link: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  x: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  key: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
};

// HTML-escape for text and attributes (data from .bib files and the web).
const bq = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function bibApi(method, path, body) {
  const opts = { method, headers: { ...authHeaders() } };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (r.status === 401) handleUnauthorized();
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = j.detail;
    const err = new Error(typeof d === "string" ? d : (d && d.message) || `${method} ${path} failed (${r.status})`);
    err.status = r.status; err.detail = d;
    throw err;
  }
  return j;
}

const bibProject = () => state.project && state.project.id;
const bibEntries = () => (BIB.data && BIB.data.entries) || [];
const bibEntry = (key) => bibEntries().find((e) => e.key === key) || null;
const bibPrefs = () => (BIB.data && BIB.data.prefs) || (BIB.sources && BIB.sources.prefs) || { key_pattern: "[auth][year]", cite_command: "cite" };

// The server works on saved files: save the editor first.
async function bibSyncEditor() {
  if (state.dirty && state.activeFile) { try { await saveActive(false); } catch { /* the op reports it */ } }
}

// New text for a file from the server → the editor's copy (and the editor).
function bibApplyContent(path, content) {
  if (content == null || !path) return;
  state.contents[path] = content;
  if (!fileMeta(path)) {
    state.files.push({ path, is_binary: false, size: content.length });
    renderFiles();
  }
  if (state.activeFile === path) {
    const ta = $("#source");
    const pos = Math.min(ta.selectionStart, content.length);
    ta.value = content;
    ta.setSelectionRange(pos, pos);
    updateHighlight();
    setDirty(false);
    document.dispatchEvent(new CustomEvent("tw:source"));
  }
  markPreviewStale();
}

function bibApplyChanged(changed) {
  for (const [p, c] of Object.entries(changed || {})) bibApplyContent(p, c);
}

async function bibLoad(file) {
  if (!bibProject()) { BIB.data = null; bibRenderPanel(); return; }
  const want = file || BIB.file || "";
  try {
    BIB.data = await bibApi("GET", `/api/projects/${bibProject()}/bib${want ? "?file=" + encodeURIComponent(want) : ""}`);
    BIB.error = "";
  } catch (e) { BIB.data = null; BIB.error = e.message; }
  BIB.file = BIB.data && BIB.data.file;
  BIB.loadedFor = bibProject();
  bibRenderPanel();
  if (BIB.open) bibRender();
}

async function bibSources() {
  if (!BIB.sources) {
    try { BIB.sources = await bibApi("GET", "/api/bib/sources"); } catch { BIB.sources = { online: false, sources: [], cleanups: {}, types: {}, cite_commands: ["cite"], key_tokens: [] }; }
    const first = (BIB.sources.sources || []).find((s) => s.enabled && s.search);
    const pref = ((BIB.sources.prefs || {}).search_sources || [])[0];
    BIB.search.source = pref || (first && first.id) || "crossref";
  }
  return BIB.sources;
}

// ── citing ──────────────────────────────────────────────────────────────
function bibCite(keys) {
  if (!keys.length) return false;
  if (!state.activeFile || isBinary(state.activeFile) || !/\.(tex|ltx)$/i.test(state.activeFile)) {
    bibFlash("Open a .tex file to cite into");
    return false;
  }
  const ta = $("#source");
  const [a, b] = state.edSel || [ta.selectionStart, ta.selectionEnd];
  const edit = BibUI.citeEdit(ta.value, a, b, keys, bibPrefs().cite_command);
  if (!edit) { bibFlash(`Already cited here: ${keys.join(", ")}`); return true; }
  edInsert(edit.from, edit.to, edit.insert);
  bibFlash(edit.joined ? `Added ${keys.join(", ")} to the citation` : `Cited ${keys.join(", ")}`);
  return true;
}

function bibFlash(text) {
  const el = BIB.open ? $("#bib-status") : $("#refs-file");
  if (!el) return;
  const old = el.dataset.text != null ? el.dataset.text : el.textContent;
  el.dataset.text = old;
  el.textContent = text;
  el.classList.add("flash");
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = el.dataset.text; delete el.dataset.text; el.classList.remove("flash"); if (BIB.open) bibRenderStatus(); }, 1800);
}

// ── left panel ──────────────────────────────────────────────────────────
function bibSetPanelOpen(open) {
  $("#pane-refs").classList.toggle("closed", !open);
  $("#refs-toggle").setAttribute("aria-expanded", String(open));
  $("#refs-toggle .chev").classList.toggle("open", open);
  try { localStorage.setItem(BIB_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode */ }
  if (open && BIB.loadedFor !== bibProject()) bibLoad();
}

function bibRenderPanel() {
  const list = $("#refs-list");
  if (!list) return;
  const d = BIB.data;
  const entries = bibEntries();
  $("#refs-count").textContent = d && d.file ? String(entries.length) : "";
  $("#refs-file").textContent = d && d.file && (d.files || []).length > 1 ? d.file : "";
  const missing = (d && d.missing) || [];
  const warn = $("#refs-warn");
  warn.hidden = !missing.length;
  warn.innerHTML = missing.length ? `${BIB_ICON.warn}${missing.length}` : "";
  warn.title = missing.length ? `${missing.length} cited key${missing.length === 1 ? "" : "s"} with no entry: ${missing.map((m) => m.key).join(", ")}` : "";
  if (!bibProject()) { list.innerHTML = ""; return; }
  if (!d) { list.innerHTML = `<div class="refs-empty">${bq(BIB.error || "Loading…")}</div>`; return; }
  if (!d.file) {
    list.innerHTML = `<div class="refs-empty">No .bib file in this project.<br><button class="tg-link" data-ref-create>Create refs.bib</button></div>`;
    return;
  }
  const shown = entries.filter((e) => BibUI.match(e, BIB.panelQuery));
  const rows = shown.slice(0, 300).map((e) => {
    const lvl = (e.problems || []).some((p) => p.level === "error") ? " err" : "";
    const who = [e.display.authors, e.display.year].filter(Boolean).join(" ");
    return `<div class="ref-row${e.cited ? "" : " unused"}${lvl}" data-key="${bq(e.key)}" role="option" tabindex="-1"
        title="${bq(e.display.title || e.key)}\nClick to cite · double-click to edit${e.cited ? "" : "\n(not cited yet)"}">
      <span class="ref-key">${bq(e.key)}</span><span class="ref-who">${bq(who)}</span>
      <span class="ref-title">${bq(e.display.title || "")}</span></div>`;
  }).join("");
  const miss = missing.length ? `<div class="ref-missing">${BIB_ICON.warn}<span>No entry for ${missing.slice(0, 3).map((m) => `<code>${bq(m.key)}</code>`).join(", ")}${missing.length > 3 ? ` +${missing.length - 3}` : ""}</span><button class="tg-link" data-ref-missing>Fix</button></div>` : "";
  list.innerHTML = miss + (rows || `<div class="refs-empty">${entries.length ? "No match." : "No entries yet."} <button class="tg-link" data-ref-add>Add one</button></div>`);
}

async function bibCreateFile(path) {
  path = (path || "refs.bib").trim();
  if (!/\.bib$/i.test(path)) path += ".bib";
  if (fileMeta(path)) return path;
  await api("PUT", `/api/projects/${bibProject()}/files/${path}`, { content: "" });
  bibApplyContent(path, "");
  return path;
}

// Add \bibliography{name} before \end{document} in the main file.
async function bibAddToMain(path) {
  const main = state.project.main_path;
  await bibSyncEditor();
  const src = state.contents[main];
  if (src == null) return;
  const name = path.replace(/\.bib$/i, "");
  const usesBiblatex = /\\usepackage(\[[^\]]*\])?\{biblatex\}/.test(src);
  const line = usesBiblatex ? `\\addbibresource{${path}}` : `\\bibliographystyle{plain}\n\\bibliography{${name}}`;
  let out;
  if (usesBiblatex) out = src.replace(/\\begin\{document\}/, `${line}\n\\begin{document}`);
  else if (/\\end\{document\}/.test(src)) out = src.replace(/\\end\{document\}/, `${line}\n\\end{document}`);
  else out = src + `\n${line}\n`;
  await api("PUT", `/api/projects/${bibProject()}/files/${main}`, { content: out });
  bibApplyContent(main, out);
  await bibLoad(path);
}

// ── manager dialog ──────────────────────────────────────────────────────
async function bibOpen(opts = {}) {
  if (!bibProject()) return;
  await bibSyncEditor();
  BIB.open = true;
  $("#bib-modal").hidden = false;
  await bibSources();
  await bibLoad(opts.file);
  if (opts.key && bibEntry(opts.key)) bibSelect(opts.key, true);
  else if (!BIB.sel || !bibEntry(BIB.sel)) { BIB.sel = null; BIB.draft = null; }
  BIB.side = opts.side || (BIB.draft ? "entry" : (bibEntries().length ? "entry" : "identifier"));
  if (opts.filter) BIB.filter = opts.filter;
  bibRender();
  setTimeout(() => (opts.side === "identifier" ? $("#bi-q") : $("#bib-search"))?.focus(), 30);
}

function bibClose() {
  if (BIB.draft && BIB.draft.dirty && !confirm("Discard the changes to this entry?")) return;
  BIB.open = false;
  BIB.draft = BIB.draft && !BIB.draft.dirty ? BIB.draft : null;
  $("#bib-modal").hidden = true;
  $("#source").focus();
}

function bibDraftFrom(e) {
  return { isNew: false, origKey: e.key, type: e.type, key: e.key,
    fields: Object.fromEntries((e.fields || []).map((f) => [f.name, f.value])),
    order: (e.fields || []).map((f) => f.name), dirty: false, renameCites: true };
}

function bibSelect(key, force) {
  if (!force && BIB.draft && BIB.draft.dirty && BIB.draft.origKey !== key &&
      !confirm("Discard the changes to this entry?")) return false;
  const e = bibEntry(key);
  BIB.sel = e ? key : null;
  BIB.draft = e ? bibDraftFrom(e) : null;
  BIB.side = "entry";
  return true;
}

function bibNewDraft(type, key, fields) {
  if (BIB.draft && BIB.draft.dirty && !confirm("Discard the changes to this entry?")) return;
  BIB.sel = null;
  BIB.draft = { isNew: true, origKey: null, type: type || "article", key: key || "", fields: fields || {}, order: [], dirty: !!(key || fields), renameCites: true };
  BIB.side = "entry"; BIB.tab = "fields";
  bibRender();
  setTimeout(() => $('#bib-side [data-field="author"]')?.focus(), 30);
}

function bibVisible() {
  const d = BIB.data;
  if (!d) return [];
  let list = bibEntries();
  if (BIB.filter === "cited") list = list.filter((e) => e.cited);
  if (BIB.filter === "unused") list = list.filter((e) => !e.cited);
  if (BIB.filter === "problems") list = list.filter((e) => (e.problems || []).some((p) => p.level !== "info") ||
    (d.problems || []).some((p) => p.key === e.key));
  list = list.filter((e) => BibUI.match(e, BIB.query));
  return BibUI.sort(list, BIB.sort.col, BIB.sort.dir);
}

function bibRender() {
  if (!BIB.open) return;
  bibRenderTop();
  bibRenderBanner();
  bibRenderTable();
  bibRenderSide();
  bibRenderStatus();
}

function bibRenderTop() {
  const d = BIB.data || { files: [] };
  const sel = $("#bib-file");
  sel.innerHTML = (d.files || []).map((f) => `<option value="${bq(f.path)}"${f.path === d.file ? " selected" : ""}>${bq(f.path)} (${f.entries})${f.used ? "" : " — not used"}</option>`).join("") +
    `<option value="__new">+ New .bib file…</option>`;
  if (!d.file) sel.value = "__new";
  document.querySelectorAll("#bib-filter [data-filter]").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === BIB.filter);
    if (b.dataset.filter === "missing") b.textContent = `Missing${(d.missing || []).length ? ` (${d.missing.length})` : ""}`;
    if (b.dataset.filter === "problems") {
      const n = bibEntries().filter((e) => (e.problems || []).some((p) => p.level !== "info")).length + (d.problems || []).filter((p) => !p.key).length;
      b.textContent = `Problems${n ? ` (${n})` : ""}`;
    }
  });
  const dups = (d.duplicates || []).length;
  $("#bib-dup-btn").textContent = dups ? `Duplicates (${dups})` : "Duplicates";
  if ($("#bib-search").value !== BIB.query) $("#bib-search").value = BIB.query;
}

function bibRenderBanner() {
  const box = $("#bib-banner");
  const d = BIB.data;
  const bits = [];
  if (BIB.error) bits.push(`<div class="bad">${BIB_ICON.warn}${bq(BIB.error)}</div>`);
  if (d && d.file) {
    const f = (d.files || []).find((x) => x.path === d.file);
    if (f && !f.used) bits.push(`<div>${BIB_ICON.warn}<span><b>${bq(d.file)}</b> isn't named by <code>\\bibliography</code> or <code>\\addbibresource</code>, so the document doesn't use it.</span> <button class="tg-link" data-bib="usefile">Add it to ${bq(state.project.main_path)}</button></div>`);
    for (const p of (d.problems || []).filter((x) => x.code === "parse").slice(0, 3)) {
      bits.push(`<div class="bad">${BIB_ICON.warn}<span>Line ${p.line}: ${bq(p.message)} — that block is skipped until it's fixed.</span> <button class="tg-link" data-bib-line="${p.line}">Show in editor</button></div>`);
    }
  }
  if (BIB.sources && !BIB.sources.online) bits.push(`<div>Online lookups are off (<code>[bibliography] online = false</code>).</div>`);
  box.innerHTML = bits.join("");
  box.hidden = !bits.length;
}

const BIB_COLS = [["", ""], ["key", "Key"], ["author", "Author"], ["title", "Title"], ["year", "Year"], ["venue", "Venue"], ["cited", "Cited"]];

function bibRenderTable() {
  const table = $("#bib-table"), empty = $("#bib-empty");
  const d = BIB.data;
  if (BIB.filter === "missing") {
    const miss = (d && d.missing) || [];
    table.innerHTML = `<thead><tr><th>Cited key</th><th>Where</th><th></th></tr></thead><tbody>` + miss.map((m) =>
      `<tr class="bib-miss" data-miss="${bq(m.key)}"><td><code>${bq(m.key)}</code></td>
        <td>${m.uses.map((u) => `<button class="tg-link" data-goto="${bq(u.file)}:${u.line}">${bq(u.file)}:${u.line}</button>`).join(" ")}</td>
        <td class="bib-miss-act"><button class="btn-small btn-secondary" data-miss-act="search">Search online</button>
          <button class="btn-small btn-secondary" data-miss-act="new">New entry</button></td></tr>`).join("") + "</tbody>";
    empty.hidden = !!miss.length;
    empty.textContent = "Every cited key has an entry.";
    return;
  }
  const rows = bibVisible();
  const head = BIB_COLS.map(([c, label]) => {
    if (!c) return `<th class="bib-c-st"></th>`;
    const on = BIB.sort.col === c;
    return `<th class="bib-c-${c}${on ? " sorted" : ""}" data-sort="${c}" aria-sort="${on ? (BIB.sort.dir === "asc" ? "ascending" : "descending") : "none"}">${label}${on ? (BIB.sort.dir === "asc" ? " ▲" : " ▼") : ""}</th>`;
  }).join("");
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>` + rows.map((e) => {
    const probs = e.problems || [];
    const lvl = probs.some((p) => p.level === "error") ? "error" : probs.some((p) => p.level === "warn") ? "warn" : "";
    const st = lvl ? `<span class="bib-st ${lvl}" title="${bq(probs.map((p) => p.message).join("\n"))}">${BIB_ICON.warn}</span>` : "";
    return `<tr data-key="${bq(e.key)}" class="${e.key === BIB.sel ? "selected" : ""}${e.cited ? "" : " unused"}">
      <td class="bib-c-st">${st}</td><td class="bib-c-key">${bq(e.key)}</td>
      <td class="bib-c-author">${bq(e.display.authors)}</td><td class="bib-c-title">${bq(e.display.title)}</td>
      <td class="bib-c-year">${bq(e.display.year)}</td><td class="bib-c-venue">${bq(e.display.venue)}</td>
      <td class="bib-c-cited">${e.cited || ""}</td></tr>`;
  }).join("") + "</tbody>";
  empty.hidden = !!rows.length;
  empty.innerHTML = !d ? bq(BIB.error || "Loading…") : !d.file ? `No .bib file yet. <button class="tg-link" data-bib="createfile">Create refs.bib</button>` :
    bibEntries().length ? "No entry matches." : `The file is empty. <button class="tg-link" data-bib="identifier">Add by DOI / arXiv / ISBN</button> or <button class="tg-link" data-bib="new">type one in</button>.`;
  const cur = table.querySelector("tr.selected");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function bibRenderStatus() {
  const el = $("#bib-status");
  if (!el || el.classList.contains("flash")) return;
  const d = BIB.data;
  if (!d || !d.file) { el.textContent = ""; return; }
  const n = bibEntries().length, shown = bibVisible().length;
  const cited = bibEntries().filter((e) => e.cited).length;
  el.textContent = `${n} entr${n === 1 ? "y" : "ies"}${shown !== n ? ` · ${shown} shown` : ""} · ${cited} cited · ${(d.missing || []).length} missing · key pattern ${bibPrefs().key_pattern}`;
}

// ── side panels ─────────────────────────────────────────────────────────
function bibRenderSide() {
  const side = $("#bib-side");
  const fn = { entry: bibSideEntry, identifier: bibSideIdentifier, search: bibSideSearch, paste: bibSidePaste,
    cleanup: bibSideCleanup, keys: bibSideKeys, duplicates: bibSideDuplicates, prefs: bibSidePrefs, fetch: bibSideFetch }[BIB.side] || bibSideEntry;
  side.innerHTML = fn();
  side.querySelectorAll("textarea.bf-val").forEach(bibGrow);
}

function bibGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, 220) + "px"; }

function bibSideHead(title, back = true) {
  return `<div class="bs-head">${back && (BIB.draft || BIB.sel) ? `<button class="icon-btn" data-bib="back" title="Back to the entry">‹</button>` : ""}<h4>${title}</h4></div>`;
}

function bibFieldRow(name, value, required, alt) {
  const probs = BIB.sel && !BIB.draft.dirty ? ((bibEntry(BIB.sel) || {}).problems || []).filter((p) => p.field === name) : [];
  const label = alt ? alt.join(" / ") : name;
  return `<div class="bf-row${required ? " req" : ""}${probs.length ? " has-prob" : ""}">
    <label for="bf-${bq(name)}">${bq(label)}${required ? "<span aria-hidden=\"true\">*</span>" : ""}</label>
    <textarea class="bf-val" id="bf-${bq(name)}" data-field="${bq(name)}" rows="1" spellcheck="${name === "title" || name === "abstract" || name === "note" ? "true" : "false"}">${bq(value || "")}</textarea>
    ${required ? "" : `<button class="as-act bf-x" data-bf-remove="${bq(name)}" title="Remove ${bq(name)}">${BIB_ICON.x}</button>`}
    ${probs.map((p) => `<div class="bf-prob ${p.level}">${bq(p.message)}${p.fix ? ` <button class="tg-link" data-bib-fix="${bq(p.fix)}">Fix</button>` : ""}</div>`).join("")}
  </div>`;
}

function bibSideEntry() {
  const dr = BIB.draft;
  if (!dr) {
    return `<div class="bs-empty"><p>Select an entry to edit it, or add one:</p>
      <button class="btn-small btn-primary" data-bib="identifier">Add by DOI / arXiv / ISBN</button>
      <button class="btn-small btn-secondary" data-bib="search">Search online</button>
      <button class="btn-small btn-secondary" data-bib="paste">Paste BibTeX</button>
      <button class="btn-small btn-secondary" data-bib="new">New entry</button>
      <p class="muted">Click a row in the left panel's References list to cite it at the editor's cursor.</p></div>`;
  }
  const S = BIB.sources || { types: {} };
  const types = Object.keys(S.types || {});
  if (!types.includes(dr.type)) types.push(dr.type);
  const present = Object.keys(dr.fields).filter((k) => dr.fields[k] !== undefined);
  const g = BibUI.fieldGroups(dr.type, S.types, present.concat(dr.order || []).filter((v, i, a) => a.indexOf(v) === i && dr.fields[v] !== undefined));
  const req = g.required.map((alts) => {
    const have = alts.find((a) => (dr.fields[a] || "").trim());
    const name = have || alts[0];
    return bibFieldRow(name, dr.fields[name], true, alts.length > 1 ? alts : null);
  }).join("");
  const optHave = g.optional.filter((f) => dr.fields[f] !== undefined);
  const optMissing = g.optional.filter((f) => dr.fields[f] === undefined);
  const opt = optHave.map((f) => bibFieldRow(f, dr.fields[f], false)).join("");
  const other = g.other.map((f) => bibFieldRow(f, dr.fields[f], false)).join("");
  const e = BIB.sel ? bibEntry(BIB.sel) : null;
  const links = e ? Object.entries(e.links || {}).map(([k, u]) => `<a href="${bq(u)}" target="_blank" rel="noopener noreferrer">${BIB_ICON.link} ${k === "doi" ? "DOI" : k === "arxiv" ? "arXiv" : "Link"}</a>`) : [];
  const title = (dr.fields.title || "").replace(/[{}\\]/g, "");
  if (title && BIB.sources && BIB.sources.scholar) {
    links.push(`<a href="${bq(BIB.sources.scholar.url.replace("{q}", encodeURIComponent(title)))}" target="_blank" rel="noopener noreferrer">${BIB_ICON.link} Google Scholar</a>`);
  }
  const fieldsTab = `
    <div class="bf-group"><h5>Required</h5>${req || '<p class="muted">None for this type.</p>'}</div>
    ${opt || other ? `<div class="bf-group"><h5>Optional</h5>${opt}${other}</div>` : ""}
    <div class="bf-add">
      <select data-bf-add aria-label="Add a field"><option value="">+ Add field…</option>${optMissing.map((f) => `<option>${bq(f)}</option>`).join("")}<option value="__other">Other…</option></select>
    </div>`;
  const srcTab = `<textarea class="bs-source" id="bib-source" spellcheck="false">${bq(e ? e.source : "")}</textarea>
    <p class="muted">Edit the BibTeX of this entry directly. Saving replaces just this entry in the file.</p>`;
  const msg = BIB.sideData && BIB.sideData.msg ? `<div class="bs-msg ${BIB.sideData.bad ? "bad" : ""}">${BIB.sideData.msg}</div>` : "";
  return `<div class="bs-entry">
    <div class="be-head">
      <select id="be-type" aria-label="Entry type">${types.map((t) => `<option${t === dr.type ? " selected" : ""}>${bq(t)}</option>`).join("")}</select>
      <input id="be-key" value="${bq(dr.key)}" placeholder="citation key (generated if empty)" aria-label="Citation key" spellcheck="false">
      <button class="icon-btn" data-bib="genkey" title="Generate the key from the pattern ${bq(bibPrefs().key_pattern)}">${BIB_ICON.key}</button>
    </div>
    ${!dr.isNew ? `<div class="seg-toggle be-tabs"><button data-be-tab="fields" class="${BIB.tab === "fields" ? "active" : ""}">Fields</button><button data-be-tab="source" class="${BIB.tab === "source" ? "active" : ""}">BibTeX</button></div>` : ""}
    ${msg}
    <div class="be-body">${BIB.tab === "source" && !dr.isNew ? srcTab : fieldsTab}</div>
    ${links.length ? `<div class="be-links">${links.join("")}</div>` : ""}
    <div class="be-foot">
      ${!dr.isNew && dr.key !== dr.origKey ? `<label class="be-rename"><input type="checkbox" data-be-rename${dr.renameCites ? " checked" : ""}> Update <code>\\cite</code> commands</label>` : ""}
      <div class="be-btns">
        ${!dr.isNew ? `<button class="btn-small btn-secondary" data-bib="cite" title="Insert a citation at the editor's cursor">Cite</button>
        <button class="btn-small btn-secondary" data-bib="fetch" title="Compare with the online record (DOI, arXiv, ISBN or title)">Fetch details</button>
        <button class="btn-small btn-secondary danger" data-bib="delete">Delete</button>` : ""}
        <span class="spacer"></span>
        ${dr.dirty ? `<button class="btn-small btn-secondary" data-bib="revert">${dr.isNew ? "Cancel" : "Revert"}</button>` : ""}
        <button class="btn-small btn-primary" data-bib="save"${dr.dirty || (BIB.tab === "source" && !dr.isNew) ? "" : " disabled"}>${dr.isNew ? "Add entry" : "Save"}</button>
      </div>
    </div></div>`;
}

function bibSourceChips(selected) {
  const S = BIB.sources || { sources: [] };
  return (S.sources || []).filter((s) => s.search).map((s) =>
    `<button class="bs-chip${s.id === selected ? " on" : ""}" data-src="${bq(s.id)}"${s.enabled ? "" : " disabled"} title="${bq(s.about)}${s.enabled ? "" : " (not enabled)"}">${bq(s.label)}</button>`).join("");
}

function bibInLibrary(c) {
  const doi = (c.doi || "").toLowerCase(), ax = (c.arxiv || "").replace(/v\d+$/, "");
  const t = BibUI.fold(c.title).replace(/[^a-z0-9]+/g, " ").trim();
  return bibEntries().find((e) => {
    const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
    if (doi && (f.doi || "").toLowerCase().includes(doi)) return true;
    if (ax && (f.eprint || "").replace(/v\d+$/, "") === ax) return true;
    return t.length > 12 && BibUI.fold(e.display.title).replace(/[^a-z0-9]+/g, " ").trim() === t;
  });
}

function bibCandidate(c, i, checkable) {
  const have = bibInLibrary(c);
  const links = [c.doi ? `<a href="https://doi.org/${bq(c.doi)}" target="_blank" rel="noopener noreferrer">DOI</a>` : "",
    c.arxiv ? `<a href="https://arxiv.org/abs/${bq(c.arxiv)}" target="_blank" rel="noopener noreferrer">arXiv</a>` : "",
    !c.doi && !c.arxiv && /^https?:\/\//i.test(c.url || "") ? `<a href="${bq(c.url)}" target="_blank" rel="noopener noreferrer">Link</a>` : ""].filter(Boolean).join(" · ");
  return `<div class="bs-cand${have ? " have" : ""}" data-cand="${i}">
    ${checkable ? `<input type="checkbox" data-pick="${i}"${BIB.search.picked.has(i) ? " checked" : ""}${have ? " disabled" : ""} aria-label="Select">` : ""}
    <div class="bs-cand-main"><div class="bs-cand-title">${bq(c.title || "(untitled)")}</div>
      <div class="bs-cand-meta">${bq([c.authors, c.year, c.venue].filter(Boolean).join(" · "))}</div>
      <div class="bs-cand-meta"><span class="bs-badge">${bq(c.source)}</span> ${bq(c.type)}${links ? " · " + links : ""}${have ? ` · <b>in the library as <button class="tg-link" data-show="${bq(have.key)}">${bq(have.key)}</button></b>` : ""}</div></div>
    ${checkable ? "" : `<button class="btn-small btn-primary" data-add-cand="${i}"${have ? " disabled" : ""}>Add</button>`}</div>`;
}

function bibSideIdentifier() {
  const sd = BIB.sideData || {};
  const res = (sd.results || []).map((c, i) => bibCandidate(c, i, false)).join("");
  return bibSideHead("Add by identifier") + `
    <p class="muted">A DOI, arXiv id, ISBN — or a doi.org / arxiv.org link.</p>
    <div class="bs-row"><input id="bi-q" placeholder="10.1038/nature14539 · 1706.03762 · 978-0-262-03561-3" value="${bq(sd.q || "")}" spellcheck="false">
      <button class="btn-small btn-primary" data-bib="lookup"${sd.busy ? " disabled" : ""}>${sd.busy ? "Looking up…" : "Look up"}</button></div>
    ${sd.msg ? `<div class="bs-msg ${sd.bad ? "bad" : ""}">${sd.msg}</div>` : ""}
    <div class="bs-cands">${res}</div>`;
}

function bibSideSearch() {
  const s = BIB.search;
  const S = BIB.sources || {};
  const res = s.results.map((c, i) => bibCandidate(c, i, true)).join("");
  const scholar = S.scholar ? `<a class="bs-scholar" href="${bq(S.scholar.url.replace("{q}", encodeURIComponent(s.q || "")))}" target="_blank" rel="noopener noreferrer" title="${bq(S.scholar.note)}">${BIB_ICON.link} Google Scholar</a>` : "";
  return bibSideHead("Search online") + `
    <div class="bs-row"><input id="bs-q" placeholder="title, authors, keywords…" value="${bq(s.q)}" spellcheck="false">
      <button class="btn-small btn-primary" data-bib="dosearch"${s.busy ? " disabled" : ""}>${s.busy ? "Searching…" : "Search"}</button></div>
    <div class="bs-chips">${bibSourceChips(s.source)}${scholar}</div>
    ${s.forKey ? `<div class="bs-msg">The first entry you add gets the key <code>${bq(s.forKey)}</code> (cited but missing).</div>` : ""}
    ${s.msg ? `<div class="bs-msg ${s.bad ? "bad" : ""}">${s.msg}</div>` : ""}
    <div class="bs-cands">${res}</div>
    ${s.results.length ? `<div class="bs-foot"><span class="muted">${s.picked.size} selected</span><span class="spacer"></span>
      <button class="btn-small btn-primary" data-bib="addpicked"${s.picked.size ? "" : " disabled"}>Add selected</button></div>` : ""}`;
}

function bibSidePaste() {
  const sd = BIB.sideData || {};
  const S = BIB.sources || {};
  return bibSideHead("Paste BibTeX") + `
    <p class="muted">One or more entries — e.g. from Google Scholar (Cite → BibTeX), a publisher page or another .bib file. Duplicates of entries you already have are skipped; clashing keys get a suffix.</p>
    <textarea id="bp-text" class="bs-source" spellcheck="false" placeholder="@article{key,&#10;  author = {…},&#10;  title = {…},&#10;}">${bq(sd.text || "")}</textarea>
    <div class="bs-foot">${S.scholar ? `<a class="bs-scholar" href="https://scholar.google.com" target="_blank" rel="noopener noreferrer">${BIB_ICON.link} Open Google Scholar</a>` : ""}
      <span class="spacer"></span><button class="btn-small btn-primary" data-bib="doimport">Import</button></div>
    ${sd.msg ? `<div class="bs-msg ${sd.bad ? "bad" : ""}">${sd.msg}</div>` : ""}`;
}

function bibSideCleanup() {
  const S = BIB.sources || { cleanups: {} };
  const sd = BIB.sideData || {};
  const acts = Object.entries(S.cleanups || {}).map(([id, label]) =>
    `<label class="bs-check"><input type="checkbox" data-clean="${bq(id)}" checked> ${bq(label)}</label>`).join("");
  return bibSideHead("Clean up entries") + `<div class="bs-checks">${acts}</div>
    <div class="bs-row"><label class="bs-check"><input type="radio" name="bc-scope" value="sel"${BIB.sel ? " checked" : " disabled"}> Selected entry${BIB.sel ? ` (${bq(BIB.sel)})` : ""}</label>
      <label class="bs-check"><input type="radio" name="bc-scope" value="all"${BIB.sel ? "" : " checked"}> All ${bibEntries().length} entries</label></div>
    <div class="bs-foot"><span class="spacer"></span><button class="btn-small btn-primary" data-bib="docleanup">Clean up</button></div>
    ${sd.msg ? `<div class="bs-msg">${sd.msg}</div>` : ""}`;
}

function bibSideKeys() {
  const S = BIB.sources || { key_tokens: [] };
  const sd = BIB.sideData || {};
  const preview = sd.renamed ? (Object.keys(sd.renamed).length
    ? `<table class="bs-keys"><tbody>${Object.entries(sd.renamed).slice(0, 60).map(([o, n]) => `<tr><td><code>${bq(o)}</code></td><td>→</td><td><code>${bq(n)}</code></td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">Every key already matches the pattern.</p>`) : "";
  return bibSideHead("Generate citation keys") + `
    <div class="bs-row"><input id="bk-pattern" value="${bq(sd.pattern || bibPrefs().key_pattern)}" spellcheck="false" aria-label="Key pattern"></div>
    <p class="muted">Fields in brackets, with an optional <code>:lower</code>, <code>:upper</code> or <code>:capitalize</code>:
      ${(S.key_tokens || []).map((t) => `<code class="bs-token" data-token="${bq(t)}">[${bq(t)}]</code>`).join(" ")}. A clashing key gets a, b, c….</p>
    <div class="bs-row"><label class="bs-check"><input type="radio" name="bk-scope" value="sel"${BIB.sel ? "" : " disabled"}> Selected entry</label>
      <label class="bs-check"><input type="radio" name="bk-scope" value="all" checked> All entries</label>
      <label class="bs-check"><input type="checkbox" id="bk-rename" checked> Update <code>\\cite</code> commands</label></div>
    <div class="bs-foot"><button class="btn-small btn-secondary" data-bib="keypreview">Preview</button><span class="spacer"></span>
      <button class="btn-small btn-primary" data-bib="keyapply">Apply</button></div>${preview}
    ${sd.msg ? `<div class="bs-msg">${sd.msg}</div>` : ""}`;
}

function bibSideDuplicates() {
  const d = BIB.data || {};
  const groups = d.duplicates || [];
  const sd = BIB.sideData || {};
  const rows = groups.map((g, i) => `<div class="bs-dup" data-dup="${i}">
      <div>${g.keys.map((k) => `<button class="tg-link" data-show="${bq(k)}">${bq(k)}</button>`).join(" · ")} <span class="muted">— ${bq(g.reason)}</span></div>
      <div class="bs-row">Keep <select data-dup-keep="${i}">${g.keys.map((k) => `<option>${bq(k)}</option>`).join("")}</select>
        <button class="btn-small btn-primary" data-dup-merge="${i}" title="Fill the kept entry's empty fields from the others, delete them, and point their \\cite commands at it">Merge</button></div></div>`).join("");
  return bibSideHead("Duplicates") + (rows || `<p class="muted">No duplicates found (same DOI, arXiv id or title).</p>`) +
    (sd.msg ? `<div class="bs-msg">${sd.msg}</div>` : "");
}

function bibSidePrefs() {
  const S = BIB.sources || { cite_commands: [], sources: [] };
  const p = bibPrefs();
  const sd = BIB.sideData || {};
  return bibSideHead("Settings") + `
    <div class="bf-row"><label for="bpr-pattern">Key pattern</label><input id="bpr-pattern" value="${bq(p.key_pattern)}" spellcheck="false"></div>
    <div class="bf-row"><label for="bpr-cite">Cite command</label><select id="bpr-cite">${(S.cite_commands || []).map((c) => `<option${c === p.cite_command ? " selected" : ""}>${bq(c)}</option>`).join("")}</select></div>
    <div class="bf-row"><label>Search in</label><div class="bs-checks">${(S.sources || []).filter((s) => s.search).map((s) =>
      `<label class="bs-check"><input type="checkbox" data-pref-src="${bq(s.id)}"${(p.search_sources || []).includes(s.id) ? " checked" : ""}${s.enabled ? "" : " disabled"}> ${bq(s.label)} <span class="muted">${bq(s.about)}</span></label>`).join("")}</div></div>
    <p class="muted">${S.online ? "Lookups go from the server to the services above; nothing is sent until you search or look something up." : "Online lookups are turned off in config.toml."}
      Google Scholar has no API: use its Cite → BibTeX and <button class="tg-link" data-bib="paste">paste</button> the result.</p>
    <div class="bs-foot"><span class="spacer"></span><button class="btn-small btn-primary" data-bib="saveprefs">Save</button></div>
    ${sd.msg ? `<div class="bs-msg ${sd.bad ? "bad" : ""}">${sd.msg}</div>` : ""}`;
}

function bibSideFetch() {
  const sd = BIB.sideData || {};
  if (sd.busy) return bibSideHead("Fetch details") + `<p class="muted">Looking up ${bq(BIB.sel)}…</p>`;
  if (sd.error) return bibSideHead("Fetch details") + `<div class="bs-msg bad">${bq(sd.error)}</div>`;
  const r = sd.result;
  if (!r) return bibSideHead("Fetch details");
  const rows = r.diff.map((x, i) => `<tr><td><input type="checkbox" data-fetch-pick="${i}"${x.current ? "" : " checked"}></td>
      <th>${bq(x.field)}</th><td class="cur">${x.current ? bq(x.current) : '<span class="muted">—</span>'}</td><td class="new">${bq(x.fetched)}</td></tr>`).join("");
  return bibSideHead("Fetch details") + `<p class="muted">From <b>${bq(r.candidate.source)}</b>: ${bq(r.candidate.title)}. Tick the values to take.</p>
    ${r.type !== r.current_type ? `<label class="bs-check"><input type="checkbox" id="bf-type-pick"> Change the type from <b>${bq(r.current_type)}</b> to <b>${bq(r.type)}</b></label>` : ""}
    ${rows ? `<table class="bs-diff"><thead><tr><th></th><th>Field</th><th>Now</th><th>Online</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="bs-foot"><span class="spacer"></span><button class="btn-small btn-primary" data-bib="applyfetch">Use the ticked values</button></div>`
      : `<p>The entry already matches the online record.</p>`}`;
}

// ── actions ─────────────────────────────────────────────────────────────
function bibCollectDraft() {
  const dr = BIB.draft;
  if (!dr) return;
  const t = $("#be-type"), k = $("#be-key");
  if (t) dr.type = t.value;
  if (k) dr.key = k.value.trim();
  document.querySelectorAll("#bib-side textarea.bf-val").forEach((ta) => { dr.fields[ta.dataset.field] = ta.value; });
}

async function bibSaveDraft(force) {
  bibCollectDraft();
  const dr = BIB.draft;
  if (!dr) return;
  await bibSyncEditor();
  const file = BIB.file || "refs.bib";
  const fields = Object.fromEntries(Object.entries(dr.fields).filter(([, v]) => v != null && String(v).trim() !== ""));
  let r;
  try {
    if (BIB.tab === "source" && !dr.isNew) {
      r = await bibApi("PUT", `/api/projects/${bibProject()}/bib/entries/${encodeURIComponent(dr.origKey)}/source`,
        { file, source: $("#bib-source").value, rename_citations: dr.renameCites });
    } else if (dr.isNew) {
      r = await bibApi("POST", `/api/projects/${bibProject()}/bib/entries`, { file, type: dr.type, key: dr.key || null, fields, force: !!force });
    } else {
      r = await bibApi("PUT", `/api/projects/${bibProject()}/bib/entries/${encodeURIComponent(dr.origKey)}`,
        { file, type: dr.type, key: dr.key || dr.origKey, fields, rename_citations: dr.renameCites });
    }
  } catch (e) {
    if (e.status === 409 && e.detail && e.detail.duplicates && !force) {
      const d0 = e.detail.duplicates[0];
      if (confirm(`This looks like ${d0.key} (${d0.reason}). Add it anyway?`)) return bibSaveDraft(true);
      return;
    }
    BIB.sideData = { msg: bq(e.message), bad: true };
    bibRenderSide();
    return;
  }
  bibApplyContent(r.file, r.content);
  bibApplyChanged(r.changed_files);
  const renamed = Object.keys(r.changed_files || {}).length;
  await bibLoad(r.file);
  bibSelect(r.key, true);
  BIB.sideData = { msg: dr.isNew ? `Added <code>${bq(r.key)}</code>.` : `Saved${renamed ? ` — \\cite commands updated in ${renamed} file${renamed === 1 ? "" : "s"}` : ""}.` };
  bibRender();
}

async function bibDelete() {
  const key = BIB.sel;
  if (!key) return;
  const e = bibEntry(key);
  if (!confirm(`Delete ${key}?${e && e.cited ? ` It is cited ${e.cited} time${e.cited === 1 ? "" : "s"}.` : ""}`)) return;
  await bibSyncEditor();
  try {
    const r = await bibApi("DELETE", `/api/projects/${bibProject()}/bib/entries/${encodeURIComponent(key)}?file=${encodeURIComponent(BIB.file)}`);
    bibApplyContent(r.file, r.content);
  } catch (err) { alert(err.message); return; }
  BIB.sel = null; BIB.draft = null;
  await bibLoad();
}

async function bibImport(body, okMsg) {
  await bibSyncEditor();
  const file = BIB.file || "refs.bib";
  const r = await bibApi("POST", `/api/projects/${bibProject()}/bib/import`, { file, ...body });
  bibApplyContent(r.file, r.content);
  await bibLoad(r.file);
  const bits = [];
  if (r.added.length) bits.push(`${okMsg || "Added"} ${r.added.map((k) => `<button class="tg-link" data-show="${bq(k)}">${bq(k)}</button>`).join(", ")}.`);
  if (r.skipped.length) bits.push(`Skipped ${r.skipped.length} already in the library: ${r.skipped.map((s) => `“${bq(s.title || s.key)}” = <button class="tg-link" data-show="${bq(s.duplicate_of)}">${bq(s.duplicate_of)}</button>`).join("; ")}.`);
  if (r.errors.length) bits.push(`${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}: ${r.errors.slice(0, 3).map((x) => bq((x.line ? `line ${x.line}: ` : "") + x.message)).join("; ")}.`);
  return { r, msg: bits.join(" ") || "Nothing to import.", bad: !r.added.length && !!r.errors.length };
}

async function bibLookup() {
  const q = $("#bi-q").value.trim();
  if (!q) return;
  BIB.sideData = { q, busy: true };
  bibRenderSide();
  try {
    const r = await bibApi("GET", `/api/bib/lookup?q=${encodeURIComponent(q)}`);
    BIB.sideData = { q, results: r.results, msg: r.results.length > 1 ? `${r.results.length} records.` : "" };
  } catch (e) { BIB.sideData = { q, msg: bq(e.message), bad: true, results: [] }; }
  bibRenderSide();
}

async function bibDoSearch() {
  const s = BIB.search;
  s.q = $("#bs-q").value.trim();
  if (!s.q) return;
  s.busy = true; s.msg = ""; s.bad = false; s.results = []; s.picked = new Set();
  const seq = (s.seq = (s.seq || 0) + 1);
  bibRenderSide();
  try {
    const r = await bibApi("GET", `/api/bib/search?q=${encodeURIComponent(s.q)}&source=${encodeURIComponent(s.source)}&limit=15`);
    if (seq !== s.seq) return;              // a newer search started meanwhile
    s.results = r.results || [];
    s.msg = s.results.length ? "" : "No results — try other words or another source.";
    if (r.identifier) s.msg = `That's ${r.identifier.kind === "doi" ? "a DOI" : r.identifier.kind === "arxiv" ? "an arXiv id" : "an ISBN"} — here is its record.`;
  } catch (e) { if (seq !== s.seq) return; s.msg = bq(e.message); s.bad = true; }
  s.busy = false;
  if (BIB.side === "search") bibRenderSide();
}

async function bibAddCandidates(cands) {
  const s = BIB.search;
  if (s.forKey && cands.length) cands = [{ ...cands[0], key: s.forKey }, ...cands.slice(1)];
  try {
    const { r, msg, bad } = await bibImport({ candidates: cands, duplicates: "skip" });
    if (r.added.length && s.forKey) s.forKey = null;
    return { r, msg, bad };
  } catch (e) { return { r: null, msg: bq(e.message), bad: true }; }
}

async function bibFetchDetails() {
  const key = BIB.sel;
  if (!key) return;
  await bibSyncEditor();
  BIB.side = "fetch"; BIB.sideData = { busy: true };
  bibRenderSide();
  try {
    const r = await bibApi("GET", `/api/projects/${bibProject()}/bib/entries/${encodeURIComponent(key)}/fetch?file=${encodeURIComponent(BIB.file)}`);
    BIB.sideData = { result: r };
  } catch (e) { BIB.sideData = { error: e.message }; }
  bibRenderSide();
}

async function bibApplyFetch() {
  const r = BIB.sideData && BIB.sideData.result;
  if (!r || !BIB.draft) return;
  document.querySelectorAll("#bib-side [data-fetch-pick]").forEach((cb) => {
    if (cb.checked) { const x = r.diff[+cb.dataset.fetchPick]; BIB.draft.fields[x.field] = x.fetched; }
  });
  if ($("#bf-type-pick") && $("#bf-type-pick").checked) BIB.draft.type = r.type;
  BIB.draft.dirty = true;
  BIB.side = "entry"; BIB.tab = "fields";
  await bibSaveDraft(true);
}

async function bibRunCleanup() {
  const actions = [...document.querySelectorAll("#bib-side [data-clean]:checked")].map((c) => c.dataset.clean);
  const scope = (document.querySelector('#bib-side input[name="bc-scope"]:checked') || {}).value;
  await bibSyncEditor();
  try {
    const r = await bibApi("POST", `/api/projects/${bibProject()}/bib/cleanup`,
      { file: BIB.file, actions, keys: scope === "sel" && BIB.sel ? [BIB.sel] : null });
    bibApplyContent(r.file, r.content);
    await bibLoad(r.file);
    if (BIB.sel) BIB.draft = bibEntry(BIB.sel) ? bibDraftFrom(bibEntry(BIB.sel)) : null;
    BIB.sideData = { msg: r.changed.length ? `Cleaned ${r.changed.length} entr${r.changed.length === 1 ? "y" : "ies"}: ${r.changed.slice(0, 12).map(bq).join(", ")}${r.changed.length > 12 ? "…" : ""}.` : "Nothing to change." };
  } catch (e) { BIB.sideData = { msg: bq(e.message) }; }
  bibRenderSide();
}

async function bibKeys(dry) {
  const pattern = $("#bk-pattern").value.trim();
  const scope = (document.querySelector('#bib-side input[name="bk-scope"]:checked') || {}).value;
  await bibSyncEditor();
  try {
    const r = await bibApi("POST", `/api/projects/${bibProject()}/bib/keys`, {
      file: BIB.file, pattern, dry_run: dry, keys: scope === "sel" && BIB.sel ? [BIB.sel] : null,
      rename_citations: $("#bk-rename").checked });
    if (dry) { BIB.sideData = { pattern, renamed: r.renamed }; bibRenderSide(); return; }
    bibApplyContent(r.file, r.content);
    bibApplyChanged(r.changed_files);
    if (BIB.sel && r.renamed[BIB.sel]) BIB.sel = r.renamed[BIB.sel];
    await bibLoad(r.file);
    if (BIB.sel) BIB.draft = bibEntry(BIB.sel) ? bibDraftFrom(bibEntry(BIB.sel)) : null;
    const n = Object.keys(r.renamed).length, files = Object.keys(r.changed_files || {}).length;
    BIB.sideData = { pattern, msg: n ? `Renamed ${n} key${n === 1 ? "" : "s"}${files ? `; \\cite commands updated in ${files} file${files === 1 ? "" : "s"}` : ""}.` : "Every key already matches the pattern." };
  } catch (e) { BIB.sideData = { pattern, msg: bq(e.message) }; }
  bibRender();
}

async function bibMerge(i) {
  const g = (BIB.data.duplicates || [])[i];
  if (!g) return;
  const keep = document.querySelector(`#bib-side [data-dup-keep="${i}"]`).value;
  const remove = g.keys.filter((k) => k !== keep);
  if (!confirm(`Merge ${remove.join(", ")} into ${keep}? ${remove.length === 1 ? "It is" : "They are"} deleted, and citations of ${remove.length === 1 ? "it" : "them"} point to ${keep}.`)) return;
  await bibSyncEditor();
  try {
    const r = await bibApi("POST", `/api/projects/${bibProject()}/bib/merge`, { file: BIB.file, keep, remove });
    bibApplyContent(r.file, r.content);
    bibApplyChanged(r.changed_files);
    await bibLoad(r.file);
    BIB.sideData = { msg: `Merged into <code>${bq(keep)}</code>${r.conflicts.length ? ` — values that differed were kept from ${bq(keep)}: ${r.conflicts.map(bq).join(", ")}` : ""}.` };
  } catch (e) { BIB.sideData = { msg: bq(e.message) }; }
  bibRenderSide();
}

async function bibSavePrefs() {
  const body = { key_pattern: $("#bpr-pattern").value.trim(), cite_command: $("#bpr-cite").value,
    search_sources: [...document.querySelectorAll("#bib-side [data-pref-src]:checked")].map((c) => c.dataset.prefSrc) };
  try {
    const p = await bibApi("PUT", "/api/bib/prefs", body);
    if (BIB.data) BIB.data.prefs = p;
    if (BIB.sources) BIB.sources.prefs = p;
    BIB.sideData = { msg: "Saved." };
  } catch (e) { BIB.sideData = { msg: bq(e.message), bad: true }; }
  bibRenderSide();
  bibRenderStatus();
}

function bibGotoLine(file, line) {
  bibClose();
  if (BIB.open) return;
  openFile(file, { line: +line });
}

async function bibToolbar(act, el) {
  switch (act) {
    case "new": return bibNewDraft("article");
    case "identifier": case "search": case "paste": case "cleanup": case "keys": case "duplicates": case "prefs":
      BIB.side = act; BIB.sideData = null;
      if (act === "search" && el && el.dataset.q) BIB.search.q = el.dataset.q;
      bibRenderSide();
      setTimeout(() => ($("#bib-side input:not([type=checkbox]):not([type=radio])") || $("#bib-side textarea"))?.focus(), 20);
      return;
    case "back": BIB.side = "entry"; BIB.sideData = null; return bibRenderSide();
    case "save": return bibSaveDraft();
    case "revert":
      if (BIB.draft && BIB.draft.isNew) { BIB.draft = null; BIB.side = "entry"; return bibRenderSide(); }
      if (BIB.sel) bibSelect(BIB.sel, true);
      BIB.sideData = null;
      return bibRenderSide();
    case "delete": return bibDelete();
    case "cite": {
      const key = BIB.sel;
      if (!key) return;
      bibClose();
      if (!BIB.open) bibCite([key]);
      return;
    }
    case "fetch": return bibFetchDetails();
    case "applyfetch": return bibApplyFetch();
    case "genkey": {
      bibCollectDraft();
      const r = await bibApi("POST", `/api/projects/${bibProject()}/bib/keys`, { file: BIB.file, dry_run: true, keys: BIB.sel ? [BIB.sel] : [] }).catch(() => null);
      if (BIB.draft.isNew || !r) {
        // a new entry gets its key when it's added (an empty key means "generate")
        BIB.draft.key = ""; BIB.draft.dirty = true;
        BIB.sideData = { msg: `The key is generated from ${bq(bibPrefs().key_pattern)} when you add the entry.` };
      } else {
        BIB.draft.key = r.renamed[BIB.sel] || BIB.sel; BIB.draft.dirty = BIB.draft.key !== BIB.draft.origKey;
        BIB.sideData = null;
      }
      return bibRenderSide();
    }
    case "lookup": return bibLookup();
    case "dosearch": return bibDoSearch();
    case "addpicked": {
      const cands = [...BIB.search.picked].map((i) => BIB.search.results[i]).filter(Boolean);
      const { msg, bad } = await bibAddCandidates(cands);
      BIB.search.picked = new Set();
      BIB.search.msg = msg; BIB.search.bad = bad;
      return bibRender();
    }
    case "doimport": {
      const text = $("#bp-text").value;
      if (!text.trim()) return;
      try {
        const { r, msg, bad } = await bibImport({ text, duplicates: "skip" }, "Imported");
        BIB.sideData = { text: r.added.length ? "" : text, msg, bad };
      } catch (e) { BIB.sideData = { text, msg: bq(e.message), bad: true }; }
      return bibRender();
    }
    case "docleanup": return bibRunCleanup();
    case "keypreview": return bibKeys(true);
    case "keyapply": return bibKeys(false);
    case "saveprefs": return bibSavePrefs();
    case "usefile": return bibAddToMain(BIB.file);
    case "createfile": {
      const p = await bibCreateFile("refs.bib");
      await bibLoad(p);
      return;
    }
  }
}

// ── wiring ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // left panel
  let open = false;
  try { open = localStorage.getItem(BIB_OPEN_KEY) === "1"; } catch { /* private mode */ }
  bibSetPanelOpen(open);
  $("#refs-toggle").addEventListener("click", () => bibSetPanelOpen($("#pane-refs").classList.contains("closed")));
  $("#refs-search").addEventListener("input", (e) => { BIB.panelQuery = e.target.value; bibRenderPanel(); });
  $("#refs-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = $("#refs-list .ref-row");
      if (first) { e.preventDefault(); bibCite([first.dataset.key]); }
    }
    if (e.key === "Escape") { e.target.value = ""; BIB.panelQuery = ""; bibRenderPanel(); }
  });
  $("#refs-add").addEventListener("click", () => bibOpen({ side: "identifier" }));
  $("#refs-open").addEventListener("click", () => bibOpen());
  $("#refs-warn").addEventListener("click", (e) => { e.stopPropagation(); bibOpen({ filter: "missing" }); });
  const list = $("#refs-list");
  let clickTimer = 0;
  list.addEventListener("mousedown", (e) => { if (e.target.closest(".ref-row")) e.preventDefault(); });   // keep the editor's caret
  list.addEventListener("click", async (e) => {
    if (e.target.closest("[data-ref-create]")) { const p = await bibCreateFile("refs.bib"); await bibLoad(p); return bibOpen({ side: "identifier" }); }
    if (e.target.closest("[data-ref-missing]")) return bibOpen({ filter: "missing" });
    if (e.target.closest("[data-ref-add]")) return bibOpen({ side: "identifier" });
    const row = e.target.closest(".ref-row");
    if (!row) return;
    clearTimeout(clickTimer);
    if (e.detail > 1) return;
    clickTimer = setTimeout(() => bibCite([row.dataset.key]), 220);   // wait: a double click edits instead
  });
  list.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".ref-row");
    if (!row) return;
    clearTimeout(clickTimer);
    bibOpen({ key: row.dataset.key });
  });
  document.querySelectorAll("[data-tool=bibman]").forEach((b) => b.addEventListener("click", () => bibOpen()));
  document.addEventListener("tw:project", () => { BIB.data = null; BIB.sel = null; BIB.draft = null; BIB.file = null; BIB.loadedFor = null;
    if (!$("#pane-refs").classList.contains("closed")) bibLoad(); else bibRenderPanel(); });
  document.addEventListener("tw:saved", (e) => {
    // a saved .bib or .tex changes entries or citations
    if (/\.(bib|tex|ltx)$/i.test((e.detail && e.detail.path) || "") && BIB.loadedFor === bibProject()) bibLoad();
  });

  // manager
  const bm = $("#bib-modal");
  $("#bib-close").addEventListener("click", bibClose);
  bm.addEventListener("mousedown", (e) => { if (e.target === bm) bibClose(); });
  $("#bib-file").addEventListener("change", async (e) => {
    if (e.target.value === "__new") {
      const name = await modal("New bibliography file", "refs.bib", "refs.bib");
      if (!name) { bibRenderTop(); return; }
      const p = await bibCreateFile(name).catch((err) => { alert(err.message); return null; });
      if (p) { BIB.sel = null; BIB.draft = null; await bibLoad(p); }
      return;
    }
    if (BIB.draft && BIB.draft.dirty && !confirm("Discard the changes to this entry?")) { bibRenderTop(); return; }
    BIB.sel = null; BIB.draft = null;
    await bibLoad(e.target.value);
  });
  $("#bib-search").addEventListener("input", (e) => { BIB.query = e.target.value; bibRenderTable(); bibRenderStatus(); });
  $("#bib-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-filter]");
    if (!b) return;
    BIB.filter = b.dataset.filter;
    bibRender();
  });
  $("#bib-toolbar").addEventListener("click", (e) => { const b = e.target.closest("[data-bib]"); if (b) bibToolbar(b.dataset.bib, b); });
  $("#bib-banner").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bib]");
    if (b) return bibToolbar(b.dataset.bib, b);
    const l = e.target.closest("[data-bib-line]");
    if (l) bibGotoLine(BIB.file, l.dataset.bibLine);
  });
  $("#bib-tablewrap").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const c = th.dataset.sort;
      BIB.sort = { col: c, dir: BIB.sort.col === c && BIB.sort.dir === "asc" ? "desc" : "asc" };
      return bibRenderTable();
    }
    const b = e.target.closest("[data-bib]");
    if (b) return bibToolbar(b.dataset.bib, b);
    const go = e.target.closest("[data-goto]");
    if (go) { const [f, l] = go.dataset.goto.split(/:(?=\d+$)/); return bibGotoLine(f, l); }
    const ma = e.target.closest("[data-miss-act]");
    if (ma) {
      const key = ma.closest("[data-miss]").dataset.miss;
      if (ma.dataset.missAct === "new") return bibNewDraft("article", key);
      BIB.search.forKey = key; BIB.search.q = BibUI.keyToQuery(key); BIB.search.results = []; BIB.search.msg = "";
      BIB.side = "search";
      bibRenderSide();
      return bibDoSearch();
    }
    const tr = e.target.closest("tr[data-key]");
    if (tr && bibSelect(tr.dataset.key)) { BIB.tab = BIB.tab || "fields"; BIB.sideData = null; bibRenderTable(); bibRenderSide(); }
  });
  $("#bib-tablewrap").addEventListener("dblclick", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (tr) setTimeout(() => $("#bib-side textarea.bf-val")?.focus(), 10);
  });
  $("#bib-tablewrap").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    const rows = bibVisible();
    if (!rows.length) return;
    e.preventDefault();
    if (e.key === "Enter") { $("#bib-side textarea.bf-val")?.focus(); return; }
    const i = rows.findIndex((r) => r.key === BIB.sel);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next && bibSelect(next.key)) { BIB.sideData = null; bibRenderTable(); bibRenderSide(); }
  });

  const side = $("#bib-side");
  side.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("bf-val") && BIB.draft) { BIB.draft.fields[t.dataset.field] = t.value; bibGrow(t); bibMarkDirty(); }
    if (t.id === "be-key" && BIB.draft) { BIB.draft.key = t.value.trim(); bibMarkDirty(true); }
    if (t.id === "bib-source") { const b = side.querySelector('[data-bib="save"]'); if (b) b.disabled = false; }
  });
  side.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "be-type" && BIB.draft) { bibCollectDraft(); BIB.draft.type = t.value; BIB.draft.dirty = true; return bibRenderSide(); }
    if (t.matches("[data-bf-add]")) {
      let name = t.value;
      if (name === "__other") name = (prompt("Field name (letters, digits, - _ :)") || "").trim().toLowerCase();
      t.value = "";
      if (!name || !BIB.draft) return;
      bibCollectDraft();
      if (BIB.draft.fields[name] === undefined) BIB.draft.fields[name] = "";
      BIB.draft.order.push(name);
      bibRenderSide();
      setTimeout(() => side.querySelector(`[data-field="${CSS.escape(name)}"]`)?.focus(), 10);
    }
    if (t.matches("[data-be-rename]") && BIB.draft) BIB.draft.renameCites = t.checked;
    if (t.matches("[data-pick]")) {
      const i = +t.dataset.pick;
      if (t.checked) BIB.search.picked.add(i); else BIB.search.picked.delete(i);
      const foot = side.querySelector(".bs-foot .muted");
      if (foot) foot.textContent = `${BIB.search.picked.size} selected`;
      const add = side.querySelector('[data-bib="addpicked"]');
      if (add) add.disabled = !BIB.search.picked.size;
    }
  });
  side.addEventListener("click", async (e) => {
    const t = e.target;
    const b = t.closest("[data-bib]");
    if (b) return bibToolbar(b.dataset.bib, b);
    const tab = t.closest("[data-be-tab]");
    if (tab) { bibCollectDraft(); BIB.tab = tab.dataset.beTab; return bibRenderSide(); }
    const rm = t.closest("[data-bf-remove]");
    if (rm && BIB.draft) { bibCollectDraft(); delete BIB.draft.fields[rm.dataset.bfRemove]; BIB.draft.dirty = true; return bibRenderSide(); }
    const fix = t.closest("[data-bib-fix]");
    if (fix && BIB.sel) {
      await bibSyncEditor();
      const r = await bibApi("POST", `/api/projects/${bibProject()}/bib/cleanup`, { file: BIB.file, keys: [BIB.sel], actions: [fix.dataset.bibFix] }).catch((err) => { alert(err.message); return null; });
      if (!r) return;
      bibApplyContent(r.file, r.content);
      await bibLoad(r.file);
      bibSelect(BIB.sel, true);
      return bibRender();
    }
    const show = t.closest("[data-show]");
    if (show) { BIB.filter = "all"; BIB.query = ""; if (bibSelect(show.dataset.show)) { BIB.sideData = null; bibRender(); } return; }
    const src = t.closest("[data-src]");
    if (src && !src.disabled) { BIB.search.source = src.dataset.src; BIB.search.q = ($("#bs-q") || {}).value || BIB.search.q; bibRenderSide(); if (BIB.search.q) bibDoSearch(); return; }
    const add = t.closest("[data-add-cand]");
    if (add) {
      const c = ((BIB.sideData || {}).results || [])[+add.dataset.addCand];
      if (!c) return;
      add.disabled = true;
      const { msg, bad } = await bibAddCandidates([c]);
      BIB.sideData = { ...(BIB.sideData || {}), msg, bad };
      return bibRender();
    }
    const tok = t.closest("[data-token]");
    if (tok) { const inp = $("#bk-pattern"); inp.value += `[${tok.dataset.token}]`; inp.focus(); return; }
    const merge = t.closest("[data-dup-merge]");
    if (merge) return bibMerge(+merge.dataset.dupMerge);
    const cand = t.closest(".bs-cand");
    if (cand && BIB.side === "search" && !t.closest("a,button,input")) {
      const cb = cand.querySelector("[data-pick]");
      if (cb && !cb.disabled) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })); }
    }
  });
  side.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && (e.target.id === "bi-q" || e.target.id === "bs-q")) {
      e.preventDefault();
      return e.target.id === "bi-q" ? bibLookup() : bibDoSearch();
    }
    if (e.key === "Enter" && !e.shiftKey && e.target.classList.contains("bf-val") && e.target.dataset.field !== "abstract") {
      e.preventDefault();      // field values are one line; Shift+Enter for a newline
      const all = [...side.querySelectorAll("textarea.bf-val")];
      const nxt = all[all.indexOf(e.target) + 1];
      if (nxt) nxt.focus(); else side.querySelector('[data-bib="save"]')?.focus();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!BIB.open || !$("#modal").hidden) return;      // the name prompt handles its own keys
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); if (BIB.draft) bibSaveDraft(); }
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      // a sub-panel steps back to the entry it came from; otherwise close
      if (BIB.side !== "entry" && BIB.draft) { BIB.side = "entry"; BIB.sideData = null; bibRenderSide(); }
      else bibClose();
    }
  });
});

function bibMarkDirty(keyOnly) {
  const dr = BIB.draft;
  if (!dr) return;
  const was = dr.dirty;
  dr.dirty = true;
  const save = $('#bib-side [data-bib="save"]');
  if (save) save.disabled = false;
  if (!was || (keyOnly && !dr.isNew && !$("#bib-side [data-be-rename]") && dr.key !== dr.origKey)) {
    // show Revert / the "update \cite" box without losing the caret
    const focus = document.activeElement;
    const id = focus && focus.id, pos = focus && focus.selectionStart;
    bibCollectDraft();
    bibRenderSide();
    const again = id && document.getElementById(id);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* not a text field */ } }
  }
}
