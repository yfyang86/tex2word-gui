import base64
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import service
from app.db import Database
from app.main import app
from app.projects import ProjectStore

# a real 1x1 PNG
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC"
)
FIG_TEX = (
    r"\documentclass{article}\usepackage{graphicx}\begin{document}\section{R}"
    r"\begin{figure}\centering\includegraphics{figures/fig.png}"
    r"\caption{A fig}\label{fig:r}\end{figure}\end{document}"
)


@pytest.fixture
def client():
    return TestClient(app)


# -- store ------------------------------------------------------------------
def test_store_binary_roundtrip(tmp_path):
    s = ProjectStore(Database(str(tmp_path / "p.db")))
    p = s.create("P", files={"main.tex": FIG_TEX})
    s.put_binary(p.id, "figures/fig.png", PNG)
    got = s.get(p.id)
    # the binary file is listed but carries size + flag, not content
    f = next(f for f in got.files if f.path == "figures/fig.png")
    assert f.is_binary and f.size == len(PNG) and "content" not in f.public()
    # file_map (text) excludes the asset; assets() returns the bytes
    assert "figures/fig.png" not in got.file_map()
    assert s.assets(p.id)["figures/fig.png"] == PNG
    assert s.file_bytes(p.id, "figures/fig.png") == (True, PNG)


# -- conversion embeds the image -------------------------------------------
def test_convert_project_embeds_image():
    docx, _ = service.convert_project(
        {"main.tex": FIG_TEX}, "main.tex", service.ConvertOptions(),
        {"figures/fig.png": PNG},
    )
    with zipfile.ZipFile(io.BytesIO(docx)) as zf:
        media = [n for n in zf.namelist() if n.startswith("word/media/")]
    assert media, "figure image should be embedded in the .docx"


# -- API: upload, raw serve, preview img -----------------------------------
def test_asset_upload_raw_and_preview(client):
    pid = client.post("/api/projects", json={
        "name": "Fig", "files": {"main.tex": FIG_TEX},
    }).json()["id"]
    try:
        # upload the figure
        r = client.post(
            f"/api/projects/{pid}/assets/figures/fig.png",
            files={"file": ("fig.png", PNG, "image/png")},
        )
        assert r.status_code == 201, r.text
        assert r.json()["is_binary"] is True

        # raw serve returns the exact bytes with an image content type
        raw = client.get(f"/api/projects/{pid}/files/figures/fig.png/raw")
        assert raw.status_code == 200
        assert raw.content == PNG
        assert raw.headers["content-type"].startswith("image/png")

        # convert embeds it
        conv = client.post(f"/api/projects/{pid}/convert", json={})
        assert conv.status_code == 200

        # preview renders a real <img> pointing at the raw endpoint
        prev = client.post(f"/api/projects/{pid}/preview", json={}).json()
        assert "<img" in prev["html"]
        assert f"/api/projects/{pid}/files/figures/fig.png/raw" in prev["html"]
    finally:
        client.delete(f"/api/projects/{pid}")


# -- PDF / EPS / TikZ figures (rasterised via the tex2word backend) ----------
FAKE_PDF = b"%PDF-1.4\nfake\n%%EOF\n"
TIKZ_TEX = (
    r"\documentclass{article}\usepackage{tikz}\begin{document}\section{R}"
    r"\begin{figure}\centering\begin{tikzpicture}\draw(0,0)--(1,1);\end{tikzpicture}"
    r"\caption{A tikz}\end{figure}\end{document}"
)


def _pdf_tex(path):
    return (
        r"\documentclass{article}\usepackage{graphicx}\begin{document}\section{R}"
        r"\begin{figure}\centering\includegraphics{" + path + r"}"
        r"\caption{A pdf}\end{figure}\end{document}"
    )


def _fake_rasterize(monkeypatch, png=PNG):
    # Patch the preview wrapper (not tex2word's raster, which conversion also uses).
    monkeypatch.setattr(service, "_raster_png", lambda blob, fmt, dpi: png)


def test_pdf_figure_rasterised_in_preview(client, monkeypatch):
    _fake_rasterize(monkeypatch)
    pid = client.post("/api/projects", json={
        "name": "Pdf", "files": {"main.tex": _pdf_tex("figures/diagram.pdf")},
    }).json()["id"]
    try:
        client.post(f"/api/projects/{pid}/assets/figures/diagram.pdf",
                    files={"file": ("diagram.pdf", FAKE_PDF, "application/pdf")})
        prev = client.post(f"/api/projects/{pid}/preview", json={}).json()
        assert "data:image/png;base64," in prev["html"]
        assert "fig-placeholder" not in prev["html"]
    finally:
        client.delete(f"/api/projects/{pid}")


def test_pdf_includegraphics_without_extension_resolves(client, monkeypatch):
    _fake_rasterize(monkeypatch)
    # source references the figure without an extension; asset stored as .pdf
    pid = client.post("/api/projects", json={
        "name": "Pdf2", "files": {"main.tex": _pdf_tex("figures/diagram")},
    }).json()["id"]
    try:
        client.post(f"/api/projects/{pid}/assets/figures/diagram.pdf",
                    files={"file": ("diagram.pdf", FAKE_PDF, "application/pdf")})
        prev = client.post(f"/api/projects/{pid}/preview", json={}).json()
        assert "data:image/png;base64," in prev["html"]
    finally:
        client.delete(f"/api/projects/{pid}")


def test_pdf_object_fallback_when_no_rasteriser(client, monkeypatch):
    monkeypatch.setattr(service, "_raster_png", lambda blob, fmt, dpi: None)
    pid = client.post("/api/projects", json={
        "name": "Pdf3", "files": {"main.tex": _pdf_tex("figures/diagram.pdf")},
    }).json()["id"]
    try:
        client.post(f"/api/projects/{pid}/assets/figures/diagram.pdf",
                    files={"file": ("diagram.pdf", FAKE_PDF, "application/pdf")})
        prev = client.post(f"/api/projects/{pid}/preview", json={}).json()
        # browser-native PDF embed pointing at the raw endpoint
        assert 'type="application/pdf"' in prev["html"]
        assert f"/api/projects/{pid}/files/figures/diagram.pdf/raw" in prev["html"]
    finally:
        client.delete(f"/api/projects/{pid}")


def test_tikz_figure_rasterised_in_preview(client, monkeypatch):
    monkeypatch.setattr(service, "_tikz_png", lambda src, dpi: PNG)
    pid = client.post("/api/projects", json={
        "name": "Tikz", "files": {"main.tex": TIKZ_TEX},
    }).json()["id"]
    try:
        prev = client.post(f"/api/projects/{pid}/preview", json={}).json()
        assert "data:image/png;base64," in prev["html"]
        assert "fig-placeholder" not in prev["html"]
    finally:
        client.delete(f"/api/projects/{pid}")


def test_tikz_placeholder_when_engine_unavailable(client, monkeypatch):
    monkeypatch.setattr(service, "_tikz_png", lambda src, dpi: None)
    pid = client.post("/api/projects", json={
        "name": "Tikz2", "files": {"main.tex": TIKZ_TEX},
    }).json()["id"]
    try:
        prev = client.post(f"/api/projects/{pid}/preview", json={}).json()
        assert "fig-placeholder" in prev["html"]  # graceful, no crash
    finally:
        client.delete(f"/api/projects/{pid}")


def test_import_archive_keeps_figure(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("paper/main.tex", FIG_TEX)
        zf.writestr("paper/figures/fig.png", PNG)
    r = client.post(
        "/api/projects/import/archive",
        files={"file": ("paper.zip", buf.getvalue(), "application/zip")},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    pid = body["id"]
    try:
        png_file = next(f for f in body["files"] if f["path"] == "figures/fig.png")
        assert png_file["is_binary"] is True
        raw = client.get(f"/api/projects/{pid}/files/figures/fig.png/raw")
        assert raw.content == PNG
    finally:
        client.delete(f"/api/projects/{pid}")
