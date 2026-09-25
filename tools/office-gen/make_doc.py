#!/usr/bin/env python3
"""
One prompt -> a designed .docx / .xlsx / .pdf, via qwen3.5-4b.

Same plan-then-fill shape as the deck generator, and the same division of
labour: the model writes content, picks block types and CHOOSES THE PALETTE;
the renderers own every pixel.

    python3 make_doc.py docx "the prompt"
"""
import os
import json, re, sys, time, urllib.request
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

MENUS = {
 "docx": """
cover    — title page, colour band. {"type":"cover","eyebrow","title","subtitle","byline"}
heading  — section head + one-line standfirst. {"type":"heading","title","standfirst"}
body     — 1-3 prose paragraphs. {"type":"body","paragraphs":[...]}
callout  — a tinted panel for the one point that matters. {"type":"callout","label","text"}
stats    — 2-4 headline numbers. {"type":"stats","stats":[{"value","label"}]}
table    — small grid. {"type":"table","headers":[...],"rows":[[...]]}
quote    — pull quote in serif italic. {"type":"quote","quote","attribution"}
bullets  — short list. {"type":"bullets","items":[...]}
pagebreak— start a new page. {"type":"pagebreak"}
""",
 "pdf": """
cover    — full-page colour field. {"type":"cover","eyebrow","title","subtitle","byline"}
heading  — section head + standfirst. {"type":"heading","title","standfirst"}
body     — prose paragraphs. {"type":"body","paragraphs":[...]}
callout  — tinted panel with an accent spine. {"type":"callout","label","text"}
stats    — 2-4 headline numbers. {"type":"stats","stats":[{"value","label"}]}
bars     — a drawn bar chart. {"type":"bars","items":[{"label","value","display"}],"highlight_index"}
table    — small grid. {"type":"table","headers":[...],"rows":[[...]]}
quote    — serif italic pull quote. {"type":"quote","quote","attribution"}
bullets  — short list. {"type":"bullets","items":[...]}
""",
}

def post(payload, timeout=600):
    return post_json(f"{SERVER}/v1/chat/completions", payload, timeout)

def ask(system, user, max_tokens=2600):
    return post({"messages":[{"role":"system","content":system},{"role":"user","content":user}],
        "temperature":0.6,"top_p":0.9,"max_tokens":max_tokens,
        "response_format":{"type":"json_object"},
        "chat_template_kwargs":{"enable_thinking":False},"cache_prompt":True
    })["choices"][0]["message"]["content"]

def parse(raw, tag):
    (scratch_dir()/f"raw_{tag}.txt").write_text(raw)
    m = re.search(r"\{.*\}", raw.strip(), re.S)
    s = m.group(0) if m else raw
    try: return json.loads(s)
    except json.JSONDecodeError as e:
        cut = s.rfind("}")
        for close in ("", "]}", "}]}", "}}]}"):
            try: return json.loads(s[:cut+1]+close)
            except json.JSONDecodeError: continue
        raise e

PALETTE_RULE = ('"palette":{"primary":"#RRGGBB","accent":"#RRGGBB"} — choose BOTH '
  'for the subject matter. Not generic blue unless the subject is genuinely corporate. '
  'primary is the dominant dark; accent is one sharp signal colour used sparingly.')

# CONTENT-DRIVEN (VQ-08). The rules used to be "Open with `cover`", "at least
# one stats, one callout and one table (and one bars)" and "9-14 blocks" — for
# ANY brief. A 4B obeyed: a "one-page" report came out as a full cover band and
# 13 blocks over three pages, and a brief of four numbers got a regional table
# nobody gave it (REAL: the Annual Unit Sales PDF). The length now comes from
# the brief ("one-page", "2 pages"), and a block type is used for content the
# brief has, never to satisfy a quota.
NO_INVENTION = (
    "- Use stats, table" + "{bars} only for numbers the brief gives. Never invent data, rows, "
    "categories or totals to fill a block.\n"
    "- quote: only words the brief itself gives, credited as the brief credits them. Never invent a "
    "quote, a person, a role or a source.\n"
    "- No URL, citation or 'Data sourced from ...' line unless the brief gives it.\n"
)


def length_rule(pages):
    if pages == 1:
        return ("- It must fit ONE page: no `cover` — a `heading` is the masthead — and 4-7 blocks.\n")
    if pages:
        return (f"- It should run to about {pages} pages: at most {pages * 6} blocks"
                + ("; open with `cover`" if pages >= 3 else "; a `heading` is the masthead, no `cover`")
                + ".\n")
    return ("- Open with `cover` only for a document longer than two pages; otherwise a `heading` is "
            "the masthead. As many blocks as the content needs, no more.\n")


def generate(kind, prompt, parts=None):
    """`parts` are the brief's own parts (provenance.brief_parts): given, they
    follow the brief in the user message as the outline the document keeps."""
    import provenance
    if kind == "xlsx":
        sysp = ("You design spreadsheets. Reply as JSON only.\n"
            "Fields: title, subtitle, sheet_name, " + PALETTE_RULE + ", "
            'kpis:[{"value","label"}] (2-4 headline figures from the rows), headers:[...], '
            'rows:[[...]] (numbers as NUMBERS not strings), '
            'total_row:true, total_label, chart:{"type":"bar"|"line"|"pie","title"}, '
            'number_format (e.g. "#,##0" or "$#,##0").\n'
            "rows are the request's own data, one row per item it gives. Only when the request "
            "asks for an example or a template may you make rows up — then say so in the subtitle. "
            "Never invent a KPI that contradicts the rows.")
        return parse(ask(sysp, prompt, 2600), kind)
    sysp = ("You design documents. Reply as JSON only.\n"
        "Top level: title, running_title, " + PALETTE_RULE + ', blocks:[...].\n'
        "Block types:\n" + MENUS[kind] + "\n"
        "Rules:\n"
        "- Build the document from what the brief contains, in the brief's order. Every block "
        "carries the brief's content; no filler ('This report details ...').\n"
        + length_rule(provenance.pages_in(prompt))
        + NO_INVENTION.replace("{bars}", ", bars" if kind == "pdf" else "")
        + "- Alternate block types; never three `body` blocks in a row.\n"
        "- Prose is tight: a sentence, not a paragraph, wherever possible.")
    user = prompt if not parts else f"{prompt}\n\n{provenance.parts_block(parts).rstrip()}"
    return parse(ask(sysp, user, 3000), kind)

if __name__ == "__main__":
    kind, prompt = sys.argv[1], sys.argv[2]
    t0 = time.time()
    spec = generate(kind, prompt)
    (scratch_dir()/f"spec_{kind}.json").write_text(json.dumps(spec, indent=1))
    pal = spec.get("palette", {})
    n = len(spec.get("blocks", spec.get("rows", [])))
    print(f"[{kind}] {n} items, palette {pal.get('primary')}/{pal.get('accent')} in {time.time()-t0:.0f}s")
