/**
 * A MATHS OR PHYSICS VISUAL MADE BY HAND — the math command's job.
 *
 * MEASURED (the STEM suite, qwen3.5-4b, before `math` existed): the
 * kinetic-theory cube hand-drawn as a flat rectangle with "u" on top of
 * "molecule"; simple harmonic motion as three dark-blue cards around an empty
 * graph; "why d/dx sin x = cos x" as eight overlapping text blocks. Each was
 * presented, looked at, and kept. `present` is the moment the model looks at
 * what it made, so that is where it is told the command that makes this kind
 * of visual in the app's style and checks it.
 *
 * A visual (an <svg> or a <canvas>) counts when its visible words are a maths
 * or physics subject — one is enough in an SVG figure, whose words are its
 * labels; a page needs two — or when it loads KaTeX or MathJax. The page the
 * math command made is never flagged — it carries its own markers.
 */
const SUBJECT =
  /\b(harmonic|oscillat\w*|displacement|velocity|acceleration|amplitude|frequency|spring|pendulum|molecules?|momentum|force|pressure|kinetic|potential energy|waves?|derivative|tangent|slope|integral|parabola|quadratic|vertex|equation|theorem|pythagor\w*|hypotenuse|triangle|vectors?|sine|cosine|sin|cos|tan|graph|axis|axes|asymptote|gradient|fourier|probability|projectile|trajectory|circuit|resistor|voltage)\b/gi;

export function handmadeMathVisual(text: string, kind: 'svg' | 'html'): boolean {
  if (!/<svg[\s>]|<canvas[\s>]/i.test(text)) return false;
  // The math command's own page (wherever --out put it) is not hand-made.
  if (/\bdata-mv-panel\b/.test(text)) return false;
  if (/\bkatex\b|\bmathjax\b/i.test(text)) return true;
  const visible = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const hits = new Set((visible.match(SUBJECT) ?? []).map((w) => w.toLowerCase()));
  return hits.size >= (kind === 'svg' ? 1 : 2);
}

/**
 * Surer than {@link handmadeMathVisual}, for a REFUSAL rather than a note: an
 * SVG whose labels name two maths or physics subjects, or one beside a maths
 * mark (θ, π, √, ², Δ…). A logo that says "Force" is not a figure; a unit
 * circle labelled "(cos θ, sin θ)" is.
 */
export function mathFigureMarkup(svg: string): boolean {
  if (!/<svg[\s>]/i.test(svg) || /\bdata-mv-panel\b/.test(svg)) return false;
  const visible = svg
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const hits = new Set((visible.match(SUBJECT) ?? []).map((w) => w.toLowerCase()));
  return hits.size >= 2 || (hits.size === 1 && /[πθωφ∫∑√²³ΔΣ]/.test(visible));
}

/** Mechanics a figure is drawn of — a lever and its weights, a ramp. */
const MECHANICS =
  /\b(lever|pivot|fulcrum|torque|moment|weights?|balance|pulley|ramp|incline|friction|gravity|newton)\b/gi;

/*
 * GEOMETRY. MEASURED (the visual-learner student, Gemma 4 12B, 2026-10-01):
 * after a page on why a circle's area is πr², "how do the slices actually make
 * a rectangle?? … can you show it with an actual picture" went to image
 * generation as "a circle being sliced into hundreds of extremely thin,
 * needle-…" — and not one word of the request or the prompt was a subject
 * here. These are everyday words too (a pizza slice, a living area), which is
 * why every reader of them wants two, and the image check more than that.
 */
const GEOMETRY =
  /\b(circles?|circumference|radius|radii|diameter|area|perimeter|rectangles?|parallelograms?|polygons?|sectors?|wedges?|slic(?:e|es|ed|ing)|arcs?|chords?|angles?|spheres?|cylinders?|cones?|cubes?|volume)\b/gi;

const ANY_SUBJECT = new RegExp(
  [SUBJECT, MECHANICS, GEOMETRY].map((re) => re.source).join('|'),
  'gi',
);

/** One key per idea: "circles" is "circle", "sliced" is "slice", "radii" is "radius". */
function subjectKey(word: string): string {
  const w = word.toLowerCase();
  if (w.startsWith('slic')) return 'slice';
  if (w === 'radii') return 'radius';
  if (w === 'axes') return 'axis';
  return /[^su]s$/.test(w) && !w.endsWith('is') ? w.slice(0, -1) : w;
}

/**
 * The maths and physics subjects a text names (plain text, not markup) — each
 * idea once, as first written, in the order they come.
 */
export function mathSubjects(text: string): string[] {
  const seen = new Map<string, string>();
  for (const w of text.match(ANY_SUBJECT) ?? []) {
    const key = subjectKey(w);
    if (!seen.has(key)) seen.set(key, w);
  }
  return [...seen.values()];
}

/**
 * Words that ask for a maths or physics figure — a lever, forces on a slope, a
 * graph of a function, a circle cut into slices — in a request or a brief
 * (plain text, not markup). Two subjects, the same bar as a hand-drawn SVG.
 */
export function mathFigureWords(text: string): boolean {
  return mathSubjects(text).length >= 2;
}

export const HANDMADE_MATH_NOTE =
  'This is a maths or physics visual made by hand. The math command makes this kind of visual in the ' +
  "app's own style — curves as expressions, sliders with Play, steps tied to the parts of the figure — " +
  'and checks it (labels on labels, parts off the view) before anyone sees it: `math --help`. If it is ' +
  'part of an explanation, make it that way.';
