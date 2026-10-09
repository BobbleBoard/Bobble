"""
A chart INTO a document — the chart tool's drawing as native shapes in a
slide, a Word page, a workbook or a PDF.

The user (2026-09-16): "ensure these can be embedded into docs or charts or
whatever, that's mainly the use case, say you put a pdf in and ask the model
to slot a chart in with the data on the second page and also reformat it to
fit the data better, it should be able to do it, whatever chart you ask".

The `chart` tool writes three files beside each other: `<stem>.svg` (the
picture), `<stem>.chart.json` (the spec) and `<stem>.chart.elements.json` —
the chart as MEASURED ELEMENTS, the same records html2pptx / html2docx /
html2pdf read off a browser (tag, x, y, w, h, bg, text, points…), but
computed by the chart's own layout so no browser runs. This module takes
those elements and emits one native shape per record into an EXISTING file:

    pptx  a grouped set of shapes on slide N, inside a box (inches)
    docx  shapes anchored to a paragraph after paragraph N, at a width
    xlsx  a native Excel chart from the spec's data, anchored at a cell
    pdf   drawn onto page N in free space, or on a new page after N

Everything stays editable where the format allows it — a bar is a rectangle
you can drag in PowerPoint, a label is text — and the PDF gets vector
drawing, never a raster. The op is `insert_chart` (office_edit.py); the
harness's `office_edit --chart` builds it, and `office.py apply` runs it
with no model in the loop.
"""
from __future__ import annotations

import io
import json
import re
from pathlib import Path

EMU_PER_IN = 914400
PT_PER_IN = 72.0


# ── the elements file ───────────────────────────────────────────────────────
def elements_for(svg: Path) -> dict:
    """The measured elements written beside a chart's SVG, or a clear error."""
    side = svg.with_name(svg.stem + ".chart.elements.json")
    if not side.is_file():
        raise RuntimeError(
            f"{svg.name} has no {side.name} beside it — it was not made by the chart tool "
            "(make the chart with `chart …`, then put that .svg into the document)")
    data = json.loads(side.read_text())
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
        raise RuntimeError(f"{side.name} is not a chart elements file")
    return data


def spec_for(svg: Path) -> dict:
    side = svg.with_name(svg.stem + ".chart.json")
    if not side.is_file():
        raise RuntimeError(f"{svg.name} has no {side.name} beside it")
    return json.loads(side.read_text())


def _rgb(css: str | None) -> tuple[int, int, int] | None:
    if not css:
        return None
    m = re.match(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", css)
    if m:
        return int(m.group(1)), int(m.group(2)), int(m.group(3))
    m = re.match(r"#([0-9a-fA-F]{6})$", css.strip())
    if m:
        h = m.group(1)
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return None


def _hex(rgb: tuple[int, int, int]) -> str:
    return "%02X%02X%02X" % rgb


def _pairs(points: str | None) -> list[tuple[float, float]]:
    nums = [float(v) for v in re.findall(r"-?[\d.]+(?:e-?\d+)?", points or "")]
    return list(zip(nums[0::2], nums[1::2]))


def _bold(el: dict) -> bool:
    w = str(el.get("fontWeight", "400"))
    return w in ("bold", "bolder") or (w.isdigit() and int(w) >= 600)


def _font_name(el: dict) -> str:
    fam = (el.get("fontFamily") or "Arial").split(",")[0].strip().strip("'\"")
    # The chart's stacks start with system faces; a document wants a name
    # every reader has. Arial, not Helvetica: Windows has no Helvetica, and
    # the canvas's slides editor measures text with opentype.js, which cannot
    # parse macOS's Helvetica.ttc (its cmap format) and falls back to guessed
    # widths — bold capitals came out narrow and "Units Sold" lost its space
    # (SEEN on a chart title). Arial Bold.ttf parses; the title reads right.
    if fam in (
        "-apple-system",
        "system-ui",
        "ui-rounded",
        "SF Pro Rounded",
        "Helvetica",
        "Helvetica Neue",
    ):
        return "Arial"
    if fam in ("SF Mono",):
        return "Menlo"
    if fam in ("Iowan Old Style",):
        return "Georgia"
    return fam


def fit_box(chart_w: float, chart_h: float, box: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """The largest box of the chart's aspect inside `box` (x, y, w, h), centred."""
    x, y, w, h = box
    s = min(w / chart_w, h / chart_h)
    fw, fh = chart_w * s, chart_h * s
    return x + (w - fw) / 2, y + (h - fh) / 2, fw, fh


# ── a picture of the elements (PIL) ─────────────────────────────────────────
def raster(elements: list[dict], width: float, height: float, scale: float = 2.0, paper=None) -> "bytes":
    """The elements drawn to a PNG at `scale`× — for the formats whose in-app
    viewer does not draw anchored shapes (a Word document, a workbook): a
    picture renders everywhere, identically."""
    import io as _io

    from PIL import Image, ImageDraw

    from textfit import _font

    W, H = int(round(width * scale)), int(round(height * scale))
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0) if paper is None else tuple(paper) + (255,))
    d = ImageDraw.Draw(im)

    def S(v):
        return float(v) * scale

    for el in elements:
        tag = el.get("tag")
        if tag == "div":
            bg = _rgb(el.get("bg"))
            if bg is None:
                continue
            x, y, w, h = S(el["x"]), S(el["y"]), S(el["w"]), S(el["h"])
            r = min(S(float(el.get("radius", 0) or 0)), w / 2, h / 2)
            box = (x, y, x + max(w, 1), y + max(h, 1))
            if r > 0.5:
                d.rounded_rectangle(box, radius=r, fill=bg)
            else:
                d.rectangle(box, fill=bg)
        elif tag == "circle":
            bg = _rgb(el.get("bg"))
            if bg is None:
                continue
            cx, cy, rr = S(el.get("cx", el["x"] + el["w"] / 2)), S(el.get("cy", el["y"] + el["h"] / 2)), S(el.get("rr", el["w"] / 2))
            d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=bg)
        elif tag in ("polyline", "polygon"):
            pairs = [(S(px), S(py)) for px, py in _pairs(el.get("points"))]
            if len(pairs) < 2:
                continue
            fill = _rgb(el.get("fillC")) if tag == "polygon" else None
            stroke = _rgb(el.get("stroke"))
            if fill is not None:
                d.polygon(pairs, fill=fill)
            if stroke is not None:
                d.line(pairs, fill=stroke, width=max(1, int(round(S(float(el.get("strokeWidth", 1) or 1))))), joint="curve")
        elif tag == "span":
            txt = (el.get("text") or "").strip()
            if not txt:
                continue
            size = max(4, S(float(el.get("fontSize", 12))))
            fam = _font_name(el)
            font = _font("Georgia" if fam in ("Georgia", "Times") else "Menlo" if fam in ("Menlo", "Courier") else "Helvetica", size, _bold(el))
            colour = _rgb(el.get("color")) or (0, 0, 0)
            x, y, w = S(el["x"]), S(el["y"]), S(el["w"])
            tw = d.textlength(txt, font=font)
            align = el.get("align")
            tx = x + (w - tw) / 2 if align == "center" else x + w - tw if align == "right" else x
            d.text((tx, y), txt, font=font, fill=colour)
    out = _io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


def png_for(svg: Path, scale: float = 2.0) -> tuple[bytes, float, float]:
    """The chart's picture (PNG bytes) and its size in chart px."""
    data = elements_for(svg)
    w, h = float(data["width"]), float(data["height"])
    return raster(data["elements"], w, h, scale), w, h


# ── pptx ────────────────────────────────────────────────────────────────────
def insert_pptx(prs, slide_no: int, svg: Path, box_in: tuple[float, float, float, float] | None) -> dict:
    """The chart as a GROUP of native shapes on slide `slide_no` (1-based)."""
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN
    from pptx.util import Emu, Pt

    slides = list(prs.slides)
    if slide_no < 1 or slide_no > len(slides):
        raise KeyError(f"no slide {slide_no} (the deck has {len(slides)})")
    sl = slides[slide_no - 1]
    data = elements_for(svg)
    cw, ch = float(data["width"]), float(data["height"])
    slide_w_in = prs.slide_width / EMU_PER_IN
    slide_h_in = prs.slide_height / EMU_PER_IN
    if box_in is None:
        # The right half of the content area, under a title if the slide has one.
        top = 0.6
        for sh in sl.shapes:
            if sh.has_text_frame and sh.top is not None and sh.top / EMU_PER_IN < 1.4 and sh.text_frame.text.strip():
                top = max(top, (sh.top + sh.height) / EMU_PER_IN + 0.2)
        box_in = (slide_w_in / 2 + 0.2, top, slide_w_in / 2 - 0.8, slide_h_in - top - 0.6)
    bx, by, bw, bh = fit_box(cw, ch, box_in)
    s = bw / cw  # inches per chart px

    def emu(v: float) -> int:
        return int(round(v * s * EMU_PER_IN))

    group = sl.shapes.add_group_shape()
    made = {"shape": 0, "text": 0, "poly": 0, "circle": 0}
    for el in data["elements"]:
        tag = el.get("tag")
        x, y = bx * EMU_PER_IN + emu(el["x"]), by * EMU_PER_IN + emu(el["y"])
        if tag == "div":
            bg = _rgb(el.get("bg"))
            if bg is None:
                continue
            radius = float(el.get("radius", 0) or 0)
            kind = MSO_SHAPE.ROUNDED_RECTANGLE if radius > 0.5 else MSO_SHAPE.RECTANGLE
            shp = group.shapes.add_shape(kind, Emu(int(x)), Emu(int(y)), Emu(max(emu(el["w"]), 1)), Emu(max(emu(el["h"]), 1)))
            shp.fill.solid()
            shp.fill.fore_color.rgb = RGBColor(*bg)
            shp.line.fill.background()
            shp.shadow.inherit = False
            if radius > 0.5:
                shp.adjustments[0] = max(0.0, min(0.5, radius / max(min(el["w"], el["h"]), 1)))
            made["shape"] += 1
        elif tag == "span":
            txt = (el.get("text") or "").strip()
            if not txt:
                continue
            tb = group.shapes.add_textbox(Emu(int(x)), Emu(int(y)), Emu(max(emu(el["w"]), 1)), Emu(max(emu(el["h"]), 1)))
            tf = tb.text_frame
            tf.word_wrap = False
            # Never shrink-to-fit: the box is an estimate, the size is the design.
            tf.auto_size = MSO_AUTO_SIZE.NONE
            tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
            p = tf.paragraphs[0]
            p.alignment = {"center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(el.get("align"), PP_ALIGN.LEFT)
            r = p.add_run()
            r.text = txt
            r.font.size = Pt(max(5, el.get("fontSize", 12) * s * PT_PER_IN))
            r.font.bold = _bold(el)
            r.font.italic = bool(el.get("italic"))
            r.font.name = _font_name(el)
            col = _rgb(el.get("color"))
            if col is not None:
                r.font.color.rgb = RGBColor(*col)
            made["text"] += 1
        elif tag in ("polyline", "polygon"):
            pairs = _pairs(el.get("points"))
            if len(pairs) < 2:
                continue
            minx = min(p[0] for p in pairs)
            miny = min(p[1] for p in pairs)
            ox, oy = bx * EMU_PER_IN, by * EMU_PER_IN
            b = group.shapes.build_freeform(int(ox + emu(pairs[0][0])), int(oy + emu(pairs[0][1])))
            b.add_line_segments([(int(ox + emu(px)), int(oy + emu(py))) for px, py in pairs[1:]], close=(tag == "polygon"))
            shp = b.convert_to_shape()
            fill = _rgb(el.get("fillC")) if tag == "polygon" else None
            stroke = _rgb(el.get("stroke"))
            if fill is not None:
                shp.fill.solid()
                shp.fill.fore_color.rgb = RGBColor(*fill)
            else:
                shp.fill.background()
            if stroke is not None:
                shp.line.color.rgb = RGBColor(*stroke)
                shp.line.width = Pt(max(0.5, float(el.get("strokeWidth", 1) or 1) * s * PT_PER_IN))
            else:
                shp.line.fill.background()
            shp.shadow.inherit = False
            made["poly"] += 1
            del minx, miny
        elif tag == "circle":
            bg = _rgb(el.get("bg"))
            shp = group.shapes.add_shape(MSO_SHAPE.OVAL, Emu(int(x)), Emu(int(y)), Emu(max(emu(el["w"]), 1)), Emu(max(emu(el["h"]), 1)))
            if bg is not None:
                shp.fill.solid()
                shp.fill.fore_color.rgb = RGBColor(*bg)
            else:
                shp.fill.background()
            shp.line.fill.background()
            shp.shadow.inherit = False
            made["circle"] += 1
    group.name = f"Chart: {svg.stem}"
    return {"slide": slide_no, "box_in": [round(v, 2) for v in (bx, by, bw, bh)], "made": made}


# ── docx ────────────────────────────────────────────────────────────────────
def insert_docx(doc, after_pid: str | None, svg: Path, width_in: float | None) -> dict:
    """The chart as a picture in a new paragraph after `after_pid` (or at the end).

    A picture, not anchored shapes: html2docx's wps shapes are right for Word
    and the app's own docs viewer stacks them at the origin (MEASURED), and a
    chart the user cannot see in the app is not slotted in. A PNG at 2× reads
    the same in Word, Pages and the viewer.
    """
    import io as _io

    from docx.shared import Inches

    png, cw, ch = png_for(svg)
    sec = doc.sections[0]
    avail_in = (sec.page_width - sec.left_margin - sec.right_margin) / EMU_PER_IN
    width_in = min(width_in or avail_in, avail_in)
    paras = doc.paragraphs
    if after_pid is None or after_pid in ("end", "$"):
        p = doc.add_paragraph()
    else:
        idx = int(str(after_pid).lstrip("p"))
        if idx < 0 or idx >= len(paras):
            raise KeyError(f"no paragraph {after_pid} (the document has {len(paras)})")
        anchor_par = paras[idx]
        # python-docx's own parser, so the new element is a CT_P with the
        # paragraph API (lxml's fromstring gives a bare element).
        from docx.oxml import parse_xml
        from docx.oxml.ns import nsdecls
        from docx.text.paragraph import Paragraph
        new_p = parse_xml(f'<w:p {nsdecls("w")}/>')
        anchor_par._p.addnext(new_p)
        p = Paragraph(new_p, anchor_par._parent)
    run = p.add_run()
    run.add_picture(_io.BytesIO(png), width=Inches(width_in))
    return {"after": after_pid or "end", "width_in": round(width_in, 2), "height_in": round(width_in * ch / cw, 2), "made": {"picture": 1}}


# ── xlsx ────────────────────────────────────────────────────────────────────
def insert_xlsx(wb, sheet_name: str | None, anchor: str | None, svg: Path, native: bool = False, width_in: float | None = None) -> dict:
    """The chart at a cell: a picture (what every viewer, the app's included,
    draws), or with `native` an Excel chart of its own from the spec's data —
    live cells, Excel's rendering, the app's viewer shows it small."""
    ws = wb[sheet_name] if sheet_name else wb.active
    if not native:
        import io as _io

        from openpyxl.drawing.image import Image as XlImage

        png, cw, ch = png_for(svg)
        img = XlImage(_io.BytesIO(png))
        # ~6.5 in wide at 96 dpi; the picture is 2× so it stays crisp. A
        # one-cell anchor with an extent: Excel sizes it by the anchor's ext,
        # the app's sheets viewer by the picture's own xfrm — which openpyxl
        # does not write, so `fix_xlsx_drawings` adds it after the save
        # (MEASURED: without it the viewer drew a one-cell thumbnail).
        width_px = int(round((width_in or 5.0) * 96))
        img.width, img.height = width_px, int(width_px * ch / cw)
        ws.add_image(img, anchor or "H2")
        return {"sheet": ws.title, "anchor": anchor or "H2", "data_sheet": None, "chart": "picture"}
    from openpyxl.chart import AreaChart, BarChart, LineChart, PieChart, Reference, ScatterChart, Series

    spec = spec_for(svg)
    series = spec.get("series") or []
    if not series:
        raise RuntimeError("the chart has no data")
    labels = [p.get("label", "") for p in series[0].get("points", [])]
    # The data lives on its own sheet so the chart has cells to point at.
    dname = "Chart data"
    n = 1
    while dname in wb.sheetnames:
        n += 1
        dname = f"Chart data {n}"
    ds = wb.create_sheet(dname)
    ds.append(["Category"] + [s.get("name") or f"Series {i + 1}" for i, s in enumerate(series)])
    for ri, label in enumerate(labels):
        ds.append([label] + [(s.get("points") or [{}] * len(labels))[ri].get("value", 0) for s in series])
    ctype = spec.get("type", "bar")
    palette = ((spec.get("style") or {}).get("palette")) or ["2F6FE4", "E8863A", "3FB3AC", "D9B44A", "9AC05F", "97A3AD"]
    palette = [c.lstrip("#") for c in palette]
    rows = len(labels) + 1
    cols = len(series) + 1
    if ctype == "donut":
        ch = PieChart()
        ch.add_data(Reference(ds, min_col=2, min_row=1, max_row=rows), titles_from_data=True)
        ch.set_categories(Reference(ds, min_col=1, min_row=2, max_row=rows))
    elif ctype == "scatter":
        ch = ScatterChart()
        ch.style = 13
        xref = Reference(ds, min_col=1, min_row=2, max_row=rows)
        for i in range(len(series)):
            yref = Reference(ds, min_col=2 + i, min_row=1, max_row=rows)
            s = Series(yref, xref, title_from_data=True)
            s.marker.symbol = "circle"
            s.graphicalProperties.line.noFill = True
            ch.series.append(s)
    else:
        if ctype in ("line",):
            ch = LineChart()
        elif ctype == "area":
            ch = AreaChart()
        else:
            ch = BarChart()
            ch.type = "bar" if ctype == "hbar" else "col"
            if ctype == "stacked":
                ch.grouping = "stacked"
                ch.overlap = 100
        ch.add_data(Reference(ds, min_col=2, max_col=cols, min_row=1, max_row=rows), titles_from_data=True)
        ch.set_categories(Reference(ds, min_col=1, min_row=2, max_row=rows))
    ch.title = spec.get("title") or None
    ch.width, ch.height = 18, 9
    if ctype != "donut":
        for i, s in enumerate(ch.series):
            colour = palette[i % len(palette)]
            try:
                s.graphicalProperties.solidFill = colour
                s.graphicalProperties.line.solidFill = colour
            except Exception:  # noqa: BLE001 — a series type without a fill
                pass
    ws.add_chart(ch, anchor or "H2")
    return {"sheet": ws.title, "anchor": anchor or "H2", "data_sheet": dname, "chart": ctype}


# ── pdf ─────────────────────────────────────────────────────────────────────
def _pdf_libs():
    try:
        import pypdf  # noqa: F401
    except ImportError as err:
        raise RuntimeError("putting a chart into a PDF needs the pypdf library "
                           "(pip install pypdf into the office pipeline's interpreter)") from err
    from reportlab.lib.colors import Color
    from reportlab.pdfgen import canvas as rl_canvas
    return pypdf, Color, rl_canvas


def free_band(page, pypdf) -> tuple[float, float] | None:
    """The empty band at the FOOT of a page: (bottom_pt, top_pt), from the lowest text/drawing."""
    lows: list[float] = []

    def visit(text, cm, tm, font_dict, font_size):
        if text and text.strip():
            lows.append(float(tm[5]))

    try:
        page.extract_text(visitor_text=visit)
    except Exception:  # noqa: BLE001 — a page with odd content still gets a guess
        return None
    if not lows:
        return None
    lowest = min(lows)
    return (0.0, max(0.0, lowest - 14))


def _paint(c, elements: list[dict], k: float, ox_pt: float, oy_pt_top: float, page_h: float, Color):
    """Draw elements (chart px) with reportlab at `k` points per px, top-left at (ox, oy_top)."""
    def col(css):
        rgb = _rgb(css)
        return None if rgb is None else Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255)

    def xy(x, y, h=0.0):
        return ox_pt + x * k, page_h - (oy_pt_top + (y + h) * k)

    for el in elements:
        tag = el.get("tag")
        if tag == "div":
            fill = col(el.get("bg"))
            if fill is None:
                continue
            x, y = xy(el["x"], el["y"], el["h"])
            w, h = el["w"] * k, el["h"] * k
            c.setFillColor(fill)
            r = min(float(el.get("radius", 0) or 0) * k, w / 2, h / 2)
            if r > 0.5:
                c.roundRect(x, y, w, h, r, stroke=0, fill=1)
            else:
                c.rect(x, y, w, h, stroke=0, fill=1)
        elif tag == "circle":
            fill = col(el.get("bg"))
            if fill is None:
                continue
            cx, cy = xy(el.get("cx", el["x"] + el["w"] / 2), el.get("cy", el["y"] + el["h"] / 2))
            c.setFillColor(fill)
            c.circle(cx, cy, max(0.5, float(el.get("rr", el["w"] / 2)) * k), stroke=0, fill=1)
        elif tag in ("polyline", "polygon"):
            pairs = _pairs(el.get("points"))
            if len(pairs) < 2:
                continue
            p = c.beginPath()
            x0, y0 = xy(pairs[0][0], pairs[0][1])
            p.moveTo(x0, y0)
            for px, py in pairs[1:]:
                xx, yy = xy(px, py)
                p.lineTo(xx, yy)
            fill = col(el.get("fillC")) if tag == "polygon" else None
            stroke = col(el.get("stroke"))
            if tag == "polygon":
                p.close()
            if fill is not None:
                c.setFillColor(fill)
            if stroke is not None:
                c.setStrokeColor(stroke)
                c.setLineWidth(max(0.4, float(el.get("strokeWidth", 1) or 1) * k))
                c.setLineJoin(1)
                c.setLineCap(1)
            c.drawPath(p, stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)
        elif tag == "span":
            txt = (el.get("text") or "").strip()
            if not txt:
                continue
            size = max(3.0, float(el.get("fontSize", 12)) * k)
            fam = _font_name(el)
            base = "Courier" if fam in ("Menlo", "Courier") else "Times" if fam in ("Georgia", "Times") else "Helvetica"
            bold = _bold(el)
            italic = bool(el.get("italic"))
            if base == "Times":
                font = "Times-" + ("BoldItalic" if bold and italic else "Bold" if bold else "Italic" if italic else "Roman")
            else:
                font = base + ("-BoldOblique" if bold and italic else "-Bold" if bold else "-Oblique" if italic else "")
            c.setFont(font, size)
            fill = col(el.get("color")) or Color(0, 0, 0)
            c.setFillColor(fill)
            x, y = xy(el["x"], el["y"] + float(el.get("fontSize", 12)) * 0.82)
            align = el.get("align")
            if align == "center":
                c.drawCentredString(x + el["w"] * k / 2, y, txt)
            elif align == "right":
                c.drawRightString(x + el["w"] * k, y, txt)
            else:
                c.drawString(x, y, txt)


def insert_pdf(src: Path, dst: Path, page_no: int, svg: Path, box_in: tuple[float, float, float, float] | None, place: str = "auto") -> dict:
    """Draw the chart onto page `page_no` in free space, or on a new page after it."""
    pypdf, Color, rl_canvas = _pdf_libs()
    data = elements_for(svg)
    cw, ch = float(data["width"]), float(data["height"])
    reader = pypdf.PdfReader(str(src))
    pages = list(reader.pages)
    if page_no < 1 or page_no > len(pages):
        raise KeyError(f"no page {page_no} (the PDF has {len(pages)})")
    page = pages[page_no - 1]
    pw, ph = float(page.mediabox.width), float(page.mediabox.height)
    margin = 0.6 * PT_PER_IN
    where = place
    box_pt: tuple[float, float, float, float] | None = None
    if box_in is not None:
        box_pt = tuple(v * PT_PER_IN for v in box_in)  # type: ignore[assignment]
        where = "box"
    elif place in ("auto", "below"):
        band = free_band(page, pypdf)
        # Free space at the foot of the page, if the chart can stand there at
        # readable size (2.4 in tall); otherwise its own page after this one.
        need = 2.4 * PT_PER_IN
        if band is not None and band[1] - margin >= need:
            top_pt = ph - band[1] + 8
            box_pt = (margin, top_pt, pw - 2 * margin, band[1] - margin - 8)
            where = "below"
        else:
            where = "new-page"
    else:
        where = "new-page"
    writer = pypdf.PdfWriter()
    for p in pages:
        writer.add_page(p)
    if where == "new-page":
        new = writer.insert_blank_page(width=pw, height=ph, index=page_no)
        target = new
        target_no = page_no + 1
        box_pt = (margin, margin * 1.5, pw - 2 * margin, ph - 3 * margin)
    else:
        target = writer.pages[page_no - 1]
        target_no = page_no
    assert box_pt is not None
    bx, by, bw, bh = fit_box(cw, ch, box_pt)  # y is from the TOP of the page, in points
    if where == "new-page":
        # Centre vertically on an otherwise empty page; keep the chart in the top half.
        by = min(by, margin * 1.5)
    k = bw / cw
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(pw, ph))
    _paint(c, data["elements"], k, bx, by, ph, Color)
    c.save()
    buf.seek(0)
    overlay = pypdf.PdfReader(buf).pages[0]
    target.merge_page(overlay)
    with open(dst, "wb") as fh:
        writer.write(fh)
    return {"page": target_no, "placed": where, "box_in": [round(v / PT_PER_IN, 2) for v in (bx, by, bw, bh)], "pages": len(writer.pages)}


def fix_xlsx_drawings(path: Path) -> int:
    """Give every picture in a saved workbook the `a:xfrm` its anchor implies.

    openpyxl writes a one-cell anchor's size on the ANCHOR (`xdr:ext`) and
    leaves the picture's own transform out; Excel reads the anchor, the app's
    sheets viewer reads the picture — and drew a one-cell thumbnail. Both
    read a picture that carries both. Returns how many were patched.
    """
    import re as _re
    import shutil
    import zipfile

    patched = 0
    tmp = path.with_name(path.name + ".fixing")
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename.startswith("xl/drawings/drawing") and item.filename.endswith(".xml"):
                xml = data.decode("utf-8")

                def add_xfrm(m):
                    nonlocal patched
                    anchor = m.group(0)
                    if "a:xfrm" in anchor:
                        return anchor
                    ext = _re.search(r'<ext cx="(\d+)" cy="(\d+)"/>', anchor)
                    if ext is None:
                        return anchor
                    xfrm = (f'<a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                            f'<a:off x="0" y="0"/><a:ext cx="{ext.group(1)}" cy="{ext.group(2)}"/></a:xfrm>')
                    patched += 1
                    return anchor.replace("<spPr>", "<spPr>" + xfrm, 1)

                xml = _re.sub(r"<oneCellAnchor>.*?</oneCellAnchor>", add_xfrm, xml, flags=_re.S)
                data = xml.encode("utf-8")
            zout.writestr(item, data)
    shutil.move(str(tmp), str(path))
    return patched
