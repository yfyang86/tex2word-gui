// End-to-end harness: boots the app on a throwaway SQLite DB and drives it
// with Playwright's Chromium. Run with:  node tests/e2e/run.js
// (needs `playwright` resolvable — e.g. NODE_PATH=$(npm root -g) — and a
// Chromium build; set PW_CHROMIUM to an executable path to override.)
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const ROOT = path.resolve(__dirname, "..", "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    if (Date.now() - t0 > ms) throw new Error(`server did not come up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function startServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-e2e-"));
  const env = { ...process.env, TEX2WORD_DB: path.join(dir, "e2e.db") };
  const py = process.env.PYTHON || path.join(ROOT, ".venv", "bin", "python");
  const proc = spawn(py, ["-m", "uvicorn", "app.main:app", "--port", String(port), "--log-level", "warning"],
    { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base + "/api/health");
  return { base, stop: () => proc.kill("SIGTERM") };
}

async function launch() {
  const { chromium } = require("playwright");
  const opts = { headless: true };
  if (process.env.PW_CHROMIUM) opts.executablePath = process.env.PW_CHROMIUM;
  return chromium.launch(opts);
}

// JSON API helper against the running server.
function apiFor(base) {
  return async (method, p, body) => {
    const r = await fetch(base + p, {
      method, headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${JSON.stringify(j)}`);
    return j;
  };
}

function assert(cond, msg) { if (!cond) throw new Error("assertion failed: " + msg); }

module.exports = { startServer, launch, apiFor, assert, ROOT };
