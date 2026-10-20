// Smoke test of the core workspace flows against the installed tex2word.
"use strict";
const { apiFor, assert } = require("./harness");

const MAIN = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Smoke Paper}
\begin{document}
\maketitle
\section{Introduction}\label{sec:intro}
Energy is $E=mc^2$, see Section~\ref{sec:method}.
\input{sections/method}
\end{document}
`;
const METHOD = String.raw`\section{Method}\label{sec:method}
We integrate:
\begin{equation}\label{eq:int}
  \int_0^1 x^2 \, dx = \frac{1}{3}.
\end{equation}
`;

module.exports = {
  async health_shows_engine_version({ page, base }) {
    const h = await (await fetch(base + "/api/health")).json();
    await page.goto(base + "/");
    await page.waitForFunction(() => /tex2word \d/.test(document.querySelector("#version-chip").textContent));
    const chip = await page.textContent("#version-chip");
    assert(chip.includes(h.tex2word_version), `chip ${chip} vs ${h.tex2word_version}`);
  },

  async new_project_preview_and_convert({ page, base }) {
    await page.goto(base + "/");
    await page.click("#btn-new");
    await page.fill("#modal-input", "E2E smoke");
    await page.click("#modal-ok");
    await page.waitForSelector("#view-workspace:not([hidden])");
    await page.waitForFunction(() => document.querySelector("#source").value.includes("\\documentclass"));
    await page.click("#btn-toggle-preview");
    await page.waitForSelector("#preview-doc h1, #preview-doc h2");
    assert(await page.$("#preview-doc math"), "preview has MathML");
    await page.click("#btn-convert");
    await page.waitForSelector("#result-slot a[download]", { timeout: 30000 });
    const href = await page.getAttribute("#result-slot a[download]", "href");
    const buf = Buffer.from(await (await fetch(base + href)).arrayBuffer());
    assert(buf.subarray(0, 2).toString() === "PK", ".docx is a zip");
  },

  async multifile_project_resolves_input({ page, base }) {
    const api = apiFor(base);
    const p = await api("POST", "/api/projects", {
      name: "Multi", main_path: "main.tex",
      files: { "main.tex": MAIN, "sections/method.tex": METHOD },
    });
    const pv = await api("POST", `/api/projects/${p.id}/preview`, {});
    assert(pv.outline.some((o) => o.text === "Method"), "sub-file section in outline");
    assert(pv.html.includes('href="#sec_method">2<'), "forward ref resolved across files");
    await page.goto(base + "/");
    await page.click(`.project-card >> text=Multi`);
    await page.waitForSelector("#view-workspace:not([hidden])");
    await page.click("#btn-toggle-preview");
    await page.waitForSelector("#preview-doc h1:not(.doc-title)");
    const heads = await page.$$eval("#preview-doc h1:not(.doc-title)", (els) => els.map((e) => e.textContent));
    assert(heads.some((t) => t.includes("Method")), "preview shows the \\input file: " + heads);
  },

  async markdown_import_and_roundtrip({ base }) {
    const api = apiFor(base);
    const p = await api("POST", "/api/projects/import/markdown",
      { name: "MD", markdown: "# Title\n\nSome *text* and $x^2$.\n\n## Part\n\nMore." });
    assert(p.files.some((f) => f.path.endsWith(".tex")), "markdown produced a .tex");
    const conv = await api("POST", `/api/projects/${p.id}/convert`, {});
    const docx = await (await fetch(base + conv.download_url)).arrayBuffer();
    const fd = new FormData();
    fd.append("file", new Blob([docx]), "x.docx");
    const r = await fetch(base + "/api/to-latex", { method: "POST", body: fd });
    const j = await r.json();
    assert(r.ok && j.latex.includes("\\section"), "round-trip recovered LaTeX");
  },

  async coverage_dashboard({ page, base }) {
    await page.goto(base + "/");
    await page.click("#btn-coverage");
    await page.waitForSelector("#cov-aggregate .cov-card", { timeout: 60000 });
    const txt = await page.textContent("#cov-aggregate");
    assert(/converted/.test(txt), "coverage cards render");
  },
};
