/**
 * What the page and the checks share, worked out once in Node: every
 * expression compiled (a function here, the same JS as text for the page), a
 * steady y-range, and the values the page opens on.
 */
import { type Node, parse, toJs } from './expr.js';
import { type Evaluators, mvEval, mvNiceStep, type Values } from './runtime.js';
import type { MathSpec, Num } from './spec.js';

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
      add(p.y, P);
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
    }
  }
  for (const st of spec.steps) for (const v of Object.values(st.set)) add(v, P);
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
function settings(spec: MathSpec): Values[] {
  const base: Values = {};
  for (const p of spec.params) base[p.name] = p.value;
  if (spec.params.length <= 3) {
    let out: Values[] = [base];
    for (const p of spec.params) {
      const next: Values[] = [];
      for (const v of out)
        for (const x of [p.min, p.value, p.max]) next.push({ ...v, [p.name]: x });
      out = next;
    }
    return out;
  }
  const out: Values[] = [base];
  for (const p of spec.params) {
    out.push({ ...base, [p.name]: p.min });
    out.push({ ...base, [p.name]: p.max });
  }
  return out;
}

/**
 * Every state a reader can reach: each slider's own value, every step's, and
 * each slider swept across its range with the rest at theirs (a motion's far
 * point is inside a range, not at its ends: A·cos(πt) is at −A when t = 1).
 */
function reachable(spec: MathSpec, E: Evaluators): Values[] {
  const out: Values[] = [...settings(spec)];
  for (let k = 0; k <= spec.steps.length; k += 1) out.push(valuesAtStep(spec, E, k));
  const base = valuesAtStep(spec, E, 0);
  for (const p of spec.params) {
    if (p.hidden === true || !(p.max > p.min)) continue;
    for (let q = 0; q <= 48; q += 1)
      out.push({ ...base, [p.name]: p.min + ((p.max - p.min) * q) / 48 });
  }
  return out;
}

/**
 * A figure's view from its shapes, for the axes the spec gave no range for:
 * every point any shape is drawn through, in every reachable state, padded so
 * a label beside an edge part still fits. The frame then holds still while
 * the sliders move, like the plot's y-range.
 */
export function fittedView(
  spec: MathSpec,
  E: Evaluators,
): { x: [number, number]; y: [number, number] } {
  const fig = spec.figure;
  const xs: number[] = [];
  const ys: number[] = [];
  if (fig !== undefined) {
    for (const v of reachable(spec, E)) {
      const s: Record<string, number> = { ...v };
      const put = (x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        xs.push(x);
        ys.push(y);
      };
      const at = (p: readonly [Num, Num]) => put(mvEval(E, p[0], s), mvEval(E, p[1], s));
      for (const sh of fig.shapes) {
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
  const span = (vals: number[], other: number): [number, number] => {
    if (vals.length === 0) return [0, 10];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < 1e-9) {
      const half = other > 1e-9 ? other / 2 : 1;
      lo -= half;
      hi += half;
    }
    const pad = (hi - lo) * 0.12;
    return [lo - pad, hi + pad];
  };
  const wx = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;
  const wy = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : 0;
  return { x: span(xs, wy), y: span(ys, wx) };
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
  const plot = spec.plot;
  if (plot === undefined) return { min: -1, max: 1, clipped: false };
  const ys: number[] = [];
  for (const v of settings(spec)) {
    const s: Record<string, number> = { ...v };
    for (const c of plot.curves) {
      const t0 = mvEval(E, c.t?.[0], s);
      const t1 = mvEval(E, c.t?.[1], s);
      for (let k = 0; k <= 240; k += 1) {
        let y: number;
        if (c.expr !== undefined) {
          s[plot.v] = plot.x.min + ((plot.x.max - plot.x.min) * k) / 240;
          y = mvEval(E, c.expr, s);
        } else {
          s.t = t0 + ((t1 - t0) * k) / 240;
          y = mvEval(E, c.py, s);
        }
        if (Number.isFinite(y)) ys.push(y);
      }
      Object.assign(s, v);
      delete s[plot.v];
      delete s.t;
      Object.assign(s, v);
    }
    for (const p of plot.points) {
      if (p.y === undefined) continue;
      const y = mvEval(E, p.y, s);
      if (Number.isFinite(y)) ys.push(y);
    }
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
  const step = mvNiceStep(hi - lo, 5);
  return {
    min: Math.floor(lo / step - 1e-9) * step,
    max: Math.ceil(hi / step + 1e-9) * step,
    clipped,
  };
}
