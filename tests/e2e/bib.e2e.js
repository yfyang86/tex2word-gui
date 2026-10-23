// Reference manager: the left panel's References list (filter, click to cite,
// missing keys) and the manager dialog (edit, key rename following \cite,
// add by DOI / arXiv, online search, paste, cleanup, keys, duplicates, a new
// .bib file). Online lookups answer from tests/fixtures/bib (fake_bib.py).
"use strict";
const { apiFor, assert } = require("./harness");

const MAIN = "\\documentclass{article}\n\\begin{document}\nDeep nets \\cite{lecun2015} and \\citep{vaswani2017, ghost2020}.\n\n\\bibliography{refs}\n\\end{document}\n";
const REFS = `@article{lecun2015,
  author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  title = {Deep learning},
  journal = {Nature},
  year = {2015},
  pages = {436-444},
}

@misc{vaswani2017,
  author = {Vaswani, Ashish and Shazeer, Noam},
  title = {Attention Is All You Need},
  year = {2017},
  eprint = {1706.03762},
  archiveprefix = {arXiv},
}

@book{knuth1984, author = {Knuth, Donald E.}, title = {The {\\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}
`;

async function setup(page, base, name, files) {
  const api = apiFor(base);
  const p = await api("POST", "/api/projects", { name, main_path: "main.tex", files: files || { "main.tex": MAIN, "refs.bib": REFS } });
  await page.goto(base + "/");
  await page.evaluate(() => { try { localStorage.setItem("tw_refs_open", "0"); } catch { /* */ } });
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  return { api, p };
}

const fileOf = async (api, pid, path) => (await api("GET", `/api/projects/${pid}`)).files.find((f) => f.path === path).content;
const rows = (page) => page.$$eval("#bib-table tbody tr[data-key]", (r) => r.map((e) => e.dataset.key));
const sideMsg = (page) => page.textContent("#bib-side .bs-msg");

async function openManager(page) {
  await page.click('.tool-row[data-tool="bibman"]');
  await page.waitForSelector("#bib-modal:not([hidden])");
  await page.waitForSelector("#bib-table");
}

module.exports = {
  async panel_filters_cites_and_flags_missing({ page, base }) {
    const { p } = await setup(page, base, "BibPanel");
    await page.click("#refs-toggle");
    await page.waitForSelector(".ref-row");
    assert((await page.textContent("#refs-count")) === "3", "three entries");
    assert((await page.$$(".ref-row")).length === 3, "listed");
    assert(await page.$('.ref-row.unused[data-key="knuth1984"]'), "uncited is dimmed");
    assert((await page.textContent(".ref-missing")).includes("ghost2020"), "missing key flagged");
    assert((await page.textContent("#refs-warn")).trim() === "1", "warning count");
    await page.fill("#refs-search", "knuth");
    assert((await page.$$(".ref-row")).length === 1, "filtered");
    await page.fill("#refs-search", "");
    // click → \cite{knuth1984} at the caret
    await page.click("#source");
    await page.evaluate(() => { const ta = document.querySelector("#source"); const i = ta.value.indexOf("Deep"); ta.setSelectionRange(i, i); ta.focus(); });
    await page.click('.ref-row[data-key="knuth1984"]');
    await page.waitForFunction(() => document.querySelector("#source").value.includes("\\cite{knuth1984}Deep"));
    // the caret is now after the command; put it inside \cite{lecun2015} and add another key there
    await page.evaluate(() => { const ta = document.querySelector("#source"); const i = ta.value.indexOf("lecun2015}") + 9; ta.setSelectionRange(i, i); ta.focus(); });
    await page.click('.ref-row[data-key="vaswani2017"]');
    await page.waitForFunction(() => document.querySelector("#source").value.includes("\\cite{lecun2015,vaswani2017}"));
    // the list remembers its open state
    await page.reload();
    await page.click(".project-card >> text=BibPanel");
    await page.waitForSelector(".ref-row");
    void p;
  },

  async manager_edits_fixes_and_renames_keys({ page, base }) {
    const { api, p } = await setup(page, base, "BibEdit");
    await openManager(page);
    assert(JSON.stringify(await rows(page)) === '["lecun2015","vaswani2017","knuth1984"]', JSON.stringify(await rows(page)));
    // search and sort
    await page.fill("#bib-search", "author:knuth");
    assert(JSON.stringify(await rows(page)) === '["knuth1984"]', "field search");
    await page.fill("#bib-search", "");
    await page.click('th[data-sort="year"]');
    assert((await rows(page))[0] === "knuth1984", "sorted by year");
    // the page-range problem has a Fix button
    await page.click('#bib-table tr[data-key="lecun2015"]');
    await page.waitForSelector('#bib-side [data-field="pages"]');
    assert((await page.textContent("#bib-side .bf-prob")).includes("double hyphen"), "problem shown");
    await page.click("#bib-side [data-bib-fix]");
    await page.waitForFunction(() => document.querySelector('#bib-side [data-field="pages"]')?.value === "436--444");
    // edit a field and the key; \cite follows
    await page.fill('#bib-side [data-field="title"]', "Deep learning (review)");
    await page.fill("#be-key", "LeCunDeep");
    await page.waitForSelector("#bib-side [data-be-rename]");
    await page.click('#bib-side [data-bib="save"]');
    await page.waitForFunction(() => document.querySelector("#bib-side .bs-msg")?.textContent.includes("Saved"));
    assert((await sideMsg(page)).includes("updated in 1 file"), await sideMsg(page));
    const bib = await fileOf(api, p.id, "refs.bib");
    assert(bib.includes("@article{LeCunDeep,") && bib.includes("title = {Deep learning (review)},") && bib.includes("@misc{vaswani2017,"), bib);
    assert((await page.inputValue("#source")).includes("\\cite{LeCunDeep}"), "the open editor got the rename");
    // the BibTeX tab edits the raw entry
    await page.click('#bib-side [data-be-tab="source"]');
    const src = await page.inputValue("#bib-source");
    assert(src.startsWith("@article{LeCunDeep,"), src);
    await page.fill("#bib-source", src.replace("Nature", "Nature Reviews"));
    await page.click('#bib-side [data-bib="save"]');
    await page.waitForFunction(() => document.querySelector("#bib-side .bs-msg")?.textContent.includes("Saved"));
    assert((await fileOf(api, p.id, "refs.bib")).includes("journal = {Nature Reviews}"), "raw edit saved");
    // new entry: required fields per type, key generated from the pattern
    await page.click('#bib-toolbar [data-bib="new"]');
    await page.selectOption("#be-type", "book");
    await page.fill('#bib-side [data-field="author"]', "Goodfellow, Ian and Bengio, Yoshua");
    await page.fill('#bib-side [data-field="title"]', "Deep Learning Book");
    await page.fill('#bib-side [data-field="publisher"]', "MIT Press");
    await page.fill('#bib-side [data-field="year"]', "2016");
    await page.click('#bib-side [data-bib="save"]');
    await page.waitForSelector('#bib-table tr[data-key="Goodfellow2016"]');
    // delete it
    page.once("dialog", (d) => d.accept());
    await page.click('#bib-side [data-bib="delete"]');
    await page.waitForFunction(() => !document.querySelector('#bib-table tr[data-key="Goodfellow2016"]'));
    // Cite from the manager closes it and inserts at the caret
    await page.click('#bib-table tr[data-key="knuth1984"]');
    await page.click('#bib-side [data-bib="cite"]');
    await page.waitForSelector("#bib-modal", { state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#source").value.includes("\\cite{knuth1984}"));
  },

  async add_by_identifier_and_search_online({ page, base }) {
    const { api, p } = await setup(page, base, "BibAdd", { "main.tex": MAIN, "refs.bib": "" });
    await openManager(page);
    await page.click('#bib-toolbar [data-bib="identifier"]');
    await page.fill("#bi-q", "https://doi.org/10.1038/nature14539");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#bib-side .bs-cand");
    assert((await page.textContent("#bib-side .bs-cand")).includes("Deep learning"), "DOI record");
    await page.click("#bib-side [data-add-cand]");
    await page.waitForSelector('#bib-table tr[data-key="LeCun2015"]');
    // the same DOI again is "in the library"
    await page.click('#bib-side [data-bib="lookup"]');
    await page.waitForSelector("#bib-side .bs-cand.have");
    // arXiv id
    await page.fill("#bi-q", "arXiv:1706.03762");
    await page.click('#bib-side [data-bib="lookup"]');
    await page.waitForFunction(() => document.querySelector("#bib-side .bs-cand-title")?.textContent === "Attention Is All You Need");
    await page.click("#bib-side [data-add-cand]");
    await page.waitForSelector('#bib-table tr[data-key="Vaswani2017"]');
    const bib = await fileOf(api, p.id, "refs.bib");
    assert(bib.includes("eprint = {1706.03762}") && bib.includes("primaryclass = {cs.CL}") && bib.includes("journal = {Nature}"), bib);
    // search Crossref, pick two, add
    await page.click('#bib-toolbar [data-bib="search"]');
    await page.fill("#bs-q", "deep learning");
    await page.click('#bib-side [data-src="crossref"]');
    await page.waitForSelector("#bib-side .bs-cand");
    assert((await page.$$("#bib-side .bs-cand")).length === 3, "three results");
    assert(await page.$("#bib-side .bs-cand.have"), "the Nature paper is already in the library");
    const scholar = await page.getAttribute("#bib-side .bs-scholar", "href");
    assert(scholar === "https://scholar.google.com/scholar?q=deep%20learning", scholar);
    await page.click('#bib-side [data-cand="0"] .bs-cand-main');
    await page.click('#bib-side [data-cand="1"] [data-pick]');
    assert((await page.textContent("#bib-side .bs-foot .muted")) === "2 selected", "two picked");
    await page.click('#bib-side [data-bib="addpicked"]');
    await page.waitForFunction(() => /Added/.test(document.querySelector("#bib-side .bs-msg")?.textContent || ""));
    assert((await rows(page)).length === 4, JSON.stringify(await rows(page)));
    // DBLP from recorded replies
    await page.click('#bib-side [data-src="dblp"]');
    await page.waitForFunction(() => document.querySelectorAll("#bib-side .bs-cand").length === 2);
  },

  async paste_missing_cleanup_keys_and_duplicates({ page, base }) {
    const { api, p } = await setup(page, base, "BibTools");
    await openManager(page);
    // paste BibTeX (Google Scholar style): one new, one duplicate of lecun2015
    await page.click('#bib-toolbar [data-bib="paste"]');
    await page.fill("#bp-text", "@article{lecun2015deep, title={Deep learning}, author={LeCun, Yann}, journal={nature}, year={2015}}\n" +
      "@inproceedings{he2016deep, title={Deep residual learning for image recognition}, author={He, Kaiming and Zhang, Xiangyu}, booktitle={CVPR}, pages={770-778}, year={2016}}");
    await page.click('#bib-side [data-bib="doimport"]');
    await page.waitForFunction(() => /Imported/.test(document.querySelector("#bib-side .bs-msg")?.textContent || ""));
    const msg = await sideMsg(page);
    assert(msg.includes("he2016deep") && msg.includes("Skipped 1") && msg.includes("lecun2015"), msg);
    // a missing citation → search with its key, the result takes that key
    await page.click('#bib-filter [data-filter="missing"]');
    await page.waitForSelector('#bib-table tr[data-miss="ghost2020"]');
    await page.click('#bib-table tr[data-miss="ghost2020"] [data-miss-act="search"]');
    await page.waitForFunction(() => document.querySelector("#bs-q")?.value === "ghost 2020");
    await page.click('#bib-side [data-src="arxiv"]');
    await page.fill("#bs-q", "attention");
    await page.click('#bib-side [data-bib="dosearch"]');
    await page.waitForSelector("#bib-side [data-pick]:not([disabled])");
    await page.click("#bib-side [data-pick]:not([disabled]) >> nth=0");
    await page.click('#bib-side [data-bib="addpicked"]');
    await page.waitForFunction(() => /Added/.test(document.querySelector("#bib-side .bs-msg")?.textContent || ""));
    assert((await fileOf(api, p.id, "refs.bib")).includes("{ghost2020,"), "took the cited key");
    await page.waitForFunction(() => document.querySelector('#bib-filter [data-filter="missing"]').textContent === "Missing");
    // clean up everything: page ranges
    await page.click('#bib-filter [data-filter="all"]');
    await page.click('#bib-toolbar [data-bib="cleanup"]');
    await page.click('#bib-side [data-bib="docleanup"]');
    await page.waitForFunction(() => /Cleaned/.test(document.querySelector("#bib-side .bs-msg")?.textContent || ""));
    const bib = await fileOf(api, p.id, "refs.bib");
    assert(bib.includes("pages = {436--444}") && bib.includes("pages = {770--778}"), bib);
    // keys: preview, then apply; \cite follows
    await page.click('#bib-toolbar [data-bib="keys"]');
    await page.fill("#bk-pattern", "[auth:lower][year]");
    await page.click('#bib-side [data-bib="keypreview"]');
    await page.waitForSelector("#bib-side .bs-keys");
    const preview = (await page.textContent("#bib-side .bs-keys")).replace(/\s+/g, " ");
    assert(preview.includes("he2016deep→he2016") && !preview.includes("lecun2015→"), preview);
    await page.click('#bib-side [data-bib="keyapply"]');
    await page.waitForFunction(() => /Renamed/.test(document.querySelector("#bib-side .bs-msg")?.textContent || ""));
    const main = await fileOf(api, p.id, "main.tex");
    assert(!main.includes("ghost2020") && /\\citep\{vaswani2017, [a-z]+\d{4}[a-z]?\}/.test(main), main);
    assert((await fileOf(api, p.id, "refs.bib")).includes("{he2016,"), "renamed in the file");
    // duplicates: force one in, merge it
    await api("POST", `/api/projects/${p.id}/bib/entries`, { file: "refs.bib", key: "dupe", force: true, fields: { title: "Deep learning", year: "2015", doi: "10.1038/nature14539" } });
    await page.click('#bib-toolbar [data-bib="duplicates"]');
    await page.evaluate(() => bibLoad());
    await page.waitForFunction(() => /Duplicates \(1\)/.test(document.querySelector("#bib-dup-btn").textContent));
    await page.click('#bib-toolbar [data-bib="duplicates"]');
    page.once("dialog", (d) => d.accept());
    await page.click("#bib-side [data-dup-merge]");
    await page.waitForFunction(() => /Merged/.test(document.querySelector("#bib-side .bs-msg")?.textContent || ""));
    const after = await fileOf(api, p.id, "refs.bib");
    assert(!after.includes("{dupe,") && after.includes("doi = {10.1038/nature14539}"), after);
  },

  async new_bib_file_and_bibliography_hint({ page, base }) {
    const { api, p } = await setup(page, base, "BibNew", { "main.tex": "\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n" });
    await page.click("#refs-toggle");
    await page.waitForSelector("[data-ref-create]");
    await page.click("[data-ref-create]");
    await page.waitForSelector("#bib-modal:not([hidden])");
    await page.waitForSelector(".file-row >> text=refs.bib").catch(() => {});
    assert((await page.textContent("#bib-banner")).includes("isn't named by"), await page.textContent("#bib-banner"));
    await page.click('#bib-banner [data-bib="usefile"]');
    await page.waitForFunction(() => document.querySelector("#bib-banner").hidden);
    const main = await fileOf(api, p.id, "main.tex");
    assert(main.includes("\\bibliography{refs}\n\\end{document}"), main);
    assert((await page.inputValue("#source")).includes("\\bibliography{refs}"), "editor updated");
    // a second file from the file menu
    page.once("dialog", (d) => d.accept());
    await page.evaluate(() => { const s = document.querySelector("#bib-file"); s.value = "__new"; s.dispatchEvent(new Event("change")); });
    await page.waitForSelector("#modal:not([hidden])");
    await page.fill("#modal-input", "extra.bib");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll("#bib-file option")].some((o) => o.value === "extra.bib" && o.selected));
    await page.keyboard.press("Escape");
    await page.waitForSelector("#bib-modal", { state: "hidden" });
  },
};
