/**
 * The `office` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import type { Capability } from './types.js';

export const office: Capability = {
  name: 'office',
  /* the user, reading the canvas assessment: "model should not be using
     python-pptx, there is a dedicated subagent for each pptx/docx/xlsx
     creation and editing right?" The pipeline existed and was reachable from
     a corp run only; asked for a deck in chat, the model had bash and a habit
     and looped on `from pptx import Presentation`. So the line says what the
     thing is AND names the habit it replaces — the same finding as the two
     generators above: a line among abilities does not outweigh what a model
     already knows how to type, unless it says so. handmade-office.ts catches
     the rest at the call. */
  summary:
    'Make a real slide deck (.pptx), document (.docx), workbook (.xlsx) or PDF from a brief, and ' +
    'edit or read existing ones. Every deck, report, memo or spreadsheet goes here — never ' +
    'python-pptx, python-docx, openpyxl or hand-written XML, and never `read` on an office file. ' +
    '(A chart on its own is the chart capability.)',
  guidance:
    'office_make takes a brief and returns a NEW file, open in the canvas, with a ' +
    'slide-by-slide summary (a file that exists is changed with office_edit, never re-made). ' +
    'Put EVERYTHING the file should say into the brief — the facts, the ' +
    'numbers, the names, the sections in order — because the pipeline writes only what it is ' +
    'given. office_edit changes wording, style, position or slide order in a file that exists, ' +
    'and puts a chart in it: draw it with chart first, then `office edit file --chart <svg>` ' +
    'with --slide N (pptx), --after <paragraph id> (docx), --anchor B12 (xlsx) or --page N ' +
    '(pdf; free space on that page, else a new page after it). "Reformat to fit" is the same ' +
    'call with an instruction — move/resize/shrink the shapes office_inspect names by id. ' +
    'office_inspect reads a file as an outline with ids. Never write these formats with a ' +
    'library or by assembling XML: the pipeline owns the format so the file opens and stays ' +
    'editable. An open document reloads in the canvas by itself after every edit.',
  tools: ['office_make', 'office_edit', 'office_inspect'],
};
