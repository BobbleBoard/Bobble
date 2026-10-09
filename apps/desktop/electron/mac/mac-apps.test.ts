import { describe, expect, it } from 'vitest';
import { findInstalledApp, orderApps, sameApp } from './mac-apps';

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

describe('findInstalledApp — the installed app a chat row names', () => {
  const apps = [
    { id: 'com.google.chrome.remotedesktop', name: 'Chrome Remote Desktop' },
    { id: 'com.google.Chrome', name: 'Google Chrome' },
    { id: 'com.apple.TextEdit', name: 'TextEdit' },
    { id: 'com.apple.Notes', name: 'Notes' },
    { id: 'com.example.x', name: 'X' },
  ];
  const find = (q: string) => findInstalledApp(apps, q)?.name;

  it('takes an exact name or bundle id, ignoring case', () => {
    expect(find('TextEdit')).toBe('TextEdit');
    expect(find('textedit')).toBe('TextEdit');
    expect(find(' Notes ')).toBe('Notes');
    expect(find('com.google.chrome')).toBe('Google Chrome');
    expect(find('x')).toBe('X');
  });

  it("reads the model's shorthand as the closest app that holds it", () => {
    expect(find('chrome')).toBe('Google Chrome');
    expect(find('Chrome Remote')).toBe('Chrome Remote Desktop');
  });

  it('reads a longer name as the app inside it', () => {
    expect(find('Google Chrome browser')).toBe('Google Chrome');
  });

  it('never matches on a sliver', () => {
    // "X" is inside "textedit browser"; "te" is inside "TextEdit".
    expect(find('the textedit window')).toBe('TextEdit');
    expect(find('te')).toBeUndefined();
    expect(find('')).toBeUndefined();
    expect(find('Blender')).toBeUndefined();
  });
});
