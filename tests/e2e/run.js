// Runs every tests/e2e/*.e2e.js spec against one server + browser.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { startServer, launch } = require("./harness");

(async () => {
  const only = process.argv[2];
  const specs = fs.readdirSync(__dirname).filter((f) => f.endsWith(".e2e.js"))
    .filter((f) => !only || f.includes(only)).sort();
  const server = await startServer();
  const browser = await launch();
  let failed = 0;
  try {
    for (const f of specs) {
      const spec = require(path.join(__dirname, f));
      for (const [name, fn] of Object.entries(spec)) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        const t0 = Date.now();
        try {
          await fn({ page, base: server.base, errors });
          if (errors.length) throw new Error("browser errors: " + errors.join(" | "));
          console.log(`  ok   ${f} › ${name} (${Date.now() - t0} ms)`);
        } catch (e) {
          failed++;
          console.log(`  FAIL ${f} › ${name}\n       ${e.stack || e}`);
          try { await page.screenshot({ path: path.join(require("node:os").tmpdir(), `e2e-fail-${name}.png`) }); } catch {}
        } finally { await ctx.close(); }
      }
    }
  } finally { await browser.close(); server.stop(); }
  console.log(failed ? `${failed} e2e test(s) failed` : "all e2e tests passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
