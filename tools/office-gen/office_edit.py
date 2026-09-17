#!/usr/bin/env python3
"""
Edit an EXISTING .pptx / .docx / .xlsx — inspect, then apply operations.

THE SHAPE. Generation is one-way: a spec goes in, a file comes out. Editing has
to work the other way round, and the naive version — hand the model the XML and
ask for a patch — fails for the same reason every other raw-format approach in
this project failed: a 4B model cannot hold OOXML in its head, and a single
malformed element corrupts the file with no error until someone opens it.

So the file is reduced to an OUTLINE first: every editable thing gets a short
stable id, its text, its box and its colours. The model then returns a list of
operations against those ids. It never sees or writes XML, its output is a flat
list of small objects that a grammar can constrain, and an operation naming an
id that does not exist is REPORTED rather than silently skipped — which is the
difference between "I edited 6 files" and knowing an edit landed.

Ids are positional and stable within one inspect→apply cycle:
    pptx   s2.3      slide 2, shape 3
    docx   p12       paragraph 12          t1.r0.c2   table 1, row 0, cell 2
    xlsx   B7        the cell (already stable)

PDF IS NOT HERE, and that is deliberate rather than unfinished. A PDF has no
document model to edit — text is placement instructions, not paragraphs. The
honest options are page-level operations (pypdf) or re-rendering from the spec,
and pretending otherwise would produce an edit tool that quietly does nothing.
"""
from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

EMU_PER_IN = 914400


# ── helpers ───────────────────────────────────────────────────────────────────
def _hex(c) -> str | None:
    """A colour as #RRGGBB, or None when it is inherited/absent. python-pptx
    raises rather than returning None for theme-inherited colours, so every
    read of one has to be guarded."""
    try:
        if c is None:
            return None
        rgb = getattr(c, "rgb", None)
        return f"#{rgb}" if rgb is not None else None
    except Exception:  # noqa: BLE001 - inherited/theme colour
        return None


def _shape_fill(shape) -> str | None:
    try:
        f = shape.fill
        if f.type is None or f.type == 5:  # None / background
            return None
        return _hex(f.fore_color)
    except Exception:  # noqa: BLE001
        return None


def _set_text_keep_style(container, text: str) -> None:
    """Replace text WITHOUT losing the run formatting.

    Assigning to `.text` drops every run and takes the paragraph back to the
    style default — which is how a "just change the wording" edit silently
    destroys the typography the generator chose. Instead keep run 0, retype it,
    and drop the rest.
    """
    paras = container.paragraphs
    if not paras:
        return
    p0 = paras[0]
    if p0.runs:
        p0.runs[0].text = text
        for r in p0.runs[1:]:
            r._r.getparent().remove(r._r)
    else:
        p0.add_run().text = text
    # Any further paragraphs belonged to the old wording.
    for p in paras[1:]:
        p._p.getparent().remove(p._p)


# ── pptx ──────────────────────────────────────────────────────────────────────
def inspect_pptx(path: Path) -> dict:
    from pptx import Presentation

    prs = Presentation(str(path))
    slides = []
    for si, sl in enumerate(prs.slides, start=1):
        shapes = []
        for shi, sh in enumerate(sl.shapes):
            item = {
                "id": f"s{si}.{shi}",
                "kind": str(sh.shape_type).split(" ")[0].lower() if sh.shape_type else "shape",
                "x": round(sh.left / EMU_PER_IN, 2) if sh.left is not None else None,
                "y": round(sh.top / EMU_PER_IN, 2) if sh.top is not None else None,
                "w": round(sh.width / EMU_PER_IN, 2) if sh.width is not None else None,
                "h": round(sh.height / EMU_PER_IN, 2) if sh.height is not None else None,
            }
            fill = _shape_fill(sh)
            if fill:
                item["fill"] = fill
            if sh.has_text_frame:
                txt = sh.text_frame.text.strip()
                if txt:
                    item["text"] = txt[:300]
                    runs = [r for p in sh.text_frame.paragraphs for r in p.runs]
                    if runs:
                        item["size"] = runs[0].font.size.pt if runs[0].font.size else None
                        item["bold"] = bool(runs[0].font.bold)
                        col = _hex(runs[0].font.color)
                        if col:
                            item["color"] = col
            shapes.append(item)
        slides.append({"slide": si, "shapes": shapes})
    return {"format": "pptx", "slides": slides,
            "size": {"w": round(prs.slide_width / EMU_PER_IN, 2),
                     "h": round(prs.slide_height / EMU_PER_IN, 2)}}


def _pptx_shape(prs, sid: str):
    slide_s, _, shape_s = sid.partition(".")
    si = int(slide_s.lstrip("s")) - 1
    shi = int(shape_s)
    slides = list(prs.slides)
    if si < 0 or si >= len(slides):
        raise KeyError(f"no slide {si + 1}")
    shapes = list(slides[si].shapes)
    if shi < 0 or shi >= len(shapes):
        raise KeyError(f"slide {si + 1} has no shape {shi}")
    return shapes[shi]


def apply_pptx(path: Path, ops: list[dict], out: Path) -> list[str]:
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.util import Emu, Pt

    prs = Presentation(str(path))
    report: list[str] = []

    def rgb(h):
        return RGBColor.from_string(str(h).lstrip("#").upper())

    # Slide-level ops run LAST: they renumber slides, and an id captured from
    # the outline refers to the ORIGINAL numbering. Applying a delete first
    # would silently retarget every later shape op by one.
    shape_ops = [o for o in ops if o.get("op") not in
                 ("delete_slide", "reorder_slides", "duplicate_slide", "insert_chart")]
    slide_ops = [o for o in ops if o.get("op") in
                 ("delete_slide", "reorder_slides", "duplicate_slide")]
    # A chart lands on a slide by NUMBER (office_chart.py), before the
    # slide-level ops renumber anything.
    chart_ops = [o for o in ops if o.get("op") == "insert_chart"]

    for o in chart_ops:
        try:
            import office_chart
            r = office_chart.insert_pptx(prs, int(o.get("slide", 1)), Path(o["file"]).expanduser(),
                                         _box(o))
            report.append(f"ok insert_chart slide {r['slide']} box {r['box_in']} in ({r['made']})")
        except Exception as err:  # noqa: BLE001
            report.append(f"FAIL insert_chart: {err}")

    for o in shape_ops:
        op = o.get("op")
        try:
            sid = o.get("id", "")
            sh = _pptx_shape(prs, sid)
            if op == "set_text":
                if not sh.has_text_frame:
                    report.append(f"skip {sid}: not a text shape")
                    continue
                _set_text_keep_style(sh.text_frame, str(o.get("text", "")))
                report.append(f"ok set_text {sid}")
            elif op == "set_style":
                if not sh.has_text_frame:
                    report.append(f"skip {sid}: not a text shape")
                    continue
                for p in sh.text_frame.paragraphs:
                    for r in p.runs:
                        if o.get("size") is not None:
                            r.font.size = Pt(float(o["size"]))
                        if o.get("bold") is not None:
                            r.font.bold = bool(o["bold"])
                        if o.get("italic") is not None:
                            r.font.italic = bool(o["italic"])
                        if o.get("color"):
                            r.font.color.rgb = rgb(o["color"])
                report.append(f"ok set_style {sid}")
            elif op == "set_fill":
                col = o.get("color")
                if col in (None, "none", "None"):
                    sh.fill.background()
                else:
                    sh.fill.solid()
                    sh.fill.fore_color.rgb = rgb(col)
                report.append(f"ok set_fill {sid}")
            elif op == "move":
                if o.get("x") is not None:
                    sh.left = Emu(int(float(o["x"]) * EMU_PER_IN))
                if o.get("y") is not None:
                    sh.top = Emu(int(float(o["y"]) * EMU_PER_IN))
                report.append(f"ok move {sid}")
            elif op == "resize":
                if o.get("w") is not None:
                    sh.width = Emu(int(float(o["w"]) * EMU_PER_IN))
                if o.get("h") is not None:
                    sh.height = Emu(int(float(o["h"]) * EMU_PER_IN))
                report.append(f"ok resize {sid}")
            elif op == "delete":
                sh._element.getparent().remove(sh._element)
                report.append(f"ok delete {sid}")
            else:
                report.append(f"UNKNOWN op {op!r}")
        except Exception as err:  # noqa: BLE001
            report.append(f"FAIL {op} {o.get('id')}: {err}")

    id_lst = prs.slides._sldIdLst
    for o in slide_ops:
        op = o.get("op")
        try:
            entries = list(id_lst)
            if op == "delete_slide":
                n = int(o["slide"]) - 1
                rid = entries[n].rId
                prs.part.drop_rel(rid)
                id_lst.remove(entries[n])
                report.append(f"ok delete_slide {n + 1}")
            elif op == "reorder_slides":
                order = [int(i) - 1 for i in o["order"]]
                if sorted(order) != list(range(len(entries))):
                    report.append(f"FAIL reorder_slides: {o['order']} is not a permutation")
                    continue
                for e in entries:
                    id_lst.remove(e)
                for i in order:
                    id_lst.append(entries[i])
                report.append("ok reorder_slides")
            elif op == "duplicate_slide":
                # Copying the slide PART is the only way that keeps images and
                # charts; a deepcopy of the element alone carries relationship
                # ids that point at nothing in the new part.
                n = int(o["slide"]) - 1
                src = list(prs.slides)[n]
                new = prs.slides.add_slide(src.slide_layout)
                for sh in src.shapes:
                    new.shapes._spTree.append(copy.deepcopy(sh._element))
                report.append(f"ok duplicate_slide {n + 1} (relationship-bearing "
                              "shapes such as images are NOT carried)")
        except Exception as err:  # noqa: BLE001
            report.append(f"FAIL {op}: {err}")

    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out))
    return report


# ── docx ──────────────────────────────────────────────────────────────────────
def inspect_docx(path: Path) -> dict:
    from docx import Document

    doc = Document(str(path))
    paras = []
    for i, p in enumerate(doc.paragraphs):
        txt = p.text.strip()
        if not txt:
            continue
        item = {"id": f"p{i}", "text": txt[:300], "style": p.style.name if p.style else None}
        if p.runs:
            r = p.runs[0]
            item["size"] = r.font.size.pt if r.font.size else None
            item["bold"] = bool(r.font.bold)
            col = _hex(r.font.color)
            if col:
                item["color"] = col
        paras.append(item)
    tables = []
    for ti, t in enumerate(doc.tables):
        rows = []
        for ri, row in enumerate(t.rows):
            rows.append([{"id": f"t{ti}.r{ri}.c{ci}", "text": c.text.strip()[:120]}
                         for ci, c in enumerate(row.cells)])
        tables.append({"table": ti, "rows": rows})
    return {"format": "docx", "paragraphs": paras, "tables": tables}


def apply_docx(path: Path, ops: list[dict], out: Path) -> list[str]:
    from docx import Document
    from docx.shared import Pt, RGBColor

    doc = Document(str(path))
    report: list[str] = []
    paras = doc.paragraphs

    def target(pid: str):
        if pid.startswith("t"):
            t_s, r_s, c_s = pid.split(".")
            t = doc.tables[int(t_s.lstrip("t"))]
            return t.rows[int(r_s.lstrip("r"))].cells[int(c_s.lstrip("c"))]
        return paras[int(pid.lstrip("p"))]

    for o in ops:
        op = o.get("op")
        pid = o.get("id", "")
        try:
            if op == "set_text":
                el = target(pid)
                _set_text_keep_style(el if hasattr(el, "paragraphs") else _Wrap(el),
                                     str(o.get("text", "")))
                report.append(f"ok set_text {pid}")
            elif op == "set_style":
                el = target(pid)
                runs = ([r for p in el.paragraphs for r in p.runs]
                        if hasattr(el, "paragraphs") else el.runs)
                for r in runs:
                    if o.get("size") is not None:
                        r.font.size = Pt(float(o["size"]))
                    if o.get("bold") is not None:
                        r.font.bold = bool(o["bold"])
                    if o.get("italic") is not None:
                        r.font.italic = bool(o["italic"])
                    if o.get("color"):
                        r.font.color.rgb = RGBColor.from_string(
                            str(o["color"]).lstrip("#").upper())
                report.append(f"ok set_style {pid}")
            elif op == "delete":
                el = target(pid)
                el._p.getparent().remove(el._p)
                report.append(f"ok delete {pid}")
            elif op == "insert_chart":
                import office_chart
                r = office_chart.insert_docx(doc, o.get("after"), Path(o["file"]).expanduser(),
                                             float(o["width"]) if o.get("width") is not None else None)
                report.append(f"ok insert_chart after {r['after']} ({r['width_in']}x{r['height_in']} in, {r['made']})")
                paras = doc.paragraphs
            elif op == "insert_paragraph":
                anchor = paras[int(str(o["after"]).lstrip("p"))]
                new = anchor.insert_paragraph_before(str(o.get("text", "")))
                # insert_paragraph_before puts it ABOVE the anchor; move it down
                # one so "after" means after.
                anchor._p.addnext(new._p)
                report.append(f"ok insert_paragraph after {o['after']}")
            else:
                report.append(f"UNKNOWN op {op!r}")
        except Exception as err:  # noqa: BLE001
            report.append(f"FAIL {op} {pid}: {err}")

    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    return report


class _Wrap:
    """A paragraph made to look like a cell, so _set_text_keep_style takes one
    code path for both."""

    def __init__(self, p):
        self.paragraphs = [p]


# ── xlsx ──────────────────────────────────────────────────────────────────────
def inspect_xlsx(path: Path, max_rows: int = 60) -> dict:
    from openpyxl import load_workbook

    wb = load_workbook(str(path))
    sheets = []
    for ws in wb.worksheets:
        cells = []
        for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, max_rows)):
            for c in row:
                if c.value is None:
                    continue
                cells.append({"id": c.coordinate, "value": str(c.value)[:120],
                              "format": c.number_format})
        sheets.append({"sheet": ws.title, "dims": f"{ws.max_row}x{ws.max_column}",
                       "cells": cells, "charts": len(getattr(ws, "_charts", []))})
    return {"format": "xlsx", "sheets": sheets}


def apply_xlsx(path: Path, ops: list[dict], out: Path) -> list[str]:
    from openpyxl import load_workbook
    from openpyxl.styles import Font, PatternFill

    wb = load_workbook(str(path))
    report: list[str] = []

    def ws_for(o):
        name = o.get("sheet")
        return wb[name] if name in wb.sheetnames else wb.active

    for o in ops:
        op = o.get("op")
        cid = o.get("id", "")
        try:
            ws = ws_for(o)
            if op == "insert_chart":
                import office_chart
                r = office_chart.insert_xlsx(wb, o.get("sheet"), o.get("anchor") or (cid or None),
                                             Path(o["file"]).expanduser(), bool(o.get("native")),
                                             float(o["width"]) if o.get("width") is not None else None)
                report.append(f"ok insert_chart {r['chart']} on {r['sheet']} at {r['anchor']}"
                              + (f" (data on '{r['data_sheet']}')" if r.get("data_sheet") else ""))
                continue
            if op == "set_cell":
                v = o.get("value")
                # A string starting with '=' is a FORMULA. Coercing it to text
                # here is how a workbook silently stops recalculating.
                ws[cid] = v
                report.append(f"ok set_cell {cid}")
            elif op == "set_number_format":
                for row in ws[cid] if ":" in cid else [[ws[cid]]]:
                    for c in row:
                        c.number_format = str(o.get("format", "General"))
                report.append(f"ok set_number_format {cid}")
            elif op == "set_style":
                for row in ws[cid] if ":" in cid else [[ws[cid]]]:
                    for c in row:
                        f = c.font
                        c.font = Font(name=f.name, size=float(o["size"]) if o.get("size") else f.sz,
                                      bold=o.get("bold", f.bold), italic=o.get("italic", f.italic),
                                      color=str(o["color"]).lstrip("#").upper()
                                      if o.get("color") else f.color)
                        if o.get("fill"):
                            c.fill = PatternFill("solid",
                                                 fgColor=str(o["fill"]).lstrip("#").upper())
                report.append(f"ok set_style {cid}")
            elif op == "set_column_width":
                ws.column_dimensions[str(o["column"])].width = float(o["width"])
                report.append(f"ok set_column_width {o['column']}")
            elif op == "delete_row":
                ws.delete_rows(int(o["row"]))
                report.append(f"ok delete_row {o['row']}")
            else:
                report.append(f"UNKNOWN op {op!r}")
        except Exception as err:  # noqa: BLE001
            report.append(f"FAIL {op} {cid}: {err}")

    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out))
    if any(o.get("op") == "insert_chart" for o in ops):
        import office_chart
        office_chart.fix_xlsx_drawings(out)
    return report


def _box(o: dict) -> tuple[float, float, float, float] | None:
    """An op's box — x, y, w, h in inches — as four numbers, or None for the default."""
    if o.get("box") is not None:
        b = o["box"]
        if isinstance(b, str):
            b = [float(v) for v in re.findall(r"-?[\d.]+", b)]
        if len(b) == 4:
            return tuple(float(v) for v in b)  # type: ignore[return-value]
        raise ValueError("box needs four numbers: x, y, w, h in inches")
    if all(o.get(k) is not None for k in ("x", "y", "w", "h")):
        return float(o["x"]), float(o["y"]), float(o["w"]), float(o["h"])
    return None


def apply_pdf(path: Path, ops: list[dict], out: Path) -> list[str]:
    """A PDF has no document model; what CAN be done to one is drawing a chart
    onto a page (in its free space) or giving the chart a page of its own."""
    import shutil

    report: list[str] = []
    src = path
    tmp_prev: Path | None = None
    for o in ops:
        op = o.get("op")
        try:
            if op == "insert_chart":
                import office_chart
                r = office_chart.insert_pdf(src, out, int(o.get("page", 1)), Path(o["file"]).expanduser(),
                                            _box(o), str(o.get("place") or "auto"))
                report.append(f"ok insert_chart page {r['page']} ({r['placed']}, box {r['box_in']} in; {r['pages']} pages now)")
                # The next op reads what this one wrote.
                src = out
                tmp_prev = out
            else:
                report.append(f"UNKNOWN op {op!r} (a PDF takes insert_chart only)")
        except Exception as err:  # noqa: BLE001
            report.append(f"FAIL {op}: {err}")
    if tmp_prev is None:
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, out)
    return report


INSPECT = {"pptx": inspect_pptx, "docx": inspect_docx, "xlsx": inspect_xlsx}
APPLY = {"pptx": apply_pptx, "docx": apply_docx, "xlsx": apply_xlsx, "pdf": apply_pdf}


def kind_of(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".")
    if ext not in APPLY:
        raise SystemExit(f"no edit model for .{ext}")
    return ext


if __name__ == "__main__":
    mode, src = sys.argv[1], Path(sys.argv[2])
    k = kind_of(src)
    if mode == "inspect":
        print(json.dumps(INSPECT[k](src), indent=1))
    elif mode == "apply":
        ops = json.loads(Path(sys.argv[3]).read_text())
        dst = Path(sys.argv[4])
        for line in APPLY[k](src, ops if isinstance(ops, list) else ops.get("ops", []), dst):
            print(" ", line)
        print(f"wrote {dst}")
