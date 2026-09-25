// @vitest-environment jsdom
/**
 * A VISION SWITCH FLIPPED WHILE THE MODEL IS LOADING IS APPLIED.
 *
 * The launch in flight captured the old setting, and the server is not running
 * yet (the supervisor disposes the old one before it spawns), so a flip that
 * only relaunched a RUNNING server was saved and never applied: the model came
 * up with its projector and the switch saying Off — or blind with it saying On.
 * The flip must ask for the relaunch; the supervisor makes it wait for the load.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
(window as unknown as { piDesktop: unknown }).piDesktop = {
  invoke: vi.fn(async () => undefined),
  onEvent: () => () => {},
};

const { VisionRow } = await import('./EngineMenu');
const { useLlmStore } = await import('../state/llm-store');
const { useSettingsStore } = await import('../state/settings-store');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function flip(): Promise<void> {
  const box = host?.querySelector('[data-testid="engine-vision-switch"]');
  if (!(box instanceof HTMLElement)) throw new Error('no Vision switch');
  await act(async () => {
    box.click();
  });
}

function setUp(status: { phase: 'starting' | 'ready' | 'idle'; serverRunning: boolean }) {
  const relaunch = vi.fn(async () => ({ success: true }));
  useLlmStore.setState((s) => ({ status: { ...s.status, ...status }, relaunch }));
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, loadVision: true },
    update: async ({ loadVision }) => {
      useSettingsStore.setState((x) => ({
        settings: { ...x.settings, ...(loadVision !== undefined ? { loadVision } : {}) },
      }));
    },
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<VisionRow onNote={() => {}} />));
  return relaunch;
}

describe('the Vision switch', () => {
  it('relaunches when flipped while the model is still loading', async () => {
    const relaunch = setUp({ phase: 'starting', serverRunning: false });
    await flip();
    expect(useSettingsStore.getState().settings.loadVision).toBe(false);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('relaunches a running server, as before', async () => {
    const relaunch = setUp({ phase: 'ready', serverRunning: true });
    await flip();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('only saves the setting when no model is up or coming up', async () => {
    const relaunch = setUp({ phase: 'idle', serverRunning: false });
    await flip();
    expect(useSettingsStore.getState().settings.loadVision).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
  });
});
