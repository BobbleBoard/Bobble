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

KINDS = ("pptx", "docx", "xlsx", "pdf", "chart")
# A chart is an .svg (chart_render.py); every other kind's extension is its name.
EXT = {"chart": "svg"}
OUTLINE_LINES = 80


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)
    sys.exit(code)


def fail(error: str, **extra) -> None:
    emit({"ok": False, "error": error, **extra}, 1)


KIND_WORDS = (
    ("pptx", r"\b(pptx|powerpoint|slides?|slide deck|deck|presentation|keynote)\b"),
    ("docx", r"\b(docx|word document|word doc|word file|\.doc|memo|letter|report|document)\b"),
    ("xlsx", r"\b(xlsx|excel|spreadsheet|workbook|sheet)\b"),
    ("pdf", r"\bpdf\b"),
    ("chart", r"\b(bar|line|pie|donut)\s*(chart|graph)|\bchart\b|\bgraph of\b"),
)


def infer_kind(brief: str, out: str | None) -> str | None:
    """The kind an --out extension or the brief's own words name, else None."""
    import re
    if out:
        ext = Path(out).suffix.lower().lstrip(".")
        if ext == "svg":
            return "chart"
        if ext in KINDS:
            return ext
    low = brief.lower()
    hits = [k for k, pat in KIND_WORDS if re.search(pat, low)]
    # "chart" inside a deck brief is a slide, not the kind; the first explicit
    # format word wins, and a lone chart word means a chart.
    return hits[0] if hits else None


def resolve_out(out: str | None, kind: str, brief: str) -> Path:
    """`--out` as given (extension corrected), else a name from the brief in cwd."""
    ext = EXT.get(kind, kind)
    if out:
        p = Path(out).expanduser()
        if p.suffix.lower() != f".{ext}":
            p = p.with_suffix(f".{ext}")
        return p.resolve()
    stem = "".join(c if c.isalnum() else "-" for c in brief.lower())[:48].strip("-") or "document"
    return (Path.cwd() / f"{stem}.{ext}").resolve()


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


MAX_WARNINGS = 6


def compact(warnings: list[str]) -> list[str]:
    """At most MAX_WARNINGS lines for the model, duplicates folded — it acts on
    a short list and loops on a long one."""
    seen = list(dict.fromkeys(w for w in warnings if w))
    if len(seen) <= MAX_WARNINGS:
        return seen
    return seen[: MAX_WARNINGS - 1] + [f"…and {len(seen) - MAX_WARNINGS + 1} more like these"]


def _drawn_line(n: int, d: dict, unit: str) -> str:
    """One line of what a slide/block SHOWS — its cuts said as 'k of n shown'."""
    kind = d.get("layout") or d.get("type") or "?"
    asked = d.get("asked")
    label = f"{kind} (asked for {asked})" if asked and asked != kind else kind
    head = d.get("head") or ""
    line = f"{n}. {label}: {_one(head)}" if head else f"{n}. {label}"
    if d.get("tail"):
        line += f" — {_one(d['tail'], 70)}"
    items = [x for x in (d.get("items") or []) if x]
    cuts = d.get("cuts") or []
    if cuts:
        c = cuts[0]
        more = f" (+{len(cuts) - 1} more cut)" if len(cuts) > 1 else ""
        line += f" [{c['field']}: {c['shown']} of {c['given']} shown{more} — {_one(items, 80)}]"
    elif items:
        line += f" [{_one(items, 80)}]"
    for note in d.get("notes") or []:
        if "shortened" not in note:
            line += f" ({note})"
    return line


def summary_of(kind: str, spec: dict, drawn: list[dict] | None = None) -> str:
    """What was MADE, one line per slide/block/row group.

    From the renderer's record of what it DREW when there is one (VQ-01, D19):
    a list cut to fit, a layout that fell back, a title shortened — the model
    is told what the file shows, not what the spec asked for."""
    if drawn and kind in ("pptx", "docx", "pdf"):
        head = [] if kind == "pptx" else [f"title: {_one(spec.get('title', ''))}"]
        return "\n".join(head + [_drawn_line(i, d, "slide" if kind == "pptx" else "block")
                                 for i, d in enumerate(drawn, 1)])
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
    if kind == "chart":
        series = spec.get("series") or []
        pts = sum(len(s.get("points") or []) for s in series if isinstance(s, dict))
        first = series[0] if series and isinstance(series[0], dict) else {}
        labels = ", ".join(str(p.get("label")) for p in (first.get("points") or [])[:8] if isinstance(p, dict))
        return "\n".join(x for x in [
            f"{spec.get('type', 'bar')} chart: {_one(spec.get('title', ''), 70)}",
            f"{len(series)} series, {pts} points — {labels}",
            f"highlight: {spec.get('highlight')}" if spec.get("highlight") else "",
        ] if x)
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
    if n is None:
        # A STRUCTURED brief — {"slides": [ {...}, {...}, {...}, {...} ]} — is
        # its own count. MEASURED on a 4B asked for a four-slide deck: it wrote
        # exactly four slide objects, the default made eight, and it then
        # spent twelve minutes editing the eight down. The objects are the ask.
        t = brief.strip()
        if t.startswith("{"):
            try:
                obj = json.loads(t)
                slides = obj.get("slides") if isinstance(obj, dict) else None
                if isinstance(slides, list) and slides:
                    n = len(slides)
            except json.JSONDecodeError:
                pass
        if n is None:
            # …or a numbered list of slide-like headings ("1. Title", "4. Summary").
            numbered = [int(x) for x in re.findall(r"^\s*(\d{1,2})[.)]\s+\S", brief, re.M)]
            if numbered and max(numbered) == len(set(numbered)) and 3 <= max(numbered) <= 24:
                n = max(numbered)
    return n if n and 3 <= n <= 24 else None


def retry(fn, what: str):
    """One more go when the model's JSON did not parse — a truncated object is
    the commonest small-model failure and the second sample usually lands."""
    try:
        return fn()
    except (ValueError, KeyError) as err:  # json.JSONDecodeError is a ValueError
        log(f"[{what}] retrying once: {err}")
        return fn()


def make(kind: str, brief: str, out: Path, slides: int | None, auto_out: bool = False) -> dict:
    t0 = time.time()
    warnings: list[str] = []
    drawn: list[dict] = []
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
        render_deck.build(spec, out, drawn=drawn, warnings=warnings)
        design = {"theme": spec["theme"]}
        items = len(filled)
    elif kind == "chart":
        # A chart of DATA: the brief's numbers, drawn (chart_render.py) — never
        # a generated picture, which cannot put a value on an axis.
        import chart_render
        import make_chart
        spec = retry(lambda: make_chart.spec_from_brief(brief), "chart")
        if auto_out:
            # Named after the chart, not after a slug of its numbers — a brief
            # that is JSON made `units-sold-by-year----label---2021---value--12.svg`.
            title = str(spec.get("title") or "").strip()
            stem = "".join(c if c.isalnum() else "-" for c in title.lower()).strip("-")
            stem = "-".join(x for x in stem.split("-") if x)[:48]
            if stem:
                out = out.with_name(f"{stem}.svg")
        info = chart_render.render(spec, out)
        warnings += info.get("warnings", [])
        # The spec beside the file is what `office edit chart.svg` revises.
        out.with_suffix(".chart.json").write_text(json.dumps(chart_render.normalise(spec), indent=1))
        design = {"palette": spec.get("palette", {}), "chart": info["type"]}
        items = info["points"]
    else:
        import make_doc
        spec = retry(lambda: make_doc.generate(kind, brief), "spec")
        if kind == "docx":
            import doc_render as renderer
        elif kind == "xlsx":
            import sheet_render as renderer
        else:
            import pdf_render as renderer
        if kind == "xlsx":
            renderer.build(spec, out)
        else:
            renderer.build(spec, out, drawn=drawn, warnings=warnings)
        design = {"palette": spec.get("palette", {})}
        items = len(spec.get("blocks", spec.get("rows", [])))
    from scratch import scratch_dir
    (scratch_dir() / f"last_{kind}_spec.json").write_text(json.dumps(spec, indent=1))
    if not out.exists() or out.stat().st_size < (512 if kind == "chart" else 1024):
        raise RuntimeError(f"the renderer wrote nothing usable at {out}")
    return {
        "ok": True,
        "kind": kind,
        "path": str(out),
        "bytes": out.stat().st_size,
        "items": items,
        **design,
        "seconds": round(time.time() - t0, 1),
        "warnings": compact(warnings),
        "summary": summary_of(kind, spec, drawn),
    }


# ── edit ─────────────────────────────────────────────────────────────────────
def edit_chart(src: Path, instruction: str, out: Path | None) -> dict:
    """Revise the spec beside the chart and draw it again."""
    import chart_render
    import make_chart
    t0 = time.time()
    side = src.with_suffix(".chart.json")
    if not side.exists():
        raise RuntimeError(f"{src.name} was not made by `office make chart` (no {side.name} beside it) — make it again with the changed brief")
    spec = chart_render.normalise(json.loads(side.read_text()))
    revised = retry(lambda: make_chart.revise(spec, instruction), "chart-edit")
    dst = out or src
    info = chart_render.render(revised, dst)
    dst.with_suffix(".chart.json").write_text(json.dumps(chart_render.normalise(revised), indent=1))
    return {"ok": True, "kind": "chart", "path": str(dst), "bytes": info["bytes"], "items": info["points"],
            "seconds": round(time.time() - t0, 1), "warnings": compact(info.get("warnings", [])),
            "summary": summary_of("chart", chart_render.normalise(revised))}


def apply(src: Path, ops: list[dict], out: Path | None) -> dict:
    """Run explicit operations — no model in the loop. The harness builds these
    for the changes it can state exactly (a chart onto slide 2)."""
    import office_edit
    t0 = time.time()
    kind = office_edit.kind_of(src)
    dst = out or src
    tmp = dst.with_name(f".{dst.stem}.editing{dst.suffix}")
    report = office_edit.APPLY[kind](src, ops, tmp)
    failed = [line for line in report if line.startswith("FAIL") or line.startswith("UNKNOWN")]
    if failed and len(failed) == len(report):
        tmp.unlink(missing_ok=True)
        raise RuntimeError("; ".join(failed))
    os.replace(tmp, dst)
    result = {
        "ok": True,
        "kind": kind,
        "path": str(dst),
        "bytes": dst.stat().st_size,
        "ops": len(ops),
        "applied": [line for line in report if line not in failed],
        "missed": failed,
        "seconds": round(time.time() - t0, 1),
    }
    if kind in office_edit.INSPECT:
        result["outline"] = outline_of(dst, kind)
    else:
        result["outline"] = f"PDF, {_pdf_pages(dst)} pages"
    return result


def _pdf_pages(path: Path) -> int:
    try:
        import pypdf
        return len(pypdf.PdfReader(str(path)).pages)
    except Exception:  # noqa: BLE001
        return 0


PDF_PAGE_CHARS = 1500
PDF_OUTLINE_PAGES = 30


def pdf_outline(path: Path) -> str:
    """The PDF as the model should see it: its pages' text, page by page.

    A `read` on a PDF used to hand back the file's BYTES (SEEN: the 4B read
    `brief-model.pdf`, quoted "Gaa3~64OR_&~^/\\gtX…" back and reasoned about
    'object 13'), so the outline is the text with page numbers — the numbers
    `office edit file.pdf --chart x.svg --page N` takes.
    """
    import pypdf
    reader = pypdf.PdfReader(str(path))
    n = len(reader.pages)
    lines = [f"PDF, {n} page{'s' if n != 1 else ''}. A chart goes on a page with: office edit {path.name} --chart <svg> --page N"]
    for i, page in enumerate(reader.pages[:PDF_OUTLINE_PAGES], 1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:  # noqa: BLE001
            text = ""
        text = " ".join(text.split())
        if len(text) > PDF_PAGE_CHARS:
            text = text[: PDF_PAGE_CHARS - 1] + "…"
        lines.append(f"page {i}: {text or '(no text — pictures or scans)'}")
    if n > PDF_OUTLINE_PAGES:
        lines.append(f"… ({n - PDF_OUTLINE_PAGES} more pages)")
    return "\n".join(lines)


def edit(src: Path, instruction: str, out: Path | None) -> dict:
    if src.suffix.lower() == ".svg":
        return edit_chart(src, instruction, out)
    import make_edit
    import office_edit
    t0 = time.time()
    kind = office_edit.kind_of(src)
    if kind not in office_edit.INSPECT:
        raise RuntimeError(
            f"{src.suffix} cannot be reworded in place — a PDF has no document model. "
            "A chart CAN go into it: `office edit file.pdf --chart chart.svg --page 2`. "
            "For other changes make it again with `office make pdf` and the changed brief.")
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
    if src.suffix.lower() == ".svg":
        side = src.with_suffix(".chart.json")
        if side.exists():
            return {"ok": True, "kind": "chart", "path": str(src), "outline": summary_of("chart", json.loads(side.read_text()))}
        raise RuntimeError(f"{src.name} is not a chart made here (no {side.name} beside it)")
    import office_edit
    kind = office_edit.kind_of(src)
    if kind == "pdf":
        return {"ok": True, "kind": "pdf", "path": str(src), "outline": pdf_outline(src)}
    if kind not in office_edit.INSPECT:
        raise RuntimeError(f"{src.suffix} has no outline to inspect")
    return {"ok": True, "kind": kind, "path": str(src), "outline": outline_of(src, kind)}


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(prog="office", add_help=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    # The kind is a positional, but a brief that names the format ("a Word
    # document (docx)", "a 4-slide deck") or an --out with an extension says it
    # too — MEASURED, a 4B wrote `office make --brief="…docx…"` and was sent
    # back for a word it had already given.
    m.add_argument("kind", nargs="?", choices=KINDS)
    m.add_argument("--brief", required=True)
    m.add_argument("--out")
    m.add_argument("--slides", type=int)
    e = sub.add_parser("edit")
    e.add_argument("file")
    e.add_argument("--instruction", required=True)
    e.add_argument("--out")
    ap_ = sub.add_parser("apply")
    ap_.add_argument("file")
    ap_.add_argument("--ops", required=True, help="a JSON list of operations, or a path to one")
    ap_.add_argument("--out")
    i = sub.add_parser("inspect")
    i.add_argument("file")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "make":
            brief = a.brief.strip()
            if len(brief) < 12:
                fail("the brief is too short to make anything from — say what the document is "
                     "about and give it the real content: names, numbers, sections.")
            kind = a.kind or infer_kind(brief, a.out)
            if kind is None:
                fail("office make needs a kind: one of " + ", ".join(KINDS) +
                     " — `office make docx --brief …` (or name it in --out: report.docx).")
            emit(make(kind, brief, resolve_out(a.out, kind, brief), a.slides, auto_out=not a.out))
        elif a.cmd == "edit":
            src = Path(a.file).expanduser().resolve()
            if not src.is_file():
                fail(f"no file at {src}")
            emit(edit(src, a.instruction.strip(), Path(a.out).expanduser().resolve() if a.out else None))
        elif a.cmd == "apply":
            src = Path(a.file).expanduser().resolve()
            if not src.is_file():
                fail(f"no file at {src}")
            raw = a.ops
            if not raw.strip().startswith("[") and Path(raw).expanduser().is_file():
                raw = Path(raw).expanduser().read_text()
            ops = json.loads(raw)
            if isinstance(ops, dict):
                ops = ops.get("ops", [])
            emit(apply(src, ops, Path(a.out).expanduser().resolve() if a.out else None))
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
