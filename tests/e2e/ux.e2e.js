// Workspace polish: file-type icons, main badge, unsaved marker + Ctrl/Cmd+S,
// the file outline, the line-number gutter and status bar, the theme toggle,
// the shortcuts dialog, narrow-window panels, settings summary, missing images.
"use strict";
const { apiFor, assert } = require("./harness");

const MAIN = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\section{Introduction}\label{sec:intro}
A very long line of prose that keeps going and going so that it wraps onto several rows in the editor at the default width, which is exactly what the gutter has to handle when it numbers lines and places the current-line band behind the text you are typing.
\subsection{Details}
\begin{figure}[h]\centering
\includegraphics{figures/missing.png}
\caption{A missing figure}\label{fig:missing}
\end{figure}
\input{sections/more}
\end{document}
`;

async function openProject(page, base, name) {
  const api = apiFor(base);
  const p = await api("POST", "/api/projects", { name, main_path: "main.tex", files: {
    "main.tex": MAIN, "sections/more.tex": "\\section{More}\nText.\n", "refs.bib": "@misc{k, title={T}}\n", "style.sty": "% pkg\n",
  } });
  await page.goto(base + "/");
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#source").value.includes("Introduction"));
  return p;
}

const caretLine = (page) => page.$eval("#source", (ta) => ta.value.slice(0, ta.selectionStart).split("\n").length - 1);

module.exports = {
  async file_tree_icons_main_badge_unsaved_dot_and_ctrl_s({ page, base }) {
    const p = await openProject(page, base, "UxTree");
    const kinds = await page.$$eval(".file-row", (rows) => Object.fromEntries(rows.map((r) =>
      [r.dataset.path, r.querySelector(".ft-icon").getAttribute("class").split(" ").find((c) => c.startsWith("ft-") && c !== "ft-icon")])));
    assert(kinds["main.tex"] === "ft-tex" && kinds["refs.bib"] === "ft-bib" && kinds["style.sty"] === "ft-sty", JSON.stringify(kinds));
    const badges = await page.$$eval(".file-row .main-badge", (b) => b.map((e) => e.closest(".file-row").dataset.path));
    assert(badges.length === 1 && badges[0] === "main.tex", "one main badge: " + badges);
    assert(!(await page.$eval("#editor-main", (e) => e.hidden)), "editor header says main");
    assert((await page.textContent("#editor-tab")) === "main.tex", "tab text stays the path");
    // typing marks the row unsaved; Ctrl/Cmd+S saves and clears it
    await page.click("#source");
    await page.keyboard.press("End");
    await page.keyboard.type(" %edited");
    assert(await page.$eval('.file-row[data-path="main.tex"]', (r) => r.classList.contains("dirty")), "unsaved dot");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !document.querySelector('.file-row[data-path="main.tex"]').classList.contains("dirty"));
    const saved = (await apiFor(base)("GET", `/api/projects/${p.id}`)).files.find((f) => f.path === "main.tex").content;
    assert(saved.includes("%edited"), "Ctrl+S saved the file");
    // a sub-file: dimmed folder in the header, no main badge
    await page.click('.file-row[data-path="sections/more.tex"]');
    await page.waitForFunction(() => document.querySelector("#editor-tab").textContent === "sections/more.tex");
    assert(await page.$eval("#editor-main", (e) => e.hidden), "fragment is not main");
    assert((await page.textContent("#editor-tab .tab-dir")) === "sections/", "folder part");
  },

  async outline_lists_the_file_and_jumps({ page, base }) {
    await openProject(page, base, "UxOutline");
    const items = await page.$$eval("#outline-tree .ol-item", (els) => els.map((e) => [e.className.match(/kind-(\w+)/)[1], e.querySelector(".ol-title").textContent]));
    assert(JSON.stringify(items) === JSON.stringify([["heading", "Introduction"], ["heading", "Details"], ["figure", "A missing figure"], ["input", "sections/more.tex"]]),
      JSON.stringify(items));
    assert((await page.textContent("#outline-file")) === "main.tex", "header names the file");
    // click → caret on that line, item highlighted
    await page.click('#outline-tree .ol-item:has-text("Details")');
    assert((await caretLine(page)) === 5, "jumped to \\subsection");
    await page.waitForFunction(() => document.querySelector("#outline-tree .ol-item.active .ol-title").textContent === "Details");
    // moving the caret moves the highlight
    await page.evaluate(() => { const ta = document.querySelector("#source"); const i = ta.value.indexOf("\\caption"); ta.focus(); ta.setSelectionRange(i, i); });
    await page.waitForFunction(() => document.querySelector("#outline-tree .ol-item.active .ol-title").textContent === "A missing figure");
    // typing a section updates the outline
    await page.evaluate(() => { const ta = document.querySelector("#source"); const i = ta.value.indexOf("\\end{document}"); ta.focus(); ta.setSelectionRange(i, i); });
    await page.keyboard.type("\\section{Conclusion}\n");
    await page.waitForFunction(() => [...document.querySelectorAll("#outline-tree .ol-title")].some((e) => e.textContent === "Conclusion"));
    // an \input opens its file
    await page.click('#outline-tree .ol-item.kind-input');
    await page.waitForFunction(() => document.querySelector("#editor-tab").textContent === "sections/more.tex");
    await page.waitForFunction(() => document.querySelector("#outline-tree .ol-title").textContent === "More");
    // folding persists
    await page.click("#outline-toggle");
    assert(await page.$eval("#pane-outline", (e) => e.classList.contains("closed")), "folded");
    await page.reload();
    await page.click(".project-card >> text=UxOutline");
    await page.waitForSelector("#view-workspace:not([hidden])");
    assert(await page.$eval("#pane-outline", (e) => e.classList.contains("closed")), "stays folded");
    await page.click("#outline-toggle");
  },

  async gutter_numbers_wrapped_lines_and_status_bar({ page, base }) {
    await openProject(page, base, "UxGutter");
    await page.waitForFunction(() => document.querySelectorAll("#ed-gutter .ln").length === 13);
    const tops = await page.$$eval("#ed-gutter .ln", (els) => els.map((e) => parseFloat(e.style.top)));
    const row = tops[1] - tops[0];
    assert(row > 15 && row < 30, "one row: " + row);
    assert(tops[5] - tops[4] > row * 1.5, "the long line 5 wraps, so line 6 sits lower: " + (tops[5] - tops[4]));
    // numbers sit level with the text: line 6 (\subsection) starts where the gutter says
    const ok = await page.evaluate((top) => {
      const ta = document.querySelector("#source");
      const pad = parseFloat(getComputedStyle(ta).paddingLeft), gut = document.querySelector("#ed-gutter").offsetWidth;
      return pad > gut && top > 0;
    }, tops[5]);
    assert(ok, "text clears the gutter");
    // clicking a number selects the line; status bar follows the caret
    await page.click('#ed-gutter .ln[data-line="3"]');
    const sel = await page.$eval("#source", (ta) => ta.value.slice(ta.selectionStart, ta.selectionEnd));
    assert(sel === "\\section{Introduction}\\label{sec:intro}\n", JSON.stringify(sel));
    assert((await page.textContent("#st-sel")).includes("selected"), "selection count");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector("#st-pos").textContent === "Ln 5, Col 1");
    assert(await page.$eval('#ed-gutter .ln[data-line="4"]', (e) => e.classList.contains("cur")), "current number marked");
    assert(!(await page.$eval("#ed-curline", (e) => e.hidden)), "current-line band");
    assert((await page.textContent("#st-lines")) === "13 lines", await page.textContent("#st-lines"));
    await page.waitForFunction(() => /\d+ words/.test(document.querySelector("#st-words").textContent));
    assert((await page.textContent("#st-root")) === "Main file", "root status");
    // scrolling keeps the gutter aligned with the text
    await page.setViewportSize({ width: 1440, height: 360 });
    const top = await page.$eval("#source", (ta) => { ta.scrollTop = 120; ta.dispatchEvent(new Event("scroll")); return ta.scrollTop; });
    assert(top > 0, "scrolled");
    const shift = await page.$eval("#ed-gutter-in", (e) => e.style.transform);
    assert(shift === `translateY(${-top}px)`, shift + " vs " + top);
  },

  async theme_menu_switches_in_one_click_and_persists({ page, base }) {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(base + "/");
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await bg();
    const pick = async (choice) => {
      await page.click("#btn-theme");
      await page.waitForSelector("#theme-menu:not([hidden])");
      await page.click(`#theme-menu [data-theme-choice="${choice}"]`);
      assert(await page.$eval("#theme-menu", (m) => m.hidden), "menu closes after a pick");
    };
    assert((await page.getAttribute("#btn-theme", "data-choice")) === "system", "starts on system");
    // one pick turns the page dark, even when the system is light (the old
    // cycle went System → Light first, which looked like nothing happened)
    await pick("dark");
    assert((await page.getAttribute("html", "data-theme")) === "dark", "dark pinned");
    assert((await bg()) !== light, "dark background");
    await page.click("#btn-theme");
    assert((await page.getAttribute('#theme-menu [data-theme-choice="dark"]', "aria-checked")) === "true", "current choice ticked");
    await page.keyboard.press("Escape");
    assert(await page.$eval("#theme-menu", (m) => m.hidden), "Esc closes the menu");
    await page.reload();
    assert((await page.getAttribute("html", "data-theme")) === "dark" && (await bg()) !== light, "persists across reloads");
    // keyboard: open, arrow to Light, Enter
    await page.focus("#btn-theme");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement.dataset.themeChoice === "dark");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    assert((await page.getAttribute("html", "data-theme")) === "light" && (await bg()) === light, "light by keyboard");
    // System follows the computer
    await pick("system");
    assert((await page.getAttribute("html", "data-theme")) === null && (await bg()) === light, "system (light)");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction((l) => getComputedStyle(document.body).backgroundColor !== l, light);
    // a click elsewhere closes the menu
    await page.click("#btn-theme");
    await page.mouse.click(400, 500);
    assert(await page.$eval("#theme-menu", (m) => m.hidden), "outside click closes");
  },

  async shortcuts_dialog_opens_with_question_mark({ page, base }) {
    await openProject(page, base, "UxKeys");
    // typing "?" in the editor is text, not the shortcut
    await page.click("#source");
    await page.keyboard.type("?");
    assert(await page.$eval("#shortcuts-modal", (m) => m.hidden), "not while typing");
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("?");
    await page.waitForSelector("#shortcuts-modal:not([hidden])");
    assert((await page.textContent("#shortcuts-modal")).includes("Save the file"), "lists shortcuts");
    await page.keyboard.press("Escape");
    assert(await page.$eval("#shortcuts-modal", (m) => m.hidden), "Esc closes");
    await page.click("#btn-shortcuts");
    await page.waitForSelector("#shortcuts-modal:not([hidden])");
    await page.click("#shortcuts-close");
  },

  async narrow_window_folds_panels_without_saving({ page, base }) {
    await openProject(page, base, "UxNarrow");
    const collapsed = (n) => page.$eval(`#pane-${n}`, (e) => e.classList.contains("collapsed"));
    const saved = () => page.evaluate(() => localStorage.getItem("tw_layout"));
    const before = await saved();
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForFunction(() => document.querySelector("#pane-report").classList.contains("collapsed"));
    assert(!(await collapsed("files")), "files stay at 1000px");
    await page.setViewportSize({ width: 760, height: 800 });
    await page.waitForFunction(() => document.querySelector("#pane-files").classList.contains("collapsed"));
    assert((await saved()) === before, "layout not saved by the fold");
    // opening a folded panel by hand keeps it open while narrow
    await page.click('#pane-report [data-expand="report"]');
    assert(!(await collapsed("report")), "expanded by hand");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => !document.querySelector("#pane-files").classList.contains("collapsed"));
    assert(!(await collapsed("report")), "both back when wide");
  },

  async settings_summary_and_missing_image_placeholder({ page, base, errors }) {
    await openProject(page, base, "UxMisc");
    await page.click('.tab[data-rtab="report"]');
    assert((await page.textContent("#settings-sum")).startsWith("1 column"), await page.textContent("#settings-sum"));
    await page.click("#conv-settings summary");
    await page.fill("#opt-columns", "2");
    await page.check("#opt-section");
    const sum = await page.textContent("#settings-sum");
    assert(sum.startsWith("2 columns") && sum.includes("numbered by section"), sum);
    // preview: the missing figure gets a placeholder, not a broken image
    await page.click("#btn-toggle-preview");
    await page.waitForSelector("#preview-doc .fig-missing", { timeout: 15000 });
    assert((await page.textContent("#preview-doc .fig-missing code")) === "figures/missing.png", "names the file");
    assert(!(await page.$("#preview-doc img.fig-img")), "no broken <img> left");
    // the browser logs the image's 404 itself; that one is expected here
    for (let i = errors.length - 1; i >= 0; i--) if (/status of 404/.test(errors[i])) errors.splice(i, 1);
    // project cards say how long ago
    await page.click("#crumb-home");
    await page.waitForSelector(".project-card");
    assert(/updated (just now|\d+ min ago)/.test(await page.textContent('.project-card:has-text("UxMisc") .tag-time')), "relative time");
  },
};
