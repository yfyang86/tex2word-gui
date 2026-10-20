// Collapsible / resizable side panels.
"use strict";
const { apiFor, assert } = require("./harness");

async function openAny(page, base) {
  const api = apiFor(base);
  const p = await api("POST", "/api/projects", {
    name: "Panels", files: { "main.tex": "\\documentclass{article}\\begin{document}Hi.\\end{document}" },
  });
  await page.goto(base + "/");
  await page.evaluate(() => localStorage.removeItem("tw_layout"));
  await page.goto(base + "/");
  await page.click(`.project-card >> text=Panels`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  return p;
}
const width = (page, sel) => page.$eval(sel, (el) => Math.round(el.getBoundingClientRect().width));

module.exports = {
  async collapse_expand_buttons({ page, base }) {
    await openAny(page, base);
    const editor0 = await width(page, ".pane.editor");
    await page.click('[data-collapse="files"]');
    assert(await page.$eval("#pane-files", (e) => e.classList.contains("collapsed")), "files collapsed");
    assert((await width(page, "#pane-files")) <= 40, "rail is narrow");
    await page.click('[data-collapse="report"]');
    const editor1 = await width(page, ".pane.editor");
    assert(editor1 > editor0 + 450, `editor grew ${editor0} → ${editor1}`);
    // rail tab button expands the right pane on that tab
    await page.click('.rail-tab[data-tab="structure"]');
    assert(!(await page.$eval("#pane-report", (e) => e.classList.contains("collapsed"))), "report expanded");
    assert(await page.$eval("#tab-structure", (e) => !e.hidden), "structure tab shown");
    await page.click('#pane-files [data-expand="files"].icon-btn');
    assert((await width(page, "#pane-files")) > 150, "files expanded");
  },

  async keyboard_shortcuts_and_persistence({ page, base }) {
    await openAny(page, base);
    await page.click("#source");
    await page.keyboard.press("Control+b");
    assert(await page.$eval("#pane-files", (e) => e.classList.contains("collapsed")), "Ctrl+B hides files");
    await page.keyboard.press("Control+Alt+b");
    assert(await page.$eval("#pane-report", (e) => e.classList.contains("collapsed")), "Ctrl+Alt+B hides report");
    await page.reload();
    await page.click(`.project-card >> text=Panels`);
    await page.waitForSelector("#view-workspace:not([hidden])");
    assert(await page.$eval("#pane-files", (e) => e.classList.contains("collapsed")), "collapse persisted");
    await page.keyboard.press("Control+b");
    assert(!(await page.$eval("#pane-files", (e) => e.classList.contains("collapsed"))), "Ctrl+B shows files again");
  },

  async drag_resize_clamped({ page, base }) {
    await openAny(page, base);
    const h = await page.$('[data-resize="files"]');
    const box = await h.boundingBox();
    await page.mouse.move(box.x + 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 200, { steps: 5 });
    await page.mouse.up();
    const w = await width(page, "#pane-files");
    assert(w > 330 && w < 360, "files widened to ~350: " + w);
    // past the limit → clamped
    const box2 = await (await page.$('[data-resize="report"]')).boundingBox();
    await page.mouse.move(box2.x + 2, box2.y + 200);
    await page.mouse.down();
    await page.mouse.move(box2.x + 900, box2.y + 200, { steps: 5 });
    await page.mouse.up();
    assert((await width(page, "#pane-report")) === 280, "report clamped to its minimum");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tw_layout")));
    assert(saved.files.width === w && saved.report.width === 280, "widths persisted");
    // double-click hides
    await page.dblclick('[data-resize="files"]');
    assert(await page.$eval("#pane-files", (e) => e.classList.contains("collapsed")), "dblclick collapses");
  },
};
