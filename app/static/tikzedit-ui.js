// TikZ editor tool — the dialog around the embedded editor.
//
// The editor (https://github.com/DominikPeters/tikz-editor, MIT) is a prebuilt
// bundle at /static/vendor/tikz-editor/ (scripts/build_tikz_editor.sh). It runs
// in an iframe on this origin; tools/tikz-editor-embed/src/bridge.ts is its end
// of the postMessage protocol. TikzEdit (tikzedit.js) does the source work.
"use strict";

const TZ_NS = "tikz-editor-embed";
const TZ_READY_TIMEOUT_MS = 30000;
const TZ = {
  info: null,         // /api/config → tools.tikz_editor
  frame: null,        // the <iframe>, kept between openings
  ready: null,        // Promise resolved by the editor's "ready"
  readyResolve: null,
  waits: new Map(),   // request id → resolve
  seq: 0,
  target: null,       // {file, from, to, text, line} when editing a picture in place
  context: [],        // preamble definitions handed to the editor
  dirty: false,
  busy: false,
};

async function tzInfo() {
  if (TZ.info) return TZ.info;
  try {
    const cfg = await api("GET", "/api/config");
    TZ.info = (cfg.tools && cfg.tools.tikz_editor) || { available: false };
  } catch {
    TZ.info = { available: false };
  }
  return TZ.info;
}

function tzSetStatus() {
  $("#tz-status").textContent = TZ.dirty ? "Unsaved changes" : "";
}

function tzRequest(type, payload) {
  const id = String(++TZ.seq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { TZ.waits.delete(id); reject(new Error("the TikZ editor did not answer")); }, 10000);
    TZ.waits.set(id, (data) => { clearTimeout(timer); resolve(data); });
    TZ.frame.contentWindow.postMessage({ ns: TZ_NS, type, id, ...payload }, location.origin);
  });
}

function tzOnMessage(e) {
  if (!TZ.frame || e.source !== TZ.frame.contentWindow || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.ns !== TZ_NS) return;
  if (d.type === "ready") {
    if (TZ.readyResolve) TZ.readyResolve(d);
    if (d.version) $("#tz-version").textContent = d.version;
  } else if (d.type === "change") {
    TZ.dirty = !!d.dirty;
    tzSetStatus();
  } else if ((d.type === "loaded" || d.type === "source") && d.id && TZ.waits.has(d.id)) {
    const done = TZ.waits.get(d.id);
    TZ.waits.delete(d.id);
    done(d);
  }
}

function tzEnsureFrame(url) {
  if (TZ.frame) return TZ.ready;
  TZ.ready = new Promise((resolve, reject) => {
    TZ.readyResolve = resolve;
    setTimeout(() => reject(new Error("the TikZ editor did not start")), TZ_READY_TIMEOUT_MS);
  });
  const f = document.createElement("iframe");
  f.className = "tz-frame";
  f.id = "tz-frame";
  f.title = "TikZ editor";
  f.src = url;
  // Keyboard focus starts in our dialog; the frame takes it on click.
  f.setAttribute("allow", "clipboard-read; clipboard-write");
  $("#tz-body").appendChild(f);
  TZ.frame = f;
  return TZ.ready;
}

// The picture around the editor's cursor in the open .tex file, or null.
function tzPictureAtCursor() {
  if (!state.activeFile || isBinary(state.activeFile) || langFor(state.activeFile) !== "tex") return null;
  const ta = $("#source");
  const caret = state.edSel ? state.edSel[0] : ta.selectionStart;
  const hit = TikzEdit.pictureAt(ta.value, caret);
  if (!hit) return null;
  const line = ta.value.slice(0, hit.from).split("\n").length;
  return { file: state.activeFile, ...hit, line };
}

async function tzOpen() {
  if (TZ.busy) return;
  const modal = $("#tz-modal");
  const info = await tzInfo();
  modal.hidden = false;
  TZ.dirty = false;
  tzSetStatus();
  const insert = $("#tz-insert");
  insert.disabled = true;
  $("#tz-missing").hidden = info.available;
  if (!info.available) {
    $("#tz-where").textContent = "";
    if (TZ.frame) TZ.frame.hidden = true;
    $("#tz-cancel").focus();
    return;
  }
  TZ.target = tzPictureAtCursor();
  const canWrite = !!(state.activeFile && !isBinary(state.activeFile));
  $("#tz-where").innerHTML = TZ.target
    ? `Editing the picture at <code>${esc(TZ.target.file)}:${TZ.target.line}</code>`
    : canWrite ? "New figure, inserted at the cursor" : "New figure (open a .tex file to insert it)";
  insert.textContent = TZ.target ? "Replace in editor" : "Insert into editor";

  const { text, at } = rootPreamble();
  const { source, context } = TikzEdit.compose(at >= 0 ? text.slice(0, at) : "", TZ.target && TZ.target.text);
  TZ.context = context;

  TZ.busy = true;
  $("#tz-loading").textContent = "Loading the TikZ editor…";
  $("#tz-loading").hidden = !!TZ.frame;
  try {
    await tzEnsureFrame(info.url);
    TZ.frame.hidden = false;
    $("#tz-loading").hidden = true;
    await tzRequest("load", { source, title: TZ.target ? TZ.target.file.split("/").pop() : "New figure", colorScheme: "light" });
    insert.disabled = !canWrite;
    TZ.frame.focus();
  } catch (e) {
    // drop the frame so the next opening starts it afresh
    if (TZ.frame) { TZ.frame.remove(); TZ.frame = null; }
    $("#tz-loading").hidden = false;
    $("#tz-loading").textContent = "Could not start the TikZ editor: " + e.message;
  } finally {
    TZ.busy = false;
  }
}

function tzClose(force) {
  if (!force && TZ.dirty && !confirm("Discard your changes to this figure?")) return false;
  $("#tz-modal").hidden = true;
  TZ.dirty = false;
  TZ.target = null;
  if (state.activeFile) $("#source").focus();
  return true;
}

async function tzInsert() {
  if (TZ.busy || !TZ.frame || !state.activeFile || isBinary(state.activeFile)) return;
  TZ.busy = true;
  try {
    const reply = await tzRequest("get", {});
    const out = TikzEdit.extract(reply.source || "", TZ.context);
    if (!out) { alert("There is no tikzpicture to insert: the editor's source has no \\begin{tikzpicture}…\\end{tikzpicture}."); return; }
    const ta = $("#source"), v = ta.value;
    const t = TZ.target;
    if (t && t.file === state.activeFile && v.slice(t.from, t.to) === t.text) {
      edInsert(t.from, t.to, out.picture);
    } else {
      const [from, to] = state.edSel || [ta.selectionStart, ta.selectionEnd];
      const before = from > 0 && v[from - 1] !== "\n" ? "\n" : "";
      const after = v[to] && v[to] !== "\n" ? "\n" : "";
      edInsert(from, to, before + out.picture + after);
    }
    const { text, at } = rootPreamble();
    if (at >= 0) {
      const lines = TikzEdit.preambleAdditions(text.slice(0, at), out.added);
      if (lines.length) await addToPreamble(lines.map((l) => `${l} % added by the TikZ editor`).join("\n"));
    }
    tzClose(true);
  } catch (e) {
    alert("Could not read the figure from the TikZ editor: " + e.message);
  } finally {
    TZ.busy = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("message", tzOnMessage);
  document.querySelectorAll("[data-tool=tikzedit]").forEach((b) => b.addEventListener("click", tzOpen));
  $("#tz-cancel").addEventListener("click", () => tzClose());
  $("#tz-insert").addEventListener("click", tzInsert);
  // Esc closes the dialog while focus is outside the editor frame (inside it,
  // the editor uses Esc itself, e.g. to clear the selection).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("#tz-modal").hidden) return;
    e.preventDefault();
    tzClose();
  });
});
