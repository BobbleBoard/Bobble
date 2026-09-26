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
import { compileSpec, startValues, steadyYRange } from './build.js';
import { checkMath, type Problem } from './checks.js';
import { mathPage } from './page.js';
import type { Values } from './runtime.js';
import { type MathSpec, normalizeMathSpec } from './spec.js';

export { contrast, type Problem, partsOf } from './checks.js';
export { ExprError } from './expr.js';
export type { Evaluators, Values } from './runtime.js';
export { runtimeSource } from './runtime.js';
export type { Panel, Scene } from './scene-types.js';
export { type MathSpec, normalizeMathSpec, SpecError, texSafeJson, withoutEmoji } from './spec.js';

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
  if (spec.plot !== undefined && (spec.plot.y.min === undefined || spec.plot.y.max === undefined)) {
    const r = steadyYRange(spec, compiled.E);
    spec = { ...spec, plot: { ...spec.plot, y: { ...spec.plot.y, min: r.min, max: r.max } } };
    if (r.clipped)
      notes.push(
        'a curve runs off towards infinity, so the y-range shows the rest of it — give "y" a range to choose',
      );
  }
  const start = startValues(spec, compiled.E);
  const problems = [
    ...checkMath(spec, compiled.E, compiled.reads),
    ...notes.map((text) => ({ level: 'note' as const, text })),
  ];
  const html = mathPage({ spec, compiled, start, kit: opts.kit ?? kitOrDefault(undefined) });
  return { spec, html, problems, start };
}
