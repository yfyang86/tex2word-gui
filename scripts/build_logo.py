"""Prepare and distribute the app logo from the single master ``icon.svg``.

The master artwork lives at the repository root (``icon.svg``). Every derived
logo artifact in the repo is generated from it — never edited by hand:

    app/static/favicon.svg      verbatim copy of the master (linked in index.html)
    app/static/favicon.ico      16/32/48 px PNGs in an ICO container
    assets/logo-1024.png        distribution PNGs (README, social, stores)
    assets/logo-512.png
    assets/logo-256.png

On macOS the rasterizer is the system Quick Look thumbnailer; elsewhere it
falls back to ``rsvg-convert`` or ``inkscape`` (e.g. CI: ``apt install
librsvg2-bin``). With ``--icns PATH`` the script also builds a macOS ``.icns``
(uses ``iconutil``; macOS only) — ``platform/macos/arm/build_dmg.sh`` calls
this for the app-bundle icon.

    python scripts/build_logo.py                # web + PNG artifacts
    python scripts/build_logo.py --icns OUT.icns
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "icon.svg"
FAVICON_SVG = ROOT / "app" / "static" / "favicon.svg"
FAVICON_ICO = ROOT / "app" / "static" / "favicon.ico"
ASSET_PNGS = [ROOT / "assets" / f"logo-{size}.png" for size in (1024, 512, 256)]
ICO_SIZES = (16, 32, 48)


def _run(cmd: list[str], **kw) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)


def render_qlmanage(size: int, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        _run(["qlmanage", "-t", "-s", str(size), "-o", tmp, str(MASTER)])
        shutil.move(str(Path(tmp) / (MASTER.name + ".png")), str(out))


def render_rsvg(size: int, out: Path) -> None:
    _run(["rsvg-convert", "-w", str(size), "-h", str(size), str(MASTER), "-o", str(out)])


def render_inkscape(size: int, out: Path) -> None:
    _run(["inkscape", str(MASTER), "-w", str(size), "-h", str(size), "-o", str(out)])


def pick_renderer():
    """Return (name, callable) for the first available rasterizer."""
    if sys.platform == "darwin" and shutil.which("qlmanage"):
        return "qlmanage", render_qlmanage
    if shutil.which("rsvg-convert"):
        return "rsvg-convert", render_rsvg
    if shutil.which("inkscape"):
        return "inkscape", render_inkscape
    sys.exit(
        "no SVG rasterizer found: on macOS qlmanage ships with the OS; on Linux "
        "install librsvg (apt install librsvg2-bin / brew install librsvg)"
    )


def pack_ico(pngs: list[bytes]) -> bytes:
    """Wrap PNG blobs (16/32/48) in an ICO container."""
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, blobs = b"", b""
    for png in pngs:
        size = struct.unpack(">I", png[16:20])[0]  # IHDR width == height here
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(png), offset + len(blobs))
        blobs += png
    return header + entries + blobs


def build_icns(out: Path, render) -> None:
    if sys.platform != "darwin" or not shutil.which("iconutil"):
        sys.exit("--icns needs macOS with iconutil (installed with Command Line Tools)")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            render(size, iconset / f"icon_{size}x{size}.png")
            render(size * 2, iconset / f"icon_{size}x{size}@2x.png")
        _run(["iconutil", "-c", "icns", "-o", str(out), str(iconset)])
    print(f"wrote {out} ({out.stat().st_size} bytes)")


def main() -> None:
    if not MASTER.exists():
        sys.exit(f"master artwork not found: {MASTER}")
    name, render = pick_renderer()

    shutil.copyfile(MASTER, FAVICON_SVG)
    print(f"wrote {FAVICON_SVG} (copy of {MASTER.name}, rasterizer: {name})")

    with tempfile.TemporaryDirectory() as tmp:
        pngs = []
        for size in ICO_SIZES:
            p = Path(tmp) / f"{size}.png"
            render(size, p)
            pngs.append(p.read_bytes())
    FAVICON_ICO.write_bytes(pack_ico(pngs))
    print(f"wrote {FAVICON_ICO} ({FAVICON_ICO.stat().st_size} bytes, sizes {ICO_SIZES})")

    for path in ASSET_PNGS:
        render(int(path.stem.rsplit("-", 1)[1]), path)
        print(f"wrote {path} ({path.stat().st_size} bytes)")

    if "--icns" in sys.argv:
        try:
            out = Path(sys.argv[sys.argv.index("--icns") + 1])
        except IndexError:
            sys.exit("--icns needs an output path")
        build_icns(out, render)


if __name__ == "__main__":
    main()
