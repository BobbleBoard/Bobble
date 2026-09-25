# office-gen — the renderers behind the `document` specialist

208 KB of Python that turns a **JSON spec** into a designed `.pptx` / `.docx` /
`.xlsx` / `.pdf`, and edits existing ones.

## Why this exists at all

A small model cannot hand-write OOXML or a `.tscn`, and it does not stop trying
just because it is bad at it. Two corp runs died on exactly that: the model
invented `project.godot` and `.tscn` from memory and could not repair either.
The same failure was waiting for every office format.

So the division here is the one that works everywhere else in this project:
**the model writes the words and picks the design; deterministic code owns every
byte of the file format.** The model emits a small JSON object — block types,
prose, two hex colours — and never sees a zip archive or an XML namespace.

## The entry points

    python3 office.py make   <kind> --brief "…" | --brief-file f --out <path>   # the app's: model plans, code draws
    python3 office.py render <kind> --spec spec.json --out <path>               # a spec drawn exactly — NO model
    python3 office.py edit | apply | inspect <file> …
    python3 make_doc.py  <docx|xlsx|pdf> "<prompt>"    # generate a spec, then render
    python3 make_deck.py "<prompt>"                    # the same for a slide deck
    python3 make_edit.py <file> "<instruction>"        # edit an EXISTING file
    python3 office_edit.py inspect <file>              # outline with stable ids
    python3 office_edit.py apply <file> <ops.json> <out>

`make` and `make_*` need a local OpenAI-compatible server (default
`127.0.0.1:8099`); `render`, the renderers and `office_edit.py` need nothing
but Python. `render` is the only path whose spec may carry `sources` and `[S3]`
citation markers (tests/fixtures/render has one spec per kind).

## What each piece owns

| file | owns |
| --- | --- |
| `palette.py` | the model's two chosen colours → a full palette, with WCAG contrast enforced |
| `numparse.py` | numbers, booleans and text as a model writes them: `22M`, `$38k`, `3,100`, `"false"`, a unit-only display |
| `provenance.py` | what a spec says that its brief did not — every number, quote, URL and attribution checked against the brief (or simple arithmetic on it) before render; invented source lines stripped, the rest flagged in `warnings`; descriptive kickers dropped; the brief's parts no slide carries named |
| `textfit.py` | real font metrics (PIL against the Mac's own TTFs; everywhere else the bundled metric-compatible OFL set in `fonts/`, sources in `fonts/SOURCES.txt`) — python-pptx/docx have none |
| `render_deck.py`, `doc_render.py`, `sheet_render.py`, `pdf_render.py` | spec → file, one per format |
| `citations.py` | the render path's sources and `[S3]` markers: numbered once, drawn as linked superscripts (docx), "Sources: 3, 7" lines (pptx), cite cells (xlsx), "[3]" (pdf); a marker naming no source is dropped and reported, never given an entry |
| `viz.py` | charts drawn as native shapes rather than chart-library defaults |
| `html2pptx.py`, `html2docx.py`, `html2pdf.py` | HTML/CSS/SVG → NATIVE editable shapes (gradients, shadows, bezier paths) — never a screenshot |
| `office_edit.py` | inspect/apply for existing files; a bad id FAILS LOUDLY rather than being skipped |

## The rule for anyone using these

Never hand-write the file format. If something is missing, add it to the
renderer — that is a change one person makes once, instead of a mistake every
agent makes forever.

## Tests

    uv venv --python 3.12 tools/office-gen/.venv
    uv pip install --python tools/office-gen/.venv/bin/python -r tools/office-gen/requirements-dev.txt
    tools/office-gen/.venv/bin/python -m pytest tools/office-gen/tests -q

The regression tests judge the renderers on the REAL 4B captures and the
visual-quality research's replays (`tools/visual-eval/fixtures`), measuring the
written file with the eval's own ruler. `pnpm vq:eval` renders all of it into
contact sheets.
