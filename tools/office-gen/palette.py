"""
The palette comes from the MODEL, not from a hardcoded list.

the user: "why is this color scheme always the same by the way? that shouldn't be
hardcoded, I hope it isn't."

It was. Five named themes, and the model picked one by name, so every document
looked the same. Now the model returns actual hex values chosen for the subject,
and this module's only job is to stop it choosing something unreadable.

That is the right division: taste is the model's, contrast is arithmetic.
Shared by every format — a deck, a report, a workbook and a PDF built from the
same brief should look like they came from the same studio.
"""
from __future__ import annotations

import colorsys
from dataclasses import dataclass


def _rgb(h: str) -> tuple[int, int, int]:
    h = (h or "").lstrip("#").strip()
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        raise ValueError(f"bad hex: {h!r}")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*(max(0, min(255, int(c))) for c in rgb))


def _lum(rgb: tuple[int, int, int]) -> float:
    """WCAG relative luminance."""
    def ch(c: float) -> float:
        c /= 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = _lum(_rgb(a)), _lum(_rgb(b))
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _shift(h: str, *, light: float = 0.0, sat: float = 0.0) -> str:
    r, g, b = (c / 255 for c in _rgb(h))
    hh, ll, ss = colorsys.rgb_to_hls(r, g, b)
    ll = max(0.0, min(1.0, ll + light))
    ss = max(0.0, min(1.0, ss + sat))
    return _hex(tuple(round(c * 255) for c in colorsys.hls_to_rgb(hh, ll, ss)))


@dataclass
class Palette:
    primary: str
    accent: str
    deep: str
    support: str
    paper: str
    ink: str
    mute: str
    faint: str

    def on(self, bg: str) -> str:
        """Readable foreground for any background — never guess this."""
        return self.paper if contrast(bg, self.paper) >= contrast(bg, self.ink) else self.ink


def build(primary: str, accent: str, *, paper="#FCFBF8", ink="#141419") -> Palette:
    """Derive a full palette from the two colours the model actually chose.

    Only two are asked for because two is what a model can pick well. Everything
    else is derived, which is also what keeps a set of documents coherent: the
    deep tone, the tint and the hairline are always the same relationships.
    """
    deep = _shift(primary, light=-0.14, sat=0.04)
    support = _shift(primary, light=0.42, sat=-0.12)
    mute = _shift(ink, light=0.38, sat=-0.05)
    faint = _shift(paper, light=-0.06)

    # Contrast is not negotiable. If the model picks an accent that cannot be
    # read on the paper, darken it until it can — its hue survives, which is the
    # part that carried the intent.
    guard = 0
    while contrast(accent, paper) < 3.0 and guard < 24:
        accent = _shift(accent, light=-0.03)
        guard += 1
    guard = 0
    while contrast(primary, paper) < 4.5 and guard < 24:
        primary = _shift(primary, light=-0.03)
        deep = _shift(primary, light=-0.14, sat=0.04)
        guard += 1

    return Palette(primary=primary, accent=accent, deep=deep, support=support,
                   paper=paper, ink=ink, mute=mute, faint=faint)


def from_spec(spec: dict) -> Palette:
    """Read the model's two colours, falling back only if they are unusable."""
    p = (spec.get("palette") or {}) if isinstance(spec.get("palette"), dict) else {}
    try:
        primary = _hex(_rgb(p.get("primary") or spec.get("primary") or "#14203C"))
    except ValueError:
        primary = "#14203C"
    try:
        accent = _hex(_rgb(p.get("accent") or spec.get("accent") or "#D98E32"))
    except ValueError:
        accent = "#D98E32"
    dark_paper = bool(p.get("dark_paper"))
    return build(primary, accent,
                 paper="#14161A" if dark_paper else "#FCFBF8",
                 ink="#F4F3EF" if dark_paper else "#141419")
