// Tab key map, environment expansion, symbol palette and popup previews.
"use strict";
const { apiFor, assert } = require("./harness");

const FILES = {
  "main.tex": String.raw`\documentclass{article}
\usepackage{amsmath,amssymb,xcolor}
\newcommand{\norm}[2][2]{\left\| #2 \right\|_{#1}}
\definecolor{brand}{HTML}{D92B2B}
\begin{document}
\section{Results}
WRITE_HERE
\end{document}
`,
};

async function openAt(page, base, name) {
  await apiFor(base)("POST", "/api/projects", { name, main_path: "main.tex", files: FILES });
  await page.goto(base + "/");
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#source").value.includes("WRITE_HERE"));
  await page.evaluate(() => {
    const ta = document.querySelector("#source");
    const i = ta.value.indexOf("WRITE_HERE");
    ta.focus(); ta.setSelectionRange(i, i + "WRITE_HERE".length);
    document.execCommand("delete");
  });
}

const value = (page) => page.$eval("#source", (ta) => ta.value);
const around = async (page) => page.$eval("#source", (ta) => {
  const i = ta.value.indexOf("\\section{Results}\n") + "\\section{Results}\n".length;
  return ta.value.slice(i, ta.value.indexOf("\\end{document}"));
});
const selected = (page) => page.$eval("#source", (ta) => ta.value.slice(ta.selectionStart, ta.selectionEnd));
const popupOpen = (page) => page.$eval("#ed-ac", (e) => !e.hidden);
const popupLabels = (page) => page.$$eval("#ed-ac:not([hidden]) .ed-ac-label", (els) => els.map((e) => e.textContent));
const focused = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

module.exports = {
  async tab_completes_a_unique_command({ page, base }) {
    await openAt(page, base, "TabUnique");
    await page.keyboard.type("$\\varnoth");
    await page.keyboard.press("Escape");          // closes the as-you-type popup only
    await page.keyboard.press("Tab");             // unique match → completed in place
    assert((await around(page)).startsWith("$\\varnothing"), "unique match completed: " + (await around(page)));
    assert(!(await popupOpen(page)), "no popup for a unique completion");
    assert((await focused(page)) === "source", "focus stays in the editor");
    // Esc (nothing open) then Tab: leave the editor — no keyboard trap
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    assert((await focused(page)) !== "source", "Esc then Tab moves focus out");
    assert((await around(page)) === "$\\varnothing\n", "the escaping Tab inserted nothing: " + JSON.stringify(await around(page)));
    // …and backwards: Esc then Shift+Tab (the Shift keydown must not disarm it)
    await page.focus("#source");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+Tab");
    assert((await focused(page)) !== "source", "Esc then Shift+Tab moves focus out");
    assert((await around(page)) === "$\\varnothing\n", "nothing outdented");
  },

  async tab_opens_the_list_then_accepts({ page, base }) {
    await openAt(page, base, "TabList");
    await page.keyboard.type("$\\lo");
    await page.keyboard.press("Escape");          // popup closed: Tab must reopen it
    assert(!(await popupOpen(page)), "closed");
    await page.keyboard.press("Tab");
    assert(await popupOpen(page), "Tab opened the list for an ambiguous prefix");
    const labels = await popupLabels(page);
    assert(labels.includes("\\longrightarrow") && labels.includes("\\log"), "candidates: " + labels.slice(0, 6));
    await page.keyboard.press("ArrowDown");
    const second = labels[1];
    await page.keyboard.press("Tab");
    assert((await around(page)).startsWith("$" + second), `accepted ${second}: ` + (await around(page)));
  },

  async tab_through_snippet_stops_and_shift_tab_back({ page, base }) {
    await openAt(page, base, "TabSnip");
    await page.keyboard.type("$\\frac");
    await page.keyboard.press("Tab");             // popup open → accept \frac
    assert((await selected(page)) === "num", "first stop");
    await page.keyboard.press("Tab");
    assert((await selected(page)) === "den", "second stop");
    await page.keyboard.press("Shift+Tab");
    assert((await selected(page)) === "num", "Shift+Tab went back");
    await page.keyboard.type("1");
    await page.keyboard.press("Tab");
    await page.keyboard.type("2");
    await page.keyboard.press("Tab");             // past the last stop: leaves the snippet
    await page.keyboard.type("$ ok");
    assert((await around(page)).startsWith("$\\frac{1}{2}$ ok"), await around(page));
  },

  async environment_word_plus_tab_expands_a_block({ page, base }) {
    await openAt(page, base, "TabEnv");
    await page.evaluate(() => document.execCommand("insertText", false, "  itemize"));
    await page.keyboard.press("Tab");
    await page.keyboard.type("one");
    assert((await around(page)).startsWith("  \\begin{itemize}\n    \\item one\n  \\end{itemize}"),
           JSON.stringify(await around(page)));
    // a word that is not an environment just gets indentation
    await page.keyboard.press("Control+End");
    await page.evaluate(() => document.execCommand("insertText", false, "\nprose"));
    await page.keyboard.press("Tab");
    assert((await value(page)).includes("\nprose  "), "plain Tab indents");
  },

  async indent_and_outdent_selected_lines({ page, base }) {
    await openAt(page, base, "TabIndent");
    await page.evaluate(() => document.execCommand("insertText", false, "a\nb\nc"));
    await page.evaluate(() => {
      const ta = document.querySelector("#source");
      const i = ta.value.indexOf("a\nb\nc");
      ta.setSelectionRange(i, i + 5);
    });
    await page.keyboard.press("Tab");
    assert((await around(page)).startsWith("  a\n  b\n  c"), JSON.stringify(await around(page)));
    assert((await selected(page)) === "  a\n  b\n  c", "block stays selected");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");       // nothing left to remove: no-op
    assert((await around(page)).startsWith("a\nb\nc"), JSON.stringify(await around(page)));
    await page.keyboard.press("Control+z");
    assert((await around(page)).startsWith("  a\n  b\n  c"), "outdent is undoable");
  },

  async modified_tab_and_composition_are_not_captured({ page, base }) {
    await openAt(page, base, "TabMods");
    const before = await value(page);
    const prevented = await page.evaluate(() => {
      const ta = document.querySelector("#source");
      const out = {};
      for (const [k, init] of Object.entries({
        ctrl: { key: "Tab", ctrlKey: true }, alt: { key: "Tab", altKey: true },
        ime: { key: "Tab", isComposing: true },
      })) {
        const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
        ta.dispatchEvent(ev);
        out[k] = ev.defaultPrevented;
      }
      return out;
    });
    assert(!prevented.ctrl && !prevented.alt && !prevented.ime, JSON.stringify(prevented));
    assert((await value(page)) === before, "text unchanged");
  },

  async popup_shows_symbol_svgs_and_colour_swatches({ page, base }) {
    await openAt(page, base, "TabIcons");
    await page.keyboard.type("$\\Righta");
    await page.waitForSelector("#ed-ac:not([hidden])");
    const href = await page.getAttribute("#ed-ac .ed-ac-item.active .ed-ac-icon use", "href");
    assert(href === "/static/symbols.svg#s-Rightarrow", "symbol preview: " + href);
    const drawn = await page.$eval("#ed-ac .ed-ac-item.active .ed-ac-icon svg", (el) => el.getBoundingClientRect().width);
    assert(drawn >= 16, "svg rendered at size");
    await page.keyboard.press("Escape");
    await page.keyboard.type("$ \\textcolor{br");
    await page.waitForSelector("#ed-ac:not([hidden])");
    assert((await popupLabels(page))[0] === "brand", "project colour first");
    const sw = await page.$eval("#ed-ac .ed-ac-item.active .ed-ac-swatch", (el) => getComputedStyle(el).backgroundColor);
    assert(sw === "rgb(217, 43, 43)", "swatch colour: " + sw);
    await page.keyboard.press("Tab");
    assert((await around(page)).includes("\\textcolor{brand}"), "colour inserted with its brace");
  },

  async macro_with_optional_argument_and_label_suggestion({ page, base }) {
    await openAt(page, base, "TabMacro");
    await page.keyboard.type("$\\nor");
    await page.waitForSelector("#ed-ac:not([hidden])");
    const detail = await page.textContent("#ed-ac .ed-ac-item.active .ed-ac-detail");
    assert(/1 optional.*\\left/.test(detail), "macro detail: " + detail);
    await page.keyboard.press("Tab");
    assert((await selected(page)) === "#2", "only the mandatory argument is asked for");
    await page.keyboard.type("x");
    await page.keyboard.press("Tab");
    await page.keyboard.type("$\n\\label{");
    await page.waitForSelector("#ed-ac:not([hidden])");
    assert((await popupLabels(page))[0] === "sec:results", "label from the heading");
  },

  async symbol_palette_inserts_and_wraps_math({ page, base }) {
    await openAt(page, base, "TabPalette");
    await page.keyboard.type("Let ");
    await page.click("#btn-symbols");
    assert(await page.$eval("#sym-panel", (e) => !e.hidden), "palette open");
    assert((await focused(page)) === "sym-search", "search focused");
    const n = await page.$$eval("#sym-grid .sym-btn", (els) => els.length);
    assert(n >= 200, "all symbols listed: " + n);
    await page.fill("#sym-search", "lambda");
    await page.keyboard.press("Enter");          // first match
    assert((await around(page)).startsWith("Let $\\lambda$"), "wrapped outside math: " + (await around(page)));
    await page.click('#sym-tabs .sym-tab >> text=Recent');
    assert(await page.$('#sym-grid .sym-btn[data-cmd="lambda"]'), "recent row remembers it");
    // inside math: no wrapping
    await page.focus("#source");
    await page.keyboard.press("End");
    await page.keyboard.type(" and $x ");
    await page.click('#sym-tabs .sym-tab >> text=Relations');
    await page.click('#sym-grid .sym-btn[data-cmd="leq"]');
    assert((await around(page)).includes("and $x \\leq"), "inserted bare inside math: " + (await around(page)));
    // Esc closes and returns to the editor
    await page.click("#sym-search");
    await page.keyboard.press("Escape");
    assert(await page.$eval("#sym-panel", (e) => e.hidden), "closed");
    assert((await focused(page)) === "source", "focus back in the editor");
  },
};
