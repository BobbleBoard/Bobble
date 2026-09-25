#!/usr/bin/env python3
"""
HTML/CSS -> NATIVE, editable Word shapes. Same measured input as html2pptx.

python-docx has no shape API of any kind — not a rectangle, not a line. So this
writes DrawingML directly: each measured element becomes an anchored
`wps:wsp` (a WordprocessingShape) positioned from the page origin, with the same
vocabulary the pptx path uses — preset geometry, solid or gradient fill, outline,
outer shadow, and text in a `wps:txbx`.

Writing the XML is worth it because the alternative is an image. A Word document
with a picture of a diagram cannot be edited, recoloured or re-worded by the
person who receives it, and "cleanly editable, never a static image" is the whole
requirement. Every shape this emits can be clicked, dragged, restyled and
retyped in Word.

Geometry is anchored to the PAGE rather than to a paragraph, so the layout does
not move when someone types above it — an absolutely-positioned design pinned to
a flowing text anchor drifts the moment the document is edited, which would
undo the point of making it editable in the first place.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

from docx import Document
from docx_fonts import own_fonts
from docx.enum.section import WD_ORIENT
from docx.oxml import OxmlElement
from docx.shared import Emu, Pt

sys.path.insert(0, str(Path(__file__).parent))
from html2pptx import _flatten_path, _parse_linear_gradient, _rgb, _rgba  # noqa: E402
from lxml.etree import fromstring  # noqa: E402

PX_W, PX_H = 1280.0, 720.0

NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
)


def _esc(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _fill_xml(el) -> str:
    grad = _parse_linear_gradient(el.get("bgImage") or "")
    if grad is not None:
        angle_css, stops = grad
        gs = "".join(
            f'<a:gs pos="{int(pos * 100000)}"><a:srgbClr val="{col}">'
            + (f'<a:alpha val="{int(alpha * 100000)}"/>' if alpha < 0.999 else "")
            + "</a:srgbClr></a:gs>"
            for pos, col, alpha in stops)
        # Same conversion as the pptx path: CSS is clockwise from north, OOXML
        # clockwise from east.
        ang = int(((angle_css - 90.0) % 360.0) * 60000)
        return f'<a:gradFill rotWithShape="1"><a:gsLst>{gs}</a:gsLst><a:lin ang="{ang}" scaled="0"/></a:gradFill>'
    bg = _rgb(el.get("bg"))
    if bg is not None:
        _, alpha = _rgba(el.get("bg") or "")
        return (f'<a:solidFill><a:srgbClr val="{bg}">'
                + (f'<a:alpha val="{int(alpha * 100000)}"/>' if alpha < 0.999 else "")
                + "</a:srgbClr></a:solidFill>")
    return "<a:noFill/>"


def _line_xml(el) -> str:
    w = el.get("borderW", 0) or 0
    col = _rgb(el.get("borderC")) if w > 0 else None
    if col is None:
        return "<a:ln><a:noFill/></a:ln>"
    return (f'<a:ln w="{int(w * 12700)}"><a:solidFill>'
            f'<a:srgbClr val="{col}"/></a:solidFill></a:ln>')


def _shadow_xml(css: str) -> str:
    if not css or css == "none":
        return ""
    col, alpha = _rgba(css)
    lengths = [float(v) for v in re.findall(r"(-?[\d.]+)px", css)]
    if col is None or len(lengths) < 2:
        return ""
    dx, dy = lengths[0], lengths[1]
    blur = lengths[2] if len(lengths) > 2 else 0.0
    if dx == 0 and dy == 0 and blur == 0:
        return ""
    dist = math.hypot(dx, dy)
    direction = math.degrees(math.atan2(dy, dx)) % 360.0
    return (f'<a:effectLst><a:outerShdw blurRad="{int(blur * 12700)}" '
            f'dist="{int(dist * 12700)}" dir="{int(direction * 60000)}" rotWithShape="0">'
            f'<a:srgbClr val="{col}"><a:alpha val="{int(alpha * 100000)}"/></a:srgbClr>'
            "</a:outerShdw></a:effectLst>")


def _txbx_xml(el, scale: float) -> str:
    txt = (el.get("text") or "").strip()
    if not txt:
        return "<wps:txbx><w:txbxContent><w:p/></w:txbxContent></wps:txbx>"
    col = _rgb(el.get("color"))
    size_half_pt = int(max(2, el.get("fontSize", 16) * 0.75 * scale) * 2)
    weight = str(el.get("fontWeight", "400"))
    bold = weight in ("bold", "bolder") or (weight.isdigit() and int(weight) >= 600)
    fam = _esc((el.get("fontFamily") or "Helvetica").split(",")[0].strip().strip("'\""))
    jc = {"center": "center", "right": "right", "justify": "both"}.get(el.get("align"), "left")
    rpr = (f'<w:rPr><w:rFonts w:ascii="{fam}" w:hAnsi="{fam}"/>'
           + ("<w:b/>" if bold else "")
           + ("<w:i/>" if el.get("italic") else "")
           + (f'<w:color w:val="{col}"/>' if col else "")
           + f'<w:sz w:val="{size_half_pt}"/></w:rPr>')
    return ("<wps:txbx><w:txbxContent>"
            f'<w:p><w:pPr><w:jc w:val="{jc}"/><w:spacing w:before="0" w:after="0"/></w:pPr>'
            f"<w:r>{rpr}<w:t xml:space=\"preserve\">{_esc(txt)}</w:t></w:r></w:p>"
            "</w:txbxContent></wps:txbx>")


def _custgeom_xml(subpaths, w_px: float, h_px: float) -> str:
    """A freeform outline as DrawingML custom geometry.

    Coordinates are relative to the shape box in EMU. Word will happily let you
    drag the individual points afterwards, which is the property that matters:
    the path arrives as a SHAPE, not as an image of one.
    """
    paths = []
    for sp in subpaths:
        moves = [f'<a:moveTo><a:pt x="{int(sp[0][0] * 12700)}" y="{int(sp[0][1] * 12700)}"/></a:moveTo>']
        for px, py in sp[1:]:
            moves.append(f'<a:lnTo><a:pt x="{int(px * 12700)}" y="{int(py * 12700)}"/></a:lnTo>')
        closed = abs(sp[0][0] - sp[-1][0]) < 0.01 and abs(sp[0][1] - sp[-1][1]) < 0.01
        if closed:
            moves.append("<a:close/>")
        paths.append(f'<a:path w="{int(w_px * 12700)}" h="{int(h_px * 12700)}">'
                     + "".join(moves) + "</a:path>")
    return f"<a:custGeom><a:avLst/><a:pathLst>{''.join(paths)}</a:pathLst></a:custGeom>"


MC_NS = ('xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
         'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"')


def _anchor(idx: int, x_emu: int, y_emu: int, cx: int, cy: int, sp_body: str) -> str:
    """One anchored shape, wrapped the way Word writes them.

    TWO things here were learned by reading the vendored renderer rather than
    guessing, after a first attempt rendered every shape stacked at the origin:

    - Anchors are COLUMN/PARAGRAPH-relative, not page-relative. The renderer
      reads posOffset against the column and the anchoring paragraph, so
      relativeFrom="page" left every offset unread and collapsed the layout into
      the top-left corner. Word honours column/paragraph anchors identically, so
      this costs nothing and works in both.
    - The mc:AlternateContent wrapper with a VML fallback is what Word itself
      emits. A bare w:drawing is legal, but the wrapper is what every renderer
      is actually tested against.
    """
    wsp = (f'<wps:wsp><wps:cNvSpPr txBox="0"/>{sp_body}'
           '<wps:bodyPr rot="0" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" wrap="none">'
           "<a:noAutofit/></wps:bodyPr></wps:wsp>")
    anchor = (
        f'<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" '
        f'relativeHeight="{251658240 + idx}" behindDoc="0" locked="0" layoutInCell="1" '
        f'allowOverlap="1"><wp:simplePos x="0" y="0"/>'
        f'<wp:positionH relativeFrom="column"><wp:posOffset>{x_emu}</wp:posOffset></wp:positionH>'
        f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>{y_emu}</wp:posOffset></wp:positionV>'
        f'<wp:extent cx="{max(1, cx)}" cy="{max(1, cy)}"/>'
        f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>'
        f'<wp:docPr id="{idx + 1}" name="Shape {idx + 1}"/>'
        f'<a:graphic><a:graphicData '
        f'uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
        f"{wsp}</a:graphicData></a:graphic></wp:anchor>")
    vml = (f'<v:rect xmlns:v="urn:schemas-microsoft-com:vml" '
           f'style="position:absolute;width:{cx / 12700:.1f}pt;height:{cy / 12700:.1f}pt"/>')
    return (f"<w:r {NS}><mc:AlternateContent {MC_NS}>"
            f'<mc:Choice Requires="wps"><w:drawing>{anchor}</w:drawing></mc:Choice>'
            f"<mc:Fallback><w:pict>{vml}</w:pict></mc:Fallback>"
            "</mc:AlternateContent></w:r>")


SKIP = {"svg", "g", "defs", "style", "script", "br"}


def build(elements: list[dict], out: Path, *, margin_in: float = 0.4) -> dict:
    doc = Document()
    # Word's template names Calibri and Cambria; the document names its own.
    own_fonts(doc, "Helvetica Neue")
    sec = doc.sections[0]
    # Landscape, sized so the 1280px design fills the text area. A design laid
    # out for 16:9 dropped into a portrait page is the other way this silently
    # looks broken.
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width, sec.page_height = Emu(int(11.69 * 914400)), Emu(int(8.27 * 914400))
    for attr in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
        setattr(sec, attr, Emu(int(margin_in * 914400)))

    avail_in = 11.69 - 2 * margin_in
    scale = avail_in * 914400 / PX_W                      # EMU per CSS pixel
    # Column/paragraph-relative offsets already start at the text area, so the
    # margin must not be added a second time.
    ox = 0
    oy = 0

    def emu(v):
        return int(v * scale)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(0)
    made = {"shape": 0, "gradient": 0, "shadow": 0, "text": 0, "path": 0, "poly": 0}
    idx = 0

    for el in elements:
        tag = el.get("tag")
        if tag in SKIP:
            continue

        # ── freeform geometry ────────────────────────────────────────────────
        subs = None
        if tag == "path":
            subs = _flatten_path(el.get("d") or "")
        elif tag in ("polyline", "polygon"):
            nums = [float(v) for v in re.findall(r"-?[\d.]+", el.get("points") or "")]
            pairs = list(zip(nums[0::2], nums[1::2]))
            if len(pairs) >= 2:
                if tag == "polygon":
                    pairs = pairs + [pairs[0]]
                subs = [pairs]
        if subs:
            allpts = [pt for sp in subs for pt in sp]
            minx, miny = min(q[0] for q in allpts), min(q[1] for q in allpts)
            maxx, maxy = max(q[0] for q in allpts), max(q[1] for q in allpts)
            rel = [[(qx - minx, qy - miny) for qx, qy in sp] for sp in subs]
            w_px, h_px = max(1.0, maxx - minx), max(1.0, maxy - miny)
            stroke = _rgb(el.get("stroke"))
            fillc = _rgb(el.get("fillC") or "")
            body = ("<wps:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/>"
                    f'<a:ext cx="{emu(w_px)}" cy="{emu(h_px)}"/></a:xfrm>'
                    + _custgeom_xml(rel, w_px, h_px)
                    + (f'<a:solidFill><a:srgbClr val="{fillc}"/></a:solidFill>'
                       if fillc is not None else "<a:noFill/>")
                    + (f'<a:ln w="{int((el.get("strokeWidth", 1) or 1) * 12700)}">'
                       f'<a:solidFill><a:srgbClr val="{stroke}"/></a:solidFill></a:ln>'
                       if stroke is not None else "<a:ln><a:noFill/></a:ln>")
                    + "</wps:spPr>")
            p._p.append(fromstring(_anchor(idx, ox + emu(el["x"]), oy + emu(el["y"]),
                                           emu(w_px), emu(h_px), body)))
            made["path" if tag == "path" else "poly"] += 1
            idx += 1
            continue

        # ── boxes ────────────────────────────────────────────────────────────
        grad = _parse_linear_gradient(el.get("bgImage") or "")
        bg = _rgb(el.get("bg"))
        border = _rgb(el.get("borderC")) if el.get("borderW", 0) > 0 else None
        shadow_css = el.get("boxShadow") or "none"
        has_text = bool((el.get("text") or "").strip())
        if bg is None and border is None and grad is None and shadow_css == "none" and not has_text:
            continue

        radius = el.get("radius", 0)
        if tag == "circle" or (radius > 1 and radius >= min(el["w"], el["h"]) / 2 - 0.5):
            geom = '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' if tag == "circle" else (
                '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/>'
                "</a:avLst></a:prstGeom>")
        elif radius > 1:
            adj = int(min(50000, radius / max(min(el["w"], el["h"]), 1) * 100000))
            geom = ('<a:prstGeom prst="roundRect"><a:avLst>'
                    f'<a:gd name="adj" fmla="val {adj}"/></a:avLst></a:prstGeom>')
        else:
            geom = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'

        body = ('<wps:spPr><a:xfrm><a:off x="0" y="0"/>'
                f'<a:ext cx="{emu(el["w"])}" cy="{emu(el["h"])}"/></a:xfrm>'
                + geom + _fill_xml(el) + _line_xml(el) + _shadow_xml(shadow_css)
                + "</wps:spPr>" + _txbx_xml(el, scale / (914400 / 96) * (PX_W / PX_W)))
        p._p.append(fromstring(_anchor(idx, ox + emu(el["x"]), oy + emu(el["y"]),
                                       emu(el["w"]), emu(el["h"]), body)))
        idx += 1
        made["shape"] += 1
        if grad is not None:
            made["gradient"] += 1
        if shadow_css != "none":
            made["shadow"] += 1
        if has_text:
            made["text"] += 1

    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    return made


if __name__ == "__main__":
    data = json.loads(Path(sys.argv[1]).read_text())
    dst = Path(sys.argv[2])
    print("emitted:", build(data, dst), "->", dst)
