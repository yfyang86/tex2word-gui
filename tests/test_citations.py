import pytest
from fastapi.testclient import TestClient

from app import service
from app.main import app

BIB = "@article{vaswani2017, author={Vaswani, Ashish}, title={Attention}, year={2017}, journal={NeurIPS}}"
MAIN = (
    r"\documentclass{article}\usepackage{natbib}\begin{document}"
    r"\section{X}As shown by \citet{vaswani2017}."
    r"\bibliographystyle{plainnat}\bibliography{refs}\end{document}"
)
CSL = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text" default-locale="en-US">'
    "<info><title>Num</title><id>num</id><updated>2020-01-01T00:00:00+00:00</updated></info>"
    '<citation collapse="citation-number"><layout prefix="[" suffix="]"><text variable="citation-number"/></layout></citation>'
    '<bibliography><layout><text variable="citation-number" prefix="[" suffix="] "/>'
    '<names variable="author" suffix=", "/><text variable="title"/></layout></bibliography></style>'
)


@pytest.fixture
def client():
    return TestClient(app)


def test_citation_mode_validation():
    with pytest.raises(service.ConversionError):
        service.ConvertOptions.from_payload({"citation_mode": "bogus"})
    opts = service.ConvertOptions.from_payload({"citation_mode": "zotero"})
    assert opts.citation_mode == "zotero"


def test_zotero_citation_mode_converts():
    docx, _ = service.convert(MAIN, service.ConvertOptions(citation_mode="zotero"))
    assert docx[:2] == b"PK"


def test_csl_style_applied_on_project():
    files = {"main.tex": MAIN, "refs.bib": BIB, "num.csl": CSL}
    opts = service.ConvertOptions(csl="num.csl")
    docx, report = service.convert_project(files, "main.tex", opts)
    assert docx[:2] == b"PK"
    # csl threaded through cleanly (no engine error)
    assert isinstance(report["coverage"], float)


def test_csl_ignored_when_not_a_project_file():
    # a csl path that isn't in the project is simply ignored (no crash)
    docx, _ = service.convert_project(
        {"main.tex": MAIN, "refs.bib": BIB}, "main.tex",
        service.ConvertOptions(csl="missing.csl"),
    )
    assert docx[:2] == b"PK"


def test_preview_accepts_citation_options(client):
    pid = client.post("/api/projects", json={
        "name": "Cite", "files": {"main.tex": MAIN, "refs.bib": BIB, "num.csl": CSL},
    }).json()["id"]
    try:
        r = client.post(f"/api/projects/{pid}/preview",
                        json={"options": {"citation_mode": "static", "csl": "num.csl"}})
        assert r.status_code == 200, r.text
        c = client.post(f"/api/projects/{pid}/convert",
                        json={"options": {"citation_mode": "zotero"}})
        assert c.status_code == 200
    finally:
        client.delete(f"/api/projects/{pid}")
