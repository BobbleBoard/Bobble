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
"""
from __future__ import annotations

from functools import lru_cache

from PIL import ImageFont

# Point size -> pixels is 1:1 here; we only ever compare widths in the same
# unit, so the DPI never enters into it.
FONT_FILES = {
    "Helvetica Neue": "/System/Library/Fonts/Helvetica.ttc",
    "Helvetica": "/System/Library/Fonts/Helvetica.ttc",
    "Georgia": "/System/Library/Fonts/Supplemental/Georgia.ttf",
    "Avenir Next": "/System/Library/Fonts/Avenir Next.ttc",
    "Menlo": "/System/Library/Fonts/Menlo.ttc",
}


@lru_cache(maxsize=256)
def _font(name: str, size_pt: float, bold: bool):
    path = FONT_FILES.get(name, FONT_FILES["Helvetica Neue"])
    try:
        # Helvetica.ttc index 1 is Bold. A wrong index is not fatal — the
        # measurement is simply a little off — so never raise here.
        idx = 1 if bold and path.endswith(".ttc") else 0
        return ImageFont.truetype(path, int(round(size_pt)), index=idx)
    except Exception:
        try:
            return ImageFont.truetype(path, int(round(size_pt)))
        except Exception:
            return ImageFont.load_default()


def width_pt(text: str, size_pt: float, *, font="Helvetica Neue", bold=False) -> float:
    if not text:
        return 0.0
    return float(_font(font, size_pt, bold).getlength(text))


def wrap(text: str, box_pt: float, size_pt: float, *, font="Helvetica Neue",
         bold=False, max_lines: int | None = None) -> list[str]:
    """Greedy word wrap against the real glyph widths."""
    text = " ".join(str(text).split())
    if not text:
        return [""]
    f = _font(font, size_pt, bold)
    lines, cur = [], ""
    for word in text.split(" "):
        trial = f"{cur} {word}".strip()
        if f.getlength(trial) <= box_pt or not cur:
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
        while lines and f.getlength(lines[-1] + "…") > box_pt and " " in lines[-1]:
            lines[-1] = lines[-1].rsplit(" ", 1)[0]
        lines[-1] = lines[-1].rstrip(" ,;:") + "…"
    return lines


def fit_size(text: str, box_pt: float, sizes: list[float], max_lines: int,
             *, font="Helvetica Neue", bold=False) -> tuple[float, list[str]]:
    """Largest size from `sizes` (descending) whose wrap fits in max_lines."""
    for size in sizes:
        lines = wrap(text, box_pt, size, font=font, bold=bold)
        if len(lines) <= max_lines:
            return size, lines
    smallest = sizes[-1]
    return smallest, wrap(text, box_pt, smallest, font=font, bold=bold,
                          max_lines=max_lines)


def height_pt(n_lines: int, size_pt: float, line_spacing: float = 1.05) -> float:
    return n_lines * size_pt * line_spacing
