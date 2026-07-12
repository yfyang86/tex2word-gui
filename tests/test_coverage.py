import pytest
from fastapi.testclient import TestClient

from app import service
from app.main import app

GOOD = r"\documentclass{article}\begin{document}\section{A}Hi $E=mc^2$ \begin{equation}y=x^2\end{equation}\end{document}"


@pytest.fixture
def client():
    return TestClient(app)


def test_coverage_report_aggregates_and_marks_aborted():
    rep = service.coverage_report([
        ("g", {"main.tex": GOOD}, "main.tex"),
        ("b", {"main.tex": ""}, "main.tex"),   # empty main → aborted
    ])
    a = rep["aggregate"]
    assert a["projects"] == 2 and a["converted"] == 1 and a["aborted"] == 1
    assert a["valid"] == 1 and a["math_omml"] >= 1 and a["coverage"] == 1.0
    rows = {r["label"]: r for r in rep["rows"]}
    assert rows["b"]["aborted"] is True and "error" in rows["b"]
    assert rows["g"]["valid"] is True and rows["g"]["omml"] >= 1


def test_coverage_report_empty():
    rep = service.coverage_report([])
    assert rep["aggregate"]["projects"] == 0
    assert rep["aggregate"]["coverage"] == 1.0
    assert rep["rows"] == []


def test_coverage_endpoint(client):
    pid = client.post(
        "/api/projects", json={"name": "CovProj", "files": {"main.tex": GOOD}}
    ).json()["id"]
    try:
        r = client.get("/api/coverage")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["aggregate"]["projects"] >= 1
        row = next((x for x in data["rows"] if x["label"] == "CovProj"), None)
        assert row is not None and row["valid"] is True
    finally:
        client.delete(f"/api/projects/{pid}")


def test_coverage_html_endpoint(client):
    r = client.get("/api/coverage.html")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
