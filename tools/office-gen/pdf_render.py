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

VQ-01 (2026-09-23): bar values parse as written ("22M", "$38k") and a unit-only
display keeps its number; table cells WRAP inside their column instead of being
cut at 30 characters (a header at 26), and a table breaks across pages with its
header repeated; a list longer than a block holds is cut AND reported; a block
that fails is tried on a scratch canvas first, so it cannot leave half its
drawing on the page.
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as rl_canvas

sys.path.insert(0, str(Path(__file__).parent))
import numparse  # noqa: E402
import palette as pal  # noqa: E402

W, H = A4
M = 52.0
CW = W - 2 * M
SANS, SANS_B = "Helvetica", "Helvetica-Bold"
SERIF_I = "Times-Italic"


def _s(v) -> str:
    return numparse.as_text(v)


class BlockReport:
    def __init__(self, index: int, kind: str):
        self.index, self.kind = index, kind
        self.head = ""
        self.items: list[str] = []
        self.cuts: list[tuple[str, int, int]] = []
        self.notes: list[str] = []

    def as_dict(self) -> dict:
        return {"block": self.index, "type": self.kind, "head": self.head, "items": self.items,
                "cuts": [{"field": f, "given": g, "shown": s} for f, g, s in self.cuts],
                "notes": self.notes}


_R: BlockReport | None = None


def _cap(seq, n: int, field: str) -> list:
    items = list(seq) if isinstance(seq, (list, tuple)) else ([] if seq is None else [seq])
    if len(items) > n and _R is not None:
        _R.cuts.append((field, len(items), n))
    return items[:n]


def _fit_line(text: str, font: str, size: float, width: float) -> str:
    """One line that fits `width`, with an ellipsis when it had to be shortened."""
    text = _s(text)
    if stringWidth(text, font, size) <= width:
        return text
    while text and stringWidth(text + "…", font, size) > width:
        text = text[:-1]
    if _R is not None:
        _R.notes.append("a label was too long for its space and was shortened with an ellipsis")
    return text.rstrip() + "…"


class Doc:
    def __init__(self, path, t):
        self.c = rl_canvas.Canvas(path if isinstance(path, io.BytesIO) else str(path), pagesize=A4)
        self.t = t
        self.y = H - M
        self.page = 1
        self.running = ""
        # A cover owns its whole page; whatever comes next starts a new one —
        # but only if something does come next (no blank page at the end).
        self.pending = False

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
        if self.pending:
            self.pending = False
            self.newpage()
            return
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
        lines = simpleSplit(_s(text), font, size, width)
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
    c, th = d.c, d.t
    # A cover that is not the first thing on its page gets a page of its own:
    # the full-bleed field used to be painted OVER whatever the page already
    # held (a quote and a paragraph vanished under a closing "cover" — REAL,
    # the 4B's Annual Unit Sales PDF).
    if d.pending or d.y < H - M - 1:
        d.pending = False
        d.newpage()
    # Full-bleed field with the title reversed out; one accent bar as the motif.
    d.rect(0, 0, W, H, th.deep)
    d.rect(0, H * 0.62, W, 4, th.accent)
    y = H * 0.52
    if b.get("eyebrow"):
        c.setFont(SANS_B, 8.5)
        c.setFillColor(HexColor(th.accent))
        c.drawString(M, y + 26, _fit_line(_s(b["eyebrow"]).upper(), SANS_B, 8.5, CW))
    title = _s(b.get("title", ""))
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
        for ln in simpleSplit(_s(b["subtitle"]), SANS, 12, CW * 0.7):
            y -= 18
            c.drawString(M, y, ln)
    if b.get("byline"):
        c.setFont(SANS, 8.5)
        c.setFillColor(HexColor(th.support))
        c.drawString(M, M, _fit_line(b["byline"], SANS, 8.5, CW))
    if _R is not None:
        _R.head = title
    d.pending = True


def B_heading(d, b):
    d.need(58)
    d.y -= 10
    title = _s(b.get("title", ""))
    lines = simpleSplit(title, SANS_B, 15, CW)
    d.c.setFont(SANS_B, 15)
    d.c.setFillColor(HexColor(d.t.primary))
    for i, ln in enumerate(lines):
        d.c.drawString(M, d.y - 15 - i * 19, ln)
    d.y -= 22 + (len(lines) - 1) * 19
    d.rect(M, d.y, 34, 3, d.t.accent)
    d.y -= 14
    if b.get("standfirst"):
        d.para(b["standfirst"], size=10.5, colour=d.t.mute, gap=8)
    if _R is not None:
        _R.head = title


def B_body(d, b):
    paras = _cap(b.get("paragraphs") or [], 8, "paragraphs")
    for p in paras:
        d.para(p, size=10.5, colour=d.t.ink, gap=7)
    if _R is not None:
        _R.items = [_s(p) for p in paras]


def B_callout(d, b):
    text = _s(b.get("text", ""))
    lines = simpleSplit(text, SANS_B, 11.5, CW - 34)
    h = len(lines) * 16 + 26 + (15 if b.get("label") else 0)
    d.need(h + 12)
    d.rect(M, d.y - h, CW, h, d.t.faint)
    d.rect(M, d.y - h, 3.5, h, d.t.accent)
    yy = d.y - 18
    if b.get("label"):
        d.c.setFont(SANS_B, 8)
        d.c.setFillColor(HexColor(d.t.accent))
        d.c.drawString(M + 16, yy, _fit_line(_s(b["label"]).upper(), SANS_B, 8, CW - 34))
        yy -= 15
    d.c.setFont(SANS_B, 11.5)
    d.c.setFillColor(HexColor(d.t.ink))
    for ln in lines:
        d.c.drawString(M + 16, yy, ln)
        yy -= 16
    d.y -= h + 14
    if _R is not None:
        _R.head = _s(b.get("label"))
        _R.items = [text]


def B_stats(d, b):
    items = _cap(b.get("stats") or [], 4, "stats")
    if not items:
        return
    colw = CW / len(items)
    values = [_s(it.get("value", "") if isinstance(it, dict) else it) for it in items]
    labels = [_s(it.get("label", "") if isinstance(it, dict) else "") for it in items]
    size = 14
    for cand in (25, 22, 19, 16, 14):
        size = cand
        if all(stringWidth(v, SANS_B, cand) <= colw - 12 for v in values):
            break
    label_lines = [simpleSplit(lab, SANS, 8.5, colw - 12) for lab in labels]
    extra = max(0, max(len(x) for x in label_lines) - 2) * 11
    d.need(76 + extra)
    top = d.y
    for i, (value, lines) in enumerate(zip(values, label_lines)):
        x = M + i * colw
        d.c.setFont(SANS_B, size)
        d.c.setFillColor(HexColor(d.t.primary))
        d.c.drawString(x, top - 26, value)
        d.rect(x, top - 36, 20, 2.5, d.t.accent)
        d.c.setFont(SANS, 8.5)
        d.c.setFillColor(HexColor(d.t.mute))
        for j, ln in enumerate(lines):
            d.c.drawString(x, top - 50 - j * 11, ln)
    d.y = top - 76 - extra
    if _R is not None:
        _R.items = [f"{v} {lab}".strip() for v, lab in zip(values, labels)]


def B_bars(d, b):
    """A drawn bar chart — vector, labelled, and no chart-library defaults."""
    items = _cap(b.get("items") or [], 6, "items")
    if not items:
        return
    vals, shown = [], []
    for it in items:
        value = it.get("value", 0) if isinstance(it, dict) else it
        p = numparse.parse(value)
        if p is None and _R is not None:
            _R.notes.append(f"'{_s(value)}' is not a number, drawn as an empty bar")
        vals.append(p.value if p is not None else 0.0)
        shown.append(numparse.shown(value, it.get("display") if isinstance(it, dict) else None))
    top_v = max(vals) if vals and max(vals) > 0 else 1.0
    row_h, gap = 17.0, 13.0
    h = len(items) * (row_h + gap) + 12
    d.need(h)
    label_w = CW * 0.30
    value_w = max(58.0, max(stringWidth(s, SANS_B, 9) for s in shown) + 10)
    bar_max = CW - label_w - value_w
    y = d.y - 12
    hi = b.get("highlight_index")
    hi = int(hi) if isinstance(hi, (int, float)) and not isinstance(hi, bool) else None
    for i, (it, v, disp) in enumerate(zip(items, vals, shown)):
        label = _s(it.get("label", "") if isinstance(it, dict) else "")
        d.c.setFont(SANS, 9)
        d.c.setFillColor(HexColor(d.t.ink))
        d.c.drawString(M, y + 4, _fit_line(label, SANS, 9, label_w - 8))
        d.rect(M + label_w, y, bar_max, row_h * 0.62, d.t.faint)
        w = bar_max * max(0.0, min(1.0, v / top_v))
        d.rect(M + label_w, y, max(w, 2), row_h * 0.62,
               d.t.accent if i == hi else d.t.primary)
        d.c.setFont(SANS_B, 9)
        d.c.setFillColor(HexColor(d.t.accent if i == hi else d.t.primary))
        d.c.drawString(M + label_w + bar_max + 8, y + 2, disp)
        y -= row_h + gap
    d.y = y - 4
    if _R is not None:
        _R.items = [f"{_s(it.get('label', '') if isinstance(it, dict) else '')} {s}".strip()
                    for it, s in zip(items, shown)]


def B_table(d, b):
    headers = [_s(x) for x in (b.get("headers") or [])]
    rows = [r if isinstance(r, list) else [r] for r in _cap(b.get("rows") or [], 14, "rows")]
    ncols = max([len(headers)] + [len(r) for r in rows] + [0])
    if ncols == 0:
        return
    headers += [""] * (ncols - len(headers))
    colw = CW / ncols

    def header_row():
        hl = [simpleSplit(hh, SANS_B, 8.8, colw - 14) or [""] for hh in headers]
        hh_ = max(len(x) for x in hl) * 11 + 10
        d.rect(M, d.y - hh_, CW, hh_, d.t.deep)
        d.c.setFont(SANS_B, 8.8)
        d.c.setFillColor(HexColor(d.t.on(d.t.deep)))
        for i, lines in enumerate(hl):
            for j, ln in enumerate(lines):
                d.c.drawString(M + i * colw + 7, d.y - 14 - j * 11, ln)
        d.y -= hh_

    d.need(28 + min(len(rows), 3) * 19 + 10)
    header_row()
    for r, row in enumerate(rows):
        cells = [simpleSplit(_s(row[i]) if i < len(row) else "", SANS_B if i == 0 else SANS, 9, colw - 14) or [""]
                 for i in range(ncols)]
        rh = max(len(x) for x in cells) * 11.5 + 7.5
        if d.y - rh < M + 24:
            d.newpage()
            header_row()
        if r % 2 == 0:
            d.rect(M, d.y - rh, CW, rh, d.t.faint)
        for i, lines in enumerate(cells):
            d.c.setFont(SANS_B if i == 0 else SANS, 9)
            d.c.setFillColor(HexColor(d.t.ink))
            for j, ln in enumerate(lines):
                d.c.drawString(M + i * colw + 7, d.y - 13 - j * 11.5, ln)
        d.y -= rh
    d.y -= 14
    if _R is not None:
        _R.head = " · ".join(h for h in headers if h)
        _R.items = [_s(r[0]) if r else "" for r in rows]


def B_quote(d, b):
    text = "“" + _s(b.get("quote", "")) + "”"
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
        d.c.drawString(M + 16, d.y, _fit_line("— " + _s(b["attribution"]), SANS, 9, CW - 16))
        d.y -= 20
    if _R is not None:
        _R.head = _s(b.get("quote"))


def B_bullets(d, b):
    items = _cap(b.get("items") or [], 10, "items")
    for item in items:
        lines = simpleSplit(_s(item), SANS, 10.5, CW - 20)
        d.need(len(lines) * 15 + 6)
        d.rect(M + 1, d.y - 8, 4, 4, d.t.accent)
        d.c.setFont(SANS, 10.5)
        d.c.setFillColor(HexColor(d.t.ink))
        for j, ln in enumerate(lines):
            d.c.drawString(M + 14, d.y - 10 - j * 14, ln)
        d.y -= len(lines) * 14 + 8
    if _R is not None:
        _R.items = [_s(x) for x in items]


BLOCKS = {"cover": B_cover, "heading": B_heading, "body": B_body,
          "callout": B_callout, "stats": B_stats, "bars": B_bars,
          "table": B_table, "quote": B_quote, "bullets": B_bullets}


def _dry_run(fn, d: Doc, b: dict) -> Exception | None:
    """Draw the block on a throwaway canvas first: a canvas cannot be undone, so
    a block that fails halfway must fail HERE, not on the page."""
    scratch = Doc(io.BytesIO(), d.t)
    scratch.y, scratch.page, scratch.running, scratch.pending = d.y, d.page, d.running, d.pending
    global _R
    real = _R
    _R = None
    try:
        fn(scratch, b)
        return None
    except Exception as err:  # noqa: BLE001
        return err
    finally:
        _R = real


def build(spec: dict, out: Path, drawn: list | None = None, warnings: list | None = None) -> Path:
    global _R
    t = pal.from_spec(spec)
    out.parent.mkdir(parents=True, exist_ok=True)
    d = Doc(out, t)
    d.running = _s(spec.get("running_title", ""))
    for i, b in enumerate(spec.get("blocks", []), 1):
        if not isinstance(b, dict):
            b = {"type": "body", "paragraphs": [_s(b)]}
        kind = _s(b.get("type")) or "body"
        _R = BlockReport(i, kind)
        fn = BLOCKS.get(kind)
        if fn is None:
            _R.notes.append(f"block type '{kind}' does not exist; set as body text")
            fn, b = B_body, {**b, "paragraphs": b.get("paragraphs") or [b.get("text", "")]}
        err = _dry_run(fn, d, b)
        if err is None:
            fn(d, b)
        else:
            print(f"  ! block {i} ({kind}) failed: {err}", file=sys.stderr)
            _R.notes.append(f"could not be drawn ({type(err).__name__}: {err}); left out")
        if drawn is not None:
            drawn.append(_R.as_dict())
        if warnings is not None:
            for field, given, shown in _R.cuts:
                warnings.append(f"block {i} ({kind}): {field} — {shown} of {given} shown; "
                                f"the block holds {shown}, put the rest in another block")
            for note in dict.fromkeys(_R.notes):
                warnings.append(f"block {i} ({kind}): {note}")
    _R = None
    d.footer()
    d.c.save()
    return out


if __name__ == "__main__":
    spec = json.loads(Path(sys.argv[1]).read_text())
    warn: list[str] = []
    p = build(spec, Path(sys.argv[2]), warnings=warn)
    print(f"wrote {p}")
    for w in warn:
        print(f"  ! {w}")
