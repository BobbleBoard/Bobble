import { describe, expect, it } from 'vitest';
import { orderApps, sameApp } from './mac-apps';

describe('the order the chooser shows apps in', () => {
  it('puts the familiar apps first, in their own order, then the rest by name', () => {
    const apps = [
      { id: 'com.zed.Zed', name: 'Zed' },
      { id: 'com.apple.Notes', name: 'Notes' },
      { id: 'com.apple.ActivityMonitor', name: 'Activity Monitor' },
      { id: 'com.apple.Safari', name: 'Safari' },
      { id: 'org.blender', name: 'blender' },
    ];
    expect(orderApps(apps).map((a) => a.name)).toEqual([
      'Safari',
      'Notes',
      'Activity Monitor',
      'blender',
      'Zed',
    ]);
  });

  it('matches familiar ids regardless of case', () => {
    const apps = [
      { id: 'com.apple.textedit', name: 'TextEdit' },
      { id: 'com.apple.Automator', name: 'Automator' },
    ];
    expect(orderApps(apps)[0]?.name).toBe('TextEdit');
  });
});

describe("sameApp — the model's name for an app and macOS's are one app", () => {
  it('matches exactly, by substring from either side, never on nothing', () => {
    expect(sameApp('Google Chrome', 'Google Chrome')).toBe(true);
    expect(sameApp('Google Chrome', 'chrome')).toBe(true);
    expect(sameApp('chrome', 'Google Chrome')).toBe(true);
    expect(sameApp('TextEdit', 'Google Chrome')).toBe(false);
    expect(sameApp('', 'Google Chrome')).toBe(false);
    expect(sameApp('Claude', 'Google Chrome')).toBe(false);
  });
});
