/**
 * @pi-desktop/mathviz — maths and physics visuals from a spec.
 *
 * A model writes what to show (curves as expressions, a figure's shapes,
 * sliders, and steps that point at the parts); `renderMath` returns the one
 * standard page for it — Bobble's kit, typeset maths, live sliders, the steps
 * tied to the figure — and the problems a person would see in it, measured,
 * so the model can fix the spec and draw again.
 */
import { type Kit, kitOrDefault } from '@pi-desktop/design-kit';
import {
  compileSpec,
  fittedView,
  groundIds,
  heldView,
  startValues,
  steadyYRange,
  yRangeMisses,
} from './build.js';
import { checkMath, type Problem } from './checks.js';
import { mathPage } from './page.js';
import type { Values } from './runtime.js';
import { type MathSpec, normalizeMathSpec } from './spec.js';

export { contrast, type Problem, partsOf } from './checks.js';
export { ExprError } from './expr.js';
export type { Evaluators, Values } from './runtime.js';
export { runtimeSource } from './runtime.js';
export type { Panel, Scene } from './scene-types.js';
export {
  lenientJson,
  type MathSpec,
  normalizeMathSpec,
  SpecError,
  texSafeJson,
  withoutEmoji,
} from './spec.js';

export interface MathResult {
  /** The spec as drawn — forgiving reads resolved, the plot's y-range fixed. */
  readonly spec: MathSpec;
  readonly html: string;
  readonly problems: readonly Problem[];
  /** The slider values the page opens on. */
  readonly start: Values;
}

/** A spec (JSON text or an object) → the page, and what is wrong with it. Throws SpecError on what cannot be drawn. */
export function renderMath(input: unknown, opts: { readonly kit?: Kit } = {}): MathResult {
  let spec = normalizeMathSpec(input);
  const compiled = compileSpec(spec);
  const notes: string[] = [];
  // ASCII, as the model would write it back into the spec.
  const num = (v: number) => String(Number(v.toPrecision(3)));
  const range = (a: number, b: number) => `${num(a)}..${num(b)}`;
  const some = (ids: readonly string[]) =>
    ids.length <= 3 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more`;
  const lost = yRangeMisses(spec, compiled.E);
  if (
    spec.plot !== undefined &&
    (spec.plot.y.min === undefined || spec.plot.y.max === undefined || lost !== null)
  ) {
    const r = steadyYRange(spec, compiled.E);
    if (lost !== null)
      notes.push(
        `the plot's y-range ${range(spec.plot.y.min ?? 0, spec.plot.y.max ?? 0)} missed ${some(lost)} at the steps, so it shows ${range(r.min, r.max)} — give "y" a range that holds the curves`,
      );
    spec = { ...spec, plot: { ...spec.plot, y: { ...spec.plot.y, min: r.min, max: r.max } } };
    if (r.clipped)
      notes.push(
        'a curve runs off towards infinity, so the y-range shows the rest of it — give "y" a range to choose',
      );
  }
  const fig = spec.figure;
  if (fig?.fit !== undefined && fig.fit.length > 0) {
    const view = fittedView(spec, compiled.E);
    const { fit, ...rest } = fig;
    spec = {
      ...spec,
      figure: {
        ...rest,
        x: fit.includes('x') ? view.x : fig.x,
        y: fit.includes('y') ? view.y : fig.y,
      },
    };
  }
  const held = heldView(spec, compiled.E);
  if (held !== null && spec.figure !== undefined) {
    const f = spec.figure;
    notes.push(
      `the view (x ${range(f.x[0], f.x[1])}, y ${range(f.y[0], f.y[1])}) left out ${some(held.left)} at the steps, so it was widened to x ${range(held.x[0], held.x[1])}, y ${range(held.y[0], held.y[1])} — give "view" ranges that hold the parts at every step`,
    );
    spec = { ...spec, figure: { ...f, x: held.x, y: held.y } };
  }
  if (spec.figure !== undefined) {
    const ground = groundIds(spec, compiled.E);
    if (ground.length > 0) spec = { ...spec, figure: { ...spec.figure, ground } };
  }
  const start = startValues(spec, compiled.E);
  const problems = [
    ...checkMath(spec, compiled.E, compiled.reads),
    ...notes.map((text) => ({ level: 'note' as const, text })),
  ];
  const html = mathPage({ spec, compiled, start, kit: opts.kit ?? kitOrDefault(undefined) });
  return { spec, html, problems, start };
}
