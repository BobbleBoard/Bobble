"""
A chart of DATA as an SVG — bars, horizontal bars, lines, a donut.

the user (2026-09-15): "we should for example be able to get really good data
visuals, tables, svgs drawings, and get the same quality standalone as when we
ask for presentations or documents". MEASURED what a 4B did without this: asked
for a bar chart of four numbers it ran image generation with the numbers in the
prompt — a diffusion model paints a chart-shaped picture and cannot put a value
on an axis — and then said it could not look at the result.

So a chart is drawn from its numbers, deterministically, in the same design
language as the deck's viz.py: two-colour palette, hairline grid, the value
written on every bar, one highlighted item where the brief names one. SVG so
the canvas shows it crisp at any size, a page can reference it, and the office
pipeline can drop it into a deck or a document as-is.

Spec (make_chart.py writes it from a brief; a brief that is already this JSON
is used directly):

  {"type": "bar" | "hbar" | "line" | "donut",
   "title": "…", "subtitle": "…", "x_label": "…", "y_label": "…",
   "series": [{"name": "…", "points": [{"label": "2021", "value": 12}, …]}],
   "highlight": "2024", "note": "Source: …",
   "palette": {"primary": "#14203C", "accent": "#D98E32"}}
"""
from __future__ import annotations

import math
from pathlib import Path
from xml.sax.saxutils import escape

import numparse
import palette as pal

W, H = 960, 600
M_LEFT, M_RIGHT, M_TOP, M_BOTTOM = 72, 40, 40, 64
FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif"
TYPES = ("bar", "hbar", "line", "donut")


def _num(v) -> float:
    """"22M", "$38k", "1.2B" and "3,100" as the numbers they are (numparse);
    the old parser knew commas, % and $ but read "22M" as 0 (D3)."""
    return numparse.num(v, 0.0)


def _fmt(v: float) -> str:
    if abs(v - round(v)) < 1e-9:
        return f"{int(round(v)):,}"
    return f"{v:,.1f}" if abs(v) >= 10 else f"{v:,.2f}".rstrip("0").rstrip(".")


def _nice_step(span: float, ticks: int = 5) -> float:
    if span <= 0:
        return 1.0
    raw = span / ticks
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return m * mag
    return 10 * mag


def normalise(spec: dict, warnings: list | None = None) -> dict:
    """Coerce whatever the model returned into the shape the renderer draws.
    `warnings` (if given) hears about anything left out or unreadable."""
    def warn(msg: str) -> None:
        if warnings is not None and msg not in warnings:
            warnings.append(msg)

    kind = str(spec.get("type") or "bar").lower().strip()
    kind = {"column": "bar", "columns": "bar", "bars": "bar", "horizontal": "hbar",
            "pie": "donut", "lines": "line", "area": "line"}.get(kind, kind)
    if kind not in TYPES:
        kind = "bar"
    series_in = spec.get("series")
    if not isinstance(series_in, list) or not series_in:
        # Accept the deck's flat form: {"items": [{"label","value"}]} …
        items = spec.get("items") or spec.get("points") or spec.get("data") or []
        # … and the two-array form a model writes unprompted (MEASURED, a 4B:
        # {"labels": [...], "numbers_data": [12, 19, 27, 35]}): parallel lists
        # of labels and values under whatever the values were called.
        if not items and isinstance(spec.get("labels"), list):
            values = next(
                (spec[k] for k in ("values", "numbers", "numbers_data", "data_values", "y", "counts", "amounts")
                 if isinstance(spec.get(k), list)),
                None,
            )
            if values is None:
                values = next((v for k, v in spec.items() if k != "labels" and isinstance(v, list)
                               and v and all(isinstance(x, (int, float, str)) for x in v)), None)
            if values is not None:
                items = [{"label": str(l), "value": v} for l, v in zip(spec["labels"], values)]
        series_in = [{"name": spec.get("y_label") or "", "points": items}]
    series = []
    if len(series_in) > 4:
        warn(f"4 of {len(series_in)} series drawn — a chart holds 4")
    for s in series_in[:4]:
        if not isinstance(s, dict):
            continue
        pts = []
        raw_pts = s.get("points") or s.get("items") or s.get("data") or []
        if len(raw_pts) > 24:
            warn(f"24 of {len(raw_pts)} points drawn in '{s.get('name') or 'the series'}' — a chart holds 24")
        for p in raw_pts[:24]:
            if isinstance(p, dict):
                raw = p.get("value") if "value" in p else p.get("y")
                label = str(p.get("label") or p.get("x") or p.get("name") or "")
            elif isinstance(p, (list, tuple)) and len(p) >= 2:
                raw, label = p[1], str(p[0])
            else:
                continue
            if numparse.parse(raw) is None:
                warn(f"'{raw}' ({label}) is not a number; drawn as 0")
            pts.append({"label": label, "value": _num(raw)})
        if pts:
            series.append({"name": str(s.get("name") or ""), "points": pts})
    if not series:
        raise ValueError("the chart has no data points — the brief must carry the numbers")
    return {
        "type": kind,
        "title": str(spec.get("title") or "").strip(),
        "subtitle": str(spec.get("subtitle") or "").strip(),
        "x_label": str(spec.get("x_label") or "").strip(),
        "y_label": str(spec.get("y_label") or "").strip(),
        "series": series,
        "highlight": str(spec.get("highlight") or "").strip(),
        "note": str(spec.get("note") or "").strip(),
        "palette": spec.get("palette") if isinstance(spec.get("palette"), dict) else {},
    }


def _text(x, y, s, size, colour, *, weight=400, anchor="start", opacity=1.0, extra=""):
    if not s:
        return ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{size}" '
            f'font-weight="{weight}" fill="{colour}" text-anchor="{anchor}" '
            f'opacity="{opacity}" {extra}>{escape(str(s))}</text>')


def _head(spec: dict, t: pal.Palette) -> tuple[list[str], float]:
    out = []
    y = M_TOP
    if spec["title"]:
        y += 26
        out.append(_text(M_LEFT, y, spec["title"], 26, t.ink, weight=600))
    if spec["subtitle"]:
        y += 22
        out.append(_text(M_LEFT, y, spec["subtitle"], 15, t.mute))
    return out, y + (18 if (spec["title"] or spec["subtitle"]) else 0)


def _legend(series, colours, x, y, t) -> list[str]:
    if len(series) < 2:
        return []
    out = []
    cx = x
    for s, c in zip(series, colours):
        out.append(f'<rect x="{cx}" y="{y - 9}" width="12" height="12" rx="2" fill="{c}"/>')
        out.append(_text(cx + 18, y + 1, s["name"] or "series", 13, t.mute))
        cx += 18 + 8 * max(4, len(s["name"] or "series")) + 22
    return out


def _series_colours(t: pal.Palette, n: int) -> list[str]:
    base = [t.primary, t.accent, t.support, t.deep]
    return base[:max(1, n)]


def _bars(spec, t, top) -> list[str]:
    series, out = spec["series"], []
    colours = _series_colours(t, len(series))
    labels = [p["label"] for p in series[0]["points"]]
    n = len(labels)
    vmax = max(max(p["value"] for p in s["points"]) for s in series)
    vmin = min(0.0, min(min(p["value"] for p in s["points"]) for s in series))
    step = _nice_step(vmax - vmin)
    top_v = math.ceil(vmax / step) * step if vmax > 0 else step
    bot_v = math.floor(vmin / step) * step if vmin < 0 else 0.0
    legend_h = 26 if len(series) > 1 else 0
    y0, y1 = top + legend_h + 10, H - M_BOTTOM - (18 if spec["x_label"] else 0)
    x0, x1 = M_LEFT + (22 if spec["y_label"] else 0), W - M_RIGHT
    out += _legend(series, colours, x0, top + 12, t)
    scale = (y1 - y0) / (top_v - bot_v)
    ybase = y1 - (0 - bot_v) * scale
    # grid + y ticks
    v = bot_v
    while v <= top_v + 1e-9:
        y = y1 - (v - bot_v) * scale
        out.append(f'<line x1="{x0}" y1="{y:.1f}" x2="{x1}" y2="{y:.1f}" stroke="{t.ink}" stroke-opacity="{0.28 if abs(v) < 1e-9 else 0.09}" stroke-width="1"/>')
        out.append(_text(x0 - 10, y + 4, _fmt(v), 12, t.mute, anchor="end"))
        v += step
    group_w = (x1 - x0) / max(n, 1)
    gap = group_w * 0.28
    bar_w = (group_w - gap) / len(series)
    for i, label in enumerate(labels):
        gx = x0 + i * group_w + gap / 2
        for j, (s, c) in enumerate(zip(series, colours)):
            if i >= len(s["points"]):
                continue
            val = s["points"][i]["value"]
            h = abs(val) * scale
            y = ybase - h if val >= 0 else ybase
            x = gx + j * bar_w
            hi = spec["highlight"] and label == spec["highlight"]
            fill = t.accent if (hi and len(series) == 1) else c
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{max(bar_w - 3, 2):.1f}" height="{max(h, 1):.1f}" rx="3" fill="{fill}"/>')
            out.append(_text(x + (bar_w - 3) / 2, (y - 7) if val >= 0 else (y + h + 15), _fmt(val), 12.5, t.ink, weight=600, anchor="middle"))
        out.append(_text(gx + (group_w - gap) / 2, y1 + 20, label, 13, t.mute, anchor="middle"))
    if spec["x_label"]:
        out.append(_text((x0 + x1) / 2, H - 22, spec["x_label"], 13, t.mute, anchor="middle"))
    if spec["y_label"]:
        cy = (y0 + y1) / 2
        out.append(_text(M_LEFT - 52, cy, spec["y_label"], 13, t.mute, anchor="middle", extra=f'transform="rotate(-90 {M_LEFT - 52} {cy:.1f})"'))
    return out


def _hbars(spec, t, top) -> list[str]:
    s = spec["series"][0]
    pts, out = s["points"], []
    vmax = max(p["value"] for p in pts) or 1.0
    label_w = min(260, 14 + 8 * max(len(p["label"]) for p in pts))
    x0, x1 = M_LEFT - 20 + label_w, W - M_RIGHT - 70
    y0, y1 = top + 8, H - M_BOTTOM
    row = (y1 - y0) / len(pts)
    bar_h = min(44, row * 0.62)
    for i, p in enumerate(pts):
        y = y0 + i * row + (row - bar_h) / 2
        w = max(2.0, (x1 - x0) * p["value"] / vmax)
        hi = spec["highlight"] and p["label"] == spec["highlight"]
        out.append(_text(x0 - 12, y + bar_h / 2 + 5, p["label"], 13.5, t.ink, anchor="end", weight=600 if hi else 400))
        out.append(f'<rect x="{x0}" y="{y:.1f}" width="{w:.1f}" height="{bar_h:.1f}" rx="3" fill="{t.accent if hi else t.primary}"/>')
        out.append(_text(x0 + w + 10, y + bar_h / 2 + 5, _fmt(p["value"]), 13, t.ink, weight=600))
    if spec["x_label"]:
        out.append(_text((x0 + x1) / 2, H - 22, spec["x_label"], 13, t.mute, anchor="middle"))
    return out


def _line(spec, t, top) -> list[str]:
    series, out = spec["series"], []
    colours = _series_colours(t, len(series))
    labels = [p["label"] for p in series[0]["points"]]
    n = len(labels)
    vals = [p["value"] for s in series for p in s["points"]]
    vmax, vmin = max(vals), min(min(vals), 0.0)
    step = _nice_step(vmax - vmin)
    top_v = math.ceil(vmax / step) * step if vmax > 0 else step
    bot_v = math.floor(vmin / step) * step if vmin < 0 else 0.0
    legend_h = 26 if len(series) > 1 else 0
    y0, y1 = top + legend_h + 14, H - M_BOTTOM - (18 if spec["x_label"] else 0)
    x0, x1 = M_LEFT + (22 if spec["y_label"] else 0) + 10, W - M_RIGHT - 10
    out += _legend(series, colours, x0, top + 12, t)
    scale = (y1 - y0) / (top_v - bot_v)
    v = bot_v
    while v <= top_v + 1e-9:
        y = y1 - (v - bot_v) * scale
        out.append(f'<line x1="{x0}" y1="{y:.1f}" x2="{x1}" y2="{y:.1f}" stroke="{t.ink}" stroke-opacity="{0.28 if abs(v) < 1e-9 else 0.09}" stroke-width="1"/>')
        out.append(_text(x0 - 12, y + 4, _fmt(v), 12, t.mute, anchor="end"))
        v += step
    xs = [x0 + (x1 - x0) * (i / max(n - 1, 1)) for i in range(n)]
    for i, label in enumerate(labels):
        out.append(_text(xs[i], y1 + 20, label, 13, t.mute, anchor="middle"))
    for s, c in zip(series, colours):
        pts = [(xs[i], y1 - (p["value"] - bot_v) * scale) for i, p in enumerate(s["points"]) if i < n]
        if len(pts) > 1:
            d = " ".join(f"{'M' if i == 0 else 'L'}{x:.1f} {y:.1f}" for i, (x, y) in enumerate(pts))
            out.append(f'<path d="{d}" fill="none" stroke="{c}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>')
        for (x, y), p in zip(pts, s["points"]):
            hi = spec["highlight"] and p["label"] == spec["highlight"]
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{6 if hi else 4.5}" fill="{t.paper}" stroke="{t.accent if hi else c}" stroke-width="3"/>')
            if len(series) == 1 or hi:
                out.append(_text(x, y - 12, _fmt(p["value"]), 12.5, t.ink, weight=600, anchor="middle"))
    if spec["x_label"]:
        out.append(_text((x0 + x1) / 2, H - 22, spec["x_label"], 13, t.mute, anchor="middle"))
    if spec["y_label"]:
        cy = (y0 + y1) / 2
        out.append(_text(M_LEFT - 52, cy, spec["y_label"], 13, t.mute, anchor="middle", extra=f'transform="rotate(-90 {M_LEFT - 52} {cy:.1f})"'))
    return out


def _donut(spec, t, top) -> list[str]:
    s = spec["series"][0]
    pts = [p for p in s["points"] if p["value"] > 0]
    out = []
    total = sum(p["value"] for p in pts) or 1.0
    cx, cy = W * 0.36, top + (H - M_BOTTOM - top) / 2
    r = min(180, (H - M_BOTTOM - top) / 2 - 10)
    ring = r * 0.34
    # The accent is the HIGHLIGHT's colour when the brief names one; the
    # other slices then stay in the primary family so the highlight is the
    # one warm thing on the chart (a second accent slice looked like two).
    shades = ([t.primary, t.support, t.deep, pal._shift(t.primary, light=0.22), pal._shift(t.primary, light=0.32, sat=-0.2), t.mute]
              if spec["highlight"] else
              [t.primary, t.accent, t.support, t.deep, pal._shift(t.primary, light=0.22), pal._shift(t.accent, light=0.18)])
    a0 = -math.pi / 2
    for i, p in enumerate(pts):
        frac = p["value"] / total
        a1 = a0 + frac * 2 * math.pi
        large = 1 if frac > 0.5 else 0
        x0, y0 = cx + r * math.cos(a0), cy + r * math.sin(a0)
        x1, y1 = cx + r * math.cos(a1), cy + r * math.sin(a1)
        ri = r - ring
        xi0, yi0 = cx + ri * math.cos(a1), cy + ri * math.sin(a1)
        xi1, yi1 = cx + ri * math.cos(a0), cy + ri * math.sin(a0)
        hi = spec["highlight"] and p["label"] == spec["highlight"]
        colour = t.accent if hi else shades[i % len(shades)]
        if frac >= 0.999:
            out.append(f'<circle cx="{cx}" cy="{cy}" r="{r - ring / 2}" fill="none" stroke="{colour}" stroke-width="{ring}"/>')
        else:
            d = (f"M{x0:.1f} {y0:.1f} A{r} {r} 0 {large} 1 {x1:.1f} {y1:.1f} "
                 f"L{xi0:.1f} {yi0:.1f} A{ri} {ri} 0 {large} 0 {xi1:.1f} {yi1:.1f} Z")
            out.append(f'<path d="{d}" fill="{colour}" stroke="{t.paper}" stroke-width="2"/>')
        # legend row
        ly = top + 30 + i * 34
        lx = W * 0.62
        out.append(f'<rect x="{lx}" y="{ly - 11}" width="14" height="14" rx="3" fill="{colour}"/>')
        out.append(_text(lx + 24, ly + 1, p["label"], 14, t.ink, weight=600 if hi else 400))
        out.append(_text(W - M_RIGHT, ly + 1, f"{_fmt(p['value'])}  ·  {frac * 100:.0f}%", 13, t.mute, anchor="end"))
        a0 = a1
    out.append(_text(cx, cy + 8, _fmt(total), 24, t.ink, weight=600, anchor="middle"))
    out.append(_text(cx, cy + 28, "total", 12, t.mute, anchor="middle"))
    return out


def render(spec: dict, out: Path) -> dict:
    warnings: list[str] = []
    spec = normalise(spec, warnings)
    t = pal.from_spec({"palette": spec["palette"]})
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="{escape(spec["title"] or "chart")}">',
        f'<rect width="{W}" height="{H}" rx="14" fill="{t.paper}"/>',
    ]
    head, top = _head(spec, t)
    parts += head
    draw = {"bar": _bars, "hbar": _hbars, "line": _line, "donut": _donut}[spec["type"]]
    parts += draw(spec, t, top)
    if spec["note"]:
        parts.append(_text(M_LEFT, H - 14, spec["note"], 11.5, t.mute))
    parts.append("</svg>")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(parts) + "\n")
    points = sum(len(s["points"]) for s in spec["series"])
    return {"type": spec["type"], "title": spec["title"], "series": len(spec["series"]),
            "points": points, "bytes": out.stat().st_size, "warnings": warnings}
