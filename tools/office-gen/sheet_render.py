#!/usr/bin/env python3
"""
Spec (JSON) -> .xlsx that looks like a dashboard, not a data dump.

A generated spreadsheet is usually raw values in A1 with default column widths,
which is legible to a machine and hostile to a person. Everything that makes a
workbook look considered — column widths, a title band, KPI cells, banded rows,
number formats, frozen panes, a native chart — is mechanical and none of it is
something a model should be spending tokens on.

Formulas are preserved as formulas. Writing a computed VALUE where a SUM belongs
produces a workbook that looks right and dies the moment anyone edits a cell.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.formatting.rule import CellIsRule, DataBarRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

sys.path.insert(0, str(Path(__file__).parent))
import palette as pal  # noqa: E402

FONT = "Helvetica Neue"


def _hx(h: str) -> str:
    return h.lstrip("#").upper()


def _fill(h: str) -> PatternFill:
    return PatternFill("solid", fgColor=_hx(h))


def _font(t, *, size=11, bold=False, colour=None, italic=False) -> Font:
    return Font(name=FONT, size=size, bold=bold, italic=italic,
                color=_hx(colour or t.ink))


def _band(ws, row, col0, col1, t, colour, height=None):
    for c in range(col0, col1 + 1):
        ws.cell(row=row, column=c).fill = _fill(colour)
    if height:
        ws.row_dimensions[row].height = height


def build(spec: dict, out: Path) -> Path:
    t = pal.from_spec(spec)
    wb = Workbook()
    ws = wb.active
    ws.title = (spec.get("sheet_name") or "Dashboard")[:31]
    ws.sheet_view.showGridLines = False       # gridlines are the "spreadsheet" tell

    headers = [str(h) for h in (spec.get("headers") or [])]
    rows = spec.get("rows") or []
    ncols = max(len(headers), 4)
    last_col = ncols

    # ── title band ───────────────────────────────────────────────────────────
    _band(ws, 1, 1, last_col, t, t.deep, height=34)
    ws.cell(row=1, column=1, value=spec.get("title", "")).font = _font(
        t, size=16, bold=True, colour=t.on(t.deep))
    ws.cell(row=1, column=1).alignment = Alignment(vertical="center", indent=1)
    if spec.get("subtitle"):
        _band(ws, 2, 1, last_col, t, t.deep, height=20)
        c = ws.cell(row=2, column=1, value=spec["subtitle"])
        c.font = _font(t, size=10, colour=t.support)
        c.alignment = Alignment(vertical="center", indent=1)
    row = 4

    # ── KPI row: merged cells, oversized numerals ────────────────────────────
    kpis = (spec.get("kpis") or [])[:4]
    if kpis:
        span = max(1, ncols // len(kpis))
        for i, k in enumerate(kpis):
            c0 = 1 + i * span
            c1 = min(last_col, c0 + span - 1)
            ws.merge_cells(start_row=row, start_column=c0, end_row=row, end_column=c1)
            cell = ws.cell(row=row, column=c0, value=k.get("value"))
            cell.font = _font(t, size=22, bold=True, colour=t.primary)
            # A KPI written as a bare number renders as 1285000, which is the
            # exact "data dump" look this renderer exists to avoid. The model
            # may name a format per KPI; otherwise a numeric value gets grouped.
            if isinstance(k.get("value"), (int, float)):
                cell.number_format = k.get("format") or spec.get("kpi_format") or "#,##0" 
            cell.alignment = Alignment(vertical="center", indent=1)
            ws.merge_cells(start_row=row + 1, start_column=c0, end_row=row + 1, end_column=c1)
            lab = ws.cell(row=row + 1, column=c0, value=k.get("label", ""))
            lab.font = _font(t, size=9, colour=t.mute)
            lab.alignment = Alignment(vertical="top", indent=1)
        ws.row_dimensions[row].height = 30
        ws.row_dimensions[row + 1].height = 16
        row += 3

    # ── data table ───────────────────────────────────────────────────────────
    head_row = row
    thin = Side(style="thin", color=_hx(t.faint))
    for c, h in enumerate(headers, start=1):
        cell = ws.cell(row=head_row, column=c, value=h)
        cell.fill = _fill(t.primary)
        cell.font = _font(t, size=10, bold=True, colour=t.on(t.primary))
        cell.alignment = Alignment(vertical="center", indent=1)
    ws.row_dimensions[head_row].height = 22

    numeric_cols: set[int] = set()
    for r, data in enumerate(rows, start=head_row + 1):
        for c in range(1, len(headers) + 1):
            v = data[c - 1] if isinstance(data, list) and c <= len(data) else None
            # A string starting with '=' is a FORMULA and must stay one.
            cell = ws.cell(row=r, column=c, value=v)
            cell.font = _font(t, size=10, bold=(c == 1))
            cell.border = Border(bottom=thin)
            cell.alignment = Alignment(vertical="center", indent=1 if c == 1 else 0,
                                       horizontal="left" if c == 1 else "right")
            if isinstance(v, (int, float)):
                numeric_cols.add(c)
                cell.number_format = spec.get("number_format", "#,##0")
            if (r - head_row) % 2 == 0:
                cell.fill = _fill(t.faint)
    last_row = head_row + len(rows)

    # ── a data bar on the main numeric column: proportion at a glance ────────
    if numeric_cols and last_row > head_row:
        col = get_column_letter(min(numeric_cols))
        ws.conditional_formatting.add(
            f"{col}{head_row+1}:{col}{last_row}",
            DataBarRule(start_type="min", end_type="max", color=_hx(t.accent),
                        showValue=True))

    # ── totals row, as a real formula ───────────────────────────────────────
    if spec.get("total_row") and numeric_cols and last_row > head_row:
        tr = last_row + 1
        ws.cell(row=tr, column=1, value=spec.get("total_label", "Total")).font = _font(
            t, size=10, bold=True, colour=t.on(t.deep))
        for c in range(1, len(headers) + 1):
            cell = ws.cell(row=tr, column=c)
            cell.fill = _fill(t.deep)
            cell.font = _font(t, size=10, bold=True, colour=t.on(t.deep))
            if c in numeric_cols:
                col = get_column_letter(c)
                cell.value = f"=SUM({col}{head_row+1}:{col}{last_row})"
                cell.number_format = spec.get("number_format", "#,##0")
                cell.alignment = Alignment(horizontal="right")
        ws.row_dimensions[tr].height = 20
        last_row = tr

    # ── native chart, bound to the cells ────────────────────────────────────
    chart_kind = (spec.get("chart") or {}).get("type")
    if chart_kind and numeric_cols and len(rows) >= 2:
        ch = {"bar": BarChart, "line": LineChart, "pie": PieChart}.get(chart_kind, BarChart)()
        vcol = min(numeric_cols)
        data = Reference(ws, min_col=vcol, min_row=head_row,
                         max_row=head_row + len(rows))
        cats = Reference(ws, min_col=1, min_row=head_row + 1,
                         max_row=head_row + len(rows))
        ch.add_data(data, titles_from_data=True)
        ch.set_categories(cats)
        ch.title = (spec.get("chart") or {}).get("title") or None
        ch.height, ch.width = 7.5, 15
        if hasattr(ch, "gapWidth"):
            ch.gapWidth = 60
        ws.add_chart(ch, f"A{last_row + 3}")

    # ── the mechanical polish nobody should spend tokens on ─────────────────
    ws.freeze_panes = ws.cell(row=head_row + 1, column=1)
    for c in range(1, len(headers) + 1):
        longest = len(str(headers[c - 1]))
        for data in rows:
            if isinstance(data, list) and c <= len(data):
                longest = max(longest, len(str(data[c - 1])))
        ws.column_dimensions[get_column_letter(c)].width = min(46, max(12, longest + 6))
    if headers:
        ws.auto_filter.ref = f"A{head_row}:{get_column_letter(len(headers))}{head_row + len(rows)}"

    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(out))
    return out


if __name__ == "__main__":
    spec = json.loads(Path(sys.argv[1]).read_text())
    p = build(spec, Path(sys.argv[2]))
    print(f"wrote {p}")
