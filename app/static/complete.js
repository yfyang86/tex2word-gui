// Smart LaTeX autocompletion — the engine (pure functions, no DOM).
// app.js wires it to the editor; tests/js/complete.test.js covers it in node.
//
//   index    = TexComplete.buildIndex({path: content, …})   project symbols
//   result   = TexComplete.complete(text, caret, index, opts) → {items, from, to, kind}
//   snippet  = TexComplete.expandSnippet("\\frac{${1:a}}{${2:b}}") → {text, stops}
//
// Completion is context-aware: commands (math-aware ranking), environments
// (\end{ suggests the innermost open one), \ref-family → labels (with what
// they label), \cite-family → bibliography keys (.bib + \bibitem), \input /
// \includegraphics / \bibliography → project files, \usepackage → packages,
// and user macros/environments defined anywhere in the project.
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TexComplete = api;
})(typeof self !== "undefined" ? self : this, function () {
  // ── Catalog ────────────────────────────────────────────────────────────
  // [name, snippet-after-name, description, where] — where: "t" text, "m" math,
  // "b" both; an optional 5th field names the package that provides it.
  const C = [
    // structure
    ["section", "{${1:title}}", "section heading", "t"],
    ["subsection", "{${1:title}}", "subsection heading", "t"],
    ["subsubsection", "{${1:title}}", "sub-subsection heading", "t"],
    ["section*", "{${1:title}}", "unnumbered section", "t"],
    ["subsection*", "{${1:title}}", "unnumbered subsection", "t"],
    ["chapter", "{${1:title}}", "chapter heading (book/report)", "t"],
    ["part", "{${1:title}}", "part heading", "t"],
    ["paragraph", "{${1:title}}", "run-in paragraph heading", "t"],
    ["subparagraph", "{${1:title}}", "run-in sub-paragraph heading", "t"],
    ["appendix", "", "start the appendix", "t"],
    ["label", "{${1:key}}", "label for \\ref", "b"],
    ["ref", "{${1:key}}", "cross-reference", "b"],
    ["eqref", "{${1:key}}", "equation reference (with parentheses)", "b", "amsmath"],
    ["pageref", "{${1:key}}", "page of a label", "t"],
    ["nameref", "{${1:key}}", "title of a labelled section", "t", "hyperref"],
    ["autoref", "{${1:key}}", "reference with type name", "t", "hyperref"],
    ["cref", "{${1:key}}", "clever reference", "t", "cleveref"],
    ["Cref", "{${1:key}}", "clever reference (capitalised)", "t", "cleveref"],
    ["cite", "{${1:key}}", "citation", "t"],
    ["citep", "{${1:key}}", "parenthetical citation", "t", "natbib"],
    ["citet", "{${1:key}}", "textual citation", "t", "natbib"],
    ["citeauthor", "{${1:key}}", "author of a citation", "t", "natbib"],
    ["citeyear", "{${1:key}}", "year of a citation", "t", "natbib"],
    ["parencite", "{${1:key}}", "parenthetical citation", "t", "biblatex"],
    ["textcite", "{${1:key}}", "textual citation", "t", "biblatex"],
    ["autocite", "{${1:key}}", "automatic citation", "t", "biblatex"],
    ["footcite", "{${1:key}}", "citation in a footnote", "t", "biblatex"],
    ["nocite", "{${1:*}}", "list without citing", "t"],
    ["footnote", "{${1:text}}", "footnote", "t"],
    ["caption", "{${1:text}}", "float caption", "t"],
    ["includegraphics", "[width=${1:0.8}\\linewidth]{${2:file}}", "insert an image", "t", "graphicx"],
    ["input", "{${1:file}}", "include a file", "t"],
    ["include", "{${1:file}}", "include a file (new page)", "t"],
    ["bibliography", "{${1:refs}}", "BibTeX database", "t"],
    ["bibliographystyle", "{${1:plain}}", "BibTeX style", "t"],
    ["addbibresource", "{${1:refs.bib}}", "biblatex database", "t", "biblatex"],
    ["printbibliography", "", "print the bibliography", "t", "biblatex"],
    ["maketitle", "", "typeset the title block", "t"],
    ["tableofcontents", "", "table of contents", "t"],
    ["title", "{${1:title}}", "document title", "t"],
    ["author", "{${1:name}}", "document author", "t"],
    ["date", "{${1:\\today}}", "document date", "t"],
    ["today", "", "today's date", "t"],
    ["thanks", "{${1:text}}", "title footnote", "t"],
    ["usepackage", "{${1:package}}", "load a package", "t"],
    ["documentclass", "{${1:article}}", "document class", "t"],
    ["newcommand", "{\\\\${1:name}}[${2:0}]{${3:definition}}", "define a command", "t"],
    ["renewcommand", "{\\\\${1:name}}{${2:definition}}", "redefine a command", "t"],
    ["newenvironment", "{${1:name}}{${2:begin}}{${3:end}}", "define an environment", "t"],
    ["newtheorem", "{${1:theorem}}{${2:Theorem}}", "define a theorem environment", "t", "amsthm"],
    ["DeclareMathOperator", "{\\\\${1:name}}{${2:text}}", "define a math operator", "t", "amsmath"],
    ["item", " ", "list item", "t"],
    ["centering", "", "center the float contents", "t"],
    ["noindent", "", "no paragraph indent", "t"],
    ["newpage", "", "new page", "t"],
    ["clearpage", "", "flush floats and start a page", "t"],
    ["vspace", "{${1:1em}}", "vertical space", "t"],
    ["hspace", "{${1:1em}}", "horizontal space", "t"],
    ["smallskip", "", "small vertical skip", "t"],
    ["medskip", "", "medium vertical skip", "t"],
    ["bigskip", "", "big vertical skip", "t"],
    ["linewidth", "", "current line width", "t"],
    ["textwidth", "", "text block width", "t"],
    ["hline", "", "table rule", "t"],
    ["toprule", "", "top table rule", "t", "booktabs"],
    ["midrule", "", "middle table rule", "t", "booktabs"],
    ["bottomrule", "", "bottom table rule", "t", "booktabs"],
    ["cmidrule", "{${1:1-2}}", "partial table rule", "t", "booktabs"],
    ["multicolumn", "{${1:2}}{${2:c}}{${3:text}}", "span table columns", "t"],
    ["multirow", "{${1:2}}{*}{${2:text}}", "span table rows", "t", "multirow"],
    ["url", "{${1:url}}", "typeset a URL", "t", "url"],
    ["href", "{${1:url}}{${2:text}}", "hyperlink", "t", "hyperref"],
    ["textcolor", "{${1:red}}{${2:text}}", "coloured text", "b", "xcolor"],
    ["SI", "{${1:1}}{${2:\\metre}}", "number with unit", "b", "siunitx"],
    ["si", "{${1:\\metre}}", "unit", "b", "siunitx"],
    ["num", "{${1:1000}}", "formatted number", "b", "siunitx"],
    // text formatting
    ["textbf", "{${1:text}}", "bold", "t"],
    ["textit", "{${1:text}}", "italic", "t"],
    ["emph", "{${1:text}}", "emphasis", "t"],
    ["texttt", "{${1:text}}", "typewriter", "t"],
    ["textsc", "{${1:text}}", "small caps", "t"],
    ["textsf", "{${1:text}}", "sans serif", "t"],
    ["textrm", "{${1:text}}", "roman", "t"],
    ["underline", "{${1:text}}", "underline", "t"],
    ["textsuperscript", "{${1:text}}", "superscript", "t"],
    ["textsubscript", "{${1:text}}", "subscript", "t"],
    ["verb", "|${1:code}|", "inline verbatim", "t"],
    ["mbox", "{${1:text}}", "unbreakable box", "t"],
    ["tiny", "", "tiny font size", "t"], ["small", "", "small font size", "t"],
    ["footnotesize", "", "footnote font size", "t"], ["normalsize", "", "normal font size", "t"],
    ["large", "", "large font size", "t"], ["Large", "", "larger font size", "t"],
    ["LaTeX", "", "the LaTeX logo", "t"], ["TeX", "", "the TeX logo", "t"],
    ["ldots", "", "ellipsis …", "b"], ["dots", "", "ellipsis", "b"],
    // math: structures
    ["frac", "{${1:num}}{${2:den}}", "fraction", "m"],
    ["dfrac", "{${1:num}}{${2:den}}", "display-style fraction", "m", "amsmath"],
    ["tfrac", "{${1:num}}{${2:den}}", "text-style fraction", "m", "amsmath"],
    ["sqrt", "{${1:x}}", "square root", "m"],
    ["sum", "_{${1:i=1}}^{${2:n}}", "sum Σ", "m"],
    ["prod", "_{${1:i=1}}^{${2:n}}", "product Π", "m"],
    ["int", "_{${1:a}}^{${2:b}}", "integral ∫", "m"],
    ["iint", "", "double integral", "m", "amsmath"],
    ["oint", "", "contour integral", "m"],
    ["lim", "_{${1:x \\to \\infty}}", "limit", "m"],
    ["binom", "{${1:n}}{${2:k}}", "binomial coefficient", "m", "amsmath"],
    ["text", "{${1:text}}", "text inside math", "m", "amsmath"],
    ["mathrm", "{${1:x}}", "upright math", "m"],
    ["mathbf", "{${1:x}}", "bold math", "m"],
    ["mathit", "{${1:x}}", "italic math", "m"],
    ["mathcal", "{${1:X}}", "calligraphic 𝒳", "m"],
    ["mathbb", "{${1:R}}", "blackboard bold ℝ", "m", "amssymb"],
    ["mathfrak", "{${1:g}}", "fraktur", "m", "amssymb"],
    ["mathsf", "{${1:x}}", "sans-serif math", "m"],
    ["boldsymbol", "{${1:x}}", "bold symbol", "m", "amsmath"],
    ["operatorname", "{${1:name}}", "named operator", "m", "amsmath"],
    ["hat", "{${1:x}}", "hat accent x̂", "m"], ["widehat", "{${1:xy}}", "wide hat", "m"],
    ["bar", "{${1:x}}", "bar accent x̄", "m"], ["overline", "{${1:xy}}", "overline", "m"],
    ["tilde", "{${1:x}}", "tilde accent x̃", "m"], ["widetilde", "{${1:xy}}", "wide tilde", "m"],
    ["vec", "{${1:x}}", "vector arrow", "m"], ["dot", "{${1:x}}", "dot accent ẋ", "m"],
    ["ddot", "{${1:x}}", "double dot ẍ", "m"],
    ["underbrace", "{${1:x}}_{${2:text}}", "underbrace", "m"],
    ["overbrace", "{${1:x}}^{${2:text}}", "overbrace", "m"],
    ["left(", "${1} \\right)", "auto-sized parentheses", "m"],
    ["left[", "${1} \\right]", "auto-sized brackets", "m"],
    ["left\\{", "${1} \\right\\}", "auto-sized braces", "m"],
    ["left|", "${1} \\right|", "auto-sized bars", "m"],
    ["left", "", "auto-sized delimiter", "m"], ["right", "", "auto-sized delimiter", "m"],
    ["quad", "", "space", "m"], ["qquad", "", "double space", "m"],
    ["tag", "{${1:1}}", "custom equation tag", "m", "amsmath"],
    ["nonumber", "", "suppress the equation number", "m"],
    ["notag", "", "suppress the equation number", "m", "amsmath"],
    ["displaystyle", "", "display-size math", "m"],
    // math: relations & operators
    ["leq", "", "≤", "m"], ["geq", "", "≥", "m"], ["neq", "", "≠", "m"],
    ["le", "", "≤", "m"], ["ge", "", "≥", "m"], ["ll", "", "≪", "m"], ["gg", "", "≫", "m"],
    ["approx", "", "≈", "m"], ["equiv", "", "≡", "m"], ["sim", "", "∼", "m"], ["simeq", "", "≃", "m"],
    ["propto", "", "∝", "m"], ["cong", "", "≅", "m"],
    ["in", "", "∈", "m"], ["notin", "", "∉", "m"], ["ni", "", "∋", "m"],
    ["subset", "", "⊂", "m"], ["subseteq", "", "⊆", "m"], ["supset", "", "⊃", "m"], ["supseteq", "", "⊇", "m"],
    ["cup", "", "∪", "m"], ["cap", "", "∩", "m"], ["bigcup", "", "⋃", "m"], ["bigcap", "", "⋂", "m"],
    ["setminus", "", "∖", "m"], ["emptyset", "", "∅", "m"], ["varnothing", "", "∅", "m", "amssymb"],
    ["times", "", "×", "m"], ["cdot", "", "·", "m"], ["cdots", "", "⋯", "m"], ["vdots", "", "⋮", "m"],
    ["ddots", "", "⋱", "m"], ["div", "", "÷", "m"], ["pm", "", "±", "m"], ["mp", "", "∓", "m"],
    ["circ", "", "∘", "m"], ["ast", "", "∗", "m"], ["star", "", "⋆", "m"], ["otimes", "", "⊗", "m"],
    ["oplus", "", "⊕", "m"], ["wedge", "", "∧", "m"], ["vee", "", "∨", "m"], ["neg", "", "¬", "m"],
    ["forall", "", "∀", "m"], ["exists", "", "∃", "m"], ["nexists", "", "∄", "m", "amssymb"],
    ["partial", "", "∂", "m"], ["nabla", "", "∇", "m"], ["infty", "", "∞", "m"],
    ["to", "", "→", "m"], ["rightarrow", "", "→", "m"], ["leftarrow", "", "←", "m"],
    ["Rightarrow", "", "⇒", "m"], ["Leftarrow", "", "⇐", "m"], ["leftrightarrow", "", "↔", "m"],
    ["Leftrightarrow", "", "⇔", "m"], ["iff", "", "⟺", "m"], ["implies", "", "⟹", "m", "amsmath"],
    ["mapsto", "", "↦", "m"], ["longrightarrow", "", "⟶", "m"], ["uparrow", "", "↑", "m"], ["downarrow", "", "↓", "m"],
    ["mid", "", "∣", "m"], ["parallel", "", "∥", "m"], ["perp", "", "⊥", "m"],
    ["langle", "", "⟨", "m"], ["rangle", "", "⟩", "m"], ["lfloor", "", "⌊", "m"], ["rfloor", "", "⌋", "m"],
    ["lceil", "", "⌈", "m"], ["rceil", "", "⌉", "m"], ["|", "", "‖", "m"],
    ["log", "", "logarithm", "m"], ["ln", "", "natural log", "m"], ["exp", "", "exponential", "m"],
    ["sin", "", "sine", "m"], ["cos", "", "cosine", "m"], ["tan", "", "tangent", "m"],
    ["max", "", "maximum", "m"], ["min", "", "minimum", "m"], ["sup", "", "supremum", "m"], ["inf", "", "infimum", "m"],
    ["arg", "", "argument", "m"], ["det", "", "determinant", "m"], ["dim", "", "dimension", "m"],
    ["Pr", "", "probability", "m"], ["deg", "", "degree", "m"], ["ker", "", "kernel", "m"],
    ["argmax", "", "arg max (needs \\DeclareMathOperator)", "m"],
    ["argmin", "", "arg min (needs \\DeclareMathOperator)", "m"],
    ["mathbb{R}", "", "real numbers ℝ", "m", "amssymb"], ["mathbb{N}", "", "naturals ℕ", "m", "amssymb"],
    ["mathbb{Z}", "", "integers ℤ", "m", "amssymb"], ["mathbb{E}", "", "expectation 𝔼", "m", "amssymb"],
    // Greek
    ...["alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
        "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma",
        "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
        "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"]
      .map((g) => [g, "", "Greek letter", "m"]),
  ];

  // [name, body, description, package?] — body goes between \begin and \end.
  const E = [
    ["equation", "\t${1}", "numbered equation"],
    ["equation*", "\t${1}", "unnumbered equation", "amsmath"],
    ["align", "\t${1} &= ${2} \\\\\\\\", "aligned equations", "amsmath"],
    ["align*", "\t${1} &= ${2}", "aligned equations, unnumbered", "amsmath"],
    ["gather", "\t${1}", "centred equations", "amsmath"],
    ["multline", "\t${1}", "one long equation", "amsmath"],
    ["split", "\t${1} &= ${2}", "split an equation", "amsmath"],
    ["cases", "\t${1} & \\text{if } ${2} \\\\\\\\\n\t${3} & \\text{otherwise}", "piecewise cases", "amsmath"],
    ["pmatrix", "\t${1} & ${2} \\\\\\\\\n\t${3} & ${4}", "matrix ( )", "amsmath"],
    ["bmatrix", "\t${1} & ${2} \\\\\\\\\n\t${3} & ${4}", "matrix [ ]", "amsmath"],
    ["array", "{${1:cc}}\n\t${2}", "math array"],
    ["itemize", "\t\\item ${1}", "bulleted list"],
    ["enumerate", "\t\\item ${1}", "numbered list"],
    ["description", "\t\\item[${1:term}] ${2}", "description list"],
    ["figure", "[${1:htbp}]\n\t\\centering\n\t\\includegraphics[width=${2:0.8}\\linewidth]{${3:file}}\n\t\\caption{${4:caption}}\n\t\\label{fig:${5:label}}", "figure float"],
    ["figure*", "[${1:t}]\n\t\\centering\n\t\\includegraphics[width=${2:\\textwidth}]{${3:file}}\n\t\\caption{${4:caption}}\n\t\\label{fig:${5:label}}", "full-width figure"],
    ["table", "[${1:htbp}]\n\t\\centering\n\t\\caption{${2:caption}}\n\t\\label{tab:${3:label}}\n\t\\begin{tabular}{${4:lc}}\n\t\t\\toprule\n\t\t${5} \\\\\\\\\n\t\t\\bottomrule\n\t\\end{tabular}", "table float"],
    ["tabular", "{${1:lc}}\n\t${2} \\\\\\\\", "table body"],
    ["subfigure", "{${1:0.48}\\linewidth}\n\t\\centering\n\t\\includegraphics[width=\\linewidth]{${2:file}}\n\t\\caption{${3:caption}}", "sub-figure", "subcaption"],
    ["minipage", "{${1:0.48}\\linewidth}\n\t${2}", "mini page"],
    ["center", "\t${1}", "centred block"],
    ["flushleft", "\t${1}", "left-aligned block"],
    ["flushright", "\t${1}", "right-aligned block"],
    ["quote", "\t${1}", "short quotation"],
    ["quotation", "\t${1}", "long quotation"],
    ["abstract", "\t${1}", "abstract"],
    ["verbatim", "${1}", "verbatim text"],
    ["lstlisting", "[language=${1:Python}]\n${2}", "code listing", "listings"],
    ["minted", "{${1:python}}\n${2}", "highlighted code", "minted"],
    ["theorem", "\t${1}", "theorem", "amsthm"],
    ["lemma", "\t${1}", "lemma", "amsthm"],
    ["proposition", "\t${1}", "proposition", "amsthm"],
    ["corollary", "\t${1}", "corollary", "amsthm"],
    ["definition", "\t${1}", "definition", "amsthm"],
    ["remark", "\t${1}", "remark", "amsthm"],
    ["proof", "\t${1}", "proof", "amsthm"],
    ["algorithm", "[${1:htbp}]\n\t\\caption{${2:caption}}\n\t\\begin{algorithmic}[1]\n\t\t\\State ${3}\n\t\\end{algorithmic}", "algorithm float", "algorithm"],
    ["algorithmic", "[1]\n\t\\State ${1}", "pseudo-code", "algpseudocode"],
    ["tikzpicture", "\t${1}", "TikZ drawing", "tikz"],
    ["thebibliography", "{${1:9}}\n\t\\bibitem{${2:key}} ${3}", "manual bibliography"],
    ["frame", "\n\t\\frametitle{${1:title}}\n\t${2}", "beamer slide", "beamer"],
    ["document", "\n${1}\n", "document body"],
  ];

  const PACKAGES = [
    ["amsmath", "math environments and macros"], ["amssymb", "extra math symbols"],
    ["amsthm", "theorem environments"], ["mathtools", "amsmath extensions"],
    ["graphicx", "\\includegraphics"], ["xcolor", "colours"], ["hyperref", "links and PDF metadata"],
    ["cleveref", "\\cref"], ["booktabs", "professional table rules"], ["multirow", "row-spanning cells"],
    ["tabularx", "auto-width tables"], ["longtable", "multi-page tables"], ["array", "tabular extensions"],
    ["siunitx", "units and numbers"], ["natbib", "author-year citations"], ["biblatex", "modern bibliographies"],
    ["subcaption", "sub-figures"], ["caption", "caption formatting"], ["float", "float placement [H]"],
    ["geometry", "page layout"], ["fancyhdr", "headers/footers"], ["enumitem", "list formatting"],
    ["listings", "code listings"], ["minted", "highlighted code"], ["tikz", "drawings"], ["pgfplots", "plots"],
    ["algorithm", "algorithm floats"], ["algpseudocode", "pseudo-code"], ["algorithm2e", "algorithms"],
    ["babel", "languages"], ["fontspec", "system fonts (XeLaTeX)"], ["xeCJK", "CJK (XeLaTeX)"],
    ["inputenc", "input encoding"], ["fontenc", "font encoding"], ["microtype", "micro-typography"],
    ["url", "URLs"], ["xspace", "smart spacing"], ["bm", "bold math"], ["bbm", "blackboard bold digits"],
    ["physics", "physics notation"], ["mhchem", "chemistry"], ["comment", "comment environments"],
    ["multicol", "multiple columns"], ["wrapfig", "wrapped figures"], ["setspace", "line spacing"],
    ["lipsum", "dummy text"], ["todonotes", "TODO notes"], ["glossaries", "glossaries"], ["acronym", "acronyms"],
  ].map(([name, desc]) => ({ name, desc }));
  const CLASSES = ["article", "report", "book", "letter", "beamer", "memoir", "amsart", "revtex4-2",
                   "IEEEtran", "llncs", "acmart", "elsarticle", "ctexart", "standalone"];

  const MATH_ENVS = /^(equation|align|gather|multline|flalign|alignat|eqnarray|math|displaymath|dmath)\*?$/;

  // ── Small text utilities ─────────────────────────────────────────────────
  function stripComments(text) {
    return text.replace(/(^|[^\\])%.*$/gm, "$1");
  }

  function lineAt(text, idx) {
    return text.slice(0, idx).split("\n").length;
  }

  function cleanText(s) {
    return (s || "").replace(/~/g, " ").replace(/\\(La)?TeX(?![a-zA-Z])/g, "$1TeX")
      .replace(/\\[a-zA-Z@]+\*?/g, " ").replace(/[{}$\\]/g, "").replace(/\s+/g, " ").trim();
  }

  // Balanced {…} group content starting at text[i] === "{".
  function braced(text, i) {
    if (text[i] !== "{") return null;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (c === "\\") { j++; continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return { value: text.slice(i + 1, j), end: j + 1 };
    }
    return null;
  }

  // ── Project index ─────────────────────────────────────────────────────────
  function parseBib(text, file) {
    const out = [];
    const re = /@([a-zA-Z]+)\s*[{(]\s*([^,\s]+)\s*,/g;
    let m;
    while ((m = re.exec(text))) {
      const type = m[1].toLowerCase();
      if (type === "comment" || type === "string" || type === "preamble") continue;
      const next = text.slice(re.lastIndex).search(/\n\s*@[a-zA-Z]/);
      const body = text.slice(re.lastIndex, next < 0 ? text.length : re.lastIndex + next);
      const field = (name) => {
        const f = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, "i").exec(body);
        if (!f) return "";
        const at = f.index + f[0].length;
        if (body[at] === "{") { const g = braced(body, at); return g ? cleanText(g.value) : ""; }
        if (body[at] === '"') { const e = body.indexOf('"', at + 1); return cleanText(body.slice(at + 1, e)); }
        return cleanText(body.slice(at).split(/[,\n]/)[0]);
      };
      out.push({
        key: m[2], type, file, line: lineAt(text, m.index),
        title: field("title"), author: field("author"), year: field("year") || field("date").slice(0, 4),
      });
    }
    return out;
  }

  const SECTION_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g;

  function indexTex(text, file, ix) {
    const code = stripComments(text);
    // definitions
    let m;
    // new commands only: \renewcommand targets already exist (often layout
    // parameters such as \topfraction redefined by a class file)
    const cmdRe = /\\(?:newcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([a-zA-Z@]+)\s*\}?\s*(?:\[(\d)\])?/g;
    while ((m = cmdRe.exec(code))) ix.macros.set(m[1], { name: m[1], args: +(m[2] || 0), file, line: lineAt(code, m.index) });
    const defRe = /\\(?:g|e|x)?def\s*\\([a-zA-Z@]+)((?:#\d)*)/g;
    while ((m = defRe.exec(code))) ix.macros.set(m[1], { name: m[1], args: (m[2].match(/#/g) || []).length, file, line: lineAt(code, m.index) });
    const opRe = /\\DeclareMathOperator\*?\s*\{\s*\\([a-zA-Z@]+)\s*\}/g;
    while ((m = opRe.exec(code))) ix.macros.set(m[1], { name: m[1], args: 0, math: true, file, line: lineAt(code, m.index) });
    const envRe = /\\(?:re)?newenvironment\s*\{([^}]+)\}\s*(?:\[(\d)\])?/g;
    while ((m = envRe.exec(code))) ix.envs.set(m[1], { name: m[1], args: +(m[2] || 0), file, desc: "project environment" });
    const thmRe = /\\newtheorem\*?\s*\{([^}]+)\}\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    while ((m = thmRe.exec(code))) ix.envs.set(m[1], { name: m[1], args: 0, file, desc: `theorem-like: ${m[2]}` });
    const boxRe = /\\(?:newtcolorbox|newmdenv)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
    while ((m = boxRe.exec(code))) ix.envs.set(m[1], { name: m[1], args: 0, file, desc: "project box" });
    const pkgRe = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
    while ((m = pkgRe.exec(code))) m[1].split(",").forEach((p) => p.trim() && ix.packages.add(p.trim()));
    // \bibitem{key} Authors. \newblock Title. \newblock Venue, 2017.
    const bibitemRe = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
    while ((m = bibitemRe.exec(code))) {
      const rest = code.slice(bibitemRe.lastIndex, bibitemRe.lastIndex + 1200);
      const stop = rest.search(/\\bibitem|\\end\s*\{thebibliography\}|\n\s*\n/);
      const parts = (stop < 0 ? rest : rest.slice(0, stop)).split(/\\newblock/).map(cleanText);
      const year = ((parts.join(" ").match(/\b(1[89]|20)\d\d\b/g) || []).pop()) || "";
      ix.cites.push({ key: m[1].trim(), type: "bibitem", file, line: lineAt(code, m.index),
                      author: (parts[0] || "").replace(/\.$/, "").replace(/, and /g, " and ").replace(/, /g, " and "),
                      title: (parts[1] || "").replace(/\.$/, "").slice(0, 100), year });
    }
    // command usage frequency (ranking signal)
    const useRe = /\\([a-zA-Z]+)/g;
    while ((m = useRe.exec(code))) ix.freq.set(m[1], (ix.freq.get(m[1]) || 0) + 1);
    // labels, with what they label: innermost environment, else the last heading
    const tokRe = /\\begin\s*\{([^}]+)\}|\\end\s*\{([^}]+)\}|\\label\s*\{([^}]+)\}|\\(?:sub)*caption\s*(?:\[[^\]]*\])?\s*\{|\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g;
    const stack = [];
    let heading = null, caption = null;
    while ((m = tokRe.exec(code))) {
      if (m[1]) { stack.push({ env: m[1], caption: null }); continue; }
      if (m[2]) {
        const i = stack.map((s) => s.env).lastIndexOf(m[2]);
        if (i >= 0) stack.splice(i);
        caption = null;
        continue;
      }
      if (m[3] === undefined) {  // caption or heading: grab its braced title
        const g = braced(code, tokRe.lastIndex - 1);
        const t = g ? cleanText(g.value.replace(/\\label\s*\{[^}]*\}/g, "")).slice(0, 70) : "";
        if (/caption/.test(m[0])) { if (stack.length) stack[stack.length - 1].caption = t; caption = t; }
        else heading = { kind: m[0].match(/\\([a-z]+)/)[1], title: t, at: m.index };
        continue;
      }
      const key = m[3].trim();
      const top = stack[stack.length - 1];
      let kind = "label", title = "";
      if (top && !/^(document|abstract|center|minipage|itemize|enumerate|description)$/.test(top.env)) {
        const env = top.env.replace(/\*$/, "");
        kind = /^(figure|subfigure|wrapfigure)$/.test(env) ? "figure" : /^(table|subtable|wraptable)$/.test(env) ? "table"
          : MATH_ENVS.test(top.env) ? "equation" : env;
        title = top.caption || (kind === "equation" ? "" : (stack.find((s) => s.caption) || {}).caption || "");
      } else if (top && /^(itemize|enumerate|description)$/.test(top.env)) {
        kind = "item";
      } else if (heading && m.index - heading.at < 300) {
        kind = heading.kind; title = heading.title;
      }
      ix.labels.push({ key, kind, title, file, line: lineAt(code, m.index) });
    }
  }

  function buildIndex(files) {
    const ix = {
      labels: [], cites: [], macros: new Map(), envs: new Map(), packages: new Set(),
      freq: new Map(), files: Object.keys(files || {}).sort(),
    };
    for (const [path, text] of Object.entries(files || {})) {
      if (typeof text !== "string") continue;
      if (/\.bib$/i.test(path)) ix.cites.push(...parseBib(text, path));
      else if (/\.(tex|sty|cls|ltx|bbl)$/i.test(path)) indexTex(text, path, ix);
    }
    return ix;
  }

  // Known keys for diagnostics: labels, and citation keys when the project has
  // any bibliography source (else ``cites`` is null: nothing to check against).
  function knownKeys(index) {
    return {
      labels: new Set(index.labels.map((l) => l.key)),
      cites: index.cites.length ? new Set(index.cites.map((c) => c.key)) : null,
    };
  }

  // ── Context ───────────────────────────────────────────────────────────────
  // Is `caret` inside math? Scans back to the paragraph start (math cannot
  // cross a blank line), tracking $, $$, \( \), \[ \] and math environments.
  function inMath(text, caret) {
    let start = Math.max(0, caret - 4000);
    const para = text.lastIndexOf("\n\n", caret - 1);
    if (para > start) start = para;
    const seg = stripComments(text.slice(start, caret));
    let math = null;
    const envs = [];
    const re = /\\begin\s*\{([^}]+)\}|\\end\s*\{([^}]+)\}|\\\\|\\[$()[\]]|\$\$|\$/g;
    let m;
    while ((m = re.exec(seg))) {
      const t = m[0];
      if (m[1]) { if (MATH_ENVS.test(m[1])) envs.push(m[1]); continue; }
      if (m[2]) { const i = envs.lastIndexOf(m[2]); if (i >= 0) envs.splice(i); continue; }
      if (t === "\\\\" || t === "\\$") continue;
      if (t === "\\(" || t === "\\[") { if (!math) math = t; continue; }
      if (t === "\\)" || t === "\\]") { if (math === (t === "\\)" ? "\\(" : "\\[")) math = null; continue; }
      if (t === "$$") { math = math === "$$" ? null : (math || "$$"); continue; }
      if (t === "$") { math = math === "$" ? null : (math || "$"); continue; }
    }
    if (math) return true;
    if (envs.length) return true;
    // a math environment opened before the paragraph start (blank lines are
    // not allowed inside display math, so this is rare)
    return false;
  }

  // The innermost environment open at `caret` (for \end{ completion).
  function openEnv(text, caret) {
    const code = stripComments(text.slice(0, caret));
    const re = /\\(begin|end)\s*\{([^}]+)\}/g;
    const stack = [];
    let m;
    while ((m = re.exec(code))) {
      if (m[1] === "begin") stack.push(m[2]);
      else { const i = stack.lastIndexOf(m[2]); if (i >= 0) stack.splice(i); }
    }
    return stack[stack.length - 1] || null;
  }

  function inComment(text, idx) {
    const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
    return /(^|[^\\])%/.test(text.slice(lineStart, idx));
  }

  // Whether a just-typed \begin{name} (ending before `caret`) still lacks its \end.
  function needsEnd(text, caret, name) {
    const re = /\\(begin|end)\s*\{([^}]+)\}/g;
    re.lastIndex = caret;
    let depth = 1, m;
    while ((m = re.exec(text))) {
      if (m[2] !== name || inComment(text, m.index)) continue;
      depth += m[1] === "begin" ? 1 : -1;
      if (depth === 0) return false;
    }
    return true;
  }

  // What is being completed at `caret`? → {kind, query, from} | null
  function context(text, caret) {
    const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
    const before = text.slice(Math.max(lineStart, caret - 400), caret);
    if (/(^|[^\\])%/.test(before)) return null;  // inside a comment
    let m;
    const arg = (kind, q) => ({ kind, query: q, from: caret - q.length });
    const listArg = (kind, raw) => { const q = raw.split(",").pop().replace(/^\s+/, ""); return arg(kind, q); };
    if ((m = /\\(begin|end)\s*\{([A-Za-z@*]*)$/.exec(before))) return { ...arg(m[1] === "end" ? "end" : "env", m[2]) };
    if ((m = /\\(?:[a-zA-Z]*ref|[cC]ref|labelcref|autoref)\*?\s*\{([^{}]*)$/.exec(before))) return listArg("label", m[1]);
    if ((m = /\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)$/.exec(before))) return listArg("cite", m[1]);
    if ((m = /\\(?:input|include|subfile|(?:sub)?import\s*\{[^}]*\})\s*\{([^{}]*)$/.exec(before))) return arg("file-tex", m[1]);
    if ((m = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]*)$/.exec(before))) return arg("file-img", m[1]);
    if ((m = /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)$/.exec(before))) return listArg("file-bib", m[1]);
    if ((m = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^{}]*)$/.exec(before))) return listArg("package", m[1]);
    if ((m = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]*)$/.exec(before))) return arg("class", m[1]);
    if ((m = /(\\+)([a-zA-Z@]*)$/.exec(before))) {
      if (m[1].length % 2 === 0) return null;  // "\\" is a line break, not a command
      return { kind: "cmd", query: m[2], from: caret - m[2].length - 1 };
    }
    return null;
  }

  // ── Ranking ───────────────────────────────────────────────────────────────
  // Higher is better; -1 = no match. Prefix > word start > substring > fuzzy.
  function score(query, name) {
    if (!query) return 100;
    if (name === query) return 1000;
    if (name.startsWith(query)) return 800 - Math.min(50, name.length - query.length);
    const lq = query.toLowerCase(), ln = name.toLowerCase();
    if (ln.startsWith(lq)) return 700 - Math.min(50, name.length - query.length);
    const parts = ln.split(/[^a-z0-9]+/);
    if (parts.some((p) => p.startsWith(lq))) return 500;
    if (ln.includes(lq)) return 400;
    let j = 0, gaps = 0, last = -1;
    for (let i = 0; i < ln.length && j < lq.length; i++) {
      if (ln[i] === lq[j]) { if (last >= 0) gaps += i - last - 1; last = i; j++; }
    }
    return j === lq.length ? Math.max(1, 250 - gaps * 10) : -1;
  }

  // Path of `target` relative to the directory of `from` (posix).
  function relPath(from, target) {
    const a = from.split("/").slice(0, -1), b = target.split("/");
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return "../".repeat(a.length - i) + b.slice(i).join("/");
  }

  function snippetLabel(n) {
    return Array.from({ length: n }, (_, i) => `{\${${i + 1}:#${i + 1}}}`).join("");
  }

  function candidates(ctx, index, opts) {
    const o = opts || {};
    const items = [];
    const push = (it) => { const s = score(ctx.query, it.match || it.label); if (s >= 0) items.push({ ...it, raw: s, score: s + (it.boost || 0) }); };
    if (ctx.kind === "cmd") {
      const math = !!o.math;
      const seen = new Set();
      for (const [name, args, desc, where, pkg] of C) {
        if (seen.has(name)) continue;
        seen.add(name);
        let boost = Math.min(120, (index.freq.get(name.replace(/[^a-zA-Z].*$/, "")) || 0) * 6);
        if (where === "m") boost += math ? 150 : -250;
        else if (where === "t") boost += math ? -250 : 0;
        if (pkg && !index.packages.has(pkg) && !/^(amsmath|amssymb|amsthm)$/.test(pkg)) boost -= 60;
        push({ kind: "cmd", label: "\\" + name, match: name, insert: "\\" + name + args, detail: desc, source: pkg || "", boost });
      }
      for (const mac of index.macros.values()) {
        if (seen.has(mac.name) || mac.name.includes("@")) continue;  // @-names are internals
        seen.add(mac.name);
        const fromPkg = /\.(sty|cls)$/i.test(mac.file);
        const what = fromPkg ? "package macro" : "project macro";
        push({ kind: "macro", label: "\\" + mac.name, match: mac.name, insert: "\\" + mac.name + snippetLabel(mac.args),
               detail: mac.args ? `${what}, ${mac.args} arg${mac.args > 1 ? "s" : ""}` : what,
               source: `${mac.file}:${mac.line}`,
               boost: (fromPkg ? -40 : 60) + Math.min(120, (index.freq.get(mac.name) || 0) * 6) });
      }
      // commands used in the project but in neither list (e.g. from a .sty)
      for (const [name, n] of index.freq) {
        if (seen.has(name) || n < 2 || name.length < 3) continue;
        push({ kind: "cmd", label: "\\" + name, match: name, insert: "\\" + name, detail: `used ${n}×`, source: "", boost: Math.min(80, n * 4) - 40 });
      }
    } else if (ctx.kind === "env" || ctx.kind === "end") {
      const seen = new Set();
      const open = ctx.kind === "end" ? o.openEnv : null;
      const all = E.map(([name, body, desc, pkg]) => ({ name, body, desc, pkg }))
        .concat([...index.envs.values()].map((e) => ({ name: e.name, body: "\t${1}", desc: e.desc, pkg: "", project: true, args: e.args })));
      for (const e of all) {
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        const boost = (e.name === open ? 3000 : 0) + (e.project ? 60 : 0);
        if (ctx.kind === "end") {
          push({ kind: "env", label: e.name, insert: e.name + "}", detail: e.name === open ? "close the open environment" : e.desc, source: e.pkg || "", boost });
        } else {
          // options/arguments stay on the \begin line; the body goes below it
          const head = (/^(\[[^\n]*\]|\{[^\n]*\})/.exec(e.body) || [""])[0];
          const rest = e.body.slice(head.length);
          const insert = `${e.name}}${e.args ? snippetLabel(e.args) : ""}${head}` +
            `${rest.startsWith("\n") ? rest : "\n" + rest}\n\\end{${e.name}}`;
          push({ kind: "env", label: e.name, insert, detail: e.desc, source: e.pkg || (e.project ? "project" : ""), boost, block: true });
        }
      }
    } else if (ctx.kind === "label") {
      for (const l of index.labels) {
        push({ kind: "label", label: l.key, insert: l.key, detail: [l.kind, l.title].filter(Boolean).join(" · "),
               source: `${l.file}:${l.line}`, match: l.key });
      }
    } else if (ctx.kind === "cite") {
      for (const c of index.cites) {
        const who = (c.author || "").split(/ and /i)[0].split(",")[0].trim();
        push({ kind: "cite", label: c.key, insert: c.key, match: c.key + " " + (c.title || "") + " " + who,
               detail: [who + (c.author && / and /i.test(c.author) ? " et al." : ""), c.year, c.title].filter(Boolean).join(" · "),
               source: c.file });
      }
    } else if (ctx.kind.startsWith("file-")) {
      const want = { "file-tex": /\.tex$/i, "file-img": /\.(png|jpe?g|gif|pdf|eps|svg|bmp|webp)$/i, "file-bib": /\.bib$/i }[ctx.kind];
      for (const f of index.files) {
        if (!want.test(f) || f === o.file) continue;
        let ins = ctx.kind === "file-img" ? f : relPath(o.file || "", f);  // engine: \input is relative to the including file
        if (ctx.kind !== "file-img") ins = ins.replace(/\.(tex|bib)$/i, "");
        push({ kind: "file", label: ins, insert: ins, match: ins, detail: f, source: "" });
      }
    } else if (ctx.kind === "package") {
      for (const p of PACKAGES) push({ kind: "pkg", label: p.name, insert: p.name, detail: p.desc, source: index.packages.has(p.name) ? "loaded" : "", boost: index.packages.has(p.name) ? -30 : 0 });
    } else if (ctx.kind === "class") {
      for (const c of CLASSES) push({ kind: "class", label: c, insert: c, detail: "document class", source: "" });
    }
    // enough good matches → drop the loose fuzzy ones
    if (items.filter((it) => it.raw >= 400).length >= 5) {
      for (let i = items.length - 1; i >= 0; i--) if (items[i].raw < 300) items.splice(i, 1);
    }
    const mru = o.mru || {};
    for (const it of items) it.score += Math.min(150, (mru[it.kind + ":" + it.label] || 0) * 30);
    items.sort((a, b) => b.score - a.score || a.label.length - b.label.length || (a.label < b.label ? -1 : 1));
    return items.slice(0, o.limit || 60);
  }

  // Everything the editor needs for one completion request.
  function complete(text, caret, index, opts) {
    const ctx = context(text, caret);
    if (!ctx) return null;
    const o = { ...(opts || {}) };
    if (ctx.kind === "cmd") o.math = inMath(text, caret);
    if (ctx.kind === "end") o.openEnv = openEnv(text, ctx.from - "\\end{".length);
    const items = candidates(ctx, index, o);
    // replace the whole token under the caret, plus a closing brace already there
    const after = text.slice(caret);
    let to = caret + (ctx.kind === "cmd" ? (/^[a-zA-Z@]*/.exec(after)[0].length) : (/^[^\s},]*/.exec(after)[0].length));
    if ((ctx.kind === "env" || ctx.kind === "end") && text[to] === "}") to += 1;
    // argument completions close their brace unless it (or a list comma) is there
    const close = ctx.kind !== "cmd" && ctx.kind !== "env" && ctx.kind !== "end" &&
      text[to] !== "}" && text[to] !== "," ? "}" : "";
    return { kind: ctx.kind, query: ctx.query, from: ctx.from, to, items, math: !!o.math, close };
  }

  // "${1:x}" / "${1}" / "$0" tabstops → {text, stops: [{start, end}], final}
  function expandSnippet(snippet) {
    let text = "";
    const stops = {};
    let i = 0;
    while (i < snippet.length) {
      const m = /^\$\{(\d+)(?::([^}]*))?\}|^\$(\d+)/.exec(snippet.slice(i));
      if (m) {
        const n = +(m[1] || m[3]);
        const ph = m[2] || "";
        if (!(n in stops)) stops[n] = { start: text.length, end: text.length + ph.length };
        text += ph;
        i += m[0].length;
      } else {
        text += snippet[i++];
      }
    }
    const order = Object.keys(stops).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    const final = 0 in stops ? stops[0].start : text.length;
    return { text, stops: order.map((n) => stops[n]), final };
  }

  // Re-indent a multi-line snippet to the line it is inserted on.
  function indentSnippet(text, indent) {
    return text.replace(/\n/g, "\n" + indent);
  }

  return {
    buildIndex, knownKeys, context, complete, candidates, expandSnippet, indentSnippet,
    inMath, openEnv, needsEnd, inComment, score, parseBib, relPath,
    CATALOG: C, ENVIRONMENTS: E, PACKAGES,
  };
});
