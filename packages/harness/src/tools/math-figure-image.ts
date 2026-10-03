/**
 * A MATHS OR PHYSICS FIGURE ASKED OF THE IMAGE MODEL — the math command's job.
 *
 * MEASURED (the visual-learner student, 2026-10-01, Gemma 4 12B, bash-CLI):
 * after a page on why a circle's area is πr², the student asked "how do the
 * slices actually make a rectangle?? the edges are all curvy. can you show it
 * with an actual picture", and the model ran
 *
 *   media generate image "A high-quality, educational 3D illustration showing
 *   a circle being sliced into hundreds of extremely thin, needle-…"
 *
 * Three minutes later it had a woven disc — a decorative wall hanging: no
 * slices, no rectangle, nothing that moves — which is what an image model makes
 * of a description of a proof. gen-tools refused figure prompts already, but
 * only by their NOTATION (sin x, d/dx, a² + b²), which this one had none of,
 * and the tool cannot read the person's words, which said it plainest. (Qwen
 * 3.8 27B, asked the same, planned an SVG through Python and never finished.)
 *
 * So the call is answered here, in the harness, where the request is known —
 * and answered the way the 4B showed works (moment-of-action): a tool result at
 * the call, not a guideline. It names the math command and hands over a small
 * spec to copy the shape of, one in which a part MOVES — what the student said
 * the first page lacked, and what no picture can do.
 *
 * The refusal can be crossed: the same call again goes through. A poster of a
 * pendulum or a cover for maths notes is a picture, and a fence with no way
 * past it is a loop (see handwritten-svg.ts).
 */

import { mathSubjects } from './handmade-math.js';

/*
 * Notation only a maths or physics figure has — where this check began, in
 * gen-tools. MEASURED there (the STEM suite, 4B): asked why d/dx sin x = cos x
 * "visually", it asked image generation for "a unit circle … Graph with sin(x)
 * in blue and cos(x) in green", waited a minute and a half, and presented a
 * painting with "sos(x)" on its axis and two waves that are neither.
 */
const NOTATION: readonly RegExp[] = [
  /\b(sin|cos|tan|sec|csc|cot|log|ln|sqrt)\s*\(?\s*(x|θ|theta|t|ωt|[a-z]\s*[+)])/i,
  /\bd\s*\/\s*d[xtθ]\b|\bf\s*\(\s*x\s*\)|\by\s*=\s*[-\d(a-z]/i,
  /\b(derivative|integral|unit circle|parabola|asymptote|hypotenuse|pythagorean theorem|free[- ]body|vector diagram|simple harmonic|projectile motion)\b/i,
  /[a-c]\s*[²2]\s*\+\s*[a-c]\s*[²2]|[∫∑√θπ]|\br\s*(?:\^\s*2|²)|\br squared\b/i,
  /* Mechanics: MEASURED (the maths suite, 4B) — "A physics diagram showing a
     seesaw with a small weight far from the pivot…", painted, with its torques
     written wrong on the picture ("20 × 2 = 40", "100 × 0.8 = 80", "balanced"). */
  /\b(torque|fulcrum|pivot|lever|see-?saw|moment arm|pulley|inclined plane|pendulum|physics (?:diagram|figure|illustration))\b/i,
];

/** Words that make a picture a FIGURE — something to learn from: labelled, explained, a proof. */
const TEACHING =
  /\b(graph|plot|axes|axis|diagram|figure|visuali[sz]\w*|label+ed|labels?|annotat\w*|explain\w*|educational|lesson|textbook|worksheet|proof|prove[sn]?|demonstrat\w*|step[- ]by[- ]step|showing (?:how|why|that)|schematic|cross[- ]section|infographic)\b/i;

/** A request that asks how or why — for an explanation, not a picture for its own sake. */
const ASKS_WHY =
  /\b(why|how (?:do|does|did|is|are|was|were|can|could|would|come|to)|explain\w*|understand|makes? sense|prove|proof|deriv\w*)\b/i;

/**
 * Is this picture a maths or physics figure? The subjects it shows when it is,
 * or null for a picture. Any one of:
 *  - its notation, twice over (sin x and d/dx; a² + b² and the theorem's name);
 *  - its notation once, in a prompt that asks for a figure to learn from;
 *  - two subjects in a prompt that asks for a figure to learn from (the
 *    student's: "educational … a circle being sliced");
 *  - two subjects in the prompt, while the person's own message asks how or
 *    why about two of them — the picture is meant to explain.
 * Art that only touches maths (a neon sine-wave poster, Pythagoras in a fresco,
 * a seesaw in a park) is none of these.
 */
export function mathFigureImage(input: {
  readonly prompt: string;
  /** The person's latest message — what they actually asked for. */
  readonly request?: string;
}): { readonly words: readonly string[] } | null {
  const prompt = input.prompt;
  const request = input.request ?? '';
  const notation = NOTATION.filter((re) => re.test(prompt)).length;
  const words = mathSubjects(prompt);
  const teaching = TEACHING.test(prompt);
  const asked = mathSubjects(request).length >= 2 && ASKS_WHY.test(request);
  const figure =
    notation >= 2 || (notation === 1 && teaching) || (words.length >= 2 && (teaching || asked));
  return figure ? { words } : null;
}

/**
 * The spec the refusal hands over — small, and with a part that MOVES, as the
 * slider goes and as the steps play: a picture cannot move, and "the slices
 * never actually move into the rectangle" was the student's word on the page
 * before. math-figure-image.test.ts draws it and holds it to no problems.
 */
export const MATH_MOVING_SPEC = [
  '{"title": "…",',
  ' "params": ["t = 0 in 0..1"],',
  ' "figure": {"view": {"x": "-1.5..4.5", "y": "-1.5..1.5"},',
  '   "shapes": [{"id": "disc", "kind": "circle", "center": [0, 0], "r": 1, "fill": "main-light", "label": "…"},',
  '              {"id": "piece", "kind": "polygon", "points": [[0, 0], [1, 0], [0.7, 0.7]], "fill": "main", "label": "…",',
  '               "slide": {"by": [2.5, 0], "t": "0..1"}}]},',
  ' "steps": [{"text": "… the {disc} …", "highlight": ["disc"], "set": {"t": 0}},',
  '           {"text": "… the {piece} moves …", "highlight": ["piece"], "set": {"t": 1}}]}',
].join('\n');

/** Where the spec goes: beside where the picture was to be saved, else named for what it shows. */
function specStem(saveTo: string | undefined, words: readonly string[]): string {
  const to = (saveTo ?? '').trim();
  // Only a place in the working folder: the spec is drawn where the chat works.
  if (to !== '' && !to.startsWith('/') && !to.startsWith('~')) {
    const base = to.replace(/\/+$/, '');
    if (/\.[a-z0-9]{2,5}$/i.test(base)) return base.replace(/\.[a-z0-9]{2,5}$/i, '');
    if (base !== '') return `${base}/${slugOf(words)}`;
  }
  return slugOf(words);
}

function slugOf(words: readonly string[]): string {
  const slug = words
    .slice(0, 2)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'figure' : slug;
}

/**
 * The answer to a maths figure asked of the image model: why a painting of
 * one fails, the math command, the spec to write, and the way past.
 * `cli` says it as the command line it came as; schemas mode, as the call.
 */
export function mathFigureImageRefusal(input: {
  readonly words: readonly string[];
  /** The picture's save_to, if the call had one — the spec goes beside it. */
  readonly saveTo?: string;
  readonly cli?: boolean;
}): string {
  const named = input.words
    .slice(0, 4)
    .map((w) => `"${w}"`)
    .join(', ');
  const stem = specStem(input.saveTo, input.words);
  return [
    `Not generated: this picture is a maths figure${named === '' ? '' : ` (${named})`}, and an image model only paints a look-alike of one — decorative shapes, misspelt labels, and nothing in it moves. The math command draws the figure itself, from coordinates, in the chat: its labels placed and checked, the explanation's steps tied to its parts, and a slider with Play for anything that moves.`,
    '',
    `Write the figure as a spec to ${stem}.math.json — it is drawn the moment it is written, and its checks come back. A small one with a part that moves (your own shapes, words and numbers go in it):`,
    MATH_MOVING_SPEC,
    'A part moves as its slider goes — "slide" {"by": [dx, dy], "t": "0..1"} carries it, "turn" {"by": 90, "about": [x, y], "t": "0..1"} turns it — and each step\'s "set" plays the move. The shapes are points, segments, vectors, polygons, circles, rects, angles, dimensions, labels, springs and boxes; `math --help` shows the rest.',
    '',
    `If a painted picture is truly what is wanted — a poster, a cover, art rather than a figure to learn from — ${input.cli === false ? 'make the same call' : 'run the same command'} again UNCHANGED.`,
  ].join('\n');
}
