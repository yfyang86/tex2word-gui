"""Draw the app icon (the brand mark: a white arrow on a red rounded square)
into app/static/favicon.ico (16, 32 and 48 px PNGs in an ICO container).

Pure Python, no imaging library: each pixel's coverage is sampled on a 4×4
grid. app/static/favicon.svg is the same mark as vector art.

    python scripts/build_favicon.py
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "static" / "favicon.ico"
RED = (0xD9, 0x2B, 0x2B)
WHITE = (0xFF, 0xFF, 0xFF)
# On the 24-unit grid of the SVG: square (1,1)-(23,23) radius 6; arrow
# M4.5 12h12.5 and M12 6.5l5.5 5.5-5.5 5.5, stroke 2.6, round caps.
SEGMENTS = [((5.5, 12.0), (17.0, 12.0)), ((12.0, 6.5), (17.5, 12.0)), ((17.5, 12.0), (12.0, 17.5))]
STROKE = 2.6
SS = 4


def in_square(x: float, y: float) -> bool:
    lo, hi, r = 1.0, 23.0, 6.0
    cx = min(max(x, lo + r), hi - r)
    cy = min(max(y, lo + r), hi - r)
    return lo <= x <= hi and lo <= y <= hi and (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def seg_dist(px: float, py: float, a: tuple[float, float], b: tuple[float, float]) -> float:
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def render(size: int) -> bytes:
    rows = []
    scale = 24.0 / size
    for j in range(size):
        row = bytearray([0])  # PNG filter: none
        for i in range(size):
            sq = arrow = 0
            for sj in range(SS):
                for si in range(SS):
                    x = (i + (si + 0.5) / SS) * scale
                    y = (j + (sj + 0.5) / SS) * scale
                    if in_square(x, y):
                        sq += 1
                        if min(seg_dist(x, y, a, b) for a, b in SEGMENTS) <= STROKE / 2:
                            arrow += 1
            n = SS * SS
            alpha = sq / n
            mix = arrow / sq if sq else 0.0
            rgb = [round(RED[k] * (1 - mix) + WHITE[k] * mix) for k in range(3)]
            row += bytes(rgb + [round(alpha * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def ico(sizes: list[int]) -> bytes:
    images = [render(s) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for s, png in zip(sizes, images):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(png), offset + len(blobs))
        blobs += png
    return header + entries + blobs


if __name__ == "__main__":
    OUT.write_bytes(ico([16, 32, 48]))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
