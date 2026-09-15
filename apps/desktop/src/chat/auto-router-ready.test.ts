// @vitest-environment jsdom
/**
 * ensureChatServerReady — the send gate holds while a switch the RENDERER has
 * decided on is still in flight.
 *
 * MEASURED 2026-09-15: "present it" typed right after a picture on a text-only
 * engine — the on-demand vision relaunch had raised the "switching…" banner,
 * the supervisor had not yet said 'starting', the gate saw a ready server and
 * dispatched, and pi's request landed on a port being torn down ("fetch failed").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLlmStore } from '../state/llm-store';
import { useModelSelectionStore } from '../state/model-selection-store';
import { ensureChatServerReady } from './auto-router';

const ready = () =>
  useLlmStore.setState((s) => ({
    status: {
      ...s.status,
      phase: 'ready',
      serverRunning: true,
      baseUrl: 'http://127.0.0.1:1/v1',
      model: { id: 'qwen3.5-4b-mtp', name: 'q', quant: 'Q8_0' } as never,
      downloadedModelIds: ['qwen3.5-4b-mtp'],
    },
  }));

describe('ensureChatServerReady while a model switch is in flight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as { piDesktop: unknown }).piDesktop = {
      invoke: vi.fn(async () => ({})),
      onEvent: vi.fn(() => () => {}),
    };
    useLlmStore.setState({
      refreshCatalog: async () => {},
      refreshStatus: async () => {},
    } as never);
    ready();
    useModelSelectionStore.getState().setSwitching(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    useModelSelectionStore.getState().setSwitching(null);
  });

  it('is a no-op when the server is ready and nothing is switching', async () => {
    await expect(ensureChatServerReady()).resolves.toBeUndefined();
  });

  it('waits for the switch to finish, then lets the send go', async () => {
    useModelSelectionStore.getState().setSwitching({ toTier: 'fast', toName: 'q (vision)' });
    let released = false;
    const gate = ensureChatServerReady().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(released).toBe(false);
    // The relaunch lands: the banner drops and the server is ready again.
    useModelSelectionStore.getState().setSwitching(null);
    await vi.advanceTimersByTimeAsync(600);
    await gate;
    expect(released).toBe(true);
  });
});
