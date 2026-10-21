// Assistant chat + settings against a fake OpenAI-compatible server
// (tests/e2e/fake_llm.js): agent edits and review, chat mode, stop, edit &
// resend, conversations, provider/model/key management, skills and prompts.
"use strict";
const { apiFor, assert } = require("./harness");
const fake = require("./fake_llm");

const MAIN = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nHello wrold.\n\\end{document}\n";

async function setup(page, base, name) {
  const llm = await fake.start();
  const api = apiFor(base);
  const prov = `fake-${name.toLowerCase()}`;
  await api("POST", "/api/providers", { name: prov, type: "openai", api_base: llm.url, models: ["luna", "astra"], api_key: "sk-test-key-123456" });
  await api("PUT", "/api/assistant/defaults", { provider: prov, model: "luna" });
  const p = await api("POST", "/api/projects", { name, main_path: "main.tex", files: { "main.tex": MAIN, "refs.bib": "@misc{k,title={T}}\n" } });
  await page.goto(base + "/");
  await page.click(`.project-card >> text=${name}`);
  await page.waitForSelector("#view-workspace:not([hidden])");
  await page.click('.tab[data-rtab="assistant"]');
  await page.waitForSelector("#tab-assistant:not([hidden])");
  return { llm, api, prov, project: p, done: async () => { await llm.stop(); await api("DELETE", `/api/providers/${prov}`).catch(() => {}); } };
}

async function send(page, text) {
  await page.fill("#ask-input", text);
  await page.keyboard.press("Enter");
}

const finished = (page, n) => page.waitForFunction((k) =>
  document.querySelectorAll(".as-msg.assistant:not(.live)").length === k && !document.querySelector(".as-msg.live"), n, { timeout: 20000 });

module.exports = {
  async agent_reads_edits_and_the_user_applies({ page, base }) {
    const ctx = await setup(page, base, "AsAgent");
    try {
      assert((await page.textContent("#assistant-slot")).includes("/fix"), "empty state suggests skills");
      assert(await page.$eval('.as-mode [data-mode="agent"]', (b) => b.classList.contains("active")), "agent mode by default");
      await send(page, "please fix the typo");
      await page.waitForSelector(".as-changes", { timeout: 20000 });
      await finished(page, 1);
      const steps = await page.$$eval(".as-step", (s) => s.map((e) => [e.className.includes("ok"), e.textContent]));
      assert(steps.length === 2 && steps.every((s) => s[0]) && steps[0][1].includes("Read") && steps[1][1].includes("Edited"), JSON.stringify(steps));
      assert((await page.textContent(".as-msg.assistant .as-body")).includes("wrold → world"), "reply rendered");
      assert(await page.$(".as-msg.assistant .as-body strong"), "markdown bold");
      const diff = await page.textContent(".as-change .diff-body");
      assert(diff.includes("Hello wrold.") && diff.includes("Hello world."), diff);
      assert((await page.$eval("#source", (t) => t.value)).includes("wrold"), "nothing applied yet");
      // the model was told what is open
      const first = ctx.llm.log[0].messages.find((m) => m.role === "user").content;
      assert(first.includes("Open file: main.tex"), first);
      assert(ctx.llm.log[0].model === "luna" && ctx.llm.log[0].tools.length >= 5, "model + tools sent");
      await page.click('.as-changes-head [data-change="apply"]');
      await page.waitForFunction(() => document.querySelector("#source").value.includes("Hello world."));
      assert((await page.textContent(".as-change")).includes("Applied"), "status shown");
      const saved = (await ctx.api("GET", `/api/projects/${ctx.project.id}`)).files.find((f) => f.path === "main.tex").content;
      assert(saved.includes("Hello world."), "written to the project");
      await page.waitForFunction(() => document.querySelector("#as-convo-title").textContent === "please fix the typo");
      assert((await page.textContent(".as-meta-line")).includes("luna"), "footer names the model");
    } finally { await ctx.done(); }
  },

  async chat_mode_markdown_code_actions_and_regenerate({ page, base }) {
    const ctx = await setup(page, base, "AsChat");
    try {
      await page.click('.as-mode [data-mode="chat"]');
      await send(page, "explain the equation");
      await finished(page, 1);
      assert(!ctx.llm.log[0].tools, "chat mode sends no tools");
      const sent = ctx.llm.log[0].messages.find((m) => m.role === "user").content;
      assert(sent.includes("File `main.tex`") && sent.includes("Hello wrold."), "chat mode inlines the open file");
      assert((await page.textContent(".md-code-head")).includes("latex"), "code block header");
      assert((await page.$$(".as-body li")).length === 2, "list rendered");
      // insert the code block at the editor's cursor
      await page.evaluate(() => { const ta = document.querySelector("#source"); const i = ta.value.indexOf("\\end{document}"); ta.focus(); ta.setSelectionRange(i, i); });
      await page.click('.md-code-head [data-code="insert"]');
      assert((await page.$eval("#source", (t) => t.value)).includes("E = mc^2\n\\end{equation}"), "inserted");
      // regenerate replaces the last reply
      await page.hover(".as-msg.assistant");
      await page.click('.as-msg.assistant [data-act="regen"]');
      await page.waitForFunction(() => document.querySelector(".as-msg.live"));
      await finished(page, 1);
      assert((await page.$$(".as-msg")).length === 2 && ctx.llm.log.length === 2, "one exchange after regenerate");
      // the choice of mode sticks
      await page.reload();
      await page.click(".project-card >> text=AsChat");
      await page.click('.tab[data-rtab="assistant"]');
      assert(await page.$eval('.as-mode [data-mode="chat"]', (b) => b.classList.contains("active")), "mode remembered");
      assert((await page.$$(".as-msg")).length === 2, "conversation reloaded");
    } finally { await ctx.done(); }
  },

  async stop_edit_and_resend_and_conversations({ page, base }) {
    const ctx = await setup(page, base, "AsStop");
    try {
      await send(page, "go slow please");
      await page.waitForFunction(() => /word\d+ word/.test(document.querySelector(".as-msg.live .as-body")?.textContent || ""), null, { timeout: 15000 });
      assert((await page.textContent("#ask-send")) === "Stop", "send becomes stop");
      await page.click("#ask-send");
      await finished(page, 1);
      assert((await page.textContent(".as-msg.assistant")).includes("Stopped"), "marked stopped");
      assert((await page.textContent("#ask-send")) === "Send", "back to send");
      // edit & resend the first message
      await page.hover(".as-msg.user");
      await page.click('.as-msg.user [data-act="edit"]');
      await page.fill(".as-edit textarea", "explain it instead");
      await page.click('.as-edit [data-edit="send"]');
      await page.waitForFunction(() => document.querySelector(".as-msg.user .as-bubble")?.textContent === "explain it instead");
      await finished(page, 1);
      const users = await page.$$eval(".as-msg.user .as-bubble", (b) => b.map((e) => e.textContent));
      assert(users.length === 1 && users[0] === "explain it instead", JSON.stringify(users));
      // a second conversation, then back to the first through the menu
      await page.click("#btn-new-chat");
      assert(!(await page.$(".as-msg")), "new chat is empty");
      await send(page, "second chat");
      await finished(page, 1);
      await page.click("#as-convo-btn");
      await page.waitForSelector("#as-convo-menu:not([hidden])");
      const titles = await page.$$eval("#as-convo-menu .as-menu-title", (t) => t.map((e) => e.textContent));
      assert(titles.length === 2 && titles.includes("second chat") && titles.includes("go slow please"), JSON.stringify(titles));
      await page.click('#as-convo-menu .as-menu-row:has-text("go slow please")');
      await page.waitForFunction(() => document.querySelector(".as-msg.user .as-bubble")?.textContent === "explain it instead");
      // delete it
      page.once("dialog", (d) => d.accept());
      await page.click("#as-convo-btn");
      await page.hover('#as-convo-menu .as-menu-row:has-text("go slow please")');
      await page.click('#as-convo-menu .as-menu-row:has-text("go slow please") [data-conv-act="delete"]');
      await page.waitForFunction(() => document.querySelectorAll("#as-convo-menu .as-menu-row").length === 1);
    } finally { await ctx.done(); }
  },

  async settings_manage_providers_models_and_keys({ page, base }) {
    const ctx = await setup(page, base, "AsProv");
    try {
      await page.click("#as-settings-btn");
      await page.waitForSelector("#as-settings:not([hidden])");
      assert((await page.textContent("#set-form .as-form-title")).includes(ctx.prov), "opens on the provider in use");
      // add DeepSeek from its preset, pointing at the fake server
      await page.selectOption("#set-preset", "deepseek");
      await page.fill("#pf-name", "deepseek-e2e");
      await page.fill("#pf-base", ctx.llm.url);
      const chips = await page.$$eval("#set-form .as-mchip", (c) => c.map((e) => e.textContent));
      assert(JSON.stringify(chips) === JSON.stringify(["deepseek-flash", "deepseek-pro"]), JSON.stringify(chips));
      await page.fill("#pf-key", "sk-deepseek-secret-7777");
      await page.click('[data-save="provider"]');
      await page.waitForSelector('.as-li.active:has-text("deepseek-e2e") .as-dot.ok');
      assert((await page.textContent(".as-key-state")).includes("7777"), "hint shown");
      assert(!(await page.content()).includes("sk-deepseek-secret"), "the key is not in the page after saving");
      assert((await page.$eval("#pf-key", (i) => i.value)) === "", "key field cleared");
      // test the connection and fetch the model list
      await page.click("[data-test]");
      await page.waitForFunction(() => /answered “OK”/.test(document.querySelector("#pf-test").textContent));
      await page.click("[data-fetch-models]");
      await page.waitForFunction(() => document.querySelectorAll("#pf-remote option").length === 4);
      // add a model by typing, make it the default, save
      await page.fill("#pf-model-add", "deepseek-reasoner");
      await page.keyboard.press("Enter");
      await page.selectOption("#pf-default", "deepseek-pro");
      await page.click('[data-save="provider"]');
      await page.waitForFunction(() => /Saved/.test(document.querySelector("#pf-test").textContent));
      const p = (await ctx.api("GET", "/api/providers")).providers.find((x) => x.name === "deepseek-e2e");
      assert(p.model === "deepseek-pro" && p.models.includes("deepseek-reasoner") && p.key_source === "stored", JSON.stringify(p));
      // the chat's model picker lists it
      await page.click("#as-settings-close");
      const opts = await page.$$eval("#as-model option", (o) => o.map((e) => e.value));
      assert(opts.includes("deepseek-e2e::deepseek-pro"), JSON.stringify(opts));
      await page.selectOption("#as-model", "deepseek-e2e::deepseek-flash");
      await send(page, "hello");
      await finished(page, 1);
      assert(ctx.llm.log[ctx.llm.log.length - 1].model === "deepseek-flash", "the picked model is used");
      // remove the stored key, then delete the provider
      await page.click("#as-settings-btn");
      await page.click('.as-li:has-text("deepseek-e2e")');
      page.once("dialog", (d) => d.accept());
      await page.click("[data-clear-key]");
      await page.waitForFunction(() => /No API key yet/.test(document.querySelector(".as-key-state").textContent));
      page.once("dialog", (d) => d.accept());
      await page.click('[data-danger="delete"]');
      await page.waitForFunction(() => ![...document.querySelectorAll(".as-li b")].some((b) => b.textContent === "deepseek-e2e"));
      await page.keyboard.press("Escape");
      assert(await page.$eval("#as-settings", (m) => m.hidden), "Esc closes");
    } finally { await ctx.done(); }
  },

  async skills_and_prompts_are_managed_and_used({ page, base }) {
    const ctx = await setup(page, base, "AsSkills");
    try {
      await page.click("#as-settings-btn");
      await page.click('[data-stab="skills"]');
      assert(await page.$eval("#sk-prompt", (t) => t.readOnly), "built-ins are read-only");
      await page.click('[data-new="skill"]');
      await page.fill("#sk-name", "shorten");
      await page.fill("#sk-title", "Shorten");
      await page.fill("#sk-desc", "Make it shorter");
      await page.fill("#sk-prompt", "Shorten {selection}. {input}");
      await page.click('[data-save="skill"]');
      await page.waitForSelector('.as-li.active:has-text("/shorten")');
      await page.click('[data-stab="prompts"]');
      await page.click('[data-new="prompt"]');
      await page.fill("#pr-title", "Reviewer 2");
      await page.fill("#pr-body", "Review {file} as a demanding reviewer.");
      await page.click('[data-save="prompt"]');
      await page.waitForSelector('.as-li.active:has-text("Reviewer 2")');
      await page.click("#as-settings-close");
      // the skill shows in / autocomplete and runs with the selection
      await page.fill("#ask-input", "/sho");
      await page.dispatchEvent("#ask-input", "input");
      await page.waitForSelector('#ac-menu .ac-item:has-text("/shorten")');
      await page.keyboard.press("Tab");
      assert((await page.$eval("#ask-input", (t) => t.value)) === "/shorten ", "accepted");
      await page.evaluate(() => { const ta = document.querySelector("#source"); const i = ta.value.indexOf("Hello"); ta.focus(); ta.setSelectionRange(i, i + 12); ta.dispatchEvent(new Event("select")); });
      await page.waitForSelector('#as-chips .as-chip.sel:has-text("Lines 4")');
      await page.click("#ask-input");
      await page.keyboard.press("End");
      await page.keyboard.type("a lot");
      await page.keyboard.press("Enter");
      await finished(page, 1);
      const sent = ctx.llm.log[0].messages.find((m) => m.role === "user").content;
      assert(sent.includes("Shorten this selection from `main.tex`") && sent.includes("Hello wrold.") && sent.includes("a lot"), sent);
      assert((await page.textContent(".as-msg.user .chat-skill")) === "/shorten", "skill tag on the message");
      // the saved prompt is inserted with {file} filled in
      await page.click("#as-prompts-btn");
      await page.click('#as-prompts-menu [data-prompt]:has-text("Reviewer 2")');
      assert((await page.$eval("#ask-input", (t) => t.value)) === "Review main.tex as a demanding reviewer.", "prompt inserted");
    } finally {
      await ctx.api("DELETE", "/api/skills/shorten").catch(() => {});
      for (const p of await ctx.api("GET", "/api/prompts")) await ctx.api("DELETE", `/api/prompts/${p.id}`).catch(() => {});
      await ctx.done();
    }
  },
};
