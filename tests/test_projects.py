import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.db import Database
from app.main import app
from app.projects import ProjectError, ProjectStore

MAIN = r"""\documentclass{article}
\begin{document}
\section{Intro}
Hello $E=mc^2$.
\input{sections/method.tex}
\end{document}
"""
METHOD = r"\section{Method}From the included file $y=x^2$."


@pytest.fixture
def store(tmp_path):
    return ProjectStore(Database(str(tmp_path / "p.db")))


@pytest.fixture
def client():
    return TestClient(app)


# -- store ------------------------------------------------------------------
def test_create_and_get(store):
    p = store.create("Paper", files={"main.tex": MAIN})
    assert p.name == "Paper" and p.kind == "tex" and p.file_count == 1
    got = store.get(p.id)
    assert got is not None
    assert got.file_map()["main.tex"] == MAIN


def test_create_rejects_bad_kind(store):
    with pytest.raises(ProjectError):
        store.create("X", kind="pdf")


def test_put_and_delete_file_touch_project(store):
    p = store.create("P", files={"main.tex": MAIN})
    before = store.get(p.id).updated_at
    f = store.put_file(p.id, "sections/method.tex", METHOD)
    assert f.path == "sections/method.tex"
    reloaded = store.get(p.id)
    assert reloaded.file_count == 2
    assert reloaded.updated_at >= before
    assert store.delete_file(p.id, "sections/method.tex") is True
    assert store.get(p.id).file_count == 1


def test_delete_cascades_files(store):
    p = store.create("P", files={"main.tex": MAIN, "a.tex": "x"})
    assert store.delete(p.id) is True
    assert store.get(p.id) is None
    # files gone too (no orphan rows)
    rows = store.db.conn.execute(
        "SELECT COUNT(*) AS n FROM files WHERE project_id = ?", (p.id,)
    ).fetchone()
    assert rows["n"] == 0


def test_persistence_across_reopen(tmp_path):
    path = str(tmp_path / "persist.db")
    s1 = ProjectStore(Database(path))
    pid = s1.create("Keeps", files={"main.tex": MAIN}).id
    s1.db.close()
    # reopen a fresh store on the same file
    s2 = ProjectStore(Database(path))
    again = s2.get(pid)
    assert again is not None and again.name == "Keeps"


# -- multi-file conversion --------------------------------------------------
def test_convert_project_resolves_input(store):
    from app import service

    p = store.create(
        "Multi", files={"main.tex": MAIN, "sections/method.tex": METHOD}
    )
    docx, report = service.convert_project(
        p.file_map(), p.main_path, service.ConvertOptions()
    )
    assert docx[:2] == b"PK"
    with zipfile.ZipFile(io.BytesIO(docx)) as zf:
        assert "word/document.xml" in zf.namelist()
    # round-trip should show content from both files
    latex = service.recover_latex(docx)
    assert "Intro" in latex and "Method" in latex


def test_convert_project_missing_main(store):
    from app import service

    with pytest.raises(service.ConversionError):
        service.convert_project({"a.tex": "x"}, "main.tex", service.ConvertOptions())


# -- API --------------------------------------------------------------------
def test_project_api_roundtrip(client):
    # create
    r = client.post(
        "/api/projects",
        json={"name": "API Paper", "files": {"main.tex": MAIN}},
    )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]

    # list shows it
    assert any(p["id"] == pid for p in client.get("/api/projects").json())

    # add the included file
    r = client.put(
        f"/api/projects/{pid}/files/sections/method.tex",
        json={"content": METHOD},
    )
    assert r.status_code == 200
    detail = client.get(f"/api/projects/{pid}").json()
    assert detail["file_count"] == 2

    # convert resolves \input
    r = client.post(f"/api/projects/{pid}/convert", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["report"]["math"]["omml"] >= 1
    dl = client.get(body["download_url"])
    assert dl.status_code == 200 and dl.content[:2] == b"PK"

    # delete
    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_main_path_override_selects_render_root(client):
    # a project with two standalone main files (the "multiple mains" case)
    a = r"\documentclass{article}\begin{document}\section{Alpha}A.\end{document}"
    b = r"\documentclass{article}\begin{document}\section{Beta}B.\end{document}"
    pid = client.post("/api/projects", json={
        "name": "Two", "main_path": "a.tex", "files": {"a.tex": a, "b.tex": b},
    }).json()["id"]
    try:
        # default → detected main (a.tex) → Alpha
        d0 = client.post(f"/api/projects/{pid}/preview", json={}).json()
        assert any(o["text"] == "Alpha" for o in d0["outline"])
        # override → b.tex → Beta
        d1 = client.post(f"/api/projects/{pid}/preview", json={"main_path": "b.tex"}).json()
        assert any(o["text"] == "Beta" for o in d1["outline"])
        # convert honours the override too
        conv = client.post(f"/api/projects/{pid}/convert", json={"main_path": "b.tex"})
        assert conv.status_code == 200
        # unknown override falls back to the detected main (no error)
        d2 = client.post(f"/api/projects/{pid}/preview", json={"main_path": "ghost.tex"}).json()
        assert any(o["text"] == "Alpha" for o in d2["outline"])
    finally:
        client.delete(f"/api/projects/{pid}")


# -- gallery: favourite / archive / rename ----------------------------------
def test_update_favourite_and_archive(store):
    p = store.create("P", files={"main.tex": MAIN})
    assert p.favourite is False and p.archived is False
    fav = store.update(p.id, favourite=True)
    assert fav.favourite is True and fav.archived is False
    arch = store.update(p.id, archived=True)
    assert arch.favourite is True and arch.archived is True
    # flags survive a reload
    again = store.get(p.id)
    assert again.favourite is True and again.archived is True


def test_rename_via_update(store):
    p = store.create("Old name", files={"main.tex": MAIN})
    renamed = store.update(p.id, name="New name")
    assert renamed.name == "New name"
    assert store.get(p.id).name == "New name"


def test_patch_endpoint_toggles_flags(client):
    pid = client.post(
        "/api/projects", json={"name": "Gal", "files": {"main.tex": MAIN}}
    ).json()["id"]
    try:
        r = client.patch(f"/api/projects/{pid}", json={"favourite": True})
        assert r.status_code == 200 and r.json()["favourite"] is True
        r = client.patch(
            f"/api/projects/{pid}", json={"archived": True, "name": "Gal 2"}
        )
        body = r.json()
        assert body["archived"] is True and body["name"] == "Gal 2"
        # list reflects the flags
        row = next(p for p in client.get("/api/projects").json() if p["id"] == pid)
        assert row["archived"] is True and row["favourite"] is True
    finally:
        client.delete(f"/api/projects/{pid}")


def test_patch_unknown_project_404(client):
    assert client.patch("/api/projects/nope", json={"name": "x"}).status_code == 404


def test_get_unknown_project_404(client):
    assert client.get("/api/projects/nope").status_code == 404


def test_convert_unknown_project_404(client):
    assert client.post("/api/projects/nope/convert", json={}).status_code == 404


def test_put_file_unknown_project_404(client):
    r = client.put("/api/projects/nope/files/a.tex", json={"content": "x"})
    assert r.status_code == 404
