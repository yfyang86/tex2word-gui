import pytest
from fastapi.testclient import TestClient

from app import service
from app.db import Database
from app.main import app
from app.projects import ProjectStore

DOC = r"\documentclass{article}\begin{document}\section{X}Body $E=mc^2$.\end{document}"


@pytest.fixture
def client():
    return TestClient(app)


def test_settings_roundtrip_store(tmp_path):
    s = ProjectStore(Database(str(tmp_path / "p.db")))
    p = s.create("P", files={"main.tex": DOC})
    assert p.settings == {}
    s.set_settings(p.id, {"citation_mode": "zotero", "columns": 2})
    got = s.get(p.id)
    assert got.settings == {"citation_mode": "zotero", "columns": 2}
    assert got.detail()["settings"]["citation_mode"] == "zotero"


def test_settings_endpoint(client):
    pid = client.post("/api/projects", json={"name": "S", "files": {"main.tex": DOC}}).json()["id"]
    try:
        r = client.put(f"/api/projects/{pid}/settings",
                       json={"settings": {"number_by_section": True, "math_image_fallback": True}})
        assert r.status_code == 200, r.text
        assert r.json()["settings"]["number_by_section"] is True
        # persisted: a fresh GET reflects it
        assert client.get(f"/api/projects/{pid}").json()["settings"]["math_image_fallback"] is True
    finally:
        client.delete(f"/api/projects/{pid}")


def test_settings_unknown_project_404(client):
    assert client.put("/api/projects/nope/settings", json={"settings": {}}).status_code == 404


def test_math_image_fallback_option():
    opts = service.ConvertOptions.from_payload({"math_image_fallback": True})
    assert opts.math_image_fallback is True
    docx, _ = service.convert(DOC, opts)   # converts even without a rasteriser
    assert docx[:2] == b"PK"


def test_reference_doc_applied():
    # any tex2word .docx works as a style template
    template = service.convert(
        r"\documentclass{article}\begin{document}\section{T}t\end{document}",
        service.ConvertOptions(),
    )[0]
    docx, _ = service.convert_project(
        {"main.tex": DOC}, "main.tex",
        service.ConvertOptions(reference_doc="tmpl.docx"),
        {"tmpl.docx": template},
    )
    assert docx[:2] == b"PK"


def test_reference_doc_ignored_when_absent():
    # a reference_doc not among the project's assets is simply ignored
    docx, _ = service.convert_project(
        {"main.tex": DOC}, "main.tex",
        service.ConvertOptions(reference_doc="missing.docx"),
    )
    assert docx[:2] == b"PK"
