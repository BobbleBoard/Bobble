/**
 * THE FEATURE SETTINGS GROUPS, composed once.
 *
 * Six features of the push each own one top-level group of DesktopSettings —
 * memory, training, devices, design, workflows, editor — defined in its own
 * file beside this one (deliverables/research/PLAN.md R6). This file is the
 * list (lane INT's); settings-contract.ts, settings-logic.ts and the renderer's
 * settings store read the composition from here, so adding a key to a group is
 * an edit to that group's file only.
 */
import { type DesignSettings, designSettings } from './design-settings';
import { type DevicesSettings, devicesSettings } from './devices-settings';
import { type EditorSettings, editorSettings } from './editor-settings';
import type { FeatureSettingsGroup } from './feature-group';
import { type MemorySettings, memorySettings } from './memory-settings';
import { type QuickPanelSettings, quickPanelSettings } from './quick-panel-settings';
import { type TrainingSettings, trainingSettings } from './training-settings';
import { type WorkflowsSettings, workflowsSettings } from './workflows-settings';

export type { FeatureSettingsGroup } from './feature-group';
export type {
  DesignSettings,
  DevicesSettings,
  EditorSettings,
  MemorySettings,
  QuickPanelSettings,
  TrainingSettings,
  WorkflowsSettings,
};

/** The groups as they appear in DesktopSettings. */
export interface FeatureSettings {
  memory: MemorySettings;
  training: TrainingSettings;
  devices: DevicesSettings;
  design: DesignSettings;
  workflows: WorkflowsSettings;
  editor: EditorSettings;
  quickPanel: QuickPanelSettings;
}

/** A patch names the groups it changes, and within a group the fields. */
export type FeatureSettingsPatch = {
  [K in keyof FeatureSettings]?: Partial<FeatureSettings[K]>;
};

export type FeatureSettingsKey = keyof FeatureSettings;

/** Every group, keyed like DesktopSettings. */
export const FEATURE_SETTINGS: {
  readonly [K in FeatureSettingsKey]: FeatureSettingsGroup<K, FeatureSettings[K]>;
} = {
  memory: memorySettings,
  training: trainingSettings,
  devices: devicesSettings,
  design: designSettings,
  workflows: workflowsSettings,
  editor: editorSettings,
  quickPanel: quickPanelSettings,
};

export const FEATURE_SETTINGS_KEYS = Object.keys(FEATURE_SETTINGS) as FeatureSettingsKey[];

/** Everything off. */
export const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
  memory: memorySettings.defaults,
  training: trainingSettings.defaults,
  devices: devicesSettings.defaults,
  design: designSettings.defaults,
  workflows: workflowsSettings.defaults,
  editor: editorSettings.defaults,
  quickPanel: quickPanelSettings.defaults,
};

/** Each group of an untrusted document, clamped; an absent group reads as its defaults. */
export function clampFeatureSettings(o: Record<string, unknown>): FeatureSettings {
  return {
    memory: memorySettings.clamp(o.memory),
    training: trainingSettings.clamp(o.training),
    devices: devicesSettings.clamp(o.devices),
    design: designSettings.clamp(o.design),
    workflows: workflowsSettings.clamp(o.workflows),
    editor: editorSettings.clamp(o.editor),
    quickPanel: quickPanelSettings.clamp(o.quickPanel),
  };
}

/** Each group merged one level with its part of a patch. */
export function mergeFeatureSettings(
  current: FeatureSettings,
  patch: FeatureSettingsPatch,
): FeatureSettings {
  return {
    memory: memorySettings.merge(current.memory, patch.memory),
    training: trainingSettings.merge(current.training, patch.training),
    devices: devicesSettings.merge(current.devices, patch.devices),
    design: designSettings.merge(current.design, patch.design),
    workflows: workflowsSettings.merge(current.workflows, patch.workflows),
    editor: editorSettings.merge(current.editor, patch.editor),
    quickPanel: quickPanelSettings.merge(current.quickPanel, patch.quickPanel),
  };
}
