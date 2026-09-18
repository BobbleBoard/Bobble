/**
 * AN SVG WRITTEN BY HAND WHILE A DRAWING MODEL IS ON.
 *
 * MEASURED, the OmniSVG connector's first real-user run (MiniCPM5 2B, bash-cli):
 * asked for "an SVG icon of a red heart with smooth curved edges", with
 *
 *   svg — Draw an SVG — icon, logo, symbol … never write SVG markup yourself.
 *
 * in its command list, the model thought "Let me create this as an SVG" and
 * typed `<svg><circle …/></svg>` into `write`. Then described the result as a
 * heart. It was a red lens. A model that knows SVG syntax reads "make me an
 * SVG" as "write the file", and one line among nine abilities does not change
 * what it already knows how to do — the prompt was sharpened once and the
 * transcript did not move.
 *
 * So the redirect happens at the moment of the action, where the model's
 * attention actually is: the FIRST write that hand-draws a graphic is refused
 * with the command that draws it. Once per file. If the model writes the same
 * file again it goes through — the markup may genuinely be wanted (a fixture,
 * a three-line chevron, something the drawing model cannot make), and a fence
 * that cannot be crossed is the wrong kind (see silent-write-relocation:
 * refuse and explain, never decide for it).
 *
 * TWO SHAPES OF THE SAME MISTAKE. A `.svg` file of markup is the obvious one.
 * The other is a PAGE: the user — "if asked to make a website of some sort utilize
 * the svgs firsthand instead of writing its own". Asked for a site with a logo
 * and icons, a model writes index.html with the logo hand-drawn INLINE — an
 * `<svg>` with paths in the middle of the markup — and no `.svg` file is ever
 * written, so the first shape never fires. So a page (or component) whose
 * content carries a drawn inline graphic is caught the same way, on `write`
 * and on `edit`.
 *
 * Narrow on purpose: only content that actually DRAWS (an <svg> with a shape
 * element inside — a bare <svg> wrapper or a <use> of a sprite is not a
 * drawing), only a file that does not already exist for the .svg case, and
 * only while the `svg` command is registered — with the connector off there
 * is nothing to point at.
 */

const SVG_OPEN = /<svg[\s>]/i;
/** An <svg> that draws something: at least one shape element inside it. */
const INLINE_DRAWN_SVG =
  /<svg[\s>][\s\S]*?<(?:path|circle|rect|polygon|ellipse|line|polyline)\b[\s\S]*?<\/svg>/i;

/*
 * WHEN THE MARKUP IS THE THING ASKED FOR.
 *
 * SEEN (the user, 2026-09-17): "show me how svg is generally formatted" — the model
 * wrote `sample.svg`, eighty-eight lines opening with `<?xml …?>` and a
 * comment block titled "SVG File Format Examples", and the guard refused it as
 * a hand-drawn graphic. Nothing was drawn; the file WAS the answer, and the
 * person got a red row and a canvas tab for a file that did not exist. The
 * guard exists for "make me an icon of a heart" typed as `<circle>`s; it has
 * no business between a person and the SVG syntax they asked to see. Three
 * signals say the markup is wanted for itself, any one of which lets it pass:
 *
 *   the REQUEST talks about SVG as a format (how it is written, its syntax,
 *   an example of it), not about a picture;
 *   the FILE is named as a sample, a template, a fixture, a placeholder;
 *   the CONTENT explains itself — a comment of a few words, a <title>/<desc>,
 *   a DOCTYPE: teaching material, which a drawing model never emits.
 */
const MARKUP_REQUEST =
  /\b(?:format(?:ted|ting)?|markup|syntax|structure|anatomy|example|sample|template|boilerplate|skeleton|spec(?:ification)?|tutorial|explain|teach|learn|cheat ?sheet|how (?:is|are|does|do|to write|to structure|to format)|xml|source|code)\b/i;
const SAMPLE_WORDS =
  'sample|example|template|demo|test|fixture|format|skeleton|boilerplate|placeholder|tutorial';
const SAMPLE_NAME = new RegExp(
  `(?:${SAMPLE_WORDS})[^/\\\\]*\\.svg$|(?:^|[/\\\\])(?:${SAMPLE_WORDS})s?[/\\\\].*\\.svg$`,
  'i',
);
// `\S+\s+` word by word — no ambiguity for the engine to backtrack through.
const EXPLAINS_ITSELF =
  /<!--\s*(?:(?:(?!-->)\S)+\s+){3,}(?!-->)\S|<(?:title|desc)\b[^>]*>\s*\S|<!DOCTYPE/i;

/** Is this `.svg` wanted as markup — a sample, a lesson, a fixture — rather than as a picture? */
export function isMarkupTheDeliverable(input: {
  path: string;
  content: string;
  request?: string;
}): boolean {
  if (SAMPLE_NAME.test(input.path.trim())) return true;
  if (EXPLAINS_ITSELF.test(input.content)) return true;
  const request = input.request ?? '';
  return /\bsvgs?\b/i.test(request) && MARKUP_REQUEST.test(request);
}

/** Would this `write` produce a hand-made `.svg` that `svg` should be drawing? */
export function isHandwrittenSvg(input: {
  path: string;
  content: string;
  exists: boolean;
  svgCommandAvailable: boolean;
  /** The person's latest message — what they actually asked for. */
  request?: string;
}): boolean {
  if (!input.svgCommandAvailable || input.exists) return false;
  if (!/\.svg$/i.test(input.path.trim())) return false;
  if (!SVG_OPEN.test(input.content)) return false;
  return !isMarkupTheDeliverable(input);
}

/** How many hand-drawn inline graphics a page's markup carries. */
export function countInlineDrawnSvgs(content: string): number {
  const re = new RegExp(INLINE_DRAWN_SVG.source, 'gi');
  let n = 0;
  while (re.exec(content) !== null) n += 1;
  return n;
}

/**
 * Would this `write` (or the new text of an `edit`) put a hand-drawn graphic
 * INLINE in a page or component? The `.svg` case is the other function; this
 * one is for every other file.
 */
export function hasHandwrittenInlineSvg(input: {
  path: string;
  content: string;
  svgCommandAvailable: boolean;
}): boolean {
  if (!input.svgCommandAvailable) return false;
  if (/\.svg$/i.test(input.path.trim())) return false;
  return INLINE_DRAWN_SVG.test(input.content);
}

/**
 * The refusal for a `.svg` file. It names the command, gives the exact call
 * shape, and says how to get the write through anyway — a refusal without an
 * exit is a loop.
 */
export function handwrittenSvgRefusal(path: string): string {
  return [
    `Not written: ${path} is hand-written SVG markup, and drawing SVGs is what the \`svg\` command is for — it runs OmniSVG on-device and produces a real vector drawing, not a guess at one.`,
    '',
    'Run it with the bash tool, describing what to draw, and say where the file goes:',
    `  svg "a red heart with smooth curved edges, centered" --out ${path}`,
    'Add --image <path> to trace a picture. Then use the file it made; tell the user its path.',
    '',
    'If you truly need this exact markup and not a drawing (a fixture, a placeholder), write it again UNCHANGED.',
  ].join('\n');
}

/** The refusal for a page or component with graphics drawn inline. */
export function handwrittenInlineSvgRefusal(path: string, count: number, edit: boolean): string {
  const what = count === 1 ? 'an SVG graphic drawn by hand' : `${count} SVG graphics drawn by hand`;
  return [
    `Not ${edit ? 'edited' : 'written'}: ${path} has ${what} inline (<svg> with paths). Graphics are what the \`svg\` command draws — it runs OmniSVG on-device — so draw each one first and reference the file, rather than inventing the paths:`,
    '',
    '  svg "a coffee cup logo, flat, two colours" --out assets/logo.svg',
    '  svg "a gear icon, single colour, simple" --out assets/gear.svg',
    '',
    `then in the page: <img src="assets/logo.svg" alt="…">. One call per graphic; describe subject, shape and colour. After that, ${edit ? 'make the edit' : 'write the page'} with the <img> references instead of the inline markup.`,
    '',
    `If those inline SVGs are truly wanted as written (a three-line chevron, a divider), ${edit ? 'apply the same edit' : 'write the same file'} again UNCHANGED.`,
  ].join('\n');
}
