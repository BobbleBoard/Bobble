/**
 * A palette read off a picture — "style it like this screenshot / this
 * poster / our brand page". the user: "styling from image etc."
 *
 * Pure over an RGBA buffer (the app decodes the file). Median-cut into a
 * handful of boxes, then the boxes' mean colours ordered by how much of the
 * picture they cover, with the greys set aside: a chart wants the picture's
 * COLOURS, and a screenshot is mostly its white or its charcoal. The
 * dominant near-white or near-black comes back separately as the picture's
 * ground, so a dark dashboard makes a dark chart.
 */

import { hue, lightness } from './style.ts';

export interface ImagePalette {
  /** The picture's colours, most present first (hex). */
  readonly palette: readonly string[];
  /** The most saturated colour that is not the primary — the highlight. */
  readonly accent: string;
  /** The picture's ground when one colour covers most of it and is near white or black. */
  readonly background?: string;
}

interface Box {
  readonly pixels: number[][];
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}

function mean(box: Box): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of box.pixels) {
    r += p[0] as number;
    g += p[1] as number;
    b += p[2] as number;
  }
  const n = Math.max(1, box.pixels.length);
  return [r / n, g / n, b / n];
}

function split(box: Box): [Box, Box] {
  const ranges = [0, 1, 2].map((c) => {
    let lo = 255;
    let hi = 0;
    for (const p of box.pixels) {
      const v = p[c] as number;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  });
  const axis = ranges.indexOf(Math.max(...ranges));
  const sorted = [...box.pixels].sort((a, b) => (a[axis] as number) - (b[axis] as number));
  // Split at the widest GAP along the axis when there is a real one: the
  // median alone never isolates a small cluster (a green dot in a blue block
  // stays a blend of the two), and a chart wants the dot.
  let cut = Math.floor(sorted.length / 2);
  let widest = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i]?.[axis] as number) - (sorted[i - 1]?.[axis] as number);
    if (gap > widest) {
      widest = gap;
      cut = i;
    }
  }
  if (widest < 32) cut = Math.floor(sorted.length / 2);
  return [{ pixels: sorted.slice(0, cut) }, { pixels: sorted.slice(cut) }];
}

/**
 * Read a palette from RGBA pixels. `count` colours at most; transparent and
 * near-grey pixels are set aside first (unless the picture is all grey).
 */
export function paletteFromPixels(rgba: Uint8Array, count = 6): ImagePalette {
  const colourful: number[][] = [];
  const greys: number[][] = [];
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] as number) < 128) continue;
    const r = rgba[i] as number;
    const g = rgba[i + 1] as number;
    const b = rgba[i + 2] as number;
    total += 1;
    // Grey by absolute chroma: a dark charcoal (20,22,28) has a high RELATIVE
    // saturation and is still grey to the eye.
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 22) greys.push([r, g, b]);
    else colourful.push([r, g, b]);
  }
  if (total === 0) return { palette: ['#97A3AD'], accent: '#97A3AD' };
  // The ground: a grey that covers most of the picture and sits near an end.
  let background: string | undefined;
  if (greys.length / total > 0.45) {
    const [r, g, b] = mean({ pixels: greys });
    const y = lightness(toHex(r, g, b));
    if (y > 0.82 || y < 0.25) background = toHex(r, g, b);
  }
  const source =
    colourful.length >= Math.max(24, total * 0.03)
      ? colourful
      : greys.length > 0
        ? greys
        : colourful;
  let boxes: Box[] = [{ pixels: source }];
  while (boxes.length < count * 2) {
    const biggest = boxes.reduce((a, b) => (a.pixels.length > b.pixels.length ? a : b));
    if (biggest.pixels.length < 8) break;
    const [a, b] = split(biggest);
    boxes = boxes
      .filter((x) => x !== biggest)
      .concat(a.pixels.length > 0 ? [a] : [], b.pixels.length > 0 ? [b] : []);
  }
  // Rank by presence, leaning towards the vivid: the muddy mean of an
  // anti-aliased edge (a dark orange-brown between a bar and a black ground)
  // covers pixels but is nobody's colour.
  const score = (colour: [number, number, number], weight: number): number =>
    weight * (0.3 + saturation(...colour)) * (lightness(toHex(...colour)) < 0.1 ? 0.3 : 1);
  const ranked = boxes
    .map((box) => ({ box, colour: mean(box), weight: box.pixels.length }))
    .sort((a, b) => score(b.colour, b.weight) - score(a.colour, a.weight));
  // Merge near-duplicates: two boxes whose means are within a small distance are one colour.
  const picked: { colour: [number, number, number]; weight: number }[] = [];
  const hueOf = (c: [number, number, number]): number => hue(toHex(...c));
  const hueGap = (a: number, b: number): number => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };
  for (const r of ranked) {
    const near = picked.find(
      (p) =>
        Math.abs(p.colour[0] - r.colour[0]) +
          Math.abs(p.colour[1] - r.colour[1]) +
          Math.abs(p.colour[2] - r.colour[2]) <
          75 ||
        // The same hue in another shade — an orange and the brown its edge
        // makes against a dark ground — is one colour, the vivid one.
        (saturation(...p.colour) > 0.25 &&
          saturation(...r.colour) > 0.25 &&
          hueGap(hueOf(p.colour), hueOf(r.colour)) < 12),
    );
    if (near !== undefined) {
      near.weight += r.weight;
      continue;
    }
    picked.push({ colour: r.colour, weight: r.weight });
  }
  picked.sort((a, b) => score(b.colour, b.weight) - score(a.colour, a.weight));
  const palette = picked.slice(0, count).map((p) => toHex(...p.colour));
  const accentPick = picked
    .slice(1, count + 2)
    .sort((a, b) => saturation(...b.colour) - saturation(...a.colour))[0];
  const accent = accentPick !== undefined ? toHex(...accentPick.colour) : (palette[0] ?? '#E8863A');
  return {
    palette: palette.length > 0 ? palette : ['#97A3AD'],
    accent,
    ...(background !== undefined ? { background } : {}),
  };
}

/** Decode a base64 RGBA buffer, as the app's `pixels` reply carries it. */
export function rgbaFromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** The picture's colours, sorted by hue — a palette that reads as a scale rather than a jumble. */
export function sortByHue(colours: readonly string[]): string[] {
  return [...colours].sort((a, b) => hue(a) - hue(b));
}
