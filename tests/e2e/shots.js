// Ad-hoc screenshots: node tests/e2e/shots.js <outdir> [script.js]
"use strict";
const path = require("node:path");
const { startServer, launch, apiFor } = require("./harness");
(async () => {
  const out = process.argv[2] || ".";
  const server = await startServer(); const browser = await launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
    const fn = require(path.resolve(process.argv[3]));
    await fn({ page, base: server.base, api: apiFor(server.base), out });
  } finally { await browser.close(); server.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
