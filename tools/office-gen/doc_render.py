#!/usr/bin/env python3
"""
Spec (JSON) -> .docx, with the design owned here and the words owned by the model.

Same bet as the deck renderer: the model picks a block type from a short menu and
writes the prose; this file owns typography, colour, spacing and the page.

python-docx has no styling conveniences worth the name — shaded paragraphs,
borders and column widths all mean writing raw OOXML. That is why most generated
Word documents look like Times New Roman with bullets: the library makes the
plain thing easy and everything else fiddly. The `_shade`/`_border` helpers below
are the fiddly part, done once.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Emu, Inches, Pt, RGBColor

sys.path.insert(0, str(Path(__file__).parent))
import palette as pal  # noqa: E402

SANS = "Helvetica Neue"
SERIF = "Georgia"


def _rgb(h: str) -> RGBColor:
    return RGBColor.from_string(h.lstrip("#").upper())


def _shade(el, hex_colour: str):
    """Cell/paragraph background. No python-docx API exists; this is the OOXML."""
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_colour.lstrip("#").upper())
    el.append(shd)


def _p_shade(p, hex_colour: str):
    _shade(p._p.get_or_add_pPr(), hex_colour)


def _cell_shade(cell, hex_colour: str):
    _shade(cell._tc.get_or_add_tcPr(), hex_colour)


def _no_borders(table):
    tbl = table._tbl
    pr = tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement(f"w:{edge}")
        e.set(qn("w:val"), "none")
        e.set(qn("w:sz"), "0")
        borders.append(e)
    pr.append(borders)


def _tbl_width(table, inches: float):
    """Pin a table's total width. Setting only the CELL width does nothing —
    Word lays the table out from tblW/tblGrid, so a one-cell rule renders
    full-bleed no matter what width the cell claims. Measured: the accent rule
    under every heading ran the full text column."""
    tblPr = table._tbl.tblPr
    for existing in tblPr.findall(qn("w:tblW")):
        tblPr.remove(existing)
    w = OxmlElement("w:tblW")
    w.set(qn("w:w"), str(int(inches * 1440)))
    w.set(qn("w:type"), "dxa")
    tblPr.append(w)
    for gc in table._tbl.find(qn("w:tblGrid")):
        gc.set(qn("w:w"), str(int(inches * 1440)))


def _rule(doc, colour: str, *, width_pct=18, space_before=2, space_after=10):
    """The accent rule under a heading — a one-cell shaded table, because Word
    has no horizontal-rule primitive that can be coloured and sized."""
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    t.autofit = False
    _no_borders(t)
    c = t.cell(0, 0)
    inches = 6.5 * width_pct / 100
    c.width = Inches(inches)
    _tbl_width(t, inches)
    _cell_shade(c, colour)
    p = c.paragraphs[0]
    p.paragraph_format.space_before = Pt(space_before)
    p.paragraph_format.space_after = Pt(0)
    r = p.add_run()
    r.font.size = Pt(3)
    doc.add_paragraph().paragraph_format.space_after = Pt(space_after)
    return t


def _text(p, s, *, size=11, colour=None, bold=False, italic=False, font=SANS,
          spacing=None):
    r = p.add_run(str(s))
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.italic = italic
    r.font.name = font
    if colour is not None:
        r.font.color.rgb = _rgb(colour)
    if spacing is not None:
        rpr = r._r.get_or_add_rPr()
        el = OxmlElement("w:spacing")
        el.set(qn("w:val"), str(int(spacing * 20)))
        rpr.append(el)
    return r


def _para(doc, *, before=0, after=8, align=None, line=None):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    if align is not None:
        p.alignment = align
    if line is not None:
        pf.line_spacing = line
    return p


# ── blocks ────────────────────────────────────────────────────────────────────
def B_cover(doc, t, b):
    """A full-bleed colour band with the title reversed out of it."""
    tbl = doc.add_table(rows=1, cols=1)
    tbl.autofit = False
    _no_borders(tbl)
    cell = tbl.cell(0, 0)
    cell.width = Inches(6.5)
    _cell_shade(cell, t.deep)
    fg = t.on(t.deep)
    p0 = cell.paragraphs[0]
    p0.paragraph_format.space_before = Pt(54)
    p0.paragraph_format.space_after = Pt(6)
    if b.get("eyebrow"):
        _text(p0, str(b["eyebrow"]).upper(), size=9, colour=t.accent, bold=True, spacing=1.6)
    p1 = cell.add_paragraph()
    p1.paragraph_format.space_after = Pt(10)
    _text(p1, b.get("title", ""), size=30, colour=fg, bold=True)
    if b.get("subtitle"):
        p2 = cell.add_paragraph()
        p2.paragraph_format.space_after = Pt(60)
        _text(p2, b["subtitle"], size=12.5, colour=t.support)
    else:
        p1.paragraph_format.space_after = Pt(60)
    doc.add_paragraph().paragraph_format.space_after = Pt(18)
    if b.get("byline"):
        p = _para(doc, after=16)
        _text(p, b["byline"], size=9.5, colour=t.mute, spacing=0.8)


def B_heading(doc, t, b):
    p = _para(doc, before=16, after=2)
    _text(p, b.get("title", ""), size=17, colour=t.primary, bold=True)
    _rule(doc, t.accent, width_pct=10, space_after=4)
    if b.get("standfirst"):
        p2 = _para(doc, after=10, line=1.35)
        _text(p2, b["standfirst"], size=11.5, colour=t.mute, italic=True)


def B_body(doc, t, b):
    for para in (b.get("paragraphs") or [])[:6]:
        p = _para(doc, after=9, line=1.4)
        _text(p, para, size=11, colour=t.ink)


def B_callout(doc, t, b):
    """A tinted panel with an accent spine — the highest-contrast way to say
    'this bit matters' without shouting."""
    tbl = doc.add_table(rows=1, cols=2)
    tbl.autofit = False
    _no_borders(tbl)
    spine, body = tbl.cell(0, 0), tbl.cell(0, 1)
    spine.width = Inches(0.06)
    body.width = Inches(6.44)
    _cell_shade(spine, t.accent)
    _cell_shade(body, t.faint)
    p = body.paragraphs[0]
    p.paragraph_format.space_before = Pt(10)
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.left_indent = Inches(0.16)
    if b.get("label"):
        _text(p, str(b["label"]).upper(), size=8.5, colour=t.accent, bold=True, spacing=1.4)
        p = body.add_paragraph()
        p.paragraph_format.left_indent = Inches(0.16)
        p.paragraph_format.space_after = Pt(10)
    _text(p, b.get("text", ""), size=11.5, colour=t.ink, bold=True)
    doc.add_paragraph().paragraph_format.space_after = Pt(12)


def B_stats(doc, t, b):
    """A row of oversized numerals. The only reliable way to make a Word page
    stop looking like a Word page."""
    items = (b.get("stats") or [])[:4]
    if not items:
        return
    tbl = doc.add_table(rows=2, cols=len(items))
    tbl.autofit = False
    _no_borders(tbl)
    for i, it in enumerate(items):
        w = Inches(6.5 / len(items))
        top, bot = tbl.cell(0, i), tbl.cell(1, i)
        top.width = bot.width = w
        pv = top.paragraphs[0]
        pv.paragraph_format.space_after = Pt(0)
        _text(pv, it.get("value", ""), size=26, colour=t.primary, bold=True)
        pl = bot.paragraphs[0]
        pl.paragraph_format.space_after = Pt(12)
        _text(pl, it.get("label", ""), size=9, colour=t.mute)
    doc.add_paragraph().paragraph_format.space_after = Pt(10)


def B_table(doc, t, b):
    headers = [str(h) for h in (b.get("headers") or [])]
    rows = (b.get("rows") or [])[:12]
    if not headers:
        return
    tbl = doc.add_table(rows=len(rows) + 1, cols=len(headers))
    tbl.autofit = True
    _no_borders(tbl)
    for c, h in enumerate(headers):
        cell = tbl.cell(0, c)
        _cell_shade(cell, t.deep)
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(5)
        p.paragraph_format.space_after = Pt(5)
        _text(p, h, size=9.5, colour=t.on(t.deep), bold=True)
    for r, row in enumerate(rows, start=1):
        for c in range(len(headers)):
            cell = tbl.cell(r, c)
            if r % 2 == 0:
                _cell_shade(cell, t.faint)
            p = cell.paragraphs[0]
            p.paragraph_format.space_before = Pt(4)
            p.paragraph_format.space_after = Pt(4)
            val = row[c] if isinstance(row, list) and c < len(row) else ""
            _text(p, val, size=10, colour=t.ink, bold=(c == 0))
    doc.add_paragraph().paragraph_format.space_after = Pt(14)


def B_quote(doc, t, b):
    p = _para(doc, before=10, after=4, line=1.3)
    p.paragraph_format.left_indent = Inches(0.35)
    _text(p, "“" + b.get("quote", "") + "”", size=15, colour=t.primary,
          italic=True, font=SERIF)
    if b.get("attribution"):
        p2 = _para(doc, after=14)
        p2.paragraph_format.left_indent = Inches(0.35)
        _text(p2, "— " + b["attribution"], size=9.5, colour=t.mute)


def B_bullets(doc, t, b):
    for item in (b.get("items") or [])[:8]:
        p = _para(doc, after=6, line=1.35)
        p.paragraph_format.left_indent = Inches(0.22)
        _text(p, "▪  ", size=10, colour=t.accent, bold=True)
        _text(p, item, size=11, colour=t.ink)


def B_pagebreak(doc, t, b):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


BLOCKS = {
    "cover": B_cover, "heading": B_heading, "body": B_body, "callout": B_callout,
    "stats": B_stats, "table": B_table, "quote": B_quote, "bullets": B_bullets,
    "pagebreak": B_pagebreak,
}


def build(spec: dict, out: Path) -> Path:
    t = pal.from_spec(spec)
    doc = Document()
    for s in doc.sections:
        s.top_margin = s.bottom_margin = Inches(0.9)
        s.left_margin = s.right_margin = Inches(1.0)
    normal = doc.styles["Normal"]
    normal.font.name = SANS
    normal.font.size = Pt(11)

    for b in spec.get("blocks", []):
        fn = BLOCKS.get(b.get("type"))
        if fn is None:
            fn = B_body
            b = {**b, "paragraphs": b.get("paragraphs") or [b.get("text", "")]}
        try:
            fn(doc, t, b)
        except Exception as err:  # noqa: BLE001
            print(f"  ! block {b.get('type')} failed: {err}")
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    return out


if __name__ == "__main__":
    spec = json.loads(Path(sys.argv[1]).read_text())
    p = build(spec, Path(sys.argv[2]))
    print(f"wrote {p} ({len(spec.get('blocks', []))} blocks)")
