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
  /* the user (2026-09-24): "svg is a big and versatile thing" — and OmniSVG cannot
     write a word or keep a set consistent (the visual suite's landing page lost
     fifteen minutes to it). The line now splits the work: OmniSVG for organic
     art and tracing; exact graphics are the model's own SVG, checked by
     presenting it (present renders it back). Same length as before. */
  /* 2026-09-25: VFIG joins OmniSVG behind the command — a figure with words to
     SVG code (--figure) and an SVG changed in place (--edit), the two jobs
     OmniSVG cannot do (the SVG bake-off). Eleven words more on the line. */
  summary:
    'Draw an organic illustration, or trace a picture into vectors, as an SVG with OmniSVG ' +
    '(--out puts it in the project); turn a figure into SVG code with its words (--figure), or ' +
    'change an SVG (--edit). Icons, logos with a name, patterns and page glyphs you ' +
    'write as SVG yourself, then present the file to see it.',
  guidance:
    'OmniSVG draws organic, illustrative vector art from a description, or traces a ' +
    'reference image into paths. It cannot write words or keep several drawings ' +
    'consistent. So an icon set, a logo with its name, a badge, a pattern, the glyphs of a ' +
    'page you are building: write those as SVG yourself — icons on a 24-unit viewBox, one ' +
    'stroke width, round caps and joins, currentColor so they take the page colour — and ' +
    'present the file: present shows you the drawing, so fix what looks wrong and present ' +
    'again. VFIG, beside it, rebuilds a FIGURE — a diagram, chart or labelled drawing in a ' +
    'picture — as SVG code whose words are text (`svg --figure --image fig.png`), and changes ' +
    'an SVG that exists (`svg --edit logo.svg "make the flame gold"`). A new diagram (steps, ' +
    'arrows, labels) is diagram; a chart of numbers is chart; a maths or physics figure is math; ' +
    'photos and realistic pictures are generation.',
  /* VQ-10: the guidance (read only when the capability is looked up, so it
     costs no prompt) sends anything with words to the tools that write them —
     the summary above is left as it was, because it rides every prompt. */
  /* One tool, and in CLI mode it IS the command: `svg <prompt> --image <path>`
     (tool-cli.ts maps generate_svg to an empty path under this group). */
  tools: ['generate_svg'],
};
