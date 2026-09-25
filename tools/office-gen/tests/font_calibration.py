"""
The numbers behind textfit's bundled fonts (XP-16): the width scale of each
stand-in, and the benchmark its acceptance is judged on.

    tools/office-gen/.venv/bin/python tools/office-gen/tests/font_calibration.py

prints both — on a Mac, since the reference is the Mac's own faces. Paste the
scales into textfit.BUNDLED when a font file changes; tests/test_fonts.py fails
until they agree with a fresh measurement.

THE CORPUS is every piece of text in the visual-quality eval's fixtures — the
research prompts, the replayed 4B-style replies and the REAL 4B captures
(tools/visual-eval/fixtures): what this pipeline is actually asked to set.
A scale is the ratio of the total width on the Mac to the total on the
stand-in, so it corrects the average and nothing else.

THE BENCHMARK is every wrap the deck renderer makes while drawing the eval's
deck cases (pitch-deck a and b1, the flow diagram, the REAL 4B solar deck).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OFFICE = HERE.parent
FIX = OFFICE.parents[1] / "tools" / "visual-eval" / "fixtures"
PROMPTS = OFFICE.parents[1] / "tools" / "visual-eval" / "prompts"
sys.path.insert(0, str(OFFICE))

import textfit  # noqa: E402

REF = 400
# Keys whose values are never set as text: layout and block names, colours,
# formats — they would weigh the average toward snake_case.
NOT_TEXT = {"layout", "type", "theme", "primary", "accent", "palette", "format", "number_format",
            "kind", "look", "id", "_note", "intent", "spec", "source", "unit", "highlight"}


def _strings(v, key: str = "") -> list[str]:
    if isinstance(v, str):
        t = " ".join(v.split())
        if key in NOT_TEXT or len(t) < 2 or not any(c.isalpha() for c in t) or t.startswith("#"):
            return []
        return [t]
    if isinstance(v, dict):
        return [s for k, x in v.items() for s in _strings(x, k)]
    if isinstance(v, list):
        return [s for x in v for s in _strings(x, key)]
    return []


def corpus() -> list[str]:
    """Every string in the eval's fixtures and prompts, once each."""
    out: list[str] = []
    for f in sorted((FIX / "replies").glob("*.json")) + sorted((FIX / "captured-4b").glob("*.json")):
        out += _strings(json.loads(f.read_text()))
    for f in sorted(PROMPTS.glob("*.txt")):
        out += [" ".join(ln.split()) for ln in f.read_text().splitlines() if len(ln.split()) > 1]
    return list(dict.fromkeys(out))


_faces: dict = {}


def raw_width(text: str, family: str, bold: bool, italic: bool, source: str) -> float:
    """Width in em of `text` in the Mac's face ('mac') or the bundled stand-in
    ('bundled'), with no scale — the two sides of a calibration."""
    if source == "mac":
        path, idx = textfit.FACES[family][(bold, italic)][0]
    else:
        path, idx = os.path.join(textfit.FONTS_DIR, textfit.BUNDLED[family][(bold, italic)][0]), 0
    key = (path, idx)
    if key not in _faces:
        from PIL import ImageFont
        _faces[key] = ImageFont.truetype(path, REF, index=idx)
    return _faces[key].getlength(text) / REF


def scales(strings: list[str] | None = None) -> dict[tuple[str, bool, bool], float]:
    """(family, bold, italic) -> total Mac width / total stand-in width, for
    every bundled weight the Mac has a face for."""
    strings = strings or corpus()
    out = {}
    for family, weights in textfit.BUNDLED.items():
        for (bold, italic) in weights:
            if (bold, italic) not in textfit.FACES[family]:
                continue
            mac = sum(raw_width(s, family, bold, italic, "mac") for s in strings)
            alt = sum(raw_width(s, family, bold, italic, "bundled") for s in strings)
            out[(family, bold, italic)] = round(mac / alt, 4)
    return out


def _deck(name: str) -> dict:
    r = json.loads((FIX / "replies" / f"{name}.json").read_text())
    plan = r["plan"]
    slides = [{**f, "layout": p["layout"]} for p, f in zip(plan["slides"], r["fills"])]
    return {"theme": plan.get("theme", "ink"), "running_title": plan.get("running_title", ""), "slides": slides}


def benchmark_decks() -> dict[str, dict]:
    return {
        "pitch-deck-a": _deck("pitch-deck-a"),
        "pitch-deck-b1": _deck("pitch-deck-b1"),
        "flow-diagram-a3": _deck("flow-diagram-a3"),
        "solar-deck": json.loads((FIX / "captured-4b" / "last_pptx_spec.json").read_text()),
    }


def benchmark_wraps() -> list[tuple]:
    """Every distinct wrap (text, box_pt, size_pt, font, bold, italic, tracking)
    render_deck makes while drawing the benchmark decks."""
    import render_deck
    calls: list[tuple] = []
    real = textfit.wrap

    def spy(text, box_pt, size_pt, *, font="Helvetica Neue", bold=False, max_lines=None, italic=False,
            tracking=0.0):
        calls.append((" ".join(str(text).split()), float(box_pt), float(size_pt), font, bool(bold),
                      bool(italic), float(tracking or 0.0)))
        return real(text, box_pt, size_pt, font=font, bold=bold, max_lines=max_lines, italic=italic,
                    tracking=tracking)

    textfit.wrap = spy
    try:
        with tempfile.TemporaryDirectory() as tmp:
            for name, spec in benchmark_decks().items():
                render_deck.build(spec, Path(tmp) / f"{name}.pptx")
    finally:
        textfit.wrap = real
    return list(dict.fromkeys(c for c in calls if c[0]))


def compare_wraps(wraps: list[tuple]) -> list[dict]:
    """Each wrap on the Mac's faces and on the bundled set: the lines, and the
    WRAP WIDTH (the widest line, as the Mac broke it) measured both ways."""
    rows = []
    for text, box, size, font, bold, italic, tracking in wraps:
        kw = {"font": font, "bold": bold, "italic": italic, "tracking": tracking}
        os.environ.pop(textfit.FONTS_ENV, None)
        mac_lines = textfit.wrap(text, box, size, **kw)
        mac_w = max(textfit.width_pt(ln, size, **kw) for ln in mac_lines)
        os.environ[textfit.FONTS_ENV] = "bundled"
        try:
            alt_lines = textfit.wrap(text, box, size, **kw)
            alt_w = max(textfit.width_pt(ln, size, **kw) for ln in mac_lines)
        finally:
            os.environ.pop(textfit.FONTS_ENV, None)
        rows.append({"text": text, "font": font, "bold": bold, "italic": italic, "size": size, "box": box,
                     "same_lines": mac_lines == alt_lines, "mac_w": mac_w, "alt_w": alt_w,
                     "delta": alt_w / mac_w - 1 if mac_w else 0.0,
                     "delta_of_box": (alt_w - mac_w) / box if box else 0.0})
    return rows


if __name__ == "__main__":
    if sys.platform != "darwin":
        sys.exit("the reference faces are the Mac's: run this on macOS")
    strings = corpus()
    print(f"corpus: {len(strings)} strings, {sum(len(s) for s in strings)} characters")
    for (family, bold, italic), s in scales(strings).items():
        print(f"  {family:15s} bold={bold!s:5s} italic={italic!s:5s} scale {s:.4f}")
    rows = compare_wraps(benchmark_wraps())
    worst = sorted(rows, key=lambda r: -abs(r["delta"]))
    print(f"benchmark wraps: {len(rows)}; identical line breaks {sum(r['same_lines'] for r in rows)}; "
          f"wrap width within 2%: {sum(abs(r['delta']) <= 0.02 for r in rows)}; "
          f"worst {worst[0]['delta'] * 100:+.2f}%")
    for r in worst[:8]:
        print(f"  {r['delta'] * 100:+.2f}% ({r['delta_of_box'] * 100:+.2f}% of its box)  "
              f"{r['font']} b={r['bold']} i={r['italic']} {r['size']}pt  {r['text'][:60]!r}")
