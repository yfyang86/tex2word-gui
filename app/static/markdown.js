// A small, safe Markdown renderer for assistant replies (pure, no DOM).
// Everything is HTML-escaped first; only the constructs below become markup,
// and links are limited to http(s)/mailto. Handles text that is still
// streaming in (an unclosed ``` fence renders as code so far).
//
//   blocks: # headings, paragraphs, - * + and 1. lists (nested by indent),
//           > quotes, ``` fenced code ```, | tables |, --- rules
//   inline: `code`, **bold**, *italic* / _italic_, ~~strike~~, [text](url), <https://autolinks>
// tests/js/markdown.test.js covers it.
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MiniMarkdown = api;
})(typeof self !== "undefined" ? self : this, function () {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function safeUrl(url) {
    const u = String(url).trim();
    return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
  }

  // Inline markup on already-split text (code spans first so their content stays literal).
  function inline(text) {
    const parts = String(text).split(/(`+[^`]*?`+)/);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        const m = /^(`+)([\s\S]*?)\1$/.exec(part);
        if (m) return `<code>${esc(m[2].replace(/^ (.*) $/, "$1"))}</code>`;
      }
      let s = esc(part);
      s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, label, url) => {
        const href = safeUrl(url.replace(/&amp;/g, "&"));
        return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      });
      s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (all, url) =>
        `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
      s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
      s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
      s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
      return s;
    }).join("");
  }

  const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  }

  function renderList(lines) {
    // lines: [{indent, ordered, text}] → nested lists by indent
    let html = "";
    const stack = [];
    for (const it of lines) {
      while (stack.length && it.indent < stack[stack.length - 1].indent) {
        html += `</li></${stack.pop().tag}>`;
      }
      let top = stack[stack.length - 1];
      const tag = it.ordered ? "ol" : "ul";
      if (top && it.indent === top.indent && top.tag !== tag) {   // "- a" then "1. b": a new list
        html += `</li></${stack.pop().tag}>`;
        top = stack[stack.length - 1];
      }
      if (!top || it.indent > top.indent) {
        const start = it.ordered && it.start !== 1 ? ` start="${it.start}"` : "";
        html += `<${tag}${start}><li>`;
        stack.push({ indent: it.indent, tag });
      } else {
        html += "</li><li>";
      }
      html += inline(it.text);
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`;
    return html;
  }

  function render(md) {
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = FENCE.exec(line);
      if (fence) {
        flush();
        const marker = fence[2], lang = fence[3];
        const body = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(marker[0].repeat(marker.length)) &&
               /^\s*[`~]+\s*$/.test(lines[i]))) {
          body.push(lines[i]);
          i++;
        }
        const closed = i < lines.length;
        i++;
        out.push(`<pre class="md-code${closed ? "" : " open"}" data-lang="${esc(lang)}"><code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      const h = HEADING.exec(line);
      if (h) { flush(); const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
      if (RULE.test(line)) { flush(); out.push("<hr>"); i++; continue; }
      if (QUOTE.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) { body.push(QUOTE.exec(lines[i])[1]); i++; }
        out.push(`<blockquote>${render(body.join("\n"))}</blockquote>`);
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flush();
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c)}</${tag}>`;
        out.push(`<table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k] || "", k)).join("")}</tr>`).join("") + "</tbody></table>");
        continue;
      }
      if (ITEM.test(line)) {
        flush();
        const items = [];
        while (i < lines.length) {
          const m = ITEM.exec(lines[i]);
          if (m) {
            const ordered = /\d/.test(m[2]);
            items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered, start: ordered ? parseInt(m[2], 10) : 1, text: m[3] });
            i++;
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1].text += " " + lines[i].trim();   // continuation line
            i++;
          } else break;
        }
        out.push(renderList(items));
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out.join("");
  }

  // The fenced code blocks of a reply, for "insert into editor" and tests.
  function codeBlocks(md) {
    const blocks = [];
    const re = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*\n([\s\S]*?)\n\s{0,3}\1\s*$/gm;
    let m;
    while ((m = re.exec(String(md || "")))) blocks.push({ lang: m[2], code: m[3] });
    return blocks;
  }

  return { render, inline, codeBlocks, escape: esc };
});
