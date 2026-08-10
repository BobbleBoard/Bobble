#!/usr/bin/env python3
"""
Deck spec (JSON) -> .pptx. Every pixel decided here, not by the model.

THE BET. A 4B model is good at prose and at picking from a short menu. It is bad
at spatial reasoning, EMU arithmetic, colour harmony and holding a grid across a
dozen slides. Asking it for python-pptx puts all four weaknesses on the critical
path. So it emits CONTENT plus a layout name; this file owns the design. The deck
looks the same whether the spec came from a 4B or a frontier model — only the
words change.

V2, after looking at V1 and agreeing it read "template basic":
  - asymmetry everywhere (colour fields, off-centre content) instead of centred
    boxes with a rule under the title;
  - scale contrast — 96pt numerals against 12pt captions;
  - data visualisation drawn as native shapes (viz.py) rather than one default
    bar chart, because a default chart looks like a default chart;
  - a motif (the accent bar) repeated so the deck reads as a set.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

sys.path.insert(0, str(Path(__file__).parent))
import viz  # noqa: E402
import hero  # noqa: E402
import textfit  # noqa: E402

W, H = Inches(13.333), Inches(7.5)
M = Inches(0.9)
GUT = Inches(0.5)
CW = W - 2 * M
FONT = "Helvetica Neue"
# A serif for the one quiet slide. The benchmark deck set its pull quote in
# serif italic and it read as editorial rather than as a slide; the same
# sentence in bold sans reads as a heading. Georgia ships on every Mac.
SERIF = "Georgia"


class Theme:
    def __init__(self, primary, support, accent, deep=None,
                 ink="#141419", paper="#FCFBF8", mute="#75747E", faint="#E7E5DF"):
        c = lambda s: RGBColor.from_string(s.lstrip("#"))
        self.primary, self.support, self.accent = c(primary), c(support), c(accent)
        self.deep = c(deep or primary)
        self.ink, self.paper, self.mute, self.faint = c(ink), c(paper), c(mute), c(faint)


THEMES = {
    "midnight": Theme("1E2761", "CADCFC", "F26B5B", deep="141A3F"),
    "forest": Theme("22452B", "9CBF7E", "E4A045", deep="16301C"),
    "terracotta": Theme("8C3D2B", "E7E1D3", "2F6B6B", deep="63291D"),
    "charcoal": Theme("24262C", "D9DCE1", "E2603F", deep="15171B"),
    "ink": Theme("14203C", "C7D3E8", "D98E32", deep="0C1428"),
}


# ── coercion ─────────────────────────────────────────────────────────────────
def _s(v) -> str:
    """Whatever the model produced -> a string. A 4B hands you a list where the
    schema said string often enough that this is load-bearing, not defensive."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (list, tuple)):
        return "  ".join(_s(x) for x in v if x is not None)
    if isinstance(v, dict):
        for k in ("text", "value", "label", "content"):
            if k in v:
                return _s(v[k])
        return "  ".join(_s(x) for x in v.values())
    return str(v)


def _list(v) -> list:
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return list(v)
    if isinstance(v, dict):
        return list(v.values())
    return [v]


def _num(v, default=0.0) -> float:
    try:
        return float(str(v).replace(",", "").replace("%", "").replace("k", "000").strip())
    except (TypeError, ValueError):
        return default


# ── primitives ───────────────────────────────────────────────────────────────
def _rect(sl, x, y, w, h, colour, *, radius=None):
    shape = MSO_SHAPE.ROUNDED_RECTANGLE if radius is not None else MSO_SHAPE.RECTANGLE
    s = sl.shapes.add_shape(shape, int(x), int(y), int(max(w, 1)), int(max(h, 1)))
    s.fill.solid()
    s.fill.fore_color.rgb = colour
    s.line.fill.background()
    s.shadow.inherit = False
    if radius is not None:
        s.adjustments[0] = radius
    return s


def _tf(sl, x, y, w, h, *, wrap=True):
    tb = sl.shapes.add_textbox(int(x), int(y), int(w), int(h))
    f = tb.text_frame
    f.word_wrap = wrap
    f.margin_left = f.margin_right = f.margin_top = f.margin_bottom = 0
    return f


def _p(tf, text, size, colour, *, bold=False, align=PP_ALIGN.LEFT, after=0,
       line=None, first=False, spacing=None, font=None):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    p.space_after = Pt(after)
    if line:
        p.line_spacing = line
    r = p.add_run()
    r.text = _s(text)
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.name = font or FONT
    r.font.color.rgb = colour
    if spacing is not None:
        # Letter-spacing has no python-pptx API; set it on the run properties.
        r.font._rPr.set("spc", str(int(spacing * 100)))
    return p


def _blank(prs):
    return prs.slides.add_slide(prs.slide_layouts[6])


def _bg(sl, colour):
    return _rect(sl, 0, 0, W, H, colour)


def _kicker(sl, t, text, x=None, y=None, colour=None):
    if not text:
        return
    tf = _tf(sl, x or M, y or Inches(0.72), CW, Inches(0.28))
    _p(tf, _s(text).upper(), 10.5, colour or t.accent, bold=True, first=True, spacing=1.4)


# SUPERSEDED by textfit.py, which measures against the real font file instead
# of estimating. Kept only for the few call sites that just want a rough count.
# python-pptx has no font metrics and no layout engine, so wrapping has to be
# PREDICTED. Getting it wrong is not a subtle defect: text lands on top of other
# text. V1 used a fixed characters-per-line constant, which is wrong the moment
# the font size changes — at 52pt it over-estimated the line length badly and
# put a subtitle through the third line of a title.
#
# This estimates from the actual box width and point size. Helvetica Neue
# averages about 0.5 em per character (0.54 bold), and word wrapping is always
# worse than character wrapping because words do not split, hence the 0.92.
def _nlines(text, box_inches, size, *, bold=False):
    text = _s(text)
    if not text:
        return 1
    char_in = size * (0.54 if bold else 0.50) / 72.0
    per_line = max(6, (box_inches / char_in) * 0.92)
    return max(1, int(-(-len(text) // per_line)))


def _text_height(text, box_inches, size, *, bold=False, line=1.05):
    """Rendered height in EMU, for stacking things underneath."""
    n = _nlines(text, box_inches, size, bold=bold)
    return Inches(n * size * line / 72.0)


def _lines(text, cpl):
    return max(1, -(-len(_s(text)) // cpl))


def _fit(text, box_inches, sizes, max_lines, *, bold=False, font=FONT):
    """Largest size that fits, plus the exact lines. Real metrics, not a guess."""
    return textfit.fit_size(_s(text), box_inches * 72, sizes, max_lines,
                            font=font, bold=bold)


def _block(sl, text, x, y, box_inches, sizes, max_lines, colour, *, bold=False,
           font=FONT, line=1.05, spacing=None):
    """Measure, wrap, then write each line as its own paragraph with reflow OFF.
    What we measured is exactly what renders."""
    size, lines = _fit(text, box_inches, sizes, max_lines, bold=bold, font=font)
    h = Inches(textfit.height_pt(len(lines), size, line) / 72 + 0.06)
    tf = _tf(sl, x, y, Inches(box_inches), h, wrap=False)
    for i, ln in enumerate(lines):
        _p(tf, ln, size, colour, bold=bold, first=(i == 0), line=line,
           font=font, spacing=spacing)
    return y + h, size, len(lines)


def _head(sl, t, s, *, y=Inches(1.28), width=0.82):
    _kicker(sl, t, s.get("kicker"))
    end, _sz, _n = _block(sl, s.get("title"), M, y, 11.5 * width,
                          [34, 30, 26, 22], 2, t.ink, bold=True, line=1.04)
    ry = end + Inches(0.10)
    _rect(sl, M, ry, Inches(0.62), Pt(4), t.accent)
    return ry + Inches(0.5)


# ── layouts ──────────────────────────────────────────────────────────────────
def L_title(prs, t, s):
    sl = _blank(prs)
    _bg(sl, t.deep)
    # Asymmetric colour field off the right edge. This one shape is most of the
    # difference between "designed" and "default".
    _rect(sl, W * 0.62, 0, W * 0.38, H, t.primary)
    _rect(sl, W * 0.62, 0, Inches(0.09), H, t.accent)
    _rect(sl, M, Inches(2.28), Inches(1.3), Pt(7), t.accent)
    end, _sz, _n = _block(sl, s.get("title"), M, Inches(2.72), 7.3,
                          [52, 46, 40, 34], 3, t.paper, bold=True, line=1.04)
    sub_y = end + Inches(0.3)
    if s.get("subtitle"):
        tf2 = _tf(sl, M, sub_y, W * 0.48, Inches(0.9))
        _p(tf2, s["subtitle"], 17, t.support, line=1.3, first=True)
    if s.get("footnote"):
        tf3 = _tf(sl, M, H - Inches(0.95), W * 0.5, Inches(0.3))
        _p(tf3, s["footnote"], 10.5, t.support, first=True, spacing=0.8)
    return sl


def L_section(prs, t, s):
    sl = _blank(prs)
    _bg(sl, t.deep)
    # Oversized numeral — scale contrast as the whole idea of the slide.
    num = _s(s.get("number") or "")
    if num:
        tf0 = _tf(sl, M - Inches(0.22), Inches(1.4), Inches(5.4), Inches(3.4))
        _p(tf0, str(num).zfill(2), 150, t.primary, bold=True, line=0.9, first=True)
    _rect(sl, M, Inches(4.62), Inches(1.3), Pt(7), t.accent)
    t_top = Inches(4.95)
    t_end, _sz, _n = _block(sl, s.get("title"), M, t_top, 8.6,
                            [36, 31, 27], 2, t.paper, bold=True, line=1.05)
    if s.get("summary"):
        # BELOW the title, then SHRUNK until it fits above the bottom margin.
        # The previous attempt clamped its y upward instead, which slid a long
        # summary back into the title — a worse bug than the overflow it fixed.
        s_top = t_end + Inches(0.18)
        max_lines = max(1, int((H - M - s_top) / Inches(0.25)))
        _block(sl, s["summary"], M, s_top, 9.4, [13.5, 12.5, 11.5, 10.5],
               min(4, max_lines), t.support, line=1.32)
    return sl


def L_bullets(prs, t, s):
    sl = _blank(prs)
    _bg(sl, t.paper)
    _rect(sl, 0, 0, Inches(0.16), H, t.primary)   # spine motif
    y = _head(sl, t, s)
    for i, b in enumerate(_list(s.get("bullets"))[:5]):
        cy = y + i * Inches(0.92)
        _rect(sl, M, cy + Inches(0.13), Inches(0.2), Inches(0.2), t.accent, radius=0.5)
        tf = _tf(sl, M + Inches(0.5), cy, CW * 0.78, Inches(0.8))
        _p(tf, b, 16, t.ink, line=1.35, first=True)
    return sl


def L_two_column(prs, t, s):
    sl = _blank(prs)
    _bg(sl, t.paper)
    y = _head(sl, t, s)
    cw = (CW - GUT) / 2
    for i, col in enumerate(_list(s.get("columns"))[:2]):
        x = M + i * (cw + GUT)
        _rect(sl, x, y, Inches(0.38), Pt(4), t.accent if i == 0 else t.support)
        tf = _tf(sl, x, y + Inches(0.2), cw, Inches(0.5))
        _p(tf, col.get("heading", ""), 17, t.primary, bold=True, first=True)
        tf2 = _tf(sl, x, y + Inches(0.85), cw, H - y - M - Inches(0.9))
        for j, b in enumerate(_list(col.get("points"))[:5]):
            _p(tf2, b, 14, t.ink, line=1.45, after=13, first=(j == 0))
    return sl


def L_stats(prs, t, s):
    """Oversized numerals on a colour field. No cards — the numbers are the
    design."""
    sl = _blank(prs)
    _bg(sl, t.paper)
    _rect(sl, 0, H * 0.46, W, H * 0.54, t.deep)
    _kicker(sl, t, s.get("kicker"))
    title = _s(s.get("title"))
    ts = 34 if _nlines(title, 9.2, 34, bold=True) == 1 else 27
    tf = _tf(sl, M, Inches(1.24), Inches(9.2), _text_height(title, 9.2, ts, bold=True) + Inches(0.2))
    _p(tf, title, ts, t.ink, bold=True, line=1.05, first=True)
    items = _list(s.get("stats"))[:4]
    n = max(1, len(items))
    cw = CW / n
    for i, it in enumerate(items):
        x = M + i * cw
        tf1 = _tf(sl, x, H * 0.46 + Inches(0.55), cw - Inches(0.3), Inches(1.5))
        _p(tf1, _s(it.get("value")), 76, t.paper, bold=True, line=0.95, first=True)
        _rect(sl, x, H * 0.46 + Inches(1.92), Inches(0.5), Pt(4), t.accent)
        tf2 = _tf(sl, x, H * 0.46 + Inches(2.14), cw - Inches(0.45), Inches(1.0))
        _p(tf2, _s(it.get("label")), 12.5, t.support, line=1.35, first=True)
    if s.get("note"):
        tf3 = _tf(sl, M, H * 0.46 - Inches(0.62), CW * 0.75, Inches(0.5))
        _p(tf3, s["note"], 12.5, t.mute, line=1.3, first=True)
    return sl


def L_comparison(prs, t, s):
    """Split screen, full bleed. The contrast IS the comparison, so no cards."""
    sl = _blank(prs)
    _bg(sl, t.paper)
    y = _head(sl, t, s)
    half = W / 2
    _rect(sl, 0, y - Inches(0.28), half, H - y + Inches(0.28), t.deep)
    _rect(sl, half, y - Inches(0.28), half, H - y + Inches(0.28), t.support)
    for i, side in enumerate(_list(s.get("sides"))[:2]):
        x = (M if i == 0 else half + Inches(0.7))
        fg = t.paper if i == 0 else t.ink
        tf = _tf(sl, x, y + Inches(0.18), half - Inches(1.5), Inches(0.5))
        _p(tf, side.get("heading", ""), 19, fg, bold=True, first=True)
        _rect(sl, x, y + Inches(0.78), Inches(0.42), Pt(4),
              t.accent if i == 0 else t.primary)
        tf2 = _tf(sl, x, y + Inches(1.05), half - Inches(1.6), H - y - Inches(1.5))
        for j, b in enumerate(_list(side.get("points"))[:5]):
            _p(tf2, b, 13.5, fg, line=1.45, after=12, first=(j == 0))
    return sl


def L_bars(prs, t, s):
    """Horizontal bars drawn as shapes — the data-viz workhorse."""
    sl = _blank(prs)
    _bg(sl, t.paper)
    y = _head(sl, t, s)
    items = [{"label": _s(it.get("label")), "value": _num(it.get("value")),
              "display": _s(it.get("display") or it.get("value"))}
             for it in _list(s.get("items"))[:5]]
    hi = s.get("highlight_index")
    if items:
        note_room = Inches(0.9) if s.get("note") else Inches(0.35)
        viz.bar_rows(sl, t, M, y + Inches(0.15), CW * 0.88, items,
                     avail=H - M - y - note_room,
                     highlight=hi if isinstance(hi, int) else 0)
    if s.get("note"):
        tf = _tf(sl, M, H - M - Inches(0.55), CW * 0.8, Inches(0.5))
        _p(tf, s["note"], 12, t.mute, line=1.3, first=True)
    return sl


def L_waffle(prs, t, s):
    """Proportion as a 10x10 dot grid, with the claim set large beside it."""
    sl = _blank(prs)
    _bg(sl, t.paper)
    y = _head(sl, t, s, width=0.62)
    pct = max(0, min(100, int(round(_num(s.get("percent"), 0)))))
    viz.waffle(sl, t, W - M - Inches(3.4), Inches(1.9), pct)
    tf = _tf(sl, M, y + Inches(0.25), CW * 0.5, Inches(1.6))
    _p(tf, f"{pct}%", 96, t.primary, bold=True, line=0.95, first=True)
    _rect(sl, M, y + Inches(1.62), Inches(0.62), Pt(4), t.accent)
    tf2 = _tf(sl, M, y + Inches(1.88), CW * 0.46, Inches(1.8))
    _p(tf2, _s(s.get("label")), 16, t.ink, line=1.4, first=True)
    if s.get("note"):
        tf3 = _tf(sl, M, H - M - Inches(0.5), CW * 0.55, Inches(0.5))
        _p(tf3, s["note"], 12, t.mute, line=1.3, first=True)
    return sl


def L_range(prs, t, s):
    """Labelled bands on one axis — for threshold claims, where two numbers in a
    sentence hide the shape of the finding."""
    sl = _blank(prs)
    _bg(sl, t.paper)
    y = _head(sl, t, s)
    bands = [{"label": _s(b.get("label")), "from": _num(b.get("from")),
              "to": _num(b.get("to"), 1)} for b in _list(s.get("bands"))[:4]]
    end = y
    if bands:
        note_room = Inches(1.1) if s.get("note") else Inches(0.4)
        end = viz.range_bands(sl, t, M, y + Inches(0.62), CW * 0.86, bands,
                              avail=H - M - y - Inches(0.62) - note_room)
    if s.get("note"):
        tf = _tf(sl, M, min(end + Inches(0.2), H - M - Inches(0.9)), CW * 0.82, Inches(0.9))
        _p(tf, s["note"], 13.5, t.ink, line=1.4, first=True)
    return sl


def L_table(prs, t, s):
    sl = _blank(prs)
    _bg(sl, t.paper)
    y = _head(sl, t, s)
    cols = [_s(c) for c in _list(s.get("headers"))] or ["", ""]
    rows = [_list(r) for r in _list(s.get("rows"))[:6]]
    avail = H - M - y - Inches(0.5)
    row_h = max(Inches(0.5), min(Inches(0.95), avail / (len(rows) + 1)))
    shape = sl.shapes.add_table(len(rows) + 1, len(cols), int(M), int(y),
                                int(CW), int(row_h * (len(rows) + 1)))
    tbl = shape.table
    tbl.first_row = True
    for c, name in enumerate(cols):
        cell = tbl.cell(0, c)
        cell.text = name
        cell.fill.solid()
        cell.fill.fore_color.rgb = t.deep
        r0 = cell.text_frame.paragraphs[0].runs[0]
        r0.font.size, r0.font.bold, r0.font.name = Pt(12), True, FONT
        r0.font.color.rgb = t.paper
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    for r, row in enumerate(rows, start=1):
        for c in range(len(cols)):
            cell = tbl.cell(r, c)
            cell.text = _s(row[c]) if c < len(row) else ""
            cell.fill.solid()
            cell.fill.fore_color.rgb = t.paper if r % 2 else t.faint
            runs = cell.text_frame.paragraphs[0].runs
            if runs:
                runs[0].font.size = Pt(12)
                runs[0].font.name = FONT
                runs[0].font.color.rgb = t.ink
                runs[0].font.bold = (c == 0)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    return sl


def L_quote(prs, t, s):
    sl = _blank(prs)
    _bg(sl, t.deep)
    _rect(sl, 0, 0, Inches(0.16), H, t.accent)
    tf0 = _tf(sl, M, Inches(1.3), Inches(2.0), Inches(1.8))
    _p(tf0, "“", 150, t.primary, bold=True, first=True)
    q = _s(s.get("quote"))
    tf = _tf(sl, M, Inches(2.5), CW * 0.84, Inches(3.0))
    p = _p(tf, q, 38 if len(q) < 110 else (31 if len(q) < 165 else 25),
           t.paper, line=1.26, first=True, font=SERIF)
    p.runs[0].font.italic = True
    if s.get("attribution"):
        _rect(sl, M, Inches(5.55), Inches(0.5), Pt(4), t.accent)
        tf2 = _tf(sl, M, Inches(5.8), CW * 0.6, Inches(0.5))
        _p(tf2, _s(s["attribution"]), 13, t.support, first=True)
    return sl


def L_closing(prs, t, s):
    sl = _blank(prs)
    _bg(sl, t.deep)
    _rect(sl, W * 0.60, 0, W * 0.40, H, t.primary)
    tf = _tf(sl, M, Inches(1.55), W * 0.5, Inches(1.3))
    _p(tf, _s(s.get("title")), 40, t.paper, bold=True, line=1.05, first=True)
    _rect(sl, M, Inches(3.0), Inches(1.3), Pt(7), t.accent)
    for i, b in enumerate(_list(s.get("points"))[:4]):
        cy = Inches(3.42) + i * Inches(0.86)
        tf2 = _tf(sl, M, cy, Inches(0.42), Inches(0.5))
        _p(tf2, f"0{i+1}", 15, t.accent, bold=True, first=True)
        tf3 = _tf(sl, M + Inches(0.62), cy, W * 0.46, Inches(0.8))
        _p(tf3, b, 15, t.support, line=1.35, first=True)
    return sl


def L_flow(prs, t, s):
    """A process, drawn. The benchmark's render-look-fix diagram was the single
    clearest slide in it."""
    sl = _blank(prs)
    _bg(sl, t.paper)
    y = _head(sl, t, s)
    steps = [{"label": _s(x.get("label")), "caption": _s(x.get("caption")),
              "emphasis": bool(x.get("emphasis"))} for x in _list(s.get("steps"))[:5]]
    if steps:
        viz.flow(sl, t, M, y + Inches(0.5), CW, steps)
    if s.get("note"):
        _rect(sl, 0, H - Inches(1.15), W, Inches(1.15), t.deep)
        tf = _tf(sl, M, H - Inches(0.86), CW * 0.85, Inches(0.6))
        _p(tf, s["note"], 17, t.paper, bold=True, line=1.25, first=True)
    return sl


def L_matrix(prs, t, s):
    """Claims against options, with filled cells. Replaces two bullet lists."""
    sl = _blank(prs)
    _bg(sl, t.paper)
    y = _head(sl, t, s)
    cols = [_s(c) for c in _list(s.get("columns"))[:3]] or ["A", "B"]
    rows = []
    for r in _list(s.get("rows"))[:6]:
        # The model returns rows as objects OR as bare arrays like
        # ["claim", true, false]. Both are reasonable readings of the schema, so
        # accept both rather than dropping the slide.
        if isinstance(r, dict):
            rows.append({"label": _s(r.get("label")), "values": _list(r.get("values"))})
        else:
            arr = _list(r)
            rows.append({"label": _s(arr[0] if arr else ""),
                         "values": [bool(v) and str(v).lower() not in ("no", "false", "0")
                                    for v in arr[1:]]})
    if rows:
        viz.matrix(sl, t, M, y + Inches(0.55), CW, rows, cols)
    if s.get("verdict"):
        _rect(sl, 0, H - Inches(1.05), W, Inches(1.05), t.deep)
        tf = _tf(sl, M, H - Inches(0.78), CW * 0.7, Inches(0.55))
        _p(tf, s["verdict"], 15, t.paper, line=1.3, first=True)
    return sl


LAYOUTS = {
    "flow": L_flow,
    "matrix": L_matrix,
    # High-fidelity grounds. Registered ahead of the flat layouts so a spec can
    # opt into imagery per slide.
    "hero_title": lambda prs, t, s: hero.hero_title(prs, t, s),
    "hero_split": lambda prs, t, s: hero.hero_split(prs, t, s),
    "hero_statement": lambda prs, t, s: hero.hero_statement(prs, t, s),
    "title": L_title, "section": L_section, "bullets": L_bullets,
    "two_column": L_two_column, "stats": L_stats, "comparison": L_comparison,
    "bars": L_bars, "waffle": L_waffle, "range": L_range,
    "table": L_table, "quote": L_quote, "closing": L_closing,
}
DARK = {"title", "section", "quote", "closing", "stats",
        "hero_title", "hero_statement", "flow", "matrix"}


def _footer(sl, t, text, page):
    tf = _tf(sl, M, H - Inches(0.52), CW * 0.7, Inches(0.28))
    _p(tf, text, 9, t.mute, first=True, spacing=0.6)
    tf2 = _tf(sl, W - M - Inches(0.6), H - Inches(0.52), Inches(0.6), Inches(0.28))
    _p(tf2, str(page), 9, t.mute, align=PP_ALIGN.RIGHT, first=True)


def build(spec: dict, out: Path) -> Path:
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H
    t = THEMES.get(spec.get("theme", "ink"), THEMES["ink"])
    running = _s(spec.get("running_title"))
    for i, s in enumerate(spec.get("slides", [])):
        layout = s.get("layout")
        fn = LAYOUTS.get(layout)
        if fn is None:
            s = {**s, "bullets": _list(s.get("bullets")) or [_s(s.get("title"))]}
            fn, layout = L_bullets, "bullets"
        try:
            sl = fn(prs, t, s)
        except Exception as err:  # noqa: BLE001
            # A malformed slide degrades to bullets rather than losing the deck.
            print(f"  ! slide {i+1} ({layout}) failed: {err} — fell back to bullets")
            sl = L_bullets(prs, t, {**s, "bullets": _list(s.get("bullets")) or [_s(s.get("title"))]})
            layout = "bullets"
        if i > 0 and layout not in DARK:
            _footer(sl, t, running, i + 1)
    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out))
    return out


if __name__ == "__main__":
    spec_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else spec_path.with_suffix(".pptx")
    spec = json.loads(spec_path.read_text())
    p = build(spec, out_path)
    print(f"wrote {p}  ({len(spec.get('slides', []))} slides)")
