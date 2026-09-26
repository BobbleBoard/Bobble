/**
 * THE MATH VISUAL, AS A MODEL WRITES IT.
 *
 * the user (2026-09-25), on a 4B's hand-written Fourier page: "really low quality
 * and generally bad feeling … emojis absolutely not, wall of text mixed with
 * bullets neither with reference to what the visual / interactiveness is, not
 * tied in … likely ideal to make a specialized extension for math stuffs like
 * we have for dataviz". So the model writes WHAT to show — curves as
 * expressions, a figure's shapes, sliders — and the explanation as steps that
 * each point at part of it; this package decides how it looks, and checks it
 * before anyone sees it.
 *
 * One set of sliders drives everything: a curve is an expression in the plot's
 * variable and the sliders; a point, a shape's corner, a label's number may be
 * an expression in the sliders. So a slider with a Play button moves the mass
 * on the spring AND the dot on its x(t) graph — the animation is the maths.
 *
 * Forgiving on the way in (the chart spec's lesson): numbers may be expressions
 * ("-pi", "2pi"), a point may be [x, y] or {x, y}, a curve may be a bare
 * string, a step may be a bare string, snake_case is read. Colours are ROLES,
 * never hex: a model cannot pick an unreadable one.
 */
import { compile, ExprError, fromLatex, numberOf, parse } from './expr.js';

export type Role = 'main' | 'second' | 'third' | 'reference' | 'highlight';
/**
 * How a closed shape is filled: a role's colour solid (an object — a mass, a
 * triangle being moved), the same colour pale (an area — a², the region under
 * a curve), the page's tint or shade, or nothing.
 */
export type Fill =
  | 'none'
  | 'tint'
  | 'main'
  | 'second'
  | 'third'
  | 'shade'
  | 'main-light'
  | 'second-light'
  | 'third-light';
/** A number, or an expression in the sliders ("A*cos(w*t)"). */
export type Num = number | string;
export type Xy = readonly [Num, Num];

export interface Param {
  readonly name: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  /** A name the spec used without declaring it: a value, not a slider on the page. */
  readonly hidden?: boolean;
}

/** What every drawn thing carries: its id, and the step it first appears at (1 = from the start). */
interface Item {
  readonly id: string;
  readonly appear: number;
}

export interface Curve extends Item {
  /** y as an expression in the plot's variable; or, parametric, x and y in `t` over `t`'s range. */
  readonly expr?: string;
  readonly px?: string;
  readonly py?: string;
  readonly t?: readonly [Num, Num];
  readonly label?: string;
  readonly role: Role;
  readonly dashed: boolean;
}

export interface PlotPoint extends Item {
  readonly x: Num;
  /** Its height; with none, the point sits on curve `on` at its x. */
  readonly y?: Num;
  readonly on?: string;
  readonly label?: string;
  readonly role: Role;
}

/** Shading between a curve and the axis, from one x to another. */
export interface Area extends Item {
  readonly under: string;
  readonly from: Num;
  readonly to: Num;
  readonly label?: string;
  readonly role: Role;
}

/** The tangent to a curve at an x — its slope worked out numerically. */
export interface Tangent extends Item {
  readonly to: string;
  readonly at: Num;
  readonly label?: string;
  readonly role: Role;
}

/** n rectangles under a curve: the sum an integral is the limit of. */
export interface Riemann extends Item {
  readonly under: string;
  readonly from: Num;
  readonly to: Num;
  readonly n: Num;
  readonly rule: 'left' | 'mid' | 'right';
  readonly role: Role;
}

export interface PlotSpec {
  /** The plot's own variable — `x` unless the model named another. */
  readonly v: string;
  readonly x: {
    readonly min: number;
    readonly max: number;
    readonly label?: string;
    readonly pi: boolean;
  };
  readonly y: { readonly min?: number; readonly max?: number; readonly label?: string };
  readonly curves: readonly Curve[];
  readonly points: readonly PlotPoint[];
  readonly areas: readonly Area[];
  readonly tangents: readonly Tangent[];
  readonly riemann: readonly Riemann[];
}

export type Anchor = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export type Shape = Item & {
  /** 0 … 1, a number or an expression of the sliders: a part that fades as a slider moves. */
  readonly opacity?: Num;
} & (
    | {
        readonly kind: 'point';
        readonly at: Xy;
        readonly label?: string;
        readonly place?: Anchor;
        readonly role: Role;
      }
    | {
        readonly kind: 'segment' | 'vector';
        readonly from: Xy;
        readonly to: Xy;
        readonly label?: string;
        readonly dashed: boolean;
        readonly role: Role;
      }
    | {
        readonly kind: 'polygon';
        readonly points: readonly Xy[];
        readonly fill: Fill;
        readonly label?: string;
        readonly dashed: boolean;
      }
    | {
        readonly kind: 'circle';
        readonly center: Xy;
        readonly r: Num;
        readonly fill: Fill;
        readonly label?: string;
        readonly role: Role;
      }
    | {
        readonly kind: 'angle';
        readonly at: Xy;
        readonly from: Xy;
        readonly to: Xy;
        readonly label?: string;
        readonly right: boolean;
      }
    | {
        readonly kind: 'dimension';
        readonly from: Xy;
        readonly to: Xy;
        readonly label: string;
        readonly offset: number;
      }
    | { readonly kind: 'label'; readonly at: Xy; readonly text: string }
    | {
        readonly kind: 'box3d';
        /** The front face's lower-left corner. */
        readonly at: Xy;
        /** Width and height of the front face; depth recedes up and to the right. */
        readonly w: Num;
        readonly h: Num;
        readonly depth: Num;
        readonly shade: 'right' | 'top' | 'front' | 'none';
        /** Measures along the front-bottom, front-right and receding edges. */
        readonly labels: { readonly w?: string; readonly h?: string; readonly d?: string };
      }
    | {
        readonly kind: 'spring';
        readonly from: Xy;
        readonly to: Xy;
        readonly coils: number;
        readonly label?: string;
      }
    | {
        /** A curve drawn from a formula: x and y in `over`, as it runs `from` → `to` (each may use the sliders — "0..t" is the path so far). */
        readonly kind: 'curve';
        readonly x: string;
        readonly y: string;
        readonly over: string;
        readonly from: Num;
        readonly to: Num;
        readonly label?: string;
        readonly dashed: boolean;
        readonly role: Role;
      }
    | {
        readonly kind: 'polyline';
        readonly points: readonly Xy[];
        readonly label?: string;
        readonly dashed: boolean;
        readonly role: Role;
        /** Drawn as a smooth curve through the points (a trajectory), not straight pieces. */
        readonly smooth: boolean;
      }
  );

export interface FigureSpec {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  /** The axes the spec gave no readable range for: renderMath fits them to the shapes. */
  readonly fit?: readonly ('x' | 'y')[];
  /** Solid areas that are ground to the rest, drawn in their pale tint (renderMath fills this in). */
  readonly ground?: readonly string[];
  readonly shapes: readonly Shape[];
}

export interface Step {
  readonly text: string;
  /** Ids drawn at full strength while this step is read; the rest step back. */
  readonly highlight: readonly string[];
  /** Slider values this step moves to (animated). */
  readonly set: Readonly<Record<string, Num>>;
  /**
   * Sliders this step wiggles, by how much, once it has moved: the value goes
   * up and down around where it is while the parts that depend on it follow —
   * cause and effect, shown (the user: "little nudges of different movements and
   * how they affect other things").
   */
  readonly nudge?: Readonly<Record<string, Num>>;
}

export interface MathSpec {
  readonly title: string;
  readonly caption?: string;
  readonly params: readonly Param[];
  readonly plot?: PlotSpec;
  readonly figure?: FigureSpec;
  readonly steps: readonly Step[];
  /** The slider the Play button runs, if any. */
  readonly play?: string;
  /** Names used with no value among declared ones — drawn as 1, and a check to fix. */
  readonly unvalued?: readonly string[];
  /**
   * The explanation plays itself when the page opens — each step's words
   * appearing as the figure moves — and then hands the reader the controls.
   * False: the page opens still, at step 1.
   */
  readonly tell: boolean;
  /** Notes about what was read differently than written ("emoji removed …"). */
  readonly notes: readonly string[];
}

/** A problem with what was written, said so the next call can fix it. */
export class SpecError extends Error {}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== ''
    ? v.trim()
    : typeof v === 'number'
      ? String(v)
      : undefined;
/** A field under any of its names, camelCase or snake_case. */
function get(o: Loose, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = o[key] ?? o[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Names the spec used without declaring, drawn as 1 — for the numbers that are
 * not expressions of the sliders (a view's range "0..L"). Set for the length of
 * one normalization.
 */
let CONSTANTS: Readonly<Record<string, number>> = {};
/** The sliders of the spec being read — a shape's slide/turn/scale runs over one of them. */
let SLIDERS: readonly Param[] = [];

function num(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const known = Object.keys(CONSTANTS);
      if (known.length > 0) {
        const r = compile(v, known)(CONSTANTS);
        if (!Number.isFinite(r)) throw new ExprError(`"${v}" is not a finite number`);
        return r;
      }
      return numberOf(v);
    } catch (e) {
      throw new SpecError(`${what}: ${e instanceof ExprError ? e.message : String(e)}`);
    }
  }
  throw new SpecError(`${what} needs a number`);
}

/** A number or an expression over the sliders — checked now, evaluated when drawn. */
function numOrExpr(v: unknown, what: string, names: readonly string[]): Num {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = str(v);
  if (s === undefined) throw new SpecError(`${what} needs a number or an expression`);
  try {
    parse(s, names);
  } catch (e) {
    const msg = e instanceof ExprError ? e.message : String(e);
    // A name it does not know is most often a slider it forgot to declare.
    const unknown = /^"([A-Za-z_]\w*)" at \d+ is not a variable here/.exec(msg)?.[1];
    const hint =
      unknown === undefined
        ? ''
        : ` — if ${unknown} is something to vary, add it to "params" as "${unknown} = 1 in 0..5"`;
    throw new SpecError(`${what} "${s}": ${msg}${hint}`);
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
}

/** "-pi..pi", "0 to 10", [a, b] or {min, max}. */
function range(v: unknown, what: string): { min: number; max: number; pi: boolean } {
  let a: unknown;
  let b: unknown;
  if (Array.isArray(v) && v.length === 2) [a, b] = v;
  else if (isObj(v)) [a, b] = [v.min ?? v.from, v.max ?? v.to];
  else if (typeof v === 'string') [a, b] = v.split(/\s*(?:\.\.\.?|\bto\b|,)\s*/);
  else throw new SpecError(`${what} needs a range like "-pi..pi" or [0, 10]`);
  /* "0..t" — a range that uses a slider (MEASURED: the 4B's projectile, a plot
     over time drawn "0..t"). A range holds still, so a slider in it is read at
     its far end: the whole motion fits. */
  const atEnds = (x: unknown, w: string): number => {
    try {
      return num(x, w);
    } catch (e) {
      const slid = SLIDERS.filter((p) => p.hidden !== true);
      if (typeof x !== 'string' || slid.length === 0) throw e;
      const scope = { ...CONSTANTS, ...Object.fromEntries(slid.map((p) => [p.name, p.max])) };
      const r = compile(x, Object.keys(scope))(scope);
      if (!Number.isFinite(r)) throw e;
      return r;
    }
  };
  const min = atEnds(a, `${what} min`);
  const max = atEnds(b, `${what} max`);
  if (!(max > min)) throw new SpecError(`${what}: its max (${max}) must be above its min (${min})`);
  return { min, max, pi: /pi|π/i.test(`${String(a)} ${String(b)}`) };
}

/** TeX commands a model types into a label, as the characters they draw. */
const TEX_LABEL: Readonly<Record<string, string>> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  omega: 'ω',
  Delta: 'Δ',
  Omega: 'Ω',
  Sigma: 'Σ',
  Theta: 'Θ',
  Phi: 'Φ',
  cdot: '·',
  times: '×',
  pm: '±',
  le: '≤',
  ge: '≥',
  leq: '≤',
  geq: '≥',
  neq: '≠',
  approx: '≈',
  infty: '∞',
  circ: '°',
  degree: '°',
  to: '→',
  rightarrow: '→',
};

/**
 * A figure's label is plain text with light TeX (x^2, v_0) — MEASURED (the
 * 4B): "$h(t)$" and "$x(t)$" drawn with their dollar signs. The delimiters go,
 * and the commands a model types become their characters; a {name} that
 * fills in a value is left alone.
 */
export function texLabel(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (!/[$\\]/.test(s)) return s;
  return s
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^{}]*)\}/g, '√$1')
    .replace(/\\(?:vec|mathbf|mathrm|text|textbf|operatorname)\{([^{}]*)\}/g, '$1')
    .replace(/\\([A-Za-z]+)/g, (_m, name: string) => TEX_LABEL[name] ?? name)
    .replace(/\$/g, '')
    .replace(/\\,|\\;|\\!|\\ /g, ' ')
    .trim();
}

const ROLES: readonly Role[] = ['main', 'second', 'third', 'reference', 'highlight'];
function role(v: unknown, fallback: Role): Role {
  const s = str(v)?.toLowerCase();
  if (s === undefined) return fallback;
  if ((ROLES as readonly string[]).includes(s)) return s as Role;
  if (/target|ideal|exact|limit|reference|compare|guide|grey|gray/.test(s)) return 'reference';
  if (/accent|primary|first/.test(s)) return 'main';
  if (/secondary|other/.test(s)) return 'second';
  if (/emph|attention|focus/.test(s)) return 'highlight';
  return fallback;
}
function fill(v: unknown): Fill {
  const s = str(v)?.toLowerCase().trim();
  if (s === undefined || s === 'false' || s === 'none') return 'none';
  if (['tint', 'main', 'second', 'third', 'shade'].includes(s)) return s as Fill;
  // "main-light", "light main", "pale second", "second soft" — the role's colour, pale.
  const role = /\b(main|second|third)\b/.exec(s)?.[1];
  if (role !== undefined && /light|pale|soft/.test(s)) return `${role}-light` as Fill;
  if (/grey|gray|shade|dark/.test(s)) return 'shade';
  return 'tint';
}
const appearOf = (v: Loose): number => {
  const a = get(v, 'appear', 'step', 'fromStep', 'showAt');
  return a === undefined ? 1 : Math.max(1, Math.round(num(a, 'appear')));
};

/** A slider: {name, min, max, value}, or "n = 5 in 1..25". */
/** A value the page uses but does not slide: "a = 3", {name: "g", value: 9.8}. */
function constant(name: string, value: number): Param {
  return { name, label: name, min: value, max: value, step: 1, value, hidden: true };
}

function param(v: unknown, i: number): Param {
  if (typeof v === 'string') {
    const m = /^\s*([a-zA-Z_]\w*)\s*=\s*(\S+)\s+(?:in|from|over)\s+(.+)$/.exec(v);
    if (m === null) {
      // "a = 3" — a value, not a slider (MEASURED: the 4B's "a=3", "b=4", "c=5").
      const k = /^\s*([a-zA-Z_]\w*)\s*=\s*([^=]+?)\s*$/.exec(v);
      if (k?.[1] !== undefined && k[2] !== undefined) {
        try {
          return constant(k[1], num(k[2], `${k[1]}`));
        } catch {
          // not a number: said below
        }
      }
      throw new SpecError(`slider ${i + 1}: write it as "n = 5 in 1..25"`);
    }
    const r = range(m[3], `slider ${m[1]}`);
    // "t = angle in 0..360": a start that is not a number starts at the low end.
    let start: unknown = m[2];
    try {
      num(m[2], 'start');
    } catch {
      start = r.min;
    }
    return param({ name: m[1], value: start, min: r.min, max: r.max }, i);
  }
  if (!isObj(v)) throw new SpecError(`slider ${i + 1} needs {name, min, max, value}`);
  /* [{"t": {"min": 0, "max": 4}}] — one slider as a one-key dictionary (MEASURED: the 4B's projectile). */
  const keys = Object.keys(v);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only !== undefined && /^[a-zA-Z_]\w*$/.test(only) && !['name', 'id', 'var'].includes(only)) {
    const inner = v[only];
    if (isObj(inner)) return param({ name: only, ...inner }, i);
    if (typeof inner === 'number') return constant(only, inner);
    if (typeof inner === 'string' && /\.\.|\bto\b/.test(inner))
      return param({ name: only, range: inner }, i);
  }
  const named = str(v.name ?? v.id ?? v.var ?? v.symbol);
  /* "Slope (m)" — a caption with the name in brackets, or ending in it
     (MEASURED: the 4B's sliders for y = mx + c). */
  const inBrackets = named !== undefined ? /\(\s*([a-zA-Z_]\w*)\s*\)/.exec(named)?.[1] : undefined;
  const trailing = named !== undefined ? /(?:^|\s)([a-zA-Z])\s*$/.exec(named)?.[1] : undefined;
  const name =
    named !== undefined && /^[a-zA-Z_]\w*$/.test(named) ? named : (inBrackets ?? trailing);
  if (name === undefined) {
    throw new SpecError(`slider ${i + 1} needs a name made of letters (like n, a, omega)`);
  }
  const caption =
    named !== undefined && named !== name
      ? named.replace(/\(\s*[a-zA-Z_]\w*\s*\)/, '').trim() || undefined
      : undefined;
  const noRange =
    v.min === undefined && v.from === undefined && v.max === undefined && v.range === undefined;
  if (noRange) {
    const val = v.value ?? v.default ?? v.initial ?? v.start;
    if (val !== undefined) return constant(name, num(val, `${name}`));
  }
  let min: number;
  let max: number;
  if (v.min === undefined && v.from === undefined && v.range !== undefined) {
    ({ min, max } = range(v.range, `slider ${name}`));
  } else {
    min = num(v.min ?? v.from, `slider ${name} min`);
    max = num(v.max ?? v.to, `slider ${name} max`);
  }
  if (!(max > min)) throw new SpecError(`slider ${name}: max must be above min`);
  // Whole numbers only for a count (n terms, k sides); a time or an amplitude slides smoothly even over 0…4.
  const label = str(v.label) ?? caption ?? name;
  const counts =
    /^(n|N|k|K|j|terms?|count|order|sides|steps|samples)$/.test(name) ||
    /\b(number of|terms|count|how many)\b/i.test(label);
  const step =
    v.step !== undefined
      ? num(v.step, `slider ${name} step`)
      : counts && Number.isInteger(min) && Number.isInteger(max)
        ? 1
        : (max - min) / 400;
  const start = v.value ?? v.default ?? v.initial ?? v.start ?? v.init;
  const value = Math.min(
    max,
    Math.max(min, start !== undefined ? num(start, `slider ${name} value`) : min),
  );
  return { name, label, min, max, step, value };
}

const RESERVED = new Set(['pi', 'e', 'tau', 'x', 'y', 't']);

function curve(v: unknown, i: number, fallback: Role, pv: string, names: readonly string[]): Curve {
  if (typeof v === 'string') {
    const expr = v.replace(/^\s*[A-Za-z]\w*\s*(\(\s*\w+\s*\))?\s*=\s*/, '');
    numOrExpr(expr, `curve ${i + 1}`, [pv, ...names]);
    return { id: `c${i + 1}`, appear: 1, expr, role: fallback, dashed: false };
  }
  if (!isObj(v)) throw new SpecError(`curve ${i + 1} needs {expr, label}`);
  const id = str(v.id) ?? `c${i + 1}`;
  const r = role(v.role ?? v.color ?? v.colour, fallback);
  const label = texLabel(str(v.label ?? v.name));
  const base = {
    id,
    appear: appearOf(v),
    ...(label !== undefined ? { label } : {}),
    role: r,
    dashed: v.dashed === true || v.dash === true || r === 'reference',
  };
  const px = str(v.px ?? get(v, 'xExpr', 'xt'));
  const py = str(v.py ?? get(v, 'yExpr', 'yt'));
  const tIn = v.t ?? v.range ?? get(v, 'tRange');
  if (
    (px !== undefined && py !== undefined) ||
    (typeof v.x === 'string' && typeof v.y === 'string' && tIn !== undefined)
  ) {
    const xs = px ?? (v.x as string);
    const ys = py ?? (v.y as string);
    const tr = range(tIn ?? [0, 2 * Math.PI], `curve ${id} t`);
    numOrExpr(xs, `curve ${id} x`, ['t', ...names]);
    numOrExpr(ys, `curve ${id} y`, ['t', ...names]);
    return { ...base, px: xs, py: ys, t: [tr.min, tr.max] };
  }
  const raw = str(
    v.expr ?? v.expression ?? v.f ?? v.y ?? v.fn ?? v.function ?? v.equation ?? v.formula,
  );
  if (raw === undefined)
    throw new SpecError(`curve ${id} needs its expression as expr, like "sin(x)"`);
  const expr = raw.replace(/^\s*[A-Za-z]\w*\s*(\(\s*\w+\s*\))?\s*=\s*/, '');
  numOrExpr(expr, `curve ${id}`, [pv, ...names]);
  return { ...base, expr };
}

/** The text of every curve a plot was given, for reading which names they use. */
function curveTexts(curvesIn: readonly unknown[]): string {
  return curvesIn
    .map((c) =>
      typeof c === 'string'
        ? c
        : isObj(c)
          ? (str(c.expr ?? c.expression ?? c.f ?? c.fn ?? c.function ?? c.equation ?? c.formula) ??
            '')
          : '',
    )
    .join(' ');
}

function plot(v: Loose, names: readonly string[]): PlotSpec {
  const curvesAll = list(
    v.curves ??
      v.functions ??
      v.exprs ??
      v.expr ??
      v.equation ??
      v.function ??
      v.expression ??
      v.formula,
  );
  const written = curveTexts(curvesAll);
  // "x(t) = …" names its variable; the right-hand sides say which names are used.
  const named = /^\s*[A-Za-z]\w*\s*\(\s*([A-Za-z_]\w*)\s*\)\s*=/.exec(written)?.[1];
  const texts = fromLatex(written.replace(/(^|\s)[A-Za-z]\w*\s*(\(\s*\w+\s*\))?\s*=\s*/g, '$1'));
  const names0 = new Set(texts.match(/[A-Za-z_]\w*/g) ?? []);
  // A plot whose curves never use x but do use t (or θ …) is a plot over that.
  const declared = str(get(v, 'var', 'variable'))?.replace(/[^a-zA-Z_]/g, '');
  const pv =
    declared ||
    named ||
    (names0.has('x')
      ? 'x'
      : (['t', 'theta', 's', 'u', 'r', 'n'].find((c) => names0.has(c)) ?? 'x'));
  const trig = /\b(sin|cos|tan|sec|csc|cot)\b/.test(texts);
  const xIn = v.x ?? get(v, 'domain', 'xRange') ?? (trig ? '-2pi..2pi' : undefined);
  const xObj = isObj(xIn) ? xIn : {};
  const x = range(isObj(xIn) && xIn.range !== undefined ? xIn.range : (xIn ?? [-10, 10]), 'x');
  const yIn = v.y ?? get(v, 'yRange');
  const yObj = isObj(yIn) ? yIn : {};
  const yHasRange =
    yIn !== undefined &&
    !(isObj(yIn) && yIn.min === undefined && yIn.max === undefined && yIn.range === undefined);
  const y = yHasRange
    ? range(isObj(yIn) && yIn.range !== undefined ? yIn.range : yIn, 'y')
    : undefined;
  const curvesIn = curvesAll;
  if (curvesIn.length === 0)
    throw new SpecError('a plot needs curves: [{"expr": "sin(x)", "label": "sin x"}]');
  // Unnamed colours go in order to the curves that are not references: the first real curve is `main`.
  const used = new Set<Role>();
  const curves = curvesIn.map((c, i) => {
    const next = (['main', 'second', 'third'] as const).find((r) => !used.has(r)) ?? 'third';
    const cv = curve(c, i, next, pv, names);
    used.add(cv.role);
    return cv;
  });
  const ids = new Set(curves.map((c) => c.id));
  const curveRef = (r: unknown, what: string): string => {
    const s = str(r) ?? curves[0]?.id ?? '';
    if (!ids.has(s))
      throw new SpecError(`${what} names curve "${s}" — the curves are ${[...ids].join(', ')}`);
    return s;
  };
  const xLabel = str(xObj.label ?? get(v, 'xLabel'));
  const yLabel = str(yObj.label ?? get(v, 'yLabel'));
  return {
    v: pv,
    x: { min: x.min, max: x.max, pi: x.pi, ...(xLabel !== undefined ? { label: xLabel } : {}) },
    y: {
      ...(y !== undefined ? { min: y.min, max: y.max } : {}),
      ...(yLabel !== undefined ? { label: yLabel } : {}),
    },
    curves,
    points: list(v.points).map((p, i) => {
      if (!isObj(p)) throw new SpecError(`point ${i + 1} needs {x, y, label}`);
      const id = str(p.id) ?? `p${i + 1}`;
      const at = p.at ?? p.xy;
      const [px, py] = Array.isArray(at) ? at : [p.x, p.y];
      const label = texLabel(str(p.label));
      const yPart =
        py !== undefined && py !== null && str(py) !== undefined
          ? // Its y may use the plot's own variable, meaning its x: "x*m + c" puts it on that line.
            { y: numOrExpr(py, `point ${id} y`, [...names, pv]) }
          : { on: curveRef(p.on ?? p.curve, `point ${id}`) };
      return {
        id,
        appear: appearOf(p),
        x: numOrExpr(px, `point ${id} x`, names),
        ...yPart,
        ...(label !== undefined ? { label } : {}),
        role: role(p.role ?? p.color, 'highlight'),
      };
    }),
    areas: list(v.areas ?? v.area ?? v.shade).map((a, i) => {
      if (!isObj(a)) throw new SpecError(`area ${i + 1} needs {under, from, to}`);
      const id = str(a.id) ?? `a${i + 1}`;
      const label = texLabel(str(a.label));
      return {
        id,
        appear: appearOf(a),
        under: curveRef(a.under ?? a.curve, `area ${id}`),
        from: numOrExpr(a.from ?? a.a ?? x.min, `area ${id} from`, names),
        to: numOrExpr(a.to ?? a.b ?? x.max, `area ${id} to`, names),
        ...(label !== undefined ? { label } : {}),
        role: role(a.role ?? a.color, 'main'),
      };
    }),
    tangents: list(v.tangents ?? v.tangent).map((t, i) => {
      if (!isObj(t)) throw new SpecError(`tangent ${i + 1} needs {to, at}`);
      const id = str(t.id) ?? `t${i + 1}`;
      const label = texLabel(str(t.label));
      return {
        id,
        appear: appearOf(t),
        to: curveRef(t.to ?? t.curve ?? t.of, `tangent ${id}`),
        at: numOrExpr(t.at ?? t.x, `tangent ${id} at`, names),
        ...(label !== undefined ? { label } : {}),
        role: role(t.role ?? t.color, 'highlight'),
      };
    }),
    riemann: list(v.riemann ?? v.rectangles).map((r, i) => {
      if (!isObj(r)) throw new SpecError(`riemann ${i + 1} needs {under, from, to, n}`);
      const id = str(r.id) ?? `r${i + 1}`;
      const rule = str(r.rule ?? r.method)?.toLowerCase();
      return {
        id,
        appear: appearOf(r),
        under: curveRef(r.under ?? r.curve, `riemann ${id}`),
        from: numOrExpr(r.from ?? x.min, `riemann ${id} from`, names),
        to: numOrExpr(r.to ?? x.max, `riemann ${id} to`, names),
        n: numOrExpr(r.n ?? 8, `riemann ${id} n`, names),
        rule: rule === 'left' || rule === 'right' ? rule : 'mid',
        role: role(r.role ?? r.color, 'main'),
      };
    }),
  };
}

const ANCHORS: readonly Anchor[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

function shape(v: unknown, i: number, named: Map<string, Xy>, names: readonly string[]): Shape {
  // Where a thing is, in the words a model uses for it (MEASURED: the 4B's labels at "pos").
  const w =
    isObj(v) && v.at === undefined
      ? { ...v, at: v.pos ?? v.position ?? v.xy ?? v.location ?? v.coords ?? v.at }
      : v;
  if (isObj(w) && w.at === undefined) delete w.at;
  const s0 = shapeBody(w, i, named, names);
  const s = isObj(w) ? moved(s0, w, names) : s0;
  const op = isObj(w) ? (w.opacity ?? w.alpha) : undefined;
  return op === undefined ? s : { ...s, opacity: numOrExpr(op, `${s.id}.opacity`, names) };
}

/**
 * SLIDE, TURN, SCALE — a part that moves as a slider runs, written as the move
 * rather than as formulas for every corner: "slide": {"by": [1.5, -2.5], "t":
 * "0..1"} moves it by (1.5, −2.5) as t goes 0 → 1, eased; "turn": {"by": 90,
 * "about": [0, 0], "t": "1..2"} turns it 90° about a point; "scale": {"by": 2}
 * grows it from its centre. The slider named is the key; without one, the
 * first slider over its whole range. the user: "smooth move/scale/slide". The move
 * is written into the coordinates, so everything that reads them — the page,
 * the checks, the arrows that show a move — sees it.
 */
function moved(sh: Shape, v: Loose, names: readonly string[]): Shape {
  const slideIn = v.slide ?? v.move ?? v.translate ?? v.shift;
  const turnIn = v.turn ?? v.rotate ?? v.spin;
  const scaleIn = v.scale ?? v.grow;
  if (slideIn === undefined && turnIn === undefined && scaleIn === undefined) return sh;
  const sliders = SLIDERS.filter((p) => p.hidden !== true);
  const progress = (m: unknown): string => {
    const o: Loose = isObj(m) ? m : {};
    const key = Object.keys(o).find((k) => sliders.some((p) => p.name === k));
    const withName = str(o.with ?? o.slider ?? o.over);
    const p =
      sliders.find((q) => q.name === (key ?? withName)) ??
      sliders.find((q) => q.name === 't') ??
      sliders[0];
    if (p === undefined)
      throw new SpecError(
        `${sh.id} moves, but there is no slider to move it — add one to "params" ("t = 0 in 0..1")`,
      );
    let a: Num = p.min;
    let b: Num = p.max;
    const r = key !== undefined ? o[key] : (o.range ?? o.during ?? o.when);
    if (r !== undefined) {
      const ends =
        Array.isArray(r) && r.length === 2
          ? r
          : typeof r === 'string'
            ? r.split(/\s*(?:\.\.\.?|\bto\b)\s*/)
            : [];
      if (ends.length === 2) {
        a = numOrExpr(ends[0], `${sh.id} move start`, names);
        b = numOrExpr(ends[1], `${sh.id} move end`, names);
      }
    } else if (o.from !== undefined && o.to !== undefined) {
      a = numOrExpr(o.from, `${sh.id} move start`, names);
      b = numOrExpr(o.to, `${sh.id} move end`, names);
    }
    return `ease(between(${p.name}, ${a}, ${b}))`;
  };
  const pair = (m: unknown, what: string): [Num, Num] => {
    const by = isObj(m) ? (m.by ?? m.to ?? m.d) : m;
    if (Array.isArray(by) && by.length === 2)
      return [
        numOrExpr(by[0], `${sh.id} ${what} x`, names),
        numOrExpr(by[1], `${sh.id} ${what} y`, names),
      ];
    throw new SpecError(`${sh.id}: "${what}" needs "by": [dx, dy]`);
  };
  const amount = (m: unknown, what: string): Num => {
    const by = isObj(m) ? (m.by ?? m.angle ?? m.factor ?? m.to) : m;
    return numOrExpr(by, `${sh.id} ${what}`, names);
  };
  const centre = centreOf(sh);
  const about = (m: unknown): [Num, Num] => {
    const c = isObj(m) ? (m.about ?? m.around ?? m.centre ?? m.center) : undefined;
    if (Array.isArray(c) && c.length === 2)
      return [
        numOrExpr(c[0], `${sh.id} about x`, names),
        numOrExpr(c[1], `${sh.id} about y`, names),
      ];
    return centre;
  };
  const e = (x: Num) => (typeof x === 'number' ? String(x) : `(${x})`);
  let f = (x: Num, y: Num): [Num, Num] => [x, y];
  let k: string | null = null;
  if (scaleIn !== undefined) {
    const [cx, cy] = about(scaleIn);
    const by = amount(scaleIn, 'scale');
    const u = progress(scaleIn);
    const g = f;
    k = `(1 + (${e(by)} - 1)*${u})`;
    const kk = k;
    f = (x, y) => {
      const [a, b] = g(x, y);
      return [`${e(cx)} + (${e(a)} - ${e(cx)})*${kk}`, `${e(cy)} + (${e(b)} - ${e(cy)})*${kk}`];
    };
  }
  if (turnIn !== undefined) {
    const [cx, cy] = about(turnIn);
    const th = `(${e(amount(turnIn, 'turn'))}*pi/180*${progress(turnIn)})`;
    const g = f;
    f = (x, y) => {
      const [a, b] = g(x, y);
      const dx = `(${e(a)} - ${e(cx)})`;
      const dy = `(${e(b)} - ${e(cy)})`;
      return [
        `${e(cx)} + ${dx}*cos${th} - ${dy}*sin${th}`,
        `${e(cy)} + ${dx}*sin${th} + ${dy}*cos${th}`,
      ];
    };
  }
  if (slideIn !== undefined) {
    const [dx, dy] = pair(slideIn, 'slide');
    const u = progress(slideIn);
    const g = f;
    f = (x, y) => {
      const [a, b] = g(x, y);
      return [`${e(a)} + ${e(dx)}*${u}`, `${e(b)} + ${e(dy)}*${u}`];
    };
  }
  const P = (p: Xy): Xy => f(p[0], p[1]);
  const grow = (r: Num): Num => (k === null ? r : `${e(r)}*${k}`);
  switch (sh.kind) {
    case 'point':
    case 'label':
      return { ...sh, at: P(sh.at) };
    case 'segment':
    case 'vector':
    case 'spring':
    case 'dimension':
      return { ...sh, from: P(sh.from), to: P(sh.to) };
    case 'polygon':
    case 'polyline':
      return { ...sh, points: sh.points.map(P) };
    case 'circle':
      return { ...sh, center: P(sh.center), r: grow(sh.r) };
    case 'angle':
      return { ...sh, at: P(sh.at), from: P(sh.from), to: P(sh.to) };
    case 'box3d':
      return { ...sh, at: P(sh.at), w: grow(sh.w), h: grow(sh.h), depth: grow(sh.depth) };
    case 'curve': {
      const [x, y] = f(sh.x, sh.y);
      return { ...sh, x: String(x), y: String(y) };
    }
  }
}

/** A shape's middle, for a turn or a scale with no point given: the mean of its numeric corners. */
function centreOf(sh: Shape): [Num, Num] {
  const pts: Xy[] =
    sh.kind === 'point' || sh.kind === 'label' || sh.kind === 'angle'
      ? [sh.at]
      : sh.kind === 'circle'
        ? [sh.center]
        : sh.kind === 'polygon' || sh.kind === 'polyline'
          ? [...sh.points]
          : sh.kind === 'box3d'
            ? [sh.at]
            : sh.kind === 'curve'
              ? []
              : [sh.from, sh.to];
  const nums = pts.filter(
    (p): p is readonly [number, number] => typeof p[0] === 'number' && typeof p[1] === 'number',
  );
  if (nums.length === 0) return [0, 0];
  return [
    nums.reduce((a, p) => a + p[0], 0) / nums.length,
    nums.reduce((a, p) => a + p[1], 0) / nums.length,
  ];
}

function shapeBody(v: unknown, i: number, named: Map<string, Xy>, names: readonly string[]): Shape {
  if (!isObj(v)) throw new SpecError(`shape ${i + 1} needs {kind, …}`);
  const kind = str(v.kind ?? v.type ?? v.shape)?.toLowerCase();
  const id = str(v.id) ?? `s${i + 1}`;
  const label = texLabel(str(v.label ?? v.text ?? v.label_text ?? v.name));
  const L = label !== undefined ? { label } : {};
  const appear = appearOf(v);
  /* A point with a depth — the model drawing a cube thinks in 3D — is drawn in
     the box3d's own oblique view: z goes right 0.8 and up 0.55 per unit. */
  const depth3 = (px: unknown, py: unknown, pz: unknown, what: string): Xy => {
    const [x, y, z] = [
      numOrExpr(px, `${what} x`, names),
      numOrExpr(py, `${what} y`, names),
      numOrExpr(pz, `${what} z`, names),
    ];
    if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number')
      return [x + 0.8 * z, y + 0.55 * z];
    return [`(${x})+0.8*(${z})`, `(${y})+0.55*(${z})`];
  };
  const xy = (p: unknown, what: string): Xy => {
    if (typeof p === 'string' && named.has(p)) return named.get(p) as Xy;
    if (Array.isArray(p) && p.length === 3) return depth3(p[0], p[1], p[2], what);
    if (isObj(p) && 'x' in p && 'y' in p && 'z' in p) return depth3(p.x, p.y, p.z, what);
    if (Array.isArray(p) && p.length === 2)
      return [numOrExpr(p[0], `${what} x`, names), numOrExpr(p[1], `${what} y`, names)];
    if (isObj(p) && 'x' in p && 'y' in p)
      return [numOrExpr(p.x, `${what} x`, names), numOrExpr(p.y, `${what} y`, names)];
    const known = named.size > 0 ? ` or a point's id (${[...named.keys()].join(', ')})` : '';
    throw new SpecError(`${what} needs a point: [x, y]${known}`);
  };
  const at = (k: string) => xy(v[k], `${id}.${k}`);
  switch (kind) {
    case 'point':
    case 'dot':
    case 'particle':
    case 'molecule': {
      const p = at('at' in v ? 'at' : 'p' in v ? 'p' : 'center');
      named.set(id, p);
      const place = str(v.place ?? v.anchor)?.toLowerCase() as Anchor | undefined;
      return {
        id,
        appear,
        kind: 'point',
        at: p,
        ...L,
        ...(place && ANCHORS.includes(place) ? { place } : {}),
        role: role(v.role ?? v.color, 'main'),
      };
    }
    case 'line':
      // A line through points — a ground, a wall's edge — is drawn straight, in ink, like a segment.
      if (Array.isArray(v.points)) {
        return shape(
          { ...v, kind: 'polyline', role: v.role ?? v.color ?? 'reference' },
          i,
          named,
          names,
        );
      }
      return shape({ ...v, kind: 'segment' }, i, named, names);
    case 'segment':
    case 'vector':
    case 'arrow':
    case 'force': {
      /* Its two ends as one list — MEASURED (the 4B's Pythagoras):
         "endpoints": [{"x": 50, "y": 250}, {"x": 450, "y": 250}]. */
      const ends = v.endpoints ?? v.ends ?? v.between ?? v.points;
      if (Array.isArray(ends) && ends.length === 2 && v.from === undefined && v.to === undefined)
        return shape(
          {
            ...v,
            endpoints: undefined,
            ends: undefined,
            between: undefined,
            points: undefined,
            from: ends[0],
            to: ends[1],
          },
          i,
          named,
          names,
        );
      const isVec = kind !== 'segment';
      /* An arrow as its ends by other names, or as a start and a direction —
         MEASURED (the 4B): {"center": [x, y], "direction": [dx, dy]}. */
      const startKey = ['from', 'start', 'tail', 'origin', 'at', 'center', 'base'].find(
        (k) => v[k] !== undefined,
      );
      const endKey = ['to', 'end', 'tip', 'head'].find((k) => v[k] !== undefined);
      const dirIn = v.direction ?? v.dir ?? v.vector ?? v.components ?? v.delta;
      if (startKey === undefined) throw new SpecError(`${id}.from needs a point: [x, y]`);
      const from = at(startKey);
      let to: Xy;
      if (endKey !== undefined) to = at(endKey);
      else if (Array.isArray(dirIn) && dirIn.length === 2) {
        const d = xy(dirIn, `${id}.direction`);
        const plus = (a: Num, b: Num): Num =>
          typeof a === 'number' && typeof b === 'number' ? a + b : `(${a})+(${b})`;
        to = [plus(from[0], d[0]), plus(from[1], d[1])];
      } else throw new SpecError(`${id}.to needs a point: [x, y] — or give "direction": [dx, dy]`);
      return {
        id,
        appear,
        kind: isVec ? 'vector' : 'segment',
        from,
        to,
        ...L,
        dashed: v.dashed === true || v.hidden === true,
        role: role(v.role ?? v.color, isVec ? 'main' : 'reference'),
      };
    }
    case 'rect':
    case 'rectangle':
    case 'block':
    case 'wall': {
      if (v.points === undefined && v.vertices === undefined) {
        if ((v.w ?? v.width) === undefined && ('from' in v || 'at' in v) && 'to' in v) {
          // By two opposite corners (MEASURED: the 4B's "large-square", {"from": [0, 0], "to": [1, 1]}).
          return shape(
            {
              ...v,
              kind: 'polygon',
              vertices: undefined,
              ...cornersOf(v.from ?? v.at, v.to),
            },
            i,
            named,
            names,
          );
        }
        const w = numOrExpr(v.w ?? v.width, `${id}.w`, names);
        const h = numOrExpr(v.h ?? v.height, `${id}.h`, names);
        const add = (a: Num, b: Num): Num =>
          typeof a === 'number' && typeof b === 'number' ? a + b : `(${a})+(${b})`;
        const half = (a: Num, d: Num): Num =>
          typeof a === 'number' && typeof d === 'number' ? a - d / 2 : `(${a})-(${d})/2`;
        // By its corner ("at"/"from"), or by its centre (MEASURED: the 4B's ground, {"center", "width", "height"}).
        let x0: Num;
        let y0: Num;
        if ('at' in v || 'from' in v || 'corner' in v)
          [x0, y0] = at('at' in v ? 'at' : 'from' in v ? 'from' : 'corner');
        else if ('center' in v || 'centre' in v) {
          const [cx, cy] = at('center' in v ? 'center' : 'centre');
          x0 = half(cx, w);
          y0 = half(cy, h);
        } else [x0, y0] = at('at');
        return {
          id,
          appear,
          kind: 'polygon',
          points: [
            [x0, y0],
            [add(x0, w), y0],
            [add(x0, w), add(y0, h)],
            [x0, add(y0, h)],
          ],
          fill: fill(v.fill),
          ...L,
          dashed: v.dashed === true,
        };
      }
      return polygonShape();
    }
    case 'square':
      if (v.points === undefined && v.vertices === undefined) return squareShape();
      return polygonShape();
    case 'polygon':
    case 'triangle':
      return polygonShape();
    case 'polyline':
    case 'path':
    case 'curve':
    case 'trajectory':
    case 'track':
    case 'trail':
    case 'parametric': {
      if (v.points === undefined && v.vertices === undefined && v.through === undefined) {
        const f = formulaCurve();
        if (f !== null) return f;
      }
      const ptsIn = v.points ?? v.vertices ?? v.through;
      if ((!Array.isArray(ptsIn) || ptsIn.length < 2) && (v.x !== undefined || v.y !== undefined))
        throw new SpecError(
          `${id} (a curve): "x" and "y" are each ONE expression in a variable of their own, over a "range" — e.g. "x": "v0*cos(a)*s", "y": "v0*sin(a)*s - 4.9*s^2", "range": "0..t" draws the path up to t`,
        );
      if (!Array.isArray(ptsIn) || ptsIn.length < 2)
        throw new SpecError(`${id} needs 2 or more points`);
      return {
        id,
        appear,
        kind: 'polyline',
        points: ptsIn.map((p, k) => xy(p, `${id} point ${k + 1}`)),
        ...L,
        dashed: v.dashed === true,
        role: role(v.role ?? v.color, 'main'),
        smooth: v.smooth === true || (v.smooth !== false && kind !== 'polyline'),
      };
    }
    case 'circle':
    case 'ball':
    case 'sphere':
    case 'mass':
    case 'bob':
    case 'disc':
      return {
        id,
        appear,
        kind: 'circle',
        center: at('center' in v ? 'center' : 'at'),
        r: numOrExpr(v.r ?? v.radius ?? 0.5, `${id}.r`, names),
        fill: fill(
          v.fill ??
            (kind === 'ball' || kind === 'sphere' || kind === 'mass' || kind === 'bob'
              ? 'main'
              : undefined),
        ),
        ...L,
        role: role(v.role ?? v.color, 'main'),
      };
    case 'angle':
      return {
        id,
        appear,
        kind: 'angle',
        at: at('at' in v ? 'at' : 'vertex'),
        from: at('from'),
        to: at('to'),
        ...L,
        right: v.right === true,
      };
    case 'dimension':
    case 'measure':
    case 'length':
      if (label === undefined) throw new SpecError(`${id} (a dimension) needs its label, like "L"`);
      return {
        id,
        appear,
        kind: 'dimension',
        from: at('from'),
        to: at('to'),
        label,
        offset: v.offset !== undefined ? num(v.offset, `${id}.offset`) : 0.5,
      };
    case 'label':
    case 'text':
      if (label === undefined) throw new SpecError(`${id} (a label) needs text`);
      return { id, appear, kind: 'label', at: at('at'), text: label };
    case 'box3d':
    case 'cube':
    case 'cuboid':
    case 'box': {
      /* "size": 4 is a cube; [w, h, d] and {w, h, d} are a box — MEASURED (the
         STEM suite, 4B): "size": [0.4, 0.4, 0.4] on four specs in a row, each
         refused. The third size wins over a "depth" of its own. */
      const sizeIn = v.size ?? v.side ?? v.dimensions ?? v.dims;
      const dims: unknown[] = Array.isArray(sizeIn)
        ? sizeIn
        : isObj(sizeIn)
          ? [
              sizeIn.w ?? sizeIn.width ?? sizeIn.x,
              sizeIn.h ?? sizeIn.height ?? sizeIn.y,
              sizeIn.d ?? sizeIn.depth ?? sizeIn.z,
            ]
          : [sizeIn];
      const size = numOrExpr(dims[0] ?? v.w ?? v.width ?? 4, `${id}.size`, names);
      const height = numOrExpr(dims[1] ?? v.h ?? v.height ?? size, `${id}.size`, names);
      // A size in three is the model thinking in x, y, z — its points use that depth too.
      const depthIn = dims.length >= 3 && dims[2] !== undefined ? dims[2] : (v.depth ?? v.d);
      const shadeIn = str(v.shade ?? v.shaded)?.toLowerCase();
      const lab = isObj(v.labels) ? v.labels : {};
      const edge = str(
        v.edge ?? v.side_label ?? (typeof v.label === 'string' ? v.label : undefined),
      );
      const w = str(lab.w ?? lab.width) ?? edge;
      const h = str(lab.h ?? lab.height) ?? edge;
      const d = str(lab.d ?? lab.depth) ?? edge;
      return {
        id,
        appear,
        kind: 'box3d',
        at: 'at' in v ? at('at') : 'corner' in v ? at('corner') : [0, 0],
        w: size,
        h: height,
        depth:
          depthIn !== undefined
            ? numOrExpr(depthIn, `${id}.depth`, names)
            : typeof size === 'number'
              ? size * 0.5
              : `(${size})*0.5`,
        shade:
          shadeIn === 'top'
            ? 'top'
            : shadeIn === 'front'
              ? 'front'
              : shadeIn === 'none' || shadeIn === 'false'
                ? 'none'
                : 'right',
        labels: { ...(w ? { w } : {}), ...(h ? { h } : {}), ...(d ? { d } : {}) },
      };
    }
    case 'spring':
      return {
        id,
        appear,
        kind: 'spring',
        from: at('from'),
        to: at('to'),
        coils: v.coils !== undefined ? Math.max(3, Math.round(num(v.coils, `${id}.coils`))) : 10,
        ...L,
      };
    default: {
      /* A kind this reader does not name is read from what the shape carries —
         MEASURED (the 4B): "right_triangle", "arc", "square_decomposition". */
      const has = (k: string) => v[k] !== undefined;
      const pts = v.points ?? v.vertices;
      if ((kind === 'arc' || kind?.endsWith('_arc') === true) && has('from') && has('to'))
        return shape({ ...v, kind: 'angle', at: v.at ?? v.center ?? v.vertex }, i, named, names);
      if (Array.isArray(pts) && pts.length >= 3) return polygonShape();
      if (Array.isArray(pts) && pts.length === 2)
        return shape(
          { ...v, kind: 'segment', from: pts[0], to: pts[1], points: undefined },
          i,
          named,
          names,
        );
      if (has('center') && (has('r') || has('radius')))
        return shape({ ...v, kind: 'circle' }, i, named, names);
      if (has('from') && has('to')) return shape({ ...v, kind: 'segment' }, i, named, names);
      if (typeof v.x === 'string' && typeof v.y === 'string') {
        const f = formulaCurve();
        if (f !== null) return f;
      }
      if (has('at') && (has('text') || has('label')) && !has('r'))
        return shape({ ...v, kind: 'label' }, i, named, names);
      if (has('at')) return shape({ ...v, kind: 'point' }, i, named, names);
      throw new SpecError(
        `shape ${id}: kind "${kind ?? ''}" is not one of point, segment, vector, polygon, polyline, curve, rect, circle, angle, dimension, label, box3d, spring`,
      );
    }
  }
  /**
   * A curve from a formula — MEASURED (the 4B): a projectile's path written as
   * a Python list comprehension inside the JSON, twice. x and y are
   * expressions in a variable of their own (s, u, …, named by "var" or found
   * in them), over a range whose ends may use the sliders: "0..t" draws the
   * path travelled so far.
   */
  function formulaCurve(): Shape | null {
    const o = v as Loose;
    let xs = typeof o.x === 'string' ? o.x : undefined;
    let ys = typeof o.y === 'string' ? o.y : undefined;
    if (xs === undefined || ys === undefined) return null;
    /* "x": "-10..10", "y": "m*x + c" — MEASURED (the 4B's y = mx + c): x
       given as the range it runs over, y as a formula in it. The range names
       the variable: x runs over it. (Read as a value, "-10..10" was −10 times
       .10, and the line stood upright at x = −1.) */
    const isRange = (t: string) => /\.\.|^\s*\S+\s+to\s+\S+\s*$/.test(t);
    let axisRange: string | undefined;
    let axis: 'x' | 'y' | undefined;
    if (isRange(xs) && !isRange(ys)) {
      axisRange = xs;
      axis = 'x';
      xs = 'x';
    } else if (isRange(ys) && !isRange(xs)) {
      axisRange = ys;
      axis = 'y';
      ys = 'y';
    }
    const free = (src: string) =>
      [...src.matchAll(/[A-Za-z_]\w*/g)]
        .map((m) => m[0])
        .filter(
          (w) =>
            !names.includes(w) &&
            !/^(pi|e|tau|sin|cos|tan|sqrt|exp|ln|log|abs|min|max|pow|ease|lerp|between|clamp|atan2|asin|acos|atan|sinh|cosh|tanh|floor|ceil|round|sign|mod|sec|csc|cot|sum|prod|if|cbrt|log10|log2|sgn)$/.test(
              w,
            ),
        );
    const named = str(o.var ?? o.variable ?? o.param ?? o.over);
    const over =
      axis ??
      (named !== undefined && /^[A-Za-z_]\w*$/.test(named)
        ? named
        : ([...free(xs), ...free(ys)][0] ?? (names.includes('t') ? 's' : 't')));
    const rIn =
      o.range ??
      axisRange ??
      o[over] ??
      o.span ??
      (o.from !== undefined && o.to !== undefined ? [o.from, o.to] : undefined);
    const ends =
      Array.isArray(rIn) && rIn.length === 2
        ? rIn
        : typeof rIn === 'string'
          ? rIn.split(/\s*(?:\.\.\.?|\bto\b)\s*/)
          : [0, 1];
    if (ends.length !== 2)
      throw new SpecError(`${id} (a curve) needs a range for ${over}, like "0..t"`);
    numOrExpr(xs, `${id}.x`, [...names, over]);
    numOrExpr(ys, `${id}.y`, [...names, over]);
    return {
      id,
      appear,
      kind: 'curve',
      x: xs,
      y: ys,
      over,
      from: numOrExpr(ends[0], `${id} start`, names),
      to: numOrExpr(ends[1], `${id} end`, names),
      ...L,
      dashed: o.dashed === true,
      role: role(o.role ?? o.color, 'main'),
    };
  }
  /**
   * A SQUARE ON A SIDE — the construction behind the Pythagorean pictures:
   * "on": [A, B] builds it on the segment A→B, on the side away from "away"
   * (a point such as the triangle's third corner) or else to the right of A→B.
   * Or by its centre and side. MEASURED (the 4B): squares meant to stand on a
   * triangle's sides, placed by hand, stood beside them instead.
   */
  function squareShape(): Shape {
    const o = v as Loose;
    const onIn = o.on ?? o.side ?? o.edge ?? o.base;
    if (Array.isArray(onIn) && onIn.length === 2) {
      const A = xy(onIn[0], `${id} side start`);
      const B = xy(onIn[1], `${id} side end`);
      const e = (x: Num) => (typeof x === 'number' ? String(x) : `(${x})`);
      const dx = `(${e(B[0])} - ${e(A[0])})`;
      const dy = `(${e(B[1])} - ${e(A[1])})`;
      // The right-hand normal of A→B is (dy, −dx); flipped when "away" lies on that side.
      let sgn = '1';
      const awayIn = o.away ?? o.away_from ?? o.opposite ?? o.outside_of;
      if (Array.isArray(awayIn) && awayIn.length === 2) {
        const P = xy(awayIn, `${id} away`);
        sgn = `(0 - sign((${e(P[0])} - ${e(A[0])})*${dy} - (${e(P[1])} - ${e(A[1])})*${dx}))`;
      }
      const nx = `${sgn}*${dy}`;
      const ny = `${sgn}*(0 - ${dx})`;
      const pts: Xy[] = [
        A,
        B,
        [`${e(B[0])} + ${nx}`, `${e(B[1])} + ${ny}`],
        [`${e(A[0])} + ${nx}`, `${e(A[1])} + ${ny}`],
      ];
      return shape(
        { ...o, kind: 'polygon', on: undefined, side: undefined, points: pts },
        i,
        named,
        names,
      );
    }
    const cIn = o.center ?? o.centre ?? o.at;
    const sideIn = o.size ?? o.length ?? o.r ?? o.width;
    if (Array.isArray(cIn) && sideIn !== undefined) {
      const [cx, cy] = xy(cIn, `${id}.center`);
      const sz = numOrExpr(sideIn, `${id}.size`, names);
      const e = (x: Num) => (typeof x === 'number' ? String(x) : `(${x})`);
      const h = `${e(sz)}/2`;
      const pts: Xy[] = [
        [`${e(cx)} - ${h}`, `${e(cy)} - ${h}`],
        [`${e(cx)} + ${h}`, `${e(cy)} - ${h}`],
        [`${e(cx)} + ${h}`, `${e(cy)} + ${h}`],
        [`${e(cx)} - ${h}`, `${e(cy)} + ${h}`],
      ];
      return shape(
        { ...o, kind: 'polygon', center: undefined, at: undefined, points: pts },
        i,
        named,
        names,
      );
    }
    throw new SpecError(
      `${id} (a square) needs its side — "on": [[0, 0], [3, 0]] builds it on that segment (add "away": [x, y] to put it on the other side of a point) — or "center" and "size"`,
    );
  }
  function polygonShape(): Shape {
    const ptsIn = (v as Loose).points ?? (v as Loose).vertices;
    if (!Array.isArray(ptsIn) || ptsIn.length < 3)
      throw new SpecError(`${id} needs 3 or more points`);
    return {
      id,
      appear,
      kind: 'polygon',
      points: ptsIn.map((p, k) => xy(p, `${id} point ${k + 1}`)),
      fill: fill((v as Loose).fill),
      ...L,
      dashed: (v as Loose).dashed === true,
    };
  }
}

/**
 * A view's range, or null: nothing given, or nothing a range can be read from.
 * MEASURED (the STEM suite, 4B): `"view": {"x": -2, "y": -2, "z": -2}` —
 * one number per axis, twice, each refused. A figure with no readable view is
 * FITTED to its shapes instead (renderMath), across every slider setting and
 * step, so no part leaves it; a view that reads is kept as written.
 */
function viewRange(v: unknown, what: string, notes: string[]): { min: number; max: number } | null {
  if (v === undefined || v === null) return null;
  const axis = what.replace(/^figure /, '');
  if (typeof v === 'number') {
    const n = Math.abs(v);
    notes.push(
      `the figure's ${axis} is one number (${v}), not a range, so the view fits the shapes — write "${axis}": "${n > 0 ? `${-n}..${n}` : '0..10'}" to choose it`,
    );
    return null;
  }
  try {
    return range(v, what);
  } catch (e) {
    const why = e instanceof SpecError || e instanceof ExprError ? e.message : String(e);
    notes.push(
      `the figure's ${axis} (${JSON.stringify(v)}) is not a range (${why.replace(`${what}: `, '').replace(`${what} `, '')}), so the view fits the shapes — write a range like "0..10" to choose it`,
    );
    return null;
  }
}

/**
 * Lists a figure may hold beside "shapes", and the kind each one's parts are —
 * areas first and words last, so what is written is drawn on top.
 */
const SHAPES_BY_KEY: Readonly<Record<string, string>> = {
  polygons: 'polygon',
  triangles: 'polygon',
  rects: 'rect',
  rectangles: 'rect',
  squares: 'square',
  circles: 'circle',
  curves: 'curve',
  segments: 'segment',
  lines: 'segment',
  arrows: 'vector',
  vectors: 'vector',
  forces: 'vector',
  springs: 'spring',
  angles: 'angle',
  dimensions: 'dimension',
  points: 'point',
  labels: 'label',
  texts: 'label',
  annotations: 'label',
};

function figure(v: Loose, names: readonly string[], notes: string[]): FigureSpec {
  const viewIn = isObj(v.view) ? v.view : isObj(v.window) ? v.window : v;
  const x = viewRange(viewIn.x ?? get(v, 'xRange'), 'figure x', notes);
  const y = viewRange(viewIn.y ?? get(v, 'yRange'), 'figure y', notes);
  const fit: ('x' | 'y')[] = [
    ...(x === null ? ['x' as const] : []),
    ...(y === null ? ['y' as const] : []),
  ];
  // A depth range widens a written frame by what depth adds in the oblique view.
  const z =
    viewIn.z !== undefined && fit.length < 2 ? viewRange(viewIn.z, 'figure z', notes) : null;
  if (z !== null) {
    if (x !== null) {
      x.max += 0.8 * Math.max(0, z.max);
      x.min += 0.8 * Math.min(0, z.min);
    }
    if (y !== null) {
      y.max += 0.55 * Math.max(0, z.max);
      y.min += 0.55 * Math.min(0, z.min);
    }
  }
  /* Parts listed by kind beside "shapes" — MEASURED (the 4B's Pythagoras):
     "dimensions": [a, b, c] and "labels": [two captions] next to its shapes,
     none of them drawn, and eleven "step 1 highlights dim_a, which is not a
     part". A list named for a kind is shapes of that kind. */
  const byKind = Object.entries(SHAPES_BY_KEY).flatMap(([key, kind]) =>
    list(v[key]).map((s) =>
      isObj(s) && s.kind === undefined && s.type === undefined ? { ...s, kind } : s,
    ),
  );
  const shapesIn = [...list(v.shapes ?? v.elements ?? v.items ?? v.objects ?? v.parts), ...byKind];
  if (shapesIn.length === 0) throw new SpecError('a figure needs shapes');
  const named = new Map<string, Xy>();
  return {
    x: x !== null ? [x.min, x.max] : [0, 10],
    y: y !== null ? [y.min, y.max] : [0, 10],
    ...(fit.length > 0 ? { fit } : {}),
    shapes: shapesIn.map((s, i) => shape(s, i, named, names)),
  };
}

const EMOJI = /\p{Extended_Pictographic}|\u{FE0F}|\u{20E3}|[\u{1F1E6}-\u{1F1FF}]/gu;

/** Emoji out: the user — "emojis absolutely not". */
export function withoutEmoji(s: string): string {
  return s
    .replace(EMOJI, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Every string in a value, emoji removed; true when any were. */
function scrub<T>(v: T, found: { any: boolean }): T {
  if (typeof v === 'string') {
    const clean = withoutEmoji(v);
    if (clean !== v.trim()) found.any = true;
    return clean as T;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, found)) as T;
  if (isObj(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, found)])) as T;
  return v;
}

/** TeX commands a spec's text and expressions use — the names a lone backslash begins. */
const TEX_COMMANDS =
  'frac|dfrac|tfrac|sqrt|sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|ln|log|exp|lim|' +
  'sum|prod|int|iint|oint|infty|partial|nabla|cdot|cdots|ldots|times|div|pm|mp|approx|neq|ne|leq|le|geq|ge|' +
  'equiv|propto|sim|to|rightarrow|leftarrow|Rightarrow|implies|iff|in|notin|subset|cup|cap|forall|exists|' +
  'alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|' +
  'sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega|' +
  'left|right|big|Big|text|mathrm|mathbf|mathit|mathcal|operatorname|vec|hat|bar|dot|ddot|overline|' +
  'underline|quad|qquad|circ|degree|angle|triangle|perp|parallel|prime|boxed|displaystyle|over|binom';
const LONE_TEX = new RegExp(`(?<!\\\\)\\\\(?=(?:${TEX_COMMANDS})(?![A-Za-z]))`, 'g');

/**
 * JSON WITH TeX IN IT, AS A MODEL TYPES IT. A spec's steps and labels carry
 * TeX, and a model writes `"$\frac{a}{b}$"` with ONE backslash — which JSON
 * reads as a form feed and "rac", as `\theta` → a tab and "heta", `\nu` → a
 * newline and "u"; `\sin` and `\pi` do not parse at all. A lone backslash
 * that begins a TeX command's name is taken as TeX (doubled before parsing);
 * `\\frac`, and a real `\n` before ordinary words, are left as they are.
 */
export function texSafeJson(text: string): string {
  return text.replace(LONE_TEX, '\\\\');
}

/**
 * JSON AS A MODEL WRITES IT WHEN THE SPEC FEELS LIKE CODE: `// comments`,
 * `/* blocks *\/`, 'single-quoted' strings, bare keys ({title: …}), trailing
 * commas. Tried only after strict JSON fails; a string-aware pass, so nothing
 * inside a string is touched.
 */
export function lenientJson(text: string): unknown {
  const src = texSafeJson(text);
  try {
    return JSON.parse(src);
  } catch (strict) {
    try {
      return JSON.parse(relaxedJson(src));
    } catch {
      throw strict;
    }
  }
}

/**
 * The relaxing pass: a scanner that knows whether it is at a key or a value.
 * A bare key is quoted; a bare VALUE that is not a JSON literal is quoted too
 * — MEASURED (the STEM suite, 4B): `"view": {"x": -2..2}`, `"at": [L/2, L/2]`,
 * `"to": [0, A*cos(omega*t)]` failed ten parses in one turn ("Unterminated
 * fractional number"). Brackets inside a bare value are counted, so `max(x,
 * 0)` stays whole; Python's True / False / None are JSON's.
 */
export function relaxedJson(src: string): string {
  const LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$|^(?:true|false|null)$/;
  const PYTHON: Readonly<Record<string, string>> = { True: 'true', False: 'false', None: 'null' };
  const stack: Array<'o' | 'a'> = [];
  let expectKey = false;
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] ?? '';
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (/\s/.test(c)) {
      out += c;
      i += 1;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? 'o' : 'a');
      expectKey = c === '{';
      out += c;
      i += 1;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      out = out.replace(/,\s*$/, '');
      out += c;
      expectKey = false;
      i += 1;
      continue;
    }
    if (c === ',' || c === ':') {
      out += c;
      expectKey = c === ',' && stack[stack.length - 1] === 'o';
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      // A string, copied through; single quotes become double.
      let j = i + 1;
      let body = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          body += (src[j] ?? '') + (src[j + 1] ?? '');
          j += 2;
          continue;
        }
        body += c === "'" && src[j] === '"' ? '\\"' : (src[j] ?? '');
        j += 1;
      }
      let text = c === "'" ? body.replace(/\\'/g, "'") : body;
      i = j + 1;
      /* "m = " + m — a string and a value joined the way JavaScript joins them
         (MEASURED: the 4B's label for y = mx + c). It becomes the label that
         shows the value live: "m = {m}". */
      let k = i;
      while (k < n && /[ \t]/.test(src[k] ?? '')) k += 1;
      if (!expectKey && src[k] === '+') {
        for (;;) {
          while (k < n && /[ \t+]/.test(src[k] ?? '')) k += 1;
          const q = src[k];
          if (q === '"' || q === "'") {
            let m = k + 1;
            let part = '';
            while (m < n && src[m] !== q) {
              if (src[m] === '\\') {
                part += (src[m] ?? '') + (src[m + 1] ?? '');
                m += 2;
                continue;
              }
              part += q === "'" && src[m] === '"' ? '\\"' : (src[m] ?? '');
              m += 1;
            }
            text += part;
            k = m + 1;
          } else {
            let m = k;
            let depth = 0;
            while (m < n) {
              const d = src[m] ?? '';
              if (d === '(') depth += 1;
              else if (d === ')') depth -= 1;
              else if (depth <= 0 && /[+,}\]\n]/.test(d)) break;
              m += 1;
            }
            const expr = src
              .slice(k, m)
              .trim()
              .replace(/\.toFixed\(\d*\)|\.toPrecision\(\d*\)|\.toString\(\)/g, '');
            if (expr !== '') text += `{${JSON.stringify(expr).slice(1, -1)}}`;
            k = m;
          }
          let z = k;
          while (z < n && /[ \t]/.test(src[z] ?? '')) z += 1;
          if (src[z] !== '+') break;
          k = z;
        }
        i = k;
      }
      out += `"${text}"`;
      continue;
    }
    // A bare run: a key to its ':', a value to ',' '}' ']', a comment or the line's end.
    let j = i;
    let depth = 0;
    while (j < n) {
      const d = src[j] ?? '';
      if (d === '(') depth += 1;
      else if (d === ')') depth = Math.max(0, depth - 1);
      else if (
        depth === 0 &&
        (d === ',' ||
          d === '}' ||
          d === ']' ||
          d === '\n' ||
          (d === '/' && src[j + 1] === '/') ||
          (expectKey && d === ':'))
      ) {
        break;
      }
      j += 1;
    }
    if (j === i) {
      out += c;
      i += 1;
      continue;
    }
    const run = src.slice(i, j).trim();
    if (expectKey) out += JSON.stringify(run);
    else out += LITERAL.test(run) ? run : (PYTHON[run] ?? JSON.stringify(run));
    i = j;
  }
  return out;
}

/** The spec as the renderer reads it, from whatever the model wrote. */
export function normalizeMathSpec(input: unknown): MathSpec {
  let v: unknown = input;
  if (typeof v === 'string') {
    try {
      v = lenientJson(v);
    } catch (e) {
      throw new SpecError(`the spec is not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (!isObj(v)) throw new SpecError('the spec needs {"title", "plot" or "figure", "steps"}');
  const found = { any: false };
  v = scrub(v, found);
  if (!isObj(v)) throw new SpecError('the spec needs {"title", "plot" or "figure", "steps"}');
  /*
   * A NAME THE SPEC USES BUT NEVER DECLARES. MEASURED (the STEM suite, 4B): a
   * cube of side L — `"view": {"x": "0..L"}`, a molecule at `[L/2, L/2]` — and
   * `A*cos(omega*t)` with no sliders at all. Each such name is taken in turn,
   * and the spec read again: a time or an angle becomes a slider (it is what
   * an animation moves), anything else a value of 1 — the figure is drawn to
   * scale, and a note says what to declare.
   */
  const auto: string[] = [];
  for (let round = 0; ; round += 1) {
    try {
      return normalizeParsed(v, found, auto);
    } catch (e) {
      const name =
        e instanceof SpecError
          ? /"([A-Za-z_]\w*)" at \d+ is not a variable here/.exec(e.message)?.[1]
          : undefined;
      if (name === undefined || auto.includes(name) || round >= 8 || name === 'x' || name === 'y')
        throw e;
      auto.push(name);
    } finally {
      CONSTANTS = {};
      SLIDERS = [];
    }
  }
}

const AUTO_SLIDERS: Readonly<Record<string, { min: number; max: number }>> = {
  t: { min: 0, max: 10 },
  time: { min: 0, max: 10 },
  theta: { min: 0, max: 2 * Math.PI },
  phi: { min: 0, max: 2 * Math.PI },
  angle: { min: 0, max: 2 * Math.PI },
};

/** "cube_molecule" → "Cube molecule": a name written as an identifier, as a title. */
function asTitle(s: string): string {
  const t = /^[\w-]+$/.test(s) && /[_-]/.test(s) ? s.replace(/[_-]+/g, ' ').trim() : s;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function normalizeParsed(v: Loose, found: { any: boolean }, auto: readonly string[]): MathSpec {
  /* A title is what the page is called, not what makes it draw — MEASURED (the
     STEM suite, 4B): a spec with "name" and no "title" was refused for that
     first, and the real problem (no shapes at all) said only on the next try. */
  const named = str(v.title ?? v.name ?? v.heading ?? v.label);
  const title = named !== undefined ? asTitle(named) : undefined;
  const plotIn = isObj(v.plot)
    ? v.plot
    : isObj(v.graph)
      ? v.graph
      : v.curves !== undefined ||
          v.functions !== undefined ||
          v.equation !== undefined ||
          v.function !== undefined ||
          v.expression !== undefined ||
          v.expr !== undefined
        ? v
        : undefined;
  const figIn = isObj(v.figure)
    ? v.figure
    : isObj(v.diagram)
      ? v.diagram
      : v.shapes !== undefined
        ? v
        : undefined;
  if (plotIn === undefined && figIn === undefined) {
    /* Both shapes of answer, not only the smallest — MEASURED (the STEM suite,
       4B): asked for "an animation of a mass on a spring next to its graph",
       it copied the one example here, a sine curve, and nothing moved. */
    throw new SpecError(
      'the spec needs a "plot" (curves as expressions) or a "figure" (shapes), or both. ' +
        'A graph: {"title": "Sine", "plot": {"x": "-pi..pi", "curves": ["sin(x)"]}, "steps": [{"text": "…", "highlight": ["c1"]}]}. ' +
        'Something that moves — a slider t that Play runs, and shapes placed by it: ' +
        '{"title": "Circling", "params": ["t = 0 in 0..10"], "play": "t", "figure": {"view": {"x": "-3..3", "y": "-3..3"}, "shapes": [{"id": "ball", "kind": "circle", "center": ["2*cos(t)", "2*sin(t)"], "r": 0.3}]}, "steps": [{"text": "…", "highlight": ["ball"]}]}. ' +
        'Steps with no curve or figure to point at are text: write them in your reply',
    );
  }
  /* {"t": {"min": 0, "max": 5}, "g": 9.8} — sliders as a dictionary, name → range or value
     (MEASURED: the 4B's projectile). */
  const asList = (x: unknown): unknown[] =>
    isObj(x) && !('name' in x) && !('min' in x) && !('range' in x)
      ? Object.entries(x).map(([k, val]) =>
          isObj(val)
            ? { name: k, ...val }
            : typeof val === 'number'
              ? `${k} = ${val}`
              : typeof val === 'string' && /\.\.|\bto\b/.test(val)
                ? { name: k, range: val }
                : `${k} = ${String(val)}`,
        )
      : list(x);
  const paramsIn = [
    ...asList(v.params ?? v.sliders ?? v.parameters),
    ...(plotIn !== undefined && plotIn !== v ? asList(plotIn.params ?? plotIn.sliders) : []),
  ];
  const declared = paramsIn.map(param);
  const autoParams: Param[] = auto
    .filter((name) => !declared.some((p) => p.name === name))
    .map((name) => {
      const slide = AUTO_SLIDERS[name];
      return slide !== undefined
        ? {
            name,
            label: name,
            min: slide.min,
            max: slide.max,
            step: (slide.max - slide.min) / 400,
            value: slide.min,
          }
        : { name, label: name, min: 1, max: 1, step: 1, value: 1, hidden: true };
    });
  CONSTANTS = Object.fromEntries(
    autoParams.filter((p) => p.hidden === true).map((p) => [p.name, 1]),
  );
  const params = [...declared, ...autoParams];
  const seen = new Set<string>();
  for (const p of params) {
    if (seen.has(p.name)) throw new SpecError(`two sliders are named ${p.name}`);
    if (RESERVED.has(p.name) && p.name !== 't' && p.hidden !== true) {
      throw new SpecError(
        `a slider cannot be named ${p.name} — it means something already; call it ${p.name}0 or a`,
      );
    }
    seen.add(p.name);
  }
  const names = params.map((p) => p.name);
  SLIDERS = params;
  const viewNotes: string[] = [];
  let plotSpec: PlotSpec | undefined;
  try {
    plotSpec = plotIn !== undefined ? plot(plotIn, names) : undefined;
  } catch (e) {
    /* "curves": [] beside a figure — MEASURED (the 4B, Pythagoras): told a
       plot needs curves, it gave its empty one "t against t" ("stage
       progression"), a line that showed nothing beside the figure that was
       the whole lesson. An empty plot beside a figure is no plot. */
    if (!(e instanceof SpecError && figIn !== undefined && /^a plot needs curves/.test(e.message)))
      throw e;
    viewNotes.push('the plot had no curves, so the page is the figure alone');
  }
  // A slider with the plot's own name is "now" on that axis (t for time): curves use the axis, points the slider.
  const figSpec = figIn !== undefined ? figure(figIn, names, viewNotes) : undefined;
  const stepsRaw = v.steps ?? v.explanation ?? v.explain;
  // {"1": …, "2": …} — steps numbered as keys — read in their order.
  const stepsIn = isObj(stepsRaw) ? Object.values(stepsRaw) : list(stepsRaw);
  const steps: Step[] = stepsIn.map((s, i) => {
    if (typeof s === 'string') return { text: s, highlight: [], set: {} };
    if (!isObj(s)) throw new SpecError(`step ${i + 1} needs {text, highlight}`);
    const body = str(s.text ?? s.say ?? s.body ?? s.explanation ?? s.content ?? s.description);
    const head = str(s.title ?? s.heading);
    const text = body !== undefined && head !== undefined ? `**${head}.** ${body}` : (body ?? head);
    if (text === undefined) throw new SpecError(`step ${i + 1} needs its text`);
    const set: Record<string, Num> = {};
    for (const [k, val] of Object.entries(isObj(s.set) ? s.set : {}))
      set[k] = numOrExpr(val, `step ${i + 1} sets ${k}`, names);
    const nudgeIn = s.nudge ?? s.wiggle ?? s.jiggle;
    const nudge: Record<string, Num> = {};
    /* "set": [{"type": "nudge", "element": "m", "value": 2.5}] — the moves as a
       list of actions (MEASURED: the 4B's y = mx + c, every step). Each moves
       its slider there; one called a nudge or a wiggle then wiggles it too. */
    const acts = [
      ...(Array.isArray(s.set) ? s.set : []),
      ...(Array.isArray(s.actions) ? s.actions : []),
      ...(Array.isArray(s.animate) ? s.animate : []),
    ];
    for (const a of acts) {
      if (!isObj(a)) continue;
      const name = str(a.element ?? a.slider ?? a.param ?? a.name ?? a.target ?? a.id);
      const val = a.value ?? a.to ?? a.set;
      if (name === undefined || !names.includes(name) || val === undefined) continue;
      set[name] = numOrExpr(val, `step ${i + 1} sets ${name}`, names);
      if (/nudge|wiggle|jiggle|vary|sweep/i.test(str(a.type ?? a.kind ?? a.action) ?? '')) {
        const p = params.find((q) => q.name === name);
        if (p !== undefined) nudge[name] = (p.max - p.min) / 10;
      }
    }
    if (typeof nudgeIn === 'string' && names.includes(nudgeIn.trim())) {
      // "nudge": "A" — wiggle A by a tenth of its range.
      const p = [...params].find((q) => q.name === nudgeIn.trim());
      if (p !== undefined) nudge[p.name] = (p.max - p.min) / 10;
    } else {
      for (const [k, val] of Object.entries(isObj(nudgeIn) ? nudgeIn : {}))
        nudge[k] = numOrExpr(val, `step ${i + 1} nudges ${k}`, names);
    }
    return {
      text,
      // A highlight given as {"type": "highlighter", "text": "c1"} names its part in one of its fields.
      highlight: list(s.highlight ?? s.show ?? s.focus ?? s.points_at ?? s.refs)
        .map((h) =>
          isObj(h)
            ? str(h.id ?? h.part ?? h.target ?? h.element ?? h.ref ?? h.text ?? h.name)
            : String(h),
        )
        .filter((h): h is string => h !== undefined),
      set,
      ...(Object.keys(nudge).length > 0 ? { nudge } : {}),
    };
  });
  const playIn = str(v.play ?? v.animate);
  const caption = str(v.caption ?? v.subtitle);
  /* Steps that move nothing, beside a slider that plays — MEASURED (the 4B,
     projectile motion, round 5): "play": "t" and four steps without a "set",
     so the page told its story over a ball sitting at the launch point. The
     time the steps tell is the slider's: they take it from its start to its
     end, one stretch each, and the note says so. */
  // A slider no part uses would move nothing: it is not the story's time.
  const drawnText = JSON.stringify([v.figure ?? v.diagram ?? null, v.plot ?? v.graph ?? null]);
  const sliders = params.filter(
    (p) => p.hidden !== true && new RegExp(`\\b${p.name}\\b`).test(drawnText),
  );
  const player =
    playIn !== undefined && names.includes(playIn)
      ? sliders.find((p) => p.name === playIn)
      : sliders.length === 1
        ? sliders[0]
        : undefined;
  const still = steps.every(
    (st) => Object.keys(st.set).length === 0 && Object.keys(st.nudge ?? {}).length === 0,
  );
  const told =
    steps.length >= 2 && still && player !== undefined && player.max > player.min
      ? steps.map((st, k) => ({
          ...st,
          set: { [player.name]: player.min + ((player.max - player.min) * k) / (steps.length - 1) },
        }))
      : steps;
  if (told !== steps && player !== undefined)
    viewNotes.push(
      `no step moved anything, so the steps take ${player.name} from ${player.min} to ${player.max}, one stretch each — give each step a "set" to choose what it shows`,
    );
  return {
    title:
      title ??
      (figSpec !== undefined && plotSpec !== undefined
        ? 'Graph and figure'
        : figSpec !== undefined
          ? 'Figure'
          : 'Graph'),
    ...(caption !== undefined ? { caption } : {}),
    params,
    ...(plotSpec !== undefined ? { plot: plotSpec } : {}),
    ...(figSpec !== undefined ? { figure: figSpec } : {}),
    steps: told,
    ...(playIn !== undefined && names.includes(playIn) ? { play: playIn } : {}),
    tell: v.tell !== false && v.autoplay !== false,
    ...(declared.length > 0 && params.some((p) => p.hidden === true)
      ? { unvalued: params.filter((p) => p.hidden === true).map((p) => p.name) }
      : {}),
    notes: [
      ...(found.any ? ['emoji removed — the page carries none'] : []),
      ...(title === undefined
        ? ['the spec has no "title", so the page has a plain one — give it a "title"']
        : []),
      ...viewNotes,
      ...(() => {
        /* A name with no value in a spec that declares none is symbolic — a
           cube of side L, x(t) = A cos(ωt) — and 1 is its unit: a note. Among
           declared values it is a slip, and a check to fix (checks.ts). */
        const hidden = params.filter((p) => p.hidden === true).map((p) => p.name);
        const slid = params
          .filter((p) => auto.includes(p.name) && p.hidden !== true)
          .map((p) => p.name);
        const out: string[] = [];
        if (hidden.length > 0 && declared.length === 0) out.push(unvaluedText(hidden));
        if (slid.length > 0)
          out.push(
            `${slid.join(', ')} ${slid.length === 1 ? 'was' : 'were'} not declared, so ${slid.length === 1 ? 'it is a slider' : 'each is a slider'} (with Play)`,
          );
        return out;
      })(),
    ],
  };
}

/** What is said of names used with no value: each is drawn as 1, and how to give it one. */
export function unvaluedText(names: readonly string[]): string {
  const one = names.length === 1;
  return `${names.join(', ')} ${one ? 'has' : 'have'} no value in the spec, so ${one ? 'it is' : 'each is'} drawn as 1 — give ${one ? 'it a number' : 'them numbers'}, or make ${one ? 'it a slider' : 'them sliders'} ("${names[0]} = 2 in 1..4")`;
}

/** A rectangle's four corners from two opposite ones: {"from": [x0, y0], "to": [x1, y1]}. */
function cornersOf(a: unknown, b: unknown): { points: unknown[] } {
  const A = Array.isArray(a) ? a : [0, 0];
  const B = Array.isArray(b) ? b : [1, 1];
  return {
    points: [
      [A[0], A[1]],
      [B[0], A[1]],
      [B[0], B[1]],
      [A[0], B[1]],
    ],
  };
}
