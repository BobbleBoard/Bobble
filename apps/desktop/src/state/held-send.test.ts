/**
 * A SEND WHOSE MODEL DID NOT START IS HELD, NOT SENT INTO NOTHING.
 *
 * The user (2026-10-08): "our dreaded 'fetch failed'". The commonest cause was a
 * send that waited for the chat model, found none, and dispatched anyway. Now
 * the wait's reason (auto-router `lastServerProblem`) holds the message, Try
 * again (`retryHeldSend`) sends it once a model is up, and a later send takes
 * a held one with it. The bridge is mocked; what went out is the evidence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ channel: string; req: unknown }> = [];
let problem: { kind: 'failed' | 'no-model'; detail?: string } | null = null;
let ready = false;

vi.mock('../chat/auto-router', () => ({
  lastServerProblem: vi.fn(() => problem),
  chatServerReady: vi.fn(() => ready),
  maybeRouteAuto: vi.fn(async () => undefined),
  ensureChatServerReady: vi.fn(async () => undefined),
}));

let vision: { ok: boolean; reason?: string } = { ok: true };
vi.mock('./local-model', () => ({
  ensureVisionMode: vi.fn(async () => vision),
}));

const invoke = vi.fn(async (channel: string, req: unknown) => {
  sent.push({ channel, req });
  return { success: true };
});
(globalThis as unknown as { window: unknown }).window = {
  location: { search: '' },
  piDesktop: { invoke, onEvent: () => () => {} },
};

const { sendPrompt, retryHeldSend } = await import('./pi-connect');
const { usePiStore } = await import('./pi-slice');
const { useHeldSendStore } = await import('./held-send-store');

const prompts = () =>
  sent.filter((s) => s.channel === 'pi:prompt').map((s) => (s.req as { message: string }).message);

beforeEach(() => {
  sent.length = 0;
  problem = null;
  ready = false;
  vision = { ok: true };
  useHeldSendStore.getState().clear();
  usePiStore.setState({
    messages: [],
    queuedSends: [],
    promptInFlight: false,
    bgRun: null,
    session: { sessionFile: '/s/chat.jsonl' },
    agent: { ...usePiStore.getState().agent, isStreaming: false, pendingMessageCount: 0 },
  });
});

describe('a send whose model did not start', () => {
  it('is held under its bubble, not dispatched, and the composer is freed', async () => {
    problem = { kind: 'failed', detail: 'llama-server never became healthy on port 52011' };
    await sendPrompt('hello');
    expect(prompts()).toEqual([]);
    const held = useHeldSendStore.getState().held;
    expect(held?.message).toMatch(/hello$/);
    expect(held?.problem.kind).toBe('failed');
    expect(held?.echoId).toBe(usePiStore.getState().messages.at(-1)?.id);
    expect(usePiStore.getState().promptInFlight).toBe(false);
  });

  it('Try again sends it exactly as held once the model is up', async () => {
    problem = { kind: 'no-model' };
    await sendPrompt('hello');
    problem = null;
    ready = true;
    await retryHeldSend();
    expect(prompts()).toEqual([expect.stringMatching(/hello$/)]);
    expect(useHeldSendStore.getState().held).toBeNull();
  });

  it('Try again with the model still down keeps it held, with the new reason', async () => {
    problem = { kind: 'no-model' };
    await sendPrompt('hello');
    problem = { kind: 'failed', detail: 'needs 21 GB, 9 GB free' };
    await retryHeldSend();
    expect(prompts()).toEqual([]);
    expect(useHeldSendStore.getState().held?.problem.detail).toBe('needs 21 GB, 9 GB free');
    expect(useHeldSendStore.getState().held?.retrying).toBe(false);
  });

  it('a later send, with the model up, takes the held one first', async () => {
    problem = { kind: 'no-model' };
    await sendPrompt('first');
    problem = null;
    ready = true;
    await sendPrompt('second');
    expect(prompts()).toEqual([expect.stringMatching(/first$/), expect.stringMatching(/second$/)]);
    expect(useHeldSendStore.getState().held).toBeNull();
  });

  it('a run with no local server (nothing recorded) dispatches as before', async () => {
    problem = null;
    ready = false;
    await sendPrompt('hello');
    expect(prompts()).toEqual([expect.stringMatching(/hello$/)]);
  });

  it('a picture no model can see is held, and "Send without the picture" sends the words', async () => {
    vision = { ok: false, reason: 'no vision-capable model is downloaded' };
    ready = true;
    await sendPrompt('what is this?', ['data:image/png;base64,AAAA']);
    expect(prompts()).toEqual([]);
    const held = useHeldSendStore.getState().held;
    expect(held?.problem.kind).toBe('no-vision');
    expect(held?.images).toHaveLength(1);
    await retryHeldSend({ withoutImages: true });
    const last = sent.filter((x) => x.channel === 'pi:prompt').at(-1)?.req as {
      message: string;
      images?: unknown[];
    };
    expect(last.message).toMatch(/what is this\?$/);
    expect(last.images).toBeUndefined();
  });
});
