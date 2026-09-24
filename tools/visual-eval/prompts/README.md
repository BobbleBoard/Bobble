# The fixed prompt set

Six realistic requests, one per kind of visual Bobble makes, from the
visual-quality research (`deliverables/research/visual-quality.md` §2.2). The eval
(`../eval.mjs`) renders the research's variants of each **without a model**: the
office pipeline runs against canned replies whose habits are copied from captured
4B output, the chart tool runs on command lines, motion runs the app's own
HyperFrames scene code.

| file | kind | variants in the eval |
|---|---|---|
| `pitch-deck.txt` | `.pptx` | a (4B-style replies), b1 (expert spec), c (design-system HTML → html2pptx) |
| `one-page-report.txt` | `.docx` / `.pdf` | a, a-pdf (same spec through pdf_render), b (expert spec + chart), c (HTML → html2pdf) |
| `flow-diagram.txt` | diagram | a-guard (the hand-written-SVG guard), a3 (office flow slide), b (hand SVG), c (Mermaid prototype) |
| `chart-set.txt` | charts | a (the REAL 4B call shapes), a-office (chart_render.py), a-real (the 2026-09-17 specs), b (used well), parse (D22/D23) |
| `landing-page.txt` | page | a (4B house style), a-real (the two pages the 4B wrote), b (designed) |
| `motion-graphic.txt` | HyperFrames | a (the text prompt), b (an authored scene) |
| `icons.txt` | `svg` (OmniSVG) | none offline — a BENCH run on a quiet Mac |

LIVE runs of these prompts (the real 4B driving the real app) are BENCH jobs
(PLAN.md R13): they load a model. The eval never does.
