// Source outline of the open file — headings, floats, equations, theorems,
// \input/\include and the bibliography — plus a word count (pure functions,
// no DOM). The left panel's Outline section renders it; tests/js/outline.test.js
// covers it.
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TexOutline = api;
})(typeof self !== "undefined" ? self : this, function () {
  const HEAD_RANK = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
  const FLOATS = {
    figure: "figure", "figure*": "figure", wrapfigure: "figure", sidewaysfigure: "figure", SCfigure: "figure",
    table: "table", "table*": "table", sidewaystable: "table", wraptable: "table", longtable: "table",
    algorithm: "algorithm", "algorithm*": "algorithm", listing: "listing",
  };
  const EQUATIONS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*",
    "eqnarray", "eqnarray*", "displaymath", "flalign", "flalign*"]);
  const THEOREMS = new Set(["theorem", "lemma", "proposition", "corollary", "definition", "remark", "example",
    "proof", "claim", "conjecture", "assumption", "observation", "fact", "exercise", "problem", "note"]);
  const VERBATIM = ["verbatim", "verbatim*", "lstlisting", "minted", "comment", "Verbatim", "alltt"];

  function escaped(text, i) {
    let n = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) n++;
    return n % 2 === 1;
  }

  // Comments and verbatim bodies blanked to spaces (offsets and newlines kept).
  function blank(text) {
    const out = text.split("");
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "%" && !escaped(text, i)) {
        while (i < text.length && text[i] !== "\n") out[i++] = " ";
      }
    }
    let clean = out.join("");
    for (const env of VERBATIM) {
      const open = `\\begin{${env}}`, close = `\\end{${env}}`;
      let i = clean.indexOf(open);
      while (i >= 0) {
        const start = i + open.length;
        const end = clean.indexOf(close, start);
        const stop = end < 0 ? clean.length : end;
        clean = clean.slice(0, start) + clean.slice(start, stop).replace(/[^\n]/g, " ") + clean.slice(stop);
        i = clean.indexOf(open, stop);
      }
    }
    return clean;
  }

  // From `i` at "{" (or "["), the index just past its match, or -1.
  function group(text, i) {
    const open = text[i], close = open === "[" ? "]" : "}";
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === "\\") { j++; continue; }
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return j + 1;
    }
    return -1;
  }

  function skipWs(text, i) {
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  }

  // LaTeX → display text: math kept, commands and braces dropped.
  function plain(tex) {
    let out = "";
    const parts = String(tex).split(/(\$[^$]*\$)/);
    for (const part of parts) {
      if (part.startsWith("$") && part.endsWith("$") && part.length > 1) { out += part; continue; }
      out += part
        .replace(/\\\\/g, " ")
        .replace(/~/g, " ")
        .replace(/\\(?:label|ref|cite|footnote|index)\*?\s*\{[^{}]*\}/g, "")
        .replace(/\\[a-zA-Z@]+\*?/g, "")
        .replace(/\\(.)/g, "$1")
        .replace(/[{}]/g, "");
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    return starts;
  }

  function lineOf(starts, offset) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // The argument at `i` (after optional whitespace): [opt]? {arg} → {opt, arg, end}.
  function args(text, i) {
    let j = skipWs(text, i), opt = null;
    if (text[j] === "[") {
      const e = group(text, j);
      if (e < 0) return null;
      opt = text.slice(j + 1, e - 1);
      j = skipWs(text, e);
    }
    if (text[j] !== "{") return { opt, arg: null, end: j };
    const e = group(text, j);
    if (e < 0) return null;
    return { opt, arg: text.slice(j + 1, e - 1), end: e };
  }

  function labelIn(text) {
    const m = /\\label\s*\{([^}]*)\}/.exec(text);
    return m ? m[1].trim() : null;
  }

  function captionIn(text) {
    const m = /\\caption\*?\s*/.exec(text);
    if (!m) return null;
    const a = args(text, m.index + m[0].length);
    return a && a.arg != null ? plain(a.arg) || (a.opt != null ? plain(a.opt) : null) : null;
  }

  function withTex(target) {
    target = target.trim();
    return /\.[A-Za-z0-9]+$/.test(target) ? target : target + ".tex";
  }

  const TOKEN = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)(?![A-Za-z])|\\begin\s*\{([^}]+)\}|\\(input|include|subfile|import|subimport|includefrom|subincludefrom)(?![A-Za-z])|\\(bibliography|addbibresource)(?![A-Za-z])|\\printbibliography(?![A-Za-z])|\\appendix(?![A-Za-z])|\\title(?![A-Za-z])/g;

  function parseTex(text) {
    const clean = blank(text);
    const starts = lineStarts(text);
    const items = [];
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(clean))) {
      const at = m.index, after = at + m[0].length;
      const item = (fields) => items.push({ offset: at, line: lineOf(starts, at), ...fields });
      if (m[1]) {
        const a = args(clean, after);
        if (!a || a.arg == null) continue;
        const title = plain(a.arg) || (a.opt != null && plain(a.opt)) || "(untitled)";
        // a \label right after the heading belongs to it
        const rest = clean.slice(a.end, a.end + 200);
        const lm = /^\s*\\label\s*\{([^}]*)\}/.exec(rest);
        item({ kind: "heading", level: m[1], rank: HEAD_RANK[m[1]], starred: !!m[2], title, label: lm ? lm[1].trim() : null });
        TOKEN.lastIndex = a.end;
      } else if (m[3]) {
        const env = m[3].trim();
        const close = `\\end{${env}}`;
        const endAt = clean.indexOf(close, after);
        const cleanBody = clean.slice(after, endAt < 0 ? Math.min(clean.length, after + 4000) : endAt);
        if (FLOATS[env]) {
          const kind = FLOATS[env];
          item({ kind, env, title: captionIn(cleanBody) || (kind[0].toUpperCase() + kind.slice(1)), label: labelIn(cleanBody) });
        } else if (EQUATIONS.has(env)) {
          const label = labelIn(cleanBody);
          const snippet = cleanBody.replace(/\\label\s*\{[^}]*\}/g, "").replace(/\s+/g, " ").trim();
          item({ kind: "equation", env, title: snippet.length > 48 ? snippet.slice(0, 47) + "…" : snippet || env, label });
        } else if (THEOREMS.has(env)) {
          const a = args(clean, after);
          const name = env[0].toUpperCase() + env.slice(1);
          const note = a && a.opt != null ? plain(a.opt) : "";
          item({ kind: "theorem", env, title: note ? `${name} (${note})` : name, label: labelIn(cleanBody) });
        } else if (env === "abstract") {
          item({ kind: "abstract", env, title: "Abstract" });
        }
      } else if (m[4]) {
        const a1 = args(clean, after);
        if (!a1 || a1.arg == null) continue;
        let target = a1.arg;
        if (/import|includefrom/.test(m[4])) {
          const a2 = args(clean, a1.end);
          if (!a2 || a2.arg == null) continue;
          target = a1.arg.replace(/\/?$/, "/") + a2.arg;
          TOKEN.lastIndex = a2.end;
        } else TOKEN.lastIndex = a1.end;
        const path = withTex(target);
        item({ kind: "input", command: m[4], title: path, target: path });
      } else if (m[5]) {
        const a = args(clean, after);
        const files = a && a.arg ? a.arg.split(",").map((s) => s.trim()).filter(Boolean) : [];
        item({ kind: "bib", title: "Bibliography", detail: files.join(", ") });
        if (a) TOKEN.lastIndex = a.end;
      } else if (m[0].startsWith("\\printbibliography")) {
        item({ kind: "bib", title: "Bibliography" });
      } else if (m[0].startsWith("\\appendix")) {
        item({ kind: "appendix", title: "Appendix" });
      } else if (m[0].startsWith("\\title")) {
        const a = args(clean, after);
        if (!a || a.arg == null) continue;
        item({ kind: "title", title: plain(a.arg) || "Title" });
        TOKEN.lastIndex = a.end;
      }
    }
    // a bibliography resource named twice (\addbibresource + \printbibliography) shows once
    return depthify(items.filter((it, i, all) =>
      it.kind !== "bib" || !all.slice(0, i).some((o) => o.kind === "bib" && !o.detail === !it.detail)));
  }

  function parseMarkdown(text) {
    const lines = text.split("\n");
    const items = [];
    let fence = null, offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const f = /^\s{0,3}(```|~~~)/.exec(ln);
      if (f) fence = fence === f[1] ? null : (fence || f[1]);
      else if (!fence) {
        const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln);
        if (h) items.push({ offset, line: i, kind: "heading", level: "h" + h[1].length, rank: h[1].length,
          title: h[2].replace(/[*_`]/g, "").trim() });
      }
      offset += ln.length + 1;
    }
    return depthify(items);
  }

  // depth: headings relative to the file's top heading; other items one below
  // the heading they follow.
  function depthify(items) {
    const ranks = items.filter((i) => i.kind === "heading").map((i) => i.rank);
    const top = ranks.length ? Math.min(...ranks) : 0;
    let current = -1;
    for (const it of items) {
      if (it.kind === "heading") { it.depth = it.rank - top; current = it.depth; }
      else if (it.kind === "title" || it.kind === "abstract" || it.kind === "appendix") it.depth = 0;
      else it.depth = current + 1;
    }
    return items;
  }

  function parse(text, lang) {
    if (lang === "md") return parseMarkdown(String(text || ""));
    return parseTex(String(text || ""));
  }

  // Index of the item the caret (0-based line) is in: the last one starting at
  // or before it, or -1.
  function activeIndex(items, line) {
    let best = -1;
    for (let i = 0; i < items.length; i++) if (items[i].line <= line) best = i; else break;
    return best;
  }

  // Words of prose: comments, commands, math and braces left out.
  function wordCount(text, lang) {
    let t = String(text || "");
    if (lang !== "md") {
      t = blank(t)
        .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, " ")
        .replace(/\\(?:begin|end|label|ref|eqref|cite[a-z]*|includegraphics|input|include|usepackage|documentclass|bibliography(?:style)?)\*?\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, " ")
        .replace(/\\[a-zA-Z@]+\*?/g, " ");
    } else {
      t = t.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
    }
    const words = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return words ? words.length : 0;
  }

  return { parse, parseTex, parseMarkdown, activeIndex, wordCount, plain };
});
