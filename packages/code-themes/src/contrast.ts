/**
 * WCAG 2.x colour maths: sRGB hex → relative luminance → contrast ratio, with
 * alpha compositing so a translucent value (a `#ffffff0a` wash, a `#7878801f`
 * selection) is judged as the colour it actually paints over its ground.
 *
 * Pure functions, no DOM — this is what the readability tests run, and what
 * the settings screen could run live if it ever needed to.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  a: number;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Is this a hex colour this module understands (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`)? */
export function isHexColor(value: string): boolean {
  return HEX.test(value.trim());
}

/** Parse a hex colour. Throws on anything else — a theme is authored by hand,
 * and a typo should fail a test rather than read as black. */
export function parseHex(value: string): Rgba {
  const v = value.trim();
  if (!HEX.test(v)) throw new Error(`not a hex colour: ${JSON.stringify(value)}`);
  let n = v.slice(1);
  if (n.length === 3 || n.length === 4) n = n.replace(/./g, (c) => c + c);
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  const a = n.length === 8 ? Number.parseInt(n.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

/** `#rrggbb` (alpha dropped — composite first if it matters). */
export function toHex({ r, g, b }: Rgba): string {
  const h = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Paint `fg` over an opaque `bg`; the result is opaque. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/** Composite a hex colour over a hex ground and give back opaque `#rrggbb`. */
export function flatten(fg: string, bg: string): string {
  return toHex(composite(parseHex(fg), parseHex(bg)));
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque colour (alpha is ignored — composite first). */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/**
 * WCAG contrast ratio between a text colour and its ground, 1–21. Translucent
 * text is composited over the ground first; a translucent ground is composited
 * over `under` (white for a light theme, black for a dark one, if the caller
 * does not say).
 */
export function contrastRatio(fg: string, bg: string, under = '#000000'): number {
  const ground = composite(parseHex(bg), parseHex(under));
  const text = composite(parseHex(fg), ground);
  const l1 = relativeLuminance(text);
  const l2 = relativeLuminance(ground);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The product's own definition of purple — the same line
 * `packages/themes/src/no-purple.test.ts` draws: blue clearly leads green, red
 * is also above green, and blue is level with red or ahead of it. A blue (red
 * below green) and a pink (blue well behind red) both fall out, which is the
 * line that matters, because rose is a colour this product uses on purpose.
 */
export function isPurple(hex: string): boolean {
  const { r, g, b } = parseHex(hex);
  return b > g + 20 && r > g && b >= r - 10;
}
