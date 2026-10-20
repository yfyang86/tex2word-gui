"""The embedded TikZ editor: availability report and the CSP its pages get."""

import json

from fastapi.testclient import TestClient

from app import tikzeditor
from app.main import app

client = TestClient(app)


def test_info_reports_a_missing_bundle(tmp_path):
    info = tikzeditor.info(tmp_path)
    assert info["available"] is False
    assert info["url"] == "/static/vendor/tikz-editor/index.html"
    assert info["version"] is None


def test_info_reads_the_build_record(tmp_path):
    root = tikzeditor.bundle_dir(tmp_path)
    root.mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html>")
    (root / "BUILD.json").write_text(json.dumps({"version": "0.6.0", "ref": "abc123"}))
    info = tikzeditor.info(tmp_path)
    assert (info["available"], info["version"], info["ref"]) == (True, "0.6.0", "abc123")


def test_info_tolerates_a_broken_build_record(tmp_path):
    root = tikzeditor.bundle_dir(tmp_path)
    root.mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html>")
    (root / "BUILD.json").write_text("{not json")
    info = tikzeditor.info(tmp_path)
    assert info["available"] is True and info["version"] is None


def test_config_exposes_the_tool():
    tool = client.get("/api/config").json()["tools"]["tikz_editor"]
    assert set(tool) >= {"available", "url", "version"}
    assert tool["upstream"] == "https://github.com/DominikPeters/tikz-editor"


def test_bundle_pages_get_a_strict_csp():
    # whether or not the bundle is built, anything under its prefix carries the policy
    r = client.get("/static/vendor/tikz-editor/index.html")
    csp = r.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]
    assert "object-src 'none'" in csp and "frame-ancestors 'self'" in csp
    assert r.headers["x-content-type-options"] == "nosniff"


def test_other_pages_are_unaffected():
    assert "content-security-policy" not in client.get("/static/app.js").headers
    assert "content-security-policy" not in client.get("/").headers
