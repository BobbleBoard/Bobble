/**
 * A PICTURE STILL NEEDS A SERVER TO GO TO.
 *
 * With Vision switched off, an attached image is sent as it is — the provider
 * tells the model vision is off (resolveVisionTarget → 'off'). The image branch
 * of the send used to rely on the vision relaunch to bring the model up, so
 * once 'off' skipped that relaunch nothing started the server: a chat server
 * that had crashed or been stopped stayed down and pi posted the message to a
 * dead endpoint ('fetch failed'). A text message in the same state waited for
 * the server; so must this one. The bridge is mocked; the order of what went
 * out is the evidence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: string[] = [];

vi.mock('../chat/auto-router', () => ({
  lastServerProblem: vi.fn(() => null),
  chatServerReady: vi.fn(() => true),
  maybeRouteAuto: vi.fn(async () => undefined),
  ensureChatServerReady: vi.fn(async () => {
    sent.push('ensureChatServerReady');
  }),
}));

const invoke = vi.fn(async (channel: string) => {
  sent.push(channel);
  return { success: true };
});
(globalThis as unknown as { window: unknown }).window = {
  location: { search: '' },
  piDesktop: { invoke, onEvent: () => () => {} },
};

const { sendPrompt } = await import('./pi-connect');
const { usePiStore } = await import('./pi-slice');
const { useLlmStore } = await import('./llm-store');
const { useSettingsStore } = await import('./settings-store');

beforeEach(() => {
  sent.length = 0;
  usePiStore.setState({
    messages: [],
    queuedSends: [],
    promptInFlight: false,
    bgRun: null,
    session: { sessionFile: '/s/chat.jsonl' },
    agent: { ...usePiStore.getState().agent, isStreaming: false, pendingMessageCount: 0 },
  });
});

describe('an image sent with Vision off', () => {
  it('starts (or waits for) the chat server before it goes to pi', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, loadVision: false } }));
    // The chat server crashed: nothing is up, and nothing is coming up.
    useLlmStore.setState((s) => ({
      status: { ...s.status, phase: 'error', serverRunning: false, model: null },
    }));

    await sendPrompt('what is in this picture?', ['data:image/png;base64,AAAA']);

    expect(sent).toContain('pi:prompt');
    expect(sent.indexOf('ensureChatServerReady')).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf('ensureChatServerReady')).toBeLessThan(sent.indexOf('pi:prompt'));
  });
});
