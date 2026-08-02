/**
 * Pure model-selection + effort helpers (round-12). No store, no I/O — the single
 * home for the tier ↔ model-selection mapping and the effort-auto → level mapping
 * that W2 (the effort slider) and W3 (the Auto router + tier dropdown) both import,
 * so the mapping lives in exactly one place.
 *
 * The harness stays 4-level (low/medium/high/max); "auto" is resolved HERE,
 * app-side, and pushed through the existing `/harness effort <level>` command.
 */
import type { ModelTier } from '@pi-desktop/harness';
import type { DesktopSettings, EffortLevel } from '../../electron/settings/settings-contract';

export type { ModelTier } from '@pi-desktop/harness';

/** The persisted model-selection union (source of truth: settings-contract). */
export type ModelSelection = DesktopSettings['modelSelection'];
/** Effort resolution mode (mirror of settings-contract's EffortMode). */
export type EffortMode = DesktopSettings['effortMode'];

/** The 4 effort levels in slider order (low → max). */
export const EFFORT_STEPS = [
  'low',
  'medium',
  'high',
  'max',
] as const satisfies readonly EffortLevel[];

/** 4-detent slider (0..1) → the nearest effort level. Detents: 0=low, .33=medium,
 * .66=high, 1=max. Out-of-range inputs clamp to the ends. */
export function sliderToLevel(v01: number): EffortLevel {
  if (!Number.isFinite(v01)) return 'low';
  const idx = Math.min(
    EFFORT_STEPS.length - 1,
    Math.max(0, Math.round(v01 * (EFFORT_STEPS.length - 1))),
  );
  return EFFORT_STEPS[idx] as EffortLevel;
}

/** Effort level → its slider position (low=0, medium=.33, high=.66, max=1). */
export function levelToSlider(level: EffortLevel): number {
  const idx = EFFORT_STEPS.indexOf(level);
  return idx <= 0 ? 0 : idx / (EFFORT_STEPS.length - 1);
}

/**
 * The effort level the harness should actually run this turn.
 *
 * This used to derive Auto's level from the ACTIVE MODEL TIER (fast→low,
 * balanced→medium, intelligent→high), which had two consequences nobody chose:
 * `max` was unreachable from Adaptive at all, and pinning the model to Fast
 * pinned thinking to `low` no matter how large the task was. Since
 * `create_production_hierarchy` is gated on high/max, that is precisely why
 * "ask the manager to set up a Godot demo" answered that it had no tool to
 * contact a manager — on Adaptive + Fast it genuinely didn't.
 *
 * Adaptive now writes the classifier's level into `settings.effort` at each idle
 * boundary (see `pushAutoEffort`), so there is ONE resolved level and every
 * reader — the slider, the harness, the corp gate — sees the same number.
 */
export function resolveEffort(s: DesktopSettings): EffortLevel {
  return s.effort;
}

/** True when the selection pins a model/tier (the Auto router is disabled). */
export function isPinnedSelection(sel: ModelSelection): boolean {
  return sel.mode !== 'auto';
}

/** The tier a selection targets, or null when it is not tier-pinned. */
export function selectionTier(sel: ModelSelection): ModelTier | null {
  return sel.mode === 'tier' ? sel.tier : null;
}
