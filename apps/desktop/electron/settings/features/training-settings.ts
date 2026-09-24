/**
 * `training` — TRAINING SETTINGS, one group of DesktopSettings.
 *
 * Training runs on this Mac. The user-facing switch that shows the Training
 * row is `capabilities.training` (TR-5's fifth Capabilities toggle);
 * `enabled` here is the lane's to keep or replace. TR-4 adds `root`,
 * `onlyOnAC`, `keepAwake`, `parkChat` and `defaultDevice`.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3, R6): it
 * is already composed into DesktopSettings, DEFAULT_SETTINGS, clampSettings,
 * mergeSettingsPatch and the renderer's store, so lane TRAIN adds keys HERE
 * — type, default (off), clamp — and nowhere else. Every key needs an entry in
 * the help registry (`electron/help/registry/<section>.ts`, BH-1) and stays
 * `internal` there until its UI ships. Side effects subscribe with
 * `subscribeSettings('training', …)` in settings-main.ts, never a new callback.
 * First filled by TR-4 (W2) (deliverables/research/training.md §4.7).
 */
import { bool, type FeatureSettingsGroup, flatMerge, record } from './feature-group';

export interface TrainingSettings {
  /** The feature's master switch. Off until its lane ships the UI that turns it on. */
  enabled: boolean;
}

export const DEFAULT_TRAINING_SETTINGS: TrainingSettings = { enabled: false };

export function clampTrainingSettings(raw: unknown): TrainingSettings {
  const o = record(raw);
  return { enabled: bool(o.enabled, DEFAULT_TRAINING_SETTINGS.enabled) };
}

export const trainingSettings: FeatureSettingsGroup<'training', TrainingSettings> = {
  key: 'training',
  defaults: DEFAULT_TRAINING_SETTINGS,
  clamp: clampTrainingSettings,
  merge: flatMerge(clampTrainingSettings),
};
