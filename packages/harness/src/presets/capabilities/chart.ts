/**
 * The `chart` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import type { Capability } from './types.js';

export const chart: Capability = {
  name: 'chart',
  /* The user (2026-09-16), Claude's inline chart beside Bobble's pipeline
     picture: "we need parity on these datavisuals, it's a common use case
     and very formulaic and doable … not just bar charts, all datavisuals".
     The line names every way the ask arrives — chart, plot, graph,
     visualise, "show me … over the years" — and the habits it replaces,
     because MEASURED on a 4B the same four numbers went to image generation
     once and to the office pipeline once before either was told otherwise. */
  summary:
    'Draw an interactive chart of numbers in the chat — bar, stacked, horizontal bar, line, ' +
    'area, scatter, donut, pie, radar — from the labels and values, in a second, in a look you choose; ' +
    'and change a chart that exists (colour, bar thickness, a second series, a new style, ' +
    'colours from a picture). Every request to chart, plot, graph or visualise data, and every ' +
    'change to a chart, goes here; never image generation, matplotlib or hand-written SVG.',
  guidance:
    'chart takes the type, the title, the labels and the values (several series as "Name: 1, 2; ' +
    'Other: 3, 4"; a unit, a highlight, a source note) and puts the chart in the chat as a card ' +
    'the user can hover, flip to a table, or open larger in the canvas. Put the real numbers in ' +
    '— it draws exactly what it is given. Give it a LOOK that fits the subject and vary between ' +
    'charts: clean (everyday), soft (pastel pills), bold (loud, values on), mono (one hue, ' +
    'rankings), editorial (serif, muted — reports), ocean, forest, sunset, candy (playful), ' +
    'slate (its own dark ground — dashboards), ' +
    'paper (cream, book-like); or set --palette/--accent/--radius/--bars/--grid/--line/--font, ' +
    'or --from_image a picture for its colours. chart_edit changes a chart that exists — ' +
    '--add "Cost: 8, 12, 10, 14" for a second bar per category, --set "2023: 17", --remove, ' +
    '--sort desc, --bars thin, --accent coral, --look …, --from_image — and redraws it in place. ' +
    'Several charts in one answer are fine — one call each. A chart goes INTO a document with ' +
    'office_edit: `office edit deck.pptx --chart units.svg --slide 2` (a native, editable group ' +
    'on the slide), `--after p3` for a .docx paragraph, `--anchor B12` for a .xlsx cell, ' +
    '`--page 2` for a .pdf (it lands in free space on that page, or on a new page after it). ' +
    'Then say in one line what the chart shows; the values are in front of the user already.',
  /* Two tools: in CLI mode `chart` IS the command (tool-cli.ts maps it to an
     empty path under this group) and the other is `chart edit`. */
  tools: ['chart', 'chart_edit'],
};
