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
export type Fill = 'none' | 'tint' | 'main' | 'second' | 'third' | 'shade';
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

export type Shape = Item &
  (
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
        readonly at: Xy;
        readonly size: Num;
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
  readonly shapes: readonly Shape[];
}

export interface Step {
  readonly text: string;
  /** Ids drawn at full strength while this step is read; the rest step back. */
  readonly highlight: readonly string[];
  /** Slider values this step moves to (animated). */
  readonly set: Readonly<Record<string, Num>>;
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
  const min = num(a, `${what} min`);
  const max = num(b, `${what} max`);
  if (!(max > min)) throw new SpecError(`${what}: its max (${max}) must be above its min (${min})`);
  return { min, max, pi: /pi|π/i.test(`${String(a)} ${String(b)}`) };
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
  const s = str(v)?.toLowerCase();
  if (s === undefined || s === 'false' || s === 'none') return 'none';
  if (['tint', 'main', 'second', 'third', 'shade'].includes(s)) return s as Fill;
  if (/grey|gray|shade|dark/.test(s)) return 'shade';
  return 'tint';
}
const appearOf = (v: Loose): number => {
  const a = get(v, 'appear', 'step', 'fromStep', 'showAt');
  return a === undefined ? 1 : Math.max(1, Math.round(num(a, 'appear')));
};

/** A slider: {name, min, max, value}, or "n = 5 in 1..25". */
function param(v: unknown, i: number): Param {
  if (typeof v === 'string') {
    const m = /^\s*([a-zA-Z_]\w*)\s*=\s*(\S+)\s+(?:in|from|over)\s+(.+)$/.exec(v);
    if (m === null) throw new SpecError(`slider ${i + 1}: write it as "n = 5 in 1..25"`);
    const r = range(m[3], `slider ${m[1]}`);
    return param({ name: m[1], value: m[2], min: r.min, max: r.max }, i);
  }
  if (!isObj(v)) throw new SpecError(`slider ${i + 1} needs {name, min, max, value}`);
  const name = str(v.name ?? v.id ?? v.var);
  if (name === undefined || !/^[a-zA-Z_]\w*$/.test(name)) {
    throw new SpecError(`slider ${i + 1} needs a name made of letters (like n, a, omega)`);
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
  const label = str(v.label) ?? name;
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
  const label = str(v.label ?? v.name);
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
      const label = str(p.label);
      const yPart =
        py !== undefined && py !== null && str(py) !== undefined
          ? { y: numOrExpr(py, `point ${id} y`, names) }
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
      const label = str(a.label);
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
      const label = str(t.label);
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
  if (!isObj(v)) throw new SpecError(`shape ${i + 1} needs {kind, …}`);
  const kind = str(v.kind ?? v.type ?? v.shape)?.toLowerCase();
  const id = str(v.id) ?? `s${i + 1}`;
  const label = str(v.label ?? v.text);
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
      const isVec = kind !== 'segment';
      return {
        id,
        appear,
        kind: isVec ? 'vector' : 'segment',
        from: at('from'),
        to: at('to'),
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
        const [x0, y0] = at('at' in v ? 'at' : 'from');
        const w = numOrExpr(v.w ?? v.width, `${id}.w`, names);
        const h = numOrExpr(v.h ?? v.height, `${id}.h`, names);
        const add = (a: Num, b: Num): Num =>
          typeof a === 'number' && typeof b === 'number' ? a + b : `(${a})+(${b})`;
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
    case 'polygon':
    case 'triangle':
    case 'square':
      return polygonShape();
    case 'polyline':
    case 'path':
    case 'curve':
    case 'trajectory':
    case 'track': {
      const ptsIn = v.points ?? v.vertices ?? v.through;
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
    case 'box': {
      const size = numOrExpr(v.size ?? v.side ?? 4, `${id}.size`, names);
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
        at: 'at' in v ? at('at') : [0, 0],
        size,
        depth:
          v.depth !== undefined
            ? numOrExpr(v.depth, `${id}.depth`, names)
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
    default:
      throw new SpecError(
        `shape ${id}: kind "${kind ?? ''}" is not one of point, segment, vector, polygon, polyline, rect, circle, angle, dimension, label, box3d, spring`,
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

function figure(v: Loose, names: readonly string[]): FigureSpec {
  const viewIn = isObj(v.view) ? v.view : v;
  const x = range(viewIn.x ?? get(v, 'xRange') ?? [0, 10], 'figure x');
  const y = range(viewIn.y ?? get(v, 'yRange') ?? [0, 10], 'figure y');
  // A depth range widens the frame by what depth adds in the oblique view.
  if (viewIn.z !== undefined) {
    const z = range(viewIn.z, 'figure z');
    x.max += 0.8 * Math.max(0, z.max);
    x.min += 0.8 * Math.min(0, z.min);
    y.max += 0.55 * Math.max(0, z.max);
    y.min += 0.55 * Math.min(0, z.min);
  }
  const shapesIn = list(v.shapes ?? v.elements ?? v.items ?? v.objects ?? v.parts);
  if (shapesIn.length === 0) throw new SpecError('a figure needs shapes');
  const named = new Map<string, Xy>();
  return {
    x: [x.min, x.max],
    y: [y.min, y.max],
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
      out += `"${c === "'" ? body.replace(/\\'/g, "'") : body}"`;
      i = j + 1;
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

function normalizeParsed(v: Loose, found: { any: boolean }, auto: readonly string[]): MathSpec {
  const title = str(v.title);
  if (title === undefined) {
    throw new SpecError(
      'the spec needs a "title" — the smallest whole spec: {"title": "Sine", "plot": {"x": "-pi..pi", "curves": ["sin(x)"]}, "steps": [{"text": "…", "highlight": ["c1"]}]}',
    );
  }
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
    throw new SpecError(
      'the spec needs a "plot" (curves as expressions) or a "figure" (shapes), or both — the smallest: ' +
        '{"title": "Sine", "plot": {"x": "-pi..pi", "curves": ["sin(x)"]}, "steps": [{"text": "…", "highlight": ["c1"]}]}. ' +
        'Steps with no curve or figure to point at are text: write them in your reply',
    );
  }
  const paramsIn = [
    ...list(v.params ?? v.sliders),
    ...(plotIn !== undefined && plotIn !== v ? list(plotIn.params ?? plotIn.sliders) : []),
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
  const plotSpec = plotIn !== undefined ? plot(plotIn, names) : undefined;
  // A slider with the plot's own name is "now" on that axis (t for time): curves use the axis, points the slider.
  const figSpec = figIn !== undefined ? figure(figIn, names) : undefined;
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
    return {
      text,
      highlight: list(s.highlight ?? s.show ?? s.focus ?? s.points_at ?? s.refs).map((h) =>
        String(h),
      ),
      set,
    };
  });
  const playIn = str(v.play ?? v.animate);
  const caption = str(v.caption ?? v.subtitle);
  return {
    title,
    ...(caption !== undefined ? { caption } : {}),
    params,
    ...(plotSpec !== undefined ? { plot: plotSpec } : {}),
    ...(figSpec !== undefined ? { figure: figSpec } : {}),
    steps,
    ...(playIn !== undefined && names.includes(playIn) ? { play: playIn } : {}),
    notes: [
      ...(found.any ? ['emoji removed — the page carries none'] : []),
      ...(() => {
        const hidden = params.filter((p) => p.hidden === true).map((p) => p.name);
        const slid = params
          .filter((p) => auto.includes(p.name) && p.hidden !== true)
          .map((p) => p.name);
        const out: string[] = [];
        if (hidden.length > 0) {
          out.push(
            `${hidden.join(', ')} ${hidden.length === 1 ? 'has' : 'have'} no value in the spec, so ${hidden.length === 1 ? 'it is' : 'each is'} drawn as 1 — give ${hidden.length === 1 ? 'it a number' : 'them numbers'}, or make ${hidden.length === 1 ? 'it a slider' : 'them sliders'} ("${hidden[0]} = 2 in 1..4")`,
          );
        }
        if (slid.length > 0)
          out.push(
            `${slid.join(', ')} ${slid.length === 1 ? 'was' : 'were'} not declared, so ${slid.length === 1 ? 'it is a slider' : 'each is a slider'} (with Play)`,
          );
        return out;
      })(),
    ],
  };
}
