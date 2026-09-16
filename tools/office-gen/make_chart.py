"""
Brief → chart spec, through the local model; or a brief that IS the spec.

The division of labour is the pipeline's everywhere else: the chat model writes
the brief with the numbers in it, the local model turns it into a spec, and
chart_render.py draws the spec. The one rule that matters is the deck's rule:
every number in the chart must appear in the brief — a chart is a claim.
"""
from __future__ import annotations

import json
import re

from make_deck import ask, parse_json

SCHEMA = (
    '\n\nReturn ONLY this JSON: {"type": "bar|hbar|line|donut", "title": "…", '
    '"subtitle": "…", "x_label": "…", "y_label": "…", "series": [{"name": "…", '
    '"points": [{"label": "…", "value": number}]}], "highlight": "label or empty", '
    '"note": "source line or empty"}'
)

SYSTEM = (
    "You turn a request into a chart specification. Copy every number and label "
    "from the request exactly; never invent, round or extend the data. Choose the "
    "type: bar for values by category or period (up to ~12), hbar to rank names "
    "(long labels), line for a trend over many points or several series over time, "
    "donut for shares of a whole. Several series only when the request compares "
    "them (revenue vs cost). Title: short, plain. Subtitle: the unit or the "
    "population. highlight: one label the request singles out, else empty."
)


def _as_spec(brief: str) -> dict | None:
    """A brief that is already the JSON spec (a model that likes structure)."""
    text = brief.strip()
    if not text.startswith("{"):
        return None
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            return None
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    if not isinstance(obj, dict):
        return None
    keys = ("series", "items", "points", "data", "labels")
    return obj if any(k in obj for k in keys) else None


TYPE_WORDS = (
    ("donut", r"\b(pie|donut|doughnut)\b"),
    ("hbar", r"\b(horizontal bars?|hbar|ranked|ranking)\b"),
    ("line", r"\b(line chart|line graph|trend line|over time as a line)\b"),
    ("bar", r"\b(bar chart|bar graph|column chart|columns?|bars)\b"),
)


def settle_type(spec: dict, brief: str) -> dict:
    """The type the brief NAMES wins; a short single series is bars.

    MEASURED on a 4B asked for "a bar chart" of four years: its brief carried
    the title and the numbers but not the word, and the local model drew a
    line. A line through four points is not a trend chart; the request's own
    word, when it has one, is the answer, and without one a handful of
    categories is bars.
    """
    low = brief.lower()
    for kind, pat in TYPE_WORDS:
        if re.search(pat, low):
            spec["type"] = kind
            return spec
    series = spec.get("series") if isinstance(spec.get("series"), list) else []
    points = len((series[0] or {}).get("points") or []) if series and isinstance(series[0], dict) else 0
    if str(spec.get("type", "")).lower() == "line" and len(series) == 1 and points <= 6:
        spec["type"] = "bar"
    return spec


def spec_from_brief(brief: str) -> dict:
    direct = _as_spec(brief)
    if direct is not None:
        return settle_type(direct, brief)
    raw = ask(SYSTEM, f"Request:\n{brief}", schema_hint=SCHEMA, max_tokens=1200)
    return settle_type(parse_json(raw, "chart"), brief)


def revise(spec: dict, instruction: str) -> dict:
    raw = ask(
        SYSTEM + " You are given the current chart and an instruction; return the whole "
        "chart with the instruction applied and nothing else changed.",
        f"Current chart:\n{json.dumps(spec)}\n\nInstruction: {instruction}",
        schema_hint=SCHEMA,
        max_tokens=1200,
    )
    return parse_json(raw, "chart-edit")
