#!/usr/bin/env python3
"""
Spec (JSON) -> a designed PDF. Vector throughout; nothing is rasterised.

Text stays selectable text and every rule, bar and panel is a drawn vector — so
the file scales, prints and can be pulled apart downstream. A PDF built by
screenshotting HTML fails all three, which is why this draws directly rather
than round-tripping through an image.

reportlab's canvas is the low-level API on purpose: platypus flowables give you
a document that looks like a LaTeX article, and the whole point here is that it
should not.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).parent))
import palette as pal  # noqa: E402

W, H = A4
M = 52.0
CW = W - 2 * M
SANS, SANS_B = "Helvetica", "Helvetica-Bold"
SERIF_I = "Times-Italic"


class Doc:
    def __init__(self, path: Path, t):
        self.c = rl_canvas.Canvas(str(path), pagesize=A4)
        self.t = t
        self.y = H - M
        self.page = 1
        self.running = ""

    # ── page furniture ───────────────────────────────────────────────────────
    def footer(self):
        if self.page == 1:
            return
        self.c.setFont(SANS, 7.5)
        self.c.setFillColor(HexColor(self.t.mute))
        self.c.drawString(M, M * 0.55, self.running)
        self.c.drawRightString(W - M, M * 0.55, str(self.page))

    def newpage(self):
        self.footer()
        self.c.showPage()
        self.page += 1
        self.y = H - M

    def need(self, h: float):
        """Break before drawing something that will not fit. Without this a
        block silently runs off the bottom edge — the PDF equivalent of the
        overlap bugs that plagued the deck renderer."""
        if self.y - h < M + 24:
            self.newpage()

    # ── primitives ───────────────────────────────────────────────────────────
    def rect(self, x, y, w, h, colour):
        self.c.setFillColor(HexColor(colour))
        self.c.rect(x, y, w, h, stroke=0, fill=1)

    def para(self, text, *, size=10.5, colour=None, font=SANS, leading=1.45,
             width=None, x=None, gap=6):
        width = width or CW
        x = M if x is None else x
        lines = simpleSplit(str(text), font, size, width)
        lh = size * leading
        self.need(len(lines) * lh + gap)
        self.c.setFont(font, size)
        self.c.setFillColor(HexColor(colour or self.t.ink))
        for ln in lines:
            self.c.drawString(x, self.y - size, ln)
            self.y -= lh
        self.y -= gap
        return self.y


# ── blocks ────────────────────────────────────────────────────────────────────
def B_cover(d, b):
    t = d.c, d.t
    c, th = t
    # Full-bleed field with the title reversed out; one accent bar as the motif.
    d.rect(0, 0, W, H, th.deep)
    d.rect(0, H * 0.62, W, 4, th.accent)
    y = H * 0.52
    if b.get("eyebrow"):
        c.setFont(SANS_B, 8.5)
        c.setFillColor(HexColor(th.accent))
        c.drawString(M, y + 26, str(b["eyebrow"]).upper())
    title = str(b.get("title", ""))
    size = 30 if len(title) < 52 else 24
    lines = simpleSplit(title, SANS_B, size, CW * 0.86)
    c.setFont(SANS_B, size)
    c.setFillColor(HexColor(th.on(th.deep)))
    for ln in lines:
        c.drawString(M, y, ln)
        y -= size * 1.14
    if b.get("subtitle"):
        c.setFont(SANS, 12)
        c.setFillColor(HexColor(th.support))
        for ln in simpleSplit(str(b["subtitle"]), SANS, 12, CW * 0.7):
            y -= 18
            c.drawString(M, y, ln)
    if b.get("byline"):
        c.setFont(SANS, 8.5)
        c.setFillColor(HexColor(th.support))
        c.drawString(M, M, str(b["byline"]))
    d.newpage()


def B_heading(d, b):
    d.need(58)
    d.y -= 10
    d.c.setFont(SANS_B, 15)
    d.c.setFillColor(HexColor(d.t.primary))
    d.c.drawString(M, d.y - 15, str(b.get("title", "")))
    d.y -= 22
    d.rect(M, d.y, 34, 3, d.t.accent)
    d.y -= 14
    if b.get("standfirst"):
        d.para(b["standfirst"], size=10.5, colour=d.t.mute, gap=8)


def B_body(d, b):
    for p in (b.get("paragraphs") or [])[:8]:
        d.para(p, size=10.5, colour=d.t.ink, gap=7)


def B_callout(d, b):
    text = str(b.get("text", ""))
    lines = simpleSplit(text, SANS_B, 11.5, CW - 34)
    h = len(lines) * 16 + 26
    d.need(h + 12)
    d.rect(M, d.y - h, CW, h, d.t.faint)
    d.rect(M, d.y - h, 3.5, h, d.t.accent)
    yy = d.y - 18
    if b.get("label"):
        d.c.setFont(SANS_B, 8)
        d.c.setFillColor(HexColor(d.t.accent))
        d.c.drawString(M + 16, yy, str(b["label"]).upper())
        yy -= 15
    d.c.setFont(SANS_B, 11.5)
    d.c.setFillColor(HexColor(d.t.ink))
    for ln in lines:
        d.c.drawString(M + 16, yy, ln)
        yy -= 16
    d.y -= h + 14


def B_stats(d, b):
    items = (b.get("stats") or [])[:4]
    if not items:
        return
    d.need(76)
    colw = CW / len(items)
    top = d.y
    for i, it in enumerate(items):
        x = M + i * colw
        d.c.setFont(SANS_B, 25)
        d.c.setFillColor(HexColor(d.t.primary))
        d.c.drawString(x, top - 26, str(it.get("value", "")))
        d.rect(x, top - 36, 20, 2.5, d.t.accent)
        d.c.setFont(SANS, 8.5)
        d.c.setFillColor(HexColor(d.t.mute))
        for j, ln in enumerate(simpleSplit(str(it.get("label", "")), SANS, 8.5, colw - 12)[:2]):
            d.c.drawString(x, top - 50 - j * 11, ln)
    d.y = top - 76


def B_bars(d, b):
    """A drawn bar chart — vector, labelled, and no chart-library defaults."""
    items = (b.get("items") or [])[:6]
    if not items:
        return
    vals = []
    for it in items:
        try:
            vals.append(float(str(it.get("value", 0)).replace(",", "").replace("%", "")))
        except ValueError:
            vals.append(0.0)
    top_v = max(vals) or 1.0
    row_h, gap = 17.0, 13.0
    h = len(items) * (row_h + gap) + 12
    d.need(h)
    label_w = CW * 0.30
    bar_max = CW - label_w - 58
    y = d.y - 12
    hi = b.get("highlight_index")
    for i, (it, v) in enumerate(zip(items, vals)):
        d.c.setFont(SANS, 9)
        d.c.setFillColor(HexColor(d.t.ink))
        d.c.drawString(M, y + 4, str(it.get("label", ""))[:44])
        d.rect(M + label_w, y, bar_max, row_h * 0.62, d.t.faint)
        w = bar_max * (v / top_v)
        d.rect(M + label_w, y, max(w, 2), row_h * 0.62,
               d.t.accent if i == hi else d.t.primary)
        d.c.setFont(SANS_B, 9)
        d.c.setFillColor(HexColor(d.t.accent if i == hi else d.t.primary))
        d.c.drawString(M + label_w + bar_max + 8, y + 2,
                       str(it.get("display", it.get("value", ""))))
        y -= row_h + gap
    d.y = y - 4


def B_table(d, b):
    headers = [str(x) for x in (b.get("headers") or [])]
    rows = (b.get("rows") or [])[:14]
    if not headers:
        return
    colw = CW / len(headers)
    d.need(28 + len(rows) * 19 + 10)
    d.rect(M, d.y - 21, CW, 21, d.t.deep)
    d.c.setFont(SANS_B, 8.8)
    d.c.setFillColor(HexColor(d.t.on(d.t.deep)))
    for i, h in enumerate(headers):
        d.c.drawString(M + i * colw + 7, d.y - 14, h[:26])
    d.y -= 21
    for r, row in enumerate(rows):
        if r % 2 == 0:
            d.rect(M, d.y - 19, CW, 19, d.t.faint)
        for i in range(len(headers)):
            val = str(row[i]) if isinstance(row, list) and i < len(row) else ""
            d.c.setFont(SANS_B if i == 0 else SANS, 9)
            d.c.setFillColor(HexColor(d.t.ink))
            d.c.drawString(M + i * colw + 7, d.y - 13, val[:30])
        d.y -= 19
    d.y -= 14


def B_quote(d, b):
    text = "“" + str(b.get("quote", "")) + "”"
    lines = simpleSplit(text, SERIF_I, 15, CW * 0.84)
    d.need(len(lines) * 22 + 40)
    d.rect(M, d.y - len(lines) * 22 - 8, 3, len(lines) * 22 + 8, d.t.accent)
    d.c.setFont(SERIF_I, 15)
    d.c.setFillColor(HexColor(d.t.primary))
    yy = d.y - 16
    for ln in lines:
        d.c.drawString(M + 16, yy, ln)
        yy -= 22
    d.y = yy - 4
    if b.get("attribution"):
        d.c.setFont(SANS, 9)
        d.c.setFillColor(HexColor(d.t.mute))
        d.c.drawString(M + 16, d.y, "— " + str(b["attribution"]))
        d.y -= 20


def B_bullets(d, b):
    for item in (b.get("items") or [])[:10]:
        lines = simpleSplit(str(item), SANS, 10.5, CW - 20)
        d.need(len(lines) * 15 + 6)
        d.rect(M + 1, d.y - 8, 4, 4, d.t.accent)
        d.c.setFont(SANS, 10.5)
        d.c.setFillColor(HexColor(d.t.ink))
        for j, ln in enumerate(lines):
            d.c.drawString(M + 14, d.y - 10 - j * 14, ln)
        d.y -= len(lines) * 14 + 8


BLOCKS = {"cover": B_cover, "heading": B_heading, "body": B_body,
          "callout": B_callout, "stats": B_stats, "bars": B_bars,
          "table": B_table, "quote": B_quote, "bullets": B_bullets}


def build(spec: dict, out: Path) -> Path:
    t = pal.from_spec(spec)
    out.parent.mkdir(parents=True, exist_ok=True)
    d = Doc(out, t)
    d.running = str(spec.get("running_title", ""))
    for b in spec.get("blocks", []):
        fn = BLOCKS.get(b.get("type"))
        if fn is None:
            fn, b = B_body, {**b, "paragraphs": b.get("paragraphs") or [b.get("text", "")]}
        try:
            fn(d, b)
        except Exception as err:  # noqa: BLE001
            print(f"  ! block {b.get('type')} failed: {err}")
    d.footer()
    d.c.save()
    return out


if __name__ == "__main__":
    spec = json.loads(Path(sys.argv[1]).read_text())
    p = build(spec, Path(sys.argv[2]))
    print(f"wrote {p}")
