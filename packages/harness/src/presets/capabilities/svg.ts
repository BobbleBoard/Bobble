/**
 * The `svg` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import type { Capability } from './types.js';

export const svg: Capability = {
  name: 'svg',
  /* MEASURED: with "Make an SVG — a vector drawing …" a 2B model asked for an
     SVG heart typed <svg><circle …/></svg> into `write` — it knows the markup,
     so "make an SVG" read as "write the file". The line has to say that
     hand-writing the markup is the thing NOT to do, or the command is never
     reached for. */
  /* …and the user, after the first run: "if asked to make a website of some sort
     utilize the svgs firsthand instead of writing its own or if asked for
     simple illustrations even without 'svg' mentioned". So the line names
     the cases where the word never comes up — a site's graphics, "a simple
     illustration" — and says where a site's file goes. */
  summary:
    'Draw any icon, logo, symbol or simple flat illustration as an SVG file — a ' +
    'website\'s graphics too, and whether or not "SVG" was said. One call per graphic; ' +
    '--out puts it in the project (assets/logo.svg). Never write SVG markup yourself.',
  guidance:
    'Every graphic goes through this: icons, logos, symbols, pictograms, simple flat ' +
    'illustrations, and the logo and icons of a site or app you are building — whether ' +
    'or not anyone said "SVG". Draw first, then reference the file (<img src>); never ' +
    'write SVG markup by hand. One call per graphic; describe subject, shape and colour ' +
    'plainly, or hand it a reference image to trace. Photos and realistic pictures are ' +
    'not vectors — those are generation.',
  /* One tool, and in CLI mode it IS the command: `svg <prompt> --image <path>`
     (tool-cli.ts maps generate_svg to an empty path under this group). */
  tools: ['generate_svg'],
};
