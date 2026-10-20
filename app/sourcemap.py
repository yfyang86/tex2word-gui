"""Source map for the preview: which project file + line produced each block.

tex2word flattens ``\\input``/``\\include`` textually and its IR carries no
source positions, so the web layer builds its own map:

1. **Flatten with origins.** :func:`flatten` reproduces tex2word's own
   ``flatten_inputs(strip_comments(root))`` *exactly* (same regexes, same
   resolution rules), but also records, for every character of the flattened
   text, the project file and line it came from.

2. **Instrument.** :func:`instrument` walks the document body and inserts
   invisible markers — short runs of Unicode private-use characters — at safe
   places: the start of text lines, inside heading/caption braces, after
   ``\\item`` and before top-level environments. The parser keeps them as plain
   text, so they surface in the IR next to the content they precede; the HTML
   renderer turns each one into an empty ``<span data-src="file:line">``.

3. **Chunk.** The body is split at top-level blank lines into *chunks* (runs of
   paragraphs outside any environment/group/math). A separator paragraph is
   placed between chunks so the parsed top-level blocks can be split back per
   chunk — the basis of the incremental "quick" preview (``livepreview.py``).

Markers are only ever inserted outside math, verbatim, TikZ, tables and brace
groups, and only into the *preview* parse — the ``.docx`` conversion never sees
them. Marker and separator identities are ``(serial, k)``: the chunk's serial
number and the marker's index inside the chunk, so a chunk's markers keep
their meaning when the chunk is reused unchanged in a later quick render.
"""

from __future__ import annotations

import bisect
import posixpath
import re
from dataclasses import dataclass, field

try:  # mirror the engine's own regexes so flattening is byte-identical
    from tex2word.frontend.preprocess import _COMMENT_RE, _IMPORT_RE, _INPUT_RE
except Exception:  # pragma: no cover - engine internals moved
    _COMMENT_RE = re.compile(r"(?<!\\)%[^\n]*(?:\n[ \t]*)?")
    _INPUT_RE = re.compile(r"\\(?:input|include)\s*\{([^}]+)\}")
    _IMPORT_RE = re.compile(
        r"\\(?:sub)?(?:import|includefrom|inputfrom)\s*\{([^}]+)\}\s*\{([^}]+)\}"
    )

_MAX_DEPTH = 20  # tex2word's include recursion limit

# ── Marker encoding (Unicode private-use area) ──────────────────────────────
M_START, M_END, M_MID, S_START = "\ue000", "\ue001", "\ue002", "\ue003"
_DIGIT0 = 0xE010  # hex digits 0-f → U+E010..U+E01F
PUA_RE = re.compile("[\ue000-\ue01f]")
MARKER_RE = re.compile("\ue000([\ue010-\ue01f]+)\ue002([\ue010-\ue01f]+)\ue001")
SEPARATOR_RE = re.compile("^\\s*\ue003([\ue010-\ue01f]+)\ue001\\s*$")


def _enc(n: int) -> str:
    return "".join(chr(_DIGIT0 + int(d, 16)) for d in format(n, "x"))


def _dec(s: str) -> int:
    return int("".join(format(ord(c) - _DIGIT0, "x") for c in s), 16)


def marker(serial: int, k: int) -> str:
    return M_START + _enc(serial) + M_MID + _enc(k) + M_END


def separator(serial: int) -> str:
    return "\n\n" + S_START + _enc(serial) + M_END + "\n\n"


def decode_marker(m: re.Match) -> tuple[int, int]:
    return _dec(m.group(1)), _dec(m.group(2))


def separator_serial(text: str) -> int | None:
    """The serial of a separator paragraph's text, or ``None``."""
    m = SEPARATOR_RE.match(text)
    return _dec(m.group(1)) if m else None


def strip_markers(text: str) -> str:
    return PUA_RE.sub("", text)


# ── Flattening with origins ─────────────────────────────────────────────────
@dataclass
class _FileText:
    path: str
    raw: str
    stripped: str
    seg_s: list[int]   # piece start offsets in the stripped text …
    seg_o: list[int]   # … and the matching offsets in the raw text
    nl: list[int]      # raw newline offsets

    def line_of(self, spos: int) -> int:
        """1-based line in the raw file for a stripped-text offset."""
        i = max(0, bisect.bisect_right(self.seg_s, spos) - 1)
        o = self.seg_o[i] + (spos - self.seg_s[i]) if self.seg_s else spos
        return bisect.bisect_left(self.nl, o) + 1


def _strip_with_map(path: str, raw: str) -> _FileText:
    parts, seg_s, seg_o = [], [], []
    last = pos = 0
    for m in _COMMENT_RE.finditer(raw):
        if m.start() > last:
            seg_s.append(pos); seg_o.append(last)
            parts.append(raw[last:m.start()]); pos += m.start() - last
        last = m.end()
    if last < len(raw) or not seg_s:
        seg_s.append(pos); seg_o.append(last)
        parts.append(raw[last:])
    nl = [i for i, c in enumerate(raw) if c == "\n"]
    return _FileText(path, raw, "".join(parts), seg_s, seg_o, nl)


@dataclass
class Flat:
    """The flattened document plus a char → (file, line) origin map."""

    text: str
    files: list[str]                                   # paths, by first appearance
    pieces: list[tuple[int, int, int]] = field(default_factory=list)  # (flat_start, file_idx, stripped_start)
    includes: list[tuple[int, int, int]] = field(default_factory=list)  # (file_idx, line, target_idx)
    _texts: list[_FileText] = field(default_factory=list)
    _starts: list[int] = field(default_factory=list)

    def origin(self, pos: int) -> tuple[int, int]:
        """``(file_idx, line)`` of a flattened-text offset (1-based line)."""
        if len(self._starts) != len(self.pieces):
            self._starts = [p[0] for p in self.pieces]
        i = max(0, bisect.bisect_right(self._starts, pos) - 1)
        if not self.pieces:
            return 0, 1
        fstart, fi, sstart = self.pieces[i]
        return fi, self._texts[fi].line_of(sstart + (pos - fstart))


def _resolve(files: dict[str, str], base: str, name: str) -> str | None:
    name = name.strip()
    cands = [name] if name.endswith(".tex") else [name, name + ".tex"]
    for cand in cands:
        p = posixpath.normpath(posixpath.join(base, cand)) if base else posixpath.normpath(cand)
        if p in files:
            return p
    return None


def flatten(files: dict[str, str], root: str) -> Flat:
    """Inline ``\\input``/``\\include``/``\\import`` the way tex2word does, with
    comments stripped, keeping an origin for every character."""
    flat = Flat(text="", files=[])
    index: dict[str, int] = {}
    out: list[str] = []
    length = 0

    def file_idx(path: str) -> int:
        if path not in index:
            index[path] = len(flat.files)
            flat.files.append(path)
            flat._texts.append(_strip_with_map(path, files[path]))
        return index[path]

    def emit(fi: int, s: int, e: int) -> None:
        nonlocal length
        if e <= s:
            return
        flat.pieces.append((length, fi, s))
        out.append(flat._texts[fi].stripped[s:e])
        length += e - s

    def walk(path: str, depth: int) -> None:
        fi = file_idx(path)
        ft = flat._texts[fi]
        text = ft.stripped
        if depth > _MAX_DEPTH:
            emit(fi, 0, len(text))
            return
        base = posixpath.dirname(path)
        matches = []
        for m in _IMPORT_RE.finditer(text):
            target = None
            d, n = m.group(1).strip(), m.group(2).strip()
            target = _resolve(files, posixpath.join(base, d) if base else d, n)
            matches.append((m.start(), m.end(), target))
        for m in _INPUT_RE.finditer(text):
            matches.append((m.start(), m.end(), _resolve(files, base, m.group(1))))
        matches.sort()
        pos = 0
        for s, e, target in matches:
            if s < pos:  # overlapping (cannot happen with the engine's regexes)
                continue
            emit(fi, pos, s)
            if target is not None:
                tfi = file_idx(target)
                flat.includes.append((fi, ft.line_of(s), tfi))
                walk(target, depth + 1)
            pos = e
        emit(fi, pos, len(text))

    walk(root, 0)
    flat.text = "".join(out)
    return flat


# ── Instrumentation + chunking ──────────────────────────────────────────────
_MATH_ENVS = {
    "equation", "align", "gather", "multline", "flalign", "alignat", "eqnarray",
    "math", "displaymath", "split", "cases", "array", "matrix", "pmatrix",
    "bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "subequations", "dmath",
}
_VERBATIM_ENVS = {
    "verbatim", "Verbatim", "lstlisting", "minted", "comment", "filecontents",
    "alltt", "BVerbatim", "LVerbatim",
}
_OPAQUE_ENVS = {  # no markers inside (beyond \caption in floats)
    "tikzpicture", "pgfpicture", "tikzcd", "forest", "circuitikz", "tabular",
    "tabularx", "tabulary", "longtable", "supertabular", "tabbing", "algorithmic",
    "algorithm", "algorithm2e", "thebibliography", "figure", "table", "wrapfigure",
    "wraptable", "subfigure", "subtable", "sidewaysfigure", "sidewaystable", "axis",
}
_FLOAT_ENVS = {"figure", "table", "wrapfigure", "wraptable", "subfigure", "subtable",
               "sidewaysfigure", "sidewaystable"}
_NO_CAPTION_ENVS = {"tikzpicture", "pgfpicture", "tabular", "tabularx", "tabulary",
                    "longtable", "algorithmic"}
_LIST_ENVS = {"itemize", "enumerate", "description", "compactitem", "compactenum",
              "inparaenum", "asparaenum", "asparaitem"}

_HEADING_RE = re.compile(
    r"\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)"
    r"\*?\s*(?:\[[^\]\n]*\])?\s*\{"
)
_ITEM_RE = re.compile(r"\\item(?![A-Za-z@])\s*(?:\[[^\]\n]*\])?\s*")
_INLINE_CMD_RE = re.compile(
    r"\\(?:textbf|textit|emph|texttt|textsc|textsf|textrm|textup|textsl|underline|"
    r"noindent|cite[a-zA-Z]*|[cC]ref|ref|eqref|autoref|href|url|mbox|LaTeX|TeX|"
    r"footnote|textcolor|hl|enquote)(?![A-Za-z@])"
)
_CAPTION_RE = re.compile(r"\\(?:sub)?caption(?![A-Za-z@])\*?\s*(?:\[[^\]\n]*\])?\s*\{")
_BEGIN_RE = re.compile(r"\\begin\s*\{([^}]*)\}")
_END_RE = re.compile(r"\\end\s*\{([^}]*)\}")


def _base_env(name: str) -> str:
    return name.strip().rstrip("*")


def _is_text_start(ch: str) -> bool:
    return ch.isalnum() or ch in "(`'\"$" or (ord(ch) > 127 and not 0xE000 <= ord(ch) <= 0xE01F)


@dataclass
class Chunk:
    start: int                         # flat-text offsets [start, end)
    end: int
    text: str                          # raw flattened text (no markers)
    marks: list[int]                   # marker insert positions, relative to start
    origins: list[tuple[int, int]]     # per marker: (file_idx, line)
    origin: tuple[int, int] = (0, 1)   # where the chunk starts

    def marked(self, serial: int) -> str:
        out, last = [], 0
        for k, rel in enumerate(self.marks):
            out.append(self.text[last:rel]); out.append(marker(serial, k)); last = rel
        out.append(self.text[last:])
        return "".join(out)


@dataclass
class Instrumented:
    flat: Flat
    prefix: str            # preamble up to and including \begin{document}
    suffix: str            # \end{document} and beyond
    chunks: list[Chunk]
    title_origin: tuple[int, int] | None = None

    def assemble(self, serials: list[int]) -> str:
        parts = [self.prefix]
        for ch, s in zip(self.chunks, serials):
            parts.append(separator(s)); parts.append(ch.marked(s))
        parts.append(self.suffix)
        return "".join(parts)


class _Scanner:
    """Line-oriented TeX state machine over the (comment-free) body text."""

    def __init__(self) -> None:
        self.depth = 0
        self.math: str | None = None     # "$", "$$", "(", "[" or None
        self.envs: list[str] = []
        self.verb: str | None = None     # active verbatim environment

    def top_level(self) -> bool:
        return not self.depth and self.math is None and not self.envs and self.verb is None

    def text_ok(self) -> bool:
        if self.depth or self.math is not None or self.verb is not None:
            return False
        return not any(e in _MATH_ENVS or e in _OPAQUE_ENVS for e in self.envs)

    def caption_ok(self) -> bool:
        if self.depth or self.math is not None or self.verb is not None:
            return False
        if not any(e in _FLOAT_ENVS for e in self.envs):
            return False
        return not any(e in _MATH_ENVS or e in _NO_CAPTION_ENVS for e in self.envs)

    def scan(self, line: str, captions: list[int] | None = None) -> None:
        i, n = 0, len(line)
        while i < n:
            if self.verb is not None:
                m = re.compile(r"\\end\s*\{" + re.escape(self.verb) + r"\*?\}").search(line, i)
                if not m:
                    return
                self.verb = None
                if self.envs:
                    self.envs.pop()
                i = m.end()
                continue
            c = line[i]
            if c == "\\":
                j = i + 1
                if j < n and (line[j].isalpha() or line[j] == "@"):
                    while j < n and (line[j].isalpha() or line[j] == "@"):
                        j += 1
                    name = line[i + 1:j]
                    if name in ("begin", "end"):
                        m = (_BEGIN_RE if name == "begin" else _END_RE).match(line, i)
                        if m:
                            env = _base_env(m.group(1))
                            if name == "begin":
                                self.envs.append(env)
                                if env in _VERBATIM_ENVS:
                                    self.verb = env
                            elif env in self.envs:
                                while self.envs and self.envs.pop() != env:
                                    pass
                            i = m.end()
                            continue
                    elif name in ("verb", "lstinline") and j < n:
                        k = j
                        if name == "lstinline" and line[k] == "[":
                            k = line.find("]", k) + 1 or n
                        if k < n and line[k] == "*":
                            k += 1
                        if k < n and line[k] not in "{ ":
                            close = line.find(line[k], k + 1)
                            i = (close + 1) if close != -1 else n
                            continue
                    elif name in ("caption", "subcaption") and captions is not None \
                            and self.caption_ok():
                        m = _CAPTION_RE.match(line, i)
                        if m:
                            captions.append(m.end())
                            self.depth += 1
                            i = m.end()
                            continue
                    i = j
                    continue
                if j < n:
                    nxt = line[j]
                    if nxt == "(" and self.math is None:
                        self.math = "("
                    elif nxt == ")" and self.math == "(":
                        self.math = None
                    elif nxt == "[" and self.math is None:
                        self.math = "["
                    elif nxt == "]" and self.math == "[":
                        self.math = None
                i = j + 1
                continue
            if c == "{":
                self.depth += 1
            elif c == "}":
                self.depth = max(0, self.depth - 1)
            elif c == "$":
                if i + 1 < n and line[i + 1] == "$":
                    if self.math is None:
                        self.math = "$$"
                    elif self.math == "$$":
                        self.math = None
                    i += 2
                    continue
                if self.math is None:
                    self.math = "$"
                elif self.math == "$":
                    self.math = None
            i += 1


def _line_mark(line: str, sc: _Scanner) -> int | None:
    """Offset in ``line`` for a line-start marker, judged from the state at the
    start of the line (before it is scanned)."""
    if not sc.text_ok():
        return None
    stripped = line.lstrip()
    if not stripped:
        return None
    off = len(line) - len(stripped)
    ch = stripped[0]
    if ch != "\\":
        return off if _is_text_start(ch) and not stripped.startswith("$$") else None
    m = _HEADING_RE.match(stripped)
    if m:
        return off + m.end()
    innermost = sc.envs[-1] if sc.envs else None
    if stripped.startswith("\\item"):
        m = _ITEM_RE.match(stripped)
        if not m or innermost not in _LIST_ENVS:
            return None
        rest = stripped[m.end():]
        if rest and (_is_text_start(rest[0]) and not rest.startswith("$$")
                     or _INLINE_CMD_RE.match(rest)):
            return off + m.end()
        return None
    if _INLINE_CMD_RE.match(stripped):
        return off
    if (stripped.startswith("\\begin") or stripped.startswith("\\[")) and innermost not in _LIST_ENVS:
        m = _BEGIN_RE.match(stripped)
        if m and _base_env(m.group(1)) == "document":
            return None
        return off
    return None


def instrument(flat: Flat) -> Instrumented:
    text = flat.text
    begin = text.find(r"\begin{document}")
    if begin == -1:
        body_start, prefix = 0, ""
    else:
        body_start = begin + len(r"\begin{document}")
        prefix = text[:body_start]
    end = text.rfind(r"\end{document}")
    body_end = end if end != -1 and end >= body_start else len(text)
    suffix = text[body_end:]

    sc = _Scanner()
    boundaries = [body_start]
    marks: dict[int, int] = {}       # insert position → origin position
    pos = body_start
    prev_end: int | None = None      # end of the previous line, if it was not blank
    body = text[body_start:body_end]
    for line in body.split("\n"):
        if not line.strip():
            if sc.top_level() and pos > boundaries[-1]:
                boundaries.append(pos)
            if sc.math == "$":
                sc.math = None  # an inline $ cannot span a paragraph break
            prev_end = None
        else:
            off = _line_mark(line, sc)
            if off is not None:
                at = pos + off
                if prev_end is not None and line.lstrip().startswith(("\\begin", "\\[")):
                    # the marker would join the paragraph above: put it at that
                    # paragraph's end, so the engine still trims the whitespace
                    marks.setdefault(prev_end, at)
                else:
                    marks.setdefault(at, at)
            captions: list[int] = []
            sc.scan(line, captions)
            for c in captions:
                marks.setdefault(pos + c, pos + c)
            prev_end = pos + len(line.rstrip())
        pos += len(line) + 1
    boundaries.append(body_end)
    order = sorted(marks)

    chunks: list[Chunk] = []
    mi = 0
    for a, b in zip(boundaries, boundaries[1:]):
        if b <= a:
            continue
        rel = []
        while mi < len(order) and order[mi] < b:
            if order[mi] >= a:
                rel.append(order[mi] - a)
            mi += 1
        chunks.append(Chunk(
            start=a, end=b, text=text[a:b], marks=rel,
            origins=[flat.origin(marks[a + r]) for r in rel],
            origin=flat.origin(min(b - 1, a + len(text[a:b]) - len(text[a:b].lstrip()))),
        ))
    inst = Instrumented(flat=flat, prefix=prefix, suffix=suffix, chunks=chunks)
    m = re.search(r"\\title\s*(?:\[[^\]]*\])?\s*\{", prefix)
    if m:
        inst.title_origin = flat.origin(m.start())
    return inst


def build(files: dict[str, str], root: str) -> Instrumented:
    return instrument(flatten(files, root))


def is_root_source(text: str) -> bool:
    """Whether a file can be rendered on its own (has a document class/body)."""
    code = _COMMENT_RE.sub("", text or "")
    return "\\documentclass" in code or "\\begin{document}" in code


def including_root(files: dict[str, str], target: str, prefer: str | None = None) -> str | None:
    """A root file whose include graph reaches ``target`` (``prefer`` first)."""
    roots = [p for p, t in files.items() if p.endswith(".tex") and is_root_source(t)]
    roots.sort(key=lambda p: (p != prefer, p))
    for r in roots:
        try:
            fl = flatten(files, r)
        except RecursionError:  # pragma: no cover
            continue
        if target in fl.files:
            return r
    return None
