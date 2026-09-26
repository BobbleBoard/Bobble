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

export const HANDMADE_MATH_NOTE =
  'This is a maths or physics visual made by hand. The math command makes this kind of visual in the ' +
  "app's own style — curves as expressions, sliders with Play, steps tied to the parts of the figure — " +
  'and checks it (labels on labels, parts off the view) before anyone sees it: `math --help`. If it is ' +
  'part of an explanation, make it that way.';
