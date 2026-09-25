/**
 * `design` — DESIGN SETTINGS, one group of DesktopSettings.
 *
 * The design kit documents, decks, charts and pages are made in. Off until
 * the Design panel ships (VQ-14). VQ-04 adds `kit`, `images`, `lint` and
 * `look`.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3, R6): it
 * is already composed into DesktopSettings, DEFAULT_SETTINGS, clampSettings,
 * mergeSettingsPatch and the renderer's store, so lane VQ (vq-kit) adds keys HERE
 * — type, default (off), clamp — and nowhere else. Every key needs an entry in
 * the help registry (`electron/help/registry/<section>.ts`, BH-1) and stays
 * `internal` there until its UI ships. Side effects subscribe with
 * `subscribeSettings('design', …)` in settings-main.ts, never a new callback.
 * First filled by VQ-04 (W2) (deliverables/research/visual-quality.md §4.6).
 */
import { bool, type FeatureSettingsGroup, flatMerge, record } from './feature-group';

export interface DesignSettings {
  /** The feature's master switch. Off until its lane ships the UI that turns it on. */
  enabled: boolean;
}

export const DEFAULT_DESIGN_SETTINGS: DesignSettings = { enabled: false };

export function clampDesignSettings(raw: unknown): DesignSettings {
  const o = record(raw);
  return { enabled: bool(o.enabled, DEFAULT_DESIGN_SETTINGS.enabled) };
}

export const designSettings: FeatureSettingsGroup<'design', DesignSettings> = {
  key: 'design',
  defaults: DEFAULT_DESIGN_SETTINGS,
  clamp: clampDesignSettings,
  merge: flatMerge(clampDesignSettings),
};
