/**
 * `editor` — EDITOR SETTINGS, one group of DesktopSettings.
 *
 * The studios as editors (click-to-comment region edits, layers, the
 * version tree). Off until the Image editor ships (IMG-12).
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3, R6): it
 * is already composed into DesktopSettings, DEFAULT_SETTINGS, clampSettings,
 * mergeSettingsPatch and the renderer's store, so lane EDIT adds keys HERE
 * — type, default (off), clamp — and nowhere else. Every key needs an entry in
 * the help registry (`electron/help/registry/<section>.ts`, BH-1) and stays
 * `internal` there until its UI ships. Side effects subscribe with
 * `subscribeSettings('editor', …)` in settings-main.ts, never a new callback.
 * First filled by ED-01 (W1) (deliverables/research/studios-editors.md §5).
 */
import { bool, type FeatureSettingsGroup, flatMerge, record } from './feature-group';

export interface EditorSettings {
  /** The feature's master switch. Off until its lane ships the UI that turns it on. */
  enabled: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { enabled: false };

export function clampEditorSettings(raw: unknown): EditorSettings {
  const o = record(raw);
  return { enabled: bool(o.enabled, DEFAULT_EDITOR_SETTINGS.enabled) };
}

export const editorSettings: FeatureSettingsGroup<'editor', EditorSettings> = {
  key: 'editor',
  defaults: DEFAULT_EDITOR_SETTINGS,
  clamp: clampEditorSettings,
  merge: flatMerge(clampEditorSettings),
};
