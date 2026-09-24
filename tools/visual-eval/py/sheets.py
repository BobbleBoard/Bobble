"""
Contact sheets: every render of one artifact in a labelled grid, plus the
non-blank check the eval reports (a blank or failed render would otherwise pass
as "a PNG exists").

    python sheets.py batch manifest.json      # [{"pngs": [...], "out": path, "title": str, "cols": n}]
    python sheets.py compare out.png "label A" a.png "label B" b.png …   # rows, top to bottom
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageStat

BG = (58, 58, 62)
FG = (236, 236, 236)
TILE_W = 640
PAD = 12
HEAD = 44
MIN_BYTES = 4000
MIN_STDDEV = 3.0


def _font(size: int):
    for path, idx in (("/System/Library/Fonts/HelveticaNeue.ttc", 0), ("/System/Library/Fonts/Helvetica.ttc", 0)):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=idx)
            except OSError:
                pass
    return ImageFont.load_default()


def nonblank(path: str | Path) -> dict:
    """Big enough on disk and not one flat colour."""
    p = Path(path)
    if not p.exists():
        return {"bytes_ok": False, "variance_ok": False}
    with Image.open(p) as im:
        sd = ImageStat.Stat(im.convert("L").resize((160, 90))).stddev[0]
    return {"bytes_ok": p.stat().st_size >= MIN_BYTES, "variance_ok": sd >= MIN_STDDEV}


def sheet(pngs: list[str], out: Path, title: str = "", cols: int = 3, tile_w: int = TILE_W) -> Path:
    ims = [Image.open(p).convert("RGB") for p in pngs] or [Image.new("RGB", (tile_w, tile_w * 9 // 16), (0, 0, 0))]
    cols = max(1, min(cols, len(ims)))
    scaled = [im.resize((tile_w, max(1, int(im.height * tile_w / im.width))), Image.LANCZOS) for im in ims]
    row_h = max(im.height for im in scaled)
    rows = (len(scaled) + cols - 1) // cols
    head = HEAD if title else 0
    S = Image.new("RGB", (cols * (tile_w + PAD) + PAD, head + rows * (row_h + PAD) + PAD), BG)
    d = ImageDraw.Draw(S)
    if title:
        d.text((PAD, 12), title, fill=FG, font=_font(20))
    for i, im in enumerate(scaled):
        S.paste(im, (PAD + (i % cols) * (tile_w + PAD), head + PAD + (i // cols) * (row_h + PAD)))
    out.parent.mkdir(parents=True, exist_ok=True)
    S.save(out)
    return out


def compare(out: Path, rows: list[tuple[str, str]], width: int = 2000) -> Path:
    """Stack labelled images top to bottom at one width (before/after evidence)."""
    font = _font(22)
    tiles = []
    for label, path in rows:
        im = Image.open(path).convert("RGB")
        im = im.resize((width, max(1, int(im.height * width / im.width))), Image.LANCZOS)
        tiles.append((label, im))
    H = sum(HEAD + im.height + PAD for _, im in tiles) + PAD
    S = Image.new("RGB", (width + 2 * PAD, H), BG)
    d = ImageDraw.Draw(S)
    y = PAD
    for label, im in tiles:
        d.text((PAD, y + 10), label, fill=FG, font=font)
        S.paste(im, (PAD, y + HEAD))
        y += HEAD + im.height + PAD
    out.parent.mkdir(parents=True, exist_ok=True)
    S.save(out)
    return out


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "batch":
        items = json.loads(Path(sys.argv[2]).read_text())
        res = []
        for it in items:
            p = sheet(it["pngs"], Path(it["out"]), it.get("title", ""), int(it.get("cols", 3)),
                      int(it.get("tile_w", TILE_W)))
            res.append({"out": str(p), **nonblank(p)})
        print(json.dumps(res))
    elif cmd == "compare":
        out = Path(sys.argv[2])
        rest = sys.argv[3:]
        compare(out, list(zip(rest[0::2], rest[1::2])))
        print(out)
