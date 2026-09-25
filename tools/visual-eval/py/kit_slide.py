"""
A design kit's slide, built by python-pptx from design_tokens.json ALONE (VQ-04).

The kit sheet's slide tile is the proof that Python reads the same tokens the
TypeScript side does: nothing in here names a colour, a face or a size — every
one comes from tools/office-gen/design_tokens.py, which reads the export of
packages/design-kit/src/kits/*.json. The layout is the research's (c) deck
grammar in miniature (visual-quality.md §2.2.1): a label, a headline, a lead,
then a KPI row on the kit's tint — label → headline → hero number → caption,
one accent use, no rule under the title, no empty panel.

    python kit_slide.py <kit-id> <out.pptx>
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OFFICE = HERE.parents[1] / "office-gen"
sys.path.insert(0, str(OFFICE))

import design_tokens as dt  # noqa: E402
from pptx import Presentation  # noqa: E402
from pptx.dml.color import RGBColor  # noqa: E402
from pptx.enum.shapes import MSO_SHAPE  # noqa: E402
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN  # noqa: E402
from pptx.util import Emu, Pt  # noqa: E402

PX = 9525  # EMU per CSS px at 96 dpi: a 1280×720 slide is 13.33 × 7.5 in


def px(v: float) -> Emu:
    return Emu(int(round(v * PX)))


def pt(v_px: float) -> Pt:
    return Pt(v_px * 0.75)


def rgb(h: str) -> RGBColor:
    return RGBColor.from_string(h.lstrip("#"))


def text(slide, x, y, w, h, runs, *, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    """A text box of one paragraph per entry, top to bottom in ONE flow — so a
    lead follows however many lines its headline took (separate boxes at fixed
    y left a hole under a one-line headline). An entry is (text, size_px,
    family, bold, colour, tracking_em, line_spacing, space_before_px)."""
    box = slide.shapes.add_textbox(px(x), px(y), px(w), px(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    for i, (words, size, family, bold, colour, tracking, spacing, before) in enumerate(runs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        if before:
            p.space_before = pt(before)
        r = p.add_run()
        r.text = words
        r.font.size = pt(size)
        r.font.name = family
        r.font.bold = bold
        r.font.color.rgb = rgb(colour)
        if tracking:
            # a:rPr spc is in hundredths of a point
            r.font._element.set("spc", str(int(round(tracking * size * 0.75 * 100))))
    return box


def build(kit_id: str, out: str) -> dict:
    kit = dt.kit(kit_id)
    c = kit["light"]
    t = kit["type"]
    s = t["slide"]
    display = dt.first_family(dt.font_stack(kit_id, "display", "mac"))
    body = dt.first_family(dt.font_stack(kit_id, "text", "mac"))
    margin = kit["space"]["margin"]
    bold = t["weights"]["display"] >= 600

    prs = Presentation()
    prs.slide_width = px(1280)
    prs.slide_height = px(720)
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    bg = slide.background.fill
    bg.solid()
    bg.fore_color.rgb = rgb(c["paper"])

    # the KPI row on the kit's tint, set on the bottom margin; the words above
    # hold a headline measure (about 30 characters, so it breaks in two the
    # way a deck headline does) — a one-line headline over a short band left
    # a third of the slide empty between them (the eval's L5 check)
    band_h = 260
    band_y = 720 - margin - band_h

    # label → headline → lead, one flow.
    # Words in the accent use accentInk: the accent itself where it reads, a
    # deeper twin where it is only a fill (graphite & amber) — the eval's
    # contrast check failed this label at 3.5:1 before the role existed.
    text(
        slide, margin, margin, 820, band_y - margin - kit["space"]["gutter"],
        [
            ("Q3 · Leak response", s["caption"], body, True, c["accentInk"], t["tracking"]["caps"], 1.0, 0),
            ("Every leak stopped before the second drip", s["title"], display, bold, c["ink"],
             t["tracking"]["display"], t["lineHeight"]["heading"], 18),
            ("Valves close on site in under 2 seconds — no internet needed, no one woken up.",
             s["body"], body, False, c["mute"], 0, t["lineHeight"]["body"], 20),
        ],
    )

    band = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, px(margin), px(band_y), px(1280 - 2 * margin), px(band_h))
    band.adjustments[0] = min(0.5, kit["space"]["radius"]["card"] / band_h)
    band.fill.solid()
    band.fill.fore_color.rgb = rgb(c["tint"])
    band.line.fill.background()
    kpis = [("42", "buildings live"), ("3,100", "units protected"), ("1.8 s", "median shut-off")]
    col = (1280 - 2 * margin - 64) / 3
    for i, (value, caption) in enumerate(kpis):
        x = margin + 32 + i * col
        text(
            slide, x, band_y, col - 24, band_h,
            [
                (value, s["display"], display, bold, c["accentInk"] if i == 2 else c["ink"],
                 t["tracking"]["display"], 1.0, 0),
                (caption, s["body"], body, False, c["mute"], 0, 1.0, 6),
            ],
            anchor=MSO_ANCHOR.MIDDLE,
        )
    prs.save(out)
    return {"kit": kit_id, "fonts": [display, body], "accent": c["accent"], "paper": c["paper"]}


if __name__ == "__main__":
    import json

    print(json.dumps(build(sys.argv[1], sys.argv[2])))
