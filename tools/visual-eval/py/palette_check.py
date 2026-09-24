"""
Colour arithmetic for the eval report: WCAG contrast, OKLab distance, and the
colour-vision-deficiency (CVD) simulation the dataviz palette method uses.

Thresholds (visual-quality.md §3, "Dataviz method"; §4.4 L4/L9):
  - text contrast >= 4.5:1, or >= 3:1 for large text (>= 18 pt, or >= 14 pt bold);
  - categorical marks: adjacent pairs dE >= 15 under normal vision and dE >= 8
    under protan/deutan/tritan simulation (OKLab, x100), and every mark >= 3:1
    against its surface.

Pure functions, no dependencies — the report must come out byte-identical run
to run, so nothing here reads a clock or a random source.
"""
from __future__ import annotations

import math
import re

# Machado, Oliveira & Fernandes (2009), severity 1.0, applied in LINEAR sRGB.
CVD = {
    "protan": ((0.152286, 1.052583, -0.204868),
               (0.114503, 0.786281, 0.099216),
               (-0.003882, -0.048116, 1.051998)),
    "deutan": ((0.367322, 0.860646, -0.227968),
               (0.280085, 0.672501, 0.047413),
               (-0.011820, 0.042940, 0.968881)),
    "tritan": ((1.255528, -0.076749, -0.178779),
               (-0.078411, 0.930809, 0.147602),
               (0.004733, 0.691367, 0.303900)),
}

NORMAL_MIN = 15.0
CVD_MIN = 8.0
MARK_CONTRAST_MIN = 3.0

_NAMED = {"white": (255, 255, 255), "black": (0, 0, 0), "none": None, "transparent": None}


def parse_colour(value) -> tuple[int, int, int] | None:
    """'#RGB', '#RRGGBB', 'rgb(r, g, b)', 'rgba(...)' or an (r, g, b) tuple -> (r, g, b)."""
    if value is None:
        return None
    if isinstance(value, (tuple, list)) and len(value) >= 3:
        return tuple(int(round(float(c))) for c in value[:3])  # type: ignore[return-value]
    s = str(value).strip().lower()
    if s in _NAMED:
        return _NAMED[s]
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) >= 6 and re.fullmatch(r"[0-9a-f]{6,8}", h):
            return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
        return None
    m = re.match(r"rgba?\(([^)]*)\)", s)
    if m:
        parts = [p.strip() for p in re.split(r"[,\s/]+", m.group(1)) if p.strip()]
        try:
            rgb = [float(p[:-1]) * 2.55 if p.endswith("%") else float(p) for p in parts[:3]]
        except ValueError:
            return None
        if len(parts) >= 4:
            try:
                a = float(parts[3][:-1]) / 100 if parts[3].endswith("%") else float(parts[3])
            except ValueError:
                a = 1.0
            if a <= 0.001:
                return None
        return tuple(int(round(c)) for c in rgb)  # type: ignore[return-value]
    if re.fullmatch(r"[0-9a-f]{6}", s):
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
    return None


def hex_of(rgb) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def _lin(c: float) -> float:
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _unlin(c: float) -> float:
    c = max(0.0, min(1.0, c))
    return 255.0 * (12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055)


def luminance(rgb) -> float:
    r, g, b = (_lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def blend(top, bottom, alpha: float):
    """`top` at `alpha` over `bottom` (sRGB compositing, as renderers do it)."""
    return tuple(int(round(t * alpha + b * (1 - alpha))) for t, b in zip(top, bottom))


def oklab(rgb) -> tuple[float, float, float]:
    r, g, b = (_lin(c) for c in rgb)
    l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = (math.copysign(abs(v) ** (1 / 3), v) for v in (l_, m_, s_))
    return (0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
            1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
            0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_)


def delta_e(a, b) -> float:
    """OKLab Euclidean distance x100 (the dataviz method's unit)."""
    la, lb = oklab(a), oklab(b)
    return 100.0 * math.dist(la, lb)


def simulate(rgb, kind: str):
    mtx = CVD[kind]
    lin = [_lin(c) for c in rgb]
    out = [sum(mtx[i][j] * lin[j] for j in range(3)) for i in range(3)]
    return tuple(int(round(_unlin(c))) for c in out)


def categorical(colours, surface) -> dict | None:
    """Adjacent-pair separation and mark contrast for a set of series colours.

    None when there is nothing categorical to judge (fewer than two colours).
    """
    cols = [c for c in (parse_colour(x) for x in colours) if c is not None]
    surf = parse_colour(surface) or (255, 255, 255)
    if len(cols) < 2:
        return None
    pairs = list(zip(cols, cols[1:]))
    normal = min(delta_e(a, b) for a, b in pairs)
    cvd = {k: min(delta_e(simulate(a, k), simulate(b, k)) for a, b in pairs) for k in CVD}
    worst_kind = min(cvd, key=lambda k: cvd[k])
    marks = min(contrast(c, surf) for c in cols)
    return {
        "colours": [hex_of(c) for c in cols],
        "normal_min": round(normal, 1),
        "cvd_min": round(cvd[worst_kind], 1),
        "cvd_worst": worst_kind,
        "mark_contrast_min": round(marks, 2),
        "ok": normal >= NORMAL_MIN and cvd[worst_kind] >= CVD_MIN and marks >= MARK_CONTRAST_MIN,
    }


def text_needs(size_pt: float, bold: bool) -> float:
    """WCAG AA: large text is >= 18 pt, or >= 14 pt bold."""
    return 3.0 if size_pt >= 18 or (bold and size_pt >= 14) else 4.5
