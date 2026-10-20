"""The table generator's LaTeX (app/static/tablegen.js) converts cleanly with tex2word.

The generator is JavaScript; node renders a set of cases and each is run
through the real engine, checking the Word-side structure: rows/cells,
merged cells, shading, booktabs, caption + label, and a valid .docx.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from tex2word import convert_source, ir
from tex2word.benchmark import validate_docx

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is required")

PREAMBLE = (
    "\\documentclass{article}\n\\usepackage{booktabs,multirow,array,tabularx,graphicx,"
    "xcolor,colortbl,longtable,rotating}\n\\begin{document}\n"
)


@pytest.fixture(scope="module")
def cases():
    out = subprocess.check_output(["node", str(ROOT / "tests/js/tablegen_cases.js")], text=True)
    return json.loads(out)


def _convert(code):
    src = code if code.startswith("\\documentclass") else PREAMBLE + code + "\n\\end{document}\n"
    result = convert_source(src)
    tables = [b for b in result.document.blocks if isinstance(b, ir.Table)]
    assert validate_docx(result.docx) == []
    assert not result.report.errors
    return tables, result


def _text(cell):
    return "".join(getattr(n, "value", "") for b in cell.blocks for n in _walk(getattr(b, "inlines", [])))


def _walk(nodes):
    for n in nodes:
        yield n
        yield from _walk(getattr(n, "inlines", []) or [])


def test_every_case_converts(cases):
    assert len(cases) >= 8
    for name, code in cases.items():
        tables, _ = _convert(code)
        assert len(tables) == 1, name
        assert len(tables[0].rows) == 4, name


def test_caption_label_and_cells(cases):
    (t,), _ = _convert(cases["standard_all_borders"])
    assert "".join(n.value for n in t.caption if hasattr(n, "value")) == "Main results"
    assert t.label == "tab:main"
    assert [_text(c) for c in t.rows[3].cells] == ["Tiny", "50%", "x & y"]  # escapes survive


def test_booktabs_flag(cases):
    (t,), _ = _convert(cases["booktabs"])
    assert t.booktabs is True


def test_merges_and_shading(cases):
    (t,), _ = _convert(cases["merges_and_colours"])
    head = t.rows[0].cells
    assert head[1].colspan == 2
    assert t.rows[1].cells[0].rowspan == 2
    shaded = [c for row in t.rows for c in row.cells if getattr(c, "shade", None)]
    assert [c.shade.upper() for c in shaded] == ["FFCC00"]
    colored = [n for row in t.rows for c in row.cells for b in c.blocks
               for n in _walk(getattr(b, "inlines", [])) if isinstance(n, ir.Colored)]
    assert colored, "text colour reaches the IR"


def test_width_and_layout_variants_keep_the_table(cases):
    for name in ("wrap", "scale", "longtable", "landscape", "widths"):
        (t,), _ = _convert(cases[name])
        assert [_text(c) for c in t.rows[1].cells] == ["Ours", "0.91", "0.88"], name
    (t,), _ = _convert(cases["longtable"])
    assert "".join(n.value for n in t.caption if hasattr(n, "value")) == "Long"
