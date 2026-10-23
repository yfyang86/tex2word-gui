"""Offline stand-in for the reference manager's online lookups in the e2e
server (tests/e2e/harness.js swaps it in): recorded replies from
tests/fixtures/bib, so the browser tests never reach the real services."""

from pathlib import Path

FIX = Path(__file__).resolve().parent.parent / "fixtures" / "bib"


def http(url: str, headers: dict, timeout: float) -> tuple[int, str]:
    read = lambda name: (FIX / name).read_text()
    if "api.crossref.org/works/10.1038" in url:
        return 200, read("crossref_doi.json")
    if "api.crossref.org/works/" in url:
        return 404, "Resource not found."
    if "api.crossref.org/works?" in url:
        return 200, read("crossref_search.json")
    if "doi.org/" in url:
        return 200, read("doi.bib")
    if "export.arxiv.org" in url:
        return 200, read("arxiv_id.xml" if "id_list" in url else "arxiv_search.xml")
    if "openlibrary.org" in url:
        return 200, read("openlibrary.json")
    if "dblp.org" in url:
        return 200, read("dblp.json")
    if "semanticscholar" in url:
        return 200, read("semanticscholar.json")
    if "openalex" in url:
        return 200, read("openalex.json")
    return 503, ""
