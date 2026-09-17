#!/usr/bin/env python3
"""
"Change X" on an existing document -> applied edits, via qwen3.5-4b.

    python3 make_edit.py out/deck.pptx "make the title slide red and cut the last slide"

THE OUTLINE IS THE PROMPT. A 4B model cannot navigate OOXML, but it can pick a
line out of a numbered list. office_edit.inspect reduces the file to one short
line per editable element; the model returns operations naming those ids; the
apply step reports every one, including the ones that missed.

Compact text beats JSON here. The same 12-slide deck is ~9k characters as
pretty-printed JSON and ~2k as lines, and the lines are what the model actually
reads well — a nested object costs attention on braces that should go on the
edit itself.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import office_edit  # noqa: E402
from scratch import post_json, scratch_dir  # noqa: E402

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


def post(payload, timeout=600):
    return post_json(f"{SERVER}/v1/chat/completions", payload, timeout)


def ask(system, user, max_tokens=1800):
    return post({"messages": [{"role": "system", "content": system},
                              {"role": "user", "content": user}],
                 "temperature": 0.3, "top_p": 0.9, "max_tokens": max_tokens,
                 "response_format": {"type": "json_object"},
                 "chat_template_kwargs": {"enable_thinking": False},
                 "cache_prompt": True})["choices"][0]["message"]["content"]


# ── the outline, as lines ─────────────────────────────────────────────────────
def outline_text(o: dict) -> str:
    fmt = o["format"]
    lines: list[str] = []
    if fmt == "pptx":
        lines.append(f"SLIDE SIZE {o['size']['w']}x{o['size']['h']} inches")
        for sl in o["slides"]:
            lines.append(f"-- slide {sl['slide']} --")
            for sh in sl["shapes"]:
                bits = [sh["id"], sh["kind"]]
                if sh.get("text"):
                    bits.append(f'"{sh["text"][:70]}"')
                if sh.get("fill"):
                    bits.append(f"fill={sh['fill']}")
                if sh.get("color"):
                    bits.append(f"text={sh['color']}")
                if sh.get("size"):
                    bits.append(f"{sh['size']}pt")
                bits.append(f"at {sh.get('x')},{sh.get('y')} {sh.get('w')}x{sh.get('h')}in")
                lines.append("  " + " ".join(str(b) for b in bits))
    elif fmt == "docx":
        for p in o["paragraphs"]:
            bits = [p["id"], f'"{p["text"][:90]}"']
            if p.get("size"):
                bits.append(f"{p['size']}pt")
            if p.get("bold"):
                bits.append("bold")
            if p.get("color"):
                bits.append(p["color"])
            lines.append(" ".join(str(b) for b in bits))
        for t in o["tables"]:
            lines.append(f"-- table {t['table']} --")
            for row in t["rows"][:6]:
                lines.append("  " + " | ".join(f'{c["id"]}:"{c["text"][:24]}"' for c in row))
    else:
        for s in o["sheets"]:
            lines.append(f"-- sheet {s['sheet']} ({s['dims']}, {s['charts']} charts) --")
            for c in s["cells"]:
                lines.append(f'  {c["id"]} = "{c["value"][:40]}" [{c["format"]}]')
    return "\n".join(lines)


OPS = {
    "pptx": """
{"op":"set_text","id":"s2.3","text":"..."}          replace the wording, KEEPING its styling
{"op":"set_style","id":"s2.3","size":24,"bold":true,"italic":false,"color":"#RRGGBB"}
{"op":"set_fill","id":"s2.1","color":"#RRGGBB"}      or "none" for no fill
{"op":"move","id":"s2.4","x":1.1,"y":5.6}            inches from the top-left
{"op":"resize","id":"s2.1","w":7.0,"h":2.0}          inches
{"op":"delete","id":"s2.5"}
{"op":"delete_slide","slide":12}
{"op":"duplicate_slide","slide":2}
{"op":"reorder_slides","order":[1,3,2,4]}            must list EVERY slide exactly once
{"op":"insert_chart","slide":2,"file":"units.svg","box":[6.8,1.4,6.0,4.4]}   a chart made by the chart tool (its .svg), box in inches x,y,w,h (omit box: the right half)
""",
    "docx": """
{"op":"set_text","id":"p3","text":"..."}             replace the wording, KEEPING its styling
{"op":"set_style","id":"p3","size":19,"bold":true,"italic":false,"color":"#RRGGBB"}
{"op":"insert_paragraph","after":"p5","text":"..."}
{"op":"delete","id":"p7"}
{"op":"insert_chart","after":"p5","file":"units.svg","width":6.0}   a chart made by the chart tool, after a paragraph, width in inches
Table cells use their own ids: {"op":"set_text","id":"t0.r1.c2","text":"..."}
""",
    "xlsx": """
{"op":"set_cell","id":"B7","value":123}              a string starting with = stays a FORMULA
{"op":"set_number_format","id":"B8:B15","format":"$#,##0"}
{"op":"set_style","id":"A16","bold":true,"color":"#RRGGBB","fill":"#RRGGBB"}
{"op":"set_column_width","column":"A","width":30}
{"op":"delete_row","row":9}
{"op":"insert_chart","anchor":"H2","file":"units.svg"}   a native Excel chart from a chart made by the chart tool, top-left at a cell
""",
}


def parse(raw: str) -> list[dict]:
    (scratch_dir() / "raw_edit.txt").write_text(raw)
    m = re.search(r"\{.*\}", raw.strip(), re.S)
    s = m.group(0) if m else raw
    try:
        data = json.loads(s)
    except json.JSONDecodeError:
        # Same truncation salvage as the generator: a cut-off list is still
        # worth most of its operations, and dropping the whole edit because the
        # last object is half-written is the wrong trade.
        cut = s.rfind("}")
        for close in ("]}", "}]}", ""):
            try:
                data = json.loads(s[:cut + 1] + close)
                break
            except json.JSONDecodeError:
                continue
        else:
            raise
    return data.get("ops", []) if isinstance(data, dict) else data


def main() -> None:
    src = Path(sys.argv[1])
    instruction = sys.argv[2]
    dst = Path(sys.argv[3]) if len(sys.argv) > 3 else src.with_name(f"{src.stem}-edited{src.suffix}")

    kind = office_edit.kind_of(src)
    t0 = time.time()
    o = office_edit.INSPECT[kind](src)
    text = outline_text(o)
    (scratch_dir() / "outline.txt").write_text(text)

    sysp = (
        f"You edit {kind.upper()} documents by emitting operations. Reply as JSON only:\n"
        '{"ops":[ ... ]}\n\n'
        "Available operations:\n" + OPS[kind] + "\n"
        "RULES\n"
        "- Only use ids that appear in the outline. An invented id is a failed edit.\n"
        "- Emit ONLY the operations the instruction asks for. Do not tidy, restyle or "
        "improve anything you were not asked about.\n"
        "- set_text keeps the existing styling, so use it for wording changes and do "
        "not follow it with a set_style unless the instruction asked for one.\n"
        "- If the instruction cannot be done with these operations, return {\"ops\":[]}."
    )
    user = f"DOCUMENT OUTLINE\n{text}\n\nINSTRUCTION\n{instruction}"

    ops = parse(ask(sysp, user))
    (scratch_dir() / "ops.json").write_text(json.dumps(ops, indent=1))
    print(f"[{kind}] {len(ops)} ops in {time.time() - t0:.0f}s")
    for line in office_edit.APPLY[kind](src, ops, dst):
        print(" ", line)
    print(f"wrote {dst}")


if __name__ == "__main__":
    main()
