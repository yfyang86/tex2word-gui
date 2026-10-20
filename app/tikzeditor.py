"""The embedded TikZ editor (https://github.com/DominikPeters/tikz-editor, MIT).

The editor is a prebuilt browser bundle served from
``app/static/vendor/tikz-editor/`` (built by ``scripts/build_tikz_editor.sh``;
not committed). This module reports whether it is installed and holds the
Content-Security-Policy its pages are served with.

The editor runs in an iframe on the app's own origin and renders whatever TikZ
the open project contains — imported arXiv sources included — into SVG. The
policy keeps any markup smuggled into that SVG from running script: only the
bundle's own files may execute, and nothing may be fetched from elsewhere.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

URL_PREFIX = "/static/vendor/tikz-editor/"
ENTRY = "index.html"

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'self'",
])


def bundle_dir(static_dir: Path) -> Path:
    return static_dir / "vendor" / "tikz-editor"


def info(static_dir: Path) -> dict[str, Any]:
    """Public description for /api/config: is the bundle installed, which build."""
    root = bundle_dir(static_dir)
    available = (root / ENTRY).is_file()
    version = ref = None
    if available:
        try:
            build = json.loads((root / "BUILD.json").read_text(encoding="utf-8"))
            version, ref = build.get("version"), build.get("ref")
        except (OSError, ValueError):
            pass
    return {
        "available": available,
        "url": URL_PREFIX + ENTRY,
        "version": version,
        "ref": ref,
        "upstream": "https://github.com/DominikPeters/tikz-editor",
    }


def is_bundle_path(path: str) -> bool:
    return path.startswith(URL_PREFIX)
