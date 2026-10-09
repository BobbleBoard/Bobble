// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appIconSrc, useAppIconStore } from './app-icons';

const SAFARI = 'data:image/png;base64,c2FmYXJp';

type Invoke = (channel: string, request: unknown) => Promise<unknown>;

function stubInvoke(impl: Invoke) {
  const invoke = vi.fn(impl);
  (window as unknown as { piDesktop: unknown }).piDesktop = { invoke };
  return invoke;
}

/** Let the store's async ask settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the chat's app icons", () => {
  beforeEach(() => useAppIconStore.setState({ icons: {} }));

  it('asks main over the real channel — never the test-only mac:debug', async () => {
    const invoke = stubInvoke(async () => ({ icon: SAFARI }));
    expect(appIconSrc('Safari')).toBeUndefined();
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('mac:app-icon', { app: 'Safari' });
    expect(invoke.mock.calls.some(([channel]) => channel === 'mac:debug')).toBe(false);
    expect(appIconSrc('Safari')).toBe(SAFARI);
  });

  it('asks once per app, however many rows want it at once', async () => {
    const invoke = stubInvoke(async () => ({ icon: SAFARI }));
    appIconSrc('Safari');
    appIconSrc('Safari');
    appIconSrc(' Safari ');
    await settle();
    appIconSrc('Safari');
    expect(invoke).toHaveBeenCalledTimes(1);
    // The padded name is the same app, and finds the same picture.
    expect(appIconSrc(' Safari ')).toBe(SAFARI);
  });

  it('bumps the store when the icon lands, so a row that asked repaints', async () => {
    stubInvoke(async () => ({ icon: SAFARI }));
    const seen: (string | null | undefined)[] = [];
    const stop = useAppIconStore.subscribe((s) => seen.push(s.icons.Safari));
    appIconSrc('Safari');
    await settle();
    stop();
    expect(seen).toEqual([SAFARI]);
  });

  it('remembers an app with no icon, and does not ask again', async () => {
    const invoke = stubInvoke(async () => ({ icon: null }));
    appIconSrc('No Such App');
    await settle();
    expect(appIconSrc('No Such App')).toBeUndefined();
    expect(useAppIconStore.getState().icons['No Such App']).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('remembers a failed ask as no icon rather than retrying every frame', async () => {
    const invoke = stubInvoke(async () => {
      throw new Error('no handler');
    });
    appIconSrc('TextEdit');
    await settle();
    appIconSrc('TextEdit');
    expect(useAppIconStore.getState().icons.TextEdit).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('asks nothing for a row with no app', () => {
    const invoke = stubInvoke(async () => ({ icon: SAFARI }));
    expect(appIconSrc(undefined)).toBeUndefined();
    expect(appIconSrc('')).toBeUndefined();
    expect(appIconSrc('   ')).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
