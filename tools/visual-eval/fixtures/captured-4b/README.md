# REAL 4B captures

What a real Qwen3.5-4B made in the user's app, kept so every renderer change is
judged against the model's actual habits rather than a tidy spec.

- `last_{pptx,docx,pdf,chart}_spec.json`, `raw_plan.txt`, `raw_fill*.txt` — the
  office pipeline's scratch (`~/.cache/bobble/office-gen`, 2026-09-16/21).
- `*.chart.json` (except `last_chart_spec.json`) — the six specs of the
  "demo all your dataviz skills" chat (`~/Bobble/demo-all-your-dataviz-skills`,
  2026-09-17).
- `cookie_docx_spec.json` — the cookie-recipe docx of 2026-09-12, rebuilt block
  by block from the file itself (its spec had been overwritten).
- `briefs.json` — what each spec was answering, and where that brief came from.
  The provenance check (tools/office-gen/provenance.py) holds each document to it.
