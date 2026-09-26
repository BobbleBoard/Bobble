/**
 * What the page and the checks share, worked out once in Node: every
 * expression compiled (a function here, the same JS as text for the page), a
 * steady y-range, and the values the page opens on.
 */
import { type Node, parse, toJs } from './expr.js';
import { type Evaluators, mvAnchors, mvEval, mvNiceStep, type Values } from './runtime.js';
import type { MathSpec, Num, Param } from './spec.js';

export interface Compiled {
  /** Source → JS expression over `s`. */
  readonly js: ReadonlyMap<string, string>;
  /** Source → the function (Node's copy of the page's). */
  readonly E: Evaluators;
  /** Every variable name each expression reads. */
  readonly reads: ReadonlyMap<string, ReadonlySet<string>>;
}

function namesIn(node: Node, out: Set<string>, bound: ReadonlySet<string> = new Set()): void {
  switch (node.k) {
    case 'var':
      if (!bound.has(node.n)) out.add(node.n);
      return;
    case 'num':
      return;
    case 'neg':
      namesIn(node.a, out, bound);
      return;
    case 'bin':
    case 'cmp':
      namesIn(node.a, out, bound);
      namesIn(node.b, out, bound);
      return;
    case 'call':
      for (const a of node.args) namesIn(a, out, bound);
      return;
    case 'if':
      namesIn(node.c, out, bound);
      namesIn(node.a, out, bound);
      namesIn(node.b, out, bound);
      return;
    case 'series': {
      namesIn(node.from, out, bound);
      namesIn(node.to, out, bound);
      namesIn(node.term, out, new Set([...bound, node.v]));
      return;
    }
  }
}

/** Every expression the spec draws with, and the names each may read. */
export function expressionsOf(spec: MathSpec): Map<string, Set<string>> {
  const P = spec.params.map((p) => p.name);
  const out = new Map<string, Set<string>>();
  const add = (v: Num | undefined, names: readonly string[]) => {
    if (typeof v !== 'string') return;
    const set = out.get(v) ?? new Set<string>();
    for (const n of names) set.add(n);
    out.set(v, set);
  };
  const labels = (text: string | undefined, extra: readonly string[]) => {
    if (text === undefined) return;
    for (const m of text.matchAll(/\{([^{}]+)\}/g)) {
      const inner = (m[1] ?? '').trim();
      try {
        parse(inner, [...P, ...extra]);
        add(inner, [...P, ...extra]);
      } catch {
        // Not an expression — a word in braces stays as written.
      }
    }
  };
  const plot = spec.plot;
  if (plot !== undefined) {
    for (const c of plot.curves) {
      add(c.expr, [plot.v, ...P]);
      add(c.px, ['t', ...P]);
      add(c.py, ['t', ...P]);
      add(c.t?.[0], P);
      add(c.t?.[1], P);
      labels(c.label, []);
    }
    for (const p of plot.points) {
      add(p.x, P);
      add(p.y, [plot.v, ...P]);
      labels(p.label, []);
    }
    for (const a of plot.areas) {
      add(a.from, P);
      add(a.to, P);
      labels(a.label, []);
    }
    for (const t of plot.tangents) {
      add(t.at, P);
      labels(t.label, ['m', plot.v]);
    }
    for (const r of plot.riemann) {
      add(r.from, P);
      add(r.to, P);
      add(r.n, P);
    }
  }
  for (const sh of spec.figure?.shapes ?? []) {
    const xy = (p: readonly [Num, Num]) => {
      add(p[0], P);
      add(p[1], P);
    };
    add(sh.opacity, P);
    switch (sh.kind) {
      case 'point':
        xy(sh.at);
        labels(sh.label, []);
        break;
      case 'segment':
      case 'vector':
      case 'spring':
        xy(sh.from);
        xy(sh.to);
        labels(sh.label, []);
        break;
      case 'polygon':
      case 'polyline':
        for (const p of sh.points) xy(p);
        labels(sh.label, []);
        break;
      case 'circle':
        xy(sh.center);
        add(sh.r, P);
        labels(sh.label, []);
        break;
      case 'angle':
        xy(sh.at);
        xy(sh.from);
        xy(sh.to);
        labels(sh.label, []);
        break;
      case 'dimension':
        xy(sh.from);
        xy(sh.to);
        labels(sh.label, []);
        break;
      case 'label':
        xy(sh.at);
        labels(sh.text, []);
        break;
      case 'box3d':
        xy(sh.at);
        add(sh.w, P);
        add(sh.h, P);
        add(sh.depth, P);
        break;
      case 'curve':
        add(sh.x, [...P, sh.over]);
        add(sh.y, [...P, sh.over]);
        add(sh.from, P);
        add(sh.to, P);
        labels(sh.label, []);
        break;
    }
  }
  for (const st of spec.steps) {
    for (const v of Object.values(st.set)) add(v, P);
    for (const v of Object.values(st.nudge ?? {})) add(v, P);
  }
  return out;
}

export function compileSpec(spec: MathSpec): Compiled {
  const js = new Map<string, string>();
  const E: Record<string, (s: Record<string, number>) => number> = {};
  const reads = new Map<string, ReadonlySet<string>>();
  for (const [src, names] of expressionsOf(spec)) {
    const tree = parse(src, [...names]);
    const code = toJs(tree);
    js.set(src, code);
    // The page's own text, run here: what the checks measure is what the reader sees.
    E[src] = new Function('s', `return ${code};`) as (s: Record<string, number>) => number;
    const used = new Set<string>();
    namesIn(tree, used);
    reads.set(src, used);
  }
  return { js, E, reads };
}

/** The page's `E` table as script text: source → function(s) { return …; }. */
export function evaluatorsScript(c: Compiled): string {
  const parts = [...c.js].map(
    ([src, code]) => `${JSON.stringify(src)}:function(s){return ${code};}`,
  );
  return `{${parts.join(',')}}`;
}

/** The values the page opens on: each slider's own, then step 1's. */
export function startValues(spec: MathSpec, E: Evaluators): Values {
  const v: Values = {};
  for (const p of spec.params) v[p.name] = p.value;
  const first = spec.steps[0];
  if (first !== undefined) {
    for (const [name, val] of Object.entries(first.set)) {
      const p = spec.params.find((q) => q.name === name);
      const n = mvEval(E, val, v);
      if (p !== undefined && Number.isFinite(n)) v[name] = Math.max(p.min, Math.min(p.max, n));
    }
  }
  return v;
}

/** The values after steps 1…k in order — the state a reader stepping through reaches. */
export function valuesAtStep(spec: MathSpec, E: Evaluators, k: number): Values {
  const v: Values = {};
  for (const p of spec.params) v[p.name] = p.value;
  for (let i = 0; i < k; i += 1) {
    for (const [name, val] of Object.entries(spec.steps[i]?.set ?? {})) {
      const p = spec.params.find((q) => q.name === name);
      const n = mvEval(E, val, v);
      if (p !== undefined && Number.isFinite(n)) v[name] = Math.max(p.min, Math.min(p.max, n));
    }
  }
  return v;
}

/** Slider settings to sample a plot's range over: every mix of each one's min, value and max (few sliders), or one at a time. */
function settings(params: readonly Param[]): Values[] {
  const base: Values = {};
  for (const p of params) base[p.name] = p.value;
  if (params.length <= 3) {
    let out: Values[] = [base];
    for (const p of params) {
      const next: Values[] = [];
      for (const v of out)
        for (const x of [p.min, p.value, p.max]) next.push({ ...v, [p.name]: x });
      out = next;
    }
    return out;
  }
  const out: Values[] = [base];
  for (const p of params) {
    out.push({ ...base, [p.name]: p.min });
    out.push({ ...base, [p.name]: p.max });
  }
  return out;
}

/**
 * The states the page's telling passes through: step 1's values (where it
 * opens), each later step's, the moves between them at quarters, and each
 * nudge's two ends. With no steps, the sliders' own values.
 */
export function toldStates(spec: MathSpec, E: Evaluators): Values[] {
  const n = spec.steps.length;
  let prev = valuesAtStep(spec, E, Math.min(1, n));
  const out: Values[] = [prev];
  for (let k = 1; k <= n; k += 1) {
    const next = valuesAtStep(spec, E, k);
    if (k > 1) {
      for (const q of [0.25, 0.5, 0.75, 1]) {
        const mid: Values = {};
        for (const [name, v] of Object.entries(next))
          mid[name] = (prev[name] ?? v) * (1 - q) + v * q;
        out.push(mid);
      }
    }
    for (const [name, amount] of Object.entries(spec.steps[k - 1]?.nudge ?? {})) {
      const p = spec.params.find((q) => q.name === name);
      const d = Math.abs(mvEval(E, amount, next));
      if (p === undefined || !Number.isFinite(d)) continue;
      for (const sign of [-1, 1]) {
        const v = (next[name] ?? p.value) + sign * d;
        out.push({ ...next, [name]: Math.max(p.min, Math.min(p.max, v)) });
      }
    }
    prev = next;
  }
  return out;
}

/**
 * Where a plot's y-range is sampled. A slider the steps drive is taken where
 * the telling takes it — MEASURED (the 4B's y = mx + c): m and c in −5..5
 * over x in −10..10 gave a frame of −60..100, and the lines the steps showed
 * (m = 3, then 2) lay nearly flat along it. A steep line leaving through the
 * top when the reader drags m to 5 is how graph paper behaves; so is a slider
 * the steps leave alone, taken where they leave it.
 */
function plotStates(spec: MathSpec, E: Evaluators): Values[] {
  const driven = new Set<string>();
  for (const st of spec.steps) {
    for (const name of Object.keys(st.set)) driven.add(name);
    for (const name of Object.keys(st.nudge ?? {})) driven.add(name);
  }
  if (driven.size === 0) return settings(spec.params);
  /* Where the telling goes, with the other sliders where it leaves them —
     MEASURED (the 4B's projectile, round 7): the far ends of the reader's
     speed and angle sliders put the frame at −75..25, and the flight the
     steps told was a ripple along its top. A curve that runs off the frame
     when the reader drags a slider to its end is graph paper's way. */
  return toldStates(spec, E);
}

/**
 * Every state a reader can reach: each slider's own value, every step's, and
 * each slider swept across its range with the rest at theirs (a motion's far
 * point is inside a range, not at its ends: A·cos(πt) is at −A when t = 1).
 */
function reachable(spec: MathSpec, E: Evaluators): Values[] {
  const out: Values[] = [...settings(spec.params)];
  for (let k = 0; k <= spec.steps.length; k += 1) out.push(valuesAtStep(spec, E, k));
  const base = valuesAtStep(spec, E, 0);
  for (const p of spec.params) {
    if (p.hidden === true || !(p.max > p.min)) continue;
    for (let q = 0; q <= 48; q += 1)
      out.push({ ...base, [p.name]: p.min + ((p.max - p.min) * q) / 48 });
  }
  return out;
}

interface PartPoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Every point the figure's parts are drawn through, in these states, with the part's id. */
function partPoints(spec: MathSpec, E: Evaluators, states: readonly Values[]): PartPoint[] {
  const fig = spec.figure;
  const out: PartPoint[] = [];
  if (fig !== undefined) {
    for (const v of states) {
      const s: Record<string, number> = { ...v };
      for (const sh of fig.shapes) {
        const put = (x: number, y: number) => {
          if (Number.isFinite(x) && Number.isFinite(y)) out.push({ id: sh.id, x, y });
        };
        const at = (p: readonly [Num, Num]) => put(mvEval(E, p[0], s), mvEval(E, p[1], s));
        switch (sh.kind) {
          case 'point':
          case 'label':
          case 'angle':
            at(sh.at);
            break;
          case 'segment':
          case 'vector':
          case 'spring':
          case 'dimension':
            at(sh.from);
            at(sh.to);
            break;
          case 'polygon':
          case 'polyline':
            for (const p of sh.points) at(p);
            break;
          case 'circle': {
            const cx = mvEval(E, sh.center[0], s);
            const cy = mvEval(E, sh.center[1], s);
            const r = Math.abs(mvEval(E, sh.r, s));
            if (Number.isFinite(r)) {
              put(cx - r, cy - r);
              put(cx + r, cy + r);
            }
            break;
          }
          case 'curve': {
            const a0 = mvEval(E, sh.from, s);
            const a1 = mvEval(E, sh.to, s);
            if (!Number.isFinite(a0) || !Number.isFinite(a1)) break;
            for (let q = 0; q <= 40; q += 1) {
              const sc = { ...s, [sh.over]: a0 + ((a1 - a0) * q) / 40 };
              put(mvEval(E, sh.x, sc), mvEval(E, sh.y, sc));
            }
            break;
          }
          case 'box3d': {
            const a = mvEval(E, sh.at[0], s);
            const b = mvEval(E, sh.at[1], s);
            const w = mvEval(E, sh.w, s);
            const h = mvEval(E, sh.h, s);
            const d = mvEval(E, sh.depth, s);
            put(a, b);
            put(a + w + 0.8 * Math.max(0, d), b + h + 0.55 * Math.max(0, d));
            put(a + 0.8 * Math.min(0, d), b + 0.55 * Math.min(0, d));
            break;
          }
        }
      }
    }
  }
  return out;
}

type View = { x: [number, number]; y: [number, number] };

/** The frame around these points, padded so a label beside an edge part still fits. */
function frameOf(pts: readonly PartPoint[]): View {
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const span = (lo: number, hi: number, other: number): [number, number] => {
    if (!(hi >= lo)) return [0, 10];
    if (hi - lo < 1e-9) {
      const half = other > 1e-9 ? other / 2 : 1;
      lo -= half;
      hi += half;
    }
    const pad = (hi - lo) * 0.12;
    return [lo - pad, hi + pad];
  };
  const wx = x1 >= x0 ? x1 - x0 : 0;
  const wy = y1 >= y0 ? y1 - y0 : 0;
  return { x: span(x0, x1, wy), y: span(y0, y1, wx) };
}

/**
 * A figure's view from its shapes, for the axes the spec gave no range for:
 * every point any shape is drawn through, in every reachable state, padded so
 * a label beside an edge part still fits. The frame then holds still while
 * the sliders move, like the plot's y-range.
 */
export function fittedView(spec: MathSpec, E: Evaluators): View {
  return frameOf(partPoints(spec, E, reachable(spec, E)));
}

/**
 * The view a spec gave, widened to hold every part at every state the telling
 * shows — or null when it holds them. MEASURED (the 4B, four pages of six):
 * the mass on the spring under the view's floor at step 1 (view y 0..200, the
 * mass at −60), the squares on a triangle's legs at x = −120 in a view from
 * −80, the ball underground at the steps after it lands. A part the words
 * talk about, off the page, is a page that does not explain. The frame the
 * spec chose is grown to hold them — or, when it hardly overlaps them, the
 * parts' own frame is used.
 */
export function heldView(spec: MathSpec, E: Evaluators): (View & { left: string[] }) | null {
  const fig = spec.figure;
  if (fig === undefined) return null;
  /* Objects, not lines: a tangent drawn from x = −1000 to 1000 is meant to
     run off the edges, and a curve or an arrow leaves with what it belongs
     to. Nor an object more than a view's width beyond the view — a slip of
     the pen, which widening would shrink everything else to show; that one
     is said as off the view. */
  const objects = new Set(
    fig.shapes
      .filter((sh) => !['segment', 'vector', 'dimension', 'curve', 'polyline'].includes(sh.kind))
      .map((sh) => sh.id),
  );
  const [x0, x1] = fig.x;
  const [y0, y1] = fig.y;
  const wx = x1 - x0;
  const wy = y1 - y0;
  const pts = partPoints(spec, E, toldStates(spec, E)).filter(
    (p) => objects.has(p.id) && p.x > x0 - wx && p.x < x1 + wx && p.y > y0 - wy && p.y < y1 + wy,
  );
  const left = new Set<string>();
  // Which sides the parts leave by: only those move.
  const by = { l: false, r: false, b: false, t: false };
  for (const p of pts) {
    const out = {
      l: p.x < x0 - wx * 0.01,
      r: p.x > x1 + wx * 0.01,
      b: p.y < y0 - wy * 0.01,
      t: p.y > y1 + wy * 0.01,
    };
    if (out.l || out.r || out.b || out.t) left.add(p.id);
    by.l ||= out.l;
    by.r ||= out.r;
    by.b ||= out.b;
    by.t ||= out.t;
  }
  if (left.size === 0) return null;
  const fitted = frameOf(pts);
  const grown: View = {
    x: [by.l ? fitted.x[0] : x0, by.r ? fitted.x[1] : x1],
    y: [by.b ? fitted.y[0] : y0, by.t ? fitted.y[1] : y1],
  };
  const area = (v: View) => (v.x[1] - v.x[0]) * (v.y[1] - v.y[0]);
  return { ...(area(grown) > 4 * area(fitted) ? fitted : grown), left: [...left] };
}

/** Is (x, y) inside the polygon — strictly, by the even–odd rule? */
function inPolygon(x: number, y: number, poly: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = [poly[i]?.[0] ?? 0, poly[i]?.[1] ?? 0];
    const [xj, yj] = [poly[j]?.[0] ?? 0, poly[j]?.[1] ?? 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The solid areas that are ground to the rest of the figure: over a quarter
 * of the view, or with another part standing on them where both show, at any
 * step. They are drawn in their pale tint for the whole page — MEASURED (the
 * 4B's Pythagoras): a solid blue square across 40% of the figure, the four
 * triangles and their labels lost on it. A part that stands there only while
 * hidden (a square that fades in where a triangle slid away) does not count.
 */
export function groundIds(spec: MathSpec, E: Evaluators): string[] {
  const fig = spec.figure;
  if (fig === undefined) return [];
  const viewArea = (fig.x[1] - fig.x[0]) * (fig.y[1] - fig.y[0]);
  const solid = fig.shapes.filter(
    (sh) =>
      sh.kind === 'polygon' && (sh.fill === 'main' || sh.fill === 'second' || sh.fill === 'third'),
  );
  const out = new Set<string>();
  const n = Math.max(1, spec.steps.length);
  for (let k = 1; k <= n; k += 1) {
    const s: Record<string, number> = { ...valuesAtStep(spec, E, k) };
    const shown = (id: string) => {
      const sh = fig.shapes.find((q) => q.id === id);
      if (sh === undefined || sh.appear > k) return false;
      return sh.opacity === undefined || mvEval(E, sh.opacity, s) >= 0.5;
    };
    const objects = mvAnchors(spec, E, s, k).filter((o) => o.panel === 'figure' && shown(o.id));
    for (const sh of solid) {
      if (sh.kind !== 'polygon' || !shown(sh.id)) continue;
      const poly = sh.points.map((p) => [mvEval(E, p[0], s), mvEval(E, p[1], s)]);
      if (poly.flat().some((v) => !Number.isFinite(v))) continue;
      let twice = 0;
      for (let i = 0; i < poly.length; i += 1) {
        const [a, b] = poly[i] ?? [0, 0];
        const [c, e] = poly[(i + 1) % poly.length] ?? [0, 0];
        twice += (a ?? 0) * (e ?? 0) - (c ?? 0) * (b ?? 0);
      }
      if (
        Math.abs(twice) / 2 > 0.25 * viewArea ||
        objects.some((o) => o.id !== sh.id && inPolygon(o.x, o.y, poly))
      )
        out.add(sh.id);
    }
  }
  return [...out];
}

/** A plot's values in one state: each curve's y at n + 1 steps across its range, and each point's y. */
function plotValues(
  spec: MathSpec,
  E: Evaluators,
  v: Values,
  n: number,
): { curves: { id: string; ys: number[] }[]; points: { id: string; y: number }[] } {
  const plot = spec.plot;
  const out = {
    curves: [] as { id: string; ys: number[] }[],
    points: [] as { id: string; y: number }[],
  };
  if (plot === undefined) return out;
  for (const c of plot.curves) {
    const s: Record<string, number> = { ...v };
    const t0 = mvEval(E, c.t?.[0], s);
    const t1 = mvEval(E, c.t?.[1], s);
    const ys: number[] = [];
    for (let k = 0; k <= n; k += 1) {
      if (c.expr !== undefined) {
        s[plot.v] = plot.x.min + ((plot.x.max - plot.x.min) * k) / n;
        ys.push(mvEval(E, c.expr, s));
      } else {
        s.t = t0 + ((t1 - t0) * k) / n;
        ys.push(mvEval(E, c.py, s));
      }
    }
    out.curves.push({ id: c.id, ys });
  }
  for (const p of plot.points) {
    if (p.y === undefined) continue;
    out.points.push({ id: p.id, y: mvEval(E, p.y, { ...v, [plot.v]: mvEval(E, p.x, v) }) });
  }
  return out;
}

/**
 * Whether a y-range the spec gave misses its curves — no curve mostly inside
 * it at the states the steps show — with the curves' ids, or null when it
 * holds half of one. MEASURED (the 4B, simple harmonic motion): "y": "-1.2..1.2" for
 * A·cos(ωt) with A = 80, a plot of an empty grid with the curve's name in its
 * key; the derivative's "-2..2" for x² over −4..4. A range that holds one
 * curve and lets another run off the top (a height, and a distance growing
 * past it) is the author's choice, and kept; so is tan x in −5..5.
 */
export function yRangeMisses(spec: MathSpec, E: Evaluators): string[] | null {
  const plot = spec.plot;
  if (plot === undefined || plot.y.min === undefined || plot.y.max === undefined) return null;
  const lo = plot.y.min;
  const hi = plot.y.max;
  const tol = (hi - lo) * 0.02;
  const inside = new Map<string, { in: number; all: number }>();
  for (const v of toldStates(spec, E)) {
    for (const c of plotValues(spec, E, v, 120).curves) {
      const n = inside.get(c.id) ?? { in: 0, all: 0 };
      for (const y of c.ys) {
        if (!Number.isFinite(y)) continue;
        n.all += 1;
        if (y >= lo - tol && y <= hi + tol) n.in += 1;
      }
      inside.set(c.id, n);
    }
  }
  const drawn = [...inside].filter(([, n]) => n.all > 0);
  if (drawn.length === 0 || drawn.some(([, n]) => n.in >= 0.5 * n.all)) return null;
  return drawn.map(([id]) => id);
}

/**
 * A y-range that holds still while the sliders move: every curve sampled over
 * the slider settings, the outer 2% dropped when a curve runs to infinity (tan
 * near π/2) so the rest is not squashed flat, zero kept in view when it is
 * near, padded, and squared to the tick step.
 */
export function steadyYRange(
  spec: MathSpec,
  E: Evaluators,
): { min: number; max: number; clipped: boolean } {
  if (spec.plot === undefined) return { min: -1, max: 1, clipped: false };
  const ys: number[] = [];
  for (const v of plotStates(spec, E)) {
    const at = plotValues(spec, E, v, 240);
    for (const c of at.curves) for (const y of c.ys) if (Number.isFinite(y)) ys.push(y);
    for (const p of at.points) if (Number.isFinite(p.y)) ys.push(p.y);
  }
  if (ys.length === 0) return { min: -1, max: 1, clipped: false };
  ys.sort((a, b) => a - b);
  const q = (f: number) =>
    ys[Math.min(ys.length - 1, Math.max(0, Math.round(f * (ys.length - 1))))] ?? 0;
  let lo = ys[0] ?? 0;
  let hi = ys[ys.length - 1] ?? 0;
  let clipped = false;
  const inner = q(0.98) - q(0.02);
  if (inner > 0 && hi - lo > 6 * inner) {
    lo = q(0.02);
    hi = q(0.98);
    clipped = true;
  }
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  if (lo > 0 && lo < span * 0.35) lo = 0;
  if (hi < 0 && -hi < span * 0.35) hi = 0;
  const pad = (hi - lo) * 0.08;
  lo -= lo === 0 ? 0 : pad;
  hi += hi === 0 ? 0 : pad;
  // Squared to a tick step — the finer of two when it wastes less (−150..150, not −200..200, for ±130).
  const squared = [5, 7].map((n) => {
    const step = mvNiceStep(hi - lo, n);
    return [Math.floor(lo / step - 1e-9) * step, Math.ceil(hi / step + 1e-9) * step] as const;
  });
  const [min, max] = squared.reduce((a, b) => (b[1] - b[0] < a[1] - a[0] ? b : a));
  return { min, max, clipped };
}
