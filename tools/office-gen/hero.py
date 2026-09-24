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

VQ-01 (2026-09-23): the type here was sized by CHARACTER COUNT and placed at
fixed heights (`58 if len(title) < 46 …`, subtitle at 5.05 in), so a 58-char
title wrapped to four lines and ran through its subtitle (D1). Every block is
now measured against the real font (textfit) and the next one placed below it;
sizes step down until the whole stack fits above the footnote.
"""
from __future__ import annotations

from pathlib import Path

from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

import imagery
import numparse
import textfit

W, H = Inches(13.333), Inches(7.5)
M = Inches(0.9)
CW = W - 2 * M
FONT = "Helvetica Neue"


def _hex(rgb) -> str:
    return f"#{rgb}"


def _s(v) -> str:
    return numparse.as_text(v)


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


def _tf(sl, x, y, w, h, *, wrap=True):
    tb = sl.shapes.add_textbox(int(x), int(y), int(w), int(h))
    f = tb.text_frame
    f.word_wrap = wrap
    f.margin_left = f.margin_right = f.margin_top = f.margin_bottom = 0
    return f


def _p(tf, text, size, colour, *, bold=False, first=False, line=None,
       align=PP_ALIGN.LEFT, after=0, spacing=None, font=FONT, italic=False):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment = align
    p.space_after = Pt(after)
    if line:
        p.line_spacing = line
    r = p.add_run()
    r.text = _s(text)
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.name = font
    r.font.color.rgb = colour
    if italic:
        r.font.italic = True
    if spacing is not None:
        r.font._rPr.set("spc", str(int(spacing * 100)))
    return p


def _measure(text, box, size, *, bold=False, font=FONT, italic=False, spacing=0.0):
    return textfit.wrap(_s(text), box / 12700, size, bold=bold, font=font, italic=italic,
                        tracking=spacing)


def _height(n, size, line):
    return Pt(textfit.height_pt(n, size, line))


def _write(sl, lines, x, y, box, size, colour, *, bold=False, line=1.05, font=FONT,
           italic=False, spacing=None):
    """Measured lines, one paragraph each, reflow OFF — what was measured is
    what renders. Returns the bottom."""
    h = _height(len(lines), size, line) + Inches(0.04)
    tf = _tf(sl, x, y, box, h, wrap=False)
    for i, ln in enumerate(lines):
        _p(tf, ln, size, colour, bold=bold, first=(i == 0), line=line, font=font,
           italic=italic, spacing=spacing)
    return y + h


def _fit(text, box, sizes, max_lines, *, bold=False, font=FONT, italic=False, spacing=0.0):
    return textfit.fit_size(_s(text), box / 12700, sizes, max_lines, bold=bold, font=font,
                            italic=italic, tracking=spacing)


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
    g = _ground(t, _s(s.get("ground") or "photo"), _s(s.get("image_query") or "abstract"), "hero")
    if g:
        _picture(sl, g, 0, 0, W, H)
    # Wedge scrim: dense on the left where the type sits, clearing to the right
    # so the picture is still visible as a picture.
    _scrim(sl, 0, 0, W * 0.62, H, t.deep, 82)
    _scrim(sl, W * 0.62, 0, W * 0.38, H, t.deep, 30)
    s0 = sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, int(W * 0.62), 0, int(Inches(0.07)), int(H))
    s0.fill.solid(); s0.fill.fore_color.rgb = t.accent
    s0.line.fill.background(); s0.shadow.inherit = False

    top = Inches(2.15)
    if s.get("eyebrow"):
        ey = _s(s["eyebrow"]).upper()
        size, lines = _fit(ey, CW * 0.5, [11, 10], 2, bold=True, spacing=1.8)
        end = _write(sl, lines, M, Inches(1.55), CW * 0.5, size, t.accent, bold=True,
                     line=1.1, spacing=1.8)
        top = max(top, end + Inches(0.22))
    foot = H - Inches(0.95)
    floor = foot - Inches(0.25)
    title = _s(s.get("title"))
    sub = _s(s.get("subtitle"))
    title_box, sub_box = W * 0.54, W * 0.46
    # The largest title (then subtitle) for which the WHOLE stack sits above the
    # footnote. The old rule sized by character count and put the subtitle at a
    # fixed 5.05 in, under a title that had wrapped to four lines (D1).
    choice = None
    for tsize in (58, 52, 46, 40, 36, 32):
        tl = _measure(title, title_box, tsize, bold=True)
        if len(tl) > 4 or any(textfit.width_pt(x, tsize, bold=True) > title_box / 12700 for x in tl):
            continue
        t_end = top + _height(len(tl), tsize, 1.02)
        if not sub:
            if t_end <= floor:
                choice = (tsize, tl, None, [])
                break
            continue
        for ssize in (16.5, 15, 14):
            sl_ = _measure(sub, sub_box, ssize)
            if len(sl_) <= 3 and t_end + Inches(0.28) + _height(len(sl_), ssize, 1.35) <= floor:
                choice = (tsize, tl, ssize, sl_)
                break
        if choice:
            break
    if choice is None:
        tsize, tl = _fit(title, title_box, [32], 3, bold=True)
        ssize, sl_ = (14, _fit(sub, sub_box, [14], 2)[1]) if sub else (None, [])
        choice = (tsize, tl, ssize, sl_)
    tsize, tl, ssize, sl_ = choice
    end = _write(sl, tl, M, top, title_box, tsize, t.paper, bold=True, line=1.02)
    if sub:
        _write(sl, sl_, M, end + Inches(0.28), sub_box, ssize, t.support, line=1.35)
    if s.get("footnote"):
        tf3 = _tf(sl, M, foot, W * 0.5, Inches(0.3))
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
    g = _ground(t, _s(s.get("ground") or "photo"), _s(s.get("image_query") or "texture"), "split")
    if g:
        _picture(sl, g, W - img_w, 0, img_w, H)
        _scrim(sl, W - img_w, 0, img_w, H, t.deep, 42)

    y = Inches(1.55)
    if s.get("kicker"):
        size, lines = _fit(_s(s["kicker"]).upper(), CW * 0.45, [10.5], 2, bold=True, spacing=1.5)
        end = _write(sl, lines, M, Inches(1.05), CW * 0.45, size, t.accent, bold=True, line=1.1,
                     spacing=1.5)
        y = max(y, end + Inches(0.14))
    title = _s(s.get("title"))
    tsize, tl = _fit(title, W * 0.44, [36, 32, 28, 24], 3, bold=True)
    t_end = _write(sl, tl, M, y, W * 0.44, tsize, t.ink, bold=True, line=1.06)
    # Body column is NARROWER than the flat half, so the breaking stat card has
    # somewhere to live. The first version ran the body to the seam and the card
    # sat straight on top of the third paragraph — a "breaking the grid" element
    # only works if the grid left room for it to break into.
    body = s.get("body")
    body_w = W * 0.34
    body_top = max(Inches(3.5), t_end + Inches(0.35))
    stat = s.get("stat") if isinstance(s.get("stat"), dict) else None
    card_h = Inches(1.85)
    limit = (H - M - card_h - Inches(0.25)) if stat else (H - M)
    body_bottom = body_top
    if body:
        items = [_s(b) for b in (body if isinstance(body, list) else [body]) if _s(b).strip()]
        for bsize in (14.5, 13.5, 12.5, 11.5):
            wrapped = [_measure(b, body_w, bsize) for b in items]
            need = sum(_height(len(w), bsize, 1.5) for w in wrapped) + Pt(12) * max(0, len(items) - 1)
            if body_top + need <= limit:
                break
        cy = body_top
        for w in wrapped:
            cy = _write(sl, w, M, cy, body_w, bsize, t.ink, line=1.5) + Pt(12)
        body_bottom = cy - Pt(12)

    if stat:
        px = W - img_w - Inches(1.35)
        card_y = max(H * 0.585, min(body_bottom + Inches(0.25), H - M - card_h))
        card = sl.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, int(px),
                                   int(card_y), int(Inches(3.9)), int(card_h))
        card.fill.solid(); card.fill.fore_color.rgb = t.accent
        card.line.fill.background(); card.shadow.inherit = False
        card.adjustments[0] = 0.07
        vsize, vl = _fit(_s(stat.get("value", "")), Inches(3.3), [46, 40, 34, 28], 1, bold=True)
        _write(sl, vl, px + Inches(0.34), card_y + Inches(0.24), Inches(3.3), vsize, t.paper,
               bold=True, line=0.98)
        lsize, ll = _fit(_s(stat.get("label", "")), Inches(3.2), [12, 11], 2)
        _write(sl, ll, px + Inches(0.34), card_y + Inches(1.12), Inches(3.2), lsize, t.paper, line=1.25)
    return sl


def hero_statement(prs, t, s):
    """One sentence, very large, on a ground. The least content per slide and
    often the most memorable — a deck needs at least one moment of quiet."""
    sl = prs.slides.add_slide(prs.slide_layouts[6])
    # Photo by default. The statement slide is the deck's quiet moment and a
    # flat ground wastes it — the whole point is one sentence over an image.
    g = _ground(t, _s(s.get("ground") or "photo"), _s(s.get("image_query") or "fog landscape minimal"), "stmt")
    if g:
        _picture(sl, g, 0, 0, W, H)
    # 55, not 68: the earlier scrim was heavy enough that the picture read as a
    # flat navy rectangle, which is the same as having no picture.
    _scrim(sl, 0, 0, W, H, t.deep, 55)
    bar = sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, int(M), int(Inches(2.2)),
                              int(Inches(1.5)), int(Pt(7)))
    bar.fill.solid(); bar.fill.fore_color.rgb = t.accent
    bar.line.fill.background(); bar.shadow.inherit = False
    text = _s(s.get("statement"))
    top = Inches(2.7)
    floor = (H - Inches(1.75)) if s.get("attribution") else (H - Inches(0.9))
    box = CW * 0.86
    # Serif italic, borrowed from the benchmark deck: the same sentence in bold
    # sans reads as a heading, in serif italic it reads as a statement. Sized to
    # the room above the attribution, not by character count.
    size, lines = 25, _measure(text, box, 25, font="Georgia", italic=True)
    for cand in (42, 38, 35, 31, 28, 25, 22):
        lines = _measure(text, box, cand, font="Georgia", italic=True)
        size = cand
        if top + _height(len(lines), cand, 1.22) <= floor:
            break
    _write(sl, lines, M, top, box, size, t.paper, line=1.22, font="Georgia", italic=True)
    if s.get("attribution"):
        tf2 = _tf(sl, M, H - Inches(1.5), CW * 0.6, Inches(0.5))
        _p(tf2, _s(s["attribution"]), 13, t.support, first=True, spacing=0.6)
    return sl
