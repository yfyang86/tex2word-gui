import time

import pytest
from fastapi.testclient import TestClient

from app.db import Database
from app.main import app
from app.store import ArtifactStore

DOC = r"\documentclass{article}\begin{document}\section{Intro}Hi $E=mc^2$.\end{document}"
MAIN = DOC


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def inline_jobs(monkeypatch):
    """Run queued jobs synchronously so a POST completes before it returns."""
    from app import main as m

    monkeypatch.setattr(m.job_queue, "submit", lambda fn: fn())
    return m


# -- durable artifact store --------------------------------------------------
def test_artifact_put_get_roundtrip(tmp_path):
    s = ArtifactStore(Database(str(tmp_path / "a.db")))
    aid = s.put(b"PKdata", "out.docx")
    got = s.get(aid)
    assert got is not None and got.data == b"PKdata" and got.filename == "out.docx"
    assert s.get("missing") is None


def test_artifact_survives_reopen(tmp_path):
    path = str(tmp_path / "persist.db")
    s1 = ArtifactStore(Database(path))
    aid = s1.put(b"keepme", "x.docx")
    s1.db.close()
    s2 = ArtifactStore(Database(path))          # fresh connection on the same file
    got = s2.get(aid)
    assert got is not None and got.data == b"keepme"


def test_artifact_ttl_eviction(tmp_path):
    s = ArtifactStore(Database(str(tmp_path / "ttl.db")), ttl_seconds=0.0)
    aid = s.put(b"gone", "x.docx")
    time.sleep(0.01)
    assert s.get(aid) is None                   # created_at < now-0s → swept


# -- async conversion jobs ---------------------------------------------------
def test_async_source_convert(client, inline_jobs):
    r = client.post("/api/convert/async", json={"source": DOC})
    assert r.status_code == 202, r.text
    jid = r.json()["job_id"]
    job = client.get(f"/api/jobs/{jid}").json()
    assert job["status"] == "done"
    assert job["report"]["math"]["omml"] >= 1
    dl = client.get(job["download_url"])
    assert dl.status_code == 200 and dl.content[:2] == b"PK"


def test_async_convert_records_error(client, inline_jobs):
    # empty source fails inside the worker → job carries the error, not a 500
    r = client.post("/api/convert/async", json={"source": "   "})
    assert r.status_code == 202
    job = client.get(f"/api/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "error" and "empty" in job["error"]


def test_async_project_convert(client, inline_jobs):
    pid = client.post("/api/projects", json={"name": "Async", "files": {"main.tex": MAIN}}).json()["id"]
    try:
        r = client.post(f"/api/projects/{pid}/convert/async", json={})
        assert r.status_code == 202
        job = client.get(f"/api/jobs/{r.json()['job_id']}").json()
        assert job["status"] == "done"
        assert client.get(job["download_url"]).content[:2] == b"PK"
    finally:
        client.delete(f"/api/projects/{pid}")


def test_async_unknown_project_404(client, inline_jobs):
    assert client.post("/api/projects/ghost/convert/async", json={}).status_code == 404


def test_job_not_found_404(client):
    assert client.get("/api/jobs/nope").status_code == 404


def test_async_bad_options_422(client, inline_jobs):
    # validation happens before queuing → immediate 422, no job created
    r = client.post("/api/convert/async", json={"source": DOC, "options": {"columns": 9}})
    assert r.status_code == 422


def test_real_background_queue_completes(client):
    """Without the inline fixture, the thread pool runs the job; poll briefly."""
    jid = client.post("/api/convert/async", json={"source": DOC}).json()["job_id"]
    for _ in range(50):
        job = client.get(f"/api/jobs/{jid}").json()
        if job["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    assert job["status"] == "done", job
