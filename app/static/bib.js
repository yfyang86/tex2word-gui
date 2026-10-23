// Reference manager helpers (pure, no DOM): search matching, sorting, where a
// citation goes in the editor text, and a search query from a citation key.
// bib-ui.js uses them; tests/js/bib.test.js covers them.
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BibUI = api;
})(typeof self !== "undefined" ? self : this, function () {
  const fold = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // JabRef-style search: every word must match somewhere; "field:word" limits it
  // to one field (key, author, title, year, venue, type, or any BibTeX field).
  function parseQuery(q) {
    const terms = [];
    const re = /(\w+):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(q || "")))) {
      if (m[1]) terms.push({ field: m[1].toLowerCase(), text: fold(m[3] != null ? m[3] : m[2]) });
      else terms.push({ field: null, text: fold(m[4] != null ? m[4] : m[5]) });
    }
    return terms.filter((t) => t.text);
  }

  function haystack(entry, field) {
    const d = entry.display || {};
    const fields = {};
    for (const f of entry.fields || []) fields[f.name] = f.value;
    const named = { key: entry.key, author: d.author_list || fields.author || fields.editor || "",
      title: d.title || fields.title || "", year: d.year || "", venue: d.venue || "", type: entry.type };
    if (field) return fold(field in named ? named[field] : fields[field] || "");
    return fold([entry.key, entry.type, named.author, named.title, named.year, named.venue,
      fields.doi, fields.eprint, fields.keywords, fields.abstract && fields.abstract.slice(0, 400)].join(" "));
  }

  function match(entry, query) {
    const terms = Array.isArray(query) ? query : parseQuery(query);
    if (!terms.length) return true;
    const all = haystack(entry, null);
    return terms.every((t) => (t.field ? haystack(entry, t.field) : all).includes(t.text));
  }

  const SORT = {
    key: (e) => fold(e.key),
    author: (e) => fold((e.display || {}).author_list),
    title: (e) => fold((e.display || {}).title),
    year: (e) => (e.display || {}).year || "",
    venue: (e) => fold((e.display || {}).venue),
    type: (e) => e.type,
    cited: (e) => String(e.cited || 0).padStart(5, "0"),
    line: (e) => String(e.line || 0).padStart(7, "0"),
  };

  function sort(entries, col, dir) {
    const get = SORT[col] || SORT.line;
    const k = dir === "desc" ? -1 : 1;
    return entries.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      if (x === y) return (a.line || 0) - (b.line || 0);
      if (x === "") return 1;
      if (y === "") return -1;
      return x < y ? -k : k;
    });
  }

  // Where to put a citation. Inside an existing \cite{a|} the keys are added
  // to it; otherwise a new \cmd{keys} replaces the selection.
  function citeEdit(text, from, to, keys, cmd) {
    const before = text.slice(0, from);
    const m = /\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)$/.exec(before);
    if (m && from === to && /^[^{}]*\}/.test(text.slice(from))) {
      const inside = m[1];
      const already = new Set(inside.split(",").map((s) => s.trim()).filter(Boolean));
      const add = keys.filter((k) => !already.has(k));
      if (!add.length) return null;
      const needComma = inside.trim() !== "" && !/,\s*$/.test(inside);
      return { from, to, insert: (needComma ? "," : "") + add.join(","), joined: true };
    }
    return { from, to, insert: `\\${cmd || "cite"}{${keys.join(",")}}`, joined: false };
  }

  // "vaswani2017attention" → "vaswani 2017 attention"; "LeCun15" → "LeCun 15".
  function keyToQuery(key) {
    return String(key || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Za-z])(\d)/g, "$1 $2")
      .replace(/(\d)([A-Za-z])/g, "$1 $2")
      .replace(/[_:.\-+/]+/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  // Fields to show for an entry type: required, optional, then the others it has.
  function fieldGroups(type, spec, present) {
    const s = (spec && spec[type]) || { required: [], optional: [] };
    const req = s.required.map((r) => r.split("/"));
    const reqNames = new Set(req.flat());
    const opt = s.optional.filter((f) => !reqNames.has(f));
    const known = new Set([...reqNames, ...opt]);
    const other = present.filter((f) => !known.has(f));
    return { required: req, optional: opt, other };
  }

  return { parseQuery, match, sort, citeEdit, keyToQuery, fieldGroups, fold };
});
