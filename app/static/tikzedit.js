// TikZ editor tool — source helpers (pure functions, no DOM).
// app/static/tikzedit-ui.js opens the embedded editor
// (https://github.com/DominikPeters/tikz-editor) and uses these to find the
// picture at the cursor, hand the editor the preamble definitions the picture
// relies on, and take the edited picture back. tests/js/tikzedit.test.js
// covers them.
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TikzEdit = api;
})(typeof self !== "undefined" ? self : this, function () {
  const ENV = "tikzpicture";
  const BEGIN = `\\begin{${ENV}}`;
  const END = `\\end{${ENV}}`;
  const CONTEXT_NOTE = "% from the preamble: changes here are added to it";
  const EMPTY_PICTURE = `${BEGIN}\n${END}`;

  // Is `i` inside a % comment (an unescaped % earlier on the same line)?
  function inComment(text, i) {
    let start = text.lastIndexOf("\n", i - 1) + 1;
    for (let j = start; j < i; j++) {
      if (text[j] === "%" && !escaped(text, j)) return true;
    }
    return false;
  }

  function escaped(text, i) {
    let n = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) n++;
    return n % 2 === 1;
  }

  // Text with every comment blanked out (same length, offsets preserved).
  function blankComments(text) {
    let out = "", i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "%" && !escaped(text, i)) {
        let end = text.indexOf("\n", i);
        if (end < 0) end = text.length;
        out += " ".repeat(end - i);
        i = end;
      } else { out += ch; i++; }
    }
    return out;
  }

  // Every tikzpicture environment → [{from, to, depth}], outermost first per
  // nesting, `to` just past \end{tikzpicture}. Unclosed openings are dropped.
  function pictures(text) {
    const clean = blankComments(text);
    const tokens = [];
    for (const [tok, kind] of [[BEGIN, "b"], [END, "e"]]) {
      let i = clean.indexOf(tok);
      while (i >= 0) { tokens.push({ at: i, kind }); i = clean.indexOf(tok, i + tok.length); }
    }
    tokens.sort((a, b) => a.at - b.at);
    const stack = [], out = [];
    for (const t of tokens) {
      if (t.kind === "b") stack.push(t.at);
      else if (stack.length) {
        const from = stack.pop();
        out.push({ from, to: t.at + END.length, depth: stack.length });
      }
    }
    return out.sort((a, b) => a.from - b.from);
  }

  // The outermost picture holding the caret → {from, to, text} | null.
  // A caret right before \begin or right after \end counts as inside.
  function pictureAt(text, caret) {
    let best = null;
    for (const p of pictures(text)) {
      if (p.from <= caret && caret <= p.to && (!best || p.from < best.from)) best = p;
    }
    return best ? { from: best.from, to: best.to, text: text.slice(best.from, best.to) } : null;
  }

  // From `i` (at an opening brace or bracket), the index just past its match.
  function skipGroup(text, i) {
    const open = text[i], close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === "\\") { j++; continue; }
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return j + 1;
    }
    return -1;
  }

  // Preamble commands a picture may depend on, and how many {…} groups each takes.
  const DEFINITIONS = {
    usetikzlibrary: 1, usepgflibrary: 1, usepgfplotslibrary: 1,
    tikzset: 1, pgfkeys: 1, pgfplotsset: 1,
    definecolor: 3, colorlet: 2,
    tikzstyle: 0,           // \tikzstyle{name}=[keys] (old syntax), parsed specially
  };
  const DEF_RE = new RegExp(String.raw`\\(${Object.keys(DEFINITIONS).join("|")})(?![A-Za-z])`, "g");

  // TikZ-related definitions in `text` → [statement source], in order.
  function definitions(text) {
    const clean = blankComments(text);
    const out = [];
    DEF_RE.lastIndex = 0;
    let m;
    while ((m = DEF_RE.exec(clean))) {
      const name = m[1];
      let j = m.index + m[0].length;
      const ws = () => { while (j < clean.length && /\s/.test(clean[j])) j++; };
      let ok = true;
      if (name === "tikzstyle") {
        ws();
        if (clean[j] !== "{" || (j = skipGroup(clean, j)) < 0) ok = false;
        if (ok) { ws(); if (clean[j] === "=") { j++; ws(); } else ok = false; }
        if (ok && (clean[j] !== "[" || (j = skipGroup(clean, j)) < 0)) ok = false;
      } else {
        let groups = DEFINITIONS[name];
        ws();
        if (name === "definecolor" && clean[j] === "[") { j = skipGroup(clean, j); ws(); }
        while (ok && groups-- > 0) {
          if (clean[j] !== "{") { ok = false; break; }
          j = skipGroup(clean, j);
          if (j < 0) { ok = false; break; }
          if (groups > 0) ws();
        }
      }
      if (!ok || j < 0) continue;
      out.push(text.slice(m.index, j));
      DEF_RE.lastIndex = j;
    }
    return out;
  }

  const normalize = (s) => s.replace(/\s+/g, " ").trim();

  // The editor's starting source: the preamble's TikZ definitions (so styles,
  // colours and libraries resolve as in the document), then the picture.
  function compose(preamble, picture) {
    const defs = definitions(preamble || "");
    const body = (picture && picture.trim()) || EMPTY_PICTURE;
    if (!defs.length) return { source: body + "\n", context: [] };
    return { source: [CONTEXT_NOTE, ...defs, "", body, ""].join("\n"), context: defs };
  }

  // Edited source → {picture, count, added} | null.
  //   picture  the text to write back (first picture to the end of the last)
  //   count    how many top-level pictures it holds
  //   added    definitions before the picture that the preamble did not have
  function extract(source, context) {
    const top = pictures(source).filter((p) => p.depth === 0);
    if (!top.length) return null;
    const from = top[0].from, to = top[top.length - 1].to;
    const known = new Set((context || []).map(normalize));
    const seen = new Set();
    const added = [];
    for (const d of definitions(source.slice(0, from))) {
      const key = normalize(d);
      if (known.has(key) || seen.has(key)) continue;
      seen.add(key);
      added.push(d);
    }
    return { picture: source.slice(from, to), count: top.length, added };
  }

  // Libraries loaded by \usetikzlibrary in `text`.
  function libraries(text) {
    const out = [];
    for (const d of definitions(text)) {
      const m = /^\\usetikzlibrary\s*\{([^}]*)\}/.exec(d);
      if (m) for (const lib of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!out.includes(lib)) out.push(lib);
      }
    }
    return out;
  }

  // Lines to add to the preamble for `added` definitions: libraries the
  // preamble already loads are dropped, and \usepackage{tikz} comes first
  // when nothing loads TikZ yet.
  function preambleAdditions(preamble, added) {
    preamble = blankComments(preamble || "");
    const have = new Set(libraries(preamble));
    const lines = [];
    if (!loadsTikz(preamble)) lines.push("\\usepackage{tikz}");
    for (const d of added || []) {
      const m = /^\\usetikzlibrary\s*\{([^}]*)\}$/.exec(d.trim());
      if (m) {
        const libs = m[1].split(",").map((s) => s.trim()).filter((l) => l && !have.has(l));
        libs.forEach((l) => have.add(l));
        if (libs.length) lines.push(`\\usetikzlibrary{${libs.join(",")}}`);
      } else lines.push(d.trim());
    }
    return lines;
  }

  // Does the preamble load TikZ (directly or through a package built on it)?
  function loadsTikz(preamble) {
    const clean = blankComments(preamble || "");
    const re = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(clean))) {
      const pkgs = m[1].split(",").map((s) => s.trim());
      if (pkgs.some((p) => /^(tikz|pgf|pgfplots|circuitikz|tikz-cd|forest|tkz-euclide|smartdiagram)$/.test(p))) return true;
    }
    return false;
  }

  return {
    BEGIN, END, EMPTY_PICTURE, CONTEXT_NOTE,
    pictures, pictureAt, definitions, compose, extract, libraries,
    preambleAdditions, loadsTikz, blankComments, inComment,
  };
});
