"""
High-fidelity layouts: photographic and gradient grounds, layered composition.

These are the answer to "can it make ONE slide look really good". Everything
here spends its budget on the background and the layering, because that is what
separates a deck that looks designed from one that looks generated — the
typography in the earlier layouts was already fine, the grounds were flat.

Three techniques carry all of it:
  - a full-bleed IMAGE ground, duotoned into the palette;
  - a SCRIM (a large semi-opaque panel over the image) so type stays readable on
    any photograph, which is the thing amateur decks always get wrong;
  - one element allowed to BREAK the grid — a panel bleeding off an edge, a
    numeral crossing a colour boundary.
"""
from __future__ import annotations

from pathlib import Path

from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

import imagery

W, H = Inches(13.333), Inches(7.5)
M = Inches(0.9)
CW = W - 2 * M


def _hex(rgb) -> str:
    return f"#{rgb}"


def _picture(sl, path: Path, x, y, w, h):
    """Cover-fit: fill the box and crop the overflow, never letterbox."""
    pic = sl.shapes.add_picture(str(path), int(x), int(y), width=int(w), height=int(h))
    return pic


def _scrim(sl, x, y, w, h, colour, alpha_pct):
    """A translucent panel. python-pptx exposes no alpha API, so the value goes
    straight into the fill's XML — without this, type on a photograph is a
    coin toss between legible and invisible depending on the crop."""
    s = sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, int(x), int(y), int(w), int(h))
    s.fill.solid()
    s.fill.fore_color.rgb = colour
    s.line.fill.background()
    s.shadow.inherit = False
    fill = s.fill._xPr.find(
        "{http://schemas.openxmlformats.org/drawingml/2006/main}solidFill")
    clr = fill[0]
    from lxml import etree
    a = "{http://schemas.openxmlformats.org/drawingml/2006/main}alpha"
    el = etree.SubElement(clr, a)
    el.set("val", str(int(alpha_pct * 1000)))
    return s


def _tf(sl, x, y, w, h):
    tb = sl.shapes.add_textbox(int(x), int(y), int(w), int(h))
    f = tb.text_frame
    f.word_wrap = True
    f.margin_left = f.margin_right = f.margin_top = f.margin_bottom = 0
    return f


def _p(tf, text, size, colour, *, bold=False, first=False, line=None,
       align=PP_ALIGN.LEFT, after=0, spacing=None, font="Helvetica Neue"):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    p.space_after = Pt(after)
    if line:
        p.line_spacing = line
    r = p.add_run()
    r.text = str(text)
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.name = font
    r.font.color.rgb = colour
    if spacing is not None:
        r.font._rPr.set("spc", str(int(spacing * 100)))
    return p


def _ground(t, kind: str, query: str, tag: str) -> Path | None:
    """Pick a ground and return a path, or None if nothing could be made."""
    out = imagery.CACHE / f"g-{tag}.jpg"
    if kind == "photo":
        src = imagery.fetch_photo(query, 1700, 960)
        if src:
            # Duotone toward SUPPORT (the light tint), not toward the deep
            # ground: mapping a dark photograph onto two dark colours produces a
            # black rectangle that reads as a mistake.
            return imagery.duotone(src, _hex(t.primary), _hex(t.support), out,
                                   contrast=1.15)
        kind = "gradient"          # offline: fall through, never fail the slide
    if kind == "gradient":
        return imagery.gradient_field(out, _hex(t.deep), _hex(t.primary))
    return imagery.geometric_field(out, _hex(t.deep), _hex(t.accent))


def hero_title(prs, t, s):
    """Full-bleed ground, a scrim wedge, oversized type crossing it."""
    sl = prs.slides.add_slide(prs.slide_layouts[6])
    g = _ground(t, s.get("ground", "photo"), s.get("image_query", "abstract"), "hero")
    if g:
        _picture(sl, g, 0, 0, W, H)
    # Wedge scrim: dense on the left where the type sits, clearing to the right
    # so the picture is still visible as a picture.
    _scrim(sl, 0, 0, W * 0.62, H, t.deep, 82)
    _scrim(sl, W * 0.62, 0, W * 0.38, H, t.deep, 30)
    s0 = sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, int(W * 0.62), 0, int(Inches(0.07)), int(H))
    s0.fill.solid(); s0.fill.fore_color.rgb = t.accent
    s0.line.fill.background(); s0.shadow.inherit = False

    if s.get("eyebrow"):
        tf0 = _tf(sl, M, Inches(1.55), CW * 0.5, Inches(0.3))
        _p(tf0, str(s["eyebrow"]).upper(), 11, t.accent, bold=True, first=True, spacing=1.8)
    title = str(s.get("title", ""))
    size = 58 if len(title) < 46 else (48 if len(title) < 72 else 40)
    tf = _tf(sl, M, Inches(2.15), W * 0.54, Inches(3.0))
    _p(tf, title, size, t.paper, bold=True, line=1.02, first=True)
    if s.get("subtitle"):
        tf2 = _tf(sl, M, Inches(5.05), W * 0.46, Inches(1.0))
        _p(tf2, s["subtitle"], 16.5, t.support, line=1.35, first=True)
    if s.get("footnote"):
        tf3 = _tf(sl, M, H - Inches(0.95), W * 0.5, Inches(0.3))
        _p(tf3, s["footnote"], 10.5, t.support, first=True, spacing=0.8)
    return sl


def hero_split(prs, t, s):
    """Image on one half, content on the other, with a stat allowed to break
    across the seam. The break is the whole point — an element crossing the
    boundary is what stops a split reading as two rectangles."""
    sl = prs.slides.add_slide(prs.slide_layouts[6])
    bg = sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, int(W), int(H))
    bg.fill.solid(); bg.fill.fore_color.rgb = t.paper
    bg.line.fill.background(); bg.shadow.inherit = False

    img_w = W * 0.46
    g = _ground(t, s.get("ground", "photo"), s.get("image_query", "texture"), "split")
    if g:
        _picture(sl, g, W - img_w, 0, img_w, H)
        _scrim(sl, W - img_w, 0, img_w, H, t.deep, 42)

    if s.get("kicker"):
        tf0 = _tf(sl, M, Inches(1.05), CW * 0.45, Inches(0.3))
        _p(tf0, str(s["kicker"]).upper(), 10.5, t.accent, bold=True, first=True, spacing=1.5)
    title = str(s.get("title", ""))
    tf = _tf(sl, M, Inches(1.55), W * 0.44, Inches(2.0))
    _p(tf, title, 36 if len(title) < 44 else 30, t.ink, bold=True, line=1.06, first=True)
    # Body column is NARROWER than the flat half, so the breaking stat card has
    # somewhere to live. The first version ran the body to the seam and the card
    # sat straight on top of the third paragraph — a "breaking the grid" element
    # only works if the grid left room for it to break into.
    body = s.get("body")
    body_w = W * 0.34
    body_bottom = Inches(3.5)
    if body:
        items = body[:4] if isinstance(body, list) else [body]
        tf2 = _tf(sl, M, Inches(3.5), body_w, Inches(3.0))
        for i, b in enumerate(items):
            _p(tf2, b, 14.5, t.ink, line=1.5, after=12, first=(i == 0))
        # Estimate where it ends so the card can clear it.
        est_lines = sum(max(1, int(-(-len(str(b)) // 42))) for b in items)
        body_bottom = Inches(3.5) + Inches(est_lines * 14.5 * 1.5 / 72) + Inches(len(items) * 0.17)

    stat = s.get("stat")
    if stat:
        px = W - img_w - Inches(1.35)
        card_y = max(H * 0.585, min(body_bottom + Inches(0.25), H - M - Inches(1.95)))
        card = sl.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, int(px),
                                   int(card_y), int(Inches(3.9)), int(Inches(1.85)))
        card.fill.solid(); card.fill.fore_color.rgb = t.accent
        card.line.fill.background(); card.shadow.inherit = False
        card.adjustments[0] = 0.07
        tf3 = _tf(sl, px + Inches(0.34), card_y + Inches(0.24), Inches(3.3), Inches(0.9))
        _p(tf3, str(stat.get("value", "")), 46, t.paper, bold=True, line=0.98, first=True)
        tf4 = _tf(sl, px + Inches(0.34), card_y + Inches(1.12), Inches(3.2), Inches(0.6))
        _p(tf4, str(stat.get("label", "")), 12, t.paper, line=1.25, first=True)
    return sl


def hero_statement(prs, t, s):
    """One sentence, very large, on a ground. The least content per slide and
    often the most memorable — a deck needs at least one moment of quiet."""
    sl = prs.slides.add_slide(prs.slide_layouts[6])
    # Photo by default. The statement slide is the deck's quiet moment and a
    # flat ground wastes it — the whole point is one sentence over an image.
    g = _ground(t, s.get("ground", "photo"), s.get("image_query", "fog landscape minimal"), "stmt")
    if g:
        _picture(sl, g, 0, 0, W, H)
    # 55, not 68: the earlier scrim was heavy enough that the picture read as a
    # flat navy rectangle, which is the same as having no picture.
    _scrim(sl, 0, 0, W, H, t.deep, 55)
    bar = sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, int(M), int(Inches(2.2)),
                              int(Inches(1.5)), int(Pt(7)))
    bar.fill.solid(); bar.fill.fore_color.rgb = t.accent
    bar.line.fill.background(); bar.shadow.inherit = False
    text = str(s.get("statement", ""))
    size = 42 if len(text) < 90 else (35 if len(text) < 140 else 28)
    tf = _tf(sl, M, Inches(2.7), CW * 0.86, Inches(3.2))
    # Serif italic, borrowed from the benchmark deck: the same sentence in bold
    # sans reads as a heading, in serif italic it reads as a statement.
    p = _p(tf, text, size, t.paper, line=1.22, first=True, font="Georgia")
    p.runs[0].font.italic = True
    if s.get("attribution"):
        tf2 = _tf(sl, M, H - Inches(1.5), CW * 0.6, Inches(0.5))
        _p(tf2, str(s["attribution"]), 13, t.support, first=True, spacing=0.6)
    return sl
