// Editor autocompletion driven through the real textarea with the keyboard.
"use strict";
const { apiFor, assert } = require("./harness");

const FILES = {
  "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath,natbib}
\newcommand{\vect}[1]{\mathbf{#1}}
\begin{document}
\section{Intro}\label{sec:intro}
\input{sections/method}
\bibliographystyle{plainnat}
\bibliography{refs}
\end{document}
`,
  "sections/method.tex": String.raw`\section{Method}\label{sec:method}
\begin{figure}\caption{Pipeline overview}\label{fig:pipe}\end{figure}
WRITE_HERE
`,
  "refs.bib": "@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish and Shazeer, Noam}, year={2017}}\n",
};

async function openAt(page, base, name) {
  const api = apiFor(base);
  await api("POST", "/api/projects", { name, main_path: "main.tex", files: FILES });
  await page.goto(base + "/");
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  await page.click(".file-row >> text=method.tex");
  await page.waitForFunction(() => document.querySelector("#source").value.includes("WRITE_HERE"));
  // replace the marker line with nothing and park the caret there
  await page.evaluate(() => {
    const ta = document.querySelector("#source");
    const i = ta.value.indexOf("WRITE_HERE");
    ta.focus(); ta.setSelectionRange(i, i + "WRITE_HERE".length);
    document.execCommand("delete");
  });
}

const value = (page) => page.$eval("#source", (ta) => ta.value);
const selected = (page) => page.$eval("#source", (ta) => ta.value.slice(ta.selectionStart, ta.selectionEnd));
const popupLabels = (page) => page.$$eval("#ed-ac:not([hidden]) .ed-ac-label", (els) => els.map((e) => e.textContent));
const popupOpen = (page) => page.$eval("#ed-ac", (e) => !e.hidden);

module.exports = {
  async ref_lists_labels_across_files({ page, base }) {
    await openAt(page, base, "AcRef");
    await page.keyboard.type("See Figure~\\ref{");
    await page.waitForSelector("#ed-ac:not([hidden])");
    const labels = await popupLabels(page);
    assert(labels.includes("fig:pipe") && labels.includes("sec:intro"), "labels from both files: " + labels);
    await page.keyboard.type("pip");
    assert((await popupLabels(page))[0] === "fig:pipe", "filtered to fig:pipe");
    const detail = await page.textContent("#ed-ac .ed-ac-item.active .ed-ac-detail");
    assert(/figure · Pipeline overview/.test(detail), "shows what it labels: " + detail);
    await page.keyboard.press("Enter");
    assert((await value(page)).includes("See Figure~\\ref{fig:pipe}"), "inserted the key");
    assert(!(await popupOpen(page)), "popup closed");
  },

  async cite_lists_bib_entries({ page, base }) {
    await openAt(page, base, "AcCite");
    await page.keyboard.type("as shown \\citep{atten");
    await page.waitForSelector("#ed-ac:not([hidden])");
    assert((await popupLabels(page))[0] === "vaswani2017", "title search finds the key");
    await page.keyboard.press("Tab");
    assert((await value(page)).includes("\\citep{vaswani2017}"), "inserted the cite key");
  },

  async command_snippet_with_tabstops({ page, base }) {
    await openAt(page, base, "AcSnip");
    await page.keyboard.type("$x = \\fra");
    await page.waitForSelector("#ed-ac:not([hidden])");
    assert((await popupLabels(page))[0] === "\\frac", "\\frac first in math");
    await page.keyboard.press("Enter");
    assert((await selected(page)) === "num", "first placeholder selected");
    await page.keyboard.type("a+1");
    await page.keyboard.press("Tab");
    assert((await selected(page)) === "den", "second placeholder selected");
    await page.keyboard.type("2");
    await page.keyboard.press("Tab");
    await page.keyboard.type("$.");
    assert((await value(page)).includes("$x = \\frac{a+1}{2}$."), "snippet filled: " + (await value(page)).slice(-40));
    // undo restores the text before the insertion (native undo stack is kept)
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    assert(!(await value(page)).includes("\\frac{a+1}"), "undo works through completions");
  },

  async project_macro_and_environment_blocks({ page, base }) {
    await openAt(page, base, "AcEnv");
    await page.keyboard.type("\\vec");
    await page.waitForSelector("#ed-ac:not([hidden])");
    const labels = await popupLabels(page);
    assert(labels.slice(0, 3).includes("\\vect"), "project macro offered: " + labels.slice(0, 5));
    await page.keyboard.press("Escape");
    assert(!(await popupOpen(page)), "Esc closes");
    await page.keyboard.type("\n\\begin{enum");
    await page.waitForSelector("#ed-ac:not([hidden])");
    await page.keyboard.press("Enter");
    await page.keyboard.type("first");
    const v = await value(page);
    assert(/\\begin\{enumerate\}\n  \\item first\n\\end\{enumerate\}/.test(v), "list block inserted: " + JSON.stringify(v.slice(-60)));
  },

  async enter_after_begin_adds_end({ page, base }) {
    await openAt(page, base, "AcEnd");
    await page.keyboard.type("\\begin{center}");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type("middle");
    assert((await value(page)).includes("\\begin{center}\n  middle\n\\end{center}"), "auto \\end");
    // …but not when the environment is already closed
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n\\begin{quote}");
    await page.keyboard.press("Escape");
    await page.keyboard.type("\\end{quote}");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Home");
    const before = (await value(page)).split("\\end{quote}").length;
    await page.keyboard.press("End");
    assert((await value(page)).split("\\end{quote}").length === before, "no duplicate \\end");
  },

  async end_suggests_the_open_environment_and_ctrl_space({ page, base }) {
    await openAt(page, base, "AcOpen");
    await page.keyboard.type("\\begin{quote}");
    await page.keyboard.press("Escape");
    await page.keyboard.type(" text \\end{");
    await page.waitForSelector("#ed-ac:not([hidden])");
    assert((await popupLabels(page))[0] === "quote", "open env first");
    await page.keyboard.press("Enter");
    assert((await value(page)).includes("text \\end{quote}"), "closed it");
    await page.keyboard.type(" \\");
    assert(!(await popupOpen(page)), "a lone backslash does not pop up");
    await page.keyboard.press("Control+Space");
    await page.waitForSelector("#ed-ac:not([hidden])");
    assert((await popupLabels(page)).length > 10, "Ctrl+Space lists commands");
  },

  async unknown_refs_and_cites_are_underlined({ page, base }) {
    await openAt(page, base, "AcLint");
    await page.keyboard.type("Known \\ref{sec:intro}, missing \\ref{sec:nope}, \\cite{vaswani2017,ghost2020}.");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll("#highlight .hl-undef").length === 2, null, { timeout: 3000 });
    const bad = await page.$$eval("#highlight .hl-undef", (els) => els.map((e) => e.textContent.trim()));
    assert(bad.join("|") === "sec:nope|ghost2020", "flagged: " + bad);
    // the overlay text stays identical to the textarea (alignment)
    assert(await page.evaluate(() => document.querySelector("#highlight").textContent.trimEnd() ===
                                       document.querySelector("#source").value.trimEnd()), "overlay text matches");
  },
};
