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
 * attention actually is: the FIRST write of a fresh `.svg` is refused with the
 * command that draws it. Once. If the model writes the same file again it goes
 * through — the markup may genuinely be wanted (a fixture, a one-line marker,
 * something the drawing model cannot make), and a fence that cannot be crossed
 * is the wrong kind (see silent-write-relocation: refuse and explain, never
 * decide for it).
 *
 * Narrow on purpose: only `write`, only a path ending in .svg, only content that
 * is SVG markup, only when the file does not already exist (rewriting one is
 * editing), and only while the `svg` command is actually registered — with the
 * connector off there is nothing to point at.
 */

const SVG_MARKUP = /<svg[\s>]/i;

/** Would this `write` produce a hand-made SVG that `svg` should be drawing? */
export function isHandwrittenSvg(input: {
  path: string;
  content: string;
  exists: boolean;
  svgCommandAvailable: boolean;
}): boolean {
  if (!input.svgCommandAvailable || input.exists) return false;
  if (!/\.svg$/i.test(input.path.trim())) return false;
  return SVG_MARKUP.test(input.content);
}

/**
 * The refusal. It names the command, gives the exact call shape, and says how
 * to get the write through anyway — a refusal without an exit is a loop.
 */
export function handwrittenSvgRefusal(path: string): string {
  return [
    `Not written: ${path} is hand-written SVG markup, and drawing SVGs is what the \`svg\` command is for — it runs OmniSVG on-device and produces a real vector drawing, not a guess at one.`,
    '',
    'Run it with the bash tool, describing what to draw:',
    '  svg "a red heart with smooth curved edges, centered"',
    'Add --image <path> to trace a picture. The .svg it makes opens on the canvas; tell the user its path.',
    '',
    'If this exact markup is genuinely what is wanted (a fixture, a placeholder), write the same file again and it will go through.',
  ].join('\n');
}
