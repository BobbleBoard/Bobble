#!/usr/bin/env python3
"""
HTML/CSS -> a VECTOR pdf. Same measured input as html2pptx.

Chromium can already print to PDF, so why this? Because print-to-PDF gives you
whatever the print stylesheet decides, at whatever page size the browser picks,
with no control over what becomes an object. This walks the SAME element list
html2pptx consumes and draws each one, so a brief, a deck and a report generated
from one design language come out consistent — and the PDF is drawn shapes and
selectable text rather than a rasterised page.

reportlab has no blur filter, so a CSS box-shadow is approximated by stacking
translucent offset copies. It is an approximation and it is marked as one in the
code, rather than quietly dropping the shadow and leaving the layout looking
flat for a reason nobody can see.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from reportlab.lib.colors import Color
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).parent))
from html2pptx import _flatten_path, _parse_linear_gradient, _rgba  # noqa: E402

PX_W, PX_H = 1280.0, 720.0


def _col(css: str, *, default=None):
    rgb, a = _rgba(css or "")
    if rgb is None:
        return default
    return Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, alpha=a)


def _rlcol(rgb, alpha=1.0):
    return Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, alpha=alpha)


class Page:
    def __init__(self, out: Path, w_pt: float, h_pt: float):
        self.W, self.H = w_pt, h_pt
        self.k = w_pt / PX_W                     # points per CSS pixel
        self.c = rl_canvas.Canvas(str(out), pagesize=(w_pt, h_pt))

    # CSS y grows down, PDF y grows up. Every draw goes through here so the
    # flip is stated once instead of scattered through the block functions.
    def xy(self, x, y, h=0.0):
        return x * self.k, self.H - (y + h) * self.k

    def rect(self, el, *, fill=None, stroke=None, lw=0.0, radius=0.0):
        x, y = self.xy(el["x"], el["y"], el["h"])
        w, h = el["w"] * self.k, el["h"] * self.k
        if fill is not None:
            self.c.setFillColor(fill)
        if stroke is not None:
            self.c.setStrokeColor(stroke)
            self.c.setLineWidth(lw * self.k)
        r = min(radius * self.k, w / 2, h / 2)
        if r > 0.5:
            self.c.roundRect(x, y, w, h, r, stroke=1 if stroke else 0, fill=1 if fill else 0)
        else:
            self.c.rect(x, y, w, h, stroke=1 if stroke else 0, fill=1 if fill else 0)

    def shadow(self, el, css: str, radius: float):
        """Stacked translucent copies standing in for a blur. Cheap, and much
        closer to the design intent than no shadow at all."""
        rgb, a = _rgba(css or "")
        lengths = [float(v) for v in re.findall(r"(-?[\d.]+)px", css or "")]
        if rgb is None or len(lengths) < 2 or a <= 0:
            return
        dx, dy = lengths[0], lengths[1]
        blur = lengths[2] if len(lengths) > 2 else 0.0
        # Measured by eye against the pptx render: 7 layers at a flat alpha
        # accumulated to ~0.7 near the shape and read as a hard grey slab. Many
        # thin layers with a quadratic falloff is much closer to a real blur.
        steps = 14
        for i in range(steps, 0, -1):
            f = i / steps
            grow = blur * f
            layer = {"x": el["x"] + dx - grow, "y": el["y"] + dy - grow,
                     "w": el["w"] + 2 * grow, "h": el["h"] + 2 * grow}
            self.rect(layer, fill=_rlcol(rgb, a * 0.055 * (1.0 - f) ** 0.5 + a * 0.012),
                      radius=radius + grow)

    def gradient(self, el, angle_css: float, stops, radius: float):
        """Clip to the box, then run a linear gradient across it."""
        c = self.c
        c.saveState()
        p = c.beginPath()
        x, y = self.xy(el["x"], el["y"], el["h"])
        w, h = el["w"] * self.k, el["h"] * self.k
        r = min(radius * self.k, w / 2, h / 2)
        if r > 0.5:
            p.roundRect(x, y, w, h, r)
        else:
            p.rect(x, y, w, h)
        c.clipPath(p, stroke=0, fill=0)
        # CSS 0deg points UP and grows clockwise; convert to a vector across the
        # box and extend it to the corners so the stops land where CSS puts them.
        import math
        th = math.radians(angle_css)
        vx, vy = math.sin(th), -math.cos(th)          # +y is up in PDF space
        cx, cy = x + w / 2, y + h / 2
        half = (abs(vx) * w + abs(vy) * h) / 2
        c.linearGradient(cx - vx * half, cy - vy * half, cx + vx * half, cy + vy * half,
                         [_rlcol(col, alpha) for _, col, alpha in stops],
                         [pos for pos, _, _ in stops], extend=True)
        c.restoreState()

    def text(self, el):
        txt = (el.get("text") or "").strip()
        if not txt:
            return
        size = el.get("fontSize", 16) * self.k
        weight = str(el.get("fontWeight", "400"))
        bold = weight in ("bold", "bolder") or (weight.isdigit() and int(weight) >= 600)
        italic = bool(el.get("italic"))
        font = "Helvetica" + ("-Bold" if bold and not italic else
                              "-BoldOblique" if bold else "-Oblique" if italic else "")
        self.c.setFont(font, size)
        self.c.setFillColor(_col(el.get("color"), default=Color(0, 0, 0)))
        # The browser already wrapped this; the box top plus one ascent puts the
        # baseline where Chromium drew it.
        x, y = self.xy(el["x"], el["y"] + el.get("fontSize", 16) * 0.82)
        align = el.get("align")
        if align == "center":
            self.c.drawCentredString(x + el["w"] * self.k / 2, y, txt)
        elif align == "right":
            self.c.drawRightString(x + el["w"] * self.k, y, txt)
        else:
            self.c.drawString(x, y, txt)

    def path(self, el):
        subs = _flatten_path(el.get("d") or "")
        if not subs:
            return 0
        allpts = [pt for sp in subs for pt in sp]
        minx = min(p[0] for p in allpts)
        miny = min(p[1] for p in allpts)
        fill = _col(el.get("fillC"))
        stroke = _col(el.get("stroke"))
        lw = el.get("strokeWidth", 0) * self.k
        for sp in subs:
            p = self.c.beginPath()
            x0, y0 = self.xy(el["x"] + sp[0][0] - minx, el["y"] + sp[0][1] - miny)
            p.moveTo(x0, y0)
            for px, py in sp[1:]:
                xx, yy = self.xy(el["x"] + px - minx, el["y"] + py - miny)
                p.lineTo(xx, yy)
            closed = abs(sp[0][0] - sp[-1][0]) < 0.01 and abs(sp[0][1] - sp[-1][1]) < 0.01
            if closed:
                p.close()
            if fill is not None and closed:
                self.c.setFillColor(fill)
            if stroke is not None:
                self.c.setStrokeColor(stroke)
                self.c.setLineWidth(max(0.4, lw))
            self.c.drawPath(p, stroke=1 if stroke is not None else 0,
                            fill=1 if (fill is not None and closed) else 0)
        return len(subs)

    def poly(self, el):
        pts = [float(v) for v in re.findall(r"-?[\d.]+", el.get("points") or "")]
        pairs = list(zip(pts[0::2], pts[1::2]))
        if len(pairs) < 2:
            return 0
        minx = min(p[0] for p in pairs)
        miny = min(p[1] for p in pairs)
        p = self.c.beginPath()
        x0, y0 = self.xy(el["x"] + pairs[0][0] - minx, el["y"] + pairs[0][1] - miny)
        p.moveTo(x0, y0)
        for px, py in pairs[1:]:
            xx, yy = self.xy(el["x"] + px - minx, el["y"] + py - miny)
            p.lineTo(xx, yy)
        fill = _col(el.get("fillC")) if el["tag"] == "polygon" else None
        stroke = _col(el.get("stroke"))
        if el["tag"] == "polygon":
            p.close()
        if fill is not None:
            self.c.setFillColor(fill)
        if stroke is not None:
            self.c.setStrokeColor(stroke)
            self.c.setLineWidth(max(0.4, el.get("strokeWidth", 1) * self.k))
        self.c.drawPath(p, stroke=1 if stroke is not None else 0, fill=1 if fill else 0)
        return 1


SKIP = {"svg", "g", "defs", "style", "script", "br"}


def build(elements: list[dict], out: Path, *, w_pt=842.0, h_pt=None) -> dict:
    h_pt = h_pt if h_pt is not None else w_pt * PX_H / PX_W
    pg = Page(out, w_pt, h_pt)
    made = {"rect": 0, "gradient": 0, "shadow": 0, "text": 0, "path": 0, "poly": 0}

    for el in elements:
        tag = el.get("tag")
        if tag in SKIP:
            continue
        if tag == "path":
            made["path"] += pg.path(el)
            continue
        if tag in ("polyline", "polygon"):
            made["poly"] += pg.poly(el)
            continue

        grad = _parse_linear_gradient(el.get("bgImage") or "")
        bg = _col(el.get("bg"))
        border = _col(el.get("borderC")) if el.get("borderW", 0) > 0 else None
        radius = el.get("radius", 0)
        shadow_css = el.get("boxShadow") or "none"

        if shadow_css != "none" and (bg is not None or grad is not None):
            pg.shadow(el, shadow_css, radius)
            made["shadow"] += 1
        if grad is not None:
            pg.gradient(el, grad[0], grad[1], radius)
            made["gradient"] += 1
            if border is not None:
                pg.rect(el, stroke=border, lw=el["borderW"], radius=radius)
        elif bg is not None or border is not None:
            pg.rect(el, fill=bg, stroke=border, lw=el.get("borderW", 0), radius=radius)
            made["rect"] += 1
        if (el.get("text") or "").strip():
            pg.text(el)
            made["text"] += 1

    out.parent.mkdir(parents=True, exist_ok=True)
    pg.c.save()
    return made


if __name__ == "__main__":
    data = json.loads(Path(sys.argv[1]).read_text())
    dst = Path(sys.argv[2])
    print("emitted:", build(data, dst), "->", dst)
