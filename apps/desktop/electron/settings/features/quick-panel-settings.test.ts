import { describe, expect, it } from 'vitest';
import { clampSettings, DEFAULT_SETTINGS, mergeSettingsPatch } from '../settings-logic';
import { clampQuickPanelSettings, DEFAULT_QUICK_PANEL_SETTINGS } from './quick-panel-settings';

describe('the quick panel settings', () => {
  it('ship on, with the summon and area keys assigned', () => {
    expect(DEFAULT_SETTINGS.quickPanel).toEqual(DEFAULT_QUICK_PANEL_SETTINGS);
    expect(DEFAULT_QUICK_PANEL_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_QUICK_PANEL_SETTINGS.hotkeys).toEqual({
      summon: 'Alt+Shift+Space',
      region: 'Alt+Shift+Command+4',
      window: null,
      screen: null,
      dictate: null,
    });
  });

  it('clamp a hand-edited file: keys canonicalised, a removed key stays removed, junk falls back', () => {
    const s = clampQuickPanelSettings({
      enabled: 'yes',
      hotkeys: { summon: 'shift+option+space', region: null, window: 'Banana+Q', dictate: 7 },
      readSelection: false,
    });
    expect(s.enabled).toBe(true);
    expect(s.hotkeys.summon).toBe('Alt+Shift+Space');
    expect(s.hotkeys.region).toBeNull();
    expect(s.hotkeys.window).toBeNull();
    expect(s.hotkeys.dictate).toBeNull();
    expect(s.hotkeys.screen).toBeNull();
    expect(s.readSelection).toBe(false);
    expect(s.closeOnBlur).toBe(true);
  });

  it('a patch to one key keeps the others, and the document round-trips', () => {
    const next = mergeSettingsPatch(DEFAULT_SETTINGS, {
      quickPanel: {
        hotkeys: { ...DEFAULT_SETTINGS.quickPanel.hotkeys, dictate: 'Control+Alt+Command+D' },
      },
    });
    expect(next.quickPanel.hotkeys.summon).toBe('Alt+Shift+Space');
    expect(next.quickPanel.hotkeys.dictate).toBe('Control+Alt+Command+D');
    expect(clampSettings(JSON.parse(JSON.stringify(next))).quickPanel).toEqual(next.quickPanel);
    const off = mergeSettingsPatch(next, { quickPanel: { enabled: false } });
    expect(off.quickPanel.enabled).toBe(false);
    expect(off.quickPanel.hotkeys.dictate).toBe('Control+Alt+Command+D');
  });
});
