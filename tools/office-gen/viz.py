"""
Data visualisations drawn as native shapes.

python-pptx's built-in charts are fine for a column chart and hopeless for
anything with design intent — you get Excel's defaults and a handful of knobs.
Everything here is rectangles, ellipses and text boxes placed by hand, which
means full control of colour, weight, spacing and annotation, and it stays
native and editable in PowerPoint rather than becoming a picture.

These exist because the first deck's single grey-and-navy bar chart was the
weakest slide in it, and "add more chart types" is the wrong fix when the real
problem is that a default chart looks like a default chart.
"""
from __future__ import annotations

from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

FONT = "Helvetica Neue"


def _rect(sl, x, y, w, h, colour, *, radius=None, alpha_shape=MSO_SHAPE.RECTANGLE):
    s = sl.shapes.add_shape(alpha_shape, x, y, int(max(w, 1)), int(max(h, 1)))
    s.fill.solid()
    s.fill.fore_color.rgb = colour
    s.line.fill.background()
    s.shadow.inherit = False
    if radius is not None and alpha_shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = radius
    return s


def _label(sl, x, y, w, h, text, size, colour, *, bold=False, align=PP_ALIGN.LEFT):
    tb = sl.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    p = tf.paragraphs[0]
    p.alignment = align
    r = p.add_run()
    r.text = str(text)
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.name = FONT
    r.font.color.rgb = colour
    return tb


def bar_rows(sl, t, x, y, w, items, *, row_h=None, gap=None, avail=None,
             label_w=None, highlight=0):
    """Horizontal bars with the label ABOVE each bar and the value at its end.

    Chosen over a vertical column chart because labels in a deck are prose, and
    prose set at 45 degrees under an axis is the single most common ugly thing
    in a generated slide.
    """
    # Grow the rows to fill the space actually available. Fixed row heights left
    # the bottom half of a three-bar slide empty, which reads as an unfinished
    # slide rather than as whitespace.
    n = max(1, len(items))
    if avail is not None:
        pitch = avail / n
        # Bars stay SLIM and the gap absorbs the extra room. Letting the bar
        # height grow with the space turned a two-bar slide into two fat
        # lozenges — filling the canvas is not the same as looking better.
        row_h = row_h or min(Inches(0.52), pitch * 0.40)
        gap = gap if gap is not None else max(Inches(0.3), pitch - row_h)
    row_h = row_h or Inches(0.62)
    gap = gap if gap is not None else Inches(0.26)
    label_w = label_w or w * 0.34
    vals = [float(i.get("value", 0) or 0) for i in items]
    top = max(vals) if vals and max(vals) > 0 else 1.0
    bar_x = x + label_w
    bar_max = w - label_w - Inches(1.45)
    for i, it in enumerate(items):
        cy = y + i * (row_h + gap)
        _label(sl, x, cy + row_h * 0.22, label_w - Inches(0.2), row_h,
               it.get("label", ""), 14, t.ink)
        frac = (float(it.get("value", 0) or 0) / top) if top else 0
        bh = row_h - Inches(0.12)
        _rect(sl, bar_x, cy + Inches(0.06), bar_max, bh,
              t.faint, radius=0.5, alpha_shape=MSO_SHAPE.ROUNDED_RECTANGLE)
        bw = bar_max * frac
        # The corner radius is a fraction of the SHORT side, so a bar narrower
        # than it is tall becomes a circle. Fall back to a square end below that
        # threshold rather than drawing a lozenge.
        fill_w = max(bw, Inches(0.06))
        _rect(sl, bar_x, cy + Inches(0.06), fill_w, bh,
              t.accent if i == highlight else t.primary,
              radius=0.5 if fill_w > bh * 1.6 else None,
              alpha_shape=(MSO_SHAPE.ROUNDED_RECTANGLE if fill_w > bh * 1.6
                           else MSO_SHAPE.RECTANGLE))
        _label(sl, bar_x + bar_max + Inches(0.18), cy + row_h * 0.24,
               Inches(1.25), row_h, it.get("display", it.get("value", "")), 16,
               t.accent if i == highlight else t.primary, bold=True)
    return y + len(items) * (row_h + gap)


def waffle(sl, t, x, y, filled, total=100, *, cols=10, cell=Inches(0.24),
           gap=Inches(0.055), on=None, off=None):
    """A 10x10 dot grid. Reads a proportion instantly and, unlike a pie, it is
    honest about precision — you can count the squares."""
    on = on or t.accent
    off = off or t.faint
    filled = max(0, min(total, int(round(filled))))
    for i in range(total):
        r, c = divmod(i, cols)
        _rect(sl, x + c * (cell + gap), y + r * (cell + gap), cell, cell,
              on if i < filled else off, radius=0.22,
              alpha_shape=MSO_SHAPE.ROUNDED_RECTANGLE)
    return y + (total // cols) * (cell + gap)


def range_bands(sl, t, x, y, w, bands, *, row_h=None, gap=None, avail=None):
    """Each band on its OWN row, spanning a shared axis.

    The first version drew every band on one line. That is only legible if the
    bands are disjoint segments of one scale — and a model comparing "0-500
    words" against "5-15 words" produces overlapping spans, so they piled on top
    of each other into a single bar with three labels stacked at the same x.
    Stacked rows are unambiguous whether the spans overlap or not, and they give
    each label its own space.
    """
    n = max(1, len(bands))
    if avail is not None:
        pitch = avail / n
        row_h = row_h or min(Inches(0.8), pitch * 0.46)
        gap = gap if gap is not None else min(Inches(0.7), pitch * 0.5)
    row_h = row_h or Inches(0.46)
    gap = gap if gap is not None else Inches(0.42)
    lo = min(float(b.get("from", 0) or 0) for b in bands)
    hi = max(float(b.get("to") or b.get("from") or 1) for b in bands)
    span = (hi - lo) or 1.0
    for i, b in enumerate(bands):
        f = float(b.get("from", 0) or 0)
        tt = float(b.get("to") or f or 0)
        if tt < f:
            f, tt = tt, f
        cy = y + i * (row_h + gap)
        col = [t.primary, t.accent, t.support, t.mute][i % 4]
        # Track, then the band's own span on top of it.
        _rect(sl, x, cy, w, row_h, t.faint, radius=0.5,
              alpha_shape=MSO_SHAPE.ROUNDED_RECTANGLE)
        x0 = x + w * ((f - lo) / span)
        x1 = x + w * ((tt - lo) / span)
        _rect(sl, x0, cy, max(x1 - x0, Inches(0.14)), row_h, col, radius=0.5,
              alpha_shape=MSO_SHAPE.ROUNDED_RECTANGLE)
        _label(sl, x, cy - Inches(0.30), w * 0.6, Inches(0.26),
               b.get("label", ""), 12, t.ink, bold=True)
        _label(sl, x + w + Inches(0.12), cy + Inches(0.02), Inches(1.5), Inches(0.3),
               f"{int(f)}–{int(tt)}", 11.5, col, bold=True)
    return y + len(bands) * (row_h + gap)


def ring(sl, t, cx, cy, r, frac, *, label="", sub="", thickness=0.62):
    """A donut gauge. MSO_SHAPE.DONUT gives the track; the filled portion is a
    BLOCK_ARC, whose adjustments are (start_angle, end_angle, thickness) in
    degrees clockwise from 12 o'clock."""
    frac = max(0.0, min(1.0, float(frac)))
    d = r * 2
    track = sl.shapes.add_shape(MSO_SHAPE.DONUT, int(cx - r), int(cy - r), int(d), int(d))
    track.fill.solid()
    track.fill.fore_color.rgb = t.faint
    track.line.fill.background()
    track.shadow.inherit = False
    track.adjustments[0] = 1 - thickness
    if frac > 0.002:
        arc = sl.shapes.add_shape(MSO_SHAPE.BLOCK_ARC, int(cx - r), int(cy - r), int(d), int(d))
        arc.fill.solid()
        arc.fill.fore_color.rgb = t.accent
        arc.line.fill.background()
        arc.shadow.inherit = False
        try:
            arc.adjustments[0] = 0.0
            arc.adjustments[1] = frac
            arc.adjustments[2] = 1 - thickness
        except (IndexError, ValueError):
            pass
    if label:
        _label(sl, int(cx - r), int(cy - Inches(0.32)), int(d), Inches(0.5),
               label, 26, t.primary, bold=True, align=PP_ALIGN.CENTER)
    if sub:
        _label(sl, int(cx - r), int(cy + Inches(0.10)), int(d), Inches(0.36),
               sub, 11, t.mute, align=PP_ALIGN.CENTER)


def stat_block(sl, t, x, y, w, value, label, *, size=64, colour=None, rule=True):
    """Oversized numeral with a rule and a caption. The highest visual-impact
    element per unit of effort in the whole file."""
    colour = colour or t.primary
    _label(sl, x, y, w, Inches(1.0), value, size, colour, bold=True)
    yy = y + Inches(size / 72 * 0.92)
    if rule:
        _rect(sl, x, yy, Inches(0.55), Pt(3), t.accent)
        yy += Inches(0.22)
    _label(sl, x, yy, w, Inches(0.8), label, 12.5, t.mute)
    return yy + Inches(0.7)


# ── borrowed from the benchmark deck ─────────────────────────────────────────
# A Claude-built deck on the same report was rendered as a reference. Four of
# its techniques were things this renderer simply could not do, and all four are
# cheap: a process flow, a comparison matrix, status pills, and a serif voice
# for the one quiet slide. Copying capability rather than copying a design.

def flow(sl, t, x, y, w, steps, *, r=Inches(0.62), label_below=True):
    """Labelled nodes joined by arrows. A process is the one thing bullets are
    worst at describing and a diagram is best at."""
    n = max(1, len(steps))
    pitch = w / n
    cy = y + r
    for i, st in enumerate(steps):
        cx = x + pitch * i + pitch / 2
        filled = st.get("emphasis") or i == 0
        node = sl.shapes.add_shape(MSO_SHAPE.OVAL, int(cx - r), int(cy - r),
                                   int(r * 2), int(r * 2))
        node.fill.solid()
        node.fill.fore_color.rgb = t.accent if filled else t.paper
        node.line.color.rgb = t.primary
        node.line.width = Pt(1.5)
        node.shadow.inherit = False
        _label(sl, int(cx - r), int(cy - Inches(0.14)), int(r * 2), Inches(0.32),
               st.get("label", ""), 11.5, t.paper if filled else t.primary,
               bold=True, align=PP_ALIGN.CENTER)
        if i < n - 1:
            ax0 = cx + r + Inches(0.12)
            ax1 = x + pitch * (i + 1) + pitch / 2 - r - Inches(0.12)
            _rect(sl, ax0, cy - Pt(1), max(ax1 - ax0, Inches(0.2)), Pt(2), t.mute)
            head = sl.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE,
                                       int(ax1 - Inches(0.13)), int(cy - Inches(0.09)),
                                       int(Inches(0.16)), int(Inches(0.18)))
            head.rotation = 90
            head.fill.solid(); head.fill.fore_color.rgb = t.mute
            head.line.fill.background(); head.shadow.inherit = False
        if label_below and st.get("caption"):
            _label(sl, int(cx - pitch / 2 + Inches(0.1)), int(cy + r + Inches(0.22)),
                   int(pitch - Inches(0.2)), Inches(0.8), st["caption"], 11, t.mute,
                   align=PP_ALIGN.CENTER)
    return cy + r + Inches(1.1)


def matrix(sl, t, x, y, w, rows, cols, *, row_h=Inches(0.52)):
    """Rows of claims against columns of options, with a filled or empty cell.

    Says "A does this, B does not" far faster than two bullet lists, and it is
    the layout a two-camp comparison actually wants.
    """
    label_w = w * 0.56
    cell_w = (w - label_w) / max(1, len(cols))
    for c, name in enumerate(cols):
        _label(sl, x + label_w + cell_w * c, y - Inches(0.42), cell_w, Inches(0.3),
               str(name).upper(), 10, t.primary, bold=True, align=PP_ALIGN.CENTER)
    for r, row in enumerate(rows):
        cy = y + r * row_h
        if r % 2 == 0:
            _rect(sl, x, cy, w, row_h, t.faint)
        _label(sl, x + Inches(0.14), cy + Inches(0.13), label_w - Inches(0.2),
               row_h, row.get("label", ""), 12.5, t.ink)
        for c in range(len(cols)):
            on = bool(row.get("values", [])[c]) if c < len(row.get("values", [])) else False
            cx = x + label_w + cell_w * c + cell_w / 2
            _rect(sl, cx - Inches(0.10), cy + row_h / 2 - Inches(0.10),
                  Inches(0.20), Inches(0.20),
                  t.accent if on else t.paper, radius=0.25,
                  alpha_shape=MSO_SHAPE.ROUNDED_RECTANGLE)
    return y + len(rows) * row_h


def pill(sl, t, x, y, text, *, tone="ok", w=Inches(1.7), h=Inches(0.3)):
    """A small status chip. Turns a verdict into an object you can scan."""
    colour = {"ok": t.accent, "warn": t.mute, "off": t.faint}.get(tone, t.accent)
    fg = t.paper if tone != "off" else t.ink
    _rect(sl, x, y, w, h, colour, radius=0.5,
          alpha_shape=MSO_SHAPE.ROUNDED_RECTANGLE)
    _label(sl, x, y + Inches(0.045), w, h, str(text).upper(), 8.5, fg,
           bold=True, align=PP_ALIGN.CENTER)
    return x + w
