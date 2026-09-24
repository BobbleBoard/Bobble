/**
 * PALETTE CHECKS — the numbers every chart look has to clear (VQ-03).
 *
 * The visual-quality research ran each of the eleven looks through the
 * data-viz method's palette validator and all eleven failed at least one check;
 * seven could not be told apart by a colour-blind reader (editorial's olive
 * beside its brick red: a deutan ΔE of 3.8, where 8 is the target). Those checks
 * now live here, in the package that owns the looks, so a look that regresses
 * fails a unit test instead of a reader.
 *
 * The method, exactly as the validator computes it — the thresholds are
 * calibrated to these models, so the models are part of the standard:
 *
 *   - ΔE is the Euclidean distance in OKLab, ×100.
 *   - Colour-vision deficiency is simulated with Machado, Oliveira & Fernandes
 *     (2009) at severity 1.0, in linear RGB. Protan and deutan gate; tritan is
 *     reported.
 *   - Neighbouring colours need a CVD ΔE ≥ 8 (6–8 only with a second channel —
 *     direct labels), and ≥ 15 under normal vision (a hard floor: labels do
 *     not excuse two colours a full-colour reader cannot tell apart).
 *   - A mark needs ≥ 3:1 WCAG contrast against the ground it is drawn on.
 *
 * "Neighbouring" is CYCLIC here, stricter than the validator's default: a
 * chart with more series than colours wraps back to the first (`i % n`), and a
 * donut's last slice touches its first, so the last colour always meets the
 * first somewhere.
 *
 * Pure: no DOM, no I/O. The design kit (VQ-04) validates its kits with the same
 * functions.
 */

export type CvdKind = 'protan' | 'deutan' | 'tritan';

/** The gates, as the method states them. */
export const PALETTE_GATES = {
  /** Neighbours under simulated protanopia/deuteranopia: the target… */
  cvdTarget: 8,
  /** …and the floor, legal only with direct labels as a second channel. */
  cvdFloor: 6,
  /** Neighbours under normal vision. Hard: labels do not excuse it. */
  normalFloor: 15,
  /** A mark against its ground (WCAG ratio). */
  markContrast: 3,
} as const;

type Vec3 = readonly [number, number, number];

/** Machado, Oliveira & Fernandes (2009), severity 1.0, linear RGB. */
const MACHADO: Readonly<Record<CvdKind, readonly Vec3[]>> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const HEX6 = /^#?([0-9a-f]{6})$/i;
const HEX3 = /^#?([0-9a-f]{3})$/i;

/** "#abc" / "#AABBCC" / "aabbcc" → "#AABBCC"; anything else throws (a check must never pass on NaN). */
export function normalizeHex(colour: string): string {
  const t = colour.trim();
  const six = HEX6.exec(t);
  if (six?.[1] !== undefined) return `#${six[1].toUpperCase()}`;
  const three = HEX3.exec(t);
  if (three?.[1] !== undefined) {
    const [r, g, b] = three[1].toUpperCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  throw new Error(`not a hex colour: ${JSON.stringify(colour)}`);
}

/** sRGB channels, 0–1. */
export function srgb(colour: string): Vec3 {
  const h = normalizeHex(colour);
  return [
    Number.parseInt(h.slice(1, 3), 16) / 255,
    Number.parseInt(h.slice(3, 5), 16) / 255,
    Number.parseInt(h.slice(5, 7), 16) / 255,
  ];
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number => {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

/** Linear-light RGB, 0–1. */
export function linearRgb(colour: string): Vec3 {
  const [r, g, b] = srgb(colour);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

/** WCAG relative luminance. */
export function relativeLuminance(colour: string): number {
  const [r, g, b] = linearRgb(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function oklabFromLinear([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function linearFromOklab([L, a, b]: Vec3): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLab [L, a, b] of a colour. */
export function oklab(colour: string): Vec3 {
  return oklabFromLinear(linearRgb(colour));
}

/** OKLCH: lightness 0–1, chroma, hue in degrees. */
export function oklch(colour: string): {
  readonly l: number;
  readonly c: number;
  readonly h: number;
} {
  const [l, a, b] = oklab(colour);
  const h = ((((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
  return { l, c: Math.hypot(a, b), h };
}

const hex2 = (v: number): string =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

/** Whether linear RGB is inside the sRGB cube (with a hair of tolerance). */
function inGamut([r, g, b]: Vec3): boolean {
  const e = 1e-6;
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e && b <= 1 + e;
}

/**
 * A colour from OKLCH, brought into sRGB by reducing chroma (never by
 * clipping channels, which shifts the hue): the hue and lightness asked for,
 * with as much of the chroma as the gamut allows.
 */
export function fromOklch(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180;
  let lo = 0;
  let hi = Math.max(0, c);
  const at = (chroma: number): Vec3 =>
    linearFromOklab([l, chroma * Math.cos(rad), chroma * Math.sin(rad)]);
  if (!inGamut(at(hi))) {
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  const [r, g, b] = at(hi);
  return `#${hex2(toGamma(r))}${hex2(toGamma(g))}${hex2(toGamma(b))}`;
}

/** The colour as a reader with this deficiency sees it (linear RGB). */
export function simulateCvd(colour: string, kind: CvdKind): Vec3 {
  const [r, g, b] = linearRgb(colour);
  const M = MACHADO[kind];
  const row = (i: number): number => {
    const m = M[i] as Vec3;
    return Math.max(0, Math.min(1, m[0] * r + m[1] * g + m[2] * b));
  };
  return [row(0), row(1), row(2)];
}

/** ΔE (OKLab ×100) between two colours — unsimulated, or as a CVD reader sees them. */
export function deltaE(a: string, b: string, kind?: CvdKind): number {
  const pa = oklabFromLinear(kind === undefined ? linearRgb(a) : simulateCvd(a, kind));
  const pb = oklabFromLinear(kind === undefined ? linearRgb(b) : simulateCvd(b, kind));
  return 100 * Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
}

/** One pair of colours that meet in a chart, measured. */
export interface PairMeasure {
  readonly a: string;
  readonly b: string;
  /** Where they meet: "series 3 ↔ 4", "highlight ↔ series 1", … */
  readonly where: string;
  readonly normal: number;
  readonly protan: number;
  readonly deutan: number;
  readonly tritan: number;
  /** The gating CVD value: min(protan, deutan). */
  readonly cvd: number;
}

export function measurePair(a: string, b: string, where = ''): PairMeasure {
  const protan = deltaE(a, b, 'protan');
  const deutan = deltaE(a, b, 'deutan');
  return {
    a: normalizeHex(a),
    b: normalizeHex(b),
    where,
    normal: deltaE(a, b),
    protan,
    deutan,
    tritan: deltaE(a, b, 'tritan'),
    cvd: Math.min(protan, deutan),
  };
}

/** Neighbours in order, the last meeting the first (`i % n` wraps; a ring closes). */
export function cyclicPairs<T>(items: readonly T[]): Array<readonly [T, T, number, number]> {
  const n = items.length;
  if (n < 2) return [];
  const out: Array<readonly [T, T, number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    if (n === 2 && i === 1) break; // two colours meet once, not twice
    out.push([items[i] as T, items[j] as T, i, j]);
  }
  return out;
}

export type CvdVerdict = 'pass' | 'floor' | 'fail';

export interface PairsVerdict {
  readonly pairs: readonly PairMeasure[];
  readonly worstCvd: PairMeasure | null;
  readonly worstNormal: PairMeasure | null;
  /** pass ≥ 8, floor 6–8 (legal only with direct labels), fail < 6. */
  readonly cvd: CvdVerdict;
  /** ≥ 15, or not. */
  readonly normal: boolean;
}

export function judgePairs(pairs: readonly PairMeasure[]): PairsVerdict {
  let worstCvd: PairMeasure | null = null;
  let worstNormal: PairMeasure | null = null;
  for (const p of pairs) {
    if (worstCvd === null || p.cvd < worstCvd.cvd) worstCvd = p;
    if (worstNormal === null || p.normal < worstNormal.normal) worstNormal = p;
  }
  const wc = worstCvd?.cvd ?? Number.POSITIVE_INFINITY;
  const wn = worstNormal?.normal ?? Number.POSITIVE_INFINITY;
  return {
    pairs,
    worstCvd,
    worstNormal,
    cvd: wc >= PALETTE_GATES.cvdTarget ? 'pass' : wc >= PALETTE_GATES.cvdFloor ? 'floor' : 'fail',
    normal: wn >= PALETTE_GATES.normalFloor,
  };
}

/** Every mark colour against a ground: those under the 3:1 line. */
export function lowContrast(
  colours: readonly string[],
  ground: string,
): Array<{ readonly colour: string; readonly ratio: number }> {
  return colours
    .map((colour) => ({ colour: normalizeHex(colour), ratio: contrastRatio(colour, ground) }))
    .filter((c) => c.ratio < PALETTE_GATES.markContrast);
}

/**
 * A categorical palette on a ground: its cyclic neighbours and its contrast.
 * The generic check (a brand palette, a kit) — a LOOK has more places where
 * colours meet, see `checkLookPalette`.
 */
export interface PaletteReport extends PairsVerdict {
  readonly ground: string;
  readonly lowContrast: ReadonlyArray<{ readonly colour: string; readonly ratio: number }>;
  /** Every gate passed; a CVD floor counts only when the chart carries direct labels. */
  readonly ok: boolean;
}

export function checkPalette(
  palette: readonly string[],
  ground: string,
  opts: { readonly directLabels?: boolean } = {},
): PaletteReport {
  const pairs = cyclicPairs(palette).map(([a, b, i, j]) =>
    measurePair(a, b, `series ${i + 1} ↔ ${j + 1}`),
  );
  const verdict = judgePairs(pairs);
  const low = lowContrast(palette, ground);
  return {
    ...verdict,
    ground: normalizeHex(ground),
    lowContrast: low,
    ok:
      verdict.normal &&
      low.length === 0 &&
      (verdict.cvd === 'pass' || (verdict.cvd === 'floor' && opts.directLabels === true)),
  };
}

/**
 * Where a look's colours meet in the charts this package draws (svg.ts and the
 * card read the same rules):
 *
 *   - series i beside series i+1, wrapping — grouped bars, stacks, lines, and a
 *     donut's slices with no highlight;
 *   - the highlight (the accent) beside series 1 — a one-series bar chart with
 *     one bar singled out, the commonest highlight there is;
 *   - a donut WITH a highlight draws its other slices from the palette minus
 *     the accent, so that shorter ring meets itself, wrapping, and the accent
 *     slice can sit beside any of its colours;
 *   - a highlighted marker on a line of any series: the accent against every
 *     series colour but its own.
 */
export function lookPairs(palette: readonly string[], accent: string): PairMeasure[] {
  const acc = normalizeHex(accent);
  const pal = palette.map(normalizeHex);
  const out: PairMeasure[] = [];
  for (const [a, b, i, j] of cyclicPairs(pal)) {
    out.push(measurePair(a, b, `series ${i + 1} ↔ ${j + 1}`));
  }
  // The highlighted bar among a one-series chart's bars: ALWAYS measured, so an
  // accent that IS the first colour (a highlight nobody can see) fails at ΔE 0.
  const first = pal[0];
  if (first !== undefined) out.push(measurePair(acc, first, 'highlight ↔ series 1'));
  const shades = pal.filter((c) => c !== acc);
  if (shades.length !== pal.length) {
    // Only when the accent is one of the palette: removing it makes new neighbours.
    for (const [a, b] of cyclicPairs(shades)) {
      const i = pal.indexOf(a);
      const j = pal.indexOf(b);
      if (Math.abs(i - j) === 1 || Math.abs(i - j) === pal.length - 1) continue; // already measured
      out.push(measurePair(a, b, `donut with a highlight: series ${i + 1} ↔ ${j + 1}`));
    }
  }
  for (const c of shades) {
    const i = pal.indexOf(c);
    if (i === 0) continue; // measured above
    out.push(measurePair(acc, c, `highlight ↔ series ${i + 1}`));
  }
  return out;
}
