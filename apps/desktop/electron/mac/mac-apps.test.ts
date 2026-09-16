import { describe, expect, it } from 'vitest';
import { orderApps } from './mac-apps';

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
