// A tiny OpenAI-compatible server for the assistant e2e tests: /v1/models and
// streaming /v1/chat/completions with scripted tool calls. The app talks to it
// through the real OpenAI SDK, so the whole path (SSE, tool loop, staging) runs.
//
// Scripts, chosen by the latest user message:
//   "fix the typo"  → read_file main.tex → edit_file wrold→world → summary text
//   "slow"          → streams a long answer slowly (for Stop)
//   "OK" probe      → "OK" (the settings "Test connection")
//   anything else   → a Markdown answer with a LaTeX code block
"use strict";
const http = require("node:http");

function start() {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer sk-")) { res.writeHead(401); res.end(JSON.stringify({ error: { message: "bad key" } })); return; }
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: ["luna", "astra", "deepseek-flash", "deepseek-pro"].map((id) => ({ id, object: "model" })) }));
        return;
      }
      if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end("{}"); return; }
      const j = JSON.parse(body || "{}");
      log.push(j);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: j.model,
        choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`);
      const end = () => {
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })}\n\n`);
        res.write("data: [DONE]\n\n"); res.end();
      };
      const msgs = j.messages || [];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      const text = (lastUser && lastUser.content) || "";
      const last = msgs[msgs.length - 1] || {};
      const toolCall = (id, name, args) => {
        send({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] });
        const s = JSON.stringify(args);
        send({ tool_calls: [{ index: 0, function: { arguments: s.slice(0, 10) } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: s.slice(10) } }] });
        send({}, "tool_calls");
        end();
      };
      if (/single word OK/.test(text)) { send({ role: "assistant", content: "OK" }); send({}, "stop"); return end(); }
      if (/fix the typo/.test(text) && j.tools) {
        const tools = msgs.filter((m) => m.role === "tool");
        if (tools.length === 0) return toolCall("call_1", "read_file", { path: "main.tex" });
        if (tools.length === 1) return toolCall("call_2", "edit_file", { path: "main.tex", old_text: "wrold", new_text: "world" });
        send({ role: "assistant", content: "Fixed the typo: **wrold → world** in `main.tex`." });
        send({}, "stop");
        return end();
      }
      if (/slow/.test(text)) {
        let n = 0;
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) { clearInterval(timer); return; }
          send({ content: `word${n} ` });
          if (++n > 400) { clearInterval(timer); send({}, "stop"); end(); }
        }, 25);
        res.on("close", () => clearInterval(timer));   // the client went away (Stop)
        return;
      }
      void last;
      const answer = "Here is a **bold** idea for `main.tex`:\n\n```latex\n\\begin{equation}\n  E = mc^2\n\\end{equation}\n```\n\n- one\n- two";
      for (const part of answer.match(/[\s\S]{1,12}/g)) send({ content: part });
      send({}, "stop");
      end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}/v1`, log, stop: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { start };
