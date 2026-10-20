// TikZ editor dialog (left panel → Tools → TikZ editor), which embeds
// github.com/DominikPeters/tikz-editor. Needs the bundle built by
// scripts/build_tikz_editor.sh; without it only the "not installed" case runs.
"use strict";
const { apiFor, assert } = require("./harness");

const PLAIN = String.raw`\documentclass{article}
\begin{document}
Intro paragraph.

HERE

\end{document}
`;

const WITH_FIGURE = String.raw`\documentclass{article}
\usepackage{tikz}
\usetikzlibrary{positioning}
\definecolor{brand}{RGB}{200,40,40}
\tikzset{box/.style={draw=brand,thick,rounded corners}}
\begin{document}
Before.

\begin{figure}[h]
\centering
\begin{tikzpicture}
  \node[box] (a) {Input};
  \node[box, right=2cm of a] (b) {Output};
  \draw[->] (a) -- (b);
\end{tikzpicture}
\caption{Flow}
\end{figure}

After.
\end{document}
`;

async function installed(base) {
  const cfg = await apiFor(base)("GET", "/api/config");
  return !!(cfg.tools && cfg.tools.tikz_editor && cfg.tools.tikz_editor.available);
}

async function openProject(page, base, name, main) {
  await apiFor(base)("POST", "/api/projects", { name, main_path: "main.tex", files: { "main.tex": main } });
  await page.goto(base + "/");
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#source").value.includes("\\begin{document}"));
}

async function caretAt(page, needle) {
  await page.evaluate((n) => {
    const ta = document.querySelector("#source");
    const i = ta.value.indexOf(n);
    ta.focus(); ta.setSelectionRange(i, i);
  }, needle);
}

// Open the tool and wait until the editor holds the figure.
async function openTool(page) {
  await page.click(".tool-row[data-tool=tikzedit]");
  await page.waitForSelector("#tz-modal:not([hidden])");
  await page.waitForSelector("#tz-insert:not([disabled])", { timeout: 60000 });
  const frame = page.frame({ url: /vendor\/tikz-editor\// });
  assert(frame, "editor frame");
  await frame.waitForSelector(".cm-content");
  return frame;
}

const frameSource = (frame) => frame.$eval(".cm-content", (el) => el.cmView ? el.cmView.view.state.doc.toString() : el.innerText);
const editor = (page) => page.$eval("#source", (ta) => ta.value);

// Replace the editor's source text the way a user would: select all, type.
async function typeSource(page, frame, text) {
  await frame.click(".cm-content");
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);
  await page.waitForFunction(() => document.querySelector("#tz-status").textContent.includes("Unsaved"));
}

module.exports = {
  async explains_how_to_install_when_the_bundle_is_missing({ page, base }) {
    await page.route("**/api/config", async (route) => {
      const res = await route.fetch();
      const cfg = await res.json();
      cfg.tools = { tikz_editor: { available: false, url: "/static/vendor/tikz-editor/index.html" } };
      await route.fulfill({ response: res, json: cfg });
    });
    await openProject(page, base, "TzMissing", PLAIN);
    await page.click(".tool-row[data-tool=tikzedit]");
    await page.waitForSelector("#tz-missing:not([hidden])");
    assert((await page.textContent("#tz-missing")).includes("scripts/build_tikz_editor.sh"), "install hint");
    assert(await page.$eval("#tz-insert", (b) => b.disabled), "insert disabled");
    assert(!(await page.$("#tz-frame")), "no frame without the bundle");
    await page.keyboard.press("Escape");
    assert(await page.$eval("#tz-modal", (m) => m.hidden), "Esc closes");
  },

  async inserts_a_new_figure_and_loads_tikz_in_the_preamble({ page, base }) {
    if (!(await installed(base))) { console.log("       (skipped: TikZ editor bundle not built)"); return; }
    await openProject(page, base, "TzNew", PLAIN);
    await caretAt(page, "HERE");
    const frame = await openTool(page);
    assert((await page.textContent("#tz-where")).includes("New figure"), "new-figure banner");
    assert((await page.textContent("#tz-insert")) === "Insert into editor", "button label");
    const src = await frameSource(frame);
    assert(src.includes("\\begin{tikzpicture}") && !src.includes("from the preamble"), "empty picture, no context: " + src);
    await typeSource(page, frame, "\\usetikzlibrary{arrows.meta}\n\\begin{tikzpicture}\n  \\draw[-Stealth] (0,0) -- (1,1);\n\\end{tikzpicture}\n");
    await page.click("#tz-insert");
    await page.waitForSelector("#tz-modal", { state: "hidden" });
    const v = await editor(page);
    assert(v.includes("HERE\\begin{tikzpicture}") === false, "picture on its own line");
    assert(v.includes("\\draw[-Stealth] (0,0) -- (1,1);"), "picture inserted:\n" + v);
    assert(v.indexOf("\\usepackage{tikz} % added by the TikZ editor") < v.indexOf("\\begin{document}"), "tikz loaded:\n" + v);
    assert(v.includes("\\usetikzlibrary{arrows.meta} % added by the TikZ editor"), "library added:\n" + v);
    assert(v.split("\\usetikzlibrary{arrows.meta}").length === 2, "library only in the preamble");
  },

  async edits_the_picture_at_the_cursor_in_place({ page, base }) {
    if (!(await installed(base))) { console.log("       (skipped: TikZ editor bundle not built)"); return; }
    await openProject(page, base, "TzEdit", WITH_FIGURE);
    await caretAt(page, "\\draw[->]");
    const frame = await openTool(page);
    assert((await page.textContent("#tz-where")).includes("main.tex:11"), await page.textContent("#tz-where"));
    assert((await page.textContent("#tz-insert")) === "Replace in editor", "button label");
    const src = await frameSource(frame);
    for (const piece of ["\\usetikzlibrary{positioning}", "\\definecolor{brand}", "\\tikzset{box/.style=", "\\node[box] (a) {Input};"]) {
      assert(src.includes(piece), `editor got ${piece}:\n${src}`);
    }
    assert(!src.includes("\\caption"), "only the picture, not the float");
    // the user renames a node and adds a library above the picture
    await typeSource(page, frame, src.replace("{Input}", "{Start}").replace("\\usetikzlibrary{positioning}", "\\usetikzlibrary{positioning,calc}"));
    await page.click("#tz-insert");
    await page.waitForSelector("#tz-modal", { state: "hidden" });
    const v = await editor(page);
    assert(v.includes("\\node[box] (a) {Start};") && !v.includes("{Input}"), "picture replaced:\n" + v);
    assert(v.includes("\\centering\n\\begin{tikzpicture}") && v.includes("\\end{tikzpicture}\n\\caption{Flow}"), "float kept:\n" + v);
    assert(v.split("\\tikzset{box/.style").length === 2, "context not duplicated:\n" + v);
    assert(!v.includes("from the preamble"), "context note not written back");
    assert(v.includes("\\usetikzlibrary{calc} % added by the TikZ editor"), "new library in the preamble:\n" + v);
    assert(!v.includes("\\usepackage{tikz} % added"), "tikz was already loaded");
  },

  async cancel_with_changes_asks_first({ page, base }) {
    if (!(await installed(base))) { console.log("       (skipped: TikZ editor bundle not built)"); return; }
    await openProject(page, base, "TzCancel", WITH_FIGURE);
    await caretAt(page, "\\draw[->]");
    const before = await editor(page);
    const frame = await openTool(page);
    // unchanged: Cancel closes at once
    await page.click("#tz-cancel");
    await page.waitForSelector("#tz-modal", { state: "hidden" });
    // reopening reuses the editor and reloads the figure
    await caretAt(page, "\\draw[->]");
    await page.click(".tool-row[data-tool=tikzedit]");
    await page.waitForSelector("#tz-insert:not([disabled])");
    assert((await page.$$("#tz-frame")).length === 1, "one frame");
    const src = await frameSource(frame);
    await typeSource(page, frame, src.replace("{Output}", "{Result}"));
    let asked = 0;
    page.once("dialog", (d) => { asked++; d.dismiss(); });
    await page.click("#tz-cancel");
    assert(asked === 1, "asked before discarding");
    assert(!(await page.$eval("#tz-modal", (m) => m.hidden)), "still open after declining");
    page.once("dialog", (d) => { asked++; d.accept(); });
    await page.click("#tz-cancel");
    await page.waitForSelector("#tz-modal", { state: "hidden" });
    assert(asked === 2 && (await editor(page)) === before, "editor untouched");
  },
  async a_chapter_picture_uses_the_root_preamble({ page, base }) {
    if (!(await installed(base))) { console.log("       (skipped: TikZ editor bundle not built)"); return; }
    const api = apiFor(base);
    const p = await api("POST", "/api/projects", { name: "TzChapter", main_path: "main.tex", files: {
      "main.tex": "\\documentclass{article}\n\\usepackage{tikz}\n\\tikzset{hot/.style={fill=red}}\n\\begin{document}\n\\input{chap}\n\\end{document}\n",
      "chap.tex": "Chapter text.\n\\begin{tikzpicture}\n  \\fill[hot] (0,0) circle (1);\n\\end{tikzpicture}\n",
    } });
    await page.goto(base + "/");
    await page.click(".project-card >> text=TzChapter");
    await page.waitForSelector("#view-workspace:not([hidden])");
    await page.click(".file-row >> text=chap.tex");
    await page.waitForFunction(() => document.querySelector("#source").value.includes("circle"));
    await caretAt(page, "circle");
    const frame = await openTool(page);
    assert((await page.textContent("#tz-where")).includes("chap.tex:2"), await page.textContent("#tz-where"));
    const src = await frameSource(frame);
    assert(src.includes("\\tikzset{hot/.style={fill=red}}"), "root preamble context:\n" + src);
    await typeSource(page, frame, src.replace("circle (1)", "circle (2)").replace("\\tikzset{hot", "\\usetikzlibrary{shapes.geometric}\n\\tikzset{hot"));
    await page.click("#tz-insert");
    await page.waitForSelector("#tz-modal", { state: "hidden" });
    const chap = await editor(page);
    assert(chap === "Chapter text.\n\\begin{tikzpicture}\n  \\fill[hot] (0,0) circle (2);\n\\end{tikzpicture}\n", "chapter:\n" + chap);
    const main = (await api("GET", `/api/projects/${p.id}`)).files.find((f) => f.path === "main.tex").content;
    assert(main.includes("\\usetikzlibrary{shapes.geometric} % added by the TikZ editor\n\\begin{document}"), main);
  },
};
