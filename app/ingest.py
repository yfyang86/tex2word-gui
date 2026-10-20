"""Ingestion: build projects from Markdown or an arXiv source bundle.

Markdown is the one path that doesn't start from LaTeX — we convert it to a
LaTeX document (via mistune's AST) so it still flows through the tex2word engine
for the actual Word conversion. arXiv ingestion downloads the paper's LaTeX
source bundle and turns its text files into a project.
"""

from __future__ import annotations

import gzip
import io
import re
import tarfile
import zipfile
from typing import Any, Callable

import mistune


class IngestError(Exception):
    """Ingestion could not produce a project (bad input, fetch/unpack failure)."""


# ── Markdown → LaTeX ────────────────────────────────────────────────────────
_ESCAPE = {
    "\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
    "_": r"\_", "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}
_ESCAPE_RE = re.compile("|".join(re.escape(k) for k in _ESCAPE))

_HEADINGS = {1: "section", 2: "subsection", 3: "subsubsection",
             4: "paragraph", 5: "subparagraph", 6: "subparagraph"}

_PREAMBLE = (
    "\\documentclass{article}\n"
    "\\usepackage{amsmath,amssymb}\n"
    "\\usepackage{graphicx}\n"
    "\\usepackage[normalem]{ulem}\n"
    "\\usepackage{hyperref}\n"
)


def _esc(text: str) -> str:
    return _ESCAPE_RE.sub(lambda m: _ESCAPE[m.group()], text)


# Math is extracted *before* Markdown parsing and restored *after*, so its LaTeX
# is never Markdown-escaped and every common delimiter LLMs emit is recognised:
#   inline   $…$   \(…\)
#   display  $$…$$  \[…\]
# Code (fenced ``` blocks and `inline` spans) is left untouched.
_MATH_SCAN = re.compile(
    r"(?P<fence>^[ \t]*(?P<f>`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*(?P=f)[^\n]*$)"
    r"|(?P<code>`+[^`\n]*`+)"
    r"|(?P<dd>(?<!\\)\$\$(?P<dd_c>[\s\S]+?)\$\$)"
    r"|(?P<db>\\\[(?P<db_c>[\s\S]+?)\\\])"
    r"|(?P<ip>\\\((?P<ip_c>[\s\S]+?)\\\))"
    r"|(?P<is>(?<!\\)\$(?!\s)(?P<is_c>(?:[^$\\]|\\.)+?)(?<!\s)\$)",
    re.MULTILINE,
)
_MATH_TOKEN = "ZtexwordmathZ{}Z"


def _protect_math(markdown: str) -> tuple[str, list[tuple[bool, str]]]:
    """Replace math spans with opaque tokens; return (text, [(is_display, latex)])."""
    spans: list[tuple[bool, str]] = []
    out: list[str] = []
    pos = 0
    for m in _MATH_SCAN.finditer(markdown):
        out.append(markdown[pos:m.start()])
        pos = m.end()
        if m.group("fence") is not None or m.group("code") is not None:
            out.append(m.group())  # leave code exactly as written
            continue
        if m.group("dd") is not None:
            display, content = True, m.group("dd_c")
        elif m.group("db") is not None:
            display, content = True, m.group("db_c")
        elif m.group("ip") is not None:
            display, content = False, m.group("ip_c")
        else:
            display, content = False, m.group("is_c")
        out.append(_MATH_TOKEN.format(len(spans)))
        spans.append((display, content.strip()))
    out.append(markdown[pos:])
    return "".join(out), spans


def _restore_math(latex: str, spans: list[tuple[bool, str]]) -> str:
    for i, (display, content) in enumerate(spans):
        repl = (f"\\begin{{equation}}\n{content}\n\\end{{equation}}"
                if display else f"${content}$")
        latex = latex.replace(_MATH_TOKEN.format(i), repl)
    return latex


class _MarkdownToLatex:
    def __init__(self) -> None:
        # Math is handled by _protect_math/_restore_math (all delimiter styles),
        # so mistune's own math plugin is intentionally omitted.
        self._md = mistune.create_markdown(
            renderer=None, plugins=["strikethrough", "table"]
        )

    def convert(self, markdown: str, title: str | None = None) -> str:
        protected, spans = _protect_math(markdown)
        tokens = self._md(protected)
        body = self._blocks(tokens)
        head = _PREAMBLE
        if title:
            head += f"\\title{{{_esc(title)}}}\n"
        head += "\\begin{document}\n"
        if title:
            head += "\\maketitle\n"
        return _restore_math(head + body + "\\end{document}\n", spans)

    # -- blocks ---------------------------------------------------------------
    def _blocks(self, nodes: list[dict[str, Any]]) -> str:
        return "".join(self._block(n) for n in nodes or [])

    def _block(self, n: dict[str, Any]) -> str:
        t = n["type"]
        if t == "blank_line":
            return ""
        if t == "paragraph":
            return self._inlines(n["children"]) + "\n\n"
        if t == "heading":
            cmd = _HEADINGS.get(n["attrs"]["level"], "section")
            return f"\\{cmd}{{{self._inlines(n['children'])}}}\n\n"
        if t == "list":
            return self._list(n)
        if t == "block_quote":
            return "\\begin{quote}\n" + self._blocks(n["children"]) + "\\end{quote}\n\n"
        if t == "block_code":
            return "\\begin{verbatim}\n" + n["raw"].rstrip("\n") + "\n\\end{verbatim}\n\n"
        if t == "block_math":
            return "\\begin{equation}\n" + n["raw"].strip() + "\n\\end{equation}\n\n"
        if t == "thematic_break":
            return "\\begin{center}\\rule{0.5\\linewidth}{0.4pt}\\end{center}\n\n"
        if t == "table":
            return self._table(n)
        if t == "block_text":
            return self._inlines(n["children"])
        if "children" in n:
            return self._blocks(n["children"])
        return ""

    def _list(self, n: dict[str, Any]) -> str:
        env = "enumerate" if n["attrs"].get("ordered") else "itemize"
        out = [f"\\begin{{{env}}}\n"]
        for item in n["children"]:
            out.append("\\item " + self._item(item["children"]).strip() + "\n")
        out.append(f"\\end{{{env}}}\n\n")
        return "".join(out)

    def _item(self, children: list[dict[str, Any]]) -> str:
        parts = []
        for c in children:
            if c["type"] in ("block_text", "paragraph"):
                parts.append(self._inlines(c["children"]))
            elif c["type"] == "list":
                parts.append("\n" + self._list(c))
            else:
                parts.append(self._block(c))
        return " ".join(p for p in parts if p)

    def _table(self, n: dict[str, Any]) -> str:
        rows: list[list[str]] = []
        align = "l"
        aligns: list[str] = []
        for section in n["children"]:
            for row in ([section] if section["type"] == "table_head" else section["children"]):
                cells = row["children"] if "children" in row else []
                if not aligns:
                    aligns = [{"left": "l", "center": "c", "right": "r"}.get(
                        c["attrs"].get("align") or "left", "l") for c in cells]
                rows.append([self._inlines(c["children"]) for c in cells])
        colspec = "".join(aligns) or "l"
        lines = ["\\begin{center}", f"\\begin{{tabular}}{{{colspec}}}", "\\hline"]
        for i, r in enumerate(rows):
            lines.append(" & ".join(r) + " \\\\")
            if i == 0:
                lines.append("\\hline")
        lines += ["\\hline", "\\end{tabular}", "\\end{center}", ""]
        return "\n".join(lines) + "\n"

    # -- inline ---------------------------------------------------------------
    def _inlines(self, nodes: list[dict[str, Any]]) -> str:
        return "".join(self._inline(n) for n in nodes or [])

    def _inline(self, n: dict[str, Any]) -> str:
        t = n["type"]
        if t == "text":
            return _esc(n["raw"])
        if t == "strong":
            return "\\textbf{" + self._inlines(n["children"]) + "}"
        if t == "emphasis":
            return "\\textit{" + self._inlines(n["children"]) + "}"
        if t == "codespan":
            return "\\texttt{" + _esc(n["raw"]) + "}"
        if t == "inline_math":
            return "$" + n["raw"] + "$"
        if t == "strikethrough":
            return "\\sout{" + self._inlines(n["children"]) + "}"
        if t == "link":
            return f"\\href{{{n['attrs']['url']}}}{{{self._inlines(n['children'])}}}"
        if t == "image":
            return f"\\includegraphics[width=\\linewidth]{{{n['attrs']['url']}}}"
        if t == "linebreak":
            return "\\\\\n"
        if t == "softbreak":
            return "\n"
        if "children" in n:
            return self._inlines(n["children"])
        return _esc(n.get("raw", ""))


def markdown_to_latex(markdown: str, title: str | None = None) -> str:
    """Convert a Markdown string to a complete LaTeX document."""
    return _MarkdownToLatex().convert(markdown, title=title)


def from_markdown(name: str, markdown: str) -> dict[str, str]:
    """Project files for a Markdown import: converted main.tex + the source."""
    if not markdown.strip():
        raise IngestError("markdown is empty")
    return {"main.tex": markdown_to_latex(markdown, title=name), "source.md": markdown}


# ── arXiv ───────────────────────────────────────────────────────────────────
_ARXIV_ID = re.compile(r"^(?:arxiv:)?\s*(?P<id>\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)$", re.I)
_TEXT_EXT = (".tex", ".bib", ".bbl", ".cls", ".sty", ".tikz", ".txt")
_ASSET_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp",
              ".pdf", ".eps")


def normalize_arxiv_id(raw: str) -> str:
    m = _ARXIV_ID.match((raw or "").strip())
    if not m:
        raise IngestError(f"not a valid arXiv id: {raw!r}")
    return m.group("id")


# Defaults for the import limits; the app passes the configured values
# ([import] max_archive_mb / max_archive_files in config.toml).
DEFAULT_MAX_BYTES = 100 * 1024 * 1024
DEFAULT_MAX_FILES = 500


class IngestTooLarge(IngestError):
    """The bundle exceeds the configured size/file-count limits."""


def _mb(n: int) -> str:
    mb = n / (1024 * 1024)
    if mb >= 10:
        return f"{mb:.0f} MB"
    return f"{mb:.1f} MB" if mb >= 1 else f"{max(1, round(n / 1024))} KB"


def _too_large(what: str, limit: int) -> IngestTooLarge:
    return IngestTooLarge(
        f"{what} is larger than the {_mb(limit)} import limit "
        "(raise [import].max_archive_mb in config.toml)"
    )


def _default_fetch(arxiv_id: str, max_bytes: int = DEFAULT_MAX_BYTES) -> bytes:
    """Download an e-print, refusing anything over ``max_bytes`` without
    buffering more than the limit."""
    import urllib.request

    url = f"https://arxiv.org/e-print/{arxiv_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "tex2word-web/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - fixed host
        length = resp.headers.get("Content-Length")
        if length and length.isdigit() and int(length) > max_bytes:
            raise _too_large(f"arXiv:{arxiv_id} source ({_mb(int(length))})", max_bytes)
        data = resp.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise _too_large(f"arXiv:{arxiv_id} source", max_bytes)
    return data


def _safe_name(name: str) -> str:
    """Normalise an archive member path: forward slashes, no leading/`..` parts."""
    name = name.replace("\\", "/")
    parts = [p for p in name.split("/") if p not in ("", ".", "..")]
    return "/".join(parts)


def _strip_common_prefix(members: dict[str, bytes]) -> dict[str, bytes]:
    """Drop a single shared top-level directory (common when zipping a folder)."""
    tops = {p.split("/", 1)[0] for p in members if "/" in p}
    if len(tops) == 1 and all("/" in p for p in members):
        return {p.split("/", 1)[1]: c for p, c in members.items()}
    return members


def _extract_members(
    data: bytes, max_bytes: int = DEFAULT_MAX_BYTES, max_files: int = DEFAULT_MAX_FILES,
) -> dict[str, bytes]:
    """Extract text + asset members from a zip, tar(.gz), or single gzipped tex.

    Member paths are sanitised (no traversal); a shared top-level folder is
    stripped; the archive itself and the extracted total are bounded by
    ``max_bytes`` and the member count by ``max_files`` (archive bombs).
    """
    if len(data) > max_bytes:
        raise _too_large(f"the archive ({_mb(len(data))})", max_bytes)
    members: dict[str, bytes] = {}
    total = 0
    keep = _TEXT_EXT + _ASSET_EXT

    def _add(name: str, raw: bytes) -> None:
        nonlocal total
        name = _safe_name(name)
        if not name or not name.lower().endswith(keep):
            return
        total += len(raw)
        if total > max_bytes:
            raise _too_large("the extracted archive", max_bytes)
        if len(members) >= max_files:
            raise IngestTooLarge(
                f"the archive has more than {max_files} source files "
                "(raise [import].max_archive_files in config.toml)"
            )
        members[name] = raw

    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                if info.file_size > max_bytes - total:  # declared size: fail before inflating
                    raise _too_large("the extracted archive", max_bytes)
                _add(info.filename, zf.read(info))
    else:
        try:
            tar = tarfile.open(fileobj=io.BytesIO(data))
        except tarfile.TarError:
            # a single gzipped .tex (some arXiv e-prints) rather than an archive
            try:
                with gzip.GzipFile(fileobj=io.BytesIO(data)) as gz:
                    raw = gz.read(max_bytes + 1)
            except Exception as exc:
                raise IngestError(f"unrecognised archive: {exc}") from exc
            if len(raw) > max_bytes:
                raise _too_large("the extracted archive", max_bytes)
            return {"main.tex": raw}
        with tar:
            for member in tar.getmembers():
                if not member.isfile():
                    continue
                if member.size > max_bytes - total:  # declared size: fail before reading
                    raise _too_large("the extracted archive", max_bytes)
                fh = tar.extractfile(member)
                if fh is not None:
                    _add(member.name, fh.read())

    if not members:
        raise IngestError("no LaTeX/text source files found in the archive")
    return _strip_common_prefix(members)


def archive_to_project(
    data: bytes, max_bytes: int = DEFAULT_MAX_BYTES, max_files: int = DEFAULT_MAX_FILES,
) -> tuple[dict[str, str], dict[str, bytes]]:
    """Split an archive into ``(text_files, binary_assets)``."""
    members = _extract_members(data, max_bytes, max_files)
    text: dict[str, str] = {}
    assets: dict[str, bytes] = {}
    for name, raw in members.items():
        if name.lower().endswith(_ASSET_EXT):
            assets[name] = raw
        else:
            text[name] = raw.decode("utf-8", "ignore")
    if not text:
        raise IngestError("no LaTeX/text source files found in the archive")
    return text, assets


def archive_to_files(data: bytes) -> dict[str, str]:
    """Text source files from an archive (back-compat helper)."""
    return archive_to_project(data)[0]


def arxiv_to_files(data: bytes) -> dict[str, str]:
    """Extract the text source files from an arXiv e-print bundle."""
    return archive_to_files(data)


def _name_from_filename(filename: str | None) -> str:
    base = _safe_name(filename or "").split("/")[-1] or "Imported project"
    for ext in (".tar.gz", ".tgz", ".tar.bz2", ".tar", ".zip", ".gz", ".tex"):
        if base.lower().endswith(ext):
            return base[: -len(ext)] or "Imported project"
    return base


def from_archive(
    name: str | None, filename: str | None, data: bytes, *,
    max_bytes: int = DEFAULT_MAX_BYTES, max_files: int = DEFAULT_MAX_FILES,
) -> tuple[str, dict[str, str], dict[str, bytes], str]:
    """Return ``(project_name, text_files, assets, main_path)`` for an archive."""
    if not data:
        raise IngestError("uploaded archive is empty")
    text, assets = archive_to_project(data, max_bytes, max_files)
    main_path = pick_main(text)
    proj_name = (name or "").strip() or _name_from_filename(filename)
    return proj_name, text, assets, main_path


def pick_main(files: dict[str, str]) -> str:
    """Choose the main .tex file (the one with \\documentclass)."""
    tex = {p: c for p, c in files.items() if p.lower().endswith(".tex")}
    if not tex:
        raise IngestError("no .tex file in the bundle")
    with_class = [p for p, c in tex.items() if "\\documentclass" in c]
    pool = with_class or list(tex)
    for preferred in ("main.tex", "ms.tex", "paper.tex"):
        for p in pool:
            if p.lower().endswith(preferred):
                return p
    # otherwise the shallowest, then alphabetical
    return sorted(pool, key=lambda p: (p.count("/"), p))[0]


def from_arxiv(
    arxiv_id: str, fetch: Callable[[str], bytes] | None = None, *,
    max_bytes: int = DEFAULT_MAX_BYTES, max_files: int = DEFAULT_MAX_FILES,
) -> tuple[str, dict[str, str], dict[str, bytes], str]:
    """Return ``(arxiv_id, text_files, assets, main_path)`` for an arXiv paper."""
    norm = normalize_arxiv_id(arxiv_id)
    fetcher = fetch or (lambda aid: _default_fetch(aid, max_bytes))
    try:
        data = fetcher(norm)
    except IngestError:
        raise
    except Exception as exc:
        raise IngestError(f"could not download arXiv:{norm} — {exc}") from exc
    if len(data) > max_bytes:
        raise _too_large(f"arXiv:{norm} source", max_bytes)
    text, assets = archive_to_project(data, max_bytes, max_files)
    return norm, text, assets, pick_main(text)
