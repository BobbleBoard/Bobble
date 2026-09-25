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

OFF macOS (XP-16, 2026-09-24): the files above are the Mac's, so a PC measured
with PIL's bitmap default and wrapped on nonsense. Every OS now measures with
bundled metric-compatible OFL fonts (fonts/, below); the Mac keeps its own
faces, so what it makes is byte-for-byte what it made before.
"""
from __future__ import annotations

import os
import sys
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
# Kept for callers that read it: the regular face of each family.
FONT_FILES = {name: faces[(False, False)][0][0] for name, faces in FACES.items()}

# ── everywhere else: the bundled set (XP-16) ──────────────────────────────────
# Off macOS none of the files above exist, and measuring fell through to
# `ImageFont.load_default()` — a bitmap font nothing like the face the file
# names — so every wrap on a PC was decided on the wrong widths and text landed
# on text. The fix is a font that is always here: metric-compatible OFL faces
# shipped in fonts/ (the user, PLAN.md Q28: "yes to all" to bundling OFL fonts).
# Versions, upstream sources and hashes are in fonts/SOURCES.txt, the licences
# beside the files.
#
#   Georgia        -> Gelasio 1.008     drawn to Georgia's metrics; MEASURED
#                                       within 0.03% of it on the eval's text
#   Helvetica      -> Liberation Sans   Arial's metrics, which are Helvetica's
#   Helvetica Neue -> Liberation Sans   no OFL face has Neue's metrics: its
#                                       letters differ from Helvetica's (E, M, t,
#                                       b, c…) and so does its punctuation. The
#                                       SCALE is the measured ratio of the Mac's
#                                       widths to Liberation's over the eval's
#                                       text, so an average line matches; what is
#                                       left is per glyph, and tests/test_fonts.py
#                                       states it
#   Avenir Next    -> Liberation Sans   no renderer names it today; scaled
#   Menlo          -> Liberation Mono   both monospaced; the ratio of the one
#                                       advance width they each have
#
# Every scale is MEASURED on a Mac against the faces above by
# tests/font_calibration.py (run it to print the table), and tests/test_fonts.py
# fails on a Mac when one drifts from a fresh measurement.
FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
# family -> {(bold, italic): (file in fonts/, width scale)}
BUNDLED = {
    "Helvetica Neue": {
        (False, False): ("LiberationSans-Regular.ttf", 1.0109),
        (True, False): ("LiberationSans-Bold.ttf", 1.0012),
        (False, True): ("LiberationSans-Italic.ttf", 1.0044),
        (True, True): ("LiberationSans-BoldItalic.ttf", 1.0028),
    },
    "Helvetica": {
        (False, False): ("LiberationSans-Regular.ttf", 0.9996),
        (True, False): ("LiberationSans-Bold.ttf", 0.9997),
        (False, True): ("LiberationSans-Italic.ttf", 0.9996),
        (True, True): ("LiberationSans-BoldItalic.ttf", 0.9997),
    },
    "Georgia": {
        (False, False): ("Gelasio-Regular.ttf", 1.0003),
        (True, False): ("Gelasio-Bold.ttf", 1.0002),
        (False, True): ("Gelasio-Italic.ttf", 1.0003),
        (True, True): ("Gelasio-BoldItalic.ttf", 1.0002),
    },
    "Avenir Next": {
        (False, False): ("LiberationSans-Regular.ttf", 1.0280),
        (True, False): ("LiberationSans-Bold.ttf", 1.0226),
    },
    "Menlo": {
        (False, False): ("LiberationMono-Regular.ttf", 1.0042),
        (True, False): ("LiberationMono-Bold.ttf", 1.0042),
    },
}
# What an OS may have installed, for a copy of the pipeline whose fonts/ went
# missing: the same metric families first (Arial IS Liberation Sans's metrics,
# and Windows ships the real Georgia), then DejaVu, which is at least a real face.
_INSTALLED = {
    "win32": {
        "sans": {(False, False): "C:/Windows/Fonts/arial.ttf", (True, False): "C:/Windows/Fonts/arialbd.ttf",
                 (False, True): "C:/Windows/Fonts/ariali.ttf", (True, True): "C:/Windows/Fonts/arialbi.ttf"},
        "serif": {(False, False): "C:/Windows/Fonts/georgia.ttf", (True, False): "C:/Windows/Fonts/georgiab.ttf",
                  (False, True): "C:/Windows/Fonts/georgiai.ttf", (True, True): "C:/Windows/Fonts/georgiaz.ttf"},
        "mono": {(False, False): "C:/Windows/Fonts/cour.ttf", (True, False): "C:/Windows/Fonts/courbd.ttf"},
    },
    "linux": {
        "sans": {(False, False): "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                 (True, False): "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                 (False, True): "/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf",
                 (True, True): "/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf"},
        "mono": {(False, False): "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
                 (True, False): "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf"},
    },
}
_LAST_RESORT = {(False, False): "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                (True, False): "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"}
_KIND = {"Georgia": "serif", "Menlo": "mono"}

# `PI_OFFICE_GEN_FONTS=bundled` measures with the bundled set on ANY OS: how a
# Mac proves what a PC will measure (tests/test_fonts.py), and the switch for
# anyone who wants a Mac's files laid out exactly as a PC lays them out.
FONTS_ENV = "PI_OFFICE_GEN_FONTS"


def _platform() -> str:
    return sys.platform


def fonts_mode() -> str:
    """'mac' on macOS (its own faces, then the bundled set), else 'bundled'."""
    if os.environ.get(FONTS_ENV, "").strip().lower() == "bundled":
        return "bundled"
    return "mac" if _platform() == "darwin" else "bundled"


def _weights(bold: bool, italic: bool) -> list[tuple[bool, bool]]:
    return list(dict.fromkeys([(bold, italic), (bold, False), (False, False)]))


def candidates(name: str, bold: bool = False, italic: bool = False,
               mode: str | None = None) -> list[tuple[str, int, float, str]]:
    """Every (file, face index, width scale, source) that may measure `name`,
    best first — what `_resolve` walks, and what a test reads."""
    mode = mode or fonts_mode()
    fam = name if name in FACES else "Helvetica Neue"
    out: list[tuple[str, int, float, str]] = []
    if mode == "mac":
        for w in _weights(bold, italic):
            out += [(path, idx, 1.0, "system") for path, idx in FACES[fam].get(w, [])]
    bundled = BUNDLED[fam]
    for w in _weights(bold, italic):
        if w in bundled:
            file, scale = bundled[w]
            out.append((os.path.join(FONTS_DIR, file), 0, scale, "bundled"))
    installed = _INSTALLED["win32" if _platform() == "win32" else "linux"].get(_KIND.get(fam, "sans"), {})
    for w in _weights(bold, italic):
        if w in installed:
            # Arial and a distro's Liberation have the bundled face's metrics,
            # so the bundled scale holds for them too.
            scale = bundled.get(w, bundled[(False, False)])[1] if _KIND.get(fam, "sans") != "serif" else 1.0
            out.append((installed[w], 0, scale, "installed"))
    for w in _weights(bold, False):
        if w in _LAST_RESORT:
            out.append((_LAST_RESORT[w], 0, 1.0, "installed"))
    return list(dict.fromkeys(out))


_warned: set[tuple[str, bool, bool]] = set()


@lru_cache(maxsize=128)
def _resolve(name: str, bold: bool, italic: bool, mode: str):
    """(PIL font at _REF px, width scale, file) for one family and weight."""
    for path, idx, scale, _src in candidates(name, bold, italic, mode):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, _REF, index=idx), scale, path
            except OSError:
                continue
    # Nothing at all. PIL's bitmap default measures nothing like the named face
    # — the off-macOS bug this file had in EVERY run — so it is said out loud,
    # once per face, and never again the silent normal case.
    if (name, bold, italic) not in _warned:
        _warned.add((name, bold, italic))
        print(f"textfit: no font file for {name} (bold={bold}, italic={italic}); measuring with PIL's "
              f"default bitmap font, so wraps will not match the file. Is {FONTS_DIR} missing?",
              file=sys.stderr)
    return ImageFont.load_default(), 1.0, ""


def _face(name: str, bold: bool, italic: bool = False):
    return _resolve(name, bool(bold), bool(italic), fonts_mode())[0]


def resolved(name: str = "Helvetica Neue", bold: bool = False, italic: bool = False) -> dict:
    """Which file measures `name` here and at what scale — for the tests, and
    for anyone asking why a wrap came out as it did."""
    _f, scale, path = _resolve(name, bool(bold), bool(italic), fonts_mode())
    return {"file": path, "scale": scale, "mode": fonts_mode()}


@lru_cache(maxsize=256)
def _sized(name: str, size_px: int, bold: bool, mode: str):
    face = _resolve(name, bold, False, mode)[0]
    try:
        return face.font_variant(size=size_px)
    except (AttributeError, OSError):
        return face


def _font(name: str, size_pt: float, bold: bool):
    """A PIL font AT `size_pt` pixels — office_chart.py draws a chart's labels
    into its raster with it. (Measuring scales from one reference size instead.)
    The glyphs are the stand-in's own, unscaled: a raster label is aligned by
    the length it is DRAWN at, so it needs no correction."""
    return _sized(name, max(1, int(round(size_pt))), bool(bold), fonts_mode())


def width_pt(text: str, size_pt: float, *, font="Helvetica Neue", bold=False, italic=False,
             tracking: float = 0.0) -> float:
    """Advance width in points; `tracking` is letter-spacing in points per
    character (the `spc` a kicker or eyebrow is set with)."""
    if not text:
        return 0.0
    face, scale, _path = _resolve(font, bool(bold), bool(italic), fonts_mode())
    w = float(face.getlength(text)) * size_pt / _REF * scale
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
