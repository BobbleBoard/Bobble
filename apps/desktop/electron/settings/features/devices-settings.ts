/**
 * `devices` — DEVICES SETTINGS, one group of DesktopSettings.
 *
 * Devices on the tailnet: using another computer's models, and sharing this
 * one's. Off until the Devices panel ships. DEV-6 adds `inferenceDevice`,
 * `generationDevices`, `sharing`, `deviceFallback` and `keepLocalBackup`.
 *
 * SKELETON from the W0-A pre-wire (deliverables/research/PLAN.md §2.3, R6): it
 * is already composed into DesktopSettings, DEFAULT_SETTINGS, clampSettings,
 * mergeSettingsPatch and the renderer's store, so lane DEV adds keys HERE
 * — type, default (off), clamp — and nowhere else. Every key needs an entry in
 * the help registry (`electron/help/registry/<section>.ts`, BH-1) and stays
 * `internal` there until its UI ships. Side effects subscribe with
 * `subscribeSettings('devices', …)` in settings-main.ts, never a new callback.
 * First filled by DEV-6 (W2) (deliverables/research/devices-tailscale.md §4.12).
 */
import { bool, type FeatureSettingsGroup, flatMerge, record } from './feature-group';

export interface DevicesSettings {
  /** The feature's master switch. Off until its lane ships the UI that turns it on. */
  enabled: boolean;
}

export const DEFAULT_DEVICES_SETTINGS: DevicesSettings = { enabled: false };

export function clampDevicesSettings(raw: unknown): DevicesSettings {
  const o = record(raw);
  return { enabled: bool(o.enabled, DEFAULT_DEVICES_SETTINGS.enabled) };
}

export const devicesSettings: FeatureSettingsGroup<'devices', DevicesSettings> = {
  key: 'devices',
  defaults: DEFAULT_DEVICES_SETTINGS,
  clamp: clampDevicesSettings,
  merge: flatMerge(clampDevicesSettings),
};
