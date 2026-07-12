import io
import zipfile
from pathlib import Path

import pytest

from app import service

SAMPLE = (Path(__file__).parent / "samples" / "sample.tex").read_text()


def test_engine_version_is_reported():
    assert service.engine_version()  # non-empty


def test_convert_produces_valid_docx_zip():
    options = service.ConvertOptions()
    docx, report = service.convert(SAMPLE, options)

    # A .docx is a zip containing the main document part.
    assert docx[:2] == b"PK"
    with zipfile.ZipFile(io.BytesIO(docx)) as zf:
        names = zf.namelist()
    assert "word/document.xml" in names

    assert 0.0 <= report["coverage"] <= 1.0
    assert set(report["math"]) == {"omml", "image", "raw"}
    assert "summary" in report
    assert isinstance(report["entries"], list)


def test_convert_rejects_empty_source():
    with pytest.raises(service.ConversionError):
        service.convert("   ", service.ConvertOptions())


def test_options_validation():
    with pytest.raises(service.ConversionError):
        service.ConvertOptions.from_payload({"columns": 9})
    with pytest.raises(service.ConversionError):
        service.ConvertOptions.from_payload({"frontend": "bogus"})
    opts = service.ConvertOptions.from_payload(
        {"number_by_section": True, "columns": 2, "language": "de-DE"}
    )
    assert opts.number_by_section and opts.columns == 2 and opts.language == "de-DE"


def test_roundtrip_recovers_latex():
    docx, _ = service.convert(SAMPLE, service.ConvertOptions())
    latex = service.recover_latex(docx)
    assert isinstance(latex, str) and latex.strip()
    # the recovered source should mention the section we wrote
    assert "Intro" in latex


def test_roundtrip_rejects_non_tex2word_docx():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", "<xml/>")
    with pytest.raises(service.ConversionError):
        service.recover_latex(buf.getvalue())
