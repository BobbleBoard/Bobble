/**
 * THE RENDERER — one set of functions that runs in two places.
 *
 * In Node it lays out every state of a math visual so the checks can measure
 * it (labels on labels, a point off the figure, a curve with no values). In
 * the page it draws the same layout live as a slider moves or a step is read.
 * The page does not get a second, hand-kept copy: `runtimeSource()` writes
 * these very functions into the page's script (`Function.prototype.toString`).
 *
 * So the rules for this file: plain `function` declarations only, calling one
 * another and nothing else — no imports, no module-level constants (a bundler
 * could rename them where the page would not follow), no classes. Types are
 * fine; they are gone before the text is read. `runtime.test.ts` runs the
 * written-out source in an empty VM context to hold that line.
 */

import type {
  Box,
  Drawable,
  PageDoc,
  PageEl,
  PageEvent,
  PageWin,
  Panel,
  Scene,
} from './scene-types.js';
import type { MathSpec, Num, Role, Shape } from './spec.js';

export type Evaluators = Readonly<Record<string, (s: Record<string, number>) => number>>;
export type Values = Record<string, number>;

// ── numbers and words ───────────────────────────────────────────────────────

export function mvEval(E: Evaluators, v: Num | undefined, s: Record<string, number>): number {
  if (typeof v === 'number') return v;
  if (v === undefined) return Number.NaN;
  const f = E[v];
  if (f === undefined) return Number.NaN;
  try {
    const r = f(s);
    return typeof r === 'number' ? r : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** A number as a label: up to three significant figures, a real minus sign. */
export function mvFmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) < 1e-9) return '0';
  let s: string;
  if (Number.isInteger(v) || Math.abs(v - Math.round(v)) < 1e-9) s = String(Math.round(v));
  else if (Math.abs(v) >= 1000) s = String(Math.round(v));
  else s = String(Number(v.toPrecision(3)));
  return s.replace('-', '−');
}

function mvGcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : mvGcd(b, a % b);
}

/** k/den of π as a label: π/2, 3π/4, −π, 2π, 0. */
export function mvPiLabel(k: number, den: number): string {
  if (k === 0) return '0';
  const g = mvGcd(k, den);
  const n = k / g;
  const d = den / g;
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  const top = a === 1 ? 'π' : `${a}π`;
  return d === 1 ? sign + top : `${sign + top}/${d}`;
}

export function mvNiceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

export function mvTicks(
  min: number,
  max: number,
  target: number,
  pi: boolean,
): { v: number; label: string }[] {
  const out: { v: number; label: string }[] = [];
  if (pi) {
    const turns = (max - min) / Math.PI;
    const den = turns <= 1.2 ? 4 : turns <= 4.5 ? 2 : 1;
    const mult = turns > 10 ? 2 : 1;
    const step = (Math.PI / den) * mult;
    const k0 = Math.ceil(min / step - 1e-9);
    const k1 = Math.floor(max / step + 1e-9);
    for (let k = k0; k <= k1; k += 1) out.push({ v: k * step, label: mvPiLabel(k * mult, den) });
    return out;
  }
  const step = mvNiceStep(max - min, target);
  const k0 = Math.ceil(min / step - 1e-9);
  const k1 = Math.floor(max / step + 1e-9);
  for (let k = k0; k <= k1; k += 1) {
    const v = Math.abs(k * step) < step * 1e-9 ? 0 : k * step;
    out.push({ v, label: mvFmt(Number(v.toPrecision(12))) });
  }
  return out;
}

/** A label's `{expr}` parts filled in with the current values. */
export function mvFill(E: Evaluators, text: string, s: Record<string, number>): string {
  return text.replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
    const key = inner.trim();
    if (E[key] === undefined) return whole;
    return mvFmt(mvEval(E, key, s));
  });
}

// ── text: light TeX for labels, and how wide it is ──────────────────────────

/** Greek names and a few symbols, as a model writes them in a label. */
export function mvSymbols(text: string): string {
  const greek: Record<string, string> = {
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    epsilon: 'ε',
    varepsilon: 'ε',
    zeta: 'ζ',
    eta: 'η',
    theta: 'θ',
    vartheta: 'ϑ',
    iota: 'ι',
    kappa: 'κ',
    lambda: 'λ',
    mu: 'μ',
    nu: 'ν',
    xi: 'ξ',
    pi: 'π',
    rho: 'ρ',
    sigma: 'σ',
    tau: 'τ',
    upsilon: 'υ',
    phi: 'φ',
    varphi: 'φ',
    chi: 'χ',
    psi: 'ψ',
    omega: 'ω',
    Gamma: 'Γ',
    Delta: 'Δ',
    Theta: 'Θ',
    Lambda: 'Λ',
    Xi: 'Ξ',
    Pi: 'Π',
    Sigma: 'Σ',
    Phi: 'Φ',
    Psi: 'Ψ',
    Omega: 'Ω',
    cdot: '·',
    times: '×',
    pm: '±',
    approx: '≈',
    neq: '≠',
    leq: '≤',
    geq: '≥',
    infty: '∞',
    to: '→',
    rightarrow: '→',
    degree: '°',
    circ: '°',
    partial: '∂',
    nabla: '∇',
    sqrt: '√',
    int: '∫',
    sum: 'Σ',
  };
  return text
    .replace(/\\([A-Za-z]+)/g, (w, name: string) => greek[name] ?? w)
    .replace(/\\,|\\;|\\!/g, ' ')
    .replace(/\\?[{}]/g, (b) => (b.length === 1 ? b : b.slice(1)));
}

/** Runs of a label: plain, superscript, subscript; a lone letter is set italic, as maths is. */
export function mvRuns(text: string): { s: string; sup?: boolean; sub?: boolean; it?: boolean }[] {
  const src = mvSymbols(text);
  const runs: { s: string; sup?: boolean; sub?: boolean; it?: boolean }[] = [];
  const push = (s: string, mode: 'sup' | 'sub' | '') => {
    if (s === '') return;
    if (mode !== '') {
      runs.push(mode === 'sup' ? { s, sup: true } : { s, sub: true });
      return;
    }
    // A single letter standing alone (x, L, v, θ) is a variable: italic.
    const re = /(^|[^\p{L}\p{N}])(\p{L})(?=$|[^\p{L}\p{N}])/gu;
    let last = 0;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      const at = m.index + (m[1] ?? '').length;
      if (at > last) runs.push({ s: s.slice(last, at) });
      runs.push({ s: m[2] ?? '', it: true });
      last = at + (m[2] ?? '').length;
    }
    if (last < s.length) runs.push({ s: s.slice(last) });
  };
  let i = 0;
  let buf = '';
  while (i < src.length) {
    const c = src[i] ?? '';
    if ((c === '^' || c === '_') && i + 1 < src.length) {
      push(buf, '');
      buf = '';
      let j = i + 1;
      let body = '';
      if (src[j] === '{') {
        const end = src.indexOf('}', j);
        body = end < 0 ? src.slice(j + 1) : src.slice(j + 1, end);
        j = end < 0 ? src.length : end + 1;
      } else {
        body = src[j] ?? '';
        j += 1;
      }
      push(body, c === '^' ? 'sup' : 'sub');
      i = j;
      continue;
    }
    buf += c;
    i += 1;
  }
  push(buf, '');
  return runs;
}

export function mvPlain(text: string): string {
  return mvRuns(text)
    .map((r) => r.s)
    .join('');
}

/** Width of one character in em, for the label font (SF / Helvetica proportions). */
function mvCharW(ch: string): number {
  if (' '.includes(ch)) return 0.28;
  if ("il.,:;|!'`".includes(ch)) return 0.26;
  if ('fjtrI()[]/-'.includes(ch)) return 0.36;
  if ('mwMW'.includes(ch)) return 0.86;
  if ('0123456789'.includes(ch)) return 0.57;
  if (/\p{Lu}/u.test(ch)) return 0.68;
  if ('=+×−±<>≈≤≥→'.includes(ch)) return 0.6;
  return 0.54;
}

export function mvTextW(text: string, size: number): number {
  let w = 0;
  for (const r of mvRuns(text)) {
    const scale = r.sup || r.sub ? 0.72 : 1;
    for (const ch of r.s) w += mvCharW(ch) * size * scale;
  }
  return w;
}

/** The box a label occupies, drawn with its baseline at y. */
export function mvTextBox(
  x: number,
  y: number,
  text: string,
  anchor: 'start' | 'middle' | 'end',
  size: number,
  key: boolean,
): Box {
  const w = mvTextW(text, size) + (key ? 18 : 0);
  const left = anchor === 'start' ? x - (key ? 18 : 0) : anchor === 'middle' ? x - w / 2 : x - w;
  const scripts = mvRuns(text).some((r) => r.sup || r.sub);
  const top = y - size * (scripts ? 1.0 : 0.82);
  return { x: left, y: top, w, h: size * (scripts ? 1.32 : 1.08) };
}

export function mvHit(a: Box, b: Box, pad: number): boolean {
  return (
    a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
  );
}

function mvInside(a: Box, area: Box): boolean {
  return (
    a.x >= area.x - 0.5 &&
    a.y >= area.y - 0.5 &&
    a.x + a.w <= area.x + area.w + 0.5 &&
    a.y + a.h <= area.y + area.h + 0.5
  );
}

/**
 * The first candidate spot for a label that sits inside `bounds`, clear of the
 * boxes already placed and of every line's sampled points; failing that, the
 * least crowded one. Returns the index and whether it is clear.
 */
export function mvPlace(
  cands: readonly { x: number; y: number; anchor: 'start' | 'middle' | 'end' }[],
  text: string,
  size: number,
  key: boolean,
  taken: readonly Box[],
  lines: readonly (readonly number[])[],
  bounds: Box,
): { i: number; clear: boolean; crowd: { boxes: number; points: number } } {
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestCrowd = { boxes: 0, points: 0 };
  for (let i = 0; i < cands.length; i += 1) {
    const c = cands[i];
    if (c === undefined) continue;
    const b = mvTextBox(c.x, c.y, text, c.anchor, size, key);
    let cost = mvInside(b, bounds) ? 0 : 1000;
    let boxes = 0;
    let points = 0;
    for (const t of taken) {
      if (mvHit(b, t, 2)) {
        const ox = Math.min(b.x + b.w, t.x + t.w) - Math.max(b.x, t.x);
        const oy = Math.min(b.y + b.h, t.y + t.h) - Math.max(b.y, t.y);
        cost += 100 + Math.max(0, ox) * Math.max(0, oy);
        boxes += 1;
      }
    }
    for (const pts of lines) {
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const px = pts[k] ?? 0;
        const py = pts[k + 1] ?? 0;
        if (px > b.x - 3 && px < b.x + b.w + 3 && py > b.y - 3 && py < b.y + b.h + 3) {
          cost += 4;
          points += 1;
        }
      }
    }
    if (cost === 0) return { i, clear: true, crowd: { boxes: 0, points: 0 } };
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
      bestCrowd = { boxes, points };
    }
  }
  return { i: best, clear: false, crowd: bestCrowd };
}

// ── the scene ───────────────────────────────────────────────────────────────

/** Every panel of the visual at these slider values and this step (1-based; 0 = no steps). */
export function mvScene(
  spec: MathSpec,
  E: Evaluators,
  values: Values,
  step: number,
  focus?: readonly string[],
): Scene {
  const current = step > 0 ? spec.steps[step - 1] : undefined;
  // `focus` replaces the step's highlight: a part the reader hovers lights
  // alone; an empty focus (a slider playing) dims nothing — what moves is seen.
  const hl = focus !== undefined ? [...focus] : [...(current?.highlight ?? [])];
  const panels: Panel[] = [];
  if (spec.figure !== undefined) panels.push(mvFigure(spec, E, values, step, hl));
  if (spec.plot !== undefined) panels.push(mvPlot(spec, E, values, step, hl));
  return { panels };
}

function mvVisible(appear: number, step: number): boolean {
  return step === 0 || appear <= step;
}

function mvDim(id: string, hl: readonly string[]): boolean {
  return hl.length > 0 && !hl.includes(id);
}

function mvTone(role: Role): string {
  return role;
}

export function mvPlot(
  spec: MathSpec,
  E: Evaluators,
  values: Values,
  step: number,
  hl: readonly string[],
): Panel {
  const plot = spec.plot;
  if (plot === undefined) throw new Error('no plot');
  const W = 720;
  const H = 440;
  const xl = plot.x.label ?? plot.v;
  const yl = plot.y.label ?? 'y';
  const L = 58;
  // The x axis's name sits past its arrow, the y axis's above its arrow.
  const R = Math.max(28, mvTextW(xl, 14) + 26);
  const T = 40;
  const B = 44;
  const xmin = plot.x.min;
  const xmax = plot.x.max;
  const ymin = plot.y.min ?? -1;
  const ymax = plot.y.max ?? 1;
  const area: Box = { x: L, y: T, w: W - L - R, h: H - T - B };
  const sx = (x: number) => L + ((x - xmin) / (xmax - xmin)) * area.w;
  const sy = (y: number) => T + area.h - ((y - ymin) / (ymax - ymin)) * area.h;
  const items: Drawable[] = [];
  const labels: Drawable[] = [];
  const taken: Box[] = [];
  const lines: number[][] = [];
  const outside: { id: string; what: string }[] = [];
  const health: { id: string; finite: number; flat: boolean; usesVar: boolean }[] = [];
  const s: Record<string, number> = { ...values };
  const pv = plot.v;

  // Grid and axes.
  const xt = mvTicks(xmin, xmax, 8, plot.x.pi);
  const yt = mvTicks(ymin, ymax, 5, false);
  for (const t of xt)
    items.push({
      t: 'line',
      x1: sx(t.v),
      y1: T,
      x2: sx(t.v),
      y2: T + area.h,
      tone: 'grid',
      width: 1,
    });
  for (const t of yt)
    items.push({
      t: 'line',
      x1: L,
      y1: sy(t.v),
      x2: L + area.w,
      y2: sy(t.v),
      tone: 'grid',
      width: 1,
    });
  const crossY = ymin < 0 && ymax > 0;
  const crossX = xmin < 0 && xmax > 0;
  const ay = crossY ? sy(0) : T + area.h;
  const ax = crossX ? sx(0) : L;
  // Axes run a little past the plot, to their arrows, so the last tick keeps its label.
  items.push({ t: 'line', x1: L, y1: ay, x2: L + area.w + 8, y2: ay, tone: 'axis', width: 1.25 });
  items.push({ t: 'line', x1: ax, y1: T - 8, x2: ax, y2: T + area.h, tone: 'axis', width: 1.25 });
  items.push({
    t: 'path',
    d: mvHead(L + area.w, ay, L + area.w + 14, ay, 9, 7),
    tone: 'axis',
    width: 0,
    fill: 'axis',
  });
  items.push({
    t: 'path',
    d: mvHead(ax, T, ax, T - 14, 9, 7),
    tone: 'axis',
    width: 0,
    fill: 'axis',
  });
  const tick = 12.5;
  for (const t of xt) {
    if (crossX && Math.abs(t.v) < 1e-12) continue;
    const x = sx(t.v);
    items.push({ t: 'line', x1: x, y1: ay - 3, x2: x, y2: ay + 3, tone: 'axis', width: 1 });
    const y = crossY ? ay + 17 : T + area.h + 18;
    const box = mvTextBox(x, y, t.label, 'middle', tick, false);
    labels.push({
      t: 'text',
      x,
      y,
      text: t.label,
      anchor: 'middle',
      size: tick,
      tone: 'mute',
      box,
    });
    taken.push(box);
  }
  for (const t of yt) {
    if (crossY && Math.abs(t.v) < 1e-12) continue;
    const y = sy(t.v);
    items.push({ t: 'line', x1: ax - 3, y1: y, x2: ax + 3, y2: y, tone: 'axis', width: 1 });
    const x = crossX ? ax - 7 : L - 8;
    const box = mvTextBox(x, y + 4.5, t.label, 'end', tick, false);
    labels.push({
      t: 'text',
      x,
      y: y + 4.5,
      text: t.label,
      anchor: 'end',
      size: tick,
      tone: 'mute',
      box,
    });
    taken.push(box);
  }
  if (crossX && crossY) {
    const box = mvTextBox(ax - 7, ay + 17, '0', 'end', tick, false);
    labels.push({
      t: 'text',
      x: ax - 7,
      y: ay + 17,
      text: '0',
      anchor: 'end',
      size: tick,
      tone: 'mute',
      box,
    });
    taken.push(box);
  }
  {
    const box = mvTextBox(L + area.w + 18, ay + 5, xl, 'start', 14, false);
    labels.push({
      t: 'text',
      x: L + area.w + 18,
      y: ay + 5,
      text: xl,
      anchor: 'start',
      size: 14,
      tone: 'ink',
      box,
      italic: xl.length === 1,
    });
    taken.push(box);
    const ybox = mvTextBox(ax, T - 20, yl, 'middle', 14, false);
    labels.push({
      t: 'text',
      x: ax,
      y: T - 20,
      text: yl,
      anchor: 'middle',
      size: 14,
      tone: 'ink',
      box: ybox,
      italic: yl.length === 1,
    });
    taken.push(ybox);
  }

  // A curve's value at x, by id.
  const byId = new Map(plot.curves.map((c) => [c.id, c] as const));
  const f = (id: string, x: number): number => {
    const c = byId.get(id);
    if (c === undefined || c.expr === undefined) return Number.NaN;
    s[pv] = x;
    const v = mvEval(E, c.expr, s);
    delete s[pv];
    Object.assign(s, values);
    return v;
  };

  // Areas and Riemann rectangles, under everything else.
  for (const a of plot.areas) {
    if (!mvVisible(a.appear, step)) continue;
    const x0 = mvEval(E, a.from, s);
    const x1 = mvEval(E, a.to, s);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
    const lo = Math.max(xmin, Math.min(x0, x1));
    const hi = Math.min(xmax, Math.max(x0, x1));
    const n = 160;
    let d = `M${sx(lo).toFixed(2)},${sy(Math.max(ymin, Math.min(ymax, 0))).toFixed(2)}`;
    for (let k = 0; k <= n; k += 1) {
      const x = lo + ((hi - lo) * k) / n;
      const y = Math.max(ymin, Math.min(ymax, f(a.under, x)));
      if (Number.isFinite(y)) d += `L${sx(x).toFixed(2)},${sy(y).toFixed(2)}`;
    }
    d += `L${sx(hi).toFixed(2)},${sy(Math.max(ymin, Math.min(ymax, 0))).toFixed(2)}Z`;
    items.push({
      t: 'path',
      d,
      tone: 'none',
      width: 0,
      fill: mvTone(a.role),
      fillOpacity: 0.2,
      id: a.id,
      dim: mvDim(a.id, hl),
      clip: true,
    });
    if (a.label !== undefined) {
      const mid = (lo + hi) / 2;
      const yv = f(a.under, mid) / 2;
      const text = mvFill(E, a.label, s);
      const cx = sx(mid);
      const cy = sy(Number.isFinite(yv) ? yv : 0) + 5;
      const pick = mvPlace(
        [
          { x: cx, y: cy, anchor: 'middle' },
          { x: cx, y: cy - 18, anchor: 'middle' },
          { x: cx, y: cy + 18, anchor: 'middle' },
        ],
        text,
        14,
        false,
        taken,
        [],
        area,
      );
      const c = [
        { x: cx, y: cy },
        { x: cx, y: cy - 18 },
        { x: cx, y: cy + 18 },
      ][pick.i] ?? { x: cx, y: cy };
      const box = mvTextBox(c.x, c.y, text, 'middle', 14, false);
      labels.push({
        t: 'text',
        x: c.x,
        y: c.y,
        text,
        anchor: 'middle',
        size: 14,
        tone: 'ink',
        box,
        id: a.id,
        dim: mvDim(a.id, hl),
        placed: true,
      });
      taken.push(box);
    }
  }
  for (const r of plot.riemann) {
    if (!mvVisible(r.appear, step)) continue;
    const x0 = mvEval(E, r.from, s);
    const x1 = mvEval(E, r.to, s);
    const n = Math.max(1, Math.min(400, Math.round(mvEval(E, r.n, s))));
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || !(x1 > x0)) continue;
    const dx = (x1 - x0) / n;
    let d = '';
    for (let k = 0; k < n; k += 1) {
      const xa = x0 + k * dx;
      const xs = r.rule === 'left' ? xa : r.rule === 'right' ? xa + dx : xa + dx / 2;
      const h = Math.max(ymin, Math.min(ymax, f(r.under, xs)));
      if (!Number.isFinite(h)) continue;
      const base = sy(Math.max(ymin, Math.min(ymax, 0)));
      const top = sy(h);
      d += `M${sx(xa).toFixed(2)},${base.toFixed(2)}V${top.toFixed(2)}H${sx(xa + dx).toFixed(2)}V${base.toFixed(2)}Z`;
    }
    items.push({
      t: 'path',
      d,
      tone: mvTone(r.role),
      width: 1,
      fill: mvTone(r.role),
      fillOpacity: 0.16,
      id: r.id,
      dim: mvDim(r.id, hl),
      clip: true,
    });
  }

  // Curves: sampled a pixel apart, broken where they have no value or jump.
  const drawn: { id: string; pts: number[]; label?: string; role: Role; dashed: boolean }[] = [];
  for (const c of plot.curves) {
    const n = 720;
    const pts: number[] = [];
    let d = '';
    let pen = false;
    let finite = 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let prevY = Number.NaN;
    const span = area.h;
    const t0 = mvEval(E, c.t?.[0], s);
    const t1 = mvEval(E, c.t?.[1], s);
    for (let k = 0; k <= n; k += 1) {
      let x: number;
      let y: number;
      if (c.expr !== undefined) {
        x = xmin + ((xmax - xmin) * k) / n;
        s[pv] = x;
        y = mvEval(E, c.expr, s);
      } else {
        s.t = t0 + ((t1 - t0) * k) / n;
        x = mvEval(E, c.px, s);
        y = mvEval(E, c.py, s);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        pen = false;
        prevY = Number.NaN;
        continue;
      }
      finite += 1;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
      const X = sx(x);
      const Y = sy(y);
      const clampedY = Math.max(T - span, Math.min(T + area.h + span, Y));
      if (pen && Number.isFinite(prevY) && Math.abs(Y - prevY) > area.h * 0.9) pen = false;
      d += `${pen ? 'L' : 'M'}${X.toFixed(2)},${clampedY.toFixed(2)}`;
      pen = true;
      prevY = Y;
      if (Y >= T && Y <= T + area.h && X >= L && X <= L + area.w) pts.push(X, Y);
    }
    delete s[pv];
    delete s.t;
    Object.assign(s, values);
    health.push({
      id: c.id,
      finite: finite / (n + 1),
      flat: finite > 0 && hi - lo <= 1e-9 * (1 + Math.abs(hi)),
      usesVar: c.expr === undefined || new RegExp(`\\b${pv}\\b|\\d${pv}\\b`).test(c.expr),
    });
    if (!mvVisible(c.appear, step)) continue;
    items.push({
      t: 'path',
      d,
      tone: mvTone(c.role),
      width: 2.5,
      dash: c.dashed,
      id: c.id,
      dim: mvDim(c.id, hl),
      clip: true,
    });
    lines.push(pts);
    drawn.push({
      id: c.id,
      pts,
      ...(c.label !== undefined ? { label: c.label } : {}),
      role: c.role,
      dashed: c.dashed,
    });
  }

  // Tangents.
  for (const tg of plot.tangents) {
    if (!mvVisible(tg.appear, step)) continue;
    const x0 = mvEval(E, tg.at, s);
    const y0 = f(tg.to, x0);
    const h = (xmax - xmin) * 1e-5;
    const m = (f(tg.to, x0 + h) - f(tg.to, x0 - h)) / (2 * h);
    if (!Number.isFinite(y0) || !Number.isFinite(m)) {
      outside.push({ id: tg.id, what: `the tangent at ${mvFmt(x0)} has no slope there` });
      continue;
    }
    const w = (xmax - xmin) * 0.2;
    const xa = x0 - w;
    const xb = x0 + w;
    items.push({
      t: 'line',
      x1: sx(xa),
      y1: sy(y0 + m * (xa - x0)),
      x2: sx(xb),
      y2: sy(y0 + m * (xb - x0)),
      tone: mvTone(tg.role),
      width: 2,
      id: tg.id,
      dim: mvDim(tg.id, hl),
      clip: true,
    });
    items.push({
      t: 'dot',
      x: sx(x0),
      y: sy(y0),
      r: 4.5,
      tone: mvTone(tg.role),
      id: tg.id,
      dim: mvDim(tg.id, hl),
    });
    lines.push([sx(xa), sy(y0 + m * (xa - x0)), sx(x0), sy(y0), sx(xb), sy(y0 + m * (xb - x0))]);
    if (tg.label !== undefined) {
      const text = mvFill(E, tg.label, { ...s, m, [pv]: x0 });
      const X = sx(xb);
      const Y = sy(y0 + m * (xb - x0));
      const cands = [
        { x: X + 6, y: Y - 6, anchor: 'start' as const },
        { x: X - 4, y: Y - 12, anchor: 'end' as const },
        { x: X + 6, y: Y + 16, anchor: 'start' as const },
        { x: sx(x0) + 10, y: sy(y0) - 14, anchor: 'start' as const },
        { x: sx(x0) - 10, y: sy(y0) - 14, anchor: 'end' as const },
      ];
      const pick = mvPlace(cands, text, 14, false, taken, lines, area);
      const c = cands[pick.i] ?? cands[0];
      if (c !== undefined) {
        const box = mvTextBox(c.x, c.y, text, c.anchor, 14, false);
        labels.push({
          t: 'text',
          x: c.x,
          y: c.y,
          text,
          anchor: c.anchor,
          size: 14,
          tone: 'ink',
          box,
          id: tg.id,
          dim: mvDim(tg.id, hl),
          placed: true,
        });
        taken.push(box);
      }
    }
  }

  // Points.
  const dots: { id: string; x: number; y: number; label?: string; dim: boolean }[] = [];
  for (const p of plot.points) {
    if (!mvVisible(p.appear, step)) continue;
    const x = mvEval(E, p.x, s);
    const y = p.y !== undefined ? mvEval(E, p.y, s) : f(p.on ?? '', x);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      outside.push({ id: p.id, what: 'it has no value at these settings' });
      continue;
    }
    if (x < xmin || x > xmax || y < ymin || y > ymax) {
      outside.push({
        id: p.id,
        what: `(${mvFmt(x)}, ${mvFmt(y)}) is outside the plot (x ${mvFmt(xmin)} to ${mvFmt(xmax)}, y ${mvFmt(ymin)} to ${mvFmt(ymax)})`,
      });
      continue;
    }
    items.push({
      t: 'dot',
      x: sx(x),
      y: sy(y),
      r: 5,
      tone: mvTone(p.role),
      id: p.id,
      dim: mvDim(p.id, hl),
    });
    taken.push({ x: sx(x) - 6, y: sy(y) - 6, w: 12, h: 12 });
    dots.push({
      id: p.id,
      x: sx(x),
      y: sy(y),
      ...(p.label !== undefined ? { label: mvFill(E, p.label, s) } : {}),
      dim: mvDim(p.id, hl),
    });
  }
  for (const d of dots) {
    if (d.label === undefined) continue;
    const text = d.label;
    const cands = mvAround(d.x, d.y, 9);
    const pick = mvPlace(cands, text, 14, false, taken, lines, area);
    const c = cands[pick.i] ?? cands[0];
    if (c === undefined) continue;
    const box = mvTextBox(c.x, c.y, text, c.anchor, 14, false);
    labels.push({
      t: 'text',
      x: c.x,
      y: c.y,
      text,
      anchor: c.anchor,
      size: 14,
      tone: 'ink',
      box,
      id: d.id,
      dim: d.dim,
      placed: true,
    });
    taken.push(box);
  }

  // Curve labels: at the quietest spot along the curve, keyed with its colour.
  for (const c of drawn) {
    if (c.label === undefined || c.pts.length < 4) continue;
    const text = mvFill(E, c.label, s);
    const cands: { x: number; y: number; anchor: 'start' | 'middle' | 'end' }[] = [];
    const n = c.pts.length / 2;
    for (const frac of [0.9, 0.78, 0.64, 0.5, 0.36, 0.22, 0.1]) {
      const k = Math.min(n - 1, Math.max(0, Math.round(frac * (n - 1))));
      const X = c.pts[2 * k] ?? 0;
      const Y = c.pts[2 * k + 1] ?? 0;
      cands.push({ x: X + 4, y: Y - 12, anchor: 'start' });
      cands.push({ x: X + 4, y: Y + 22, anchor: 'start' });
    }
    const others = lines.filter((pts) => pts !== c.pts);
    const pick = mvPlace(cands, text, 14, true, taken, [...others, c.pts], area);
    const p = cands[pick.i] ?? cands[0];
    if (p === undefined) continue;
    const box = mvTextBox(p.x, p.y, text, 'start', 14, true);
    labels.push({
      t: 'text',
      x: p.x,
      y: p.y,
      text,
      anchor: 'start',
      size: 14,
      tone: 'ink',
      key: mvTone(c.role),
      box,
      id: c.id,
      dim: mvDim(c.id, hl),
      placed: true,
    });
    taken.push(box);
  }

  return {
    kind: 'plot',
    w: W,
    h: H,
    area,
    map: {
      x0: xmin,
      y1: ymax,
      kx: area.w / (xmax - xmin),
      ky: area.h / (ymax - ymin),
      ox: L,
      oy: T,
    },
    items: [...items, ...labels],
    outside,
    curveHealth: health,
  };
}

/** Eight spots around a point: right-above first, as a reader expects a point's name. */
function mvAround(
  x: number,
  y: number,
  r: number,
): { x: number; y: number; anchor: 'start' | 'middle' | 'end' }[] {
  return [
    { x: x + r, y: y - r + 2, anchor: 'start' },
    { x: x - r, y: y - r + 2, anchor: 'end' },
    { x: x + r, y: y + r + 10, anchor: 'start' },
    { x: x - r, y: y + r + 10, anchor: 'end' },
    { x, y: y - r - 5, anchor: 'middle' },
    { x, y: y + r + 16, anchor: 'middle' },
    { x: x + r + 4, y: y + 5, anchor: 'start' },
    { x: x - r - 4, y: y + 5, anchor: 'end' },
  ];
}

/** An arrowhead: a filled triangle whose tip is (x2, y2), pointing along (x1, y1) → (x2, y2). */
export function mvHead(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  len: number,
  wid: number,
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const bx = x2 - ux * len;
  const by = y2 - uy * len;
  const nx = -uy * (wid / 2);
  const ny = ux * (wid / 2);
  return `M${x2.toFixed(2)},${y2.toFixed(2)}L${(bx + nx).toFixed(2)},${(by + ny).toFixed(2)}L${(bx - nx).toFixed(2)},${(by - ny).toFixed(2)}Z`;
}

export function mvFigure(
  spec: MathSpec,
  E: Evaluators,
  values: Values,
  step: number,
  hl: readonly string[],
): Panel {
  const fig = spec.figure;
  if (fig === undefined) throw new Error('no figure');
  const P = 28;
  let W = 720;
  let [x0, x1] = fig.x;
  let [y0, y1] = fig.y;
  let k = (W - 2 * P) / (x1 - x0);
  let H = (y1 - y0) * k + 2 * P;
  // A tall figure is drawn narrower, not smaller: its width follows its view, at the plot's scale.
  const maxH = spec.plot !== undefined ? 440 : 580;
  if (H > maxH) {
    k = (maxH - 2 * P) / (y1 - y0);
    H = maxH;
    W = Math.max(300, Math.round((x1 - x0) * k + 2 * P));
    const extra = (W - 2 * P) / k - (x1 - x0);
    x0 -= extra / 2;
    x1 += extra / 2;
  } else if (H < 280) {
    const extra = (280 - H) / k;
    y0 -= extra / 2;
    y1 += extra / 2;
    H = 280;
  }
  const fx = (x: number) => P + (x - x0) * k;
  const fy = (y: number) => P + (y1 - y) * k;
  const area: Box = { x: 0, y: 0, w: W, h: H };
  const s: Record<string, number> = { ...values };
  const items: Drawable[] = [];
  const pending: {
    id: string;
    text: string;
    cands: { x: number; y: number; anchor: 'start' | 'middle' | 'end' }[];
    dim: boolean;
    size: number;
    alpha?: number;
  }[] = [];
  const taken: Box[] = [];
  const lines: number[][] = [];
  const outside: { id: string; what: string }[] = [];
  const pt = (p: readonly [Num, Num]): [number, number] => [mvEval(E, p[0], s), mvEval(E, p[1], s)];
  const px = (p: readonly [Num, Num]): [number, number] => {
    const [a, b] = pt(p);
    return [fx(a), fy(b)];
  };
  const inView = (id: string, x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      outside.push({ id, what: 'it has no value at these settings' });
      return false;
    }
    if (x < x0 - 1e-9 || x > x1 + 1e-9 || y < y0 - 1e-9 || y > y1 + 1e-9) {
      outside.push({
        id,
        what: `(${mvFmt(x)}, ${mvFmt(y)}) is outside the figure (x ${mvFmt(fig.x[0])} to ${mvFmt(fig.x[1])}, y ${mvFmt(fig.y[0])} to ${mvFmt(fig.y[1])})`,
      });
    }
    return true;
  };

  for (const sh of fig.shapes as readonly Shape[]) {
    if (!mvVisible(sh.appear, step)) continue;
    const dim = mvDim(sh.id, hl);
    // Its own opacity — an expression of the sliders, so a part can fade as one moves. Gone at 0.
    const alphaIn = sh.opacity === undefined ? 1 : mvEval(E, sh.opacity, s);
    const alpha = Number.isFinite(alphaIn) ? Math.min(1, Math.max(0, alphaIn)) : 1;
    if (alpha <= 0.001) continue;
    const drawnFrom = items.length;
    const queuedFrom = pending.length;
    switch (sh.kind) {
      case 'point': {
        const [a, b] = pt(sh.at);
        if (!inView(sh.id, a, b)) break;
        const X = fx(a);
        const Y = fy(b);
        items.push({ t: 'dot', x: X, y: Y, r: 5.5, tone: sh.role, id: sh.id, dim });
        taken.push({ x: X - 7, y: Y - 7, w: 14, h: 14 });
        if (sh.label !== undefined) {
          const all = mvAround(X, Y, 10);
          const order = ['ne', 'nw', 'se', 'sw', 'n', 's', 'e', 'w'];
          const first = sh.place !== undefined ? all[order.indexOf(sh.place)] : undefined;
          pending.push({
            id: sh.id,
            text: mvFill(E, sh.label, s),
            cands: first !== undefined ? [first, ...all] : all,
            dim,
            size: 15,
          });
        }
        break;
      }
      case 'segment':
      case 'vector': {
        const [ax, ay] = pt(sh.from);
        const [bx, by] = pt(sh.to);
        if (sh.kind === 'vector') {
          inView(sh.id, ax, ay);
          inView(sh.id, bx, by);
        } else if (!mvCrosses(ax, ay, bx, by, x0, x1, y0, y1)) {
          /* A line may run past the edge — a tangent drawn long, a ground wider
             than the view — and is simply cut there. MEASURED (the 4B): thirty
             "outside the figure" lines for tangents drawn to x = ±1500, and it
             gave up fixing. Only a line with nothing in view is said. */
          outside.push({
            id: sh.id,
            what: Number.isFinite(ax + ay + bx + by)
              ? `lies entirely outside the figure (x ${mvFmt(fig.x[0])} to ${mvFmt(fig.x[1])}, y ${mvFmt(fig.y[0])} to ${mvFmt(fig.y[1])})`
              : 'it has no value at these settings',
          });
          break;
        }
        const [X1, Y1] = [fx(ax), fy(ay)];
        const [X2, Y2] = [fx(bx), fy(by)];
        const len = Math.hypot(X2 - X1, Y2 - Y1);
        if (!(len > 0.5)) break;
        const tone = sh.role;
        if (sh.kind === 'vector') {
          const back = Math.min(11, len * 0.4);
          const ex = X2 - ((X2 - X1) / len) * back * 0.8;
          const ey = Y2 - ((Y2 - Y1) / len) * back * 0.8;
          items.push({
            t: 'line',
            x1: X1,
            y1: Y1,
            x2: ex,
            y2: ey,
            tone,
            width: 2.25,
            dash: sh.dashed,
            id: sh.id,
            dim,
          });
          items.push({
            t: 'path',
            d: mvHead(X1, Y1, X2, Y2, back, back * 0.8),
            tone,
            width: 0,
            fill: tone,
            id: sh.id,
            dim,
          });
        } else {
          items.push({
            t: 'line',
            x1: X1,
            y1: Y1,
            x2: X2,
            y2: Y2,
            tone: tone === 'reference' ? 'ink' : tone,
            width: 1.75,
            dash: sh.dashed,
            id: sh.id,
            dim,
          });
        }
        lines.push(mvSampleLine(X1, Y1, X2, Y2));
        if (sh.label !== undefined) {
          const nx = -(Y2 - Y1) / len;
          const ny = (X2 - X1) / len;
          const cands: { x: number; y: number; anchor: 'start' | 'middle' | 'end' }[] = [];
          for (const f of [0.55, 0.35, 0.75, 0.9]) {
            const mx = X1 + (X2 - X1) * f;
            const my = Y1 + (Y2 - Y1) * f;
            for (const side of [1, -1]) {
              const ox = nx * 13 * side;
              const oy = ny * 13 * side;
              cands.push({
                x: mx + ox,
                y: my + oy + 5,
                anchor: Math.abs(ox) < 4 ? 'middle' : ox > 0 ? 'start' : 'end',
              });
            }
          }
          pending.push({ id: sh.id, text: mvFill(E, sh.label, s), cands, dim, size: 15 });
        }
        break;
      }
      case 'polygon': {
        const pts = sh.points.map(px);
        if (pts.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) {
          outside.push({ id: sh.id, what: 'a corner has no value at these settings' });
          break;
        }
        for (const p of sh.points) {
          const [a, b] = pt(p);
          inView(sh.id, a, b);
        }
        const d = `${pts.map(([a, b], i) => `${i === 0 ? 'M' : 'L'}${a.toFixed(2)},${b.toFixed(2)}`).join('')}Z`;
        // A role's colour is solid, its edge the paper (flat shapes that touch stay apart);
        // a pale fill is edged in its colour; tint, shade and an outline are edged in ink.
        const solid = sh.fill === 'main' || sh.fill === 'second' || sh.fill === 'third';
        const light = sh.fill.endsWith('-light');
        items.push({
          t: 'path',
          d,
          tone: solid ? 'paper' : light ? sh.fill.replace('-light', '') : 'ink',
          width: solid ? 2 : light ? 1.5 : 1.75,
          fill: sh.fill === 'none' ? undefined : sh.fill,
          fillOpacity: 1,
          dash: sh.dashed,
          id: sh.id,
          dim,
        });
        const edges: number[] = [];
        for (let i = 0; i < pts.length; i += 1) {
          const [a, b] = pts[i] ?? [0, 0];
          const [c, e] = pts[(i + 1) % pts.length] ?? [0, 0];
          edges.push(...mvSampleLine(a, b, c, e));
        }
        lines.push(edges);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const bx = { x: Math.min(...xs), y: Math.min(...ys), w: 0, h: 0 };
        bx.w = Math.max(...xs) - bx.x;
        bx.h = Math.max(...ys) - bx.y;
        // Words do not sit on a solid shape: its label goes beside it, and others keep off it.
        if (solid) taken.push(bx);
        if (sh.label !== undefined) {
          const cx = pts.reduce((acc, p) => acc + p[0], 0) / pts.length;
          const cy = pts.reduce((acc, p) => acc + p[1], 0) / pts.length;
          // A big area's name is bigger — a² across a square, not a caption in its corner.
          const size = Math.round(Math.min(24, Math.max(15, Math.sqrt(bx.w * bx.h) / 9)));
          pending.push({
            id: sh.id,
            text: mvFill(E, sh.label, s),
            cands: solid
              ? [
                  { x: bx.x + bx.w / 2, y: bx.y - 8, anchor: 'middle' },
                  { x: bx.x + bx.w / 2, y: bx.y + bx.h + 20, anchor: 'middle' },
                  { x: bx.x + bx.w + 8, y: bx.y + bx.h / 2 + 5, anchor: 'start' },
                  { x: bx.x - 8, y: bx.y + bx.h / 2 + 5, anchor: 'end' },
                ]
              : [{ x: cx, y: cy + size / 3, anchor: 'middle' }, ...mvAround(cx, cy, 14)],
            dim,
            size: solid ? 15 : size,
          });
        }
        break;
      }
      case 'polyline': {
        const pts = sh.points.map(px);
        if (pts.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) {
          outside.push({ id: sh.id, what: 'a point on it has no value at these settings' });
          break;
        }
        for (const p of sh.points) {
          const [a, b] = pt(p);
          inView(sh.id, a, b);
        }
        let d = pts
          .map(([a, b], i) => `${i === 0 ? 'M' : 'L'}${a.toFixed(2)},${b.toFixed(2)}`)
          .join('');
        if (sh.smooth && pts.length >= 3) {
          // Catmull-Rom through the points, as cubic Béziers.
          const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))] ?? [0, 0];
          d = `M${P(0)[0].toFixed(2)},${P(0)[1].toFixed(2)}`;
          for (let i = 0; i + 1 < pts.length; i += 1) {
            const [x0, y0] = P(i - 1);
            const [x1, y1] = P(i);
            const [x2, y2] = P(i + 1);
            const [x3, y3] = P(i + 2);
            const c1 = [x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6];
            const c2 = [x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6];
            d += `C${(c1[0] ?? 0).toFixed(2)},${(c1[1] ?? 0).toFixed(2)} ${(c2[0] ?? 0).toFixed(2)},${(c2[1] ?? 0).toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`;
          }
        }
        items.push({
          t: 'path',
          d,
          tone: sh.role === 'reference' ? 'ink' : sh.role,
          width: sh.role === 'reference' ? 1.75 : 2.25,
          dash: sh.dashed,
          id: sh.id,
          dim,
        });
        const along: number[] = [];
        for (let i = 0; i + 1 < pts.length; i += 1) {
          const [a, b] = pts[i] ?? [0, 0];
          const [c, e] = pts[i + 1] ?? [0, 0];
          along.push(...mvSampleLine(a, b, c, e));
        }
        lines.push(along);
        if (sh.label !== undefined) {
          const [ex, ey] = pts[pts.length - 1] ?? [0, 0];
          const [mx, my] = pts[Math.floor(pts.length / 2)] ?? [ex, ey];
          pending.push({
            id: sh.id,
            text: mvFill(E, sh.label, s),
            cands: [...mvAround(ex, ey, 10), ...mvAround(mx, my, 12)],
            dim,
            size: 15,
          });
        }
        break;
      }
      case 'curve': {
        // A formula's curve: sampled as its variable runs from `from` to `to` (a trail when `to` is t).
        const a0 = mvEval(E, sh.from, s);
        const a1 = mvEval(E, sh.to, s);
        if (!Number.isFinite(a0) || !Number.isFinite(a1)) {
          outside.push({ id: sh.id, what: 'its range has no value at these settings' });
          break;
        }
        const N = 160;
        const scope: Record<string, number> = { ...s };
        const world: number[][] = [];
        for (let q = 0; q <= N; q += 1) {
          scope[sh.over] = a0 + ((a1 - a0) * q) / N;
          const wx = mvEval(E, sh.x, scope);
          const wy = mvEval(E, sh.y, scope);
          if (Number.isFinite(wx) && Number.isFinite(wy)) world.push([wx, wy]);
        }
        if (world.length < 2) break;
        // Like a line, a curve may run past the edge; only one with nothing in view is said.
        if (
          !world.some(
            (w) => (w[0] ?? 0) >= x0 && (w[0] ?? 0) <= x1 && (w[1] ?? 0) >= y0 && (w[1] ?? 0) <= y1,
          )
        ) {
          outside.push({ id: sh.id, what: 'lies entirely outside the figure' });
          break;
        }
        const pts = world.map((w) => [fx(w[0] ?? 0), fy(w[1] ?? 0)] as [number, number]);
        const d = pts
          .map(([a, b], i) => `${i === 0 ? 'M' : 'L'}${a.toFixed(2)},${b.toFixed(2)}`)
          .join('');
        items.push({
          t: 'path',
          d,
          tone: sh.role === 'reference' ? 'ink' : sh.role,
          width: sh.role === 'reference' ? 1.75 : 2.25,
          dash: sh.dashed,
          id: sh.id,
          dim,
        });
        const along: number[] = [];
        for (let i = 0; i + 1 < pts.length; i += 4) {
          const [a, b] = pts[i] ?? [0, 0];
          const [c, e] = pts[Math.min(pts.length - 1, i + 4)] ?? [0, 0];
          along.push(...mvSampleLine(a, b, c, e));
        }
        lines.push(along);
        if (sh.label !== undefined) {
          const [ex, ey] = pts[pts.length - 1] ?? [0, 0];
          const [mx, my] = pts[Math.floor(pts.length / 2)] ?? [ex, ey];
          pending.push({
            id: sh.id,
            text: mvFill(E, sh.label, s),
            cands: [...mvAround(mx, my, 12), ...mvAround(ex, ey, 10)],
            dim,
            size: 15,
          });
        }
        break;
      }
      case 'circle': {
        const [a, b] = pt(sh.center);
        const r = mvEval(E, sh.r, s);
        if (!inView(sh.id, a, b) || !(r > 0)) break;
        const X = fx(a);
        const Y = fy(b);
        const R = r * k;
        items.push({
          t: 'path',
          d: `M${(X - R).toFixed(2)},${Y.toFixed(2)}a${R.toFixed(2)},${R.toFixed(2)} 0 1,0 ${(2 * R).toFixed(2)},0a${R.toFixed(2)},${R.toFixed(2)} 0 1,0 ${(-2 * R).toFixed(2)},0Z`,
          tone: sh.fill === 'none' ? sh.role : 'ink',
          width: sh.fill === 'none' ? 2 : 1.25,
          fill:
            sh.fill === 'none'
              ? undefined
              : sh.fill === 'tint'
                ? 'tint'
                : sh.fill === 'shade'
                  ? 'shade'
                  : sh.role,
          fillOpacity: 1,
          id: sh.id,
          dim,
        });
        const ring: number[] = [];
        for (let q = 0; q < 48; q += 1)
          ring.push(
            X + R * Math.cos((q / 48) * 2 * Math.PI),
            Y + R * Math.sin((q / 48) * 2 * Math.PI),
          );
        lines.push(ring);
        // A solid disc (a mass, a molecule) is no ground for words: labels go beside it.
        if (sh.fill === 'main' || sh.fill === 'second' || sh.fill === 'third')
          taken.push({ x: X - R * 0.8, y: Y - R * 0.8, w: R * 1.6, h: R * 1.6 });
        if (sh.label !== undefined) {
          const d = R * 0.72 + 8;
          pending.push({
            id: sh.id,
            text: mvFill(E, sh.label, s),
            cands: mvAround(X, Y, d),
            dim,
            size: 15,
          });
        }
        break;
      }
      case 'angle': {
        const [vx, vy] = px(sh.at);
        const [ax, ay] = px(sh.from);
        const [bx, by] = px(sh.to);
        const a1 = Math.atan2(ay - vy, ax - vx);
        let a2 = Math.atan2(by - vy, bx - vx);
        let sweep = a2 - a1;
        while (sweep <= -Math.PI) sweep += 2 * Math.PI;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        a2 = a1 + sweep;
        const r = 26;
        if (sh.right) {
          const u = [Math.cos(a1) * 14, Math.sin(a1) * 14];
          const w = [Math.cos(a2) * 14, Math.sin(a2) * 14];
          const d = `M${(vx + (u[0] ?? 0)).toFixed(2)},${(vy + (u[1] ?? 0)).toFixed(2)}L${(vx + (u[0] ?? 0) + (w[0] ?? 0)).toFixed(2)},${(vy + (u[1] ?? 0) + (w[1] ?? 0)).toFixed(2)}L${(vx + (w[0] ?? 0)).toFixed(2)},${(vy + (w[1] ?? 0)).toFixed(2)}`;
          items.push({ t: 'path', d, tone: 'ink', width: 1.5, id: sh.id, dim });
        } else {
          const d = `M${(vx + r * Math.cos(a1)).toFixed(2)},${(vy + r * Math.sin(a1)).toFixed(2)}A${r},${r} 0 0,${sweep > 0 ? 1 : 0} ${(vx + r * Math.cos(a2)).toFixed(2)},${(vy + r * Math.sin(a2)).toFixed(2)}`;
          items.push({ t: 'path', d, tone: 'highlight', width: 1.75, id: sh.id, dim });
        }
        if (sh.label !== undefined) {
          const mid = a1 + sweep / 2;
          const lx = vx + 44 * Math.cos(mid);
          const ly = vy + 44 * Math.sin(mid) + 5;
          pending.push({
            id: sh.id,
            text: mvFill(E, sh.label, s),
            cands: [
              { x: lx, y: ly, anchor: 'middle' },
              { x: vx + 58 * Math.cos(mid), y: vy + 58 * Math.sin(mid) + 5, anchor: 'middle' },
            ],
            dim,
            size: 15,
          });
        }
        break;
      }
      case 'dimension': {
        const [ax, ay] = pt(sh.from);
        const [bx, by] = pt(sh.to);
        const [X1, Y1] = [fx(ax), fy(ay)];
        const [X2, Y2] = [fx(bx), fy(by)];
        const len = Math.hypot(X2 - X1, Y2 - Y1);
        if (!(len > 1)) break;
        const nx = (Y2 - Y1) / len;
        const ny = -(X2 - X1) / len;
        const off = sh.offset * k;
        const [A1, B1, A2, B2] = [X1 + nx * off, Y1 + ny * off, X2 + nx * off, Y2 + ny * off];
        items.push({
          t: 'line',
          x1: X1 + nx * 4,
          y1: Y1 + ny * 4,
          x2: A1 + nx * 5,
          y2: B1 + ny * 5,
          tone: 'mute',
          width: 1,
          id: sh.id,
          dim,
        });
        items.push({
          t: 'line',
          x1: X2 + nx * 4,
          y1: Y2 + ny * 4,
          x2: A2 + nx * 5,
          y2: B2 + ny * 5,
          tone: 'mute',
          width: 1,
          id: sh.id,
          dim,
        });
        items.push({
          t: 'line',
          x1: A1,
          y1: B1,
          x2: A2,
          y2: B2,
          tone: 'mute',
          width: 1.25,
          id: sh.id,
          dim,
        });
        items.push({
          t: 'path',
          d: mvHead(A2, B2, A1, B1, 8, 6),
          tone: 'mute',
          width: 0,
          fill: 'mute',
          id: sh.id,
          dim,
        });
        items.push({
          t: 'path',
          d: mvHead(A1, B1, A2, B2, 8, 6),
          tone: 'mute',
          width: 0,
          fill: 'mute',
          id: sh.id,
          dim,
        });
        const mx = (A1 + A2) / 2 + nx * 14;
        const my = (B1 + B2) / 2 + ny * 14 + 5;
        pending.push({
          id: sh.id,
          text: mvFill(E, sh.label, s),
          cands: [
            { x: mx, y: my, anchor: 'middle' },
            { x: (A1 + A2) / 2 + nx * 24, y: (B1 + B2) / 2 + ny * 24 + 5, anchor: 'middle' },
          ],
          dim,
          size: 15,
        });
        break;
      }
      case 'label': {
        const [a, b] = pt(sh.at);
        if (!inView(sh.id, a, b)) break;
        pending.push({
          id: sh.id,
          text: mvFill(E, sh.text, s),
          cands: [{ x: fx(a), y: fy(b) + 5, anchor: 'middle' }, ...mvAround(fx(a), fy(b), 8)],
          dim,
          size: 15,
        });
        break;
      }
      case 'box3d': {
        const [a, b] = pt(sh.at);
        const w = mvEval(E, sh.w, s);
        const h = mvEval(E, sh.h, s);
        const depth = mvEval(E, sh.depth, s);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !(w > 0) || !(h > 0)) {
          outside.push({ id: sh.id, what: 'its corner or size has no value' });
          break;
        }
        const dx = depth * 0.8;
        const dy = depth * 0.55;
        inView(sh.id, a, b);
        inView(sh.id, a + w + dx, b + h + dy);
        const V = (x: number, y: number): [number, number] => [fx(x), fy(y)];
        const A = V(a, b);
        const Bv = V(a + w, b);
        const C = V(a + w, b + h);
        const D = V(a, b + h);
        const A2 = V(a + dx, b + dy);
        const B2 = V(a + w + dx, b + dy);
        const C2 = V(a + w + dx, b + h + dy);
        const D2 = V(a + dx, b + h + dy);
        const poly = (ps: [number, number][]) =>
          `${ps.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join('')}Z`;
        if (sh.shade === 'right')
          items.push({
            t: 'path',
            d: poly([Bv, B2, C2, C]),
            tone: 'none',
            width: 0,
            fill: 'shade',
            fillOpacity: 1,
            id: sh.id,
            dim,
          });
        if (sh.shade === 'top')
          items.push({
            t: 'path',
            d: poly([D, C, C2, D2]),
            tone: 'none',
            width: 0,
            fill: 'shade',
            fillOpacity: 1,
            id: sh.id,
            dim,
          });
        if (sh.shade === 'front')
          items.push({
            t: 'path',
            d: poly([A, Bv, C, D]),
            tone: 'none',
            width: 0,
            fill: 'shade',
            fillOpacity: 1,
            id: sh.id,
            dim,
          });
        const edge = (p: [number, number], q: [number, number], dash: boolean) =>
          items.push({
            t: 'line',
            x1: p[0],
            y1: p[1],
            x2: q[0],
            y2: q[1],
            tone: dash ? 'mute' : 'ink',
            width: dash ? 1.25 : 1.75,
            dash,
            id: sh.id,
            dim,
          });
        edge(A2, B2, true);
        edge(A2, D2, true);
        edge(A, A2, true);
        for (const [p, q] of [
          [A, Bv],
          [Bv, C],
          [C, D],
          [D, A],
          [D, D2],
          [C, C2],
          [Bv, B2],
          [D2, C2],
          [B2, C2],
        ] as [[number, number], [number, number]][])
          edge(p, q, false);
        lines.push([
          ...mvSampleLine(A[0], A[1], Bv[0], Bv[1]),
          ...mvSampleLine(Bv[0], Bv[1], C[0], C[1]),
          ...mvSampleLine(C[0], C[1], D[0], D[1]),
          ...mvSampleLine(D[0], D[1], A[0], A[1]),
          ...mvSampleLine(Bv[0], Bv[1], B2[0], B2[1]),
          ...mvSampleLine(B2[0], B2[1], C2[0], C2[1]),
          ...mvSampleLine(D[0], D[1], D2[0], D2[1]),
          ...mvSampleLine(D2[0], D2[1], C2[0], C2[1]),
          ...mvSampleLine(C[0], C[1], C2[0], C2[1]),
        ]);
        if (sh.labels.w !== undefined) {
          const mx = (A[0] + Bv[0]) / 2;
          pending.push({
            id: sh.id,
            text: sh.labels.w,
            cands: [
              { x: mx, y: A[1] + 22, anchor: 'middle' },
              { x: mx, y: A[1] + 34, anchor: 'middle' },
            ],
            dim,
            size: 15,
          });
        }
        if (sh.labels.h !== undefined) {
          const my = (A[1] + D[1]) / 2 + 5;
          pending.push({
            id: sh.id,
            text: sh.labels.h,
            cands: [
              { x: A[0] - 10, y: my, anchor: 'end' },
              { x: A[0] - 22, y: my, anchor: 'end' },
            ],
            dim,
            size: 15,
          });
        }
        if (sh.labels.d !== undefined) {
          const mx = (Bv[0] + B2[0]) / 2;
          const my = (Bv[1] + B2[1]) / 2;
          pending.push({
            id: sh.id,
            text: sh.labels.d,
            cands: [
              { x: mx + 12, y: my + 16, anchor: 'start' },
              { x: mx + 20, y: my + 24, anchor: 'start' },
            ],
            dim,
            size: 15,
          });
        }
        break;
      }
      case 'spring': {
        const [X1, Y1] = px(sh.from);
        const [X2, Y2] = px(sh.to);
        const len = Math.hypot(X2 - X1, Y2 - Y1);
        if (!(len > 2)) break;
        const ux = (X2 - X1) / len;
        const uy = (Y2 - Y1) / len;
        const nx = -uy;
        const ny = ux;
        const lead = Math.min(18, len * 0.12);
        const body = len - 2 * lead;
        const n = sh.coils * 2;
        const amp = 9;
        let d = `M${X1.toFixed(2)},${Y1.toFixed(2)}L${(X1 + ux * lead).toFixed(2)},${(Y1 + uy * lead).toFixed(2)}`;
        const pts: number[] = [];
        for (let q = 1; q <= n; q += 1) {
          const along = lead + (body * (q - 0.5)) / n;
          const side = q % 2 === 0 ? -1 : 1;
          const X = X1 + ux * along + nx * amp * side;
          const Y = Y1 + uy * along + ny * amp * side;
          d += `L${X.toFixed(2)},${Y.toFixed(2)}`;
          pts.push(X, Y);
        }
        d += `L${(X2 - ux * lead).toFixed(2)},${(Y2 - uy * lead).toFixed(2)}L${X2.toFixed(2)},${Y2.toFixed(2)}`;
        items.push({ t: 'path', d, tone: 'ink', width: 1.6, id: sh.id, dim });
        lines.push(pts);
        if (sh.label !== undefined) {
          const mx = (X1 + X2) / 2;
          const my = (Y1 + Y2) / 2;
          pending.push({
            id: sh.id,
            text: mvFill(E, sh.label, s),
            cands: [
              { x: mx + nx * 22, y: my + ny * 22 + 5, anchor: nx >= 0 ? 'start' : 'end' },
              { x: mx - nx * 22, y: my - ny * 22 + 5, anchor: nx >= 0 ? 'end' : 'start' },
            ],
            dim,
            size: 15,
          });
        }
        break;
      }
    }
    if (alpha < 1) {
      for (let q = drawnFrom; q < items.length; q += 1)
        items[q] = { ...(items[q] as Drawable), alpha };
      for (let q = queuedFrom; q < pending.length; q += 1) {
        const pq = pending[q];
        if (pq !== undefined) pq.alpha = alpha;
      }
    }
  }
  const labels: Drawable[] = [];
  for (const p of pending) {
    const pick = mvPlace(p.cands, p.text, p.size, false, taken, lines, area);
    const c = p.cands[pick.i] ?? p.cands[0];
    if (c === undefined) continue;
    const box = mvTextBox(c.x, c.y, p.text, c.anchor, p.size, false);
    labels.push({
      t: 'text',
      x: c.x,
      y: c.y,
      text: p.text,
      anchor: c.anchor,
      size: p.size,
      tone: 'ink',
      box,
      id: p.id,
      dim: p.dim,
      placed: true,
      ...(pick.clear ? {} : { crowd: pick.crowd }),
      ...(p.alpha !== undefined ? { alpha: p.alpha } : {}),
    });
    taken.push(box);
  }
  return {
    kind: 'figure',
    w: W,
    h: H,
    area,
    map: { x0, y1, kx: k, ky: k, ox: P, oy: P },
    items: [...items, ...labels],
    outside,
    curveHealth: [],
  };
}

/** Points along a segment, a few pixels apart — what a label must keep clear of. */
/** Does the segment from (ax, ay) to (bx, by) cross the box [x0, x1] × [y0, y1]? (Liang–Barsky.) */
function mvCrosses(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): boolean {
  if (!Number.isFinite(ax + ay + bx + by)) return false;
  const dx = bx - ax;
  const dy = by - ay;
  let lo = 0;
  let hi = 1;
  const edges: [number, number][] = [
    [-dx, ax - x0],
    [dx, x1 - ax],
    [-dy, ay - y0],
    [dy, y1 - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) lo = Math.max(lo, r);
    else hi = Math.min(hi, r);
    if (lo > hi) return false;
  }
  return true;
}

function mvSampleLine(x1: number, y1: number, x2: number, y2: number): number[] {
  const n = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 6));
  const out: number[] = [];
  for (let q = 0; q <= n; q += 1) out.push(x1 + ((x2 - x1) * q) / n, y1 + ((y2 - y1) * q) / n);
  return out;
}

// ── SVG ─────────────────────────────────────────────────────────────────────

export function mvEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A label's runs as tspans: scripts raised or lowered and set smaller, variables in italic. */
export function mvRichSvg(text: string, italic: boolean): string {
  const runs = mvRuns(text);
  let out = '';
  let shift = 0;
  for (const r of runs) {
    const want = r.sup ? -0.42 : r.sub ? 0.24 : 0;
    const dy = want - shift;
    shift = want;
    const attrs = [
      dy !== 0 ? `dy="${dy.toFixed(2)}em"` : '',
      r.sup || r.sub ? 'font-size="72%"' : '',
      r.it || italic ? 'font-style="italic"' : '',
    ]
      .filter(Boolean)
      .join(' ');
    out += attrs === '' ? mvEsc(r.s) : `<tspan ${attrs}>${mvEsc(r.s)}</tspan>`;
  }
  if (shift !== 0) out += `<tspan dy="${(-shift).toFixed(2)}em"></tspan>`;
  return out;
}

export function mvSvg(panel: Panel, index: number, title: string): string {
  const clipId = `mv-clip-${index}`;
  const a = panel.area;
  let body = '';
  for (const it of panel.items) {
    /* Dimmed shapes step back to 45%; a part's own opacity and a fade multiply
       in. Words never fade with dimming — the user: "there's some faded text" — a
       dimmed label turns the muted grey, which still reads (6.9:1). */
    const dimAmt = it.dimMix ?? (it.dim ? 1 : 0);
    const op = (it.alpha ?? 1) * (it.t === 'text' ? 1 : 1 - 0.55 * dimAmt);
    const cls = (base: string) =>
      `class="${base}"${op < 0.999 ? ` opacity="${op.toFixed(3)}"` : ''}${it.id !== undefined ? ` data-id="${mvEsc(it.id)}"` : ''}`;
    if (it.t === 'line') {
      body += `<line x1="${it.x1.toFixed(2)}" y1="${it.y1.toFixed(2)}" x2="${it.x2.toFixed(2)}" y2="${it.y2.toFixed(2)}" ${cls(`mv-s-${it.tone}${it.dash ? ' mv-dash' : ''}`)} stroke-width="${it.width}"${it.clip ? ` clip-path="url(#${clipId})"` : ''}/>`;
    } else if (it.t === 'path') {
      const fill = it.fill !== undefined ? ` mv-f-${it.fill}` : ' mv-nofill';
      const stroke = it.width > 0 ? ` mv-s-${it.tone}` : '';
      body += `<path d="${it.d}" ${cls(`mv-p${stroke}${fill}${it.dash ? ' mv-dash' : ''}`)} stroke-width="${it.width}"${it.fillOpacity !== undefined && it.fill !== undefined ? ` fill-opacity="${it.fillOpacity}"` : ''}${it.clip ? ` clip-path="url(#${clipId})"` : ''}/>`;
    } else if (it.t === 'dot') {
      body += `<circle cx="${it.x.toFixed(2)}" cy="${it.y.toFixed(2)}" r="${it.r}" ${cls(`mv-dot mv-f-${it.tone}`)}/>`;
    } else {
      if (it.key !== undefined) {
        const ky = it.box.y + it.box.h / 2;
        const kop = (it.alpha ?? 1) * (1 - 0.55 * dimAmt);
        body += `<line x1="${(it.box.x + 1).toFixed(2)}" y1="${ky.toFixed(2)}" x2="${(it.box.x + 13).toFixed(2)}" y2="${ky.toFixed(2)}" class="mv-s-${it.key} mv-key"${kop < 0.999 ? ` opacity="${kop.toFixed(3)}"` : ''} stroke-width="3"/>`;
      }
      body += `<text x="${it.x.toFixed(2)}" y="${it.y.toFixed(2)}" text-anchor="${it.anchor}" font-size="${it.size}" ${cls(`mv-t mv-t-${dimAmt > 0.5 ? 'mute' : it.tone}`)}>${mvRichSvg(it.text, it.italic === true)}</text>`;
    }
  }
  return `<svg viewBox="0 0 ${panel.w} ${panel.h}" class="mv-svg" role="img" aria-label="${mvEsc(title)}"><defs><clipPath id="${clipId}"><rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}"/></clipPath></defs>${body}</svg>`;
}

// ── the page's life: sliders, play, steps ───────────────────────────────────

export interface PageData {
  readonly spec: MathSpec;
  readonly start: Values;
}

/** A part's place in world units, for the arrow that shows which way it moved. */
export interface MvAnchor {
  readonly id: string;
  readonly panel: 'figure' | 'plot';
  readonly x: number;
  readonly y: number;
}

/**
 * Where each OBJECT sits at these values — a point, a disc, a polygon's or a
 * box's centre, a point on the plot. Lines, arrows and labels that ride on an
 * object are left out: an arrow for the ball and another for the velocity
 * drawn on it said the same move twice.
 */
export function mvAnchors(spec: MathSpec, E: Evaluators, values: Values, step: number): MvAnchor[] {
  const s: Record<string, number> = { ...values };
  const out: MvAnchor[] = [];
  const at = (p: readonly [Num, Num]): number[] => [mvEval(E, p[0], s), mvEval(E, p[1], s)];
  for (const sh of (spec.figure?.shapes ?? []) as readonly Shape[]) {
    if (!mvVisible(sh.appear, step)) continue;
    let pts: number[][] = [];
    if (sh.kind === 'point') pts = [at(sh.at)];
    else if (sh.kind === 'circle') pts = [at(sh.center)];
    else if (sh.kind === 'polygon') pts = sh.points.map(at);
    else if (sh.kind === 'box3d') {
      const c = at(sh.at);
      pts = [[(c[0] ?? 0) + mvEval(E, sh.w, s) / 2, (c[1] ?? 0) + mvEval(E, sh.h, s) / 2]];
    }
    const ok = pts.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
    if (ok.length === 0) continue;
    out.push({
      id: sh.id,
      panel: 'figure',
      x: ok.reduce((acc, q) => acc + (q[0] ?? 0), 0) / ok.length,
      y: ok.reduce((acc, q) => acc + (q[1] ?? 0), 0) / ok.length,
    });
  }
  const plot = spec.plot;
  if (plot !== undefined) {
    for (const p of plot.points) {
      if (!mvVisible(p.appear, step)) continue;
      const x = mvEval(E, p.x, s);
      let y = p.y !== undefined ? mvEval(E, p.y, s) : Number.NaN;
      if (p.y === undefined && p.on !== undefined) {
        const c = plot.curves.find((q) => q.id === p.on);
        if (c?.expr !== undefined) y = mvEval(E, c.expr, { ...s, [plot.v]: x });
      }
      if (Number.isFinite(x) && Number.isFinite(y)) out.push({ id: p.id, panel: 'plot', x, y });
    }
  }
  return out;
}

/** An arrow from where a part was to where it is going: the direction of a move. */
export function mvArrow(x1: number, y1: number, x2: number, y2: number, alpha: number): Drawable[] {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > 16)) return [];
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const sx = x1 + ux * 6;
  const sy = y1 + uy * 6;
  const ex = x2 - ux * 8;
  const ey = y2 - uy * 8;
  const hx = ex - ux * 11;
  const hy = ey - uy * 11;
  const nx = -uy * 6;
  const ny = ux * 6;
  return [
    { t: 'line', x1: sx, y1: sy, x2: hx, y2: hy, tone: 'highlight', width: 2.5, alpha },
    {
      t: 'path',
      d: `M${ex.toFixed(2)},${ey.toFixed(2)}L${(hx + nx).toFixed(2)},${(hy + ny).toFixed(2)}L${(hx - nx).toFixed(2)},${(hy - ny).toFixed(2)}Z`,
      tone: 'highlight',
      width: 0,
      fill: 'highlight',
      fillOpacity: 1,
      alpha,
    },
  ];
}

/** A move being shown: where the parts were, where they go, and the scene they left. */
export interface MvCue {
  readonly from: readonly MvAnchor[];
  readonly to: readonly MvAnchor[];
  readonly ghost: Scene;
  /** Arrows for a move; none for a nudge, whose parts swing both ways. */
  readonly arrows: boolean;
}

/**
 * What a move adds to a panel: under the parts, each moving part faint where
 * it was; over them, an arrow from there to where it is going. Parts that do
 * not move get neither.
 */
export function mvCueItems(
  cue: MvCue,
  panel: Panel,
  index: number,
  a: number,
): { under: Drawable[]; over: Drawable[] } {
  const under: Drawable[] = [];
  const over: Drawable[] = [];
  const map = panel.map;
  if (map === undefined || !(a > 0)) return { under, over };
  const X = (x: number) => map.ox + (x - map.x0) * map.kx;
  const Y = (y: number) => map.oy + (map.y1 - y) * map.ky;
  const moved = new Set<string>();
  for (const f of cue.from) {
    if (f.panel !== panel.kind) continue;
    const t = cue.to.find((q) => q.id === f.id && q.panel === f.panel);
    if (t === undefined) continue;
    if (Math.hypot(X(t.x) - X(f.x), Y(t.y) - Y(f.y)) < 4) continue;
    moved.add(f.id);
    if (cue.arrows) over.push(...mvArrow(X(f.x), Y(f.y), X(t.x), Y(t.y), 0.9 * a));
  }
  const ghost = cue.ghost.panels[index];
  if (ghost !== undefined && ghost.kind === panel.kind) {
    for (const it of ghost.items) {
      if (it.t === 'text' || it.id === undefined || !moved.has(it.id)) continue;
      under.push(
        it.t === 'dot'
          ? { ...it, alpha: 0.24 * a, dim: false, dimMix: 0 }
          : { ...it, alpha: 0.24 * a, dim: false, dimMix: 0, dash: true },
      );
    }
  }
  return { under, over };
}

/**
 * Wire the page. A step lights its parts and moves the sliders it names —
 * slowly enough to follow, with an arrow from where each moving part was and
 * a faint copy left there — then wiggles the sliders it nudges, so what
 * depends on them is seen to follow. The explanation first PLAYS itself: each
 * step's words appear beside the figure as it moves, and when it is done the
 * reader gets the sliders, Back and Next, and Play again (the user: "it should
 * really feel like there's an explanation going on, after it plays once maybe
 * you can expose sliders"). Any control the reader touches ends the telling.
 * Less motion, if the reader asked for it: no telling, no tweens.
 */
export function mvMount(doc: PageDoc, win: PageWin, data: PageData, E: Evaluators): void {
  const spec = data.spec;
  const values: Values = { ...data.start };
  const n = spec.steps.length;
  let step = n > 0 ? 1 : 0;
  let hover: string[] = [];
  // The slider Play is running, if any.
  let playing = '';
  const root = doc.querySelector('.mv');
  const panes: PageEl[] = Array.from(doc.querySelectorAll('[data-mv-panel]'));
  const stepEls: PageEl[] = Array.from(doc.querySelectorAll('[data-mv-step]'));
  const count = doc.querySelector('[data-mv-count]');
  const reduce = win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  // A move takes this long; a nudge swings twice in this long.
  const MOVE_MS = 1100;
  const NUDGE_MS = 3200;
  let cue: (MvCue & { t0: number; dur: number }) | null = null;
  let tweening = false;
  let frame = 0;
  const redraw = () => {
    if (frame === 0) frame = win.requestAnimationFrame(draw);
  };
  function draw(): void {
    frame = 0;
    const now = win.performance.now();
    const scene = mvScene(
      spec,
      E,
      values,
      step,
      hover.length > 0 ? hover : playing !== '' ? [] : undefined,
    );
    let a = 0;
    if (cue !== null) {
      const age = now - cue.t0;
      const hold = cue.dur + 700;
      a = age < 160 ? age / 160 : age < hold ? 1 : Math.max(0, 1 - (age - hold) / 450);
      if (age > hold + 450) cue = null;
    }
    scene.panels.forEach((p: Panel, i: number) => {
      const el = panes[i];
      if (el === undefined) return;
      let panel = p;
      if (cue !== null && a > 0) {
        const c = mvCueItems(cue, p, i, a);
        panel = { ...p, items: [...c.under, ...p.items, ...c.over] };
      }
      el.innerHTML = mvSvg(panel, i, spec.title);
    });
    for (const p of spec.params) {
      const input = doc.querySelector(`[data-mv-param="${p.name}"]`);
      const out = doc.querySelector(`[data-mv-value="${p.name}"]`);
      const v = values[p.name] ?? p.value;
      if (input !== null && Number(input.value) !== v && doc.activeElement !== input)
        input.value = String(v);
      if (out !== null) out.textContent = mvFmt(v);
    }
    // The cue fades on its own once the move has landed.
    if (cue !== null && !tweening) redraw();
  }
  let tween = 0;
  const clampTo = (name: string, v: number): number => {
    const p = spec.params.find((q) => q.name === name);
    return p === undefined ? v : Math.max(p.min, Math.min(p.max, v));
  };
  const moveTo = (target: Values, after?: () => void) => {
    win.cancelAnimationFrame(tween);
    tweening = false;
    const from: Values = { ...values };
    const keys = Object.keys(target).filter((k) => target[k] !== from[k]);
    if (keys.length === 0 || reduce) {
      Object.assign(values, target);
      redraw();
      after?.();
      return;
    }
    const t0 = win.performance.now();
    cue = {
      t0,
      dur: MOVE_MS,
      from: mvAnchors(spec, E, from, step),
      to: mvAnchors(spec, E, { ...from, ...target }, step),
      ghost: mvScene(spec, E, from, step, []),
      arrows: true,
    };
    tweening = true;
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / MOVE_MS);
      const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      for (const k of keys) {
        const p = spec.params.find((q) => q.name === k);
        const a = from[k] ?? 0;
        const b = target[k] ?? a;
        let v = a + (b - a) * e;
        if (p !== undefined && p.step >= 1 && Number.isInteger(p.step)) v = Math.round(v);
        values[k] = v;
      }
      draw();
      if (u < 1) tween = win.requestAnimationFrame(tick);
      else {
        tweening = false;
        redraw();
        after?.();
      }
    };
    tween = win.requestAnimationFrame(tick);
  };
  // A nudge: each named slider swings up and down around where it is, twice, and settles.
  const nudge = (amounts: Readonly<Record<string, number>>) => {
    const names = Object.keys(amounts).filter((k) => (amounts[k] ?? 0) !== 0);
    if (names.length === 0 || reduce) return;
    win.cancelAnimationFrame(tween);
    const base: Values = { ...values };
    const probe: Values = { ...base };
    for (const k of names) probe[k] = clampTo(k, (base[k] ?? 0) + (amounts[k] ?? 0));
    const t0 = win.performance.now();
    cue = {
      t0,
      dur: NUDGE_MS,
      from: mvAnchors(spec, E, base, step),
      to: mvAnchors(spec, E, probe, step),
      ghost: mvScene(spec, E, base, step, []),
      arrows: false,
    };
    tweening = true;
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / NUDGE_MS);
      const w = Math.sin(u * Math.PI * 4) * (1 - 0.3 * u);
      for (const k of names) values[k] = clampTo(k, (base[k] ?? 0) + (amounts[k] ?? 0) * w);
      draw();
      if (u < 1) tween = win.requestAnimationFrame(tick);
      else {
        for (const k of names) values[k] = base[k] ?? 0;
        tweening = false;
        redraw();
      }
    };
    tween = win.requestAnimationFrame(tick);
  };

  // The telling: the explanation plays itself once, then the reader has the controls.
  let telling = false;
  let paused = false;
  let tellTimer = 0;
  const pauseBtn = doc.querySelector('[data-mv-pause]');
  const words = (k: number) =>
    (spec.steps[k - 1]?.text ?? '').split(/\s+/).filter((w) => w !== '').length;
  const dwell = (k: number): number => {
    const st = spec.steps[k - 1];
    const moves = st !== undefined && Object.keys(st.set).length > 0 ? MOVE_MS : 0;
    const nudges = st?.nudge !== undefined && Object.keys(st.nudge).length > 0 ? NUDGE_MS : 0;
    // About 210 words a minute, and never under two and a half seconds.
    return moves + nudges + Math.max(2500, 700 + words(k) * 285);
  };
  const showSteps = () => {
    stepEls.forEach((el: PageEl, i: number) => {
      el.classList.toggle('is-on', i === step - 1);
      el.classList.toggle('is-ahead', telling && i > step - 1);
      el.setAttribute('aria-current', i === step - 1 ? 'step' : 'false');
    });
    if (count !== null) count.textContent = `${step} / ${n}`;
  };
  const endTelling = () => {
    telling = false;
    paused = false;
    win.clearTimeout(tellTimer);
    root?.classList.remove('mv-telling');
    showSteps();
  };
  const tellOn = () => {
    win.clearTimeout(tellTimer);
    if (!telling || paused) return;
    tellTimer = win.setTimeout(() => {
      if (!telling || paused) return;
      if (step >= n) {
        endTelling();
        return;
      }
      go(step + 1, true);
      tellOn();
    }, dwell(step));
  };
  const setPause = (on: boolean) => {
    paused = on;
    if (pauseBtn !== null) {
      pauseBtn.textContent = on ? 'Resume' : 'Pause';
      pauseBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (!on) tellOn();
    else win.clearTimeout(tellTimer);
  };
  const startTelling = () => {
    if (n < 2 || reduce) {
      endTelling();
      return;
    }
    telling = true;
    root?.classList.add('mv-telling');
    Object.assign(values, data.start);
    setPause(false);
    go(1, true);
    tellOn();
  };

  function go(k: number, byTelling = false): void {
    if (n === 0) return;
    // The reader took over — before the telling started, or during it.
    if (!byTelling) endTelling();
    step = Math.max(1, Math.min(n, k));
    showSteps();
    const target: Values = {};
    const st = spec.steps[step - 1];
    for (const [name, v] of Object.entries(st?.set ?? {})) {
      const val = mvEval(E, v, values);
      if (spec.params.some((q) => q.name === name) && Number.isFinite(val))
        target[name] = clampTo(name, val);
    }
    const amounts: Record<string, number> = {};
    for (const [name, v] of Object.entries(st?.nudge ?? {})) {
      const val = mvEval(E, v, { ...values, ...target });
      if (spec.params.some((q) => q.name === name) && Number.isFinite(val)) amounts[name] = val;
    }
    stopPlay();
    moveTo(target, Object.keys(amounts).length > 0 ? () => nudge(amounts) : undefined);
    redraw();
  }
  // Play: the named slider runs from where it is to its end, and round again.
  let playFrame = 0;
  let last = 0;
  const playBtns: PageEl[] = Array.from(doc.querySelectorAll('[data-mv-play]'));
  function stopPlay(): void {
    playing = '';
    win.cancelAnimationFrame(playFrame);
    for (const b of playBtns) {
      b.classList.remove('is-playing');
      b.setAttribute('aria-pressed', 'false');
    }
  }
  let pos = 0;
  const run = (now: number) => {
    const p = spec.params.find((q) => q.name === playing);
    if (p === undefined) return;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    const span = p.max - p.min;
    const discrete = p.step >= 1 && Number.isInteger(p.step);
    // A counted slider (n = 1 … 25) steps about six a second; a smooth one crosses in five seconds.
    pos += (discrete ? Math.min(6, Math.max(1, span / 3)) : span / 5) * dt;
    if (pos > p.max + (discrete ? 0.999 : 0)) pos = p.min;
    values[p.name] = discrete ? Math.min(p.max, Math.floor(pos)) : Math.min(p.max, pos);
    draw();
    playFrame = win.requestAnimationFrame(run);
  };
  for (const b of playBtns) {
    b.addEventListener('click', () => {
      const name = b.getAttribute('data-mv-play') ?? '';
      endTelling();
      if (playing === name) {
        stopPlay();
        draw();
        return;
      }
      stopPlay();
      win.cancelAnimationFrame(tween);
      tweening = false;
      playing = name;
      last = 0;
      pos = values[name] ?? 0;
      b.classList.add('is-playing');
      b.setAttribute('aria-pressed', 'true');
      playFrame = win.requestAnimationFrame(run);
    });
  }
  for (const p of spec.params) {
    const input = doc.querySelector(`[data-mv-param="${p.name}"]`);
    input?.addEventListener('input', () => {
      endTelling();
      stopPlay();
      win.cancelAnimationFrame(tween);
      tweening = false;
      values[p.name] = Number(input.value);
      redraw();
    });
  }
  stepEls.forEach((el: PageEl, i: number) => {
    el.addEventListener('click', () => go(i + 1));
  });
  doc.querySelector('[data-mv-prev]')?.addEventListener('click', () => go(step - 1));
  doc.querySelector('[data-mv-next]')?.addEventListener('click', () => go(step + 1));
  doc.querySelector('[data-mv-replay]')?.addEventListener('click', () => startTelling());
  doc.querySelector('[data-mv-skip]')?.addEventListener('click', () => endTelling());
  pauseBtn?.addEventListener('click', () => setPause(!paused));
  doc.addEventListener('keydown', (ev: PageEvent) => {
    if (ev.target?.tagName === 'INPUT') return;
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown') go(step + 1);
    if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') go(step - 1);
  });
  for (const ref of Array.from(doc.querySelectorAll('[data-mv-ref]'))) {
    ref.addEventListener('mouseenter', () => {
      hover = [ref.getAttribute('data-mv-ref') ?? ''];
      redraw();
    });
    ref.addEventListener('mouseleave', () => {
      hover = [];
      redraw();
    });
  }
  draw();
  // The page opens telling (its markup already hides what is ahead); a moment, then it plays.
  if (spec.tell !== false && n > 1 && !reduce) tellTimer = win.setTimeout(startTelling, 900);
  else endTelling();
}

/** Every function above, in the order the page needs them. */
export const RUNTIME_FUNCTIONS = [
  mvEval,
  mvFmt,
  mvGcd,
  mvPiLabel,
  mvNiceStep,
  mvTicks,
  mvFill,
  mvSymbols,
  mvRuns,
  mvPlain,
  mvCharW,
  mvTextW,
  mvTextBox,
  mvHit,
  mvInside,
  mvPlace,
  mvScene,
  mvVisible,
  mvDim,
  mvTone,
  mvPlot,
  mvAround,
  mvHead,
  mvFigure,
  mvCrosses,
  mvSampleLine,
  mvEsc,
  mvRichSvg,
  mvSvg,
  mvAnchors,
  mvArrow,
  mvCueItems,
  mvMount,
] as const;

/** The functions above as page script — the same text Node runs. */
export function runtimeSource(): string {
  return `var __name = function (f) { return f; };\n${RUNTIME_FUNCTIONS.map((f) => f.toString()).join('\n')}`;
}
