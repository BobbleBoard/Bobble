/**
 * `quickPanel` — THE QUICK PANEL'S SETTINGS, one group of DesktopSettings.
 *
 * The floating panel a global hotkey summons over any app (electron/quick/).
 * On by default — reaching Bobble from anywhere is the point of it — with two
 * keys assigned (see DEFAULT_HOTKEYS for why those two) and the rest left for
 * the person to choose.
 *
 * Pure (the renderer imports it): type, defaults, clamp. Main re-registers the
 * keys through `subscribeSettings('quickPanel', …)` in quick-main.ts.
 */
import {
  DEFAULT_HOTKEYS,
  normalizeHotkey,
  QUICK_ACTIONS,
  type QuickAction,
} from '../../quick/hotkeys';
import { bool, type FeatureSettingsGroup, flatMerge, record } from './feature-group';

export interface QuickPanelSettings {
  /** The panel and every hotkey. Off: nothing is registered. */
  enabled: boolean;
  /** Each action's global key (an Electron accelerator), or null for none. */
  hotkeys: Record<QuickAction, string | null>;
  /**
   * Read the text selected in the app in front when the panel opens, so it can
   * be offered as context. It is read on this Mac only and goes nowhere unless
   * the person sends it; off means the panel never looks.
   */
  readSelection: boolean;
  /** Clicking outside the panel puts it away (unless it is pinned). */
  closeOnBlur: boolean;
}

export const DEFAULT_QUICK_PANEL_SETTINGS: QuickPanelSettings = {
  enabled: true,
  hotkeys: { ...DEFAULT_HOTKEYS },
  readSelection: true,
  closeOnBlur: true,
};

export function clampQuickPanelSettings(raw: unknown): QuickPanelSettings {
  const o = record(raw);
  const keys = record(o.hotkeys);
  const hotkeys = {} as Record<QuickAction, string | null>;
  for (const action of QUICK_ACTIONS) {
    const value = keys[action];
    // Absent: the default. Explicit null: the person took the key away.
    hotkeys[action] =
      value === undefined
        ? DEFAULT_QUICK_PANEL_SETTINGS.hotkeys[action]
        : value === null
          ? null
          : normalizeHotkey(typeof value === 'string' ? value : null);
  }
  return {
    enabled: bool(o.enabled, DEFAULT_QUICK_PANEL_SETTINGS.enabled),
    hotkeys,
    readSelection: bool(o.readSelection, DEFAULT_QUICK_PANEL_SETTINGS.readSelection),
    closeOnBlur: bool(o.closeOnBlur, DEFAULT_QUICK_PANEL_SETTINGS.closeOnBlur),
  };
}

export const quickPanelSettings: FeatureSettingsGroup<'quickPanel', QuickPanelSettings> = {
  key: 'quickPanel',
  defaults: DEFAULT_QUICK_PANEL_SETTINGS,
  clamp: clampQuickPanelSettings,
  // `hotkeys` is merged one level deeper, so changing one key keeps the others.
  merge: (current, patch) =>
    patch === undefined
      ? current
      : flatMerge(clampQuickPanelSettings)(current, {
          ...patch,
          ...(patch.hotkeys !== undefined
            ? { hotkeys: { ...current.hotkeys, ...patch.hotkeys } }
            : {}),
        }),
};
