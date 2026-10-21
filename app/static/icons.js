// File-type icons for the file tree, the editor header and the outline
// (pure functions, no DOM). tests/js/icons.test.js covers them.
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FileIcons = api;
})(typeof self !== "undefined" ? self : this, function () {
  // extension → kind
  const KINDS = {
    tex: ["tex", "ltx", "latex"],
    bib: ["bib", "bbl", "bst"],
    sty: ["sty", "cls", "def", "clo", "cfg", "dtx", "ins"],
    md: ["md", "markdown"],
    tikz: ["tikz", "pgf"],
    image: ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "tif", "tiff"],
    pdf: ["pdf", "eps", "ps"],
    data: ["csv", "tsv", "dat", "json", "yaml", "yml", "xml"],
    text: ["txt", "log", "rst"],
  };
  const BY_EXT = {};
  for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) BY_EXT[e] = kind;

  const LABELS = {
    tex: "LaTeX", bib: "Bibliography", sty: "Package / class", md: "Markdown",
    tikz: "TikZ", image: "Image", pdf: "PDF / PostScript", data: "Data", text: "Text", file: "File",
    folder: "Folder",
  };

  function ext(path) {
    const name = String(path || "").split("/").pop();
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i + 1).toLowerCase() : "";
  }

  function kindOf(path) { return BY_EXT[ext(path)] || "file"; }

  // 24×24 stroke glyphs; colour comes from the .ft-<kind> class (currentColor).
  const PATHS = {
    tex: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    bib: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="M9 7h7"/>',
    sty: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
    md: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6M16 9v6M14 13l2 2 2-2"/>',
    tikz: '<path d="M5 18C8 5 15 19 19 6"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 15h1.5a1.5 1.5 0 0 0 0-3H8v5"/>',
    data: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
    text: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    "folder-open": '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L22 11H7.2a2 2 0 0 0-1.9 1.4L3 19"/>',
  };

  function svg(kind, size) {
    size = size || 14;
    const body = PATHS[kind] || PATHS.file;
    return `<svg class="ft-icon ft-${kind}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  function forPath(path, size) { return svg(kindOf(path), size); }

  function label(kind) { return LABELS[kind] || LABELS.file; }

  return { kindOf, svg, forPath, label, ext, KINDS };
});
