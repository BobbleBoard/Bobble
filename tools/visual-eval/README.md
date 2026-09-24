# visual-eval — the visual-quality eval harness

One command renders every research prompt and variant, plus the REAL 4B
captures, into contact sheets and a `report.json` — with **no model**, headless,
in well under three minutes (about 40 s on the M5).

    pnpm vq:eval                                  # = node tools/visual-eval/eval.mjs
    node tools/visual-eval/eval.mjs --out /tmp/vq --only pitch-deck,captured
    node tools/visual-eval/eval.mjs --mermaid path/to/mermaid.min.js   # adds the diagram prototype
    VQ_OFFICE_GEN=/path/to/other/tools/office-gen node tools/visual-eval/eval.mjs --out /tmp/before
                                                  # judge another copy of the pipeline, same ruler

## What it needs

- **Python with the office libraries.** The pinned dev venv (never the app's own):

      uv venv --python 3.12 tools/office-gen/.venv
      uv pip install --python tools/office-gen/.venv/bin/python -r tools/office-gen/requirements-dev.txt

  `--python` / `VQ_PYTHON` name another; the app's office venv is the last fallback.
- **macOS QuickLook** (`qlmanage -t`, a command-line thumbnailer) for pptx/docx/pdf.
  Eval-only: the app never depends on it.
- **Playwright's headless Chromium** from the workspace (`pnpm install`).
- Optionally **Mermaid 11** for the `diagram` prototype (`--mermaid` / `VQ_MERMAID`);
  without it that one variant is reported as skipped.

## What comes out (`--out`, default `tools/visual-eval/out/`)

| path | what |
|---|---|
| `report.json` | per artifact: slides/pages, % text under the size floor (14 pt slides, 10 pt documents, 11 px charts, 14 px pages), rendered-text overlaps, text off the canvas, empty regions (≥ 30% of a slide with no text, picture or mark), items dropped against the spec, font families, text contrast and — for charts — the categorical palette check (adjacent ΔE ≥ 15 normal, ≥ 8 under CVD, marks ≥ 3:1). Office cases also carry what `office.py` told the model (`warnings`, `summary`). **Deterministic: run it twice and diff.** |
| `run.json` | timings, the Python used, the focus checks — everything that may differ run to run |
| `sheets/*.png` | one contact sheet per case (checked non-blank: size and pixel variance) |
| `files/`, `renders/` | the artifacts and their per-slide / per-page renders |

The run fails (exit 1) if a case errors, a sheet is blank, or anything it started
took the screen (the frontmost app is read before and between phases).

## How it measures

`py/measure.py` reads the **file**, never the code that wrote it, and its ruler
(`py/fontmetrics.py`) is separate from the renderers' `textfit.py`, so a renderer
change cannot move the measurement. Text geometry is calibrated against
QuickLook: a paragraph at spacing multiple *m* advances 1.2 × size × *m* per line
(measured on Helvetica Neue at 14–58 pt). Contrast and palette arithmetic is in
`py/palette_check.py` (WCAG 2, OKLab, Machado 2009 CVD).

## Layout

- `eval.mjs` — the command; `cases.mjs` — the fixed set.
- `lib/` — Chromium renders (SVG, pages, HyperFrames, HTML measurement, Mermaid) and the chart CLI runner.
- `py/` — the replay stub, `office.py` under replay, QuickLook, measurement, sheets, the HTML→native builder.
- `prompts/` — the prompts; `fixtures/` — canned replies, REAL 4B captures, HTML and chart fixtures.
