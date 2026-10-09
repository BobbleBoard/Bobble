import { describe, expect, it } from 'vitest';
import { clampSettings, DEFAULT_SETTINGS, mergeSettingsPatch } from '../settings-logic';
import { clampDesignSettings, DEFAULT_DESIGN_SETTINGS, designKitEnv } from './design-settings';
import {
  clampFeatureSettings,
  DEFAULT_FEATURE_SETTINGS,
  FEATURE_SETTINGS,
  FEATURE_SETTINGS_KEYS,
  mergeFeatureSettings,
} from './index';

/** The six groups the W0-A pre-wire planned, all shipped off. */
const PUSH_KEYS = FEATURE_SETTINGS_KEYS.filter((k) => k !== 'quickPanel');

describe('the feature settings groups (W0-A pre-wire)', () => {
  it('are the six planned groups, each keyed as it appears in DesktopSettings', () => {
    expect(FEATURE_SETTINGS_KEYS).toEqual([
      'memory',
      'training',
      'devices',
      'design',
      'workflows',
      'editor',
      'quickPanel',
    ]);
    for (const key of FEATURE_SETTINGS_KEYS) expect(FEATURE_SETTINGS[key].key).toBe(key);
  });

  it('default to everything off', () => {
    // The quick panel ships on (see quick-panel-settings.test.ts).
    for (const key of PUSH_KEYS) {
      expect(DEFAULT_FEATURE_SETTINGS[key].enabled, key).toBe(false);
      expect(DEFAULT_SETTINGS[key]).toEqual(DEFAULT_FEATURE_SETTINGS[key]);
    }
    // Groups whose lanes have not added keys yet are the bare switch.
    for (const key of PUSH_KEYS.filter((k) => k !== 'design')) {
      expect(DEFAULT_FEATURE_SETTINGS[key]).toEqual({ enabled: false });
    }
    expect(DEFAULT_SETTINGS.design).toEqual(DEFAULT_DESIGN_SETTINGS);
    expect(DEFAULT_SETTINGS.capabilities.training).toBe(false);
  });

  it('read an old settings.json (no groups) as the defaults', () => {
    const s = clampSettings({ theme: { flavor: 'codex', mode: 'dark' } });
    for (const key of FEATURE_SETTINGS_KEYS) expect(s[key]).toEqual(DEFAULT_FEATURE_SETTINGS[key]);
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
    expect(g.design).toEqual(DEFAULT_DESIGN_SETTINGS);
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

/*
 * VQ-04 fills the design group (deliverables/research/visual-quality.md §4.6):
 * the kit, pictures in documents, the check-and-fix pass and the vision look.
 */
describe('the design settings (VQ-04)', () => {
  it('default to the house kit, no pictures, check & fix, look when the model can see — and off', () => {
    expect(DEFAULT_DESIGN_SETTINGS).toEqual({
      enabled: false,
      kit: 'paper-blue',
      images: 'off',
      lint: 'fix',
      look: 'auto',
    });
  });

  it('clamp a hand-edited file: unknown choices fall back, a kit id is kept only when it is one', () => {
    expect(
      clampDesignSettings({
        enabled: true,
        kit: 'Fog',
        images: 'final',
        lint: 'report',
        look: 'off',
      }),
    ).toEqual({ enabled: true, kit: 'fog', images: 'final', lint: 'report', look: 'off' });
    expect(
      clampDesignSettings({ kit: 'no such kit!', images: 'always', lint: 7, look: null }),
    ).toEqual(DEFAULT_DESIGN_SETTINGS);
    // A brand kit a later version knows is kept as written; it resolves where it is read.
    expect(clampDesignSettings({ kit: 'brand-tidewell' }).kit).toBe('brand-tidewell');
  });

  it('merge a patch and round-trip through the settings document', () => {
    const next = mergeSettingsPatch(DEFAULT_SETTINGS, { design: { kit: 'slate-cobalt' } });
    expect(next.design).toEqual({ ...DEFAULT_DESIGN_SETTINGS, kit: 'slate-cobalt' });
    expect(clampSettings(JSON.parse(JSON.stringify(next))).design).toEqual(next.design);
  });

  it('tell a pi child its kit only while the setting is on', () => {
    expect(designKitEnv(DEFAULT_DESIGN_SETTINGS)).toBeUndefined();
    expect(designKitEnv({ ...DEFAULT_DESIGN_SETTINGS, enabled: true, kit: 'fog' })).toBe('fog');
  });
});
