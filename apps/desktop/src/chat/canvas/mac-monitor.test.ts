import { describe, expect, it } from 'vitest';
import { MAC_MONITOR_TAB_KEY, macMonitorMayOpen, macMonitorTabAction } from './mac-monitor';

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

describe('macMonitorMayOpen — the tab stays in the chat that is driving', () => {
  const base = {
    owner: '/s/a.jsonl',
    viewed: '/s/a.jsonl',
    backgroundRun: false,
    dismissed: false,
  };
  it('opens in the owning chat', () => {
    expect(macMonitorMayOpen(base)).toBe(true);
  });
  it('does not follow the user into another chat', () => {
    expect(macMonitorMayOpen({ ...base, viewed: '/s/b.jsonl' })).toBe(false);
  });
  it('never opens over a chat while the run is in the background', () => {
    // The viewed chat is not the one driving, whatever the pointers say.
    expect(macMonitorMayOpen({ ...base, backgroundRun: true })).toBe(false);
    expect(macMonitorMayOpen({ ...base, viewed: '/s/b.jsonl', backgroundRun: true })).toBe(false);
  });
  it('stays closed for the rest of a session the user closed it in', () => {
    expect(macMonitorMayOpen({ ...base, dismissed: true })).toBe(false);
  });
  it('opens when the owner is unknown (a chat with no file yet) and nothing runs in the background', () => {
    expect(macMonitorMayOpen({ ...base, owner: null, viewed: null })).toBe(true);
    expect(macMonitorMayOpen({ ...base, owner: null, viewed: '/s/b.jsonl' })).toBe(true);
  });
});
