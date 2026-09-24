/**
 * `memory` — MEMORY SETTINGS, one group of DesktopSettings.
 *
 * Memory (Hindsight): what Bobble learns across chats. `enabled` is THE
 * one-click switch — off by default (PLAN.md Q10) — and off means no
 * learning, no recall and no memory process. WP-M1 adds `autoRecall`,
 * `autoRetain`, `learnOnBattery`, `idleSeconds` and `excludedChats`.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3, R6): it
 * is already composed into DesktopSettings, DEFAULT_SETTINGS, clampSettings,
 * mergeSettingsPatch and the renderer's store, so lane MEM adds keys HERE
 * — type, default (off), clamp — and nowhere else. Every key needs an entry in
 * the help registry (`electron/help/registry/<section>.ts`, BH-1) and stays
 * `internal` there until its UI ships. Side effects subscribe with
 * `subscribeSettings('memory', …)` in settings-main.ts, never a new callback.
 * First filled by WP-M1 (W1) (deliverables/research/hindsight-memory.md §4.7).
 */
import { bool, type FeatureSettingsGroup, flatMerge, record } from './feature-group';

export interface MemorySettings {
  /** The feature's master switch. Off until its lane ships the UI that turns it on. */
  enabled: boolean;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { enabled: false };

export function clampMemorySettings(raw: unknown): MemorySettings {
  const o = record(raw);
  return { enabled: bool(o.enabled, DEFAULT_MEMORY_SETTINGS.enabled) };
}

export const memorySettings: FeatureSettingsGroup<'memory', MemorySettings> = {
  key: 'memory',
  defaults: DEFAULT_MEMORY_SETTINGS,
  clamp: clampMemorySettings,
  merge: flatMerge(clampMemorySettings),
};
