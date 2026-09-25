/**
 * The shape every feature's settings group shares, and the small guards its
 * clamp is built from.
 *
 * A group is one top-level key of `DesktopSettings` (`memory`, `training`, …),
 * owned by one lane and defined in one file here — so a new key never touches
 * settings-contract.ts or settings-logic.ts (deliverables/research/PLAN.md R6).
 * Pure: no electron, no fs — the renderer imports these too.
 */

export interface FeatureSettingsGroup<K extends string, T extends object> {
  /** The top-level key in `DesktopSettings`. */
  readonly key: K;
  /** Everything off: what an install that never saw this feature reads. */
  readonly defaults: T;
  /** An untrusted value (settings.json is hand-editable) → a valid group. */
  readonly clamp: (raw: unknown) => T;
  /** One level deep: a patch names the fields it changes and keeps the rest. */
  readonly merge: (current: T, patch: Partial<T> | undefined) => T;
}

/** The object behind an untrusted value, or an empty one. */
export function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A merge that is a spread then a clamp — right for a flat group. */
export function flatMerge<T extends object>(
  clamp: (raw: unknown) => T,
): (current: T, patch: Partial<T> | undefined) => T {
  return (current, patch) => clamp({ ...current, ...patch });
}
