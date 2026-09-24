/**
 * `workflows` — WORKFLOWS SETTINGS, one group of DesktopSettings.
 *
 * Saved workflows and Deep research. Off until the Workflows page ships.
 * The lane adds `yieldToChat`, `defaultDepth`, `battery` and `judge`.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3, R6): it
 * is already composed into DesktopSettings, DEFAULT_SETTINGS, clampSettings,
 * mergeSettingsPatch and the renderer's store, so lane WF adds keys HERE
 * — type, default (off), clamp — and nowhere else. Every key needs an entry in
 * the help registry (`electron/help/registry/<section>.ts`, BH-1) and stays
 * `internal` there until its UI ships. Side effects subscribe with
 * `subscribeSettings('workflows', …)` in settings-main.ts, never a new callback.
 * First filled by WF-02 (W2), WF-15 (W4) (deliverables/research/workflows.md §5).
 */
import { bool, type FeatureSettingsGroup, flatMerge, record } from './feature-group';

export interface WorkflowsSettings {
  /** The feature's master switch. Off until its lane ships the UI that turns it on. */
  enabled: boolean;
}

export const DEFAULT_WORKFLOWS_SETTINGS: WorkflowsSettings = { enabled: false };

export function clampWorkflowsSettings(raw: unknown): WorkflowsSettings {
  const o = record(raw);
  return { enabled: bool(o.enabled, DEFAULT_WORKFLOWS_SETTINGS.enabled) };
}

export const workflowsSettings: FeatureSettingsGroup<'workflows', WorkflowsSettings> = {
  key: 'workflows',
  defaults: DEFAULT_WORKFLOWS_SETTINGS,
  clamp: clampWorkflowsSettings,
  merge: flatMerge(clampWorkflowsSettings),
};
