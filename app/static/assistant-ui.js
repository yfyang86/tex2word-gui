// tex-copilot chat (right panel → Assistant) and the Assistant settings dialog.
//
// The server side is app/assistant_api.py: providers/models, skills, prompts,
// settings, and POST /api/conversations/{id}/agent, a server-sent-event stream
// of {start, text, reasoning, tool_start, tool_end, notice, usage, changes,
// done | error}. In Agent mode the model works through project tools and its
// edits come back as a change set the user reviews and applies here.
// MiniMarkdown (markdown.js) renders replies.
"use strict";

const AS_MODEL_KEY = "tw_as_model";
const AS_MODE_KEY = "tw_as_mode";
const AS = {
  providers: [], defaults: {}, presets: [], canManage: false,
  skills: [], prompts: [], settings: null,
  conv: null, convs: [],
  mode: null,             // the open session's mode (else the last one used)
  switch: null,           // a pending model-switch report (POST …/switch-check)
  convQuery: "",          // sessions menu search
  running: null,          // {controller, live}
  useFile: true,          // include the open file as context
  ignoredSel: "",         // a selection the user dismissed
  ac: null,
  frame: 0,
  remoteModels: {},       // provider → fetched model ids (settings datalist)
};

const asLS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const AS_ICON = {
  spin: '<span class="as-spin" aria-hidden="true"></span>',
  ok: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  bad: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  edit: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  redo: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  insert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  file: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  sel: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7V4h3M20 7V4h-3M4 17v3h3M20 17v3h-3M9 12h6"/></svg>',
  x: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  split: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-11 6"/></svg>',
  pin: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z"/></svg>',
  dup: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/></svg>',
  down: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  agent: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/></svg>',
  chat: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  warn: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

const TOOL_LABEL = {
  list_files: "Listed the files", read_file: "Read", search: "Searched", outline: "Outlined",
  check: "Checked the conversion", edit_file: "Edited", write_file: "Wrote",
};

// ── data ────────────────────────────────────────────────────────────────
async function loadProvider() {
  try {
    const r = await api("GET", "/api/providers");
    AS.providers = r.providers || [];
    AS.defaults = r.default || {};
    AS.presets = r.presets || [];
    AS.canManage = !!r.can_manage;
  } catch { AS.providers = []; AS.defaults = {}; }
  asRenderModelPicker();
  asRenderEmpty();
}

async function loadSkills() {
  const [skills, prompts, settings] = await Promise.all([
    api("GET", "/api/skills").catch(() => []),
    api("GET", "/api/prompts").catch(() => []),
    api("GET", "/api/assistant/settings").catch(() => null),
  ]);
  AS.skills = skills || [];
  AS.prompts = prompts || [];
  AS.settings = settings;
  asRenderMode();
  asRenderEmpty();
}

async function loadConversation() {
  AS.conv = null; AS.convs = [];
  if (!state.project) return asRender();
  try {
    AS.convs = await api("GET", `/api/projects/${state.project.id}/conversations`);
    if (AS.convs.length) AS.conv = await api("GET", `/api/conversations/${AS.convs[0].id}`);
  } catch { /* leave empty */ }
  asApplySession();
  asRender();
}

async function asOpenConversation(id) {
  if (AS.running) return;
  try { AS.conv = await api("GET", `/api/conversations/${id}`); } catch (e) { alert(e.message); return; }
  asApplySession();
  asRender();
}

async function asNewConversation() {
  if (!state.project || AS.running) return;
  AS.conv = null;   // created lazily with the first message
  AS.mode = null;
  asApplySession();
  asRender();
  $("#ask-input").focus();
}

// The session's own model and mode go back into the picker and the toggle.
function asApplySession() {
  const s = (AS.conv && AS.conv.settings) || {};
  AS.mode = s.mode || null;
  asHideSwitch();
  asRenderMode();
  asRenderModelPicker();
  const msgs = (AS.conv && AS.conv.messages) || [];
  if (s.model && msgs.length && asModelValue().join("::") !== `${s.provider}::${s.model}`) asCheckSwitch();
}

function asSessionSettings() {
  const [provider, model] = asModelValue();
  return { provider, model, mode: asMode() };
}

async function asEnsureConversation() {
  if (AS.conv && AS.conv.id) return AS.conv;
  AS.conv = await api("POST", `/api/projects/${state.project.id}/conversations`,
    { title: "Chat", settings: asSessionSettings() });
  AS.conv.messages = AS.conv.messages || [];
  return AS.conv;
}

// After a turn (or a branch change) the server's copy is the truth: ids,
// versions and branches. A reply that never reached it (an error before the
// stream, or a Stop it hasn't written yet) is kept from the local copy.
async function asSyncConversation(pending, cid) {
  if (!AS.conv || !AS.conv.id || (cid && AS.conv.id !== cid)) return;   // another session is open now
  let fresh;
  try { fresh = await api("GET", `/api/conversations/${AS.conv.id}`); } catch { return; }
  if (!AS.conv || AS.conv.id !== fresh.id) return;
  if (pending && !pending.live.id) {
    const last = fresh.messages[fresh.messages.length - 1];
    const saved = last && last.role === "assistant" && pending.parent && last.parent_id === pending.parent;
    if (!saved) {
      if (pending.user && !pending.user.id) fresh.messages.push(pending.user);
      fresh.messages.push(pending.live);
    }
  }
  AS.conv = fresh;
}

async function asRefreshConvList() {
  if (!state.project) return;
  try { AS.convs = await api("GET", `/api/projects/${state.project.id}/conversations`); } catch { /* keep */ }
  const cur = AS.conv && AS.convs.find((c) => c.id === AS.conv.id);
  if (cur) AS.conv.title = cur.title;   // the server titles a chat from its first message
  asRenderHeader();
}

async function asSearchConvs(q) {
  AS.convQuery = q;
  if (!state.project) return;
  try {
    AS.convs = await api("GET", `/api/projects/${state.project.id}/conversations${q ? "?q=" + encodeURIComponent(q) : ""}`);
  } catch { /* keep */ }
  if (AS.convQuery === q) asRenderConvList();
}

// ── model + mode ────────────────────────────────────────────────────────
function asModelValue() {
  const sel = $("#as-model");
  const v = (sel && sel.value) || "";
  const i = v.indexOf("::");
  return i < 0 ? [null, null] : [v.slice(0, i), v.slice(i + 2)];
}

function asRenderModelPicker(prefer) {
  const sel = $("#as-model");
  if (!sel) return;
  const usable = AS.providers.filter((p) => p.models && p.models.length);
  if (!usable.length) { sel.innerHTML = '<option value="">No model set up</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  // the open session's model, else the last one picked, else the default
  const sess = (AS.conv && AS.conv.settings) || {};
  const wants = [prefer, sess.model ? `${sess.provider}::${sess.model}` : null, asLS.get(AS_MODEL_KEY),
    AS.defaults.provider ? `${AS.defaults.provider}::${AS.defaults.model || ""}` : null].filter(Boolean);
  const ok = new Set(usable.filter((p) => p.has_key).flatMap((p) => p.models.map((m) => `${p.name}::${m}`)));
  const want = wants.find((w) => ok.has(w));
  sel.innerHTML = usable.map((p) => `<optgroup label="${esc(p.name)}${p.has_key ? "" : " — no API key"}">` +
    p.models.map((m) => {
      const v = `${p.name}::${m}`;
      return `<option value="${esc(v)}"${v === want ? " selected" : ""}${p.has_key ? "" : " disabled"}>${esc(m)}</option>`;
    }).join("") + "</optgroup>").join("");
  if (!want) {
    const first = sel.querySelector("option:not([disabled])");
    if (first) first.selected = true;
  }
  sel.title = sel.value ? `Model: ${sel.value.replace("::", " · ")}` : "No usable model";
}

// ── model switch on a session ───────────────────────────────────────────
async function asModelChanged() {
  const sel = $("#as-model");
  asLS.set(AS_MODEL_KEY, sel.value);
  sel.title = `Model: ${sel.value.replace("::", " · ")}`;
  if (!AS.conv || !AS.conv.id) return;
  if (!(AS.conv.messages || []).length) return asSaveSessionSettings(asSessionSettings());
  await asCheckSwitch();
}

async function asSaveSessionSettings(settings) {
  if (!AS.conv || !AS.conv.id) return;
  try {
    const r = await api("PATCH", `/api/conversations/${AS.conv.id}`, { settings });
    AS.conv.settings = r.settings;
  } catch { /* the next turn records it anyway */ }
}

async function asCheckSwitch() {
  const [provider, model] = asModelValue();
  if (!provider || !AS.conv || !AS.conv.id) return asHideSwitch();
  let r;
  try { r = await api("POST", `/api/conversations/${AS.conv.id}/switch-check`, { provider, model, mode: asMode() }); }
  catch { return; }
  if (asModelValue().join("::") !== `${provider}::${model}`) return;   // changed again meanwhile
  if (r.same) return asHideSwitch();
  AS.switch = r;
  asRenderSwitch();
}

function asHideSwitch() {
  AS.switch = null;
  const box = $("#as-switch");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

function asRenderSwitch() {
  const box = $("#as-switch"), r = AS.switch;
  if (!box || !r) return;
  const from = r.from.model, to = r.to.model;
  const items = r.warnings.map((w) => `<li class="${w.level === "info" ? "info" : "warn"}" data-kind="${esc(w.kind)}">${esc(w.text)}</li>`).join("");
  box.innerHTML = `<div class="as-switch-head">${AS_ICON.warn}<span>${r.from.available
      ? `Switch this session from <b>${esc(from)}</b> to <b>${esc(to)}</b>?`
      : `This session ran on <b>${esc(from)}</b>, which isn't available. Continue on <b>${esc(to)}</b>?`}</span></div>
    <ul class="as-switch-list">${items}</ul>
    <div class="as-switch-actions">
      <button class="btn-small btn-primary" data-switch="apply">Switch to ${esc(to)}</button>
      <button class="btn-small btn-secondary" data-switch="split" title="Copy this conversation into a new session that uses ${esc(to)}">New session on ${esc(to)}</button>
      ${r.from.available ? `<button class="btn-small btn-secondary" data-switch="keep">Keep ${esc(from)}</button>` : ""}
    </div>`;
  box.hidden = false;
}

async function asSwitchAction(kind) {
  const r = AS.switch;
  if (!r || !AS.conv) return;
  if (kind === "keep") {
    asRenderModelPicker(`${r.from.provider}::${r.from.model}`);
    asLS.set(AS_MODEL_KEY, $("#as-model").value);
  } else if (kind === "apply") {
    await asSaveSessionSettings({ provider: r.to.provider, model: r.to.model });
  } else if (kind === "split") {
    try {
      AS.conv = await api("POST", `/api/conversations/${AS.conv.id}/fork`,
        { settings: { provider: r.to.provider, model: r.to.model, mode: asMode() } });
    } catch (e) { alert(e.message); return; }
    asApplySession();
    asRender();
    asRefreshConvList();
  }
  asHideSwitch();
}

function asMode() {
  if (AS.mode === "agent" || AS.mode === "chat") return AS.mode;
  const saved = asLS.get(AS_MODE_KEY);
  if (saved === "agent" || saved === "chat") return saved;
  return (AS.settings && AS.settings.default_mode) || "agent";
}

function asRenderMode() {
  const m = asMode();
  document.querySelectorAll(".as-mode [data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === m);
    b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  });
}

function asUsable() {
  return AS.providers.some((p) => p.has_key && p.models && p.models.length);
}

// ── context chips ───────────────────────────────────────────────────────
function asSelection() {
  const ta = $("#source");
  if (!ta || !state.activeFile || isBinary(state.activeFile) || $("#code-wrap").hidden) return null;
  const [a, b] = [ta.selectionStart, ta.selectionEnd];
  if (b <= a) return null;
  const text = ta.value.slice(a, b);
  if (!text.trim() || text === AS.ignoredSel) return null;
  const first = ta.value.slice(0, a).split("\n").length;
  return { text, lines: [first, first + text.split("\n").length - 1] };
}

function asMentions(text) {
  const out = [];
  for (const tok of (text.match(/(?:^|\s)@([^\s,;]+)/g) || []).map((t) => t.trim().slice(1))) {
    const meta = (state.files || []).find((f) => !f.is_binary && (f.path === tok || f.path.split("/").pop() === tok));
    if (meta && !out.includes(meta.path)) out.push(meta.path);
  }
  return out;
}

function asRenderChips() {
  const box = $("#as-chips");
  if (!box) return;
  const chips = [];
  if (state.activeFile && !isBinary(state.activeFile)) {
    chips.push(`<button class="as-chip${AS.useFile ? "" : " off"}" data-chip="file" title="${AS.useFile ? "The assistant sees which file is open (click to leave it out)" : "Left out — click to include the open file"}">${AS_ICON.file}${esc(state.activeFile.split("/").pop())}</button>`);
  }
  const sel = asSelection();
  if (sel) {
    chips.push(`<span class="as-chip sel" title="The selected text is sent with your message">${AS_ICON.sel}Lines ${sel.lines[0]}${sel.lines[1] !== sel.lines[0] ? "–" + sel.lines[1] : ""}<button class="as-chip-x" data-chip="sel" title="Don't send the selection" aria-label="Don't send the selection">${AS_ICON.x}</button></span>`);
  }
  for (const p of asMentions($("#ask-input").value)) chips.push(`<span class="as-chip at">@${esc(p)}</span>`);
  box.innerHTML = chips.join("");
  box.hidden = !chips.length;
}

// ── rendering ───────────────────────────────────────────────────────────
function asRender() {
  asRenderHeader();
  asRenderTranscript();
  asRenderChips();
  asRenderSend();
}

function asRenderHeader() {
  const t = $("#as-convo-title");
  if (t) t.textContent = (AS.conv && AS.conv.title) || "New chat";
  const mode = $("#as-convo-mode");
  if (mode) { mode.innerHTML = AS_ICON[asMode()]; mode.title = asMode() === "agent" ? "Agent session" : "Chat session"; }
  const b = $("#as-branch-btn");
  if (b) {
    const n = (AS.conv && AS.conv.branches && AS.conv.branches.length) || 0;
    b.hidden = n < 2;
    $("#as-branch-n").textContent = String(n);
    b.title = `${n} branches in this session — pick one`;
  }
}

function asRenderSend() {
  const b = $("#ask-send");
  if (!b) return;
  b.textContent = AS.running ? "Stop" : "Send";
  b.classList.toggle("stop", !!AS.running);
  b.title = AS.running ? "Stop (Esc)" : "Send (Enter)";
}

function asRenderEmpty() {
  if (!AS.conv || !(AS.conv.messages || []).length) asRenderTranscript();
}

function asRenderTranscript() {
  const slot = $("#assistant-slot");
  if (!slot) return;
  const msgs = (AS.conv && AS.conv.messages) || [];
  if (!msgs.length) {
    const setup = asUsable() ? "" :
      `<div class="as-setup">No model is set up yet. <button class="tg-link" data-open-settings>Add a provider and API key</button> in Assistant settings.</div>`;
    const sk = AS.skills.slice(0, 6).map((s) =>
      `<button class="as-suggest" data-skill="${esc(s.name)}"><b>/${esc(s.name)}</b><span>${esc(s.description || s.title)}</span></button>`).join("");
    slot.innerHTML = `<div class="as-empty"><div class="as-empty-title">tex-copilot</div>
      <p>Ask about your paper or ask for a change. In <b>Agent</b> mode it reads the project, runs the converter and proposes edits you review before anything changes.</p>
      ${setup}<div class="as-suggests">${sk}</div></div>`;
    return;
  }
  slot.innerHTML = "";
  const src = AS.conv.forked_from;
  if (src && src.conversation_id) {
    const el = document.createElement("div");
    el.className = "as-forked";
    el.innerHTML = `${AS_ICON.split}<span>Split from <button class="tg-link" data-open-conv="${esc(src.conversation_id)}">${esc(src.title || "a session")}</button> · ${src.messages} message${src.messages === 1 ? "" : "s"} copied</span>`;
    slot.appendChild(el);
  }
  msgs.forEach((m, i) => slot.appendChild(asMsgNode(m, i, msgs)));
  slot.scrollTop = slot.scrollHeight;
}

// "‹ 2/3 ›" on a message that has other versions (edits, regenerations).
function asBranchNav(m) {
  const b = m.branch;
  if (!b || !m.id) return "";
  const off = AS.running ? " disabled" : "";
  return `<span class="as-branch" title="Versions of this message">` +
    `<button class="as-act" data-act="prev" aria-label="Previous version"${b.index === 0 ? " disabled" : off}>‹</button>` +
    `<span class="as-branch-n">${b.index + 1}/${b.count}</span>` +
    `<button class="as-act" data-act="next" aria-label="Next version"${b.index === b.count - 1 ? " disabled" : off}>›</button></span>`;
}

function asStepLine(s) {
  const state_ = s.ok === undefined ? "run" : s.ok ? "ok" : "bad";
  const icon = state_ === "run" ? AS_ICON.spin : state_ === "ok" ? AS_ICON.ok : AS_ICON.bad;
  const label = TOOL_LABEL[s.name] || s.name;
  const detail = s.summary || (s.args && (s.args.path || s.args.query)) || "";
  return `<div class="as-step ${state_}" title="${esc(JSON.stringify(s.args || {}))}"><span class="as-step-ic">${icon}</span>` +
    `<span class="as-step-name">${esc(label)}</span>${detail ? `<span class="as-step-detail">${esc(detail)}</span>` : ""}</div>`;
}

function asSteps(steps, live) {
  if (!steps || !steps.length) return "";
  const lines = steps.map(asStepLine).join("");
  if (live || steps.length <= 3) return `<div class="as-steps">${lines}</div>`;
  const bad = steps.filter((s) => s.ok === false).length;
  return `<details class="as-steps as-steps-fold"><summary>Used ${steps.length} tools${bad ? ` · ${bad} failed` : ""}</summary>${lines}</details>`;
}

function asDiffRows(before, after) {
  const d = lineDiff(before || "", after || "");
  const keep = new Array(d.length).fill(false);
  d.forEach((row, i) => { if (row.type !== "ctx") for (let k = Math.max(0, i - 2); k <= Math.min(d.length - 1, i + 2); k++) keep[k] = true; });
  let out = "", skipped = false, add = 0, del = 0;
  d.forEach((row, i) => {
    if (row.type === "add") add++;
    if (row.type === "del") del++;
    if (!keep[i]) { if (!skipped) out += '<div class="dl gap">⋯</div>'; skipped = true; return; }
    skipped = false;
    const sym = row.type === "add" ? "+" : row.type === "del" ? "−" : " ";
    out += `<div class="dl ${row.type}"><span class="dg">${sym}</span>${esc(row.text) || "&nbsp;"}</div>`;
  });
  return { html: out, add, del };
}

const CHANGE_STATUS = { pending: "", applied: "Applied", rejected: "Rejected", conflict: "Changed since — not applied" };

function asChanges(m) {
  const ch = (m.meta && m.meta.changes) || [];
  if (!ch.length) return "";
  const pending = ch.filter((c) => c.status === "pending" || c.status === "conflict").length;
  const files = ch.map((c) => {
    const d = asDiffRows(c.before, c.after);
    const st = c.status || "pending";
    const actions = (st === "pending" || st === "conflict")
      ? `<button class="btn-small btn-secondary" data-change="apply" data-path="${esc(c.path)}">${st === "conflict" ? "Overwrite" : "Apply"}</button>` +
        `<button class="btn-small btn-secondary" data-change="reject" data-path="${esc(c.path)}">Reject</button>`
      : "";
    return `<details class="as-change st-${st}"${ch.length <= 2 && st === "pending" ? " open" : ""}>
      <summary>${FileIcons.forPath(c.path, 13)}<span class="as-change-path">${esc(c.path)}</span>${c.before == null ? '<span class="as-badge new">new</span>' : ""}
        <span class="as-change-stat"><span class="add">+${d.add}</span> <span class="del">−${d.del}</span></span>
        ${CHANGE_STATUS[st] ? `<span class="as-badge st">${esc(CHANGE_STATUS[st])}</span>` : ""}<span class="spacer"></span>${actions}</summary>
      <div class="diff-body">${d.html}</div></details>`;
  }).join("");
  const head = pending
    ? `<div class="as-changes-head"><b>Proposed changes</b><span class="muted">${ch.length} file${ch.length === 1 ? "" : "s"} · nothing is changed until you apply</span><span class="spacer"></span>` +
      `<button class="btn-small btn-primary" data-change="apply">Apply all</button><button class="btn-small btn-secondary" data-change="reject">Reject all</button></div>`
    : `<div class="as-changes-head"><b>Changes</b><span class="muted">${ch.filter((c) => c.status === "applied").length} applied</span></div>`;
  return `<div class="as-changes">${head}${files}</div>`;
}

function asFmtTokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function asMsgNode(m, i, msgs) {
  const el = document.createElement("div");
  el.className = `as-msg ${m.role}${m.live ? " live" : ""}`;
  el.dataset.i = i;
  if (m.role === "user") {
    const skill = m.skill ? `<span class="chat-skill">/${esc(m.skill)}</span> ` : "";
    const text = m.skill && m.content.startsWith("/" + m.skill) ? m.content.slice(m.skill.length + 1).trim() : m.content;
    el.innerHTML = `<div class="as-bubble">${skill}${esc(text)}</div>` + asBranchNav(m) +
      (m.id && !AS.running ? `<div class="as-actions"><button class="as-act" data-act="edit" title="Edit and resend (keeps this version as a branch)">${AS_ICON.edit}</button>` +
        `<button class="as-act" data-act="copy" title="Copy">${AS_ICON.copy}</button>` +
        `<button class="as-act" data-act="split" title="Split: a new session with the conversation up to here">${AS_ICON.split}</button>` +
        `<button class="as-act" data-act="delete" title="Delete this message and its replies">${AS_ICON.trash}</button></div>` : "");
    return el;
  }
  const meta = m.meta || {};
  const think = meta.reasoning ? `<details class="as-think"${m.live && !m.content ? " open" : ""}><summary>Thinking</summary><div>${esc(meta.reasoning)}</div></details>` : "";
  const notices = (meta.notices || []).map((t) => `<div class="as-notice">${esc(t)}</div>`).join("");
  const body = m.content ? `<div class="as-body md">${MiniMarkdown.render(m.content.replace(/\n\n_\(Proposed edits to: [^\n]*\)_$/, ""))}</div>` :
    (m.live && !(meta.steps || []).length && !meta.reasoning ? `<div class="as-body as-typing">${AS_ICON.spin} Thinking…</div>` : "");
  const err = meta.error ? `<div class="as-error">${esc(meta.error)}${!m.live ? ` <button class="tg-link" data-act="retry">Retry</button>` : ""}</div>` : "";
  const stopped = meta.stopped ? '<div class="as-notice">Stopped.</div>' : "";
  const bits = [];
  if (meta.model) bits.push(esc(meta.model));
  if (meta.usage) bits.push(`${asFmtTokens(meta.usage.input + meta.usage.output)} tokens`);
  if (meta.ms) bits.push(`${(meta.ms / 1000).toFixed(1)} s`);
  if (meta.mode === "chat") bits.push("chat");
  const foot = m.live ? "" : `<div class="as-foot">${asBranchNav(m)}<span class="as-meta-line">${bits.join(" · ")}</span><span class="spacer"></span>` +
    (m.content ? `<button class="as-act" data-act="copy" title="Copy the reply">${AS_ICON.copy}</button>` : "") +
    (!AS.running && m.id ? `<button class="as-act" data-act="split" title="Split: a new session with the conversation up to here">${AS_ICON.split}</button>` : "") +
    (!AS.running ? `<button class="as-act" data-act="regen" title="Regenerate (keeps this reply as a version)">${AS_ICON.redo}</button>` : "") + "</div>";
  // a divider where the branch moves to another model
  let prevModel = null;
  for (let k = i - 1; k >= 0 && !prevModel; k--) if (msgs[k].role === "assistant") prevModel = (msgs[k].meta || {}).model || null;
  if (!prevModel && meta.switched_from) prevModel = meta.switched_from.model;
  const sw = prevModel && meta.model && prevModel !== meta.model
    ? `<div class="as-switched">Model changed: <b>${esc(prevModel)}</b> → <b>${esc(meta.model)}</b></div>` : "";
  el.innerHTML = sw + think + asSteps(meta.steps, m.live) + body + notices + stopped + err + asChanges(m) + foot;
  asDecorateCode(el);
  return el;
}

// Code blocks get a header with the language and Copy / Insert buttons.
function asDecorateCode(root) {
  root.querySelectorAll("pre.md-code").forEach((pre) => {
    if (pre.previousElementSibling && pre.previousElementSibling.classList.contains("md-code-head")) return;
    const head = document.createElement("div");
    head.className = "md-code-head";
    const canInsert = state.activeFile && !isBinary(state.activeFile);
    head.innerHTML = `<span>${esc(pre.dataset.lang || "code")}</span><span class="spacer"></span>` +
      `<button class="as-act" data-code="copy" title="Copy">${AS_ICON.copy}</button>` +
      (canInsert ? `<button class="as-act" data-code="insert" title="Insert at the editor's cursor">${AS_ICON.insert}</button>` : "");
    pre.before(head);
  });
}

function asPaintLive() {
  cancelAnimationFrame(AS.frame);
  AS.frame = requestAnimationFrame(() => {
    const slot = $("#assistant-slot");
    const msgs = AS.conv.messages;
    const i = msgs.length - 1;
    const old = slot.querySelector(`.as-msg[data-i="${i}"]`);
    if (!old) return asRenderTranscript();
    const nearBottom = slot.scrollHeight - slot.scrollTop - slot.clientHeight < 80;
    old.replaceWith(asMsgNode(msgs[i], i, msgs));
    if (nearBottom) slot.scrollTop = slot.scrollHeight;
  });
}

// ── sending ─────────────────────────────────────────────────────────────
function asParse(text) {
  const m = text.match(/^\/([\w-]+)\s*([\s\S]*)$/);
  if (m && AS.skills.some((s) => s.name === m[1])) return { skill: m[1], rest: m[2].trim() };
  return { skill: null, rest: text };
}

// opts.parent_id: answer under this message ("root" = a new first message);
// opts.regenerate: reply again to this saved user message.
async function asSend(override, opts = {}) {
  if (AS.running) return asStop();
  const input = $("#ask-input");
  const raw = opts.regenerate ? "" : (override != null ? override : input.value).trim();
  if ((!raw && !opts.regenerate) || !state.project) return;
  if (!asUsable()) { asOpenSettings("providers"); return; }
  const { skill, rest } = opts.regenerate ? { skill: null, rest: "" } : asParse(raw);
  asHideSwitch();   // sending on the new model is choosing it
  const [provider, model] = asModelValue();
  if (state.dirty && state.activeFile) { try { await saveActive(false); } catch { /* sent anyway */ } }
  let conv;
  try { conv = await asEnsureConversation(); } catch (e) { alert("Could not start a conversation: " + e.message); return; }
  const ta = $("#source");
  const sel = asSelection();
  const file = AS.useFile && state.activeFile && !isBinary(state.activeFile) ? state.activeFile : null;
  const body = {
    content: rest, skill, provider, model,
    mode: skill ? null : asMode(),
    active_file: file,
    selection: file && sel ? sel.text : null,
    selection_lines: file && sel ? sel.lines : null,
    cursor_line: file ? ta.value.slice(0, ta.selectionStart).split("\n").length : null,
    files: asMentions(raw),
    parent_id: opts.parent_id || null,
    regenerate: opts.regenerate || null,
  };
  conv.messages = conv.messages || [];
  const userMsg = opts.regenerate ? null : { role: "user", content: raw, skill };
  const live = { role: "assistant", content: "", meta: { steps: [], model }, live: true };
  if (userMsg) conv.messages.push(userMsg);
  conv.messages.push(live);
  if (override == null && !opts.regenerate) { input.value = ""; asAutoGrow(); }
  const controller = new AbortController();
  AS.running = { controller, live };
  asRender();
  await asStream(`/api/conversations/${conv.id}/agent`, body, controller, (ev) => {
    const meta = live.meta;
    switch (ev.type) {
      case "start":
        if (userMsg) Object.assign(userMsg, ev.user_message);
        meta.model = ev.model; meta.mode = ev.mode;
        if (ev.switched_from) meta.switched_from = ev.switched_from;
        break;
      case "text": live.content += ev.text; break;
      case "reasoning": meta.reasoning = (meta.reasoning || "") + ev.text; break;
      case "tool_start": meta.steps.push({ id: ev.id, name: ev.name, args: ev.args }); break;
      case "tool_end": { const s = meta.steps.find((x) => x.id === ev.id); if (s) Object.assign(s, { ok: ev.ok, summary: ev.summary }); break; }
      case "notice": (meta.notices = meta.notices || []).push(ev.text); break;
      case "usage": meta.usage = { input: ev.input, output: ev.output }; break;
      case "changes": meta.changes = ev.changes; break;
      case "done": case "error": {
        const saved = ev.message || { ...live, meta: { ...meta, error: ev.error } };
        Object.assign(live, saved, { live: false });
        if (ev.type === "error" && !saved.meta.error) live.meta.error = ev.error;
        break;
      }
    }
    asPaintLive();
  }, (err) => {
    live.live = false;
    live.meta.error = err;
  });
  const stopped = controller.signal.aborted;
  if (stopped) { live.live = false; live.meta.stopped = true; }
  AS.running = null;
  asRender();
  // a stopped turn is written by the server as its stream closes
  if (stopped) await new Promise((r) => setTimeout(r, 400));
  await asSyncConversation({ live, user: userMsg, parent: userMsg ? userMsg.id : opts.regenerate }, conv.id);
  asRender();
  asRefreshConvList();
}

function asStop() {
  if (AS.running) AS.running.controller.abort();
}

async function asStream(url, payload, controller, onEvent, onError) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) { if (!controller.signal.aborted) onError(e.message); return; }
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    onError(typeof j.detail === "string" ? j.detail : `the assistant failed (${res.status})`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        onEvent(ev);
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) onError(e.message);
  }
}

// ── message actions ─────────────────────────────────────────────────────
// Regenerate adds another version of the reply; the old one stays a branch.
function asRegenerate(i) {
  const msgs = AS.conv.messages;
  let u = i - 1;
  while (u >= 0 && msgs[u].role !== "user") u--;
  if (u < 0) return;
  const user = msgs[u];
  if (!user.id) {   // never reached the server: send it again
    const parent = u > 0 ? msgs[u - 1].id : null;
    msgs.splice(u);
    return asSend(user.content, { parent_id: parent || "root" });
  }
  msgs.splice(u + 1);
  asSend(null, { regenerate: user.id });
}

// Show another version of message i (and the newest branch below it).
async function asPickVersion(i, step) {
  const m = AS.conv.messages[i];
  const b = m && m.branch;
  if (!b || AS.running) return;
  const target = b.ids[b.index + step];
  if (!target) return;
  await asSelectBranch(target);
}

async function asSelectBranch(mid) {
  try { AS.conv = await api("POST", `/api/conversations/${AS.conv.id}/select`, { message_id: mid }); }
  catch (e) { alert(e.message); return; }
  asRender();
}

// Split: a new session holding the conversation up to message i.
async function asSplitAt(i) {
  const m = AS.conv.messages[i];
  if (!m || !m.id || AS.running) return;
  let conv;
  try { conv = await api("POST", `/api/conversations/${AS.conv.id}/fork`, { message_id: m.id, settings: asSessionSettings() }); }
  catch (e) { alert(e.message); return; }
  AS.conv = conv;
  asApplySession();
  asRender();
  asRefreshConvList();
  $("#ask-input").focus();
}

async function asDeleteMessage(i) {
  const m = AS.conv.messages[i];
  if (!m || !m.id || AS.running) return;
  const below = AS.conv.messages.length - i - 1;
  if (!confirm(below ? `Delete this message and the ${below} after it (in every branch below it)?` : "Delete this message?")) return;
  try { AS.conv = (await api("DELETE", `/api/conversations/${AS.conv.id}/messages/${m.id}`)).conversation; }
  catch (e) { alert(e.message); return; }
  asRender();
  asRefreshConvList();
}

function asEditMessage(i, node) {
  const m = AS.conv.messages[i];
  const bubble = node.querySelector(".as-bubble");
  const box = document.createElement("div");
  box.className = "as-edit";
  box.innerHTML = `<textarea rows="3"></textarea><div class="as-edit-actions"><button class="btn-small btn-secondary" data-edit="cancel">Cancel</button><button class="btn-small btn-primary" data-edit="send">Send</button></div>`;
  const ta = box.querySelector("textarea");
  ta.value = m.content;
  bubble.replaceWith(box);
  node.querySelector(".as-actions")?.remove();
  ta.focus();
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); box.querySelector('[data-edit="send"]').click(); }
    if (e.key === "Escape") { e.preventDefault(); asRenderTranscript(); }
  });
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-edit]");
    if (!b) return;
    if (b.dataset.edit === "cancel") return asRenderTranscript();
    const text = ta.value.trim();
    if (!text) return;
    // the edit becomes a new version next to the original, which stays a branch
    const msgs = AS.conv.messages;
    const parent = m.parent_id || (i > 0 ? msgs[i - 1].id : null);
    msgs.splice(i);
    asSend(text, { parent_id: parent || "root" });
  });
}

async function asCopy(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea");
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    t.remove();
  }
  if (btn) { btn.classList.add("done"); setTimeout(() => btn.classList.remove("done"), 1000); }
}

function asInsertCode(code) {
  if (!state.activeFile || isBinary(state.activeFile)) return;
  const ta = $("#source");
  const [a, b] = state.edSel || [ta.selectionStart, ta.selectionEnd];
  edInsert(a, b, code);
}

async function asActOnChanges(i, action, path) {
  const m = AS.conv.messages[i];
  if (!m || !m.id) return;
  if (action === "apply" && state.dirty && state.activeFile) { try { await saveActive(false); } catch { /* conflict check covers it */ } }
  let r;
  try {
    r = await api("POST", `/api/conversations/${AS.conv.id}/messages/${m.id}/changes`,
      { action, paths: path ? [path] : null });
  } catch (e) { alert("Could not update the changes: " + e.message); return; }
  m.meta.changes = r.changes;
  for (const w of r.written || []) {
    state.contents[w.path] = w.content;
    if (!(state.files || []).some((f) => f.path === w.path)) state.files.push({ path: w.path, is_binary: false, size: w.content.length });
    if (w.path === state.activeFile) {
      const ta = $("#source");
      const keep = ta.scrollTop;
      ta.value = w.content;
      updateHighlight();
      ta.scrollTop = keep; syncHighlightScroll();
      setDirty(false);
    }
  }
  if ((r.written || []).length) { renderFiles(); markPreviewStale(); }
  if (r.changes.some((c) => c.status === "conflict") && action === "apply") {
    const conflicted = r.changes.filter((c) => c.status === "conflict").map((c) => c.path);
    if (path && conflicted.includes(path) && confirm(`${path} changed after the assistant read it. Overwrite it with the proposed version anyway?`)) {
      await asForceApply(m, path);
    }
  }
  asRenderTranscript();
}

// Overwrite one conflicted file with the proposal (the user confirmed).
async function asForceApply(m, path) {
  const c = m.meta.changes.find((x) => x.path === path);
  if (!c) return;
  try {
    await api("PUT", `/api/projects/${state.project.id}/files/${path}`, { content: c.after });
  } catch (e) { alert(e.message); return; }
  state.contents[path] = c.after;
  if (path === state.activeFile) { $("#source").value = c.after; updateHighlight(); setDirty(false); }
  c.before = c.after;   // now matches the project, so the server records it as applied
  await api("POST", `/api/conversations/${AS.conv.id}/messages/${m.id}/changes`, { action: "apply", paths: [path] })
    .then((r) => { m.meta.changes = r.changes; }).catch(() => {});
  renderFiles(); markPreviewStale();
}

// ── composer ────────────────────────────────────────────────────────────
function asAutoGrow() {
  const ta = $("#ask-input");
  const cap = Math.max(96, Math.round(window.innerHeight * 0.3));
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight + 2, cap) + "px";
}

function asToken(input) {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const slash = before.match(/^\/([\w-]*)$/);
  if (slash) return { kind: "/", query: slash[1], start: 0, end: pos };
  const at = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (at) return { kind: "@", query: at[1], start: pos - at[1].length - 1, end: pos };
  return null;
}

function asAcUpdate() {
  const input = $("#ask-input");
  const tok = asToken(input);
  if (!tok) return asAcClose();
  const q = tok.query.toLowerCase();
  const items = tok.kind === "/"
    ? AS.skills.filter((s) => s.name.startsWith(q)).map((s) => ({ label: "/" + s.name, insert: "/" + s.name + " ", hint: s.description || s.title }))
    : (state.files || []).filter((f) => !f.is_binary && f.path.toLowerCase().includes(q)).slice(0, 8)
      .map((f) => ({ label: f.path, insert: "@" + f.path + " ", hint: "file" }));
  if (!items.length) return asAcClose();
  AS.ac = { items, index: 0, start: tok.start, end: tok.end };
  asAcRender();
}

function asAcRender() {
  const menu = $("#ac-menu");
  if (!AS.ac) { menu.hidden = true; return; }
  menu.innerHTML = AS.ac.items.map((it, i) =>
    `<div class="ac-item${i === AS.ac.index ? " active" : ""}" data-i="${i}"><span class="ac-label">${esc(it.label)}</span><span class="ac-hint">${esc(it.hint)}</span></div>`).join("");
  menu.hidden = false;
}

function asAcAccept(i) {
  const ac = AS.ac;
  if (!ac) return;
  const input = $("#ask-input");
  const it = ac.items[i];
  input.value = input.value.slice(0, ac.start) + it.insert + input.value.slice(ac.end);
  const caret = ac.start + it.insert.length;
  input.setSelectionRange(caret, caret);
  asAcClose();
  input.focus();
  asRenderChips();
}

function asAcClose() { AS.ac = null; const m = $("#ac-menu"); if (m) m.hidden = true; }

function asKeydown(e) {
  if (e.isComposing) return;
  const ac = AS.ac;
  if (ac) {
    if (e.key === "ArrowDown") { e.preventDefault(); ac.index = (ac.index + 1) % ac.items.length; return asAcRender(); }
    if (e.key === "ArrowUp") { e.preventDefault(); ac.index = (ac.index - 1 + ac.items.length) % ac.items.length; return asAcRender(); }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return asAcAccept(ac.index); }
    if (e.key === "Escape") { e.preventDefault(); return asAcClose(); }
  }
  if (e.key === "Escape" && AS.running) { e.preventDefault(); return asStop(); }
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); asSend(); }
}

function asFillPlaceholders(body) {
  const sel = asSelection();
  return body.replace(/\{file\}/g, state.activeFile || "the open file")
    .replace(/\{selection\}/g, sel ? sel.text : "the selected text");
}

function asInsertIntoComposer(text) {
  const input = $("#ask-input");
  const [a, b] = [input.selectionStart, input.selectionEnd];
  input.value = input.value.slice(0, a) + text + input.value.slice(b);
  input.focus();
  input.setSelectionRange(a + text.length, a + text.length);
  asAutoGrow(); asRenderChips();
}

// ── menus (conversations, prompts) ──────────────────────────────────────
function asMenu(menuSel, btnSel, open) {
  const menu = $(menuSel), btn = $(btnSel);
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
}

// The sessions manager: search, new, and per session open / pin / rename /
// duplicate / export / delete.
function asRenderConvMenu() {
  const menu = $("#as-convo-menu");
  if (!menu.querySelector(".as-convo-search")) {
    menu.innerHTML = `<div class="as-convo-tools">
        <input type="search" class="as-convo-search" placeholder="Search sessions…" aria-label="Search sessions">
        <button class="btn-small btn-primary" data-conv-new title="Start a new session with the model and mode below">+ New</button>
      </div><div class="as-convo-list"></div>`;
  }
  const q = menu.querySelector(".as-convo-search");
  if (q.value !== AS.convQuery) q.value = AS.convQuery;
  asRenderConvList();
}

function asRenderConvList() {
  const list = $("#as-convo-menu .as-convo-list");
  if (!list) return;
  const cur = AS.conv && AS.conv.id;
  const rows = AS.convs.map((c) => {
    const s = c.settings || {};
    const mode = s.mode === "chat" ? "chat" : "agent";
    const sub = [s.model, `${c.message_count} message${c.message_count === 1 ? "" : "s"}`,
      c.branch_count > 1 ? `${c.branch_count} branches` : null, relTime(c.updated_at)].filter(Boolean).join(" · ");
    return `<div class="as-menu-row as-sess${c.id === cur ? " current" : ""}${c.pinned ? " pinned" : ""}" data-conv="${esc(c.id)}" role="menuitem" tabindex="-1" title="${esc(c.preview || c.title)}">
      <span class="as-sess-mode ${mode}" title="${mode === "agent" ? "Agent session" : "Chat session"}">${AS_ICON[mode]}</span>
      <span class="as-sess-main"><span class="as-menu-title">${esc(c.title)}</span>
        <span class="as-menu-sub">${c.forked_from ? AS_ICON.split + " " : ""}${esc(sub)}</span></span>
      <button class="as-act${c.pinned ? " on" : ""}" data-conv-act="pin" title="${c.pinned ? "Unpin" : "Pin to the top"}" aria-pressed="${c.pinned}">${AS_ICON.pin}</button>
      <button class="as-act" data-conv-act="rename" title="Rename">${AS_ICON.edit}</button>
      <button class="as-act" data-conv-act="duplicate" title="Duplicate">${AS_ICON.dup}</button>
      <button class="as-act" data-conv-act="export" title="Export as Markdown">${AS_ICON.down}</button>
      <button class="as-act" data-conv-act="delete" title="Delete">${AS_ICON.trash}</button></div>`;
  }).join("");
  list.innerHTML = rows || `<div class="as-menu-empty">${AS.convQuery ? "No session matches." : "No earlier sessions in this project."}</div>`;
}

async function asConvAction(id, act) {
  const c = AS.convs.find((x) => x.id === id);
  if (act === "rename") {
    const title = await modal("Rename session", "Title", c ? c.title : "");
    if (!title || !title.trim()) return;
    await api("PATCH", `/api/conversations/${id}`, { title: title.trim() }).catch((err) => alert(err.message));
    if (AS.conv && AS.conv.id === id) AS.conv.title = title.trim();
  } else if (act === "pin") {
    await api("PATCH", `/api/conversations/${id}`, { pinned: !(c && c.pinned) }).catch((err) => alert(err.message));
  } else if (act === "duplicate") {
    if (AS.running) return;
    try { AS.conv = await api("POST", `/api/conversations/${id}/fork`, {}); } catch (err) { alert(err.message); return; }
    asApplySession(); asRender();
  } else if (act === "export") {
    return asExport(id, c ? c.title : "chat");
  } else if (act === "delete") {
    if (!confirm(`Delete the session “${c ? c.title : ""}”? This can't be undone.`)) return;
    await api("DELETE", `/api/conversations/${id}`).catch((err) => alert(err.message));
    if (AS.conv && AS.conv.id === id) { AS.conv = null; asApplySession(); asRender(); }
  }
  await asSearchConvs(AS.convQuery);
  asRenderHeader();
}

async function asExport(id, title) {
  let res;
  try { res = await fetch(`/api/conversations/${id}/export`, { headers: authHeaders() }); } catch (e) { alert(e.message); return; }
  if (!res.ok) { alert(`Export failed (${res.status})`); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = (title || "chat").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) + ".md";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function asRenderBranchMenu() {
  const menu = $("#as-branch-menu");
  const branches = ((AS.conv && AS.conv.branches) || []).slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  menu.innerHTML = `<div class="as-menu-head">Branches in this session</div>` + branches.map((b) =>
    `<button class="as-menu-item as-branch-row${b.current ? " current" : ""}" data-branch="${esc(b.head_id)}" role="menuitem">
      <span class="as-menu-title">${esc(b.label || "(empty)")}</span>
      ${b.reply ? `<span class="as-menu-sub as-branch-reply">↳ ${esc(b.reply)}</span>` : ""}
      <span class="as-menu-sub">${b.current ? "Showing · " : ""}${b.messages} message${b.messages === 1 ? "" : "s"} · ${esc(relTime(b.updated_at))}</span></button>`).join("");
}

function asRenderPromptsMenu() {
  const menu = $("#as-prompts-menu");
  const rows = AS.prompts.map((p) => `<button class="as-menu-item" data-prompt="${esc(p.id)}" role="menuitem" title="${esc(p.body.slice(0, 300))}">
      <span class="as-menu-title">${esc(p.title)}</span>${p.description ? `<span class="as-menu-sub">${esc(p.description)}</span>` : ""}</button>`).join("");
  menu.innerHTML = (rows || '<div class="as-menu-empty">No saved prompts yet.</div>') +
    `<button class="as-menu-new" data-open-settings="prompts" role="menuitem">Manage prompts…</button>`;
}

// ── settings dialog ─────────────────────────────────────────────────────
const SET = { tab: "providers", sel: null, skill: null, prompt: null };

async function asOpenSettings(tab) {
  await Promise.all([loadProvider(), loadSkills()]);
  SET.tab = tab || SET.tab;
  $("#as-settings").hidden = false;
  $("#as-set-ro").hidden = AS.canManage;
  asSetRender();
}

function asCloseSettings() {
  $("#as-settings").hidden = true;
  asRenderModelPicker(); asRenderMode(); asRenderEmpty();
}

function asSetRender() {
  document.querySelectorAll("#as-set-tabs [data-stab]").forEach((b) => b.classList.toggle("active", b.dataset.stab === SET.tab));
  const body = $("#as-set-body");
  if (SET.tab === "providers") body.innerHTML = asProvidersView();
  else if (SET.tab === "skills") body.innerHTML = asSkillsView();
  else if (SET.tab === "prompts") body.innerHTML = asPromptsView();
  else body.innerHTML = asBehaviourView();
  if (!AS.canManage) body.querySelectorAll("input, select, textarea, button[data-save], button[data-danger], button[data-new]")
    .forEach((el) => { el.disabled = true; });
}

function asField(label, control, hint) {
  return `<label class="as-f"><span class="as-f-label">${label}</span>${control}${hint ? `<span class="as-f-hint">${hint}</span>` : ""}</label>`;
}

function asProvidersView() {
  if (SET.sel !== "__new" && !AS.providers.some((p) => p.name === SET.sel)) {
    const inUse = asModelValue()[0] || AS.defaults.provider;
    SET.sel = AS.providers.some((p) => p.name === inUse) ? inUse : AS.providers[0] ? AS.providers[0].name : "__new";
  }
  const list = AS.providers.map((p) => `<button class="as-li${p.name === SET.sel ? " active" : ""}" data-pick="${esc(p.name)}">
      <span class="as-dot ${p.has_key ? "ok" : "off"}" title="${p.has_key ? "API key set" : "no API key"}"></span>
      <span class="as-li-main"><b>${esc(p.name)}</b><span>${esc(p.type === "claude" ? "Anthropic" : "OpenAI-compatible")} · ${p.models.length} model${p.models.length === 1 ? "" : "s"}${p.source === "config" ? " · config.toml" : ""}</span></span></button>`).join("");
  const presets = AS.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
  const def = AS.providers.filter((p) => p.models.length).map((p) => `<optgroup label="${esc(p.name)}">` +
    p.models.map((m) => `<option value="${esc(p.name + "::" + m)}"${AS.defaults.provider === p.name && AS.defaults.model === m ? " selected" : ""}>${esc(m)}</option>`).join("") + "</optgroup>").join("");
  return `<div class="as-set-top">${asField("Default model", `<select id="set-default">${def || "<option>—</option>"}</select>`, "Used for new chats unless you pick another in the chat.")}</div>
    <div class="as-split"><aside class="as-list">${list}
      <div class="as-add"><select id="set-preset" aria-label="Start from"><option value="">Add a provider…</option>${presets}<option value="__blank">Blank (OpenAI-compatible)</option></select></div></aside>
      <section class="as-form" id="set-form">${asProviderForm()}</section></div>`;
}

function asProviderForm() {
  const isNew = SET.sel === "__new";
  const p = isNew ? (SET.draft || { type: "openai", models: [], api_base: "", tools: true, enabled: true, source: "custom" })
    : AS.providers.find((x) => x.name === SET.sel);
  if (!p) return '<div class="muted">Add a provider to get started.</div>';
  const keyState = p.key_source === "stored" ? `A key is stored (encrypted)${p.key_hint ? ` · ends in <code>${esc(p.key_hint)}</code>` : ""}.`
    : p.key_source === "env" ? `Using the key in the environment variable <code>${esc(p.api_key_env || "")}</code>.`
    : p.key_source === "config" ? "Using the key written in config.toml."
    : '<span class="as-warn">No API key yet.</span>';
  const remote = AS.remoteModels[p.name] || [];
  const chips = (p.models || []).map((m) => `<span class="as-mchip">${esc(m)}<button data-rm-model="${esc(m)}" title="Remove" aria-label="Remove ${esc(m)}">${AS_ICON.x}</button></span>`).join("");
  const danger = isNew ? "" : p.source === "custom" ? `<button class="btn-secondary as-danger" data-danger="delete">Delete provider</button>`
    : p.overridden ? `<button class="btn-secondary" data-danger="reset" title="Drop the changes made here and use config.toml again">Reset to config.toml</button>` : "";
  return `
    ${isNew ? asField("Name", `<input id="pf-name" value="${esc(p.name || "")}" placeholder="e.g. openai, deepseek, my-vllm" spellcheck="false">`, "Lowercase letters, digits, . _ -") : `<h4 class="as-form-title">${esc(p.name)}${p.source === "config" ? ' <span class="as-badge">config.toml</span>' : ""}${p.overridden ? ' <span class="as-badge">edited here</span>' : ""}</h4>`}
    <div class="as-row2">
      ${asField("Type", `<select id="pf-type"><option value="openai"${p.type === "openai" ? " selected" : ""}>OpenAI-compatible</option><option value="claude"${p.type === "claude" ? " selected" : ""}>Anthropic (Claude)</option></select>`)}
      ${asField("API base URL", `<input id="pf-base" value="${esc(p.api_base || "")}" placeholder="https://api.example.com/v1" spellcheck="false">`)}
    </div>
    ${asField("Models", `<div class="as-models">${chips}<input id="pf-model-add" list="pf-remote" placeholder="${chips ? "Add a model…" : "Type a model name and press Enter"}" spellcheck="false"><datalist id="pf-remote">${remote.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></div>`,
      `Type the exact model id (e.g. <code>deepseek-flash</code>) and press Enter.${!isNew ? ' <button class="tg-link" data-fetch-models>Fetch the list from the provider</button>' : ""}${remote.length ? ` · ${remote.length} available (suggested as you type)` : ""}`)}
    ${asField("Default model", `<select id="pf-default">${(p.models || []).map((m) => `<option${m === p.model ? " selected" : ""}>${esc(m)}</option>`).join("") || "<option value=''>—</option>"}</select>`)}
    <div class="as-key">
      <div class="as-f-label">API key</div>
      <div class="as-key-state">${isNew ? "" : keyState}</div>
      <div class="as-key-row"><input id="pf-key" type="password" autocomplete="new-password" placeholder="${p.key_source === "stored" ? "Paste a new key to replace it" : "Paste the API key"}" spellcheck="false">
        ${p.key_source === "stored" ? '<button class="btn-small btn-secondary" data-clear-key>Remove stored key</button>' : ""}</div>
      <span class="as-f-hint">Stored encrypted on the server and never shown again or sent back to the browser. Or leave it empty and use an environment variable:</span>
      <input id="pf-env" value="${esc(p.api_key_env || "")}" placeholder="ENV_VAR_NAME (optional)" spellcheck="false">
    </div>
    <div class="as-checks">
      <label><input type="checkbox" id="pf-tools"${p.tools !== false ? " checked" : ""}> Supports tools (function calling) — needed for Agent mode</label>
      <label><input type="checkbox" id="pf-enabled"${p.enabled !== false ? " checked" : ""}> Enabled</label>
    </div>
    <div class="as-test" id="pf-test"></div>
    <div class="as-form-actions">${danger}<span class="spacer"></span>
      ${isNew ? "" : '<button class="btn-secondary" data-test>Test connection</button>'}
      <button class="btn-primary" data-save="provider">${isNew ? "Add provider" : "Save"}</button></div>`;
}

function asFormModels() {
  return [...document.querySelectorAll("#set-form .as-mchip")].map((c) => c.firstChild.textContent);
}

function asProviderPayload(isNew) {
  const body = {
    type: $("#pf-type").value,
    api_base: $("#pf-base").value.trim(),
    models: asFormModels(),
    default_model: $("#pf-default").value || null,
    tools: $("#pf-tools").checked,
    enabled: $("#pf-enabled").checked,
    api_key_env: $("#pf-env").value.trim(),
  };
  const key = $("#pf-key").value.trim();
  if (key) body.api_key = key;
  if (isNew) body.name = $("#pf-name").value.trim();
  return body;
}

async function asSaveProvider() {
  const isNew = SET.sel === "__new";
  const pending = $("#pf-model-add").value.trim();
  if (pending) asAddModelChip(pending);
  const body = asProviderPayload(isNew);
  try {
    const r = isNew ? await api("POST", "/api/providers", body) : await api("PATCH", `/api/providers/${SET.sel}`, body);
    SET.sel = r.name; SET.draft = null;
  } catch (e) { asTestLine(false, e.message); return; }
  await loadProvider();
  asSetRender();
  asTestLine(true, "Saved.");
}

function asTestLine(ok, text) {
  const box = $("#pf-test");
  if (box) box.innerHTML = `<span class="${ok ? "ok" : "bad"}">${ok ? AS_ICON.ok : AS_ICON.bad} ${esc(text)}</span>`;
}

function asAddModelChip(name) {
  name = name.trim();
  if (!name || /\s/.test(name) || asFormModels().includes(name)) return;
  const wrap = $("#set-form .as-models");
  const chip = document.createElement("span");
  chip.className = "as-mchip";
  chip.innerHTML = `${esc(name)}<button data-rm-model="${esc(name)}" title="Remove" aria-label="Remove ${esc(name)}">${AS_ICON.x}</button>`;
  wrap.insertBefore(chip, $("#pf-model-add"));
  const sel = $("#pf-default");
  if (![...sel.options].some((o) => o.value === name)) {
    if (sel.options.length === 1 && !sel.options[0].value) sel.innerHTML = "";
    sel.insertAdjacentHTML("beforeend", `<option>${esc(name)}</option>`);
  }
}

function asSkillsView() {
  const sel = SET.skill === "__new" ? null : AS.skills.find((s) => s.name === SET.skill) || AS.skills[0];
  if (SET.skill !== "__new") SET.skill = sel ? sel.name : null;
  const list = AS.skills.map((s) => `<button class="as-li${s.name === SET.skill ? " active" : ""}" data-pick-skill="${esc(s.name)}">
      <span class="as-li-main"><b>/${esc(s.name)}</b><span>${esc(s.description || s.title)}</span></span>${s.scope === "builtin" ? '<span class="as-badge">built-in</span>' : ""}</button>`).join("");
  const s = SET.skill === "__new" ? (SET.skillDraft || { name: "", title: "", description: "", mode: "agent", prompt: "", scope: "custom" }) : sel;
  const ro = s && s.scope === "builtin";
  const form = !s ? "" : `
    ${SET.skill === "__new" ? asField("Command", `<input id="sk-name" value="${esc(s.name)}" placeholder="e.g. shorten" spellcheck="false">`, "Run it with /name in the chat. Lowercase letters, digits and -.")
      : `<h4 class="as-form-title">/${esc(s.name)}${ro ? ' <span class="as-badge">built-in</span>' : ""}</h4>`}
    <div class="as-row2">${asField("Title", `<input id="sk-title" value="${esc(s.title || "")}"${ro ? " readonly" : ""}>`)}
      ${asField("Mode", `<select id="sk-mode"${ro ? " disabled" : ""}><option value="agent"${s.mode === "agent" ? " selected" : ""}>Agent (may read files and propose edits)</option><option value="chat"${s.mode === "chat" ? " selected" : ""}>Chat (answers only)</option></select>`)}</div>
    ${asField("Description", `<input id="sk-desc" value="${esc(s.description || "")}"${ro ? " readonly" : ""}>`, "Shown in the / menu.")}
    ${asField("Instructions", `<textarea id="sk-prompt" rows="9" spellcheck="false"${ro ? " readonly" : ""}>${esc(s.prompt || "")}</textarea>`,
      "Placeholders: <code>{selection}</code> the selected text (or the open file), <code>{file}</code> the open file, <code>{input}</code> what was typed after the command.")}
    <div class="as-form-actions">${ro ? "" : (SET.skill === "__new" ? "" : '<button class="btn-secondary as-danger" data-danger="skill">Delete</button>')}<span class="spacer"></span>
      ${ro ? '<button class="btn-secondary" data-new="dup-skill">Duplicate as a custom skill</button>' : `<button class="btn-primary" data-save="skill">${SET.skill === "__new" ? "Create skill" : "Save"}</button>`}</div>`;
  return `<div class="as-split"><aside class="as-list">${list}<div class="as-add"><button class="btn-secondary" data-new="skill">+ New skill</button></div></aside>
    <section class="as-form" id="set-form">${form}<div class="as-test" id="pf-test"></div></section></div>`;
}

function asPromptsView() {
  const sel = SET.prompt === "__new" ? null : AS.prompts.find((p) => p.id === SET.prompt) || AS.prompts[0];
  if (SET.prompt !== "__new") SET.prompt = sel ? sel.id : null;
  const list = AS.prompts.map((p) => `<button class="as-li${p.id === SET.prompt ? " active" : ""}" data-pick-prompt="${esc(p.id)}">
      <span class="as-li-main"><b>${esc(p.title)}</b><span>${esc(p.description || p.body.slice(0, 60))}</span></span></button>`).join("")
    || '<div class="as-menu-empty">No prompts yet.</div>';
  const p = SET.prompt === "__new" ? { title: "", description: "", body: "" } : sel;
  const form = !p ? '<div class="muted">Save prompts you use often; insert them from the bookmark button in the chat.</div>' : `
    ${asField("Title", `<input id="pr-title" value="${esc(p.title)}" placeholder="e.g. Reviewer 2">`)}
    ${asField("Description", `<input id="pr-desc" value="${esc(p.description || "")}">`)}
    ${asField("Prompt", `<textarea id="pr-body" rows="10" spellcheck="false">${esc(p.body)}</textarea>`,
      "Inserted into the message box. <code>{file}</code> and <code>{selection}</code> are filled in when you insert it.")}
    <div class="as-form-actions">${SET.prompt === "__new" ? "" : '<button class="btn-secondary as-danger" data-danger="prompt">Delete</button>'}<span class="spacer"></span>
      <button class="btn-primary" data-save="prompt">${SET.prompt === "__new" ? "Create prompt" : "Save"}</button></div>`;
  return `<div class="as-split"><aside class="as-list">${list}<div class="as-add"><button class="btn-secondary" data-new="prompt">+ New prompt</button></div></aside>
    <section class="as-form" id="set-form">${form}<div class="as-test" id="pf-test"></div></section></div>`;
}

function asBehaviourView() {
  const s = AS.settings || { instructions: "", max_steps: 12, default_mode: "agent", system_prompt: "" };
  return `<section class="as-form as-wide" id="set-form">
    ${asField("Custom instructions", `<textarea id="bh-instr" rows="6" placeholder="e.g. Use British spelling. Prefer \\cref over \\ref. Never change the bibliography.">${esc(s.instructions || "")}</textarea>`,
      "Added to every conversation, for every project.")}
    <div class="as-row2">
      ${asField("Default mode", `<select id="bh-mode"><option value="agent"${s.default_mode === "agent" ? " selected" : ""}>Agent</option><option value="chat"${s.default_mode === "chat" ? " selected" : ""}>Chat</option></select>`, "Your own choice in the chat overrides it.")}
      ${asField("Tool steps per turn", `<input id="bh-steps" type="number" min="1" max="40" value="${esc(s.max_steps)}">`, "How many tool calls the agent may make before it stops.")}
    </div>
    <details class="as-sys"><summary>Built-in system prompt (Agent mode)</summary><pre>${esc(s.system_prompt || "")}</pre></details>
    <div class="as-test" id="pf-test"></div>
    <div class="as-form-actions"><span class="spacer"></span><button class="btn-primary" data-save="behaviour">Save</button></div></section>`;
}

async function asSettingsClick(e) {
  const t = e.target;
  const tab = t.closest("[data-stab]");
  if (tab) { SET.tab = tab.dataset.stab; return asSetRender(); }
  if (t.closest("#as-settings-close")) return asCloseSettings();
  const pick = t.closest("[data-pick]");
  if (pick) { SET.sel = pick.dataset.pick; SET.draft = null; return asSetRender(); }
  const pickS = t.closest("[data-pick-skill]");
  if (pickS) { SET.skill = pickS.dataset.pickSkill; return asSetRender(); }
  const pickP = t.closest("[data-pick-prompt]");
  if (pickP) { SET.prompt = pickP.dataset.pickPrompt; return asSetRender(); }
  const rm = t.closest("[data-rm-model]");
  if (rm) {
    e.preventDefault();
    const name = rm.dataset.rmModel;
    rm.closest(".as-mchip").remove();
    const opt = [...$("#pf-default").options].find((o) => o.value === name);
    if (opt) opt.remove();
    return;
  }
  if (t.closest("[data-fetch-models]")) {
    e.preventDefault();
    asTestLine(true, "Fetching models…");
    try {
      const r = await api("GET", `/api/providers/${SET.sel}/remote-models`);
      AS.remoteModels[SET.sel] = r.models;
      $("#pf-remote").innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join("");
      asTestLine(true, `${r.models.length} models available — start typing in Models to pick them.`);
      $("#pf-model-add").focus();
    } catch (err) { asTestLine(false, err.message); }
    return;
  }
  if (t.closest("[data-clear-key]")) {
    e.preventDefault();
    if (!confirm("Remove the stored API key for " + SET.sel + "?")) return;
    try { await api("PATCH", `/api/providers/${SET.sel}`, { api_key: "" }); } catch (err) { return asTestLine(false, err.message); }
    await loadProvider(); asSetRender(); asTestLine(true, "Stored key removed.");
    return;
  }
  if (t.closest("[data-test]")) {
    asTestLine(true, "Testing…");
    try {
      const r = await api("POST", `/api/providers/${SET.sel}/test`, { model: $("#pf-default").value || null });
      asTestLine(r.ok, r.ok ? `${r.model} answered “${r.reply}” in ${r.ms} ms` : r.error);
    } catch (err) { asTestLine(false, err.message); }
    return;
  }
  const save = t.closest("[data-save]");
  if (save) return asSave(save.dataset.save);
  const danger = t.closest("[data-danger]");
  if (danger) return asDanger(danger.dataset.danger);
  const nu = t.closest("[data-new]");
  if (nu) {
    if (nu.dataset.new === "skill") { SET.skill = "__new"; SET.skillDraft = null; }
    if (nu.dataset.new === "prompt") SET.prompt = "__new";
    if (nu.dataset.new === "dup-skill") {
      const s = AS.skills.find((x) => x.name === SET.skill);
      SET.skillDraft = { ...s, name: s.name + "-custom", scope: "custom", title: s.title + " (custom)" };
      SET.skill = "__new";
    }
    return asSetRender();
  }
}

async function asSave(kind) {
  try {
    if (kind === "provider") return asSaveProvider();
    if (kind === "skill") {
      const body = { title: $("#sk-title").value, description: $("#sk-desc").value, mode: $("#sk-mode").value, prompt: $("#sk-prompt").value };
      const r = SET.skill === "__new" ? await api("POST", "/api/skills", { ...body, name: $("#sk-name").value.trim() })
        : await api("PATCH", `/api/skills/${SET.skill}`, body);
      SET.skill = r.name;
    } else if (kind === "prompt") {
      const body = { title: $("#pr-title").value, description: $("#pr-desc").value, body: $("#pr-body").value };
      const r = SET.prompt === "__new" ? await api("POST", "/api/prompts", body) : await api("PATCH", `/api/prompts/${SET.prompt}`, body);
      SET.prompt = r.id;
    } else if (kind === "behaviour") {
      await api("PUT", "/api/assistant/settings", { instructions: $("#bh-instr").value,
        default_mode: $("#bh-mode").value, max_steps: parseInt($("#bh-steps").value, 10) || 12 });
    }
  } catch (err) { asTestLine(false, err.message); return; }
  await loadSkills();
  asSetRender();
  asTestLine(true, "Saved.");
}

async function asDanger(kind) {
  try {
    if (kind === "delete" || kind === "reset") {
      if (!confirm(kind === "delete" ? `Delete the provider ${SET.sel} and its stored key?` : `Drop the changes made here to ${SET.sel} and use config.toml again?`)) return;
      await api("DELETE", `/api/providers/${SET.sel}`);
      if (kind === "delete") SET.sel = null;
      await loadProvider();
    } else if (kind === "skill") {
      if (!confirm(`Delete the skill /${SET.skill}?`)) return;
      await api("DELETE", `/api/skills/${SET.skill}`);
      SET.skill = null; await loadSkills();
    } else if (kind === "prompt") {
      if (!confirm("Delete this prompt?")) return;
      await api("DELETE", `/api/prompts/${SET.prompt}`);
      SET.prompt = null; await loadSkills();
    }
  } catch (err) { asTestLine(false, err.message); return; }
  asSetRender();
}

function asSettingsChange(e) {
  const t = e.target;
  if (t.id === "set-preset" && t.value) {
    const preset = AS.presets.find((p) => p.id === t.value);
    SET.sel = "__new";
    SET.draft = preset ? { name: preset.id, type: preset.type, api_base: preset.api_base, models: preset.models.slice(),
      api_key_env: preset.api_key_env || "", tools: true, enabled: true, source: "custom", model: preset.models[0] }
      : { name: "", type: "openai", api_base: "", models: [], tools: true, enabled: true, source: "custom" };
    asSetRender();
    $("#pf-key")?.focus();
  }
  if (t.id === "set-default" && t.value) {
    const [p, m] = t.value.split("::");
    api("PUT", "/api/assistant/defaults", { provider: p, model: m })
      .then((d) => { AS.defaults = d; }).catch((err) => alert(err.message));
  }
}

// ── wiring ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const input = $("#ask-input");
  $("#ask-send").addEventListener("click", () => asSend());
  input.addEventListener("input", () => { asAcUpdate(); asAutoGrow(); asRenderChips(); });
  input.addEventListener("keydown", asKeydown);
  input.addEventListener("blur", () => setTimeout(asAcClose, 150));
  $("#ac-menu").addEventListener("mousedown", (e) => {
    const it = e.target.closest(".ac-item");
    if (it) { e.preventDefault(); asAcAccept(+it.dataset.i); }
  });
  $("#as-model").addEventListener("change", asModelChanged);
  document.querySelectorAll(".as-mode [data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (asMode() === b.dataset.mode) return;
    AS.mode = b.dataset.mode;
    asLS.set(AS_MODE_KEY, b.dataset.mode);
    asRenderMode(); asRenderHeader();
    asSaveSessionSettings({ mode: b.dataset.mode });   // the session remembers it
    if (AS.switch) asCheckSwitch();                     // tool support may differ
  }));
  $("#as-switch").addEventListener("click", (e) => {
    const b = e.target.closest("[data-switch]");
    if (b) asSwitchAction(b.dataset.switch);
  });
  $("#btn-new-chat").addEventListener("click", asNewConversation);
  $("#as-settings-btn").addEventListener("click", () => asOpenSettings());
  $("#as-chips").addEventListener("click", (e) => {
    const c = e.target.closest("[data-chip]");
    if (!c) return;
    if (c.dataset.chip === "file") AS.useFile = !AS.useFile;
    if (c.dataset.chip === "sel") { const s = asSelection(); AS.ignoredSel = s ? s.text : ""; }
    asRenderChips();
  });
  // the editor's selection feeds the chips
  const src = $("#source");
  for (const ev of ["mouseup", "keyup", "select"]) src.addEventListener(ev, asRenderChips);
  document.addEventListener("tw:source", asRenderChips);

  // transcript actions
  $("#assistant-slot").addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-open-settings]")) return asOpenSettings("providers");
    const oc = t.closest("[data-open-conv]");
    if (oc) return asOpenConversation(oc.dataset.openConv);
    const sug = t.closest("[data-skill]");
    if (sug) { input.value = `/${sug.dataset.skill} `; input.focus(); asAutoGrow(); return; }
    const node = t.closest(".as-msg");
    const i = node ? +node.dataset.i : -1;
    const m = i >= 0 && AS.conv ? AS.conv.messages[i] : null;
    const code = t.closest("[data-code]");
    if (code) {
      const pre = code.closest(".md-code-head").nextElementSibling;
      const text = pre ? pre.textContent : "";
      return code.dataset.code === "copy" ? asCopy(text, code) : asInsertCode(text);
    }
    const ch = t.closest("[data-change]");
    if (ch && m) { e.preventDefault(); return asActOnChanges(i, ch.dataset.change, ch.dataset.path || null); }
    const act = t.closest("[data-act]");
    if (!act || !m) return;
    if (act.dataset.act === "copy") return asCopy(m.content.replace(/\n\n_\(Proposed edits to: [^\n]*\)_$/, ""), act);
    if (act.dataset.act === "edit") return asEditMessage(i, node);
    if (act.dataset.act === "regen" || act.dataset.act === "retry") return asRegenerate(i);
    if (act.dataset.act === "prev" || act.dataset.act === "next") return asPickVersion(i, act.dataset.act === "next" ? 1 : -1);
    if (act.dataset.act === "split") return asSplitAt(i);
    if (act.dataset.act === "delete") return asDeleteMessage(i);
  });

  // conversations menu
  $("#as-convo-btn").addEventListener("click", async () => {
    const open = $("#as-convo-menu").hidden;
    if (open) { await asSearchConvs(AS.convQuery); asRenderConvMenu(); }
    asMenu("#as-convo-menu", "#as-convo-btn", open);
    if (open) $("#as-convo-menu .as-convo-search")?.focus();
  });
  let convSearchTimer = 0;
  $("#as-convo-menu").addEventListener("input", (e) => {
    if (!e.target.classList.contains("as-convo-search")) return;
    clearTimeout(convSearchTimer);
    const q = e.target.value.trim();
    convSearchTimer = setTimeout(() => asSearchConvs(q), 180);
  });
  $("#as-convo-menu").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); asMenu("#as-convo-menu", "#as-convo-btn", false); $("#as-convo-btn").focus(); }
    if (e.key === "Enter" && e.target.classList.contains("as-convo-search")) {
      const first = $("#as-convo-menu [data-conv]");
      if (first) { asMenu("#as-convo-menu", "#as-convo-btn", false); asOpenConversation(first.dataset.conv); }
    }
  });
  $("#as-convo-menu").addEventListener("click", async (e) => {
    if (e.target.closest("[data-conv-new]")) { asMenu("#as-convo-menu", "#as-convo-btn", false); return asNewConversation(); }
    const row = e.target.closest("[data-conv]");
    if (!row) return;
    const act = e.target.closest("[data-conv-act]");
    if (act) return asConvAction(row.dataset.conv, act.dataset.convAct);
    asMenu("#as-convo-menu", "#as-convo-btn", false);
    asOpenConversation(row.dataset.conv);
  });

  // branches menu
  $("#as-branch-btn").addEventListener("click", () => {
    const open = $("#as-branch-menu").hidden;
    if (open) asRenderBranchMenu();
    asMenu("#as-branch-menu", "#as-branch-btn", open);
  });
  $("#as-branch-menu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-branch]");
    if (!b || AS.running) return;
    asMenu("#as-branch-menu", "#as-branch-btn", false);
    asSelectBranch(b.dataset.branch);
  });

  // saved prompts menu
  $("#as-prompts-btn").addEventListener("click", () => {
    const open = $("#as-prompts-menu").hidden;
    if (open) asRenderPromptsMenu();
    asMenu("#as-prompts-menu", "#as-prompts-btn", open);
  });
  $("#as-prompts-menu").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-settings]");
    asMenu("#as-prompts-menu", "#as-prompts-btn", false);
    if (open) return asOpenSettings("prompts");
    const item = e.target.closest("[data-prompt]");
    const p = item && AS.prompts.find((x) => x.id === item.dataset.prompt);
    if (p) asInsertIntoComposer(asFillPlaceholders(p.body));
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".as-convo")) asMenu("#as-convo-menu", "#as-convo-btn", false);
    if (!e.target.closest(".as-branches")) asMenu("#as-branch-menu", "#as-branch-btn", false);
    if (!e.target.closest(".as-prompts")) asMenu("#as-prompts-menu", "#as-prompts-btn", false);
  });

  // settings dialog
  $("#as-settings").addEventListener("click", asSettingsClick);
  $("#as-settings").addEventListener("change", asSettingsChange);
  $("#as-settings").addEventListener("mousedown", (e) => { if (e.target.id === "as-settings") asCloseSettings(); });
  $("#as-settings").addEventListener("keydown", (e) => {
    if (e.target.id === "pf-model-add" && e.key === "Enter") { e.preventDefault(); asAddModelChip(e.target.value); e.target.value = ""; }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#as-settings").hidden && !e.defaultPrevented) { e.preventDefault(); asCloseSettings(); }
  });
  asRenderMode();
});
