"""
Metrics for one rendered artifact — read from the FILE, never from the code that
wrote it, and deterministic (the eval runs twice and diffs the JSON).

  pptx: slides, text under 14 pt, text-box overlaps (rendered-text geometry,
        see fontmetrics.py), text off the slide, the largest empty region per
        slide, dropped items against the spec, fonts, text contrast, thin
        decorative bars.
  docx: an estimated page count (a flow model of the document), text under
        10 pt, table widths (tblW) and rule heights, dropped items, fonts,
        text contrast on shaded cells.
  pdf:  pages, text under 10 pt, fonts and whether they are embedded.
  svg:  text under 11 px, label overlaps, a title, the series colours through
        the categorical palette check, text contrast on the ground.

    python measure.py <pptx|docx|pdf|svg> <file> [--spec spec.json]
"""
from __future__ import annotations

import io
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fontmetrics as fm  # noqa: E402
from palette_check import blend, categorical, contrast, hex_of, parse_colour, text_needs  # noqa: E402

EMU_PER_PT = 12700
EMU_PER_IN = 914400
SLIDE_SMALL_PT = 14.0
DOC_SMALL_PT = 10.0
SVG_SMALL_PX = 11.0
EMPTY_REGION_MIN = 0.30          # L5: a rectangle >= 30% of the canvas
GRID_COLS = 128


def r1(v: float) -> float:
    return round(float(v) + 0.0, 1)


def _norm(s: str) -> str:
    return re.sub(r"[^0-9a-z%$#.]+", " ", str(s).lower()).strip()


def _present(needle: str, hay: str) -> bool:
    """Is a spec string drawn? Tolerates wrapping (whitespace) and an ellipsis
    on the tail: the first 24 characters are enough to recognise an item."""
    n = _norm(needle)
    if not n:
        return True
    h = _norm(hay)
    return n in h or n[:24] in h


# ── pptx ─────────────────────────────────────────────────────────────────────
def _fill_rgb(shape):
    """(rgb, alpha) of a shape's fill, or None."""
    from pptx.enum.dml import MSO_FILL
    try:
        f = shape.fill
        if f.type == MSO_FILL.SOLID:
            rgb = parse_colour(str(f.fore_color.rgb))
            alpha = 1.0
            el = f._xPr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}solidFill")
            if el is not None and len(el):
                a = el[0].find("{http://schemas.openxmlformats.org/drawingml/2006/main}alpha")
                if a is not None:
                    alpha = int(a.get("val", "100000")) / 100000
            return rgb, alpha
        if f.type == MSO_FILL.GRADIENT:
            stops = [parse_colour(str(s.color.rgb)) for s in f.gradient_stops]
            stops = [s for s in stops if s]
            if stops:
                avg = tuple(int(round(sum(c[i] for c in stops) / len(stops))) for i in range(3))
                return avg, 1.0
    except Exception:  # noqa: BLE001 — theme colours, placeholders: unknown, not an error
        return None
    return None


def _picture_image(shape):
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(shape.image.blob)).convert("RGB")
    except Exception:  # noqa: BLE001
        return None
    return im


def _smooth(im) -> bool:
    """A procedural ground (a gradient, a flat fill) rather than a picture of
    something: almost no local detail. Photos and drawings have plenty."""
    from PIL import ImageFilter, ImageStat
    small = im.convert("L").resize((96, 54))
    edges = small.filter(ImageFilter.FIND_EDGES)
    return ImageStat.Stat(edges).mean[0] < 4.0


def _iter_shapes(shapes, dx=0, dy=0, sx=1.0, sy=1.0):
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    for sh in shapes:
        try:
            x, y, w, h = sh.left or 0, sh.top or 0, sh.width or 0, sh.height or 0
        except Exception:  # noqa: BLE001
            continue
        box = (dx + x * sx, dy + y * sy, w * sx, h * sy)
        if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            xfrm = sh._element.grpSpPr.find(
                "{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm")
            ch = xfrm.find("{http://schemas.openxmlformats.org/drawingml/2006/main}chOff") if xfrm is not None else None
            ce = xfrm.find("{http://schemas.openxmlformats.org/drawingml/2006/main}chExt") if xfrm is not None else None
            cx0, cy0 = (int(ch.get("x")), int(ch.get("y"))) if ch is not None else (x, y)
            cw, chh = (int(ce.get("cx")), int(ce.get("cy"))) if ce is not None else (w, h)
            ksx = (w / cw if cw else 1.0) * sx
            ksy = (h / chh if chh else 1.0) * sy
            yield from _iter_shapes(sh.shapes, box[0] - cx0 * ksx, box[1] - cy0 * ksy, ksx, ksy)
            continue
        yield sh, box


def _frame_blocks(tf, box, *, default_size=18.0):
    """Rendered-text geometry of one text frame: [(ink_rect, text, size, bold, rgb, font)]
    per frame (one rect covering every paragraph), plus the run stats."""
    from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
    x, y, w, h = box
    ml, mr = (tf.margin_left or 0), (tf.margin_right or 0)
    mt, mb = (tf.margin_top or 0), (tf.margin_bottom or 0)
    wrap_on = tf.word_wrap is not False
    avail = max(1.0, (w - ml - mr) / EMU_PER_PT)
    paras = []
    runs_stats = []
    for pi, p in enumerate(tf.paragraphs):
        text = "".join(r.text for r in p.runs) if p.runs else p.text
        sizes, bold, font, rgb = [], False, None, None
        for r in p.runs:
            sz = r.font.size.pt if r.font.size is not None else default_size
            sizes.append(sz)
            chars = len(re.sub(r"\s", "", r.text))
            runs_stats.append((sz, chars, r.font.name))
            if font is None and r.font.name:
                font = r.font.name
            bold = bold or bool(r.font.bold)
            if rgb is None:
                try:
                    if r.font.color is not None and r.font.color.type is not None:
                        rgb = parse_colour(str(r.font.color.rgb))
                except Exception:  # noqa: BLE001
                    rgb = None
        size = max(sizes) if sizes else default_size
        ls = p.line_spacing
        multiple = exact = None
        if isinstance(ls, float):
            multiple = ls
        elif ls is not None:
            exact = ls / EMU_PER_PT
        if not text.strip():
            paras.append({"text": "", "n": 1, "size": size, "multiple": multiple, "exact": exact,
                          "wmax": 0.0, "bold": bold, "font": font, "rgb": rgb,
                          "before": (p.space_before or 0) / EMU_PER_PT if pi else 0.0,
                          "after": (p.space_after or 0) / EMU_PER_PT, "align": p.alignment})
            continue
        if wrap_on:
            lines = fm.wrap(text, avail, size, font=font, bold=bold)
            n = sum(fm.char_wrap_count(ln, avail, size, font=font, bold=bold) for ln in lines)
            wmax = min(avail, max(fm.width(ln, size, font=font, bold=bold) for ln in lines))
        else:
            lines = text.replace("\v", "\n").split("\n")
            n = len(lines)
            wmax = max(fm.width(ln, size, font=font, bold=bold) for ln in lines)
        paras.append({"text": text, "n": n, "size": size, "multiple": multiple, "exact": exact,
                      "wmax": wmax, "bold": bold, "font": font, "rgb": rgb,
                      "before": (p.space_before or 0) / EMU_PER_PT if pi else 0.0,
                      "after": (p.space_after or 0) / EMU_PER_PT, "align": p.alignment})
    if not any(pp["text"].strip() for pp in paras):
        return None, runs_stats
    # Stack the paragraphs: line boxes, then the ink inside them.
    cur = 0.0
    ink_top = ink_bot = None
    total = 0.0
    for pp in paras:
        cur += pp["before"]
        pitch = fm.pitch(pp["size"], pp["multiple"], pp["exact"])
        if pp["text"].strip():
            top = cur + fm.cap_top(pp["size"], pp["multiple"]) - 0.03 * pp["size"]
            bot = cur + fm.cap_top(pp["size"], pp["multiple"]) + fm.CAP_H * pp["size"] \
                + (pp["n"] - 1) * pitch + fm.DESC * pp["size"]
            ink_top = top if ink_top is None else min(ink_top, top)
            ink_bot = bot if ink_bot is None else max(ink_bot, bot)
        cur += pp["n"] * pitch + pp["after"]
        total = cur
    anchor = tf.vertical_anchor
    inner_h = (h - mt - mb) / EMU_PER_PT
    off = 0.0
    if anchor == MSO_ANCHOR.MIDDLE:
        off = (inner_h - total) / 2
    elif anchor == MSO_ANCHOR.BOTTOM:
        off = inner_h - total
    wmax = max(pp["wmax"] for pp in paras)
    align = next((pp["align"] for pp in paras if pp["text"].strip()), None)
    left = x + ml
    if align == PP_ALIGN.CENTER:
        left = x + ml + (avail * EMU_PER_PT - wmax * EMU_PER_PT) / 2 if wrap_on else x + (w - wmax * EMU_PER_PT) / 2
    elif align == PP_ALIGN.RIGHT:
        left = x + w - mr - wmax * EMU_PER_PT
    top_emu = y + mt + (off + ink_top) * EMU_PER_PT
    bot_emu = y + mt + (off + ink_bot) * EMU_PER_PT
    lead = next(pp for pp in paras if pp["text"].strip())
    return {
        "rect": (left, top_emu, wmax * EMU_PER_PT, bot_emu - top_emu),
        "text": " ".join(pp["text"] for pp in paras if pp["text"].strip()),
        "size": lead["size"], "bold": lead["bold"], "rgb": lead["rgb"], "font": lead["font"],
        "first_line_mid": top_emu + 0.45 * lead["size"] * EMU_PER_PT,
    }, runs_stats


def _inter(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return (min(ax + aw, bx + bw) - max(ax, bx), min(ay + ah, by + bh) - max(ay, by))


def _largest_empty(occ, cols, rows):
    """Largest all-empty rectangle in a boolean grid (histogram + stack)."""
    best = 0
    heights = [0] * cols
    for r in range(rows):
        for c in range(cols):
            heights[c] = 0 if occ[r][c] else heights[c] + 1
        stack: list[int] = []
        for c in range(cols + 1):
            hgt = heights[c] if c < cols else 0
            start = c
            while stack and heights[stack[-1]] >= hgt:
                top = stack.pop()
                left = stack[-1] + 1 if stack else 0
                best = max(best, heights[top] * (c - left))
                start = top
            del start
            stack.append(c)
    return best


def _slide_items(s: dict) -> list[tuple[str, list[str]]]:
    """What a slide spec asks to be drawn, per list field: (field, [strings])."""
    def lst(v):
        if v is None:
            return []
        if isinstance(v, dict):
            return list(v.values())
        return list(v) if isinstance(v, (list, tuple)) else [v]

    def txt(v, *keys):
        if isinstance(v, dict):
            for k in keys:
                if v.get(k) not in (None, ""):
                    return str(v[k])
            return ""
        if isinstance(v, (list, tuple)):
            return str(v[0]) if v else ""
        return str(v)

    L = s.get("layout")
    out = []
    if L in ("bars",):
        out.append(("items", [txt(i, "label") for i in lst(s.get("items"))]))
    elif L == "flow":
        out.append(("steps", [txt(i, "label") for i in lst(s.get("steps"))]))
    elif L == "stats":
        out.append(("stats", [txt(i, "value") for i in lst(s.get("stats"))]))
    elif L == "table":
        out.append(("rows", [txt(r) for r in lst(s.get("rows"))]))
    elif L == "matrix":
        out.append(("rows", [txt(r, "label") for r in lst(s.get("rows"))]))
    elif L == "range":
        out.append(("bands", [txt(b, "label") for b in lst(s.get("bands"))]))
    elif L in ("closing",):
        out.append(("points", [txt(p) for p in lst(s.get("points"))]))
    elif L in ("bullets",):
        out.append(("bullets", [txt(p) for p in lst(s.get("bullets"))]))
    elif L == "comparison":
        for i, side in enumerate(lst(s.get("sides"))):
            out.append((f"sides[{i}].points", [txt(p) for p in lst(side.get("points") if isinstance(side, dict) else [])]))
    elif L == "two_column":
        for i, col in enumerate(lst(s.get("columns"))):
            out.append((f"columns[{i}].points", [txt(p) for p in lst(col.get("points") if isinstance(col, dict) else [])]))
    elif L == "hero_split":
        out.append(("body", [txt(p) for p in lst(s.get("body"))]))
    return [(f, [x for x in xs if x.strip()]) for f, xs in out]


def measure_pptx(path: Path, spec: dict | None = None) -> dict:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    prs = Presentation(str(path))
    W, H = prs.slide_width, prs.slide_height
    px = W / 1280.0                                  # 2 px at 1280 wide is the overlap tolerance
    cell = W / GRID_COLS
    rows_n = max(1, int(round(H / cell)))
    total_chars = small_chars = 0
    fonts: set[str] = set()
    overlaps, offcanvas, empties, contrast_fails, dropped = [], [], [], [], []
    decor = 0
    contrast_min = None
    slide_texts = []
    for si, slide in enumerate(prs.slides, 1):
        layers = []          # (box, kind, payload) in z-order, for colour lookup
        texts = []
        occ = [[False] * GRID_COLS for _ in range(rows_n)]
        all_text = []

        def mark(rect):
            x, y, w, h = rect
            c0, c1 = max(0, int(x // cell)), min(GRID_COLS - 1, int((x + w) // cell))
            r0, r1_ = max(0, int(y // cell)), min(rows_n - 1, int((y + h) // cell))
            for rr in range(r0, r1_ + 1):
                for cc in range(c0, c1 + 1):
                    occ[rr][cc] = True

        for zi, (sh, box) in enumerate(_iter_shapes(slide.shapes)):
            x, y, w, h = box
            area = (w * h) / float(W * H) if W and H else 0
            if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
                im = _picture_image(sh)
                layers.append((box, "picture", im))
                if im is not None and (area < 0.12 or not _smooth(im)):
                    mark(box)
                continue
            if getattr(sh, "has_table", False) and sh.has_table:
                tbl = sh.table
                col_w = [c.width for c in tbl.columns]
                ty = y
                for row in tbl.rows:
                    tx = x
                    row_h = row.height
                    for ci, cellobj in enumerate(row.cells):
                        cw = col_w[ci] if ci < len(col_w) else 0
                        blk, stats = _frame_blocks(cellobj.text_frame, (tx, ty, cw, row_h))
                        for sz, ch, fnt in stats:
                            total_chars += ch
                            small_chars += ch if sz < SLIDE_SMALL_PT else 0
                            if fnt:
                                fonts.add(fnt)
                        if blk:
                            all_text.append(blk["text"])
                            need_h = blk["rect"][3] + (cellobj.margin_top or 0) + (cellobj.margin_bottom or 0)
                            row_h = max(row_h, int(need_h))
                        tx += cw
                    ty += row_h
                trect = (x, y, w, ty - y)
                texts.append({"shape": zi, "rect": trect, "text": "[table]", "size": 12, "bold": False,
                              "rgb": None, "table": True})
                mark(trect)
                continue
            fill = _fill_rgb(sh)
            has_text = getattr(sh, "has_text_frame", False) and sh.has_text_frame and sh.text_frame.text.strip()
            if fill is not None:
                layers.append((box, "fill", fill))
                if not has_text:
                    thin = min(w, h) <= 0.2 * EMU_PER_IN and max(w, h) >= 4 * max(1, min(w, h))
                    if thin:
                        decor += 1
                    if area < 0.12:
                        mark(box)
            if has_text:
                blk, stats = _frame_blocks(sh.text_frame, box)
                for sz, ch, fnt in stats:
                    total_chars += ch
                    small_chars += ch if sz < SLIDE_SMALL_PT else 0
                    if fnt:
                        fonts.add(fnt)
                if blk:
                    blk["shape"] = zi
                    blk["layer_index"] = len(layers)
                    texts.append(blk)
                    all_text.append(blk["text"])
                    mark(blk["rect"])
        slide_texts.append(" \n ".join(all_text))

        # Overlaps between different shapes' rendered text.
        for i in range(len(texts)):
            for j in range(i + 1, len(texts)):
                a, b = texts[i], texts[j]
                if a.get("table") and b.get("table"):
                    continue
                iw, ih = _inter(a["rect"], b["rect"])
                if iw > 2 * px and ih > 2 * px:
                    overlaps.append({"slide": si, "a": a["text"][:40], "b": b["text"][:40],
                                     "px": r1(min(iw, ih) / px)})
            x, y, w, h = texts[i]["rect"]
            out = max(0 - x, 0 - y, x + w - W, y + h - H)
            if out > 2 * px:
                offcanvas.append({"slide": si, "text": texts[i]["text"][:40], "px": r1(out / px)})

        # Text contrast against what is under it.
        def under(xp, yp, upto):
            colour = (255, 255, 255)
            for (bx, by, bw, bh), kind, payload in layers[:upto]:
                if not (bx <= xp <= bx + bw and by <= yp <= by + bh):
                    continue
                if kind == "picture":
                    if payload is None:
                        continue
                    iw_, ih_ = payload.size
                    u = min(iw_ - 1, max(0, int((xp - bx) / max(bw, 1) * iw_)))
                    v = min(ih_ - 1, max(0, int((yp - by) / max(bh, 1) * ih_)))
                    colour = payload.getpixel((u, v))[:3]
                else:
                    rgb, alpha = payload
                    if rgb is not None:
                        colour = blend(rgb, colour, alpha) if alpha < 0.999 else rgb
            return colour

        for t in texts:
            if t.get("table") or t.get("layer_index") is None:
                continue
            fg = t["rgb"] or (0, 0, 0)
            x, y, w, h = t["rect"]
            worst = None
            for fx in (0.08, 0.5, 0.92):
                bg = under(x + w * fx, t["first_line_mid"], t["layer_index"])
                c = contrast(fg, bg)
                worst = c if worst is None else min(worst, c)
            need = text_needs(t["size"], t["bold"])
            contrast_min = worst if contrast_min is None else min(contrast_min, worst)
            if worst < need:
                contrast_fails.append({"slide": si, "text": t["text"][:40], "ratio": round(worst, 2), "need": need})

        empty = _largest_empty(occ, GRID_COLS, rows_n) / float(GRID_COLS * rows_n)
        if empty >= EMPTY_REGION_MIN:
            empties.append({"slide": si, "pct": r1(empty * 100)})

    slides_spec = (spec or {}).get("slides") if isinstance(spec, dict) else None
    if isinstance(slides_spec, list):
        for si, s in enumerate(slides_spec, 1):
            if si > len(slide_texts) or not isinstance(s, dict):
                continue
            for field, want in _slide_items(s):
                got = [x for x in want if _present(x, slide_texts[si - 1])]
                if len(got) < len(want):
                    missing = [x for x in want if x not in got]
                    dropped.append({"slide": si, "layout": s.get("layout"), "field": field,
                                    "given": len(want), "drawn": len(got), "missing": [m[:32] for m in missing[:3]]})
    n_slides = len(prs.slides)
    return {
        "slides": n_slides,
        "spec_slides": len(slides_spec) if isinstance(slides_spec, list) else None,
        "text": {"chars": total_chars, "small_threshold": "14pt",
                 "small_pct": r1(100.0 * small_chars / total_chars) if total_chars else 0.0},
        "overlaps": overlaps,
        "offcanvas": offcanvas,
        "empty_regions": empties,
        "dropped": dropped,
        "fonts": sorted(fonts),
        "palette": {"contrast_min": round(contrast_min, 2) if contrast_min is not None else None,
                    "contrast_fails": contrast_fails, "categorical": None},
        "decor_bars": decor,
    }


# ── docx ─────────────────────────────────────────────────────────────────────
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _twips(el, attr="w") -> float | None:
    if el is None:
        return None
    v = el.get(W_NS + attr)
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def _docx_para(p, doc_default: float, width_pt: float):
    """(height_pt, chars, small_chars, fonts, size, rgb, bold, has_page_break) for one paragraph."""
    from docx.shared import Pt  # noqa: F401 — imported for side effects of docx types
    pf = p.paragraph_format
    runs = p.runs
    sizes, fonts, chars, small = [], set(), 0, 0
    rgb = None
    bold = False
    for r in runs:
        sz = r.font.size.pt if r.font.size is not None else doc_default
        sizes.append(sz)
        n = len(re.sub(r"\s", "", r.text))
        chars += n
        small += n if sz < DOC_SMALL_PT else 0
        if r.font.name:
            fonts.add(r.font.name)
        bold = bold or bool(r.font.bold)
        if rgb is None and r.font.color is not None and r.font.color.type is not None:
            try:
                rgb = parse_colour(str(r.font.color.rgb))
            except Exception:  # noqa: BLE001
                rgb = None
    text = p.text
    # The paragraph MARK has a size too: an empty paragraph is one line of it.
    mark_size = doc_default
    rpr = p._p.pPr.find(W_NS + "rPr") if p._p.pPr is not None else None
    if rpr is not None:
        sz = rpr.find(W_NS + "sz")
        if sz is not None and sz.get(W_NS + "val"):
            mark_size = int(sz.get(W_NS + "val")) / 2
    size = max(sizes) if sizes and text.strip() else mark_size
    ls = pf.line_spacing
    rule = pf.line_spacing_rule
    exact = None
    multiple = 1.0
    if isinstance(ls, float):
        multiple = ls
    elif ls is not None:
        exact = ls.pt
    left = (pf.left_indent.pt if pf.left_indent is not None else 0.0)
    right = (pf.right_indent.pt if pf.right_indent is not None else 0.0)
    avail = max(10.0, width_pt - left - right)
    font = next(iter(fonts), None)
    if text.strip():
        lines = fm.wrap(text, avail, size, font=font, bold=bold)
        n = sum(fm.char_wrap_count(ln, avail, size, font=font, bold=bold) for ln in lines)
    else:
        n = 1
    # Word "single" for these fonts is ~1.2 em; an EXACT rule wins outright,
    # an AT-LEAST rule only raises the line.
    from docx.enum.text import WD_LINE_SPACING
    if exact is not None:
        line_h = exact if rule == WD_LINE_SPACING.EXACTLY else max(exact, size * 1.2)
    else:
        line_h = size * 1.2 * multiple
    before = pf.space_before.pt if pf.space_before is not None else 0.0
    after = pf.space_after.pt if pf.space_after is not None else 0.0
    brk = any(br.get(W_NS + "type") == "page" for br in p._p.iter(W_NS + "br"))
    return before + n * line_h + after, chars, small, fonts, size, rgb, bold, brk


def measure_docx(path: Path, spec: dict | None = None) -> dict:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    doc = Document(str(path))
    sec = doc.sections[0]
    page_h = sec.page_height.pt - sec.top_margin.pt - sec.bottom_margin.pt
    content_w = sec.page_width.pt - sec.left_margin.pt - sec.right_margin.pt
    try:
        default = doc.styles["Normal"].font.size.pt if doc.styles["Normal"].font.size else 11.0
    except KeyError:
        default = 11.0
    total = small = 0
    fonts: set[str] = set()
    used = 0.0
    pages = 1
    tables = []
    contrast_fails = []
    contrast_min = None
    all_text = []

    def place(h: float):
        nonlocal used, pages
        if used + h > page_h and used > 0:
            pages += 1
            used = 0.0
        used += h
        while used > page_h:            # one block taller than a page
            pages += 1
            used -= page_h

    for el in doc.element.body.iterchildren():
        tag = el.tag.split("}")[1]
        if tag == "p":
            p = Paragraph(el, doc)
            h, ch, sm, fs, size, rgb, bold, brk = _docx_para(p, default, content_w)
            total += ch
            small += sm
            fonts |= fs
            if p.text.strip():
                all_text.append(p.text)
                c = contrast(rgb or (0, 0, 0), (255, 255, 255))
                contrast_min = c if contrast_min is None else min(contrast_min, c)
                if c < text_needs(size, bold):
                    contrast_fails.append({"text": p.text[:40], "ratio": round(c, 2), "need": text_needs(size, bold)})
            place(h)
            if brk:
                pages += 1
                used = 0.0
        elif tag == "tbl":
            t = Table(el, doc)
            tblPr = el.find(W_NS + "tblPr")
            tblW = tblPr.find(W_NS + "tblW") if tblPr is not None else None
            has_w = tblW is not None and tblW.get(W_NS + "type") in ("dxa", "pct") and float(tblW.get(W_NS + "w") or 0) > 0
            grid = [(_twips(gc) or 0) / 20 for gc in el.iter(W_NS + "gridCol")]
            ncols = len(t.columns)
            width = ((_twips(tblW) or 0) / 20) if has_w and tblW.get(W_NS + "type") == "dxa" else sum(grid)
            col_w = grid if grid and sum(grid) > 0 else [content_w / max(ncols, 1)] * ncols
            height = 0.0
            shaded_text = []
            for row in t.rows:
                trPr = row._tr.find(W_NS + "trPr")
                trh = trPr.find(W_NS + "trHeight") if trPr is not None else None
                row_min = (_twips(trh, "val") or 0) / 20 if trh is not None else 0.0
                exact = trh is not None and trh.get(W_NS + "hRule") == "exact"
                row_need = 0.0
                for ci, cellobj in enumerate(row.cells):
                    cw = col_w[ci] if ci < len(col_w) else content_w / max(ncols, 1)
                    tcMar = cellobj._tc.tcPr.find(W_NS + "tcMar") if cellobj._tc.tcPr is not None else None
                    ml = mr = 5.4
                    mt = mb = 0.0
                    if tcMar is not None:
                        for side, attr in (("left", "ml"), ("start", "ml"), ("right", "mr"), ("end", "mr"), ("top", "mt"), ("bottom", "mb")):
                            e = tcMar.find(W_NS + side)
                            if e is not None:
                                v = (_twips(e) or 0) / 20
                                if attr == "ml":
                                    ml = v
                                elif attr == "mr":
                                    mr = v
                                elif attr == "mt":
                                    mt = v
                                else:
                                    mb = v
                    shade = None
                    if cellobj._tc.tcPr is not None:
                        shd = cellobj._tc.tcPr.find(W_NS + "shd")
                        if shd is not None:
                            shade = parse_colour(shd.get(W_NS + "fill") or "")
                    cell_h = mt + mb
                    for p in cellobj.paragraphs:
                        h, ch, sm, fs, size, rgb, bold, _ = _docx_para(p, default, max(10.0, cw - ml - mr))
                        total += ch
                        small += sm
                        fonts |= fs
                        cell_h += h
                        if p.text.strip():
                            all_text.append(p.text)
                            bg = shade or (255, 255, 255)
                            c = contrast(rgb or (0, 0, 0), bg)
                            contrast_min = c if contrast_min is None else min(contrast_min, c)
                            if c < text_needs(size, bold):
                                contrast_fails.append({"text": p.text[:40], "ratio": round(c, 2), "need": text_needs(size, bold)})
                            shaded_text.append(p.text)
                    row_need = max(row_need, cell_h)
                rh = row_min if exact else max(row_min, row_need)
                height += rh
                place(rh)
            is_rule = len(t.rows) == 1 and ncols == 1 and not any(x.strip() for x in shaded_text)
            tables.append({"cols": ncols, "rows": len(t.rows), "tblW": bool(has_w),
                           "width_in": round(width / 72, 2) if width else None,
                           "rule": is_rule, "height_pt": r1(height)})
    dropped = []
    blocks = (spec or {}).get("blocks") if isinstance(spec, dict) else None
    hay = "\n".join(all_text)
    if isinstance(blocks, list):
        for bi, b in enumerate(blocks, 1):
            if not isinstance(b, dict):
                continue
            want = []
            t = b.get("type")
            if t == "table":
                want = [str(r[0]) for r in (b.get("rows") or []) if isinstance(r, list) and r]
            elif t == "bullets":
                want = [str(x) for x in (b.get("items") or [])]
            elif t == "stats":
                want = [str(x.get("value", "")) for x in (b.get("stats") or []) if isinstance(x, dict)]
            elif t == "body":
                want = [str(x) for x in (b.get("paragraphs") or [])]
            want = [w for w in want if w.strip()]
            got = [w for w in want if _present(w, hay)]
            if len(got) < len(want):
                dropped.append({"block": bi, "type": t, "given": len(want), "drawn": len(got),
                                "missing": [m[:32] for m in want if m not in got][:3]})
    fill = used / page_h if page_h else 0
    return {
        "pages_est": pages,
        "last_page_fill": round(fill, 2),
        "text": {"chars": total, "small_threshold": "10pt",
                 "small_pct": r1(100.0 * small / total) if total else 0.0},
        "tables": tables,
        "dropped": dropped,
        "fonts": sorted(fonts),
        "palette": {"contrast_min": round(contrast_min, 2) if contrast_min is not None else None,
                    "contrast_fails": contrast_fails, "categorical": None},
    }


# ── pdf ──────────────────────────────────────────────────────────────────────
def measure_pdf(path: Path, spec: dict | None = None) -> dict:
    import pypdf
    reader = pypdf.PdfReader(str(path))
    total = small = 0
    fonts: dict[str, bool] = {}
    for page in reader.pages:
        def visit(text, cm, tm, font_dict, font_size):
            nonlocal total, small
            n = len(re.sub(r"\s", "", text or ""))
            if not n:
                return
            k = math.hypot(tm[0], tm[1]) * math.hypot(cm[0], cm[1]) or 1.0
            size = (font_size or 0) * k
            total += n
            small += n if size < DOC_SMALL_PT else 0
        try:
            page.extract_text(visitor_text=visit)
        except Exception:  # noqa: BLE001
            pass
        res = page.get("/Resources") or {}
        fdict = res.get("/Font") or {}
        for ref in fdict.values():
            f = ref.get_object()
            name = str(f.get("/BaseFont", "?")).lstrip("/")
            desc = f.get("/FontDescriptor")
            emb = False
            if desc is not None:
                d = desc.get_object()
                emb = any(k in d for k in ("/FontFile", "/FontFile2", "/FontFile3"))
            fonts[name] = fonts.get(name, False) or emb
    return {
        "pages": len(reader.pages),
        "text": {"chars": total, "small_threshold": "10pt",
                 "small_pct": r1(100.0 * small / total) if total else 0.0},
        "fonts": sorted(fonts),
        "fonts_embedded": bool(fonts) and all(fonts.values()),
        "dropped": [],
        "palette": {"contrast_min": None, "contrast_fails": [], "categorical": None},
    }


# ── svg ──────────────────────────────────────────────────────────────────────
def _svg_attr(el, name, style):
    if el.get(name) is not None:
        return el.get(name)
    m = re.search(rf"(?:^|;)\s*{re.escape(name)}\s*:\s*([^;]+)", style or "")
    return m.group(1).strip() if m else None


def measure_svg(path: Path, spec: dict | None = None) -> dict:
    root = ET.parse(str(path)).getroot()
    ns = "{http://www.w3.org/2000/svg}"
    vb = (root.get("viewBox") or "").split()
    cw = float(vb[2]) if len(vb) == 4 else float(re.sub(r"[^0-9.]", "", root.get("width") or "960") or 960)
    ch = float(vb[3]) if len(vb) == 4 else float(re.sub(r"[^0-9.]", "", root.get("height") or "560") or 560)
    ground = None
    marks: list[tuple[str, float]] = []
    texts = []
    inherited = {}

    def walk(el, parent_style: dict):
        style = dict(parent_style)
        for k in ("fill", "stroke", "font-size", "font-family", "font-weight", "opacity", "fill-opacity",
                  "stroke-width", "text-anchor"):
            v = _svg_attr(el, k, el.get("style"))
            if v is not None:
                style[k] = v
        tag = el.tag.replace(ns, "")
        if tag in ("rect", "path", "circle", "ellipse", "polygon", "polyline", "line"):
            op = float(style.get("opacity", 1) or 1) * float(style.get("fill-opacity", 1) or 1)
            fill = parse_colour(style.get("fill")) if style.get("fill") not in (None, "none") else None
            stroke = parse_colour(style.get("stroke")) if style.get("stroke") not in (None, "none") else None
            nonlocal ground
            if tag == "rect" and fill is not None and ground is None:
                try:
                    w = float(el.get("width", "0").rstrip("%")) if not str(el.get("width", "")).endswith("%") else cw
                    h = float(el.get("height", "0").rstrip("%")) if not str(el.get("height", "")).endswith("%") else ch
                except ValueError:
                    w = h = 0
                if w >= cw * 0.95 and h >= ch * 0.95:
                    ground = fill
                    return
            if fill is not None and op >= 0.3 and tag != "line":
                marks.append((hex_of(fill), 1.0))
            elif stroke is not None and fill is None and tag in ("path", "polyline"):
                try:
                    sw = float(style.get("stroke-width", 1) or 1)
                except ValueError:
                    sw = 1
                if sw >= 2 and float(style.get("opacity", 1) or 1) >= 0.3:
                    marks.append((hex_of(stroke), 1.0))
        if tag == "text":
            content = "".join(el.itertext()).strip()
            if content:
                try:
                    size = float(re.sub(r"[^0-9.]", "", str(style.get("font-size", "16"))) or 16)
                except ValueError:
                    size = 16.0
                try:
                    x = float(el.get("x", "0").split()[0])
                    y = float(el.get("y", "0").split()[0])
                except ValueError:
                    x = y = 0.0
                weight = str(style.get("font-weight", "400"))
                bold = weight in ("bold", "bolder") or (weight.isdigit() and int(weight) >= 600)
                fam = str(style.get("font-family", "")).split(",")[0]
                w = fm.width(content, size, font=fam, bold=bold)
                anchor = style.get("text-anchor", "start")
                x0 = x - w / 2 if anchor == "middle" else x - w if anchor == "end" else x
                rotated = "rotate" in (el.get("transform") or "")
                texts.append({"text": content, "size": size, "bold": bold,
                              "rgb": parse_colour(style.get("fill")) or (0, 0, 0),
                              "rect": (x0, y - 0.74 * size, w, 0.95 * size), "rotated": rotated,
                              "family": fam.strip().strip("'\"")})
        for c in el:
            walk(c, style)

    walk(root, inherited)
    ground = ground or (255, 255, 255)
    chars = sum(len(re.sub(r"\s", "", t["text"])) for t in texts)
    small = sum(len(re.sub(r"\s", "", t["text"])) for t in texts if t["size"] < SVG_SMALL_PX)
    overlaps = []
    flat = [t for t in texts if not t["rotated"]]
    for i in range(len(flat)):
        for j in range(i + 1, len(flat)):
            iw, ih = _inter(flat[i]["rect"], flat[j]["rect"])
            if iw > 2 and ih > 2:
                overlaps.append({"a": flat[i]["text"][:32], "b": flat[j]["text"][:32], "px": r1(min(iw, ih))})
    fails = []
    cmin = None
    for t in texts:
        c = contrast(t["rgb"], ground)
        cmin = c if cmin is None else min(cmin, c)
        need = text_needs(t["size"] * 0.75, t["bold"])     # px -> pt
        if c < need:
            fails.append({"text": t["text"][:32], "ratio": round(c, 2), "need": need})
    seen = []
    for colour, _w in marks:
        if colour not in seen and parse_colour(colour) != ground:
            seen.append(colour)
    title = max(texts, key=lambda t: t["size"])["text"] if texts and max(t["size"] for t in texts) >= 18 else None
    return {
        "size": [cw, ch],
        "title": title,
        "text": {"chars": chars, "small_threshold": "11px",
                 "small_pct": r1(100.0 * small / chars) if chars else 0.0,
                 "min_px": r1(min(t["size"] for t in texts)) if texts else None},
        "overlaps": overlaps,
        "fonts": sorted({t["family"] for t in texts if t["family"]}),
        "dropped": [],
        "palette": {"ground": hex_of(ground), "contrast_min": round(cmin, 2) if cmin is not None else None,
                    "contrast_fails": fails, "categorical": categorical(seen[:8], ground)},
    }


MEASURE = {"pptx": measure_pptx, "docx": measure_docx, "pdf": measure_pdf, "svg": measure_svg}


def measure(kind: str, path: Path, spec: dict | None = None) -> dict:
    return MEASURE[kind](Path(path), spec)


def batch(manifest: list[dict]) -> list[dict]:
    """[{"kind", "file", "spec": path|None}] -> one metrics dict (or {"error"}) each."""
    out = []
    for it in manifest:
        try:
            sp = json.loads(Path(it["spec"]).read_text()) if it.get("spec") else None
            out.append(measure(it["kind"], Path(it["file"]), sp))
        except Exception as err:  # noqa: BLE001 — one bad artifact must not hide the rest
            out.append({"error": f"{type(err).__name__}: {err}"})
    return out


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=sorted(MEASURE) + ["batch"])
    ap.add_argument("file")
    ap.add_argument("--spec")
    a = ap.parse_args()
    if a.kind == "batch":
        print(json.dumps(batch(json.loads(Path(a.file).read_text()))))
    else:
        sp = json.loads(Path(a.spec).read_text()) if a.spec else None
        print(json.dumps(measure(a.kind, Path(a.file), sp), indent=1, sort_keys=True))
