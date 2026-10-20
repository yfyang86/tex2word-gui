// Table generator dialog (left panel → Tools → Table generator).
"use strict";
const { apiFor, assert } = require("./harness");

const MAIN = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Intro paragraph.

HERE

\begin{table}[htbp]
\centering
\caption{Old results}
\label{tab:old}
\begin{tabular}{lc}
\hline
Name & Score \\ \hline
A    & 1     \\
\end{tabular}
\end{table}
\end{document}
`;

async function openProject(page, base, name) {
  await apiFor(base)("POST", "/api/projects", { name, main_path: "main.tex", files: { "main.tex": MAIN } });
  await page.goto(base + "/");
  await page.evaluate(() => localStorage.removeItem("tw_tablegen"));
  await page.goto(base + "/");
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#source").value.includes("HERE"));
}

async function caretAt(page, needle, select) {
  await page.evaluate(([n, sel]) => {
    const ta = document.querySelector("#source");
    const i = ta.value.indexOf(n);
    ta.focus(); ta.setSelectionRange(i, sel ? i + n.length : i);
  }, [needle, select]);
}

async function openTool(page) {
  await page.click(".tool-row[data-tool=tablegen]");
  await page.waitForSelector("#tg-modal:not([hidden])");
}

const code = (page) => page.textContent("#tg-code");
const cellText = (page, r, c) => page.textContent(`#tg-grid td[data-r="${r}"][data-c="${c}"]`);
const editor = (page) => page.$eval("#source", (ta) => ta.value);
const paste = (page, text) => page.evaluate((t) => {
  const dt = new DataTransfer();
  dt.setData("text/plain", t);
  document.querySelector("#tg-gridwrap").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);

module.exports = {
  async opens_from_the_left_panel_with_an_empty_table({ page, base }) {
    await openProject(page, base, "TgOpen");
    await caretAt(page, "HERE");
    await openTool(page);
    assert((await page.$$eval("#tg-grid td", (t) => t.length)) === 20, "4×5 grid");
    const c = await code(page);
    assert(c.includes("\\begin{tabular}{lllll}") && c.includes("\\end{table}"), c);
    // the rail icon opens it too (collapsed files panel)
    await page.keyboard.press("Escape");
    assert(await page.$eval("#tg-modal", (m) => m.hidden), "Esc closes the dialog");
    await page.click('[data-collapse="files"]');
    await page.click(".rail-tool[data-tool=tablegen]");
    await page.waitForSelector("#tg-modal:not([hidden])");
  },

  async typing_tab_enter_and_live_output({ page, base }) {
    await openProject(page, base, "TgType");
    await caretAt(page, "HERE");
    await openTool(page);
    await page.click('#tg-grid td[data-r="0"][data-c="0"]');
    await page.keyboard.type("Model");            // typing starts an edit
    await page.keyboard.press("Tab");             // commit, next cell
    await page.keyboard.type("Acc");
    await page.keyboard.press("Enter");           // commit, cell below
    await page.keyboard.type("0.91");
    await page.keyboard.press("Escape");          // cancels this edit only
    assert(!(await page.$eval("#tg-modal", (m) => m.hidden)), "Esc while editing keeps the dialog");
    assert((await cellText(page, 0, 0)) === "Model" && (await cellText(page, 0, 1)) === "Acc", "committed cells");
    assert((await cellText(page, 1, 1)) === "", "cancelled edit not saved");
    await page.keyboard.press("Enter");           // edit the existing text
    await page.keyboard.type(" %");
    await page.keyboard.press("Enter");
    const rows = (await code(page)).split("\n");
    assert(/^Model & Acc +& +& +& *\\\\$/.test(rows[3]), "first row: " + rows[3]);
    assert(/^ +& +\\% +&/.test(rows[4]), "edited cell, escaped: " + rows[4]);
  },

  async paste_merge_format_borders_and_undo({ page, base }) {
    await openProject(page, base, "TgOps");
    await caretAt(page, "HERE");
    await openTool(page);
    await page.click('#tg-grid td[data-r="0"][data-c="0"]');
    await paste(page, "Model\tAcc\tF1\nOurs\t0.91\t0.88\nBase\t0.72\t0.70");
    assert((await cellText(page, 2, 2)) === "0.70", "spreadsheet paste");
    // bold header via Ctrl+B — and the files panel must not toggle
    await page.click('#tg-grid td[data-r="0"][data-c="0"]');
    await page.click('#tg-grid td[data-r="0"][data-c="2"]', { modifiers: ["Shift"] });
    await page.keyboard.press("Control+b");
    assert(!(await page.$eval("#pane-files", (e) => e.classList.contains("collapsed"))), "Ctrl+B stayed in the dialog");
    assert((await code(page)).includes("\\textbf{Model}"), "bold");
    // merge B1:C1 and centre it
    await page.click('#tg-grid td[data-r="0"][data-c="1"]');
    await page.click('#tg-grid td[data-r="0"][data-c="2"]', { modifiers: ["Shift"] });
    await page.click('[data-tg="merge"]');
    await page.click('[data-tg="alignC"]');
    assert((await code(page)).includes("\\multicolumn{2}{c}{\\textbf{Acc F1}}"), await code(page));
    assert((await page.getAttribute('#tg-grid td[data-r="0"][data-c="1"]', "colspan")) === "2", "merged in the grid");
    // all borders on the whole table
    await page.click(".tg-corner");
    await page.click('[data-tg="bAll"]');
    const c = await code(page);
    assert(c.includes("\\begin{tabular}{|l|l|l|l|l|}") && c.includes("\\hline"), c);
    // undo twice: borders, then centring
    await page.keyboard.press("Control+z");
    assert(!(await code(page)).includes("\\hline"), "undo borders");
    await page.keyboard.press("Control+z");
    assert((await code(page)).includes("\\multicolumn{2}{l}{"), "undo centring");
    await page.keyboard.press("Control+Shift+z");
    assert((await code(page)).includes("\\multicolumn{2}{c}{"), "redo");
    // copy produces TSV of the selection
    const tsv = await page.evaluate(() => {
      const dt = new DataTransfer();
      document.querySelector("#tg-gridwrap").dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData("text/plain");
    });
    assert(tsv.split("\n")[1].startsWith("Ours\t0.91\t0.88"), "copied TSV: " + JSON.stringify(tsv));
  },

  async menus_context_menu_and_options({ page, base }) {
    await openProject(page, base, "TgMenus");
    await caretAt(page, "HERE");
    await openTool(page);
    await page.click('#tg-grid .tg-colh[data-col="1"]', { button: "right" });
    await page.click('#tg-menu .tg-mi >> text=Insert column right');
    assert((await page.$$eval("#tg-grid .tg-colh", (t) => t.length)) === 6, "column inserted");
    await page.click('#tg-grid td[data-r="3"][data-c="0"]');   // one cell: Delete row removes one row
    await page.click('#tg-menubar button[data-menu="Row"]');
    await page.click('#tg-menu .tg-mi >> text=Delete row');
    assert((await page.$$eval("#tg-grid tbody tr", (t) => t.length)) === 3, "row deleted");
    await page.click('label:has-text("Booktabs")');
    await page.click('label:has-text("Above")');
    await page.fill("#tg-captext", "Ablation & results");
    await page.click('label:has-text("Wrap to text width")');
    assert(await page.evaluate(() => document.activeElement.matches('input[name="tg-width"][value="wrap"]')),
           "focus stays on the option after it re-renders");
    const c = await code(page);
    assert(c.includes("\\caption{Ablation \\& results}") && c.includes("\\label{tab:ablation-results}"), c);
    assert(c.includes("\\begin{tabularx}{\\textwidth}{XXXXXX}"), c);
    assert((await page.textContent("#tg-notes")).includes("tabularx"), "needed packages listed");
    // options persist across reopening
    await page.keyboard.press("Escape");
    await openTool(page);
    assert(await page.$eval('input[name="tg-style"][value="booktabs"]', (i) => i.checked), "options persisted");
  },

  async insert_into_editor_adds_packages({ page, base }) {
    await openProject(page, base, "TgInsert");
    await caretAt(page, "HERE", true);            // the selection is replaced
    await openTool(page);
    await page.click('#tg-grid td[data-r="0"][data-c="0"]');
    await paste(page, "a\tb\nc\td");
    await page.click('#tg-grid td[data-r="0"][data-c="0"]');
    await page.click('#tg-grid td[data-r="1"][data-c="0"]', { modifiers: ["Shift"] });
    await page.click('[data-tg="merge"]');
    await page.click('label:has-text("Booktabs")');
    await page.click("#tg-insert");
    assert(await page.$eval("#tg-modal", (m) => m.hidden), "dialog closed");
    const v = await editor(page);
    assert(!v.includes("HERE"), "selection replaced");
    assert(v.includes("\\multirow{2}{*}{a c}"), "table inserted");
    assert(v.includes("\\usepackage{booktabs,multirow} % added by the table generator\n\\begin{document}"), "packages added");
    // the preview renders the inserted table
    await page.click("#btn-toggle-preview");
    await page.waitForSelector("#preview-doc table td");
    // one editor undo removes the package line, another the table
    await page.focus("#source");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    assert((await editor(page)).includes("HERE"), "undoable in the editor");
  },

  async edit_the_table_at_the_cursor_and_replace_it({ page, base }) {
    await openProject(page, base, "TgEdit");
    await caretAt(page, "Name & Score");
    await openTool(page);
    assert(!(await page.$eval("#tg-banner", (b) => b.hidden)), "banner says which table is edited");
    assert((await page.textContent("#tg-banner")).includes("main.tex:"), "with its location");
    assert((await cellText(page, 1, 0)) === "A" && (await cellText(page, 0, 1)) === "Score", "loaded cells");
    assert(await page.$eval('input[name="tg-caption"][value="above"]', (i) => i.checked), "caption position read");
    assert((await page.inputValue("#tg-captext")) === "Old results", "caption text read");
    await page.dblclick('#tg-grid td[data-r="1"][data-c="1"]');
    await page.keyboard.press("Control+a");
    await page.keyboard.type("42");
    await page.keyboard.press("Enter");
    assert((await page.textContent("#tg-insert")).includes("Replace"), "button says replace");
    await page.click("#tg-insert");
    const v = await editor(page);
    assert(v.split("\\begin{table}").length === 2, "replaced, not duplicated");
    assert(/A +& 42/.test(v) && v.includes("\\label{tab:old}"), v);
  },

  async load_latex_and_csv_import({ page, base }) {
    await openProject(page, base, "TgLoad");
    await openTool(page);
    await page.click('#tg-menubar button[data-menu="File"]');
    await page.click('#tg-menu .tg-mi >> text=Load LaTeX code…');
    await page.fill("#tg-load-text", "\\begin{tabular}{|c|r|}\\hline x & y \\\\ \\hline\\multicolumn{2}{|c|}{z} \\\\ \\hline\\end{tabular}");
    await page.click("#tg-load-ok");
    assert((await cellText(page, 1, 0)) === "z", "loaded");
    assert((await page.getAttribute('#tg-grid td[data-r="1"][data-c="0"]', "colspan")) === "2", "multicolumn read");
    assert((await code(page)).includes("\\begin{tabular}{|c|r|}"), await code(page));
    // CSV file import
    await page.setInputFiles("#tg-file", { name: "t.csv", mimeType: "text/csv", buffer: Buffer.from('h1,h2,h3\n1,"2,5",3\n') });
    await page.waitForFunction(() => document.querySelectorAll("#tg-grid tbody tr").length === 2);
    assert((await cellText(page, 1, 1)) === "2,5", "quoted CSV field");
  },

  async packages_go_to_the_root_preamble_from_a_chapter_file({ page, base }) {
    const api = apiFor(base);
    const p = await api("POST", "/api/projects", { name: "TgChapter", main_path: "main.tex", files: {
      "main.tex": "\\documentclass{article}\n\\begin{document}\n\\input{chap}\n\\end{document}\n",
      "chap.tex": "Chapter text.\n\nSPOT\n",
    } });
    await page.goto(base + "/");
    await page.click(".project-card >> text=TgChapter");
    await page.waitForSelector("#view-workspace:not([hidden])");
    await page.click(".file-row >> text=chap.tex");
    await page.waitForFunction(() => document.querySelector("#source").value.includes("SPOT"));
    await caretAt(page, "SPOT", true);
    await openTool(page);
    await page.click('label:has-text("Booktabs")');
    assert((await page.textContent("#tg-notes")).includes("booktabs"), "booktabs flagged as missing");
    await page.click("#tg-insert");
    assert((await editor(page)).includes("\\toprule") === false && (await editor(page)).includes("\\begin{tabular}"), "table in the chapter");
    const main = (await api("GET", `/api/projects/${p.id}`)).files.find((f) => f.path === "main.tex").content;
    assert(main.includes("\\usepackage{booktabs} % added by the table generator\n\\begin{document}"), main);
  },
};
