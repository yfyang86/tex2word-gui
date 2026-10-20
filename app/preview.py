"""Render the tex2word IR into a browser preview: HTML, outline, statistics.

Architecture: **tex2word is the source of truth.** The renderer walks
``ConversionResult.document`` — the same IR the engine compiles to OOXML — so
labels, citations (already formatted in ``Cite.rendered``), cross-reference
targets, tables, figures and the bibliography all come straight from the engine.

The web layer only supplies what tex2word deliberately *defers to Word*:
the **display numbers** for sections/equations/figures/tables (the IR leaves
``LabelInfo.number`` as ``None`` because Word computes them via fields). We
assign those numbers in a first pass so forward ``\\ref`` links resolve, then
render in a second pass.

Math is the one genuinely non-IR concern: the IR carries LaTeX, and Word gets
OMML, but a *browser* needs presentation MathML. We use ``latex2mathml`` for
that — the very library tex2word itself uses for its OMML math path — so this is
an adapter for display, not a re-implementation of the engine.
"""

from __future__ import annotations

import functools
import hashlib
import re
from html import escape
from typing import Any, Callable

from tex2word import ir

from .sourcemap import MARKER_RE, PUA_RE, decode_marker, strip_markers

try:
    import latex2mathml.converter as _l2m
except Exception:  # pragma: no cover - optional
    _l2m = None


@functools.lru_cache(maxsize=8192)
def _math_html(latex: str, *, block: bool) -> str:
    if _l2m is not None:
        try:
            mml = _l2m.convert(latex)
            if block:
                mml = mml.replace('display="inline"', 'display="block"', 1)
            return mml
        except Exception:
            pass
    cls = "math-fallback block" if block else "math-fallback"
    return f'<span class="{cls}">{escape(latex)}</span>'


def _anchor(label: str | None, labels: dict[str, Any], fallback: str) -> str:
    """Stable HTML id for an element — tex2word's bookmark when it has a label."""
    if label and label in labels and getattr(labels[label], "bookmark", None):
        return re.sub(r"[^A-Za-z0-9_-]", "_", labels[label].bookmark)
    return fallback


class _Numberer:
    """Assigns display numbers the way tex2word would for Word's counters.

    Used identically in both passes (deterministic document-order walk), so a
    ``\\ref`` resolved in pass 1 matches the number rendered in pass 2.
    """

    def __init__(self, by_section: bool) -> None:
        self.by_section = by_section
        self.sec = [0] * 7
        self.counters = {"equation": 0, "figure": 0, "table": 0}
        self.cur_section = 0

    def heading(self, level: int, numbered: bool) -> str:
        if not numbered:
            return ""
        level = max(1, min(6, level))
        self.sec[level - 1] += 1
        for i in range(level, 7):
            self.sec[i] = 0
        if level == 1:
            self.cur_section = self.sec[0]
            if self.by_section:
                for k in self.counters:
                    self.counters[k] = 0
        return ".".join(str(self.sec[i]) for i in range(level))

    def item(self, kind: str) -> str:
        self.counters[kind] += 1
        n = self.counters[kind]
        if self.by_section and self.cur_section:
            return f"{self.cur_section}.{n}"
        return str(n)


# Pass 1 — walk the IR and record number-by-label so refs can resolve.
def _assign_numbers(blocks: list[Any], num: _Numberer, out: dict[str, str]) -> None:
    for b in blocks or []:
        if isinstance(b, ir.Heading):
            n = num.heading(b.level, getattr(b, "numbered", True))
            if b.label:
                out[b.label] = n
        elif isinstance(b, ir.MathBlock) and getattr(b, "numbered", False):
            n = num.item("equation")
            if b.label:
                out[b.label] = n
        elif isinstance(b, ir.Figure):
            n = num.item("figure")
            if b.label:
                out[b.label] = n
        elif isinstance(b, ir.Table):
            n = num.item("table")
            if b.label:
                out[b.label] = n
        elif isinstance(b, ir.ItemList):
            for it in b.items:
                _assign_numbers(it.blocks, num, out)
        elif isinstance(b, ir.Quote):
            _assign_numbers(b.blocks, num, out)
        elif isinstance(b, ir.Theorem):
            _assign_numbers(b.blocks, num, out)


_IMG_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp")


class _Renderer:
    def __init__(self, labels: dict[str, Any], numbers: dict[str, str],
                 by_section: bool, asset_url: Any = None,
                 fig_html: Any = None,
                 src: Callable[[int, int], str | None] | None = None) -> None:
        self.labels = labels
        self.numbers = numbers
        self.asset_url = asset_url
        # optional callable(Figure) -> html|None for figures the browser can't
        # render directly (PDF/EPS/TikZ); rasterised via the tex2word backend.
        self.fig_html = fig_html
        # resolves a source marker (serial, k) → "file_idx:line" (sync anchors)
        self.src = src
        self.num = _Numberer(by_section)
        self.outline: list[dict[str, Any]] = []
        self.words = 0
        self.counts = {"headings": 0, "equations": 0, "figures": 0, "tables": 0}
        self._auto = 0

    def _auto_anchor(self) -> str:
        self._auto += 1
        return f"n{self._auto}"

    # -- inline ---------------------------------------------------------------
    def inlines(self, nodes: list[Any]) -> str:
        return "".join(self.inline(n) for n in nodes or [])

    def inline(self, n: Any) -> str:
        if isinstance(n, ir.Text):
            if "\ue000" not in n.value:
                self.words += len(n.value.split())
                return escape(n.value)
            return self._marked_text(n.value)
        if isinstance(n, ir.Math):
            return _math_html(strip_markers(n.latex), block=False)
        if isinstance(n, ir.Emphasis):
            kind = getattr(n.kind_, "name", str(n.kind_)).lower()
            tag = "strong" if "bold" in kind else "em"
            return f"<{tag}>{self.inlines(n.inlines)}</{tag}>"
        if isinstance(n, ir.Link):
            return f'<a href="{escape(n.url)}" rel="noopener">{self.inlines(n.inlines)}</a>'
        if isinstance(n, ir.LineBreak):
            return "<br>"
        if isinstance(n, (ir.Colored, ir.FontSize)):
            return f"<span>{self.inlines(n.inlines)}</span>"
        if isinstance(n, ir.Cite):
            # tex2word already formatted the citation (natbib/CSL) — use it.
            text = n.rendered or f"[{', '.join(n.keys)}]"
            return f'<span class="cite">{escape(text)}</span>'
        if isinstance(n, ir.Ref):
            return self._ref(n)
        if isinstance(n, (ir.Footnote, ir.Endnote)):
            return f'<sup class="fn">{self.inlines(n.inlines)}</sup>'
        if isinstance(n, ir.RawInline):
            return f'<code class="raw">{escape(n.latex)}</code>'
        if hasattr(n, "inlines"):
            return self.inlines(n.inlines)
        return escape(getattr(n, "value", getattr(n, "text", "")) or "")

    def _marked_text(self, value: str) -> str:
        """Text carrying source markers → escaped text + empty sync anchors."""
        out, last = [], 0
        for m in MARKER_RE.finditer(value):
            out.append(escape(strip_markers(value[last:m.start()])))
            loc = self.src(*decode_marker(m)) if self.src else None
            if loc:
                out.append(f'<span class="sl" data-src="{loc}"></span>')
            last = m.end()
        out.append(escape(strip_markers(value[last:])))
        self.words += len(strip_markers(value).split())
        return "".join(out)

    def _ref(self, n: ir.Ref) -> str:
        # Resolve the cross-reference to the number we computed for its target.
        number = self.numbers.get(n.key)
        info = self.labels.get(n.key)
        anchor = _anchor(n.key, self.labels, "")
        label = number or (getattr(info, "name", None) if info else None) or n.key
        href = f' href="#{anchor}"' if anchor else ""
        return f'<a class="ref"{href}>{escape(strip_markers(str(label)))}</a>'

    def text_only(self, nodes: list[Any]) -> str:
        parts = []
        for n in nodes or []:
            if isinstance(n, ir.Text):
                parts.append(n.value)
            elif isinstance(n, ir.Math):
                parts.append(n.latex)
            elif hasattr(n, "inlines"):
                parts.append(self.text_only(n.inlines))
        return strip_markers("".join(parts)).strip()

    # -- blocks ---------------------------------------------------------------
    def blocks(self, nodes: list[Any]) -> str:
        out = []
        for b in nodes or []:
            try:
                out.append(self.block(b))
            except Exception:
                # one bad node must not sink the whole preview
                out.append(f'<p class="render-skip">[{escape(type(b).__name__)}]</p>')
        return "".join(out)

    def block(self, b: Any) -> str:
        if isinstance(b, ir.Heading):
            return self._heading(b)
        if isinstance(b, ir.Paragraph):
            if _marker_only(b.inlines):
                # a marker placed before a display block: zero-height anchor
                return f'<p class="srcmark">{self.inlines(b.inlines)}</p>'
            align = f' style="text-align:{b.align}"' if getattr(b, "align", None) else ""
            return f"<p{align}>{self.inlines(b.inlines)}</p>"
        if isinstance(b, ir.MathBlock):
            return self._math_block(b)
        if isinstance(b, ir.Figure):
            return self._figure(b)
        if isinstance(b, ir.Table):
            return self._table(b)
        if isinstance(b, ir.ItemList):
            return self._list(b)
        if isinstance(b, ir.CodeBlock):
            return f"<pre><code>{escape(strip_markers(b.text))}</code></pre>"
        if isinstance(b, ir.Quote):
            return f"<blockquote>{self.blocks(b.blocks)}</blockquote>"
        if isinstance(b, ir.Theorem):
            # kind/title may be plain strings or inline-node lists
            kind = escape(b.kind) if isinstance(b.kind, str) else self.inlines(b.kind)
            title = f" ({self.inlines(b.title)})" if getattr(b, "title", None) else ""
            return f'<div class="theorem"><b>{kind}{title}.</b> {self.blocks(b.blocks)}</div>'
        if isinstance(b, ir.Algorithm):
            cap = self.inlines(b.caption) if b.caption else "Algorithm"
            lines = "".join(f"<div>{self.inlines(l.inlines)}</div>" for l in b.lines)
            return f'<div class="algorithm"><b>{cap}</b>{lines}</div>'
        if isinstance(b, ir.Bibliography):
            return self._bibliography(b)
        if isinstance(b, (ir.TableOfContents, ir.Index)):
            return ""
        if hasattr(b, "inlines"):
            return f"<p>{self.inlines(b.inlines)}</p>"
        if hasattr(b, "blocks"):
            return self.blocks(b.blocks)
        return ""

    def _heading(self, h: ir.Heading) -> str:
        level = max(1, min(6, h.level))
        self.counts["headings"] += 1
        number = self.num.heading(h.level, getattr(h, "numbered", True))
        prefix = f"{number} " if number else ""
        anchor = _anchor(h.label, self.labels, self._auto_anchor())
        self.outline.append(
            {"type": "heading", "level": level, "number": number,
             "text": self.text_only(h.inlines), "anchor": anchor}
        )
        return f'<h{level} id="{anchor}">{escape(prefix)}{self.inlines(h.inlines)}</h{level}>'

    def _math_block(self, m: ir.MathBlock) -> str:
        if not getattr(m, "numbered", False):
            return f'<div class="matheq">{_math_html(strip_markers(m.latex), block=True)}</div>'
        number = self.num.item("equation")
        self.counts["equations"] += 1
        anchor = _anchor(m.label, self.labels, self._auto_anchor())
        self.outline.append(
            {"type": "equation", "number": number, "text": f"Equation ({number})",
             "anchor": anchor, "level": 0}
        )
        eqno = f'<span class="eqno">({number})</span>'
        return f'<div class="matheq" id="{anchor}">{_math_html(strip_markers(m.latex), block=True)}{eqno}</div>'

    def _figure(self, f: ir.Figure) -> str:
        number = self.num.item("figure")
        self.counts["figures"] += 1
        anchor = _anchor(f.label, self.labels, self._auto_anchor())
        cap = self.inlines(f.caption) if f.caption else ""
        label = f"Figure {number}"
        self.outline.append(
            {"type": "figure", "number": number, "text": label, "anchor": anchor, "level": 0}
        )
        img = self._figure_image(f)
        return f'<figure id="{anchor}">{img}<figcaption><b>{label}.</b> {cap}</figcaption></figure>'

    def _figure_image(self, f: ir.Figure) -> str:
        path = getattr(getattr(f, "image", None), "path", None)
        # Browser-renderable raster image: serve straight from the raw endpoint.
        if path and self.asset_url and path.lower().endswith(_IMG_EXT):
            return f'<img class="fig-img" src="{escape(self.asset_url(path))}" alt="{escape(path)}">'
        # PDF/EPS/TikZ: let the engine-backed hook rasterise it (data URI / embed).
        if self.fig_html:
            html = self.fig_html(f)
            if html:
                return html
        name = escape(path) if path else "figure"
        return f'<div class="fig-placeholder">{name}</div>'

    def _table(self, t: ir.Table) -> str:
        number = self.num.item("table")
        self.counts["tables"] += 1
        anchor = _anchor(t.label, self.labels, self._auto_anchor())
        label = f"Table {number}"
        self.outline.append(
            {"type": "table", "number": number, "text": label, "anchor": anchor, "level": 0}
        )
        rows_html = []
        for row in t.rows:
            tag = "th" if getattr(row, "is_header", False) else "td"
            cells = []
            for c in row.cells:
                attrs = ""
                if getattr(c, "colspan", 1) and c.colspan > 1:
                    attrs += f' colspan="{c.colspan}"'
                if getattr(c, "rowspan", 1) and c.rowspan > 1:
                    attrs += f' rowspan="{c.rowspan}"'
                cells.append(f"<{tag}{attrs}>{self.blocks(c.blocks)}</{tag}>")
            rows_html.append("<tr>" + "".join(cells) + "</tr>")
        caption = (
            f"<caption><b>{label}.</b> {self.inlines(t.caption)}</caption>"
            if t.caption else f"<caption><b>{label}.</b></caption>"
        )
        return f'<table id="{anchor}">{caption}{"".join(rows_html)}</table>'

    def _list(self, l: ir.ItemList) -> str:
        tag = "ol" if l.ordered else "ul"
        items = "".join(f"<li>{self.blocks(it.blocks)}</li>" for it in l.items)
        return f"<{tag}>{items}</{tag}>"

    def _bibliography(self, b: ir.Bibliography) -> str:
        entries = b.entries or []
        if not entries:
            return ""
        items = []
        for e in entries:
            if hasattr(e, "inlines"):
                items.append(f"<li>{self.inlines(e.inlines)}</li>")
            elif getattr(e, "rendered", None):
                items.append(f"<li>{escape(str(e.rendered))}</li>")
            else:
                items.append(f"<li>{escape(str(e))}</li>")
        return f'<h2 class="bib-head">References</h2><ol class="bibliography">{"".join(items)}</ol>'


def _marker_only(inlines: list[Any]) -> bool:
    if not inlines or not all(isinstance(n, ir.Text) for n in inlines):
        return False
    joined = "".join(n.value for n in inlines)
    return "\ue000" in joined and not strip_markers(joined).strip()


_FIRST_TAG = re.compile(r"^<([A-Za-z][A-Za-z0-9]*)")
_EMPTY_P = re.compile(r"<p>\s*</p>")


def _segment(html: str) -> str:
    """One top-level block's HTML as a single element (so it can be keyed and
    swapped on its own); leftover marker characters are dropped."""
    html = _EMPTY_P.sub("", PUA_RE.sub("", html)).strip()
    if not html:
        return ""
    m = _FIRST_TAG.match(html)
    close_end = -1
    if m:
        depth = 0
        for t in re.finditer(rf"<(/?){m.group(1)}(?=[\s>/])", html):
            depth += -1 if t.group(1) else 1
            if depth == 0:
                close_end = html.find(">", t.end()) + 1
                break
    if close_end != len(html):  # several siblings (e.g. bibliography h2 + ol)
        return f'<div class="blk">{html}</div>'
    return html


def segment_key(html: str) -> str:
    return hashlib.blake2b(html.encode("utf-8"), digest_size=8).hexdigest()


def _keyed(html: str, key: str) -> str:
    return _FIRST_TAG.sub(lambda m: f'<{m.group(1)} data-k="{key}"', html, count=1)


def render_document(
    doc: ir.Document, *, number_by_section: bool = False, asset_url: Any = None,
    fig_html: Any = None, src: Callable[[int, int], str | None] | None = None,
    title_src: str | None = None,
) -> dict[str, Any]:
    """Render an IR document into ``{html, segments, outline, statistics, title}``.

    ``segments`` is ``[[key, html], …]`` — one entry per top-level element, each
    a single element carrying ``data-k="key"`` (a hash of its content), so a
    client can patch only the blocks that changed. ``html`` is their
    concatenation. ``src`` resolves source markers (see ``sourcemap``) into
    ``data-src`` sync anchors; ``title_src`` anchors the title.
    """
    labels = doc.labels or {}
    numbers: dict[str, str] = {}
    _assign_numbers(doc.blocks, _Numberer(number_by_section), numbers)

    r = _Renderer(labels=labels, numbers=numbers, by_section=number_by_section,
                  asset_url=asset_url, fig_html=fig_html, src=src)
    meta = doc.meta
    title_text = None
    raw: list[str] = []
    if meta and meta.title:
        title_text = r.text_only(meta.title)
        ts = f' data-src="{title_src}"' if title_src else ""
        raw.append(f"<h1 class='doc-title'{ts}>{r.inlines(meta.title)}</h1>")
    if meta and meta.authors:
        rendered = [r.inlines(a) for a in meta.authors]
        raw.append("<p class='doc-authors'>" + " · ".join(rendered) + "</p>")
    if meta and meta.abstract:
        raw.append(f"<div class='abstract'><b>Abstract.</b> {r.blocks(meta.abstract)}</div>")
    for b in doc.blocks or []:
        raw.append(r.blocks([b]))

    segments: list[list[str]] = []
    for piece in raw:
        html = _segment(piece)
        if html:
            key = segment_key(html)
            segments.append([key, _keyed(html, key)])

    statistics = {
        "words": r.words,
        "headings": r.counts["headings"],
        "equations": r.counts["equations"],
        "figures": r.counts["figures"],
        "tables": r.counts["tables"],
    }
    return {
        "html": "".join(h for _, h in segments),
        "segments": segments,
        "outline": r.outline,
        "statistics": statistics,
        "title": title_text,
    }
