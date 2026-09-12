#!/usr/bin/env python3
"""
Research report -> deck spec, using a 4B local model.

PLAN THEN FILL. One prompt asking a 4B model for a whole fifteen-slide JSON
document fails in the ways small models always fail: it loses the schema
halfway, repeats a slide, or truncates. So this asks for an OUTLINE first (one
line per slide), then fills ONE slide per request, each with only that layout's
schema in front of it. Every generation is short, and a malformed one costs a
single slide rather than the deck.

Each request is also independent, which means a failure is recoverable and
retryable in place — the pattern that made the office format tests reliable
earlier today.

JSON is enforced by llama.cpp's grammar, not by asking politely. A 4B model
asked for "only JSON" will still occasionally open with "Here is the JSON:".
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from scratch import post_json, scratch_dir

HERE = Path(__file__).parent
# The server is NOT a fixed port. The app's supervisor picks a free one per
# launch, so a hardcoded 8099 is connection-refused inside a real run — which is
# exactly how a specialist concludes the renderers are broken and goes back to
# hand-writing the file format. Read it from the environment, accept a base URL
# with or without a trailing /v1, and keep 8099 as the bare-testbed default.
def _server() -> str:
    raw = (os.environ.get("PI_OFFICE_GEN_SERVER")
           or os.environ.get("OPENAI_BASE_URL")
           or "http://127.0.0.1:8099")
    return raw.rstrip("/").removesuffix("/v1")


SERVER = _server()

# The layout menu, as the model sees it. Short descriptions, and an explicit
# note on WHEN to use each — a small model given ten equal-looking options
# defaults to the first one every time.
MENU = """
hero_title  — COVER. Full-bleed photo ground, huge type. Use for slide 1. {"title","subtitle","eyebrow","footnote","image_query"}
hero_split  — photo on one half, argument on the other, one stat breaking the seam. {"title","kicker","body":[...],"stat":{"value","label"},"image_query"}
hero_statement — ONE sentence, very large, over a photo. The deck's quiet moment. {"statement","attribution","image_query"}
section     — divider opening a new part. {"number","title","summary"}
stats       — 2-4 headline NUMBERS set huge. {"title","kicker","stats":[{"value","label"}],"note"}
bars        — ranked horizontal bars to COMPARE quantities. {"title","kicker","items":[{"label","value","display"}],"highlight_index","note"}
flow        — a PROCESS as connected nodes. Use for any sequence or cycle. {"title","kicker","steps":[{"label","caption","emphasis"}],"note"}
matrix      — claims vs options with filled cells. Beats two bullet lists for a comparison. {"title","kicker","columns":[...],"rows":[{"label","values":[true,false]}],"verdict"}
waffle      — one proportion as a 100-dot grid. {"title","kicker","percent","label","note"}
range       — labelled bands on one axis, for THRESHOLDS. {"title","kicker","bands":[{"label","from","to"}],"note"}
comparison  — two camps, split screen. {"title","kicker","sides":[{"heading","points":[...]},{...}]}
table       — small grid of facts. {"title","kicker","headers":[...],"rows":[[...]]}
quote       — a striking sentence, set in serif italic. {"quote","attribution"}
closing     — numbered takeaways. {"title","points":[...]}
""".strip()


def post(payload: dict, timeout=600) -> dict:
    return post_json(f"{SERVER}/v1/chat/completions", payload, timeout)


def ask(system: str, user: str, *, schema_hint: str = "", max_tokens=900) -> str:
    payload = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user + schema_hint},
        ],
        "temperature": 0.6,
        "top_p": 0.9,
        "max_tokens": max_tokens,
        # Grammar-constrained to a JSON object. Asking a 4B for "JSON only" and
        # hoping is how you get "Here is the JSON:" prepended to your parse.
        "response_format": {"type": "json_object"},
        # Qwen3.5 is a reasoning model: left alone it spends the ENTIRE token
        # budget in reasoning_content and returns content='' with
        # finish_reason='length'. Nothing about that failure says "thinking ate
        # your output" — it just looks like an empty reply.
        "chat_template_kwargs": {"enable_thinking": False},
        "cache_prompt": True,
    }
    out = post(payload)["choices"][0]["message"]["content"]
    return out


def parse_json(raw: str, tag: str = "x"):
    (scratch_dir() / f"raw_{tag}.txt").write_text(raw)
    raw = raw.strip()
    m = re.search(r"\{.*\}", raw, re.S)
    if m:
        raw = m.group(0)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as first:
        # SALVAGE a truncated object. Hitting the token ceiling mid-array is the
        # commonest small-model JSON failure, and discarding a good plan because
        # its last entry was cut in half is pure waste.
        cut = max(raw.rfind("},"), raw.rfind("}\n"), raw.rfind("} "), raw.rfind("}"))
        if cut == -1:
            raise first
        head = raw[: cut + 1]
        for closing in ("", "]}", "}]}", "}}]}", "]}}"):
            try:
                return json.loads(head + closing)
            except json.JSONDecodeError:
                continue
        raise first


def outline(report: str, n: int) -> list[dict]:
    sys_p = (
        "You are a presentation planner. You read a research report and plan a deck. "
        "You never write slide content at this stage — only the plan.\n\n"
        "Available layouts:\n" + MENU + "\n\n"
        "Rules:\n"
        "- Open with `hero_title`, close with `closing`.\n"
        "- Include ONE `hero_statement` or `quote` as the deck's quiet moment.\n"
        "- Use `flow` if the report describes any process or cycle.\n"
        "- Use `matrix` for the two-camp comparison rather than two bullet lists.\n"
        "- For any slide with an image_query, give 2-4 words describing an ABSTRACT photo (architecture, texture, landscape). Never a chart or a diagram.\n"
        "- DATA VISUALISATION IS THE PRIORITY. The report is full of figures. At least "
        "FOUR slides must be one of: stats, bars, waffle, range, table.\n"
        
        
        "- Vary the layout from slide to slide. Never use the same layout three times running.\n"
        "- Every slide must come from the report. Invent nothing."
    )
    user = (
        f"REPORT:\n\n{report}\n\n"
        f"Plan exactly {n} slides. Reply as JSON: "
        '{"theme": one of ["midnight","forest","terracotta","charcoal","ink"], '
        '"running_title": "<short deck name>", '
        '"slides":[{"layout":"...","title":"...","intent":"<what it must say, max 12 words>"}]}'
    )
    data = parse_json(ask(sys_p, user, max_tokens=3000), "plan")
    return data


def fill(report: str, plan_slide: dict, idx: int, total: int) -> dict:
    layout = plan_slide["layout"]
    sys_p = (
        "You write the content for ONE slide of a presentation, from a research report.\n"
        "Reply with JSON for that slide only. Use the exact field names given.\n\n"
        "Writing rules:\n"
        "- Short. A slide is not a paragraph. Bullets under 14 words.\n"
        "- Use concrete facts and numbers from the report wherever possible.\n"
        "- No filler like 'Introduction' or 'In conclusion'.\n"
        "- Never invent a number that is not in the report.\n"
        "- For bars/waffle/range/stats, every number MUST appear in the report. "
        "Never invent a value to fill a chart. If the report has no comparable "
        "figures for this slide, say so in the fields you can fill honestly."
    )
    schema = next((l for l in MENU.splitlines() if l.strip().startswith(layout)), layout)
    user = (
        f"REPORT:\n\n{report}\n\n"
        f"SLIDE {idx} of {total}. Layout: {layout}\n"
        f"Planned title: {plan_slide.get('title','')}\n"
        f"This slide must say: {plan_slide.get('intent','')}\n\n"
        f"Schema for this layout:\n{schema}\n\n"
        f'Reply as JSON with "layout": "{layout}" plus that layout\'s fields.'
    )
    out = parse_json(ask(sys_p, user, max_tokens=700), f"fill{idx}")
    out["layout"] = layout
    return out


def main():
    report = (HERE / "report.md").read_text()
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12

    t0 = time.time()
    print(f"[plan] asking for {n} slides ...", flush=True)
    plan = outline(report, n)
    slides_plan = plan["slides"][:n]
    print(f"[plan] {len(slides_plan)} slides, theme={plan.get('theme')} "
          f"({time.time()-t0:.0f}s)", flush=True)
    for i, s in enumerate(slides_plan, 1):
        print(f"       {i:2}. {s.get('layout','?'):11} {s.get('title','')[:58]}", flush=True)

    filled = []
    for i, ps in enumerate(slides_plan, 1):
        for attempt in (1, 2):
            try:
                s = fill(report, ps, i, len(slides_plan))
                filled.append(s)
                print(f"[fill] {i:2}/{len(slides_plan)} {ps['layout']:11} ok", flush=True)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"[fill] {i:2} {ps['layout']} FAILED ({e}) — dropped", flush=True)
                else:
                    print(f"[fill] {i:2} retry ({type(e).__name__})", flush=True)

    spec = {
        "theme": plan.get("theme", "ink"),
        "running_title": plan.get("running_title", ""),
        "slides": filled,
    }
    out = scratch_dir() / "deck_spec.json"
    out.write_text(json.dumps(spec, indent=1))
    print(f"\n[done] {len(filled)} slides in {time.time()-t0:.0f}s -> {out}")


if __name__ == "__main__":
    main()
