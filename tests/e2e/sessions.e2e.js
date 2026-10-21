// Assistant sessions against the fake OpenAI-compatible server: versions and
// branches (regenerate, edit, pick), split into a new session, the sessions
// manager (search, pin, rename, duplicate, export, delete), and the remembered
// model/mode with the warning shown when the model changes.
"use strict";
const { apiFor, assert } = require("./harness");
const fake = require("./fake_llm");

const MAIN = "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n";

async function setup(page, base, name) {
  const llm = await fake.start();
  const api = apiFor(base);
  const prov = `fake-${name.toLowerCase()}`;
  await api("POST", "/api/providers", { name: prov, type: "openai", api_base: llm.url, models: ["luna", "astra"], api_key: "sk-test-key-123456" });
  await api("PUT", "/api/assistant/defaults", { provider: prov, model: "luna" });
  const p = await api("POST", "/api/projects", { name, main_path: "main.tex", files: { "main.tex": MAIN } });
  await page.goto(base + "/");
  await page.evaluate(() => { localStorage.removeItem("tw_as_model"); localStorage.removeItem("tw_as_mode"); });
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  await page.click('.tab[data-rtab="assistant"]');
  await page.waitForSelector("#tab-assistant:not([hidden])");
  return { llm, api, prov, project: p, done: async () => { await llm.stop(); await api("DELETE", `/api/providers/${prov}`).catch(() => {}); } };
}

// Waits until the last reply on screen answers `expect` (the echoed text) and
// the turn is over.
const idle = (page, expect) => page.waitForFunction((t) => {
  const b = [...document.querySelectorAll(".as-msg.assistant:not(.live) .as-body")].pop();
  return b && (!t || b.textContent.includes(t)) && !document.querySelector(".as-msg.live") &&
    document.querySelector("#ask-send")?.textContent === "Send";
}, expect, { timeout: 20000 });

async function send(page, text) {
  await page.fill("#ask-input", text);
  await page.keyboard.press("Enter");
  await idle(page, text.replace(/^echo: ?/, ": "));
}
const bodies = (page) => page.$$eval(".as-msg.assistant .as-body", (b) => b.map((e) => e.textContent.trim()));
const users = (page) => page.$$eval(".as-msg.user .as-bubble", (b) => b.map((e) => e.textContent.trim()));

async function openSessions(page) {
  if (await page.$eval("#as-convo-menu", (m) => m.hidden)) await page.click("#as-convo-btn");
  await page.waitForSelector("#as-convo-menu:not([hidden]) .as-convo-list");
}
const sessionTitles = (page) => page.$$eval("#as-convo-menu .as-menu-title", (t) => t.map((e) => e.textContent));

module.exports = {
  async versions_and_branches_can_be_picked({ page, base }) {
    const ctx = await setup(page, base, "SesBranch");
    try {
      await send(page, "echo: one");
      assert((await bodies(page))[0] === "Echo #1 (luna): one", JSON.stringify(await bodies(page)));
      assert(!(await page.$(".as-branch")), "no version arrows yet");
      // regenerate: a second version, the first one stays reachable
      await page.hover(".as-msg.assistant");
      await page.click('.as-msg.assistant [data-act="regen"]');
      await idle(page, "Echo #2");
      assert((await page.textContent(".as-msg.assistant .as-branch-n")) === "2/2", "reply version 2 of 2");
      await page.click('.as-msg.assistant [data-act="prev"]');
      await page.waitForFunction(() => document.querySelector(".as-msg.assistant .as-branch-n")?.textContent === "1/2");
      assert((await bodies(page))[0].startsWith("Echo #1"), "back to the first reply");
      // a follow-up on version 1, then edit the first message: a new branch at the root
      await send(page, "echo: follow-up");
      assert((await users(page)).length === 2, "two turns on this branch");
      await page.hover(".as-msg.user");
      await page.click('.as-msg.user >> nth=0 >> [data-act="edit"]');
      await page.fill(".as-edit textarea", "echo: rewritten");
      await page.click('.as-edit [data-edit="send"]');
      await idle(page, ": rewritten");
      assert(JSON.stringify(await users(page)) === '["echo: rewritten"]', JSON.stringify(await users(page)));
      assert((await page.textContent(".as-msg.user .as-branch-n")) === "2/2", "first message has two versions");
      // the branches button lists every branch; pick the follow-up one
      assert((await page.textContent("#as-branch-n")) === "3", "three branches");
      await page.click("#as-branch-btn");
      const rows = await page.$$eval("#as-branch-menu .as-branch-row", (r) => r.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
      assert(rows.length === 3 && rows.some((r) => r.startsWith("echo: follow-up")) &&
        rows.some((r) => r.startsWith("echo: one ↳ Echo #2")) && rows.some((r) => r.startsWith("echo: rewritten") && r.includes("Showing")), JSON.stringify(rows));
      await page.click('#as-branch-menu .as-branch-row:has-text("echo: follow-up")');
      await page.waitForFunction(() => document.querySelectorAll(".as-msg.user").length === 2);
      assert(JSON.stringify(await users(page)) === '["echo: one","echo: follow-up"]', JSON.stringify(await users(page)));
      // it survives a reload: the server keeps the branch on screen
      await page.reload();
      await page.click(".project-card >> text=SesBranch");
      await page.click('.tab[data-rtab="assistant"]');
      await page.waitForSelector(".as-msg.user");
      assert((await users(page)).length === 2, "same branch after reload");
      // delete the follow-up turn
      page.once("dialog", (d) => d.accept());
      await page.hover(".as-msg.user >> nth=1");
      await page.click('.as-msg.user >> nth=1 >> [data-act="delete"]');
      await page.waitForFunction(() => document.querySelectorAll(".as-msg.user").length === 1);
    } finally { await ctx.done(); }
  },

  async split_and_manage_sessions({ page, base }) {
    const ctx = await setup(page, base, "SesManage");
    try {
      await send(page, "echo: alpha");
      await send(page, "echo: beta");
      // split after the first reply → a new session with the first turn
      await page.hover(".as-msg.assistant >> nth=0");
      await page.click('.as-msg.assistant >> nth=0 >> [data-act="split"]');
      await page.waitForSelector(".as-forked");
      assert((await page.textContent(".as-forked")).includes("Split from echo: alpha"), await page.textContent(".as-forked"));
      assert((await page.$$(".as-msg")).length === 2, "the split holds one turn");
      assert((await page.textContent("#as-convo-title")).includes("(split)"), "split title");
      await send(page, "echo: gamma");
      // the manager lists both, newest first
      await openSessions(page);
      let titles = await sessionTitles(page);
      assert(titles.length === 2 && titles[0].includes("(split)"), JSON.stringify(titles));
      const sub = await page.textContent('#as-convo-menu .as-sess:has-text("(split)") .as-menu-sub');
      assert(sub.includes("luna") && sub.includes("4 messages"), sub);
      // pin the original: it moves to the top
      await page.hover('#as-convo-menu .as-sess:not(:has-text("(split)"))');
      await page.click('#as-convo-menu .as-sess:not(:has-text("(split)")) [data-conv-act="pin"]');
      await page.waitForFunction(() => document.querySelector("#as-convo-menu .as-sess")?.classList.contains("pinned"));
      titles = await sessionTitles(page);
      assert(titles[0] === "echo: alpha", JSON.stringify(titles));
      // search by message text
      await page.fill("#as-convo-menu .as-convo-search", "gamma");
      await page.waitForFunction(() => document.querySelectorAll("#as-convo-menu .as-sess").length === 1);
      assert((await sessionTitles(page))[0].includes("(split)"), "search finds the split by its content");
      await page.fill("#as-convo-menu .as-convo-search", "");
      await page.waitForFunction(() => document.querySelectorAll("#as-convo-menu .as-sess").length === 2);
      // rename, duplicate, export
      await page.hover('#as-convo-menu .as-sess:has-text("(split)")');
      await page.click('#as-convo-menu .as-sess:has-text("(split)") [data-conv-act="rename"]');
      await page.fill("#modal-input", "Gamma thread");
      await page.keyboard.press("Enter");
      await openSessions(page);
      await page.waitForFunction(() => [...document.querySelectorAll("#as-convo-menu .as-menu-title")].some((e) => e.textContent === "Gamma thread"));
      await page.hover('#as-convo-menu .as-sess:has-text("Gamma thread")');
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click('#as-convo-menu .as-sess:has-text("Gamma thread") [data-conv-act="export"]'),
      ]);
      assert(download.suggestedFilename() === "Gamma-thread.md", download.suggestedFilename());
      const md = await new Promise((resolve, reject) => {
        download.createReadStream().then((st) => { let t = ""; st.on("data", (c) => { t += c; }); st.on("end", () => resolve(t)); st.on("error", reject); }, reject);
      });
      assert(md.startsWith("# Gamma thread") && md.includes("echo: gamma"), md.slice(0, 200));
      await openSessions(page);
      await page.hover('#as-convo-menu .as-sess:has-text("Gamma thread")');
      await page.click('#as-convo-menu .as-sess:has-text("Gamma thread") [data-conv-act="duplicate"]');
      await page.waitForFunction(() => (document.querySelector("#as-convo-title")?.textContent || "").includes("(copy)"));
      assert((await page.$$(".as-msg")).length === 4, "the copy holds every message");
      // delete the copy (the open one): the transcript empties
      await openSessions(page);
      page.once("dialog", (d) => d.accept());
      await page.hover('#as-convo-menu .as-sess:has-text("(copy)")');
      await page.click('#as-convo-menu .as-sess:has-text("(copy)") [data-conv-act="delete"]');
      await page.waitForFunction(() => document.querySelectorAll("#as-convo-menu .as-sess").length === 2);
      assert(!(await page.$(".as-msg")), "deleted session is closed");
      // open the original from the split's banner link
      await page.click('#as-convo-menu .as-sess:has-text("Gamma thread")');
      await page.waitForSelector(".as-forked");
      await page.click(".as-forked [data-open-conv]");
      await page.waitForFunction(() => document.querySelector("#as-convo-title")?.textContent === "echo: alpha");
    } finally { await ctx.done(); }
  },

  async session_remembers_model_and_warns_on_switch({ page, base }) {
    const ctx = await setup(page, base, "SesModel");
    const pick = (model) => page.selectOption("#as-model", `${ctx.prov}::${model}`);
    void idle;
    try {
      await page.click('.as-mode [data-mode="chat"]');
      await send(page, "echo: first");
      // switching the model on a session with history warns first
      await pick("astra");
      await page.waitForSelector("#as-switch:not([hidden])");
      const text = await page.textContent("#as-switch");
      assert(text.includes("from luna to astra") && text.includes("KV cache"), text);
      // keep the old model
      await page.click('#as-switch [data-switch="keep"]');
      await page.waitForSelector("#as-switch", { state: "hidden" });
      assert((await page.inputValue("#as-model")) === `${ctx.prov}::luna`, "picker back on luna");
      // switch for real: the next reply says so
      await pick("astra");
      await page.click('#as-switch [data-switch="apply"]');
      await page.waitForSelector("#as-switch", { state: "hidden" });
      await send(page, "echo: second");
      assert((await page.textContent(".as-msg.assistant >> nth=1 >> .as-switched")).includes("luna → astra"), "switch divider");
      assert((await bodies(page))[1] === "Echo #2 (astra): second", JSON.stringify(await bodies(page)));
      // a new session starts from the last picked model; the old one keeps astra + chat
      await page.click("#btn-new-chat");
      await pick("luna");
      await page.click('.as-mode [data-mode="agent"]');
      await send(page, "echo: other session");
      await openSessions(page);
      await page.click('#as-convo-menu .as-sess:has-text("echo: first")');
      await page.waitForFunction(() => document.querySelector(".as-msg.user .as-bubble")?.textContent === "echo: first");
      assert((await page.inputValue("#as-model")) === `${ctx.prov}::astra`, "the session's model is restored");
      assert(await page.$eval('.as-mode [data-mode="chat"]', (b) => b.classList.contains("active")), "the session's mode is restored");
      assert(await page.$("#as-switch[hidden]"), "no warning when it opens on its own model");
      // "New session on luna": a copy of this one that runs on luna
      await pick("luna");
      await page.waitForSelector("#as-switch:not([hidden])");
      await page.click('#as-switch [data-switch="split"]');
      await page.waitForFunction(() => (document.querySelector("#as-convo-title")?.textContent || "").includes("(copy)"));
      assert((await page.$$(".as-msg")).length === 4, "copied the conversation");
      await send(page, "echo: third");
      assert((await bodies(page))[2].includes("(luna): third"), JSON.stringify(await bodies(page)));
    } finally { await ctx.done(); }
  },
};
