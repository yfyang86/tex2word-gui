from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import __version__ as app_version
from app.main import app

SAMPLE = (Path(__file__).parent / "samples" / "sample.tex").read_text()


@pytest.fixture
def client():
    return TestClient(app)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["tex2word_version"]
    assert body["app_version"] == app_version


def test_convert_then_download(client):
    r = client.post("/api/convert", json={"source": SAMPLE, "filename": "paper"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filename"] == "paper.docx"
    assert body["download_url"].startswith("/api/artifacts/")
    assert "coverage" in body["report"]

    dl = client.get(body["download_url"])
    assert dl.status_code == 200
    assert dl.content[:2] == b"PK"
    assert "attachment" in dl.headers["content-disposition"]
    assert "paper.docx" in dl.headers["content-disposition"]


def test_convert_empty_source_is_422(client):
    r = client.post("/api/convert", json={"source": "   "})
    assert r.status_code == 422


def test_convert_bad_columns_is_422(client):
    # pydantic bounds (1..4) reject this before reaching the engine
    r = client.post(
        "/api/convert", json={"source": SAMPLE, "options": {"columns": 99}}
    )
    assert r.status_code == 422


def test_download_missing_artifact_is_404(client):
    assert client.get("/api/artifacts/deadbeef").status_code == 404


def test_to_latex_roundtrip(client):
    conv = client.post("/api/convert", json={"source": SAMPLE})
    docx = client.get(conv.json()["download_url"]).content

    r = client.post(
        "/api/to-latex",
        files={
            "file": (
                "paper.docx",
                docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert r.status_code == 200, r.text
    assert "Intro" in r.json()["latex"]


def test_to_latex_rejects_garbage(client):
    r = client.post(
        "/api/to-latex",
        files={"file": ("junk.docx", b"not a zip", "application/octet-stream")},
    )
    assert r.status_code == 422


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Tex Word Studio" in r.text
