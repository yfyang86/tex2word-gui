// Multi-file source ⇄ preview sync, sticky render root, quick/full preview.
"use strict";
const { apiFor, assert } = require("./harness");

const FILES = {
  "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Sync Paper}
\begin{document}
\maketitle

\section{Introduction}\label{sec:intro}
Intro paragraph one, see Section~\ref{sec:method}.

\input{sections/method}
\input{sections/results}

\section{Conclusion}
Closing remarks.
\end{document}
`,
  "sections/method.tex": String.raw`\section{Method}\label{sec:method}
Method paragraph line one
continues on line three.

\begin{equation}\label{eq:a}
  y = Wx + b
\end{equation}

\begin{itemize}
  \item First point of the method.
  \item Second point.
\end{itemize}
` + Array.from({ length: 30 }, (_, i) => `\nFiller paragraph ${i} with some words to make the document long enough to scroll.\n`).join(""),
  "sections/results.tex": String.raw`\section{Results}\label{sec:results}
Final words of the results.

Another results paragraph.
`,
};

async function open(page, base, name) {
  const api = apiFor(base);
  const p = await api("POST", "/api/projects", { name, main_path: "main.tex", files: FILES });
  await page.goto(base + "/");
  await page.evaluate(() => { localStorage.removeItem("tw_preview_mode"); localStorage.removeItem("tw_layout"); });
  await page.goto(base + "/");
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  await page.click("#btn-toggle-preview");
  await page.waitForSelector("#preview-doc [data-src]");
  return p;
}

const status = (page) => page.textContent("#preview-status");
const activeFile = (page) => page.textContent("#editor-tab");
const caretLine = (page) => page.$eval("#source", (ta) => ta.value.slice(0, ta.selectionStart).split("\n").length);

async function openTreeFile(page, name) {
  await page.click(`.file-row >> text=${name}`);
  await page.waitForFunction((n) => document.querySelector("#editor-tab").textContent.endsWith(n), name);
}

async function placeCaret(page, needle) {
  await page.evaluate((needle) => {
    const ta = document.querySelector("#source");
    const idx = ta.value.indexOf(needle);
    ta.focus(); ta.setSelectionRange(idx, idx);
    ta.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, needle);
}

// Is the element containing `text` inside the preview viewport?
const visibleInPreview = (page, text) => page.evaluate((text) => {
  const pv = document.querySelector("#preview-doc");
  const el = [...pv.querySelectorAll("p, li, h1, h2, figcaption")].find((e) => e.textContent.includes(text));
  if (!el) return false;
  const r = el.getBoundingClientRect(), v = pv.getBoundingClientRect();
  return r.top >= v.top - 2 && r.bottom <= v.bottom + 2;
}, text);

module.exports = {
  async subfile_keeps_the_whole_document_as_root({ page, base }) {
    await open(page, base, "SyncRoot");
    assert((await status(page)).startsWith("full"), "first render is full");
    const rev0 = await page.evaluate(() => state.previewRev);
    await openTreeFile(page, "method.tex");
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => state.previewRev) === rev0, "opening a fragment does not re-render");
    const heads = await page.$$eval("#preview-doc h1:not(.doc-title)", (els) => els.map((e) => e.textContent));
    assert(heads.some((h) => h.includes("Introduction")) && heads.some((h) => h.includes("Method")),
           "preview still shows the whole document: " + heads);
    assert(await page.$eval(".file-row.active", (e) => !e.querySelector(".main-badge")), "fragment is not marked main");
  },

  async editor_click_scrolls_preview_in_a_subfile({ page, base }) {
    await open(page, base, "SyncE2P");
    await openTreeFile(page, "method.tex");
    await placeCaret(page, "Filler paragraph 25");
    await page.waitForTimeout(250);
    assert(await visibleInPreview(page, "Filler paragraph 25"), "preview scrolled to the sub-file paragraph");
    await placeCaret(page, "First point");
    await page.waitForTimeout(250);
    assert(await visibleInPreview(page, "First point"), "preview scrolled to the list item");
  },

  async preview_click_opens_the_right_file_and_line({ page, base }) {
    await open(page, base, "SyncP2E");
    assert((await activeFile(page)) === "main.tex", "starts in main.tex");
    const el = await page.$("#preview-doc li >> text=First point");
    await el.scrollIntoViewIfNeeded();
    await el.click();
    await page.waitForFunction(() => document.querySelector("#editor-tab").textContent === "sections/method.tex");
    const want = FILES["sections/method.tex"].split("\n").findIndex((l) => l.includes("First point")) + 1;
    assert((await caretLine(page)) === want, `caret on line ${want}, got ${await caretLine(page)}`);
    // and back into main.tex
    const intro = await page.$("#preview-doc p >> text=Intro paragraph one");
    await intro.scrollIntoViewIfNeeded();
    await intro.click();
    await page.waitForFunction(() => document.querySelector("#editor-tab").textContent === "main.tex");
    assert((await caretLine(page)) === 8, "caret on main.tex line 8, got " + (await caretLine(page)));
  },

  async quick_mode_patches_only_the_edited_block({ page, base }) {
    await open(page, base, "SyncQuick");
    assert(await page.$eval('[data-pmode="quick"]', (b) => b.classList.contains("active")), "quick is the default");
    // tag every preview block so we can tell which DOM nodes were replaced
    await page.evaluate(() => [...document.querySelector("#preview-doc").children].forEach((el) => { el.__kept = true; }));
    await openTreeFile(page, "results.tex");
    await placeCaret(page, "Final words");
    await page.keyboard.type("Very ");
    await page.waitForFunction(() => /^quick/.test(document.querySelector("#preview-status").textContent), null, { timeout: 5000 });
    const res = await page.evaluate(() => {
      const kids = [...document.querySelector("#preview-doc").children];
      return { replaced: kids.filter((e) => !e.__kept).map((e) => e.textContent.slice(0, 40)), total: kids.length };
    });
    assert(res.replaced.length === 1 && res.replaced[0].includes("Very Final words"),
           "only the edited paragraph was replaced: " + JSON.stringify(res));
    assert(/ 1\/\d+$/.test(await status(page)), "status reports 1 changed block: " + (await status(page)));
    // the background reconcile (full parse) keeps the untouched nodes too
    await page.waitForFunction(() => /^full/.test(document.querySelector("#preview-status").textContent), null, { timeout: 8000 });
    const kept = await page.evaluate(() => [...document.querySelector("#preview-doc").children].filter((e) => e.__kept).length);
    assert(kept === res.total - 1, `reconcile kept ${kept}/${res.total - 1} nodes`);
  },

  async full_mode_rerenders_everything({ page, base }) {
    await open(page, base, "SyncFull");
    await page.click('[data-pmode="full"]');
    await page.evaluate(() => [...document.querySelector("#preview-doc").children].forEach((el) => { el.__kept = true; }));
    await openTreeFile(page, "results.tex");
    await placeCaret(page, "Another results");
    await page.keyboard.type("Yet ");
    await page.waitForFunction(() => document.querySelector("#preview-doc").textContent.includes("Yet Another"), null, { timeout: 5000 });
    assert((await status(page)).startsWith("full"), "full mode status");
    const kept = await page.evaluate(() => [...document.querySelector("#preview-doc").children].filter((e) => e.__kept).length);
    assert(kept === 0, "full mode replaced the whole DOM");
    await page.reload();
    await page.click(`.project-card >> text=SyncFull`);
    await page.waitForSelector("#view-workspace:not([hidden])");
    assert(await page.$eval('[data-pmode="full"]', (b) => b.classList.contains("active")), "mode persisted");
  },

  async quick_fallback_explains_why({ page, base }) {
    await open(page, base, "SyncFallback");
    await placeCaret(page, "Sync Paper}");
    await page.keyboard.type("X");  // a preamble edit cannot be applied locally
    await page.waitForFunction(() => document.querySelector("#preview-status").classList.contains("fell-back"), null, { timeout: 5000 });
    const title = await page.getAttribute("#preview-status", "title");
    assert(/preamble/.test(title), "tooltip explains the fallback: " + title);
    assert((await page.textContent("#preview-doc .doc-title")).includes("XSync"), "title updated");
  },
};
