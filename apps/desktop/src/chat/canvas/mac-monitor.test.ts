import { describe, expect, it } from 'vitest';
import { MAC_MONITOR_TAB_KEY, macMonitorTabAction } from './mac-monitor';

describe('macMonitorTabAction', () => {
  it('opens nothing while nothing is being controlled', () => {
    expect(macMonitorTabAction({ active: false, appName: '' }, undefined)).toBeNull();
  });

  it('drops the app name from the tab when the session ends', () => {
    expect(
      macMonitorTabAction({ active: false, appName: 'TextEdit' }, { id: 't1', title: 'TextEdit' }),
    ).toEqual({ kind: 'retitle', id: 't1', title: 'Computer use' });
    // …and then leaves it alone.
    expect(
      macMonitorTabAction({ active: false, appName: '' }, { id: 't1', title: 'Computer use' }),
    ).toBeNull();
  });

  it('opens ONE tab, titled with the controlled app', () => {
    expect(macMonitorTabAction({ active: true, appName: 'TextEdit' }, undefined)).toEqual({
      kind: 'open',
      title: 'TextEdit',
    });
  });

  it('reuses the existing tab rather than piling up duplicates', () => {
    expect(
      macMonitorTabAction({ active: true, appName: 'TextEdit' }, { id: 't1', title: 'TextEdit' }),
    ).toBeNull();
  });

  it('retitles when the session moves to a different app', () => {
    expect(
      macMonitorTabAction({ active: true, appName: 'Notes' }, { id: 't1', title: 'TextEdit' }),
    ).toEqual({ kind: 'retitle', id: 't1', title: 'Notes' });
  });

  it('falls back to a name rather than an empty tab label', () => {
    expect(macMonitorTabAction({ active: true, appName: '   ' }, undefined)).toEqual({
      kind: 'open',
      title: 'Computer use',
    });
  });

  it('keeps a stable upsert key so repeat sessions reuse the one tab', () => {
    expect(MAC_MONITOR_TAB_KEY).toBe('mac-monitor');
  });
});
