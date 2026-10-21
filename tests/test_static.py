"""The page shell: favicon, and cache headers that let new releases show up."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_favicon_is_a_real_icon():
    r = client.get("/favicon.ico")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/x-icon"
    assert r.content[:4] == b"\x00\x00\x01\x00"          # ICO header
    assert int.from_bytes(r.content[4:6], "little") >= 2   # several sizes


def test_svg_icon_and_page_links():
    assert client.get("/static/favicon.svg").headers["content-type"].startswith("image/svg+xml")
    page = client.get("/").text
    assert 'rel="icon" href="/favicon.ico"' in page
    assert 'href="/static/favicon.svg" type="image/svg+xml"' in page


def test_page_and_assets_are_revalidated():
    for path in ("/", "/static/app.js", "/static/tokens.css", "/static/theme.js", "/favicon.ico"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert r.headers["cache-control"] == "no-cache", path
        assert r.headers.get("etag") or path == "/", path   # static files revalidate by ETag


def test_api_and_errors_get_no_cache_header():
    assert "cache-control" not in client.get("/api/health").headers
    assert "cache-control" not in client.get("/static/missing.js").headers
