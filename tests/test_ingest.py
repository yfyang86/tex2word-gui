import io
import tarfile

import pytest
from fastapi.testclient import TestClient

from app import ingest, service
from app.main import app

MD = """# My Paper

Intro with **bold**, *italic*, `code`, inline math $E=mc^2$, and a [link](http://x).

## Method
- one
- two

$$
\\int_0^1 x^2\\,dx = \\tfrac{1}{3}
$$

| a | b |
|:--|--:|
| 1 | 2 |
"""


@pytest.fixture
def client():
    return TestClient(app)


def _make_tar(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _make_zip(files: dict[str, str]) -> bytes:
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


# ── Markdown → LaTeX ───────────────────────────────────────────────────────
def test_markdown_to_latex_constructs():
    tex = ingest.markdown_to_latex(MD, title="My Paper")
    assert "\\documentclass" in tex and "\\begin{document}" in tex
    assert "\\subsection{Method}" in tex   # level-2 heading
    assert "\\textbf{bold}" in tex and "\\textit{italic}" in tex
    assert "\\texttt{code}" in tex
    assert "$E=mc^2$" in tex              # inline math preserved verbatim
    assert "\\begin{equation}" in tex and "\\int_0^1" in tex
    assert "\\begin{itemize}" in tex
    assert "\\href{http://x}{link}" in tex
    assert "\\begin{tabular}" in tex


def test_markdown_output_converts_through_tex2word():
    # the generated LaTeX must be valid enough for the engine to produce a docx
    tex = ingest.markdown_to_latex(MD, title="My Paper")
    docx, report = service.convert(tex, service.ConvertOptions())
    assert docx[:2] == b"PK"
    assert report["math"]["omml"] >= 1


def test_from_markdown_keeps_source():
    files = ingest.from_markdown("Doc", "# Hi\n\nText $x^2$.")
    assert set(files) == {"main.tex", "source.md"}
    assert files["source.md"].startswith("# Hi")
    assert "\\section{Hi}" in files["main.tex"]


def test_from_markdown_rejects_empty():
    with pytest.raises(ingest.IngestError):
        ingest.from_markdown("x", "   ")


# ── arXiv ──────────────────────────────────────────────────────────────────
def test_normalize_arxiv_id():
    assert ingest.normalize_arxiv_id("arXiv:2406.10817") == "2406.10817"
    assert ingest.normalize_arxiv_id("2406.10817v2") == "2406.10817v2"
    assert ingest.normalize_arxiv_id("math/0211159") == "math/0211159"
    with pytest.raises(ingest.IngestError):
        ingest.normalize_arxiv_id("not-an-id")


def test_arxiv_to_files_and_pick_main():
    tar = _make_tar({
        "intro.tex": "\\section{Intro}",
        "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}",
        "refs.bib": "@article{a,title={T}}",
        "logo.png": "BINARYDATA",  # ignored (not a text ext)
    })
    files = ingest.arxiv_to_files(tar)
    assert set(files) == {"intro.tex", "main.tex", "refs.bib"}
    assert ingest.pick_main(files) == "main.tex"


def test_from_arxiv_with_injected_fetch():
    tar = _make_tar({"main.tex": "\\documentclass{article}\\begin{document}hi\\end{document}"})
    aid, files, assets, main = ingest.from_arxiv("2406.10817", fetch=lambda _id: tar)
    assert aid == "2406.10817" and main == "main.tex" and "main.tex" in files
    assert assets == {}


def test_archive_to_project_keeps_assets():
    png = b"\x89PNG\r\n\x1a\nFAKE-IMAGE-BYTES"
    data = _make_zip({"p/main.tex": DOCCLASS, "p/figures/fig.png": png})
    text, assets = ingest.archive_to_project(data)
    assert set(text) == {"main.tex"}
    assert assets["figures/fig.png"] == png    # bytes preserved
    name, t, a, main = ingest.from_archive(None, "p.zip", data)
    assert main == "main.tex" and a["figures/fig.png"] == png


# ── endpoints ──────────────────────────────────────────────────────────────
def test_import_markdown_endpoint(client):
    r = client.post("/api/projects/import/markdown", json={"name": "MD Paper", "markdown": MD})
    assert r.status_code == 201, r.text
    body = r.json()
    pid = body["id"]
    assert body["kind"] == "markdown" and body["file_count"] == 2
    # the imported project converts end-to-end
    conv = client.post(f"/api/projects/{pid}/convert", json={})
    assert conv.status_code == 200, conv.text
    client.delete(f"/api/projects/{pid}")


def test_markdown_to_tex_endpoint(client):
    r = client.post("/api/markdown/to-tex",
                    json={"markdown": "# Intro\n\nSome **bold** and $E=mc^2$.", "title": "intro"})
    assert r.status_code == 200, r.text
    latex = r.json()["latex"]
    assert "\\documentclass" in latex and "Intro" in latex
    # empty markdown is a clean 422
    assert client.post("/api/markdown/to-tex", json={"markdown": "   "}).status_code == 422


def test_import_arxiv_endpoint(client, monkeypatch):
    tar = _make_tar({"main.tex": "\\documentclass{article}\\begin{document}\\section{Hi}x\\end{document}"})
    monkeypatch.setattr(ingest, "_default_fetch", lambda _id, max_bytes=None: tar)
    r = client.post("/api/projects/import/arxiv", json={"arxiv_id": "arXiv:2406.10817"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "arxiv" and body["name"] == "arXiv:2406.10817"
    client.delete(f"/api/projects/{body['id']}")


# ── archive upload ─────────────────────────────────────────────────────────
DOCCLASS = "\\documentclass{article}\\begin{document}\\section{Hi}x\\end{document}"


def test_archive_to_files_zip_strips_common_prefix():
    data = _make_zip({
        "paper/main.tex": DOCCLASS,
        "paper/sections/intro.tex": "\\section{Intro}",
        "paper/refs.bib": "@a{b}",
        "paper/figure.png": "BINARY",   # non-text, ignored
    })
    files = ingest.archive_to_files(data)
    assert set(files) == {"main.tex", "sections/intro.tex", "refs.bib"}
    assert ingest.pick_main(files) == "main.tex"


def test_archive_to_files_zip_traversal_sanitised():
    data = _make_zip({"../evil.tex": DOCCLASS, "main.tex": DOCCLASS})
    files = ingest.archive_to_files(data)
    assert "main.tex" in files
    assert not any(p.startswith("..") for p in files)


def test_archive_to_files_tar():
    files = ingest.archive_to_files(_make_tar({"main.tex": DOCCLASS, "r.bib": "@a{b}"}))
    assert set(files) == {"main.tex", "r.bib"}


def test_archive_to_files_garbage_raises():
    with pytest.raises(ingest.IngestError):
        ingest.archive_to_files(b"not an archive")


def test_from_archive_name_from_filename():
    name, files, assets, main = ingest.from_archive(None, "My-Paper.tar.gz", _make_tar({"main.tex": DOCCLASS}))
    assert name == "My-Paper" and main == "main.tex"


def test_import_archive_endpoint(client):
    data = _make_zip({"proj/main.tex": DOCCLASS, "proj/intro.tex": "\\section{I}"})
    r = client.post(
        "/api/projects/import/archive",
        files={"file": ("proj.zip", data, "application/zip")},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "tex" and body["name"] == "proj"
    assert body["file_count"] == 2 and body["main_path"] == "main.tex"
    # the imported project converts end-to-end
    assert client.post(f"/api/projects/{body['id']}/convert", json={}).status_code == 200
    client.delete(f"/api/projects/{body['id']}")


def test_import_archive_no_tex_422(client):
    data = _make_zip({"readme.txt": "hello"})
    r = client.post(
        "/api/projects/import/archive",
        files={"file": ("x.zip", data, "application/zip")},
    )
    assert r.status_code == 422


def test_import_arxiv_bad_id_422(client):
    r = client.post("/api/projects/import/arxiv", json={"arxiv_id": "garbage"})
    assert r.status_code == 422


def test_import_arxiv_fetch_failure_502(client, monkeypatch):
    def boom(_id, max_bytes=None):
        raise OSError("network unreachable")
    monkeypatch.setattr(ingest, "_default_fetch", boom)
    r = client.post("/api/projects/import/arxiv", json={"arxiv_id": "2406.10817"})
    assert r.status_code == 502


# ── import size limits ([import].max_archive_mb / max_archive_files) ──────────
def test_default_limit_is_100_mb():
    assert ingest.DEFAULT_MAX_BYTES == 100 * 1024 * 1024
    from app.config import ImportConfig
    assert ImportConfig().max_archive_mb == 100 and ImportConfig().max_archive_bytes == ingest.DEFAULT_MAX_BYTES


def test_size_formatting():
    assert ingest._mb(100 * 1024 * 1024) == "100 MB"
    assert ingest._mb(int(1.5 * 1024 * 1024)) == "1.5 MB"
    assert ingest._mb(200_000) == "195 KB"


def test_archive_over_the_limit_is_rejected():
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("main.tex", DOCCLASS)
        zf.writestr("big.tex", "x" * 50_000)  # deflates to a few hundred bytes
    data = buf.getvalue()
    assert len(data) < 2000
    with pytest.raises(ingest.IngestTooLarge, match="max_archive_mb"):
        ingest.archive_to_project(data, max_bytes=len(data) - 1)  # the archive itself
    with pytest.raises(ingest.IngestTooLarge, match="extracted"):
        ingest.archive_to_project(data, max_bytes=len(data) + 100)  # ~50 KB of members
    text, _ = ingest.archive_to_project(data, max_bytes=1024 * 1024)
    assert "big.tex" in text


def test_tar_and_single_gzip_respect_the_limit():
    import gzip
    tar = _make_tar({"main.tex": DOCCLASS + "y" * 4000})
    with pytest.raises(ingest.IngestTooLarge):
        ingest.archive_to_project(tar, max_bytes=len(tar) + 10)
    gz = gzip.compress((DOCCLASS + "z" * 100_000).encode())  # compresses to ~1 KB
    with pytest.raises(ingest.IngestTooLarge, match="extracted"):
        ingest.archive_to_project(gz, max_bytes=50_000)
    assert "main.tex" in ingest.archive_to_project(gz, max_bytes=200_000)[0]


def test_file_count_limit():
    data = _make_zip({"main.tex": DOCCLASS, **{f"s{i}.tex": "x" for i in range(5)}})
    with pytest.raises(ingest.IngestTooLarge, match="max_archive_files"):
        ingest.archive_to_project(data, max_files=3)
    assert len(ingest.archive_to_project(data, max_files=6)[0]) == 6


def test_from_arxiv_checks_the_download_size():
    tar = _make_tar({"main.tex": DOCCLASS})
    with pytest.raises(ingest.IngestTooLarge, match="arXiv:2406.10817"):
        ingest.from_arxiv("2406.10817", fetch=lambda _id: tar, max_bytes=len(tar) - 1)


def test_default_fetch_streams_with_a_cap(monkeypatch):
    import urllib.request

    class Resp(io.BytesIO):
        def __init__(self, body, length):
            super().__init__(body)
            self.headers = {"Content-Length": length} if length else {}
        def __enter__(self): return self
        def __exit__(self, *a): self.close()

    reads = []
    def fake_open(body, length):
        def opener(req, timeout=None):
            r = Resp(body, length)
            orig = r.read
            r.read = lambda n=-1: reads.append(n) or orig(n)
            return r
        return opener

    # declared too large → refused before reading the body
    monkeypatch.setattr(urllib.request, "urlopen", fake_open(b"x" * 10, "999999"))
    with pytest.raises(ingest.IngestTooLarge):
        ingest._default_fetch("2406.10817", max_bytes=1000)
    assert reads == []
    # no Content-Length: reads at most limit+1 bytes, then refuses
    monkeypatch.setattr(urllib.request, "urlopen", fake_open(b"x" * 5000, None))
    with pytest.raises(ingest.IngestTooLarge):
        ingest._default_fetch("2406.10817", max_bytes=1000)
    assert reads == [1001]
    monkeypatch.setattr(urllib.request, "urlopen", fake_open(b"ok", "2"))
    assert ingest._default_fetch("2406.10817", max_bytes=1000) == b"ok"


def test_import_endpoints_use_the_configured_limit_and_413(client, monkeypatch):
    import app.main as m
    tar = _make_tar({"main.tex": DOCCLASS + "w" * 3000})
    monkeypatch.setattr(ingest, "_default_fetch", lambda _id, max_bytes=None: tar)
    monkeypatch.setattr(m.config.imports, "max_archive_mb", 0)  # 0 MB: everything is too large
    r = client.post("/api/projects/import/arxiv", json={"arxiv_id": "2406.10817"})
    assert r.status_code == 413 and "max_archive_mb" in r.json()["detail"]
    files = {"file": ("p.tar", tar, "application/x-tar")}
    r = client.post("/api/projects/import/archive", files=files)
    assert r.status_code == 413
    monkeypatch.setattr(m.config.imports, "max_archive_mb", 100)
    r = client.post("/api/projects/import/arxiv", json={"arxiv_id": "2406.10817"})
    assert r.status_code == 201
    client.delete(f"/api/projects/{r.json()['id']}")


def test_archive_upload_may_exceed_the_general_body_cap(client, monkeypatch):
    import app.main as m
    tar = _make_tar({"main.tex": DOCCLASS})
    monkeypatch.setattr(m.config.security, "max_body_mb", 0)   # generic cap: nothing fits
    monkeypatch.setattr(m.config.imports, "max_archive_mb", 100)
    files = {"file": ("p.tar", tar, "application/x-tar")}
    r = client.post("/api/projects/import/archive", files=files)
    assert r.status_code == 201, r.text
    client.delete(f"/api/projects/{r.json()['id']}")
    # other routes still get the generic cap
    assert client.post("/api/preview", json={"source": "x"}).status_code == 413
