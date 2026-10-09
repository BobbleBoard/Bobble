/**
 * AN SVG WRITTEN BY HAND — NOW ONLY A DIAGRAM IS REFUSED.
 *
 * The user (2026-09-24): "I feel like there's something wrong with omnisvg or maybe
 * just how it's used right now also, svg is a big and versatile thing". MEASURED
 * the same night (visual suite, 9B, a ceramics studio's landing page): the page's
 * seven inline icons were refused toward OmniSVG, then its logo four times over,
 * and the turn ended with OmniSVG — which cannot write a word — drawing a logo
 * "with the text Kiln and Co". Most of fifteen minutes went into the fence. An
 * icon set in one consistent stroke, a logo with its name, a pattern, a page's
 * inline glyphs: those are geometry and type, which a model writes well and a
 * drawing model cannot. So the refusal toward `svg` (OmniSVG) is gone — the
 * model writes SVG, and `present` hands it back RENDERED so it can see what it
 * drew and fix it (present-bridge). OmniSVG stays the tool for an organic
 * illustration from a description, or tracing a picture into vectors.
 *
 * What still stands is the DIAGRAM route below: boxes, arrows and labels typed
 * as markup are refused toward `diagram`, which lays out and labels them.
 *
 * (The history, for why the fence was built:)
 */
/*
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
 *
 * A DIAGRAM IS NOT A DRAWING (VQ-10, the research's D30). Boxes, arrows and
 * labels typed as markup were refused TOWARD OmniSVG, which cannot write a
 * word — REAL, asked for "an educational SVG … with equations displayed" it
 * drew an abstract shape and a car. So markup shaped like a diagram (labelled
 * boxes and connectors), or asked for as one, is refused toward `diagram` —
 * Mermaid, laid out and labelled by the app — and that refusal stands whether
 * or not OmniSVG is installed, whether or not the file exists (MEASURED: the
 * 4B ran `svg`, then typed its own flow.svg over the result), and whatever
 * comments the markup carries (the same run's "<!-- Step 1: Order Placed -->"
 * was read as teaching material and let through). Only a sample's name, a
 * question about SVG as a format, or an identical repeat lets it by.
 */

import { mathFigureMarkup } from './handmade-math.js';

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
export function isMarkupTheDeliverable(
  input: {
    path: string;
    content: string;
    request?: string;
  },
  opts: { readonly selfExplaining?: boolean } = {},
): boolean {
  if (SAMPLE_NAME.test(input.path.trim())) return true;
  if (opts.selfExplaining !== false && EXPLAINS_ITSELF.test(input.content)) return true;
  const request = input.request ?? '';
  return /\bsvgs?\b/i.test(request) && MARKUP_REQUEST.test(request);
}

/** Words that ask for a diagram rather than a picture. */
const DIAGRAM_REQUEST =
  /\b(?:diagram|flow ?charts?|flows?|process(?:es)?|workflow|pipeline|sequence|org(?:anisation|anization)? ?chart|hierarchy|mind ?map|state machine|decision tree|swim ?lanes?|architecture|timeline|entity[- ]relationship|erd|uml)\b/i;

const count = (content: string, re: RegExp): number => (content.match(re) ?? []).length;

/*
 * MARKUP THAT MOVES IS NOT A DIAGRAM. MEASURED (4B, the visual suite): asked
 * for "a short animation that shows why the Pythagorean theorem is true by
 * rearranging four triangles", it wrote an SVG of squares, triangles, side
 * labels and four <animate>s — and was refused toward Mermaid, which draws
 * still flowcharts and cannot place a triangle, let alone move one. The turn
 * ended there. The diagram tool makes still diagrams, so an SVG that animates
 * (SMIL or CSS keyframes) is the thing asked for, whatever its shapes count.
 */
const ANIMATES = /<(?:animate|animateTransform|animateMotion|set)[\s/>]|@keyframes\b/i;

/**
 * Is this markup a DIAGRAM — steps in boxes, joined by lines, with words on
 * them — rather than a picture? Labels (three or more <text>), boxes (two or
 * more rects, ellipses, circles or polygons) and connectors (a line, a
 * polyline, an arrowhead marker, or paths joining them); or, when the request
 * asks for a diagram in so many words, two labels with boxes or a connector
 * (two words on one shape is a logo).
 */
export function isDiagramShaped(content: string, request?: string): boolean {
  if (ANIMATES.test(content)) return false;
  const labels = count(content, /<text[\s>]/gi);
  const boxes = count(content, /<(?:rect|ellipse|circle|polygon)[\s/>]/gi);
  const connectors =
    count(content, /<(?:line|polyline)[\s/>]/gi) +
    count(content, /marker-(?:end|start)\s*[=:]/gi) +
    count(content, /<marker[\s>]/gi);
  if (labels >= 3 && boxes >= 2 && connectors >= 1) return true;
  if (labels >= 3 && boxes >= 3 && count(content, /<path[\s/>]/gi) >= 2) return true;
  // Asked for as a diagram: two labels in boxes, or two labels and a connector.
  return labels >= 2 && (boxes >= 2 || connectors >= 1) && DIAGRAM_REQUEST.test(request ?? '');
}

/**
 * Would this `write` produce a hand-made `.svg` that a tool should be
 * drawing — `diagram` for a diagram (when it is registered), `svg` for a
 * picture? `handwrittenSvgRoute` says which.
 */
export function isHandwrittenSvg(input: {
  path: string;
  content: string;
  exists: boolean;
  svgCommandAvailable: boolean;
  /** The `diagram` tool is registered (the app is there to draw it). */
  diagramAvailable?: boolean;
  /** The person's latest message — what they actually asked for. */
  request?: string;
}): boolean {
  return handwrittenSvgRoute(input) !== null;
}

/** Where a hand-made `.svg` should have come from: `math`, `diagram`, `svg`, or nowhere (null: let it through). */
export function handwrittenSvgRoute(input: {
  path: string;
  content: string;
  exists: boolean;
  svgCommandAvailable: boolean;
  diagramAvailable?: boolean;
  mathAvailable?: boolean;
  request?: string;
}): 'math' | 'diagram' | 'svg' | null {
  if (!/\.svg$/i.test(input.path.trim())) return null;
  if (!SVG_OPEN.test(input.content)) return null;
  /* A maths or physics figure before a diagram — MEASURED (the STEM suite,
     4B): a unit circle with "(cos θ, sin θ)" and a tangent, hand-written, was
     refused toward Mermaid ("boxes, arrows and labels"), which cannot draw a
     circle; the model went to image generation next. */
  if (input.mathAvailable === true && mathFigureMarkup(input.content)) {
    return isMarkupTheDeliverable(input, { selfExplaining: false }) ? null : 'math';
  }
  if (input.diagramAvailable === true && isDiagramShaped(input.content, input.request)) {
    return isMarkupTheDeliverable(input, { selfExplaining: false }) ? null : 'diagram';
  }
  // A drawing the model writes is its to write (see the header).
  return null;
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
  diagramAvailable?: boolean;
}): boolean {
  return inlineSvgRoute(input) !== null;
}

/** The inline case's route: a drawn maths figure → `math`, a drawn diagram → `diagram`, a drawn graphic → `svg`. */
export function inlineSvgRoute(input: {
  path: string;
  content: string;
  svgCommandAvailable: boolean;
  diagramAvailable?: boolean;
  mathAvailable?: boolean;
  request?: string;
}): 'math' | 'diagram' | 'svg' | null {
  if (/\.svg$/i.test(input.path.trim())) return null;
  const drawn = [...input.content.matchAll(new RegExp(INLINE_DRAWN_SVG.source, 'gi'))].map(
    (m) => m[0],
  );
  if (drawn.length === 0) return null;
  if (input.mathAvailable === true && drawn.some((d) => mathFigureMarkup(d))) return 'math';
  if (input.diagramAvailable === true && drawn.some((d) => isDiagramShaped(d, input.request))) {
    return 'diagram';
  }
  // A page's own icons and marks are the page's (see the header).
  return null;
}

/**
 * The refusal for a diagram typed as SVG (VQ-10): the structure in Mermaid
 * instead, the call that draws it, and the same way through as the others.
 * `cli` says it as a command line; schemas mode names the tool.
 */
export function handwrittenDiagramRefusal(
  path: string,
  opts: { readonly cli?: boolean; readonly inline?: boolean; readonly edit?: boolean } = {},
): string {
  const out = opts.inline === true ? 'assets/flow.svg' : path;
  const call =
    opts.cli === false
      ? [
          `Call the diagram tool with a title and the Mermaid source (out: "${out}"), e.g.`,
          '  title: "Order fulfilment"',
          '  source: "flowchart TD\\n  A([Order placed]) --> B{Payment ok?}\\n  B -- no --> C[Email customer]\\n  C -. retry .-> B"',
          'If it is not in your tool list, turn it on first: capability "diagram".',
        ]
      : [
          'Run it with the bash tool — one line per connection, a branch is a labelled edge:',
          `  diagram "Order fulfilment" --out ${out} --source 'flowchart TD`,
          '    A([Order placed]) --> B{Payment ok?}',
          '    B -- no --> C[Email customer]',
          "    C -. retry .-> B'",
        ];
  const what =
    opts.inline === true
      ? `${path} has a diagram drawn by hand inline (<svg> boxes, arrows and labels)`
      : `${path} is a diagram drawn by hand — boxes, arrows and labels placed one coordinate at a time`;
  return [
    `Not ${opts.edit === true ? 'edited' : 'written'}: ${what}. Diagrams are what the diagram tool is for: you write the structure in Mermaid and the app lays it out, labels every step and branch, and draws it in the project's design kit. The svg command cannot draw it — it makes pictures, not words.`,
    '',
    ...call,
    '',
    opts.inline === true
      ? `The card appears in the chat; then reference the file in the page: <img src="${out}" alt="…">.`
      : 'The card appears in the chat.',
    '',
    `If this exact markup is truly wanted (a fixture, a sample), ${opts.edit === true ? 'apply the same edit' : 'write the same file'} again UNCHANGED.`,
  ].join('\n');
}

/**
 * A whole spec, small — the shape a refusal hands over AT the refusal.
 * MEASURED (Ling 3.0 Tiny, 2026-10-01): told "`math --help` shows a whole
 * spec", it never ran it; it read the refusal as a bug in the write tool and
 * spent the rest of its window trying to get the same SVG past it. The 4B's
 * lesson (a tool result at the call moves it where a guideline did not) is
 * that the example belongs in the result.
 */
export const MATH_SPEC_SHAPE = [
  '{"title": "…",',
  ' "figure": {"view": {"x": "-2..2", "y": "-1.5..1.5"},',
  '   "shapes": [{"id": "disc", "kind": "circle", "center": [0, 0], "r": 1, "fill": "main-light", "label": "…"},',
  '              {"id": "r", "kind": "segment", "from": [0, 0], "to": [1, 0], "label": "r"}]},',
  ' "steps": [{"text": "… the {disc} …", "highlight": ["disc"]},',
  '           {"text": "… its radius {r} …", "highlight": ["r"]}]}',
].join('\n');

/**
 * The refusal for a maths or physics figure typed as SVG: the math command,
 * and the file that draws it the moment it is written (math-tool.ts).
 */
export function handwrittenMathRefusal(
  path: string,
  opts: { readonly inline?: boolean; readonly edit?: boolean; readonly bash?: boolean } = {},
): string {
  const stem = path.replace(/\.[^./\\]+$/, '').replace(/^.*[\\/]/, '') || 'figure';
  const what =
    opts.inline === true
      ? `${path} has a maths or physics figure drawn by hand inline (<svg> lines, circles and labels)`
      : `${path} is a maths or physics figure drawn by hand — lines, circles and labels placed one coordinate at a time`;
  return [
    `Not ${opts.edit === true ? 'edited' : 'written'}: ${what}. The math command draws it in the app's style: its labels placed so none overlap, the whole checked, and the explanation's steps tied to its parts, with sliders and Play if anything moves.`,
    '',
    `Write the figure as a spec to ${stem}.math.json — it is drawn the moment it is written, and its checks come back. The shape of one, for a figure and two steps (your own shapes, words and numbers go in it):`,
    MATH_SPEC_SHAPE,
    'The shapes are points, segments, vectors, polygons, circles, rects, angles, dimensions, labels, springs and boxes, at x, y coordinates; `math --help` shows the rest (sliders, curves, moving parts).',
    '',
    `If this exact markup is truly wanted (a fixture, a sample), ${opts.edit === true ? 'apply the same edit' : opts.bash === true ? 'run the same command' : 'write the same file'} again UNCHANGED.`,
  ].join('\n');
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
