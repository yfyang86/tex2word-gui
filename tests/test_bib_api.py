"""The reference manager API: reading a project's bibliography, entry CRUD,
import, cleanup, keys, merge, and online lookups (served from recorded
replies — no network)."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import bib_api
from app.bibfetch import Fetcher
from app.config import BibliographyConfig
from app.main import app

FIX = Path(__file__).parent / "fixtures" / "bib"

MAIN = ("\\documentclass{article}\n\\begin{document}\nDeep nets \\cite{lecun2015} and \\citep{vaswani,ghost}.\n"
        "\\bibliography{refs}\n\\end{document}\n")
REFS = """@article{lecun2015,
  author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  title = {Deep learning},
  journal = {Nature},
  year = {2015},
  pages = {436-444},
}

@misc{vaswani,
  author = {Vaswani, Ashish and Shazeer, Noam},
  title = {Attention Is All You Need},
  year = {2017},
  eprint = {1706.03762},
  archiveprefix = {arXiv},
}

@book{unused1984, author = {Knuth, Donald}, title = {The {\\TeX}book}, year = {1984}}
"""


def fake_http(calls):
    def get(url, headers, timeout):
        calls.append(url)
        if "api.crossref.org/works/10.1038" in url:
            return 200, (FIX / "crossref_doi.json").read_text()
        if "api.crossref.org/works/" in url:
            return 404, "Resource not found."
        if "api.crossref.org/works?" in url:
            return 200, (FIX / "crossref_search.json").read_text()
        if "doi.org/" in url:
            return 200, (FIX / "doi.bib").read_text()
        if "export.arxiv.org" in url:
            return 200, (FIX / "arxiv_id.xml" if "id_list" in url else FIX / "arxiv_search.xml").read_text()
        if "openlibrary.org" in url:
            return 200, (FIX / "openlibrary.json").read_text()
        if "dblp.org" in url:
            return 200, "<!doctype html><title>Making sure you're not a bot!</title>"
        if "semanticscholar" in url:
            return 429, '{"message": "Too Many Requests"}'
        return 500, ""
    return get


@pytest.fixture
def client():
    calls: list[str] = []
    saved = bib_api.deps.fetcher
    bib_api.deps.fetcher = Fetcher(BibliographyConfig(), http=fake_http(calls))
    c = TestClient(app)
    c.calls = calls
    yield c
    bib_api.deps.fetcher = saved


def _project(client, files=None):
    return client.post("/api/projects", json={"name": "Bib", "main_path": "main.tex",
                                              "files": files or {"main.tex": MAIN, "refs.bib": REFS}}).json()


def _file(client, pid, path):
    return {f["path"]: f["content"] for f in client.get(f"/api/projects/{pid}").json()["files"]}[path]


def test_read_bibliography_with_citations(client):
    p = _project(client)
    r = client.get(f"/api/projects/{p['id']}/bib").json()
    assert r["file"] == "refs.bib" and r["files"] == [{"path": "refs.bib", "used": True, "entries": 3}]
    by = {e["key"]: e for e in r["entries"]}
    assert by["lecun2015"]["display"] == {"authors": "LeCun et al.", "author_list": "LeCun, Bengio, Hinton",
                                          "title": "Deep learning", "year": "2015", "venue": "Nature"}
    assert by["lecun2015"]["cited"] == 1 and by["vaswani"]["links"]["arxiv"] == "https://arxiv.org/abs/1706.03762"
    assert [p_["code"] for p_ in by["lecun2015"]["problems"]] == ["page_range"]
    assert by["lecun2015"]["source"].startswith("@article{lecun2015,")
    assert r["missing"] == [{"key": "ghost", "uses": [{"file": "main.tex", "line": 3}]}]
    assert r["unused"] == ["unused1984"] and r["prefs"]["key_pattern"] == "[auth][year]"
    empty = _project(client, {"main.tex": MAIN})
    assert client.get(f"/api/projects/{empty['id']}/bib").json()["file"] is None


def test_entry_crud_and_key_rename_follows_citations(client):
    p = _project(client)
    pid = p["id"]
    r = client.post(f"/api/projects/{pid}/bib/entries", json={
        "file": "refs.bib", "type": "article",
        "fields": {"author": "Hinton, Geoffrey and Salakhutdinov, Ruslan", "title": "Reducing the Dimensionality of Data",
                   "journal": "Science", "year": "2006"}})
    assert r.status_code == 201 and r.json()["key"] == "Hinton2006"
    assert "@article{Hinton2006," in _file(client, pid, "refs.bib")
    # the same work again → 409 with the duplicate named
    r = client.post(f"/api/projects/{pid}/bib/entries", json={
        "file": "refs.bib", "type": "article", "key": "dup", "fields": {"title": "Deep Learning.", "year": "2015"}})
    assert r.status_code == 409 and r.json()["detail"]["duplicates"][0]["key"] == "lecun2015"
    assert client.post(f"/api/projects/{pid}/bib/entries", json={
        "file": "refs.bib", "key": "lecun2015", "fields": {"title": "x"}}).status_code == 409
    # edit + rename: \cite{lecun2015} in main.tex follows
    r = client.put(f"/api/projects/{pid}/bib/entries/lecun2015", json={
        "file": "refs.bib", "type": "article", "key": "LeCun2015",
        "fields": {"author": "LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey", "title": "Deep learning",
                   "journal": "Nature", "year": "2015", "pages": "436--444", "volume": "521"}}).json()
    assert r["key"] == "LeCun2015" and "\\cite{LeCun2015}" in r["changed_files"]["main.tex"]
    assert "\\cite{LeCun2015}" in _file(client, pid, "main.tex")
    refs = _file(client, pid, "refs.bib")
    assert "pages = {436--444}," in refs and refs.endswith("\n") and "@misc{vaswani," in refs
    assert client.put(f"/api/projects/{pid}/bib/entries/vaswani", json={
        "file": "refs.bib", "key": "LeCun2015", "fields": {"title": "x"}}).status_code == 409
    bad = client.put(f"/api/projects/{pid}/bib/entries/vaswani", json={"file": "refs.bib", "fields": {"title": "{x"}})
    assert bad.status_code == 422 and "title" in bad.json()["detail"]
    # raw source edit
    r = client.put(f"/api/projects/{pid}/bib/entries/vaswani/source", json={
        "file": "refs.bib", "source": "@misc{vaswani2017,\n  title = {Attention},\n}"}).json()
    assert r["key"] == "vaswani2017" and "\\citep{vaswani2017,ghost}" in _file(client, pid, "main.tex")
    assert client.put(f"/api/projects/{pid}/bib/entries/vaswani2017/source",
                      json={"file": "refs.bib", "source": "@misc{a, x={1}} @misc{b, y={2}}"}).status_code == 422
    # delete
    r = client.delete(f"/api/projects/{pid}/bib/entries/unused1984?file=refs.bib").json()
    assert "unused1984" not in r["content"]
    assert client.delete(f"/api/projects/{pid}/bib/entries/unused1984?file=refs.bib").status_code == 404
    # a new .bib file is created on the first entry; bad paths are refused
    r = client.post(f"/api/projects/{pid}/bib/entries", json={"file": "more.bib", "key": "x1", "fields": {"title": "X"}})
    assert r.status_code == 201 and _file(client, pid, "more.bib").startswith("@misc{x1,")
    assert client.post(f"/api/projects/{pid}/bib/entries",
                       json={"file": "../evil.bib", "fields": {"title": "X"}}).status_code == 422


def test_import_pasted_bibtex_and_candidates(client):
    p = _project(client)
    pid = p["id"]
    pasted = ("@article{lecun2015deep, title={Deep learning}, author={LeCun, Yann}, journal={nature}, year={2015}}\n"
              "@inproceedings{he2016deep, title={Deep residual learning for image recognition},\n"
              "  author={He, Kaiming and Zhang, Xiangyu}, booktitle={CVPR}, pages={770--778}, year={2016}}\n"
              "@article{vaswani, title={A different paper with the same key}, year={2020}}")
    r = client.post(f"/api/projects/{pid}/bib/import", json={"file": "refs.bib", "text": pasted}).json()
    assert r["added"] == ["he2016deep", "vaswania"]
    assert r["skipped"] == [{"key": "lecun2015deep", "title": "Deep learning", "duplicate_of": "lecun2015",
                             "reason": "same title"}]
    cand = client.get("/api/bib/lookup", params={"q": "10.1038/nature14539"}).json()["results"]
    r = client.post(f"/api/projects/{pid}/bib/import", json={"file": "refs.bib", "candidates": cand,
                                                             "duplicates": "add"}).json()
    assert r["added"] == ["LeCun2015a"]        # keys are case-insensitive: lecun2015 exists
    assert client.post(f"/api/projects/{pid}/bib/import", json={"file": "refs.bib"}).status_code == 422


def test_cleanup_keys_and_merge(client):
    p = _project(client)
    pid = p["id"]
    r = client.post(f"/api/projects/{pid}/bib/cleanup", json={"file": "refs.bib", "actions": ["pages"]}).json()
    assert r["changed"] == ["lecun2015"] and "pages = {436--444}" in r["content"]
    assert client.post(f"/api/projects/{pid}/bib/cleanup", json={"actions": ["nope"]}).status_code == 422
    r = client.post(f"/api/projects/{pid}/bib/keys", json={"file": "refs.bib", "pattern": "[auth:lower][shortyear]"}).json()
    assert r["renamed"] == {"lecun2015": "lecun15", "vaswani": "vaswani17", "unused1984": "knuth84"}
    main = _file(client, pid, "main.tex")
    assert "\\cite{lecun15}" in main and "\\citep{vaswani17,ghost}" in main
    # merge a duplicate into the original; its citations move over
    client.post(f"/api/projects/{pid}/bib/entries", json={
        "file": "refs.bib", "key": "lecunDup", "force": True,
        "fields": {"title": "Deep Learning", "year": "2015", "doi": "10.1038/nature14539"}})
    client.put(f"/api/projects/{pid}/files/main.tex", json={"content": main + "\\cite{lecunDup}"})
    dups = client.get(f"/api/projects/{pid}/bib").json()["duplicates"]
    assert dups == [{"keys": ["lecun15", "lecunDup"], "reason": "same title"}]
    r = client.post(f"/api/projects/{pid}/bib/merge", json={"file": "refs.bib", "keep": "lecun15", "remove": ["lecunDup"]}).json()
    assert "lecunDup" not in r["content"] and "doi = {10.1038/nature14539}" in r["content"]
    assert "\\cite{lecun15}" in _file(client, pid, "main.tex") and "lecunDup" not in _file(client, pid, "main.tex")


def test_online_lookup_search_and_fetch(client):
    r = client.get("/api/bib/lookup", params={"q": "https://doi.org/10.1038/nature14539"}).json()
    assert r["identifier"] == {"kind": "doi", "id": "10.1038/nature14539"} and r["results"][0]["source"] == "crossref"
    # a DOI Crossref doesn't know falls back to doi.org's BibTeX
    r = client.get("/api/bib/lookup", params={"q": "10.48550/arXiv.1706.03762"}).json()
    assert r["results"][0]["source"] == "doi.org"
    assert client.get("/api/bib/lookup", params={"q": "arXiv:1706.03762"}).json()["results"][0]["arxiv"] == "1706.03762"
    assert client.get("/api/bib/lookup", params={"q": "978-0-262-03561-3"}).json()["results"][0]["type"] == "book"
    assert client.get("/api/bib/lookup", params={"q": "just words"}).status_code == 422
    r = client.get("/api/bib/search", params={"q": "deep learning", "source": "crossref"}).json()
    assert len(r["results"]) == 3 and r["scholar"] == "https://scholar.google.com/scholar?q=deep+learning"
    assert len(client.get("/api/bib/search", params={"q": "attention", "source": "arxiv"}).json()["results"]) == 3
    blocked = client.get("/api/bib/search", params={"q": "attention", "source": "dblp"})
    assert blocked.status_code == 502 and "web page" in blocked.json()["detail"]
    limited = client.get("/api/bib/search", params={"q": "attention", "source": "semanticscholar"})
    assert limited.status_code == 502 and "rate-limiting" in limited.json()["detail"]
    # results are cached
    n = len(client.calls)
    client.get("/api/bib/search", params={"q": "deep learning", "source": "crossref"})
    assert len(client.calls) == n
    # fetch details for an entry by its arXiv id → a field diff
    p = _project(client)
    r = client.get(f"/api/projects/{p['id']}/bib/entries/vaswani/fetch?file=refs.bib").json()
    fields = {d["field"] for d in r["diff"]}
    assert {"primaryclass", "url", "month"} <= fields and "title" not in fields
    # sources list + switching lookups off
    s = client.get("/api/bib/sources").json()
    assert s["online"] and {x["id"] for x in s["sources"]} >= {"crossref", "arxiv", "dblp", "openlibrary"}
    assert "acronyms" in s["cleanups"] and "article" in s["types"] and s["scholar"]["url"].startswith("https://scholar")
    bib_api.deps.fetcher = Fetcher(BibliographyConfig(online=False), http=fake_http([]))
    off = client.get("/api/bib/lookup", params={"q": "10.1038/nature14539"})
    assert off.status_code == 502 and "turned off" in off.json()["detail"]


def test_prefs(client):
    r = client.put("/api/bib/prefs", json={"key_pattern": "[auth:lower][year]", "cite_command": "citep"}).json()
    assert r["key_pattern"] == "[auth:lower][year]" and r["cite_command"] == "citep"
    assert client.put("/api/bib/prefs", json={"key_pattern": "nobrackets"}).status_code == 422
    assert client.put("/api/bib/prefs", json={"cite_command": "frob"}).status_code == 422
    p = _project(client)
    r = client.post(f"/api/projects/{p['id']}/bib/entries", json={"file": "refs.bib", "fields": {
        "author": "Doe, Jane", "title": "A study", "year": "2020"}}).json()
    assert r["key"] == "doe2020"
    client.put("/api/bib/prefs", json={"key_pattern": "[auth][year]", "cite_command": "cite"})
