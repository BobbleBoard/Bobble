/**
 * How a chart LOOKS — a module of its own, so no two charts need to look alike.
 *
 * the user (2026-09-16), on the first inline charts: "square not rounded looks
 * bad. can it style them on its own? … this can be a lot better and more
 * modular, we CANNOT have 'all charts from bobble look the same generic'."
 *
 * So the look is part of the spec, chosen per chart — by the model (`--look
 * editorial`, `--palette "#…"`, `--radius pill`, `--line smooth`), or by the
 * tool from the title when the model says nothing (`pickLook`: a rotation
 * through the everyday looks, so consecutive charts differ on their own).
 * Every knob is a field a renderer reads; a LOOK is a named bundle of them
 * (palette + geometry + type), and the two renderers (the static SVG, the
 * interactive card) read the same `ResolvedStyle`, so the file on disk and the
 * card in the chat wear the same clothes.
 *
 * Looks come in two families. THEME-FOLLOWING looks (clean, soft, bold, …)
 * bring a palette and a shape and take ink, grid and ground from wherever they
 * are drawn — a light chat, a dark chat, white paper. FIXED-GROUND looks
 * (slate, terminal, paper) bring their own ground and ink and wear them
 * anywhere: a slate chart in a light chat is a dark card, on purpose.
 *
 * No purple anywhere in the presets — the user's design brief for the app.
 */

export type LookName =
  | 'clean'
  | 'soft'
  | 'bold'
  | 'mono'
  | 'editorial'
  | 'ocean'
  | 'forest'
  | 'sunset'
  | 'candy'
  | 'slate'
  | 'terminal'
  | 'paper';

export type GridMode = 'lines' | 'dots' | 'none';
export type LineStyle = 'straight' | 'smooth' | 'step';
export type MarkerStyle = 'ring' | 'dot' | 'none';
export type AreaFill = 'flat' | 'gradient' | 'none';
export type FontChoice = 'system' | 'serif' | 'mono' | 'rounded';
export type ValueLabelMode = 'auto' | 'on' | 'off';

/** The style as written in a spec — every field optional, a look underneath. */
export interface ChartStyle {
  readonly look?: LookName;
  /** Series colours, first is the primary; overrides the look's palette. */
  readonly palette?: readonly string[];
  /** The highlight colour. */
  readonly accent?: string;
  /** Bar corner radius in px, or 'pill' (fully rounded), or 0 for square. */
  readonly radius?: number | 'pill';
  /** Bar width as a fraction of its band (0.2–0.95). */
  readonly barWidth?: number;
  readonly grid?: GridMode;
  readonly line?: LineStyle;
  readonly markers?: MarkerStyle;
  readonly area?: AreaFill;
  readonly font?: FontChoice;
  /** Values written on bars/points: on, off, or auto (the larger view only). */
  readonly labels?: ValueLabelMode;
  /** Donut ring thickness as a fraction of the radius (0.2–0.6). */
  readonly ring?: number;
  /** A ground of the chart's own (paper colour); implies an ink. */
  readonly background?: string;
  readonly ink?: string;
}

/** A named look: a full set of defaults. */
export interface Look {
  readonly name: LookName;
  /** One line for the guide — when it fits. */
  readonly about: string;
  readonly palette: readonly string[];
  readonly accent: string;
  readonly radius: number | 'pill';
  readonly barWidth: number;
  readonly grid: GridMode;
  readonly line: LineStyle;
  readonly markers: MarkerStyle;
  readonly area: AreaFill;
  readonly font: FontChoice;
  readonly labels: ValueLabelMode;
  readonly titleWeight: number;
  readonly strokeWidth: number;
  readonly ring: number;
  /** A ground of its own (fixed-ground looks); absent = follows the theme. */
  readonly ground?: Ground;
}

export interface Ground {
  readonly paper: string;
  readonly ink: string;
  readonly mute: string;
  readonly grid: string;
}

export const LIGHT_GROUND: Ground = {
  paper: '#FFFFFF',
  ink: '#1D1D1F',
  mute: '#6E6E73',
  grid: '#E6E6EA',
};

export const DARK_GROUND: Ground = {
  paper: '#1B1B1F',
  ink: '#F2F2F5',
  mute: '#9A9AA3',
  grid: '#2E2E35',
};

export const FONT_STACKS: Readonly<Record<FontChoice, string>> = {
  system: "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif",
  mono: "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  rounded:
    "'SF Pro Rounded', ui-rounded, 'Nunito', 'Avenir Next Rounded', -apple-system, sans-serif",
};

const look = (l: Look): Look => l;

export const LOOKS: readonly Look[] = [
  look({
    name: 'clean',
    about: 'the everyday one — the app blue, a thin grid, gently rounded bars',
    palette: ['#2F6FE4', '#E8863A', '#3FB3AC', '#D9B44A', '#9AC05F', '#97A3AD'],
    accent: '#E8863A',
    radius: 6,
    barWidth: 0.62,
    grid: 'lines',
    line: 'straight',
    markers: 'ring',
    area: 'flat',
    font: 'system',
    labels: 'auto',
    titleWeight: 600,
    strokeWidth: 2.5,
    ring: 0.36,
  }),
  look({
    name: 'soft',
    about: 'pastel pills, a dotted grid, smooth lines — friendly, low contrast',
    palette: ['#7FB3F5', '#F5B48A', '#8FD3C9', '#F2D98A', '#B9D98A', '#C9B8A8'],
    accent: '#F08C5A',
    radius: 'pill',
    barWidth: 0.5,
    grid: 'dots',
    line: 'smooth',
    markers: 'dot',
    area: 'gradient',
    font: 'rounded',
    labels: 'auto',
    titleWeight: 600,
    strokeWidth: 3,
    ring: 0.42,
  }),
  look({
    name: 'bold',
    about: 'saturated colours, no grid, values on every bar, a heavy title — for a headline number',
    palette: ['#1F5EFF', '#FF6A3D', '#00B894', '#FFC400', '#FF3D7F', '#00A8E8'],
    accent: '#FF6A3D',
    radius: 10,
    barWidth: 0.7,
    grid: 'none',
    line: 'straight',
    markers: 'dot',
    area: 'flat',
    font: 'system',
    labels: 'on',
    titleWeight: 800,
    strokeWidth: 3.5,
    ring: 0.5,
  }),
  look({
    name: 'mono',
    about: 'one hue in tints with a single warm accent — for rankings and one-series bars',
    palette: ['#1D4ED8', '#3B82F6', '#60A5FA', '#93C5FD', '#BFDBFE', '#DBEAFE'],
    accent: '#F59E0B',
    radius: 3,
    barWidth: 0.66,
    grid: 'lines',
    line: 'straight',
    markers: 'ring',
    area: 'flat',
    font: 'system',
    labels: 'auto',
    titleWeight: 600,
    strokeWidth: 2.5,
    ring: 0.34,
  }),
  look({
    name: 'editorial',
    about:
      'serif titles, a muted navy/terracotta/olive palette, hairline grid — reports, the press',
    palette: ['#1F3A5F', '#C0504D', '#6B8E23', '#D4A017', '#4E7D96', '#8C8C8C'],
    accent: '#C0504D',
    radius: 2,
    barWidth: 0.56,
    grid: 'lines',
    line: 'straight',
    markers: 'ring',
    area: 'flat',
    font: 'serif',
    labels: 'off',
    titleWeight: 600,
    strokeWidth: 2,
    ring: 0.3,
  }),
  look({
    name: 'ocean',
    about: 'deep blues to teal with a sand accent, smooth lines and a gradient under them',
    palette: ['#0B6E99', '#1BA3C6', '#5CC8D7', '#9EDCE0', '#F2B134', '#2C4A63'],
    accent: '#F2B134',
    radius: 8,
    barWidth: 0.6,
    grid: 'dots',
    line: 'smooth',
    markers: 'dot',
    area: 'gradient',
    font: 'system',
    labels: 'auto',
    titleWeight: 600,
    strokeWidth: 3,
    ring: 0.4,
  }),
  look({
    name: 'forest',
    about: 'greens and bark with a copper accent — nature, sustainability, growth',
    palette: ['#2F6B3A', '#5FA05C', '#9BC97A', '#D6C98A', '#B8722C', '#6F7F6A'],
    accent: '#B8722C',
    radius: 6,
    barWidth: 0.6,
    grid: 'lines',
    line: 'straight',
    markers: 'ring',
    area: 'flat',
    font: 'system',
    labels: 'auto',
    titleWeight: 600,
    strokeWidth: 2.5,
    ring: 0.36,
  }),
  look({
    name: 'sunset',
    about: 'coral to amber to rose, pill bars, no grid — warm and loud',
    palette: ['#F0563C', '#F5883D', '#F7B547', '#E56C8A', '#C25C6E', '#3B3A57'],
    accent: '#F7B547',
    radius: 'pill',
    barWidth: 0.6,
    grid: 'none',
    line: 'smooth',
    markers: 'dot',
    area: 'gradient',
    font: 'system',
    labels: 'auto',
    titleWeight: 700,
    strokeWidth: 3,
    ring: 0.44,
  }),
  look({
    name: 'candy',
    about: 'pink, tangerine, mint, sky — pill bars, rounded type, values on — playful',
    palette: ['#FF5C8A', '#FFB84C', '#4CD4B0', '#5CB8FF', '#C8E45C', '#FF8F5C'],
    accent: '#FF5C8A',
    radius: 'pill',
    barWidth: 0.55,
    grid: 'dots',
    line: 'smooth',
    markers: 'dot',
    area: 'gradient',
    font: 'rounded',
    labels: 'on',
    titleWeight: 700,
    strokeWidth: 3,
    ring: 0.46,
  }),
  look({
    name: 'slate',
    about: 'its own charcoal ground with bright cyan/lime/amber — a dashboard tile, in any theme',
    palette: ['#4CC9F0', '#B5E48C', '#FFB703', '#F4978E', '#8ECAE6', '#A8DADC'],
    accent: '#FFB703',
    radius: 4,
    barWidth: 0.62,
    grid: 'lines',
    line: 'straight',
    markers: 'dot',
    area: 'gradient',
    font: 'system',
    labels: 'auto',
    titleWeight: 600,
    strokeWidth: 2.5,
    ring: 0.38,
    ground: { paper: '#1C1F26', ink: '#E6E8EE', mute: '#9AA3B2', grid: '#2C313C' },
  }),
  look({
    name: 'terminal',
    about:
      'black ground, phosphor green and amber, monospace, square bars — for anything engineering',
    palette: ['#39FF14', '#FFB000', '#00E5FF', '#FF5C5C', '#C8FF6E', '#8AA5FF'],
    accent: '#FFB000',
    radius: 0,
    barWidth: 0.7,
    grid: 'dots',
    line: 'step',
    markers: 'none',
    area: 'flat',
    font: 'mono',
    labels: 'on',
    titleWeight: 700,
    strokeWidth: 2,
    ring: 0.5,
    ground: { paper: '#0B0F0A', ink: '#B7F5A1', mute: '#6E9B62', grid: '#1E2A1B' },
  }),
  look({
    name: 'paper',
    about: 'cream ground, ink lines, serif — a chart from a book',
    palette: ['#2B4C7E', '#C0504D', '#5B8C5A', '#D9A441', '#7A6C5D', '#4E8FA6'],
    accent: '#C0504D',
    radius: 2,
    barWidth: 0.52,
    grid: 'lines',
    line: 'straight',
    markers: 'ring',
    area: 'flat',
    font: 'serif',
    labels: 'off',
    titleWeight: 600,
    strokeWidth: 2,
    ring: 0.3,
    ground: { paper: '#FBF6EA', ink: '#2B2A26', mute: '#7B776C', grid: '#E6DFCF' },
  }),
];

export const LOOK_NAMES: readonly LookName[] = LOOKS.map((l) => l.name);

/** The looks a chart may be given when nobody asked for one: the theme-following family. */
export const EVERYDAY_LOOKS: readonly LookName[] = [
  'clean',
  'soft',
  'bold',
  'editorial',
  'ocean',
  'forest',
  'sunset',
  'mono',
];

export function lookByName(name: string | undefined): Look | undefined {
  if (name === undefined) return undefined;
  const key = name.trim().toLowerCase();
  return LOOKS.find((l) => l.name === key);
}

/**
 * The look for a chart that named none: a rotation seeded by the title, so
 * "Units Sold by Year" and "Market share" in one conversation come out
 * differently, and the same chart made twice comes out the same.
 */
export function pickLook(seed: string): LookName {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const idx = (h >>> 0) % EVERYDAY_LOOKS.length;
  return EVERYDAY_LOOKS[idx] ?? 'clean';
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function hex(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (HEX.test(t)) return t.length === 4 ? `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}` : t;
  const named = NAMED_COLOURS[t.toLowerCase()];
  return named;
}

/** A few colour words a model reaches for; everything else is a hex. */
const NAMED_COLOURS: Readonly<Record<string, string>> = {
  blue: '#2F6FE4',
  navy: '#1F3A5F',
  teal: '#3FB3AC',
  green: '#5FA05C',
  lime: '#9AC05F',
  yellow: '#F2C94C',
  amber: '#F59E0B',
  orange: '#E8863A',
  coral: '#F0563C',
  red: '#D64545',
  pink: '#FF5C8A',
  rose: '#E56C8A',
  brown: '#8C6A4A',
  copper: '#B8722C',
  grey: '#97A3AD',
  gray: '#97A3AD',
  slate: '#4E5D6C',
  black: '#1D1D1F',
  white: '#FFFFFF',
  cream: '#FBF6EA',
};

function paletteOf(v: unknown): string[] | undefined {
  const list = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(/[,;\s]+/).filter((s) => s !== '')
      : [];
  const out = list.map(hex).filter((c): c is string => c !== undefined);
  return out.length > 0 ? out : undefined;
}

function oneOf<T extends string>(v: unknown, options: readonly T[]): T | undefined {
  if (typeof v !== 'string') return undefined;
  const key = v.trim().toLowerCase();
  return options.find((o) => o === key);
}

/**
 * Read a style from whatever was written: a `style` object, or the same keys
 * flat on the spec (`look`, `palette`, `accent`, `radius`, …). Unknown values
 * are dropped, never thrown — a typo in a colour is not a reason to have no
 * chart.
 */
export function normalizeStyle(input: Record<string, unknown>): ChartStyle | undefined {
  const nested =
    input.style !== null && typeof input.style === 'object'
      ? (input.style as Record<string, unknown>)
      : {};
  const get = (key: string): unknown => nested[key] ?? input[key];
  const out: {
    -readonly [K in keyof ChartStyle]: ChartStyle[K];
  } = {};
  const lookName = oneOf(get('look') ?? get('theme') ?? get('preset'), LOOK_NAMES);
  if (lookName !== undefined) out.look = lookName;
  const palette = paletteOf(get('palette') ?? get('colors') ?? get('colours'));
  if (palette !== undefined) out.palette = palette;
  const accent = hex(get('accent') ?? get('highlight_color') ?? get('highlightColor'));
  if (accent !== undefined) out.accent = accent;
  const radiusRaw = get('radius') ?? get('corner_radius') ?? get('cornerRadius') ?? get('corners');
  if (typeof radiusRaw === 'number' && Number.isFinite(radiusRaw)) {
    out.radius = Math.max(0, Math.min(64, radiusRaw));
  } else if (typeof radiusRaw === 'string') {
    const key = radiusRaw.trim().toLowerCase();
    if (key === 'pill' || key === 'round' || key === 'rounded' || key === 'full')
      out.radius = 'pill';
    else if (key === 'square' || key === 'none' || key === 'sharp') out.radius = 0;
    else if (/^\d+(?:\.\d+)?$/.test(key)) out.radius = Math.max(0, Math.min(64, Number(key)));
  }
  const bw = get('barWidth') ?? get('bar_width') ?? get('bars');
  const bwNum = typeof bw === 'number' ? bw : typeof bw === 'string' ? Number(bw) : Number.NaN;
  if (Number.isFinite(bwNum)) {
    out.barWidth = Math.max(0.2, Math.min(0.95, bwNum > 1 ? bwNum / 100 : bwNum));
  } else if (typeof bw === 'string') {
    const key = bw.trim().toLowerCase();
    if (key === 'thin' || key === 'narrow') out.barWidth = 0.4;
    else if (key === 'wide' || key === 'thick' || key === 'fat') out.barWidth = 0.8;
  }
  const grid = oneOf(get('grid') ?? get('gridlines'), [
    'lines',
    'dots',
    'none',
    'off',
    'on',
  ] as const);
  if (grid !== undefined) out.grid = grid === 'off' ? 'none' : grid === 'on' ? 'lines' : grid;
  const line = oneOf(get('line') ?? get('curve') ?? get('lineStyle') ?? get('line_style'), [
    'straight',
    'smooth',
    'step',
    'curved',
    'linear',
  ] as const);
  if (line !== undefined)
    out.line = line === 'curved' ? 'smooth' : line === 'linear' ? 'straight' : line;
  const markers = oneOf(get('markers') ?? get('points'), [
    'ring',
    'dot',
    'none',
    'off',
    'on',
  ] as const);
  if (markers !== undefined) {
    out.markers = markers === 'off' ? 'none' : markers === 'on' ? 'dot' : markers;
  }
  const area = oneOf(get('area') ?? get('fill'), ['flat', 'gradient', 'none'] as const);
  if (area !== undefined) out.area = area;
  const font = oneOf(get('font') ?? get('typeface'), [
    'system',
    'serif',
    'mono',
    'rounded',
  ] as const);
  if (font !== undefined) out.font = font;
  const labelsRaw = get('labels') ?? get('value_labels') ?? get('valueLabels');
  if (labelsRaw === true) out.labels = 'on';
  else if (labelsRaw === false) out.labels = 'off';
  else {
    const labels = oneOf(labelsRaw, ['auto', 'on', 'off', 'show', 'hide'] as const);
    if (labels !== undefined) {
      out.labels = labels === 'show' ? 'on' : labels === 'hide' ? 'off' : labels;
    }
  }
  const ring = get('ring') ?? get('thickness');
  const ringNum =
    typeof ring === 'number' ? ring : typeof ring === 'string' ? Number(ring) : Number.NaN;
  if (Number.isFinite(ringNum))
    out.ring = Math.max(0.2, Math.min(0.6, ringNum > 1 ? ringNum / 100 : ringNum));
  const background = hex(get('background') ?? get('paper') ?? get('ground'));
  if (background !== undefined) out.background = background;
  const ink = hex(get('ink') ?? get('text_color') ?? get('textColor'));
  if (ink !== undefined) out.ink = ink;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Everything a renderer needs, with nothing left to decide. */
export interface ResolvedStyle {
  readonly look: LookName;
  readonly palette: readonly string[];
  readonly accent: string;
  readonly radius: number | 'pill';
  readonly barWidth: number;
  readonly grid: GridMode;
  readonly line: LineStyle;
  readonly markers: MarkerStyle;
  readonly area: AreaFill;
  readonly font: FontChoice;
  readonly fontFamily: string;
  readonly labels: ValueLabelMode;
  readonly titleWeight: number;
  readonly strokeWidth: number;
  readonly ring: number;
  /** The ground when the chart brings its own (a fixed-ground look, or an explicit background). */
  readonly ground: Ground | null;
}

/** Perceived lightness of a hex colour, 0–1 (sRGB, rough). */
export function lightness(hexColour: string): number {
  const h = hex(hexColour) ?? '#000000';
  const r = Number.parseInt(h.slice(1, 3), 16) / 255;
  const g = Number.parseInt(h.slice(3, 5), 16) / 255;
  const b = Number.parseInt(h.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A ground for an explicit background colour: ink chosen for contrast. */
function groundFor(paper: string, ink?: string): Ground {
  const dark = lightness(paper) < 0.45;
  return {
    paper,
    ink: ink ?? (dark ? '#F2F2F5' : '#1D1D1F'),
    mute: dark ? '#A0A3AD' : '#6E6E73',
    grid: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.09)',
  };
}

/**
 * The style of a spec, with the look's defaults under the spec's own fields.
 * `fallback` is the look used when the spec names none — callers that want
 * variety pass `pickLook(title)`; a renderer that just needs *a* look passes
 * nothing and gets `clean`.
 */
export function resolveStyle(
  style: ChartStyle | undefined,
  fallback: LookName = 'clean',
  opts: { readonly theme?: 'light' | 'dark' } = {},
): ResolvedStyle {
  const base = lookByName(style?.look) ?? lookByName(fallback) ?? (LOOKS[0] as Look);
  const font = style?.font ?? base.font;
  const ground =
    style?.background !== undefined
      ? groundFor(style.background, style.ink)
      : style?.ink !== undefined && base.ground !== undefined
        ? { ...base.ground, ink: style.ink }
        : (base.ground ?? null);
  const rawPalette =
    style?.palette !== undefined && style.palette.length > 0 ? style.palette : base.palette;
  // A theme-following look on a dark ground: its darkest inks (editorial's
  // navy) would sink into the charcoal — lifted just enough to read.
  const onDark = ground === null ? opts.theme === 'dark' : lightness(ground.paper) < 0.45;
  const palette = onDark ? rawPalette.map(liftForDark) : rawPalette;
  return {
    look: base.name,
    palette,
    accent: onDark ? liftForDark(style?.accent ?? base.accent) : (style?.accent ?? base.accent),
    radius: style?.radius ?? base.radius,
    barWidth: style?.barWidth ?? base.barWidth,
    grid: style?.grid ?? base.grid,
    line: style?.line ?? base.line,
    markers: style?.markers ?? base.markers,
    area: style?.area ?? base.area,
    font,
    fontFamily: FONT_STACKS[font],
    labels: style?.labels ?? base.labels,
    titleWeight: base.titleWeight,
    strokeWidth: base.strokeWidth,
    ring: style?.ring ?? base.ring,
    ground,
  };
}

/** A colour too dark for a dark ground, mixed towards white until it reads (others untouched). */
export function liftForDark(colour: string): string {
  const h = hex(colour);
  if (h === undefined) return colour;
  const y = lightness(h);
  if (y >= 0.3) return h;
  const t = Math.min(0.5, (0.3 - y) * 1.6 + 0.12);
  const c = (i: number): number => Number.parseInt(h.slice(i, i + 2), 16);
  const mix = (v: number): string =>
    Math.round(v + (255 - v) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(c(1))}${mix(c(3))}${mix(c(5))}`.toUpperCase();
}

/** The corner radius for a bar of this size: 'pill' is as round as the bar allows. */
export function barRadius(radius: number | 'pill', w: number, h: number): number {
  const cap = Math.max(0, Math.min(w, h) / 2);
  return radius === 'pill' ? cap : Math.max(0, Math.min(radius, cap));
}

const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * A bar with rounded corners on the side that faces away from the axis —
 * the top of a positive bar, the bottom of a negative one, the right end of
 * a horizontal bar. A rect with `rx` rounds all four and reads as a lozenge
 * sitting on the axis; a real bar grows out of it.
 */
export function roundedBarPath(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  side: 'top' | 'bottom' | 'right' | 'left',
): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r === 0) return `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}Z`;
  switch (side) {
    case 'top':
      return `M${f(x)} ${f(y + h)}V${f(y + r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(-r)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}V${f(y + h)}Z`;
    case 'bottom':
      return `M${f(x)} ${f(y)}V${f(y + h - r)}a${f(r)} ${f(r)} 0 0 0 ${f(r)} ${f(r)}h${f(w - 2 * r)}a${f(r)} ${f(r)} 0 0 0 ${f(r)} ${f(-r)}V${f(y)}Z`;
    case 'right':
      return `M${f(x)} ${f(y)}H${f(x + w - r)}a${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(r)}v${f(h - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-r)} ${f(r)}H${f(x)}Z`;
    default:
      return `M${f(x + w)} ${f(y)}H${f(x + r)}a${f(r)} ${f(r)} 0 0 0 ${f(-r)} ${f(r)}v${f(h - 2 * r)}a${f(r)} ${f(r)} 0 0 0 ${f(r)} ${f(r)}H${f(x + w)}Z`;
  }
}

export interface XY {
  readonly x: number;
  readonly y: number;
}

/**
 * The path through a series of points in the chosen line style. `smooth` is
 * a monotone cubic (Fritsch–Carlson): a curve that never overshoots a point,
 * so a smooth line still tells the truth at every marker.
 */
export function linePath(points: readonly XY[], style: LineStyle): string {
  if (points.length === 0) return '';
  const p0 = points[0] as XY;
  if (points.length === 1) return `M${f(p0.x)} ${f(p0.y)}`;
  if (style === 'straight') {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p.x)} ${f(p.y)}`).join(' ');
  }
  if (style === 'step') {
    const parts = [`M${f(p0.x)} ${f(p0.y)}`];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1] as XY;
      const b = points[i] as XY;
      const mx = (a.x + b.x) / 2;
      parts.push(`H${f(mx)}`, `V${f(b.y)}`, `H${f(b.x)}`);
    }
    return parts.join(' ');
  }
  // Monotone cubic interpolation.
  const n = points.length;
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i] as XY;
    const b = points[i + 1] as XY;
    dx.push(b.x - a.x);
    dy.push(b.y - a.y);
    m.push(dx[i] === 0 ? 0 : (dy[i] as number) / (dx[i] as number));
  }
  const t: number[] = [m[0] as number];
  for (let i = 1; i < n - 1; i += 1) {
    const a = m[i - 1] as number;
    const b = m[i] as number;
    t.push(a * b <= 0 ? 0 : (a + b) / 2);
  }
  t.push(m[n - 2] as number);
  for (let i = 0; i < n - 1; i += 1) {
    const mi = m[i] as number;
    if (mi === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = (t[i] as number) / mi;
    const b = (t[i + 1] as number) / mi;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * mi;
      t[i + 1] = tau * b * mi;
    }
  }
  const parts = [`M${f(p0.x)} ${f(p0.y)}`];
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i] as XY;
    const b = points[i + 1] as XY;
    const h = (dx[i] as number) / 3;
    parts.push(
      `C${f(a.x + h)} ${f(a.y + h * (t[i] as number))} ${f(b.x - h)} ${f(b.y - h * (t[i + 1] as number))} ${f(b.x)} ${f(b.y)}`,
    );
  }
  return parts.join(' ');
}

/** The area under a line path, closed along the baseline. */
export function areaPath(points: readonly XY[], style: LineStyle, baseline: number): string {
  if (points.length === 0) return '';
  const first = points[0] as XY;
  const last = points[points.length - 1] as XY;
  return `${linePath(points, style)} L${f(last.x)} ${f(baseline)} L${f(first.x)} ${f(baseline)} Z`;
}

/** The hue of a hex colour in degrees, for the no-purple check. */
export function hue(hexColour: string): number {
  const h = hex(hexColour) ?? '#000000';
  const r = Number.parseInt(h.slice(1, 3), 16) / 255;
  const g = Number.parseInt(h.slice(3, 5), 16) / 255;
  const b = Number.parseInt(h.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let deg: number;
  if (max === r) deg = ((g - b) / d) % 6;
  else if (max === g) deg = (b - r) / d + 2;
  else deg = (r - g) / d + 4;
  deg *= 60;
  return deg < 0 ? deg + 360 : deg;
}
