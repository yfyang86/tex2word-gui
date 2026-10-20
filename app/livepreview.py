"""Live preview engine: full and incremental ("quick") renders of a project.

**Full** re-parses the whole (instrumented) project with tex2word and renders
every block. **Quick** reuses the previous parse: the body is cut into chunks
at top-level blank lines (see ``sourcemap``); only chunks whose text changed
are re-parsed — together, in one small synthetic document made of the cached
preamble plus those chunks — and their blocks are spliced into the cached IR.
Cross-references, labels and numbering are then recomputed over the whole
spliced document, so numbers and ``\\ref`` links stay globally correct.

Quick falls back to full (and says why) whenever a local re-parse could differ
from a full one: the preamble or include structure changed, an edit touches a
global construct (macro/counter/theorem definitions, ``\\appendix``,
bibliography, title/abstract, acronyms, conditionals, …), the citation order
changed, too much changed at once, or the chunk boundaries could not be
recovered from the parse. The client additionally reconciles with a full
render once typing settles, so drift can never persist.

Both modes return ``segments`` — ``[[key, html]]`` per top-level element —
and omit the html (``null``) of segments the client already holds (it echoes
the ``rev`` it last applied as ``base_rev``), so the browser only swaps the
blocks that actually changed.
"""

from __future__ import annotations

import dataclasses
import difflib
import hashlib
import os
import re
import tempfile
import threading
import time
from collections import OrderedDict
from typing import Any, Callable

from tex2word import ir
from tex2word.frontend import parse_document
from tex2word.report import ConversionReport
from tex2word.transforms import resolve_crossrefs

from . import preview as _preview
from . import sourcemap as sm

try:  # the engine's own citation walk: which Cite nodes it formats, in order
    from tex2word.bib.render import _walk_cites
except Exception:  # pragma: no cover - engine internals moved
    _walk_cites = None

# Edits containing any of these can change more than their own chunk.
_GLOBAL_RE = re.compile(
    r"\\(?:(?:re)?newcommand(?!\*?\s*\{?\\(?:arraystretch|baselinestretch)\b)|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let"
    r"|(?:re)?newenvironment|newtheorem|theoremstyle|DeclareMathOperator|definecolor"
    r"|colorlet|newacronym|newglossaryentry|newcounter|setcounter|addtocounter"
    r"|stepcounter|refstepcounter|numberwithin|counterwithin|appendix|bibliography"
    r"|printbibliography|bibliographystyle|addbibresource|nocite|maketitle|title|author|date"
    r"|twocolumn|onecolumn|tableofcontents|listoffigures|listoftables|makeatletter"
    r"|makeatother|usepackage|documentclass|if(?!f(?![A-Za-z@]))[A-Za-z]*|fi|else"
    r"|ac|acp|acs|acl|acf|acsp|aclp|acfp|Ac|Acp|Acl|Acf|Acs|iac|Iac|acro|acrshort"
    r"|acrlong|acrfull|gls|Gls|GLS|glspl|Glspl|GLSpl|glstext|glsfirst|glsdesc"
    r"|glssymbol|glsentry[A-Za-z]*)(?![A-Za-z@])"
    r"|\\begin\s*\{(?:abstract|thebibliography|multicols\*?|document)\}"
    r"|\[[^\]\n]*\bresume\b"  # enumitem list numbering continued across lists
)
# Body-level definitions other chunks may depend on: such chunks are re-parsed
# alongside any changed chunk (as context; their own blocks are discarded).
_DEF_RE = re.compile(
    r"\\(?:(?:re)?newcommand(?!\*?\s*\{?\\(?:arraystretch|baselinestretch)\b)|providecommand|DeclareRobustCommand|def|gdef|edef|xdef|let"
    r"|(?:re)?newenvironment|newtheorem|theoremstyle|DeclareMathOperator|definecolor"
    r"|colorlet|newacronym|newglossaryentry|newtcolorbox|newmdenv|newcounter)(?![A-Za-z@])"
)
_LABEL_RE = re.compile(r"\\label\s*\{([^}]*)\}")
_BIBRES_RE = re.compile(r"\\(?:addbibresource|bibliography)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}")
_APPENDIX_RE = re.compile(r"\\appendix(?![A-Za-z@])")

MAX_SESSIONS = 8


class PreviewError(Exception):
    """The project could not be rendered."""


def _hash(text: str) -> str:
    return hashlib.blake2b(text.encode("utf-8"), digest_size=12).hexdigest()


def _engine_cites(blocks: list[Any]) -> list[ir.Cite]:
    """The Cite nodes tex2word's citation pass formats, in its walk order."""
    out: list[ir.Cite] = []
    if _walk_cites is not None:
        _walk_cites(blocks, out)
    return out


def _cite_order(cites: list[ir.Cite]) -> list[str]:
    seen: dict[str, None] = {}
    for c in cites:
        for k in c.keys:
            seen.setdefault(k, None)
    return list(seen)


def _walk(obj: Any):
    if isinstance(obj, list):
        for x in obj:
            yield from _walk(x)
    elif isinstance(obj, ir.Node):
        yield obj
        if dataclasses.is_dataclass(obj):
            for f in dataclasses.fields(obj):
                v = getattr(obj, f.name)
                if isinstance(v, (list, ir.Node)):
                    yield from _walk(v)


def _ir_labels(blocks: list[Any]) -> set[str]:
    out: set[str] = set()
    for n in _walk(blocks):
        lab = getattr(n, "label", None)
        if isinstance(lab, str) and lab:
            out.add(lab)
        for lab in getattr(n, "line_labels", None) or []:
            if lab:
                out.add(lab)
    return out


def _text_labels(text: str) -> set[str]:
    return {m.group(1).strip() for m in _LABEL_RE.finditer(text)}


def _entangled(text: str, blocks: list[Any]) -> bool:
    """Whether the chunk's labels ended up anywhere but in its own blocks —
    the parse of this chunk then depends on its neighbours."""
    return _text_labels(text) != _ir_labels(blocks)


_LABELABLE = (ir.Heading, ir.MathBlock, ir.Theorem, ir.Algorithm, ir.ListItem,
              ir.Figure, ir.Table)


def _label_spans(chunks: list["_ChunkState"]) -> list[tuple["_ChunkState", "_ChunkState"]]:
    """Chunk ranges tied together by a label the engine attached outside its
    own chunk. tex2word gives a ``\\label`` to the most recent labelable block
    anywhere before it (a caption's label can land on an earlier heading), so a
    label missing from its own chunk depends on everything back to the block
    that received it — or, if it vanished, back to the nearest earlier
    labelable block. Any edit inside such a range needs a full parse."""
    text = [_text_labels(c.text) for c in chunks]
    irl = [_ir_labels(c.blocks) for c in chunks]
    has_slot = [any(isinstance(n, _LABELABLE) for n in _walk(c.blocks)) for c in chunks]
    spans = []
    for g in range(len(chunks)):
        for lab in text[g] - irl[g]:
            recv = [r for r in range(len(chunks)) if lab in irl[r] and lab not in text[r]]
            if recv:
                lo, hi = min(recv + [g]), max(recv + [g])
            else:
                lo = next((r for r in range(g, -1, -1) if has_slot[r]), 0)
                hi = g
            spans.append((chunks[lo], chunks[hi]))
    return spans


def _cite_key(c: ir.Cite) -> tuple:
    return (tuple(c.keys), c.mode, sm.strip_markers(c.prefix or ""), sm.strip_markers(c.suffix or ""))


def _block_serial(b: Any) -> int | None:
    if isinstance(b, ir.Paragraph) and b.inlines and all(isinstance(n, ir.Text) for n in b.inlines):
        return sm.separator_serial("".join(n.value for n in b.inlines))
    return None


def _split(blocks: list[Any], serials: list[int]) -> list[list[Any]] | None:
    """Cut top-level blocks at separator paragraphs; ``None`` if the separators
    did not survive as expected (then the chunk ↔ block mapping is unknown)."""
    out: list[list[Any]] = []
    seen: list[int] = []
    for b in blocks:
        s = _block_serial(b)
        if s is not None:
            seen.append(s)
            out.append([])
        elif not out:
            return None
        else:
            out[-1].append(b)
    return out if seen == serials else None


@dataclasses.dataclass
class _ChunkState:
    hash: str
    text: str
    serial: int
    blocks: list[Any]
    origins: list[tuple[int, int]]
    entangled: bool = False


@dataclasses.dataclass
class _Session:
    prefix: str = ""
    suffix: str = ""
    chunks: list[_ChunkState] = dataclasses.field(default_factory=list)
    meta: Any = None
    book: bool = False
    report: Any = None
    cite_map: dict = dataclasses.field(default_factory=dict)
    cite_order: list = dataclasses.field(default_factory=list)
    tail: list = dataclasses.field(default_factory=list)  # blocks the engine appended (bibliography)
    spans: list = dataclasses.field(default_factory=list)  # label-entangled chunk ranges
    quick_ok: bool = False
    instrumented: bool = False
    files: list[str] = dataclasses.field(default_factory=list)
    includes: list = dataclasses.field(default_factory=list)
    title_origin: tuple[int, int] | None = None
    next_serial: int = 1
    rev: int = 0
    last_keys: set = dataclasses.field(default_factory=set)
    lock: threading.Lock = dataclasses.field(default_factory=threading.Lock)


class PreviewEngine:
    def __init__(self, max_sessions: int = MAX_SESSIONS) -> None:
        self._sessions: OrderedDict[Any, _Session] = OrderedDict()
        self._lock = threading.Lock()
        self.max_sessions = max_sessions

    # -- sessions -------------------------------------------------------------
    def _session(self, key: Any) -> _Session:
        with self._lock:
            s = self._sessions.get(key)
            if s is None:
                s = self._sessions[key] = _Session()
            self._sessions.move_to_end(key)
            while len(self._sessions) > self.max_sessions:
                self._sessions.popitem(last=False)
            return s

    def forget(self, predicate: Callable[[Any], bool]) -> None:
        with self._lock:
            for k in [k for k in self._sessions if predicate(k)]:
                del self._sessions[k]

    # -- parsing ----------------------------------------------------------------
    @staticmethod
    def _parse(source: str, files: dict[str, str], csl: str | None) -> tuple[Any, Any, float]:
        t0 = time.perf_counter()
        with tempfile.TemporaryDirectory() as base:
            abs_base = os.path.abspath(base)
            for path, content in files.items():
                dest = os.path.abspath(os.path.join(abs_base, path))
                if not dest.startswith(abs_base + os.sep):
                    raise PreviewError(f"illegal file path: {path!r}")
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "w", encoding="utf-8") as fh:
                    fh.write(content)
            csl_path = os.path.join(abs_base, csl) if csl else None
            doc, report = parse_document(source, base, csl_path=csl_path)
        resolve_crossrefs(doc, report)
        return doc, report, (time.perf_counter() - t0) * 1000

    def _full(self, s: _Session, inst: sm.Instrumented, files: dict[str, str],
              csl: str | None) -> tuple[ir.Document, float]:
        serials = list(range(s.next_serial, s.next_serial + len(inst.chunks)))
        s.next_serial += len(serials)
        try:
            doc, report, ms = self._parse(inst.assemble(serials), files, csl)
            instrumented = True
        except Exception:
            # markers must never cost a preview: retry exactly as tex2word would
            try:
                doc, report, ms = self._parse(inst.flat.text, files, csl)
            except Exception as exc:
                raise PreviewError(f"conversion failed: {exc}") from exc
            instrumented = False
        parts = _split(doc.blocks, serials) if instrumented else None
        s.tail = []
        if parts and parts[-1] and isinstance(parts[-1][-1], ir.Bibliography) \
                and not re.search(r"\\(?:bibliography|printbibliography)(?![A-Za-z@])|thebibliography",
                                  inst.chunks[-1].text):
            s.tail = [parts[-1].pop()]  # appended by the citation pass, not parsed
        if parts is None:
            blocks = [b for b in doc.blocks if _block_serial(b) is None]
            s.chunks = []
            s.quick_ok = False
        else:
            blocks = [b for part in parts for b in part] + s.tail
            s.chunks = [
                _ChunkState(_hash(c.text), c.text, ser, part, c.origins, _entangled(c.text, part))
                for c, ser, part in zip(inst.chunks, serials, parts)
            ]
            s.quick_ok = True
            s.spans = _label_spans(s.chunks)
        doc.blocks = blocks
        s.instrumented = instrumented
        s.prefix, s.suffix = inst.prefix, inst.suffix
        s.meta, s.book, s.report = doc.meta, doc.book, report
        cites = _engine_cites(doc.blocks)
        s.cite_map = {}
        for c in cites:
            s.cite_map.setdefault(_cite_key(c), c.rendered)
        s.cite_order = _cite_order(cites)
        s.title_origin = inst.title_origin
        if not instrumented:  # fall back to a source map-free session
            s.chunks = []
        return doc, ms

    def _quick(self, s: _Session, inst: sm.Instrumented, files: dict[str, str],
               csl: str | None) -> tuple[ir.Document | None, float, str | None, int]:
        """Incremental re-parse. Returns (doc, parse_ms, reason_for_full, reparsed)."""
        if not s.quick_ok or not s.chunks:
            return None, 0, "no reusable parse yet", 0
        if inst.prefix != s.prefix:
            return None, 0, "the preamble changed", 0
        if inst.suffix != s.suffix:
            return None, 0, "the document end changed", 0
        new_hashes = [_hash(c.text) for c in inst.chunks]
        old_hashes = [c.hash for c in s.chunks]
        ops = difflib.SequenceMatcher(None, old_hashes, new_hashes, autojunk=False).get_opcodes()
        changed_new = [j for tag, _, _, j1, j2 in ops if tag != "equal" for j in range(j1, j2)]
        changed_old = [i for tag, i1, i2, _, _ in ops if tag != "equal" for i in range(i1, i2)]
        texts = [s.chunks[i].text for i in changed_old] + [inst.chunks[j].text for j in changed_new]
        hit = next((m for t in texts for m in [_GLOBAL_RE.search(t)] if m), None)
        if hit:
            return None, 0, f"the edit touches {hit.group(0).strip()}", 0
        if any(s.chunks[i].entangled for i in changed_old):
            return None, 0, "the edited block shares labels with its neighbours", 0
        pos = {id(c): i for i, c in enumerate(s.chunks)}
        for a, b in s.spans:
            lo, hi = pos.get(id(a)), pos.get(id(b))
            if lo is None or hi is None:
                return None, 0, "the edit moves a shared label", 0
            for tag, i1, i2, _, _ in ops:
                if tag == "equal":
                    continue
                if (i1 == i2 and lo < i1 <= hi) or (i1 < i2 and i1 <= hi and i2 > lo):
                    return None, 0, "the edit sits between a label and its target", 0
        limit = max(12, len(inst.chunks) // 4)
        if len(changed_new) > limit:
            return None, 0, f"{len(changed_new)} chunks changed at once", 0

        parsed: dict[int, list[Any]] = {}
        ms = 0.0
        if changed_new:
            changed_set = set(changed_new)
            first = min(changed_set)
            # chunks whose definitions (or \appendix switch) the changed ones see
            context = [j for j, c in enumerate(inst.chunks)
                       if j not in changed_set and (_DEF_RE.search(c.text)
                                                    or (j < first and _APPENDIX_RE.search(c.text)))]
            order = sorted(changed_set | set(context))
            serials = list(range(s.next_serial, s.next_serial + len(order)))
            s.next_serial += len(serials)
            src = (_BIBRES_RE.sub("", inst.prefix)
                   + "".join(sm.separator(ser) + inst.chunks[j].marked(ser)
                             for j, ser in zip(order, serials))
                   + "\n\\end{document}\n")
            try:
                part_doc, _, ms = self._parse(src, files, csl)
            except Exception as exc:
                return None, 0, f"partial parse failed ({exc})", 0
            split = _split(part_doc.blocks, serials)
            if split is None:
                return None, ms, "chunk boundaries were not recovered", 0
            if part_doc.meta.abstract:
                return None, ms, "the abstract changed", 0
            by_index = dict(zip(order, zip(serials, split)))
            serials = [by_index[j][0] for j in changed_new]
            parts = [by_index[j][1] for j in changed_new]
            for j, blocks in zip(changed_new, parts):
                if _entangled(inst.chunks[j].text, blocks):
                    return None, ms, "the edited block's labels depend on its neighbours", 0
            for j, ser, blocks in zip(changed_new, serials, parts):
                for c in _walk(blocks):
                    if isinstance(c, ir.Cite):
                        c.rendered = None  # as the engine leaves cites it never formats
                for c in _engine_cites(blocks):
                    key = _cite_key(c)
                    if key not in s.cite_map:
                        return None, ms, "a new citation appeared", 0
                    c.rendered = s.cite_map[key]
                parsed[j] = blocks
            new_serials = dict(zip(changed_new, serials))
        else:
            new_serials = {}

        # splice: equal chunks keep their (serial, blocks); changed ones are new
        old_for_new: dict[int, _ChunkState] = {}
        for tag, i1, i2, j1, j2 in ops:
            if tag == "equal":
                for i, j in zip(range(i1, i2), range(j1, j2)):
                    old_for_new[j] = s.chunks[i]
        chunks: list[_ChunkState] = []
        for j, c in enumerate(inst.chunks):
            if j in parsed:
                chunks.append(_ChunkState(new_hashes[j], c.text, new_serials[j], parsed[j], c.origins))
            else:
                old = old_for_new[j]
                old.origins = c.origins  # same text, possibly moved lines
                chunks.append(old)
        blocks = [b for c in chunks for b in c.blocks]
        if _cite_order(_engine_cites(blocks)) != s.cite_order:
            return None, ms, "the citation order changed", 0
        s.chunks = chunks
        s.title_origin = inst.title_origin
        doc = ir.Document(blocks=blocks + s.tail, meta=s.meta, book=s.book)
        resolve_crossrefs(doc, ConversionReport())
        return doc, ms, None, len(changed_new)

    # -- public -----------------------------------------------------------------
    def render(
        self, key: Any, files: dict[str, str], main: str, *, number_by_section: bool = False,
        csl: str | None = None, mode: str = "full", base_rev: int | None = None,
        asset_url: Any = None, fig_html: Any = None,
    ) -> dict[str, Any]:
        if main not in files:
            raise PreviewError(f"main file {main!r} is not in the project")
        if not (files[main] or "").strip():
            raise PreviewError(f"main file {main!r} is empty")
        t0 = time.perf_counter()
        s = self._session(key)
        with s.lock:
            inst = sm.build(files, main)
            text_files = {p: c for p, c in files.items()}
            reason, reparsed, actual = None, len(inst.chunks), "full"
            doc = None
            ms = 0.0
            if mode == "quick":
                doc, ms, reason, reparsed = self._quick(s, inst, text_files, csl)
                if doc is not None:
                    actual = "quick"
            if doc is None:
                doc, full_ms = self._full(s, inst, text_files, csl)
                ms += full_ms
                reparsed = len(inst.chunks)
            s.files, s.includes = inst.flat.files, inst.flat.includes

            t1 = time.perf_counter()
            origins = {c.serial: c.origins for c in s.chunks}

            def src(serial: int, k: int) -> str | None:
                o = origins.get(serial)
                if o is None or k >= len(o):
                    return None
                return f"{o[k][0]}:{o[k][1]}"

            title_src = (f"{s.title_origin[0]}:{s.title_origin[1]}"
                         if s.title_origin and s.instrumented else None)
            data = _preview.render_document(
                doc, number_by_section=number_by_section, asset_url=asset_url,
                fig_html=fig_html, src=src if s.instrumented else None, title_src=title_src,
            )
            render_ms = (time.perf_counter() - t1) * 1000

            known = s.last_keys if base_rev is not None and base_rev == s.rev else set()
            s.rev += 1
            s.last_keys = {k for k, _ in data["segments"]}
            data["segments"] = [[k, None if k in known else h] for k, h in data["segments"]]
            if known:
                data["html"] = None
            data.update({
                "rev": s.rev,
                "mode": actual,
                "reason": reason,
                "main_path": main,
                "report": s.report,
                "source_map": {
                    "files": list(s.files),
                    "includes": [list(e) for e in s.includes],
                } if s.instrumented else None,
                "timings": {
                    "parse_ms": round(ms, 1), "render_ms": round(render_ms, 1),
                    "total_ms": round((time.perf_counter() - t0) * 1000, 1),
                },
                "chunks": {"total": len(inst.chunks), "reparsed": reparsed},
            })
            return data
