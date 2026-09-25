/**
 * WHAT A KIT IS — one design system as data, the shape every consumer reads.
 *
 * The research counted five disconnected style systems in the app — deck
 * THEMES, document palettes, chart looks, chart_render's colours, the
 * HyperFrames navy — plus the model's own habits for pages
 * (deliverables/research/visual-quality.md §4.0 principle 2). A deck, its charts
 * and its title card could not belong together because nothing they read was
 * shared. A kit is that shared thing: colour ROLES for a light and a dark
 * ground, a type scale per medium, a spacing grid, motion timing, an image
 * style, and the knobs a chart and a diagram take from it. One kit per project;
 * variety comes across projects (PLAN.md Q15: "One design kit per project").
 *
 * Roles, not colours: a consumer asks for `ink` or `bad`, never for "#1E1C19",
 * so a kit switch re-dresses everything and a brand can replace one role
 * without knowing who reads it.
 *
 * Pure data and pure checks — no DOM, no I/O. `parseKit` is the SHAPE (a kit
 * file that is not a kit is refused, naming the field); validate.ts is the
 * QUALITY (contrast, colour-blind separation, no purple).
 */

export const KIT_SCHEMA_VERSION = 1;

/** A `#RRGGBB` colour. Six digits, so every reader — TS, Python, CSS — parses it the same way. */
export type Hex = string;

/**
 * The colours of one mode. Every role is a colour a consumer draws WITH; what
 * it may be drawn ON is fixed by validate.ts (ink on paper at 7:1, a series
 * colour on paper at 3:1, …).
 */
export interface KitColours {
  /** The ground a slide, page, card or diagram is drawn on. */
  readonly paper: Hex;
  /** A raised surface on the paper: a card, a node, a table band. */
  readonly surface: Hex;
  /** Body text and strong lines. */
  readonly ink: Hex;
  /** Secondary text: captions, axis labels, edge labels, footers. */
  readonly mute: Hex;
  /** Hairlines: rules, grids, borders, connectors at rest. */
  readonly line: Hex;
  /** THE accent — the brand's one colour: a primary action, a finished step, a title card's words. */
  readonly accent: Hex;
  /** Text set on the accent. */
  readonly onAccent: Hex;
  /** A deep ground for hero slides, title cards and a flow's first step. */
  readonly deep: Hex;
  /** Text set on deep. */
  readonly onDeep: Hex;
  /** A pale field of the accent: a callout, a highlighted row, a group. */
  readonly tint: Hex;
  /** A good change, a success, a path that worked. */
  readonly good: Hex;
  /** A bad change, a failure, an error path. */
  readonly bad: Hex;
  /** Attention short of failure. */
  readonly warn: Hex;
  /** The colour that singles one mark out against the series (a highlighted bar or slice). */
  readonly highlight: Hex;
  /**
   * Categorical colours for charts and diagram groups, first the primary. The
   * highlight may be one of them (never the first), like a chart look's accent.
   */
  readonly series: readonly Hex[];
}

/** One family for each platform — a stack, fastest-available first. */
export interface FontStacks {
  readonly mac: string;
  readonly windows: string;
  readonly linux: string;
}

export type Platform = keyof FontStacks;

export interface KitType {
  /** Titles, big numbers, a title card's words. */
  readonly display: FontStacks;
  /** Body, labels, captions. */
  readonly text: FontStacks;
  readonly mono: FontStacks;
  readonly weights: {
    readonly regular: number;
    readonly medium: number;
    readonly bold: number;
    readonly display: number;
  };
  /** Pixels on a 1280×720 slide (the research's 7-step deck scale, §2.2.1 (c)). */
  readonly slide: {
    readonly caption: number;
    readonly body: number;
    readonly lead: number;
    readonly title: number;
    readonly display: number;
    readonly hero: number;
  };
  /** Pixels on a 1440-wide page. */
  readonly page: {
    readonly caption: number;
    readonly body: number;
    readonly lead: number;
    readonly h2: number;
    readonly h1: number;
  };
  /** Points in a printed document (Butterick: body 10–12 pt). */
  readonly doc: {
    readonly caption: number;
    readonly body: number;
    readonly h2: number;
    readonly h1: number;
    readonly title: number;
  };
  readonly lineHeight: { readonly body: number; readonly heading: number };
  /** Letter spacing in em: display type tighter, short caps labels opened up. */
  readonly tracking: { readonly display: number; readonly caps: number };
}

export interface KitSpace {
  /** The rhythm every gap is a multiple of, px. */
  readonly unit: number;
  /** A slide's or page's outer margin at 1280 px. */
  readonly margin: number;
  readonly gutter: number;
  readonly radius: { readonly small: number; readonly card: number };
  /** A hairline's weight, px. */
  readonly stroke: number;
}

export interface KitMotion {
  /** CSS easing for entrances. */
  readonly ease: string;
  /** Seconds: one entrance, the step between staggered ones, the hold before an exit. */
  readonly enter: number;
  readonly stagger: number;
  readonly hold: number;
}

export interface KitImage {
  /** Words a picture prompt carries for this kit — light, palette, mood. Never text or logos. */
  readonly style: string;
}

/** What a chart takes from the kit besides colours (charts' look-from-kit.ts). */
export interface KitChart {
  /** The chart look whose geometry the kit starts from (a packages/charts LookName). */
  readonly base: string;
  readonly radius: number | 'pill';
  readonly grid: 'lines' | 'dots' | 'none';
  readonly line: 'straight' | 'smooth' | 'step';
  readonly font: 'system' | 'serif' | 'mono' | 'rounded';
}

/** What a diagram takes from the kit besides colours. */
export interface KitDiagram {
  /** clean = drawn lines; sketch = Mermaid's hand-drawn look. */
  readonly look: 'clean' | 'sketch';
  /** Connector shape: basis (soft curves), linear (straight), step (orthogonal). */
  readonly curve: 'basis' | 'linear' | 'step';
  /** Label size, px. */
  readonly fontSize: number;
  /** Node corner radius, px. */
  readonly radius: number;
}

export interface Kit {
  readonly schema: typeof KIT_SCHEMA_VERSION;
  /** Lowercase, hyphenated: what a setting, a brand file or a tool names it by. */
  readonly id: string;
  readonly name: string;
  /** One line: what it suits. */
  readonly about: string;
  readonly light: KitColours;
  readonly dark: KitColours;
  readonly type: KitType;
  readonly space: KitSpace;
  readonly motion: KitMotion;
  readonly image: KitImage;
  readonly chart: KitChart;
  readonly diagram: KitDiagram;
}

export type KitMode = 'light' | 'dark';

/** The colour roles every mode must carry, in the order a sheet lists them. */
export const COLOUR_ROLES = [
  'paper',
  'surface',
  'ink',
  'mute',
  'line',
  'accent',
  'onAccent',
  'deep',
  'onDeep',
  'tint',
  'good',
  'bad',
  'warn',
  'highlight',
] as const satisfies readonly (keyof KitColours)[];

export type ColourRole = (typeof COLOUR_ROLES)[number];

/** A kit that is not one, and exactly where. */
export class KitShapeError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${path}: ${problem}`);
    this.name = 'KitShapeError';
  }
}

const HEX6 = /^#[0-9A-F]{6}$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new KitShapeError(path, 'must be an object');
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new KitShapeError(path, 'must be text');
  return v;
}

function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new KitShapeError(path, `must be a number from ${min} to ${max}`);
  }
  return v;
}

function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) {
    throw new KitShapeError(path, `must be one of ${options.join(', ')}`);
  }
  return v as T;
}

/**
 * A colour as a kit stores it: `#RRGGBB`, upper case. Kit FILES must already
 * be in that form (one spelling per colour, so a diff shows a real change);
 * `normalizeKitHex` is for colours arriving from elsewhere — a brand file, a
 * picture.
 */
function hex(v: unknown, path: string): Hex {
  if (typeof v !== 'string' || !HEX6.test(v)) {
    throw new KitShapeError(path, 'must be a colour written #RRGGBB (upper case)');
  }
  return v;
}

/** "#abc", "#aabbcc", "AABBCC" → "#AABBCC"; anything else → undefined. */
export function normalizeKitHex(v: unknown): Hex | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(t)) return `#${t.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(t)) {
    const [r, g, b] = t.toUpperCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return undefined;
}

function colours(v: unknown, path: string): KitColours {
  const o = obj(v, path);
  const out: Record<string, unknown> = {};
  for (const role of COLOUR_ROLES) out[role] = hex(o[role], `${path}.${role}`);
  if (!Array.isArray(o.series)) throw new KitShapeError(`${path}.series`, 'must be a list');
  if (o.series.length < 5 || o.series.length > 8) {
    throw new KitShapeError(`${path}.series`, 'must hold 5 to 8 colours');
  }
  out.series = o.series.map((c, i) => hex(c, `${path}.series[${i}]`));
  return out as unknown as KitColours;
}

function stacks(v: unknown, path: string): FontStacks {
  const o = obj(v, path);
  return {
    mac: str(o.mac, `${path}.mac`),
    windows: str(o.windows, `${path}.windows`),
    linux: str(o.linux, `${path}.linux`),
  };
}

function sizes<K extends string>(
  v: unknown,
  path: string,
  keys: readonly K[],
  min: number,
  max: number,
): Record<K, number> {
  const o = obj(v, path);
  const out = {} as Record<K, number>;
  let last = 0;
  for (const k of keys) {
    const n = num(o[k], `${path}.${k}`, min, max);
    // A scale that is not a scale — a title smaller than its body — is a typo.
    if (n < last)
      throw new KitShapeError(`${path}.${k}`, `must not be smaller than the step below`);
    last = n;
    out[k] = n;
  }
  return out;
}

/**
 * Read an untrusted value as a Kit, or throw naming the first field that is
 * wrong. Unknown fields are refused too: a misspelt role would otherwise be
 * silently ignored while its reader fell back to the default.
 */
export function parseKit(raw: unknown): Kit {
  const o = obj(raw, 'kit');
  const known = new Set([
    'schema',
    'id',
    'name',
    'about',
    'light',
    'dark',
    'type',
    'space',
    'motion',
    'image',
    'chart',
    'diagram',
  ]);
  for (const k of Object.keys(o)) {
    if (!known.has(k)) throw new KitShapeError(`kit.${k}`, 'is not a kit field');
  }
  if (o.schema !== KIT_SCHEMA_VERSION) {
    throw new KitShapeError('kit.schema', `must be ${KIT_SCHEMA_VERSION}`);
  }
  const id = str(o.id, 'kit.id');
  if (!ID.test(id)) throw new KitShapeError('kit.id', 'must be lowercase words joined by hyphens');
  const type = obj(o.type, 'kit.type');
  const weights = obj(type.weights, 'kit.type.weights');
  const lh = obj(type.lineHeight, 'kit.type.lineHeight');
  const tracking = obj(type.tracking, 'kit.type.tracking');
  const space = obj(o.space, 'kit.space');
  const radius = obj(space.radius, 'kit.space.radius');
  const motion = obj(o.motion, 'kit.motion');
  const image = obj(o.image, 'kit.image');
  const chart = obj(o.chart, 'kit.chart');
  const diagram = obj(o.diagram, 'kit.diagram');
  const chartRadius =
    chart.radius === 'pill' ? 'pill' : num(chart.radius, 'kit.chart.radius', 0, 32);
  return {
    schema: KIT_SCHEMA_VERSION,
    id,
    name: str(o.name, 'kit.name'),
    about: str(o.about, 'kit.about'),
    light: colours(o.light, 'kit.light'),
    dark: colours(o.dark, 'kit.dark'),
    type: {
      display: stacks(type.display, 'kit.type.display'),
      text: stacks(type.text, 'kit.type.text'),
      mono: stacks(type.mono, 'kit.type.mono'),
      weights: {
        regular: num(weights.regular, 'kit.type.weights.regular', 100, 900),
        medium: num(weights.medium, 'kit.type.weights.medium', 100, 900),
        bold: num(weights.bold, 'kit.type.weights.bold', 100, 900),
        display: num(weights.display, 'kit.type.weights.display', 100, 900),
      },
      slide: sizes(
        type.slide,
        'kit.type.slide',
        ['caption', 'body', 'lead', 'title', 'display', 'hero'] as const,
        8,
        240,
      ),
      page: sizes(
        type.page,
        'kit.type.page',
        ['caption', 'body', 'lead', 'h2', 'h1'] as const,
        8,
        160,
      ),
      doc: sizes(
        type.doc,
        'kit.type.doc',
        ['caption', 'body', 'h2', 'h1', 'title'] as const,
        6,
        72,
      ),
      lineHeight: {
        body: num(lh.body, 'kit.type.lineHeight.body', 1, 2),
        heading: num(lh.heading, 'kit.type.lineHeight.heading', 0.8, 1.6),
      },
      tracking: {
        display: num(tracking.display, 'kit.type.tracking.display', -0.1, 0.1),
        caps: num(tracking.caps, 'kit.type.tracking.caps', 0, 0.2),
      },
    },
    space: {
      unit: num(space.unit, 'kit.space.unit', 2, 16),
      margin: num(space.margin, 'kit.space.margin', 16, 160),
      gutter: num(space.gutter, 'kit.space.gutter', 8, 64),
      radius: {
        small: num(radius.small, 'kit.space.radius.small', 0, 32),
        card: num(radius.card, 'kit.space.radius.card', 0, 48),
      },
      stroke: num(space.stroke, 'kit.space.stroke', 0.5, 4),
    },
    motion: {
      ease: str(motion.ease, 'kit.motion.ease'),
      enter: num(motion.enter, 'kit.motion.enter', 0.1, 3),
      stagger: num(motion.stagger, 'kit.motion.stagger', 0, 1),
      hold: num(motion.hold, 'kit.motion.hold', 0, 10),
    },
    image: { style: str(image.style, 'kit.image.style') },
    chart: {
      base: str(chart.base, 'kit.chart.base'),
      radius: chartRadius,
      grid: oneOf(chart.grid, 'kit.chart.grid', ['lines', 'dots', 'none'] as const),
      line: oneOf(chart.line, 'kit.chart.line', ['straight', 'smooth', 'step'] as const),
      font: oneOf(chart.font, 'kit.chart.font', ['system', 'serif', 'mono', 'rounded'] as const),
    },
    diagram: {
      look: oneOf(diagram.look, 'kit.diagram.look', ['clean', 'sketch'] as const),
      curve: oneOf(diagram.curve, 'kit.diagram.curve', ['basis', 'linear', 'step'] as const),
      fontSize: num(diagram.fontSize, 'kit.diagram.fontSize', 10, 28),
      radius: num(diagram.radius, 'kit.diagram.radius', 0, 24),
    },
  };
}

/** The platform this process runs on, as a kit's font stacks key it. */
export function currentPlatform(platform: string = process.platform): Platform {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
}
