"""Compose labelled BEFORE | AFTER pairs from the two probe runs (same probe, same
state, same viewport), so a change can be judged without flipping files."""
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).parent
before, after, out = root / "before", root / "after", root / "pairs"
out.mkdir(exist_ok=True)

NAMES = [
    "01-empty-light",
    "01-empty-dark",
    "02-thread-top-light",
    "02-thread-top-dark",
    "03-thread-bottom-light",
    "03-thread-bottom-dark",
    "12-sidebar-hover-light",
    "12-sidebar-hover-dark",
    "15-settings-models-light",
    "15-settings-models-dark",
    "15-settings-interface-light",
    "15-settings-interface-dark",
    "08-canvas-markdown-light",
    "05-model-menu-light",
]
BAR, GAP, BG = 28, 8, (208, 208, 212)

for name in NAMES:
    b, a = before / f"{name}.png", after / f"{name}.png"
    if not (b.exists() and a.exists()):
        continue
    ib, ia = Image.open(b).convert("RGB"), Image.open(a).convert("RGB")
    w = ib.width + ia.width + GAP * 3
    h = max(ib.height, ia.height) + BAR + GAP * 2
    canvas = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(canvas)
    draw.text((GAP + 6, 7), "BEFORE", fill=(17, 17, 17))
    draw.text((GAP * 2 + ib.width + 6, 7), "AFTER", fill=(17, 17, 17))
    canvas.paste(ib, (GAP, BAR + GAP))
    canvas.paste(ia, (GAP * 2 + ib.width, BAR + GAP))
    canvas.save(out / f"{name}.png", optimize=True)
    print("pair", name)
