"""
Text measurement for the eval, independent of the renderers' own textfit.py.

The report compares renders before and after a renderer change, so the ruler
must not move with the thing it measures: textfit.py is the renderers' code
(VQ-01 changes it), this is the eval's. Widths come from the real font files
through PIL, loaded at a large size and scaled, so a 13.5 pt run is measured
at 13.5 pt rather than rounded to 14.

Vertical geometry is CALIBRATED against QuickLook (the eval's renderer, and
within a point of PowerPoint's rule): a paragraph set at spacing multiple m
advances 1.2 * size * m per line; with no spacing set, 1.16 * size. The first
cap top sits 0.24 em (0.17 em unset) + 0.6 em per unit of m above 1 below the
line top; cap height 0.71 em; descenders 0.21 em. MEASURED 2026-09-23:
58 pt m=1.02 -> pitch 71.4 pt; 52 pt m=1.04 -> 65.4; 17 pt m=1.3 -> 26.4;
14 pt unset -> 16.2; 34 pt m=1.04 -> 42.6.
"""
from __future__ import annotations

import os
from functools import lru_cache

from PIL import ImageFont

LINE = 1.2
SINGLE = 1.16
CAP_TOP_SET = 0.24
CAP_TOP_SINGLE = 0.17
CAP_H = 0.71
DESC = 0.21

_REF = 200  # measure at this pixel size and scale

# (file, face index) candidates per (family, bold, italic); first that loads wins.
_MAC = "/System/Library/Fonts"
_SUP = "/System/Library/Fonts/Supplemental"
FACES = {
    "helvetica neue": {
        (False, False): [(f"{_MAC}/HelveticaNeue.ttc", 0)],
        (True, False): [(f"{_MAC}/HelveticaNeue.ttc", 1)],
        (False, True): [(f"{_MAC}/HelveticaNeue.ttc", 2)],
        (True, True): [(f"{_MAC}/HelveticaNeue.ttc", 3)],
    },
    "helvetica": {
        (False, False): [(f"{_MAC}/Helvetica.ttc", 0)],
        (True, False): [(f"{_MAC}/Helvetica.ttc", 1)],
        (False, True): [(f"{_MAC}/Helvetica.ttc", 2)],
        (True, True): [(f"{_MAC}/Helvetica.ttc", 3)],
    },
    "georgia": {
        (False, False): [(f"{_SUP}/Georgia.ttf", 0)],
        (True, False): [(f"{_SUP}/Georgia Bold.ttf", 0)],
        (False, True): [(f"{_SUP}/Georgia Italic.ttf", 0)],
        (True, True): [(f"{_SUP}/Georgia Bold Italic.ttf", 0)],
    },
    "arial": {
        (False, False): [(f"{_SUP}/Arial.ttf", 0)],
        (True, False): [(f"{_SUP}/Arial Bold.ttf", 0)],
        (False, True): [(f"{_SUP}/Arial Italic.ttf", 0)],
        (True, True): [(f"{_SUP}/Arial Bold Italic.ttf", 0)],
    },
}
# Anything else is measured as Helvetica Neue: close enough for a sans, and
# the report names the families so an unexpected one is visible anyway.
_FALLBACK = "helvetica neue"
# Off macOS (track 4) the same metrics are approximated by what the OS has.
_PORTABLE = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "C:/Windows/Fonts/arial.ttf"]


def family_key(name: str | None) -> str:
    n = (name or "").strip().strip("'\"").lower()
    for key in FACES:
        if n.startswith(key):
            return key
    return _FALLBACK


@lru_cache(maxsize=64)
def _font(family: str, bold: bool, italic: bool):
    faces = FACES.get(family, FACES[_FALLBACK])
    for path, idx in faces.get((bold, italic), []) + faces[(False, False)]:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, _REF, index=idx)
            except OSError:
                continue
    for path in _PORTABLE:
        if os.path.exists(path):
            return ImageFont.truetype(path, _REF)
    return ImageFont.load_default()


def width(text: str, size: float, *, font: str | None = None, bold=False, italic=False) -> float:
    """Advance width of `text` at `size` (same unit as size)."""
    if not text:
        return 0.0
    f = _font(family_key(font), bool(bold), bool(italic))
    return float(f.getlength(text)) * size / _REF


def wrap(text: str, box: float, size: float, *, font=None, bold=False, italic=False) -> list[str]:
    """Greedy word wrap, as PowerPoint/Word/QuickLook break a line: at spaces,
    a single word wider than the box stays whole on its own line."""
    out: list[str] = []
    for hard in str(text).replace("\v", "\n").split("\n"):
        words = hard.split()
        if not words:
            out.append("")
            continue
        cur = ""
        for w in words:
            trial = f"{cur} {w}" if cur else w
            if not cur or width(trial, size, font=font, bold=bold, italic=italic) <= box + 0.01:
                cur = trial
            else:
                out.append(cur)
                cur = w
        out.append(cur)
    return out or [""]


def char_wrap_count(text: str, box: float, size: float, *, font=None, bold=False) -> int:
    """How many lines a renderer that ALSO breaks inside words would need — the
    '3,10 / 0' case: a word wider than its box is split by the renderer."""
    n = 0
    for line in wrap(text, box, size, font=font, bold=bold):
        w = width(line, size, font=font, bold=bold)
        n += max(1, int(-(-w // max(box, 1e-6)))) if w > box + 0.5 else 1
    return max(1, n)


def pitch(size: float, multiple: float | None, exact: float | None = None) -> float:
    if exact is not None:
        return exact
    return size * (LINE * multiple if multiple is not None else SINGLE)


def cap_top(size: float, multiple: float | None) -> float:
    if multiple is None:
        return CAP_TOP_SINGLE * size
    return (CAP_TOP_SET + max(0.0, multiple - 1.0) * 0.6) * size
