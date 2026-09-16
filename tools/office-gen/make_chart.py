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
    return obj if isinstance(obj, dict) and ("series" in obj or "items" in obj or "points" in obj) else None


def spec_from_brief(brief: str) -> dict:
    direct = _as_spec(brief)
    if direct is not None:
        return direct
    raw = ask(SYSTEM, f"Request:\n{brief}", schema_hint=SCHEMA, max_tokens=1200)
    return parse_json(raw, "chart")


def revise(spec: dict, instruction: str) -> dict:
    raw = ask(
        SYSTEM + " You are given the current chart and an instruction; return the whole "
        "chart with the instruction applied and nothing else changed.",
        f"Current chart:\n{json.dumps(spec)}\n\nInstruction: {instruction}",
        schema_hint=SCHEMA,
        max_tokens=1200,
    )
    return parse_json(raw, "chart-edit")
