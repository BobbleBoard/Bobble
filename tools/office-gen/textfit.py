"""
Real text measurement, borrowed from the benchmark deck's approach.

THE PROBLEM. python-pptx has no font metrics and no layout engine, so a renderer
cannot know how tall a paragraph will be. Every layout bug in this project came
from that one fact: a title wrapping to three lines instead of two, and landing
on the subtitle. I estimated it twice — first with a fixed characters-per-line
constant, then with a width-and-size-aware guess — and both were wrong often
enough to put text on top of other text.

THE FIX, which the Claude-built reference deck used and which is simply better:
measure the string against the ACTUAL macOS font file with PIL, wrap it here,
and write explicit lines with word_wrap disabled. PowerPoint is then not
permitted to reflow anything, so what we measured is what renders. Estimation
becomes measurement, and the whole class of overlap bugs disappears.

The residual risk is that PowerPoint's shaping differs slightly from PIL's for
the same TTF. Pre-wrapping bounds that: worst case a line is a few points
narrower than its box, which is invisible. Auto-reflow was the unbounded case.

TWO CORRECTIONS (VQ-01, 2026-09-23), both measured:
  - Line HEIGHT. A paragraph at line spacing m advances 1.2 x size x m per line
    in QuickLook and PowerPoint (58 pt at 1.02 -> 71.4 pt; 52 pt at 1.04 -> 65.4;
    17 pt at 1.3 -> 26.4), not size x m. Everything stacked under a measured
    block was placed about a sixth too high — the subtitle that collided with
    a three-line title. `height_pt` now returns the rendered height.
  - Faces. "Helvetica Neue" was measured with Helvetica.ttc and bold with face
    1 of any .ttc; Georgia bold was measured as regular. Each family now names
    the file and face index per weight, and sizes are measured at a large size
    and scaled, so 13.5 pt is 13.5 pt rather than a rounded 14.
"""
from __future__ import annotations

import os
from functools import lru_cache

from PIL import ImageFont

# Rendered line pitch per point at line spacing 1.0 (PowerPoint's "single" for
# the sans and serif used here; QuickLook agrees within a point).
LINE_FACTOR = 1.2
_REF = 200

_MAC = "/System/Library/Fonts"
_SUP = "/System/Library/Fonts/Supplemental"
# family -> {(bold, italic): [(file, face index), …]} — first that loads wins.
FACES = {
    "Helvetica Neue": {
        (False, False): [(f"{_MAC}/HelveticaNeue.ttc", 0)],
        (True, False): [(f"{_MAC}/HelveticaNeue.ttc", 1)],
        (False, True): [(f"{_MAC}/HelveticaNeue.ttc", 2)],
        (True, True): [(f"{_MAC}/HelveticaNeue.ttc", 3)],
    },
    "Helvetica": {
        (False, False): [(f"{_MAC}/Helvetica.ttc", 0)],
        (True, False): [(f"{_MAC}/Helvetica.ttc", 1)],
        (False, True): [(f"{_MAC}/Helvetica.ttc", 2)],
        (True, True): [(f"{_MAC}/Helvetica.ttc", 3)],
    },
    "Georgia": {
        (False, False): [(f"{_SUP}/Georgia.ttf", 0)],
        (True, False): [(f"{_SUP}/Georgia Bold.ttf", 0)],
        (False, True): [(f"{_SUP}/Georgia Italic.ttf", 0)],
        (True, True): [(f"{_SUP}/Georgia Bold Italic.ttf", 0)],
    },
    "Avenir Next": {
        (False, False): [(f"{_MAC}/Avenir Next.ttc", 7)],
        (True, False): [(f"{_MAC}/Avenir Next.ttc", 0)],
    },
    "Menlo": {(False, False): [(f"{_MAC}/Menlo.ttc", 0)], (True, False): [(f"{_MAC}/Menlo.ttc", 1)]},
}
# Off macOS (track 4): metric-compatible stand-ins, so a PC still measures.
_PORTABLE = {
    (False, False): ["C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                     "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    (True, False): ["C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
}
# Kept for callers that read it: the regular face of each family.
FONT_FILES = {name: faces[(False, False)][0][0] for name, faces in FACES.items()}


@lru_cache(maxsize=64)
def _face(name: str, bold: bool, italic: bool = False):
    faces = FACES.get(name, FACES["Helvetica Neue"])
    for path, idx in faces.get((bold, italic), []) + faces.get((bold, False), []) + faces[(False, False)]:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, _REF, index=idx)
            except OSError:
                continue
    for path in _PORTABLE.get((bold, False), []) + _PORTABLE[(False, False)]:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, _REF)
            except OSError:
                continue
    return ImageFont.load_default()


@lru_cache(maxsize=256)
def _font(name: str, size_pt: float, bold: bool):
    """A PIL font AT `size_pt` pixels — office_chart.py draws a chart's labels
    into its raster with it. (Measuring scales from one reference size instead.)"""
    face = _face(name, bool(bold))
    try:
        return face.font_variant(size=max(1, int(round(size_pt))))
    except (AttributeError, OSError):
        return face


def width_pt(text: str, size_pt: float, *, font="Helvetica Neue", bold=False, italic=False,
             tracking: float = 0.0) -> float:
    """Advance width in points; `tracking` is letter-spacing in points per
    character (the `spc` a kicker or eyebrow is set with)."""
    if not text:
        return 0.0
    w = float(_face(font, bool(bold), bool(italic)).getlength(text)) * size_pt / _REF
    return w + tracking * max(0, len(text) - 1)


def wrap(text: str, box_pt: float, size_pt: float, *, font="Helvetica Neue",
         bold=False, max_lines: int | None = None, italic=False, tracking: float = 0.0) -> list[str]:
    """Greedy word wrap against the real glyph widths."""
    text = " ".join(str(text).split())
    if not text:
        return [""]
    kw = {"font": font, "bold": bold, "italic": italic, "tracking": tracking}
    lines, cur = [], ""
    for word in text.split(" "):
        trial = f"{cur} {word}".strip()
        if width_pt(trial, size_pt, **kw) <= box_pt or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        # Ellipsise rather than silently dropping the tail — a truncated
        # sentence that looks complete is worse than one that admits it.
        while lines and width_pt(lines[-1] + "…", size_pt, **kw) > box_pt and " " in lines[-1]:
            lines[-1] = lines[-1].rsplit(" ", 1)[0]
        lines[-1] = lines[-1].rstrip(" ,;:") + "…"
    return lines


def fits(text: str, box_pt: float, size_pt: float, max_lines: int, *, font="Helvetica Neue",
         bold=False, italic=False, tracking: float = 0.0) -> bool:
    """Whole words, every line inside the box, within max_lines."""
    kw = {"font": font, "bold": bold, "italic": italic, "tracking": tracking}
    lines = wrap(text, box_pt, size_pt, **kw)
    return len(lines) <= max_lines and all(width_pt(ln, size_pt, **kw) <= box_pt for ln in lines)


def fit_size(text: str, box_pt: float, sizes: list[float], max_lines: int,
             *, font="Helvetica Neue", bold=False, italic=False,
             tracking: float = 0.0) -> tuple[float, list[str]]:
    """Largest size from `sizes` (descending) whose wrap fits in max_lines —
    with every line inside the box: a single word wider than the box ("3,100"
    at 76 pt in a narrow column) is split by the renderer, over the next thing."""
    kw = {"font": font, "bold": bold, "italic": italic, "tracking": tracking}
    for size in sizes:
        if fits(text, box_pt, size, max_lines, **kw):
            return size, wrap(text, box_pt, size, **kw)
    smallest = sizes[-1]
    return smallest, wrap(text, box_pt, smallest, max_lines=max_lines, **kw)


def line_pitch_pt(size_pt: float, line_spacing: float = 1.0) -> float:
    """How far one line advances when rendered at `line_spacing` (a multiple)."""
    return size_pt * LINE_FACTOR * line_spacing


def height_pt(n_lines: int, size_pt: float, line_spacing: float = 1.05) -> float:
    """Rendered height of n lines — what the next block must clear."""
    return n_lines * line_pitch_pt(size_pt, line_spacing)
