---
name: data-visuals
description: Draw and change charts of data with Bobble's `chart` and `chart_edit` tools — bar, stacked, horizontal bar, line, area, scatter, donut — each with a look that fits its subject, never a generic default. Use whenever the user wants numbers charted, plotted, graphed or visualised, or asks to change a chart (colours, bar thickness, another series, a style, "make it look like this picture").
license: MIT (© 2026 Pi Desktop contributors)
---

# Data visuals

A chart in Bobble is one call: the numbers go in, an interactive card comes
out in the chat (hover reads a value, chart ⇄ table toggle, Open in canvas),
and the same drawing lands in the project as an `.svg` with its spec beside it.
Never image generation, matplotlib, a hand-written SVG or a whole deck for one
chart.

```
chart bar "Units Sold by Year" --labels "2021, 2022, 2023, 2024" --values "12, 19, 15, 22" --unit units --look editorial
chart line "Revenue vs Cost" --labels "Q1, Q2, Q3, Q4" --values "Revenue: 4.2, 5.1, 6.4, 7.0; Cost: 3.1, 3.4, 3.9, 4.2" --unit "$" --look ocean
chart donut "Market share" --labels "Acme, Globex, Others" --values "38, 27, 35" --unit % --highlight Acme --look soft
chart edit units-sold-by-year.svg --add "Cost: 8, 12, 10, 14" --bars thin --accent coral
```

## Choose the chart from the question

- **bar** — values by category or period, up to ~12; the default.
- **hbar** — a ranking, or long names; add `--sort desc` on an edit.
- **stacked** — parts of each total (channels of revenue by quarter).
- **line** — a trend over many points, or several series over time.
- **area** — the same, when the volume under the line is the point.
- **scatter** — two measures per item (x/y).
- **donut** — shares of one whole, few slices; `--unit %` when the values are shares.

Several series only when the user compares things. One `--highlight` when
they single something out. A `--unit` whenever the values have one.

## Give every chart a look — and make them differ

The look is chosen per chart; a conversation with three charts should not
show three of the same. Match the subject, then vary:

| look | what it is | reach for it when |
|---|---|---|
| clean | the app blue, thin grid, gently rounded bars | anything plain, ops, product |
| soft | pastel pills, dotted grid, smooth lines | friendly, consumer, low-stakes |
| bold | saturated, no grid, values on every bar, heavy title | one headline number, a pitch |
| mono | one hue in tints, a warm accent | a ranking, a single series |
| editorial | serif, navy/terracotta/olive, hairline grid | reports, finance, the press |
| ocean | blues to teal, sand accent, smooth lines, gradient | water, shipping, cool subjects |
| forest | greens and bark, copper accent | nature, sustainability, growth |
| sunset | coral to amber to rose, pill bars, no grid | warm, loud, marketing |
| candy | pink, tangerine, mint, sky; rounded type; values on | playful, kids, games |
| slate | its own charcoal ground, cyan/lime/amber | dashboards, monitoring, any theme |
| terminal | black ground, phosphor green, monospace, square bars | engineering, latency, builds |
| paper | cream ground, ink lines, serif | a chart from a book, history |

Knobs on top of any look, or on their own: `--palette "#264653, #2a9d8f, #e9c46a"`
(or names: navy, coral, teal…), `--accent coral`, `--radius pill|0|8`,
`--bars thin|wide|0.4`, `--grid lines|dots|none`, `--line straight|smooth|step`,
`--font system|serif|mono|rounded`, `--value_labels on|off`, `--background #102030`
(a ground of its own), `--style '{"markers":"dot","area":"gradient","ring":0.4}'`.

`--from_image path.png` reads the colours off a picture — a screenshot of the
user's dashboard, a poster, a brand page — into the palette (and its ground
when the picture has one). Use it when the user points at an image.

Leave the look out only when nothing about the subject suggests one: a look is
then picked from the title so charts still vary.

## Changing a chart

Every change is `chart_edit` on the file the chart tool reported — never a
second `chart` with everything retyped:

- another series to compare: `--add "Cost: 8, 12, 10, 14"` (one value per category)
- one value: `--set "2023: 17"`, a second series' value: `--set "Cost/2023: 9"`
- drop a series or a category: `--remove Cost`
- rename: `--rename "Cost: Costs"`; reorder: `--sort desc`
- the words: `--title`, `--subtitle`, `--unit`, `--note`, `--highlight 2024|none`
- the kind: `--type hbar`
- the look: any knob above, `--look sunset`, `--from_image shot.png`

The chart is redrawn in place and shown again.

## After the chart

One sentence: what it shows — the peak, the trend, the share. The values are on
the card; do not list them, do not describe the chart or the file.
