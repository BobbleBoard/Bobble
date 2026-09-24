import { afterEach, describe, expect, it } from 'vitest';
import { navigate, setNavAllowList, useAppNavStore } from './app-nav-store';

const allow = () => ({
  settingsSections: ['appearance'],
  views: { models: ['storage'] },
  studios: ['image' as const],
});

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  useAppNavStore.setState({ pending: null, focusSettingId: null, viewTab: null });
});

describe('the app nav store', () => {
  it('refuses everything but the chat until App installs the allow-list', () => {
    expect(navigate('settings:appearance')).toBe(false);
    expect(useAppNavStore.getState().pending).toBeNull();
    expect(navigate({ kind: 'chat' })).toBe(true);
  });

  it('queues an allowed target for App, with a fresh seq each time, and carries the row', () => {
    restore = setNavAllowList(allow);
    expect(navigate('bobble://settings/appearance#theme.mode')).toBe(true);
    const first = useAppNavStore.getState().pending;
    expect(first?.target).toEqual({
      kind: 'settings',
      section: 'appearance',
      settingId: 'theme.mode',
    });
    expect(useAppNavStore.getState().focusSettingId).toBe('theme.mode');
    expect(useAppNavStore.getState().take()).toEqual(first);
    expect(useAppNavStore.getState().pending).toBeNull();
    navigate('settings:appearance');
    expect((useAppNavStore.getState().pending?.seq ?? 0) > (first?.seq ?? 0)).toBe(true);
    expect(useAppNavStore.getState().focusSettingId).toBeNull();
  });

  it('checks an object target against the same allow-list as a link', () => {
    restore = setNavAllowList(allow);
    expect(navigate({ kind: 'view', view: 'models', tab: 'storage' })).toBe(true);
    expect(useAppNavStore.getState().viewTab).toBe('storage');
    expect(navigate({ kind: 'view', view: 'models', tab: 'discover' })).toBe(false);
    expect(navigate({ kind: 'studio', studio: 'video' })).toBe(false);
    expect(navigate({ kind: 'settings', section: 'memory' })).toBe(false);
  });
});
