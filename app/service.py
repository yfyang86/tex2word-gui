"""Thin wrapper around the ``tex2word`` engine.

All direct calls into ``tex2word`` live here so the HTTP layer stays free of
engine details and engine failures surface as :class:`ConversionError` rather
than bare tracebacks.
"""

from __future__ import annotations

import base64
import dataclasses
import functools
import os
import tempfile
import time
from html import escape
from typing import Any, Callable

import tex2word
from tex2word import convert_source
from tex2word.benchmark import validate_docx
from tex2word.report import ConversionReport, aggregate_html
from tex2word.roundtrip import read_manifest, to_latex

# Conversion options we expose to the frontend, mapped to convert_source kwargs.
_ALLOWED_FRONTENDS = {"pure", "latexml"}
_ALLOWED_CITATION_MODES = {"static", "zotero"}

# Figure formats the browser can't show in <img>; rasterised for the preview.
_VECTOR_EXT = (".pdf", ".eps", ".ps")
_PREVIEW_DPI = 150


class ConversionError(Exception):
    """Raised when the engine cannot turn the given source into a document."""


@dataclasses.dataclass(slots=True)
class ConvertOptions:
    """Validated subset of ``convert_source`` options exposed by the app."""

    number_by_section: bool = False
    columns: int = 1
    language: str | None = None
    frontend: str = "pure"
    citation_mode: str = "static"
    csl: str | None = None          # project-relative path to a .csl style
    math_image_fallback: bool = False
    reference_doc: str | None = None  # project-relative path to a template .docx

    @classmethod
    def from_payload(cls, data: dict[str, Any] | None) -> "ConvertOptions":
        data = data or {}
        columns = int(data.get("columns", 1) or 1)
        if not 1 <= columns <= 4:
            raise ConversionError("columns must be between 1 and 4")
        frontend = str(data.get("frontend", "pure") or "pure")
        if frontend not in _ALLOWED_FRONTENDS:
            raise ConversionError(
                f"frontend must be one of {sorted(_ALLOWED_FRONTENDS)}"
            )
        citation_mode = str(data.get("citation_mode", "static") or "static")
        if citation_mode not in _ALLOWED_CITATION_MODES:
            raise ConversionError(
                f"citation_mode must be one of {sorted(_ALLOWED_CITATION_MODES)}"
            )
        language = data.get("language") or None
        return cls(
            number_by_section=bool(data.get("number_by_section", False)),
            columns=columns,
            language=language,
            frontend=frontend,
            citation_mode=citation_mode,
            csl=(data.get("csl") or None),
            math_image_fallback=bool(data.get("math_image_fallback", False)),
            reference_doc=(data.get("reference_doc") or None),
        )


def engine_version() -> str:
    """Return the installed tex2word version."""
    return getattr(tex2word, "__version__", "unknown")


def report_to_dict(report: ConversionReport) -> dict[str, Any]:
    """Serialise a :class:`ConversionReport` into a JSON-friendly dict."""
    entries = [
        {
            "severity": e.severity,
            "construct": e.construct,
            "message": e.message,
        }
        for e in report.entries
    ]
    # coverage() returns counts; derive the OMML ratio (1.0 when there's no math)
    cov = report.coverage()
    total = cov.get("math_total", 0)
    ratio = (cov.get("math_omml", 0) / total) if total else 1.0
    return {
        "summary": report.summary(),
        "coverage": ratio,
        "math": {
            "omml": report.math_omml,
            "image": report.math_image,
            "raw": report.math_raw,
        },
        "counts": {
            "warnings": len(report.warnings),
            "errors": len(report.errors),
        },
        "constructs": dict(report.construct_counts()),
        "entries": entries,
    }


def run_source(source: str, options: ConvertOptions) -> "Any":
    """Run the engine on a single LaTeX string and return the ``ConversionResult``.

    Exposes ``.docx`` / ``.document`` (IR) / ``.report``. Raises
    :class:`ConversionError` for empty input or any engine failure.
    """
    if not source or not source.strip():
        raise ConversionError("source is empty")
    try:
        return convert_source(
            source,
            number_by_section=options.number_by_section,
            columns=options.columns,
            frontend=options.frontend,
            language=options.language,
            citation_mode=options.citation_mode,
            math_image_fallback=options.math_image_fallback,
        )
    except Exception as exc:  # engine raises a variety of errors
        raise ConversionError(f"conversion failed: {exc}") from exc


def run_project(
    files: dict[str, str],
    main_path: str,
    options: ConvertOptions,
    assets: dict[str, bytes] | None = None,
) -> "Any":
    """Run the engine on a multi-file project and return the ``ConversionResult``.

    Text ``files`` and binary ``assets`` (figures) are materialised into a temp
    directory so ``tex2word`` can resolve ``\\input`` / ``\\include`` and embed
    ``\\includegraphics`` images via ``base_dir``. Raises :class:`ConversionError`
    for a missing/empty main file or any engine failure.
    """
    if main_path not in files:
        raise ConversionError(f"main file {main_path!r} is not in the project")
    main_source = files[main_path]
    if not main_source or not main_source.strip():
        raise ConversionError(f"main file {main_path!r} is empty")

    with tempfile.TemporaryDirectory() as base_dir:
        abs_base = os.path.abspath(base_dir)

        def _dest(path: str) -> str:
            dest = os.path.abspath(os.path.join(abs_base, path))
            if dest != abs_base and not dest.startswith(abs_base + os.sep):
                raise ConversionError(f"illegal file path: {path!r}")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            return dest

        for path, content in files.items():
            with open(_dest(path), "w", encoding="utf-8") as fh:
                fh.write(content)
        for path, blob in (assets or {}).items():
            with open(_dest(path), "wb") as fh:
                fh.write(blob)
        # use a project .csl style if the option points at a real project file
        csl_path = None
        if options.csl and options.csl in files and options.csl.lower().endswith(".csl"):
            csl_path = os.path.join(abs_base, options.csl)
        # adopt a project template .docx (a binary asset) as the reference doc
        ref_doc = None
        ref = options.reference_doc
        if ref and ref.lower().endswith(".docx") and ref in (assets or {}):
            ref_doc = os.path.join(abs_base, ref)
        try:
            return convert_source(
                main_source,
                base_dir=base_dir,
                number_by_section=options.number_by_section,
                columns=options.columns,
                frontend=options.frontend,
                language=options.language,
                citation_mode=options.citation_mode,
                csl=csl_path,
                math_image_fallback=options.math_image_fallback,
                reference_doc=ref_doc,
            )
        except Exception as exc:
            raise ConversionError(f"conversion failed: {exc}") from exc


def convert(source: str, options: ConvertOptions) -> tuple[bytes, dict[str, Any]]:
    """Convert LaTeX ``source`` to ``.docx`` bytes plus a report dict."""
    result = run_source(source, options)
    return result.docx, report_to_dict(result.report)


def _png_data_uri(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


@functools.lru_cache(maxsize=64)
def _raster_png(blob: bytes, fmt: str, dpi: int) -> bytes | None:
    """Rasterise PDF/EPS bytes to PNG via tex2word's own backend (cached)."""
    from tex2word.backend import raster

    with tempfile.NamedTemporaryFile(suffix=f".{fmt}", delete=False) as tf:
        tf.write(blob)
        tmp = tf.name
    try:
        out = raster.rasterize(tmp, fmt, dpi)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return out[0] if out else None


@functools.lru_cache(maxsize=32)
def _tikz_png(source: str, dpi: int) -> bytes | None:
    """Compile a TikZ/PGF figure to PNG via tex2word's tikz backend (cached)."""
    from tex2word.backend import tikz

    out = tikz.render(source, dpi=dpi)
    return out[0] if out else None


def _resolve_vector(path: str, assets: dict[str, bytes]) -> tuple[str | None, str]:
    """Find a PDF/EPS asset for an \\includegraphics path (extension optional)."""
    candidates = [path] + [path + ext for ext in _VECTOR_EXT]
    for cand in candidates:
        if cand in assets:
            fmt = os.path.splitext(cand)[1].lower().lstrip(".")
            if f".{fmt}" in _VECTOR_EXT:
                return cand, fmt
    return None, ""


def make_figure_html(
    assets: dict[str, bytes] | None = None,
    *,
    asset_url: Callable[[str], str] | None = None,
    dpi: int = _PREVIEW_DPI,
) -> Callable[[Any], str | None]:
    """Build a ``callable(Figure) -> html | None`` for figures the browser can't
    render natively (PDF/EPS images and inline TikZ/PGF), reusing tex2word's own
    raster/tikz backends. Returns ``None`` for raster images (handled upstream by
    ``asset_url``) or when rasterisation isn't possible, so the caller can fall
    back to a placeholder.
    """
    assets = assets or {}

    def render(fig: Any) -> str | None:
        try:
            img = getattr(fig, "image", None)
            # Inline TikZ/PGF: no image node, compile the figure source.
            if img is None:
                src = getattr(fig, "source", "") or ""
                if not src:
                    return None
                png = _tikz_png(src, dpi)
                return f'<img class="fig-img" src="{_png_data_uri(png)}" alt="figure">' if png else None
            path = getattr(img, "path", "") or ""
            key, fmt = _resolve_vector(path, assets)
            if key is None:
                return None
            png = _raster_png(assets[key], fmt, dpi)
            if png:
                return f'<img class="fig-img" src="{_png_data_uri(png)}" alt="{path}">'
            # No rasteriser (e.g. pypdfium2 missing): let the browser show the PDF.
            if fmt == "pdf" and asset_url:
                return f'<object class="fig-img fig-pdf" type="application/pdf" data="{escape(asset_url(key))}"></object>'
            return None
        except Exception:
            return None

    return render


def preview(
    result: "Any",
    *,
    number_by_section: bool = False,
    asset_url: "Any" = None,
    fig_html: "Any" = None,
) -> dict[str, Any]:
    """Render a ``ConversionResult`` into a preview payload (html/outline/stats).

    ``asset_url`` is an optional ``path -> url`` callable used to render raster
    figure images (e.g. pointing at the project's raw-file endpoint). ``fig_html``
    is an optional ``Figure -> html`` callable for PDF/EPS/TikZ figures.
    """
    from . import preview as _preview  # local import avoids a cycle at load time

    data = _preview.render_document(
        result.document, number_by_section=number_by_section,
        asset_url=asset_url, fig_html=fig_html,
    )
    data["report"] = report_to_dict(result.report)
    return data


def convert_project(
    files: dict[str, str],
    main_path: str,
    options: ConvertOptions,
    assets: dict[str, bytes] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """Convert a multi-file project to ``.docx`` bytes plus a report dict."""
    result = run_project(files, main_path, options, assets)
    return result.docx, report_to_dict(result.report)


def coverage_report(
    items: list[tuple[str, dict[str, str], str]]
) -> dict[str, Any]:
    """Aggregate tex2word conversion metrics over a list of projects.

    Each item is ``(label, files, main_path)``. Per project we run the real
    conversion, read the ``ConversionReport`` and validate the ``.docx``; a
    conversion that raises is recorded as *aborted* rather than failing the whole
    dashboard.
    """
    rows: list[dict[str, Any]] = []
    agg: dict[str, Any] = {
        "projects": 0, "converted": 0, "aborted": 0, "valid": 0,
        "math_omml": 0, "math_image": 0, "math_raw": 0,
        "warnings": 0, "errors": 0, "constructs": {},
    }
    for item in items:
        label, files, main_path = item[0], item[1], item[2]
        assets = item[3] if len(item) > 3 else None
        agg["projects"] += 1
        t0 = time.perf_counter()
        try:
            result = run_project(files, main_path, ConvertOptions(), assets)
        except ConversionError as exc:
            agg["aborted"] += 1
            rows.append({"label": label, "ok": False, "aborted": True, "error": str(exc)})
            continue
        rep = report_to_dict(result.report)
        issues = validate_docx(result.docx)
        secs = round(time.perf_counter() - t0, 3)
        math = rep["math"]
        agg["converted"] += 1
        agg["valid"] += 0 if issues else 1
        agg["math_omml"] += math["omml"]
        agg["math_image"] += math["image"]
        agg["math_raw"] += math["raw"]
        agg["warnings"] += rep["counts"]["warnings"]
        agg["errors"] += rep["counts"]["errors"]
        for k, v in rep["constructs"].items():
            agg["constructs"][k] = agg["constructs"].get(k, 0) + v
        rows.append({
            "label": label, "ok": True, "aborted": False,
            "coverage": rep["coverage"],
            "omml": math["omml"], "image": math["image"], "raw": math["raw"],
            "warnings": rep["counts"]["warnings"], "errors": rep["counts"]["errors"],
            "valid": not issues, "issues": issues[:5], "seconds": secs,
        })
    total_math = agg["math_omml"] + agg["math_image"] + agg["math_raw"]
    agg["coverage"] = (agg["math_omml"] / total_math) if total_math else 1.0
    return {"aggregate": agg, "rows": rows}


def engine_coverage_html(items: list[tuple[str, dict[str, str], str]]) -> str:
    """tex2word's own aggregate coverage dashboard (HTML) over the projects."""
    results = []
    for item in items:
        label, files, main_path = item[0], item[1], item[2]
        assets = item[3] if len(item) > 3 else None
        try:
            result = run_project(files, main_path, ConvertOptions(), assets)
        except ConversionError:
            continue
        results.append((label, result.report))
    return aggregate_html(results)


def recover_latex(docx_bytes: bytes) -> str:
    """Recover LaTeX from a tex2word-produced ``.docx``.

    Raises :class:`ConversionError` if the document carries no recoverable
    manifest (e.g. it was not produced by tex2word).
    """
    if not docx_bytes:
        raise ConversionError("uploaded file is empty")
    try:
        manifest = read_manifest(docx_bytes)
        if manifest is None:
            raise ConversionError(
                "no recoverable LaTeX manifest found — "
                "was this .docx produced by tex2word?"
            )
        latex = to_latex(docx_bytes)
    except ConversionError:
        raise
    except Exception as exc:
        raise ConversionError(f"round-trip failed: {exc}") from exc
    if latex is None:
        raise ConversionError("round-trip produced no LaTeX")
    return latex
