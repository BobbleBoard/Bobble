/**
 * `design` — DESIGN SETTINGS, one group of DesktopSettings.
 *
 * The design kit documents, decks, charts and pages are made in
 * (deliverables/research/visual-quality.md §4.6, filled by VQ-04):
 *
 *   - `kit`    — which kit (`@pi-desktop/design-kit` ids: paper-teal, fog,
 *                bone-oxblood, slate-cobalt, sage-moss, graphite-amber). A
 *                project's own `.bobble/brand.md` wins over it.
 *   - `images` — pictures in documents and pages: off, draft (FLUX.2 klein,
 *                Apache-2.0, seconds) or final (Qwen-Image 2.1, ~97 s, a
 *                non-commercial licence). PLAN Q16's recommended default is
 *                draft; it stays `off` here until VQ-09 makes pictures and
 *                VQ-14's panel shows the licence line beside the choice.
 *   - `lint`   — after making something: check & fix (default), check and
 *                tell me, or off (VQ-07).
 *   - `look`   — look at the result with vision when the model can see
 *                (auto), or never (VQ-07's optional pass).
 *
 * `enabled` stays the master switch, off, until the Design panel ships
 * (VQ-14): while it is off nothing reads `kit` from here — a diagram wears the
 * house default (or the project's brand) and charts keep their per-chat
 * looks. Every value is clamped: settings.json is hand-editable, and an
 * unknown kit id is kept as written (a brand kit a later version knows) but
 * resolves to the default where it is read.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3, R6): it
 * is already composed into DesktopSettings, DEFAULT_SETTINGS, clampSettings,
 * mergeSettingsPatch and the renderer's store, so lane VQ (vq-kit) adds keys HERE
 * — type, default (off), clamp — and nowhere else. Every key needs an entry in
 * the help registry (`electron/help/registry/<section>.ts`, BH-1) and stays
 * `internal` there until its UI ships. Side effects subscribe with
 * `subscribeSettings('design', …)` in settings-main.ts, never a new callback.
 */
import { bool, type FeatureSettingsGroup, flatMerge, record } from './feature-group';

export type DesignImages = 'off' | 'draft' | 'final';
export type DesignLint = 'fix' | 'report' | 'off';
export type DesignLook = 'auto' | 'off';

export interface DesignSettings {
  /** The feature's master switch. Off until its lane ships the UI that turns it on. */
  enabled: boolean;
  /** The design kit's id. */
  kit: string;
  images: DesignImages;
  lint: DesignLint;
  look: DesignLook;
}

/** The house default kit — design-kit's DEFAULT_KIT_ID (kept literal: this file is renderer-safe and dependency-free). */
export const DEFAULT_DESIGN_KIT = 'paper-teal';

export const DEFAULT_DESIGN_SETTINGS: DesignSettings = {
  enabled: false,
  kit: DEFAULT_DESIGN_KIT,
  images: 'off',
  lint: 'fix',
  look: 'auto',
};

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** A kit id as a kit file spells one: lowercase words joined by hyphens. */
function kitId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DESIGN_KIT;
  const id = value.trim().toLowerCase();
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) && id.length <= 64 ? id : DEFAULT_DESIGN_KIT;
}

export function clampDesignSettings(raw: unknown): DesignSettings {
  const o = record(raw);
  return {
    enabled: bool(o.enabled, DEFAULT_DESIGN_SETTINGS.enabled),
    kit: kitId(o.kit),
    images: oneOf(o.images, ['off', 'draft', 'final'] as const, DEFAULT_DESIGN_SETTINGS.images),
    lint: oneOf(o.lint, ['fix', 'report', 'off'] as const, DEFAULT_DESIGN_SETTINGS.lint),
    look: oneOf(o.look, ['auto', 'off'] as const, DEFAULT_DESIGN_SETTINGS.look),
  };
}

export const designSettings: FeatureSettingsGroup<'design', DesignSettings> = {
  key: 'design',
  defaults: DEFAULT_DESIGN_SETTINGS,
  clamp: clampDesignSettings,
  merge: flatMerge(clampDesignSettings),
};

/**
 * The kit a pi child is told to wear (`PI_DESKTOP_DESIGN_KIT`), or nothing
 * while the Design setting is off — the harness then uses the project's brand
 * or the house default.
 */
export function designKitEnv(design: DesignSettings): string | undefined {
  return design.enabled ? design.kit : undefined;
}
