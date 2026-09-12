#!/usr/bin/env python3
"""
THE ONE ENTRY POINT — `office make | edit | inspect`, for the app and for a person.

The pieces in this directory were written as a testbed: `make_doc.py` produced
a spec and stopped, `make_deck.py` read `report.md` from its own folder and took
a slide COUNT as its only argument, and `make_edit.py` would not even import.
Every prompt in the app that named them as `make_deck.py "<what you want>"` was
describing a command that did not exist — and a model that runs a command that
fails goes straight back to hand-writing the file format, which is the one thing
this pipeline exists to prevent.

So this is the surface that is actually called, with one shape for all of it:

    office.py make    <pptx|docx|xlsx|pdf> --brief "<what, with the real facts>" --out <path> [--slides N]
    office.py edit    <file> --instruction "<change>" [--out <path>]
    office.py inspect <file>

Every command prints ONE JSON object on stdout (progress goes to stderr) and
exits non-zero with {"ok": false, "error": …} when it could not do the job, so
the caller — the harness's `office` tool — never has to parse prose.

The division of labour is unchanged: the local model writes the words and picks
the design; deterministic code owns every byte of the file. This script only
wires those two together and reports what came out.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

KINDS = ("pptx", "docx", "xlsx", "pdf")
OUTLINE_LINES = 80


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)
    sys.exit(code)


def fail(error: str, **extra) -> None:
    emit({"ok": False, "error": error, **extra}, 1)


def resolve_out(out: str | None, kind: str, brief: str) -> Path:
    """`--out` as given (extension corrected), else a name from the brief in cwd."""
    if out:
        p = Path(out).expanduser()
        if p.suffix.lower() != f".{kind}":
            p = p.with_suffix(f".{kind}")
        return p.resolve()
    stem = "".join(c if c.isalnum() else "-" for c in brief.lower())[:48].strip("-") or "document"
    return (Path.cwd() / f"{stem}.{kind}").resolve()


def outline_of(path: Path, kind: str) -> str:
    """What is in the file, as the edit pipeline sees it — ids the model can name."""
    import make_edit
    import office_edit
    o = office_edit.INSPECT[kind](path)
    text = make_edit.outline_text(o)
    lines = text.splitlines()
    if len(lines) > OUTLINE_LINES:
        lines = lines[:OUTLINE_LINES] + [f"… ({len(lines) - OUTLINE_LINES} more lines)"]
    return "\n".join(lines)


def _one(v, n: int = 90) -> str:
    if isinstance(v, list):
        v = " · ".join(str(x) for x in v[:4])
    s = str(v or "").replace("\n", " ").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def summary_of(kind: str, spec: dict) -> str:
    """What was MADE, one line per slide/block/row group — from the spec, which
    is the truth about content; the shape outline is for editing, not reading."""
    if kind == "pptx":
        out = []
        for i, sl in enumerate(spec.get("slides", []), 1):
            head = sl.get("title") or sl.get("statement") or sl.get("quote") or ""
            tail = sl.get("subtitle") or sl.get("kicker") or sl.get("summary") or ""
            body = sl.get("body") or sl.get("points") or sl.get("bullets") or ""
            if not tail and sl.get("stats"):
                tail = ", ".join(f'{x.get("value")} {x.get("label")}' for x in sl["stats"][:4] if isinstance(x, dict))
            line = f"{i}. {sl.get('layout', '?')}: {_one(head)}"
            if tail:
                line += f" — {_one(tail, 70)}"
            if body:
                line += f" [{_one(body, 80)}]"
            out.append(line)
        return "\n".join(out)
    if kind == "xlsx":
        kpis = ", ".join(f'{k.get("value")} {k.get("label")}' for k in spec.get("kpis", []) if isinstance(k, dict))
        headers = " | ".join(str(h) for h in spec.get("headers", []))
        rows = spec.get("rows", [])
        chart = spec.get("chart") or {}
        return "\n".join(
            x for x in [
                f"sheet '{spec.get('sheet_name', 'Sheet1')}': {spec.get('title', '')}",
                f"KPIs: {kpis}" if kpis else "",
                f"columns: {headers}",
                f"{len(rows)} rows" + (f", total row '{spec.get('total_label')}'" if spec.get("total_row") else ""),
                f"chart: {chart.get('type')} — {chart.get('title')}" if chart else "",
            ] if x
        )
    out = [f"title: {_one(spec.get('title', ''))}"]
    for i, b in enumerate(spec.get("blocks", []), 1):
        t = b.get("type", "?")
        head = b.get("title") or b.get("label") or b.get("quote") or b.get("eyebrow") or ""
        body = b.get("text") or b.get("standfirst") or b.get("paragraphs") or b.get("items") or b.get("stats") or b.get("headers") or ""
        if isinstance(body, list) and body and isinstance(body[0], dict):
            body = ", ".join(f'{x.get("value", "")} {x.get("label", "")}'.strip() for x in body[:4])
        line = f"{i}. {t}: {_one(head, 70)}" if head else f"{i}. {t}"
        if body:
            line += f" — {_one(body, 90)}"
        out.append(line)
    return "\n".join(out)


# ── make ─────────────────────────────────────────────────────────────────────
def slides_in(brief: str) -> int | None:
    """'a 6-slide deck', 'six slides', '10 slides' — the count the brief asks for.

    MEASURED: asked for a 6-slide deck the model passed no --slides and the
    default made 8; it then told the user it had made six. The brief carries
    the number; read it rather than trust a default over the person's words."""
    words = {"three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
             "ten": 10, "twelve": 12, "fifteen": 15, "twenty": 20}
    m = re.search(r"\b(\d{1,2}|[a-z]+)[\s-]*slides?\b", brief, re.I)
    n = None
    if m:
        tok = m.group(1).lower()
        n = int(tok) if tok.isdigit() else words.get(tok)
    if n is None:
        # A brief written slide by slide — "Slide 1: …" … "Slide 6: …" — asks
        # for exactly that many, and MEASURED a model writes them that way.
        heads = [int(x) for x in re.findall(r"\bslide\s+(\d{1,2})\b", brief, re.I)]
        if heads and max(heads) == len(set(heads)):
            n = max(heads)
    return n if n and 3 <= n <= 24 else None


def retry(fn, what: str):
    """One more go when the model's JSON did not parse — a truncated object is
    the commonest small-model failure and the second sample usually lands."""
    try:
        return fn()
    except (ValueError, KeyError) as err:  # json.JSONDecodeError is a ValueError
        log(f"[{what}] retrying once: {err}")
        return fn()


def make(kind: str, brief: str, out: Path, slides: int | None) -> dict:
    t0 = time.time()
    warnings: list[str] = []
    if kind == "pptx":
        import make_deck
        import render_deck
        n = max(3, min(24, slides or slides_in(brief) or 8))
        log(f"[plan] {n} slides")
        plan = retry(lambda: make_deck.outline(brief, n), "plan")
        planned = plan.get("slides", [])[:n]
        if not planned:
            raise RuntimeError("the model returned no slide plan")
        filled = []
        for i, ps in enumerate(planned, 1):
            layout = ps.get("layout", "bullets")
            for attempt in (1, 2):
                try:
                    filled.append(make_deck.fill(brief, ps, i, len(planned)))
                    log(f"[fill] {i}/{len(planned)} {layout}")
                    break
                except Exception as err:  # noqa: BLE001 — one slide, retried once
                    if attempt == 2:
                        warnings.append(f"slide {i} ({layout}) dropped: {err}")
                        log(f"[fill] {i} FAILED — dropped")
        spec = {
            "theme": plan.get("theme", "ink"),
            "running_title": plan.get("running_title", ""),
            "slides": filled,
        }
        render_deck.build(spec, out)
        design = {"theme": spec["theme"]}
        items = len(filled)
    else:
        import make_doc
        spec = retry(lambda: make_doc.generate(kind, brief), "spec")
        if kind == "docx":
            import doc_render as renderer
        elif kind == "xlsx":
            import sheet_render as renderer
        else:
            import pdf_render as renderer
        renderer.build(spec, out)
        design = {"palette": spec.get("palette", {})}
        items = len(spec.get("blocks", spec.get("rows", [])))
    from scratch import scratch_dir
    (scratch_dir() / f"last_{kind}_spec.json").write_text(json.dumps(spec, indent=1))
    if not out.exists() or out.stat().st_size < 1024:
        raise RuntimeError(f"the renderer wrote nothing usable at {out}")
    return {
        "ok": True,
        "kind": kind,
        "path": str(out),
        "bytes": out.stat().st_size,
        "items": items,
        **design,
        "seconds": round(time.time() - t0, 1),
        "warnings": warnings,
        "summary": summary_of(kind, spec),
    }


# ── edit ─────────────────────────────────────────────────────────────────────
def edit(src: Path, instruction: str, out: Path | None) -> dict:
    import make_edit
    import office_edit
    t0 = time.time()
    kind = office_edit.kind_of(src)
    if kind not in office_edit.INSPECT:
        raise RuntimeError(
            f"{src.suffix} cannot be edited in place — a PDF has no document model. "
            "Make it again with `office make pdf` and the changed brief.")
    dst = out or src
    o = office_edit.INSPECT[kind](src)
    text = make_edit.outline_text(o)
    sysp = (
        f"You edit {kind.upper()} documents by emitting operations. Reply as JSON only:\n"
        '{"ops":[ ... ]}\n\n'
        "Available operations:\n" + make_edit.OPS[kind] + "\n"
        "RULES\n"
        "- Only use ids that appear in the outline. An invented id is a failed edit.\n"
        "- Emit ONLY the operations the instruction asks for. Do not tidy, restyle or "
        "improve anything you were not asked about.\n"
        "- set_text keeps the existing styling, so use it for wording changes and do "
        "not follow it with a set_style unless the instruction asked for one.\n"
        "- If the instruction cannot be done with these operations, return {\"ops\":[]}."
    )
    user = f"DOCUMENT OUTLINE\n{text}\n\nINSTRUCTION\n{instruction}"
    ops = make_edit.parse(make_edit.ask(sysp, user))
    log(f"[{kind}] {len(ops)} ops")
    if not ops:
        raise RuntimeError(
            "the model found no operation for that instruction — say WHICH slide/paragraph/"
            "cell and WHAT it should become (the outline below names them).\n" + text[:1500])
    # Apply to a temp target when editing in place: a failed apply must not
    # leave a half-written file where the good one was.
    tmp = dst.with_name(f".{dst.stem}.editing{dst.suffix}")
    report = office_edit.APPLY[kind](src, ops, tmp)
    os.replace(tmp, dst)
    missed = [line for line in report if "no such" in line.lower() or "unknown" in line.lower() or "missed" in line.lower()]
    return {
        "ok": True,
        "kind": kind,
        "path": str(dst),
        "bytes": dst.stat().st_size,
        "ops": len(ops),
        "applied": [line for line in report if line not in missed],
        "missed": missed,
        "seconds": round(time.time() - t0, 1),
        "outline": outline_of(dst, kind),
    }


# ── inspect ──────────────────────────────────────────────────────────────────
def inspect(src: Path) -> dict:
    import office_edit
    kind = office_edit.kind_of(src)
    if kind not in office_edit.INSPECT:
        raise RuntimeError(f"{src.suffix} has no outline to inspect (PDF is placement, not structure)")
    return {"ok": True, "kind": kind, "path": str(src), "outline": outline_of(src, kind)}


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(prog="office", add_help=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    m.add_argument("kind", choices=KINDS)
    m.add_argument("--brief", required=True)
    m.add_argument("--out")
    m.add_argument("--slides", type=int)
    e = sub.add_parser("edit")
    e.add_argument("file")
    e.add_argument("--instruction", required=True)
    e.add_argument("--out")
    i = sub.add_parser("inspect")
    i.add_argument("file")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "make":
            brief = a.brief.strip()
            if len(brief) < 12:
                fail("the brief is too short to make anything from — say what the document is "
                     "about and give it the real content: names, numbers, sections.")
            emit(make(a.kind, brief, resolve_out(a.out, a.kind, brief), a.slides))
        elif a.cmd == "edit":
            src = Path(a.file).expanduser().resolve()
            if not src.is_file():
                fail(f"no file at {src}")
            emit(edit(src, a.instruction.strip(), Path(a.out).expanduser().resolve() if a.out else None))
        else:
            src = Path(a.file).expanduser().resolve()
            if not src.is_file():
                fail(f"no file at {src}")
            emit(inspect(src))
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001 — everything reaches the caller as JSON
        detail = traceback.format_exc().strip().splitlines()[-1]
        msg = str(err) or detail
        if "Connection refused" in msg or "urlopen" in detail or "URLError" in detail:
            msg = (f"the local model server did not answer ({msg}). The app starts it when a "
                   "chat model is loaded; PI_OFFICE_GEN_SERVER names it.")
        fail(msg, kind=getattr(a, "kind", None) or getattr(a, "file", None))


if __name__ == "__main__":
    main(sys.argv[1:])
