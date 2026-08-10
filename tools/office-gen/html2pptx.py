#!/usr/bin/env python3
"""
HTML/CSS -> NATIVE, editable pptx shapes. No rasterisation.

THE IDEA. python-pptx cannot lay anything out — it has no font metrics and no
box model, which is the root of every overlap bug in this project. A browser has
both, and we already ship one. So: let the model write HTML/CSS, let Chromium
lay it out, read back `getBoundingClientRect()` and the computed styles for every
element, and emit one native PowerPoint shape per element.

The result is not a picture of a slide. Every rectangle is a rectangle, every
string is editable text, every polyline is a freeform shape you can drag a point
of. That is the difference between this and every html-to-slides tool that
screenshots the page.

It also removes the ceiling on what the model can express. A fixed layout menu
can only produce what was anticipated; HTML can produce whatever the model can
describe, and the browser guarantees it is measured correctly.

Input is the JSON emitted by the measuring script (see measure_js()).
"""
from __future__ import annotations

import copy
import json
import math
import re
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.oxml.ns import nsdecls, qn
from pptx.util import Emu, Inches, Pt
from lxml.etree import fromstring as _fromstring


def parse_xml(xml: str):
    return _fromstring(xml)

# The HTML is authored at this size; everything scales from it.
PX_W, PX_H = 1280, 720
SLIDE_W, SLIDE_H = Inches(13.333), Inches(7.5)
SCALE = SLIDE_W / PX_W          # EMU per CSS pixel


def measure_js() -> str:
    """The script run in the page. Returns one record per visible element."""
    return r"""
(() => {
  const out = [];
  const walk = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const tag = el.tagName.toLowerCase();
    const leaf = el.children.length === 0;
    out.push({
      tag,
      x: r.x, y: r.y, w: r.width, h: r.height,
      bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity,
      bgImage: cs.backgroundImage, boxShadow: cs.boxShadow, transform: cs.transform,
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      borderW: parseFloat(cs.borderTopWidth) || 0, borderC: cs.borderTopColor,
      fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily, italic: cs.fontStyle === 'italic',
      align: cs.textAlign, lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      text: leaf ? (el.textContent || '').trim() : '',
      points: tag === 'polyline' || tag === 'polygon' ? el.getAttribute('points') : null,
      d: tag === 'path' ? el.getAttribute('d') : null,
      stroke: cs.stroke, strokeWidth: parseFloat(cs.strokeWidth) || 0,
      fillC: cs.fill,
      cx: tag === 'circle' ? parseFloat(el.getAttribute('cx')) : null,
      cy: tag === 'circle' ? parseFloat(el.getAttribute('cy')) : null,
      rr: tag === 'circle' ? parseFloat(el.getAttribute('r')) : null,
    });
    for (const c of el.children) walk(c);
  };
  for (const c of document.body.children) walk(c);
  return JSON.stringify(out);
})()
"""


def _rgb(css: str):
    """'rgb(a) -> RGBColor, or None for transparent."""
    if not css:
        return None
    m = re.match(r"rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)", css)
    if not m:
        return None
    r, g, b = (int(float(m.group(i))) for i in (1, 2, 3))
    a = float(m.group(4)) if m.group(4) is not None else 1.0
    if a < 0.02:
        return None
    return RGBColor(r, g, b)


def _rgba(css: str):
    """As _rgb, but keeps the alpha — shadows are mostly alpha."""
    m = re.match(r"rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)", css or "")
    if not m:
        return None, 1.0
    r, g, b = (int(float(m.group(i))) for i in (1, 2, 3))
    a = float(m.group(4)) if m.group(4) is not None else 1.0
    return RGBColor(r, g, b), a


# ── gradients ─────────────────────────────────────────────────────────────────
def _parse_linear_gradient(css: str):
    """`linear-gradient(135deg, rgb(...) 0%, rgb(...) 100%)` -> (angle, stops).

    Only linear gradients. Radial and conic have no OOXML equivalent that keeps
    the shape editable, and a silently-wrong fill is worse than an honest solid.
    """
    if not css or "linear-gradient" not in css:
        return None
    inner = css[css.index("linear-gradient") + len("linear-gradient"):].strip()
    if not inner.startswith("("):
        return None
    depth, end = 0, None
    for i, ch in enumerate(inner):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end is None:
        return None
    body = inner[1:end]

    # Split on commas that are NOT inside rgb(...).
    parts, depth, cur = [], 0, ""
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur.strip())
    if not parts:
        return None

    angle_css = 180.0  # CSS default is "to bottom"
    if parts and not parts[0].lstrip().startswith("rgb"):
        head = parts.pop(0).strip()
        m = re.match(r"(-?[\d.]+)deg", head)
        if m:
            angle_css = float(m.group(1))
        elif head.startswith("to "):
            angle_css = {"to top": 0.0, "to right": 90.0, "to bottom": 180.0,
                         "to left": 270.0}.get(head, 180.0)

    stops = []
    for i, p in enumerate(parts):
        cm = re.match(r"(rgba?\([^)]*\))\s*([\d.]+)?%?", p.strip())
        if not cm:
            continue
        col, alpha = _rgba(cm.group(1))
        if col is None:
            continue
        pos = float(cm.group(2)) / 100.0 if cm.group(2) is not None else (
            i / max(1, len(parts) - 1))
        stops.append((max(0.0, min(1.0, pos)), col, alpha))
    if len(stops) < 2:
        return None
    return angle_css, stops


def _apply_gradient(shape, angle_css: float, stops) -> None:
    f = shape.fill
    f.gradient()
    # CSS measures clockwise from NORTH; OOXML clockwise from EAST; and
    # python-pptx's gradient_angle is COUNTER-clockwise. Composing those:
    #   ooxml_cw = css - 90        gradient_angle = 360 - ooxml_cw
    f.gradient_angle = (450.0 - angle_css) % 360.0
    existing = f.gradient_stops
    # python-pptx creates exactly two stops and exposes no way to add more, so
    # the extra ones go in as raw XML alongside them.
    gs_lst = existing._gsLst
    for gs in list(gs_lst)[2:]:
        gs_lst.remove(gs)
    while len(gs_lst) < len(stops):
        gs_lst.append(copy.deepcopy(gs_lst[-1]))
    for gs, (pos, col, alpha) in zip(list(gs_lst), stops):
        gs.set("pos", str(int(round(pos * 100000))))
        for child in list(gs):
            gs.remove(child)
        clr = parse_xml(
            f'<a:srgbClr {nsdecls("a")} val="{col}">'
            + (f'<a:alpha val="{int(round(alpha * 100000))}"/>' if alpha < 0.999 else "")
            + "</a:srgbClr>")
        gs.append(clr)


# ── shadows ───────────────────────────────────────────────────────────────────
def _apply_shadow(shape, css: str) -> bool:
    """`box-shadow` -> a native outer shadow effect.

    python-pptx exposes only `shadow.inherit`, so this writes the effect list
    directly. Worth the XML: a card without its shadow reads as flat and is the
    single most obvious way a converted layout stops looking designed.
    """
    if not css or css == "none":
        return False
    col, alpha = _rgba(css)
    lengths = [float(x) for x in re.findall(r"(-?[\d.]+)px", css)]
    if col is None or len(lengths) < 2:
        return False
    dx, dy = lengths[0], lengths[1]
    blur = lengths[2] if len(lengths) > 2 else 0.0
    if dx == 0 and dy == 0 and blur == 0:
        return False
    dist = math.hypot(dx, dy)
    # Screen y grows DOWNWARD, which is the same sense as OOXML's clockwise
    # direction, so atan2(dy, dx) needs no flip.
    direction = math.degrees(math.atan2(dy, dx)) % 360.0
    spPr = shape._element.spPr
    for old in spPr.findall(qn("a:effectLst")):
        spPr.remove(old)
    spPr.append(parse_xml(
        f'<a:effectLst {nsdecls("a")}>'
        f'<a:outerShdw blurRad="{int(blur * 12700)}" dist="{int(dist * 12700)}" '
        f'dir="{int(direction * 60000)}" rotWithShape="0">'
        f'<a:srgbClr val="{col}"><a:alpha val="{int(alpha * 100000)}"/></a:srgbClr>'
        f"</a:outerShdw></a:effectLst>"))
    return True


# ── svg paths ─────────────────────────────────────────────────────────────────
def _flatten_path(d: str, steps: int = 16):
    """SVG path data -> a list of subpaths, each a list of (x, y).

    Curves are flattened to line segments because a PowerPoint freeform is a
    polyline: this keeps the shape NATIVE and point-editable, which is the whole
    point, at the cost of curve handles. Previously `d` was collected by the
    measuring script and then never converted, so every path silently vanished —
    the worst of both worlds, since it looked handled.
    """
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?[\d.]+(?:e-?\d+)?", d or "")
    subpaths, cur = [], []
    x = y = 0.0
    sx = sy = 0.0
    prev_c2 = None
    prev_q = None
    i = 0
    cmd = None

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        if re.match(r"[A-Za-z]", toks[i]):
            cmd = toks[i]
            i += 1
            if cmd in "Zz":
                if cur:
                    cur.append((sx, sy))
                    subpaths.append(cur)
                    cur = []
                x, y = sx, sy
                continue
        if i >= len(toks):
            break
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            nx, ny = num(), num()
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            if cur:
                subpaths.append(cur)
            cur = [(x, y)]
            sx, sy = x, y
            cmd = "l" if rel else "L"      # subsequent pairs are implicit lineto
        elif c == "L":
            nx, ny = num(), num()
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            cur.append((x, y))
        elif c == "H":
            nx = num()
            x = x + nx if rel else nx
            cur.append((x, y))
        elif c == "V":
            ny = num()
            y = y + ny if rel else ny
            cur.append((x, y))
        elif c in ("C", "S", "Q", "T"):
            if c == "C":
                x1, y1, x2, y2, nx, ny = (num() for _ in range(6))
                if rel:
                    x1, y1, x2, y2, nx, ny = x + x1, y + y1, x + x2, y + y2, x + nx, y + ny
            elif c == "S":
                x2, y2, nx, ny = (num() for _ in range(4))
                if rel:
                    x2, y2, nx, ny = x + x2, y + y2, x + nx, y + ny
                x1, y1 = (2 * x - prev_c2[0], 2 * y - prev_c2[1]) if prev_c2 else (x, y)
            elif c == "Q":
                qx, qy, nx, ny = (num() for _ in range(4))
                if rel:
                    qx, qy, nx, ny = x + qx, y + qy, x + nx, y + ny
                x1, y1 = x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y)
                x2, y2 = nx + 2 / 3 * (qx - nx), ny + 2 / 3 * (qy - ny)
                prev_q = (qx, qy)
            else:  # T
                nx, ny = num(), num()
                if rel:
                    nx, ny = x + nx, y + ny
                qx, qy = (2 * x - prev_q[0], 2 * y - prev_q[1]) if prev_q else (x, y)
                x1, y1 = x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y)
                x2, y2 = nx + 2 / 3 * (qx - nx), ny + 2 / 3 * (qy - ny)
                prev_q = (qx, qy)
            x0, y0 = x, y
            for s in range(1, steps + 1):
                t = s / steps
                mt = 1 - t
                cur.append((
                    mt ** 3 * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t ** 3 * nx,
                    mt ** 3 * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t ** 3 * ny))
            prev_c2 = (x2, y2)
            x, y = nx, ny
            if c not in ("Q", "T"):
                prev_q = None
        elif c == "A":
            # Arcs are flattened to their endpoint. A correct implementation is
            # a page of trigonometry for a case the generator does not emit; a
            # straight line is visibly wrong rather than silently wrong.
            for _ in range(5):
                num()
            nx, ny = num(), num()
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            cur.append((x, y))
        else:
            i += 1
        if c not in ("C", "S"):
            prev_c2 = None
    if cur:
        subpaths.append(cur)
    return [sp for sp in subpaths if len(sp) >= 2]


def _emu(px: float) -> int:
    return int(px * SCALE)


def _shape(sl, el):
    """A box with a background, gradient, border or shadow -> a native shape."""
    bg = _rgb(el.get("bg"))
    grad = _parse_linear_gradient(el.get("bgImage") or "")
    border = _rgb(el.get("borderC")) if el.get("borderW", 0) > 0 else None
    shadow = (el.get("boxShadow") or "none") != "none"
    if bg is None and border is None and grad is None and not shadow:
        return None
    radius = el.get("radius", 0)
    kind = MSO_SHAPE.ROUNDED_RECTANGLE if radius > 1 else MSO_SHAPE.RECTANGLE
    s = sl.shapes.add_shape(kind, _emu(el["x"]), _emu(el["y"]),
                            _emu(el["w"]), _emu(el["h"]))
    if grad is not None:
        _apply_gradient(s, grad[0], grad[1])
    elif bg is not None:
        s.fill.solid()
        s.fill.fore_color.rgb = bg
    else:
        s.fill.background()
    if border is not None:
        s.line.color.rgb = border
        s.line.width = Pt(el["borderW"] * 0.75)
    else:
        s.line.fill.background()
    s.shadow.inherit = False
    if shadow:
        _apply_shadow(s, el.get("boxShadow"))
    if radius > 1:
        # The adjustment is a fraction of the SHORT side, which is how CSS's
        # absolute pixel radius has to be re-expressed. It read max() until now,
        # so a wide pill got a fraction of its LENGTH and came out barely
        # rounded — visibly wrong on exactly the shapes that use radius most.
        s.adjustments[0] = max(0.0, min(0.5, radius / max(min(el["w"], el["h"]), 1)))
    return s


def _text(sl, el):
    txt = (el.get("text") or "").strip()
    if not txt:
        return None
    tb = sl.shapes.add_textbox(_emu(el["x"]), _emu(el["y"]),
                               _emu(el["w"]), _emu(el["h"]))
    tf = tb.text_frame
    # Reflow OFF: the browser already decided where the line breaks go, and
    # letting PowerPoint re-wrap would throw that measurement away.
    tf.word_wrap = False
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    p = tf.paragraphs[0]
    p.alignment = {"center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT,
                   "justify": PP_ALIGN.JUSTIFY}.get(el.get("align"), PP_ALIGN.LEFT)
    r = p.add_run()
    r.text = txt
    # CSS px -> points at 96dpi.
    r.font.size = Pt(max(6, el.get("fontSize", 16) * 0.75))
    weight = el.get("fontWeight", "400")
    r.font.bold = weight in ("bold", "bolder") or (weight.isdigit() and int(weight) >= 600)
    r.font.italic = bool(el.get("italic"))
    fam = (el.get("fontFamily") or "Helvetica").split(",")[0].strip().strip("'\"")
    r.font.name = fam
    col = _rgb(el.get("color"))
    if col is not None:
        r.font.color.rgb = col
    return tb


def _poly(sl, el):
    """SVG polyline/polygon -> a native freeform shape, still editable."""
    pts = el.get("points")
    if not pts:
        return None
    nums = [float(v) for v in re.findall(r"-?[\d.]+", pts)]
    pairs = list(zip(nums[0::2], nums[1::2]))
    if len(pairs) < 2:
        return None
    ox, oy = el["x"], el["y"]
    # SVG coordinates are relative to the <svg>, and the element's own bbox
    # already accounts for the offset — anchor on the reported box.
    x0, y0 = pairs[0]
    minx = min(p[0] for p in pairs)
    miny = min(p[1] for p in pairs)
    builder = sl.shapes.build_freeform(_emu(ox + (x0 - minx)), _emu(oy + (y0 - miny)))
    builder.add_line_segments(
        [(_emu(ox + (px - minx)), _emu(oy + (py - miny))) for px, py in pairs[1:]],
        close=(el["tag"] == "polygon"))
    shp = builder.convert_to_shape()
    stroke = _rgb(el.get("stroke"))
    poly_fill = _rgb(el.get("fillC") or "") if el["tag"] == "polygon" else None
    if poly_fill is not None:
        shp.fill.solid()
        shp.fill.fore_color.rgb = poly_fill
    else:
        shp.fill.background()
    if stroke is not None:
        shp.line.color.rgb = stroke
        shp.line.width = Pt(max(0.75, el.get("strokeWidth", 2) * 0.75))
    shp.shadow.inherit = False
    return shp


def _path(sl, el):
    """SVG <path> -> one native freeform per subpath."""
    subs = _flatten_path(el.get("d") or "")
    if not subs:
        return 0
    made = 0
    ox, oy = el["x"], el["y"]
    allpts = [pt for sp in subs for pt in sp]
    minx = min(p[0] for p in allpts)
    miny = min(p[1] for p in allpts)
    fill = _rgb(el.get("fillC") or "") or _rgb(el.get("bg"))
    stroke = _rgb(el.get("stroke"))
    for sp in subs:
        closed = abs(sp[0][0] - sp[-1][0]) < 0.01 and abs(sp[0][1] - sp[-1][1]) < 0.01
        b = sl.shapes.build_freeform(_emu(ox + sp[0][0] - minx), _emu(oy + sp[0][1] - miny))
        b.add_line_segments([(_emu(ox + px - minx), _emu(oy + py - miny))
                             for px, py in sp[1:]], close=closed)
        shp = b.convert_to_shape()
        if closed and fill is not None:
            shp.fill.solid()
            shp.fill.fore_color.rgb = fill
        else:
            shp.fill.background()
        if stroke is not None:
            shp.line.color.rgb = stroke
            shp.line.width = Pt(max(0.75, el.get("strokeWidth", 2) * 0.75))
        else:
            shp.line.fill.background()
        shp.shadow.inherit = False
        made += 1
    return made


def _circle(sl, el):
    s = sl.shapes.add_shape(MSO_SHAPE.OVAL, _emu(el["x"]), _emu(el["y"]),
                            _emu(el["w"]), _emu(el["h"]))
    bg = _rgb(el.get("bg")) or _rgb(el.get("stroke"))
    if bg is not None:
        s.fill.solid(); s.fill.fore_color.rgb = bg
    else:
        s.fill.background()
    s.line.fill.background()
    s.shadow.inherit = False
    return s


SKIP = {"svg", "g", "defs", "style", "script", "br"}


def build(elements: list[dict], out: Path, *, existing: Presentation | None = None):
    prs = existing or Presentation()
    prs.slide_width, prs.slide_height = SLIDE_W, SLIDE_H
    sl = prs.slides.add_slide(prs.slide_layouts[6])
    made = {"shape": 0, "text": 0, "poly": 0, "circle": 0, "path": 0}
    for el in elements:
        tag = el.get("tag")
        if tag in SKIP:
            continue
        if tag == "path":
            n = _path(sl, el)
            made["path"] = made.get("path", 0) + n
            continue
        if tag in ("polyline", "polygon"):
            if _poly(sl, el) is not None:
                made["poly"] += 1
            continue
        if tag == "circle":
            _circle(sl, el); made["circle"] += 1
            continue
        if _shape(sl, el) is not None:
            made["shape"] += 1
        if _text(sl, el) is not None:
            made["text"] += 1
    prs.save(str(out))
    return made


if __name__ == "__main__":
    data = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    print("emitted:", build(data, out), "->", out)
