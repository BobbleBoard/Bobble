import { describe, expect, it } from 'vitest';
import { clampSettings, DEFAULT_SETTINGS, mergeSettingsPatch } from '../settings-logic';
import {
  clampFeatureSettings,
  DEFAULT_FEATURE_SETTINGS,
  FEATURE_SETTINGS,
  FEATURE_SETTINGS_KEYS,
  mergeFeatureSettings,
} from './index';

describe('the feature settings groups (W0-A pre-wire)', () => {
  it('are the six planned groups, each keyed as it appears in DesktopSettings', () => {
    expect(FEATURE_SETTINGS_KEYS).toEqual([
      'memory',
      'training',
      'devices',
      'design',
      'workflows',
      'editor',
    ]);
    for (const key of FEATURE_SETTINGS_KEYS) expect(FEATURE_SETTINGS[key].key).toBe(key);
  });

  it('default to everything off', () => {
    for (const key of FEATURE_SETTINGS_KEYS) {
      expect(DEFAULT_FEATURE_SETTINGS[key]).toEqual({ enabled: false });
      expect(DEFAULT_SETTINGS[key]).toEqual(DEFAULT_FEATURE_SETTINGS[key]);
    }
    expect(DEFAULT_SETTINGS.capabilities.training).toBe(false);
  });

  it('read an old settings.json (no groups) as the defaults', () => {
    const s = clampSettings({ theme: { flavor: 'codex', mode: 'dark' } });
    for (const key of FEATURE_SETTINGS_KEYS) expect(s[key]).toEqual({ enabled: false });
    expect(s.capabilities.training).toBe(false);
  });

  it('keep what is valid and drop what is not', () => {
    const g = clampFeatureSettings({
      memory: { enabled: true, stray: 1 },
      training: { enabled: 'yes' },
      devices: 'nonsense',
      design: null,
      workflows: [true],
    });
    expect(g.memory).toEqual({ enabled: true });
    expect(g.training).toEqual({ enabled: false });
    expect(g.devices).toEqual({ enabled: false });
    expect(g.design).toEqual({ enabled: false });
    expect(g.workflows).toEqual({ enabled: false });
    expect(g.editor).toEqual({ enabled: false });
  });

  it('merge one level: a patch names its group and leaves the others alone', () => {
    const on = mergeFeatureSettings(DEFAULT_FEATURE_SETTINGS, { memory: { enabled: true } });
    expect(on.memory.enabled).toBe(true);
    expect(on.training).toEqual({ enabled: false });
    const back = mergeFeatureSettings(on, { devices: { enabled: true } });
    expect(back.memory.enabled).toBe(true);
    expect(back.devices.enabled).toBe(true);
  });

  it('round-trip through the settings document — clamp, merge, JSON and back', () => {
    const next = mergeSettingsPatch(DEFAULT_SETTINGS, {
      workflows: { enabled: true },
      capabilities: { training: true },
    });
    expect(next.workflows.enabled).toBe(true);
    expect(next.capabilities).toEqual({ ...DEFAULT_SETTINGS.capabilities, training: true });
    expect(clampSettings(JSON.parse(JSON.stringify(next)))).toEqual(next);
    // …and a patch that touches none of them changes none of them.
    const untouched = mergeSettingsPatch(next, { effort: 'high' });
    expect(untouched.workflows).toEqual(next.workflows);
    expect(untouched.memory).toEqual(next.memory);
  });
});
