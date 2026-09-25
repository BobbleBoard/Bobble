/**
 * ⌘Z TAKES BACK WHAT WAS JUST SENT (the user, 2026-09-24): "pressing cmd z within 3
 * seconds of sending a message and before any text has been typed into the
 * input box should unsend+rewind the chat".
 *
 * The composer owns the gesture; this pins what unsending DOES to the chat and
 * to pi, with the bridge mocked: which RPCs go out, in which order, and what is
 * left in the thread. That the next message reuses the prompt cache after the
 * rewind is measured against a real model by tests/e2e/unsend-prefill-probe.mjs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { channel: string; req: unknown };
const calls: Call[] = [];
let forkMessages: Array<{ entryId: string; text: string }> = [];
let serverReady: () => void = () => {};
let parkSends = false;

vi.mock('../chat/auto-router', () => ({
  maybeRouteAuto: vi.fn(async () => undefined),
  ensureChatServerReady: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        if (!parkSends) resolve();
        else serverReady = resolve;
      }),
  ),
}));

/* The chat's org record lives in the settings store, which paints the document
   when it saves — there is none under node. The DISK half of the real delete
   is what is under test; it goes through the same bridge call. */
vi.mock('./chat-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chat-org')>()),
  deleteChat: vi.fn((file: string, chain: readonly string[] = []) =>
    window.piDesktop.invoke('fs:delete-session', { file, chain }),
  ),
}));

const invoke = vi.fn(async (channel: string, req: unknown) => {
  calls.push({ channel, req });
  if (channel === 'pi:get-fork-messages') return { success: true, messages: forkMessages };
  if (channel === 'pi:fork') return { success: true, text: '', cancelled: false };
  if (channel === 'pi:get-state') {
    return { success: true, state: { sessionFile: '/s/branch.jsonl', sessionId: 'b' } };
  }
  if (channel === 'fs:delete-session') return { ok: true };
  return { success: true };
});
(globalThis as unknown as { window: unknown }).window = {
  location: { search: '' },
  piDesktop: { invoke, onEvent: () => () => {} },
};

const { sendPrompt, unsendLastSend, unsendSettled } = await import('./pi-connect');
const { usePiStore } = await import('./pi-slice');
const { usePresentStore } = await import('./present-store');
const { useDeletedChats } = await import('./deleted-chats');

const channels = (): string[] => calls.map((c) => c.channel);
const EARLIER = [
  { kind: 'user' as const, id: 'u0', text: 'hello', timestamp: 1 },
  {
    kind: 'assistant' as const,
    id: 'a0',
    blocks: [{ type: 'text' as const, text: 'hi there' }],
    timestamp: 2,
  },
];

beforeEach(() => {
  calls.length = 0;
  parkSends = false;
  forkMessages = [];
  usePiStore.setState({
    messages: [...EARLIER],
    queuedSends: [],
    promptInFlight: false,
    bgRun: null,
    session: { sessionFile: '/s/chat.jsonl' },
    agent: { ...usePiStore.getState().agent, isStreaming: false },
  });
  usePresentStore.setState({ byChat: {} });
  useDeletedChats.setState({ files: new Set() });
});

describe('a message still waiting in the queue', () => {
  it('comes off the queue — and the turn it waited behind is NOT stopped', () => {
    usePiStore.setState({
      agent: { ...usePiStore.getState().agent, isStreaming: true },
      queuedSends: [
        { text: 'first queued', images: [] },
        { text: 'oops', images: [] },
      ],
    });
    expect(unsendLastSend({ text: 'oops', images: [] })).toBe(true);
    expect(usePiStore.getState().queuedSends.map((q) => q.text)).toEqual(['first queued']);
    expect(channels()).toEqual([]);
  });

  it('is only ever the LAST queued message, the one just sent', () => {
    usePiStore.setState({
      queuedSends: [
        { text: 'oops', images: [] },
        { text: 'later', images: [] },
      ],
    });
    expect(unsendLastSend({ text: 'oops', images: [] })).toBe(false);
    expect(usePiStore.getState().queuedSends).toHaveLength(2);
  });
});

describe('a message pi has', () => {
  it('leaves the thread at once, stops its turn, and rewinds pi to before it', async () => {
    await sendPrompt('draw a fox');
    forkMessages = [
      { entryId: 'e0', text: 'hello' },
      { entryId: 'e1', text: 'draw a fox' },
    ];
    // The turn has started drawing its reply.
    usePiStore.setState((s) => ({
      messages: [
        ...s.messages,
        { kind: 'assistant', id: 'a1', blocks: [], timestamp: 5, isStreaming: true },
      ],
    }));
    calls.length = 0;

    expect(unsendLastSend({ text: 'draw a fox', images: [] })).toBe(true);
    // Gone from the thread before anything is awaited.
    expect(usePiStore.getState().messages.map((m) => m.id)).toEqual(['u0', 'a0']);
    expect(usePiStore.getState().promptInFlight).toBe(false);

    await unsendSettled();
    expect(channels()).toEqual(['pi:abort', 'pi:get-fork-messages', 'pi:fork', 'pi:get-state']);
    // Forked AT the message — pi's branch ends just before it.
    expect(calls.find((c) => c.channel === 'pi:fork')?.req).toEqual({ entryId: 'e1' });
    expect(usePiStore.getState().session?.sessionFile).toBe('/s/branch.jsonl');
  });

  it('what the stopped turn draws on its way out goes too; a NEW message stays', async () => {
    await sendPrompt('draw a fox');
    forkMessages = [{ entryId: 'e1', text: 'draw a fox' }];
    calls.length = 0;
    expect(unsendLastSend({ text: 'draw a fox', images: [] })).toBe(true);
    // The aborted reply lands after the cut; the user already sent the next one.
    usePiStore.setState((s) => ({
      messages: [
        ...s.messages,
        { kind: 'assistant', id: 'late', blocks: [], timestamp: 6, stopReason: 'aborted' },
        { kind: 'user', id: 'next', text: 'draw an owl', timestamp: 7 },
      ],
    }));
    await unsendSettled();
    expect(usePiStore.getState().messages.map((m) => m.id)).toEqual(['u0', 'a0', 'next']);
  });

  it('a send made during the rewind waits for it, then goes to the branch', async () => {
    await sendPrompt('draw a fox');
    forkMessages = [{ entryId: 'e1', text: 'draw a fox' }];
    calls.length = 0;
    unsendLastSend({ text: 'draw a fox', images: [] });
    await sendPrompt('draw an owl');
    await unsendSettled();
    const order = channels();
    expect(order.indexOf('pi:fork')).toBeLessThan(order.indexOf('pi:prompt'));
  });

  it('keeps the cards the chat had shown, under the branch it now lives in', async () => {
    usePresentStore.setState({
      byChat: {
        '/s/chat.jsonl': [{ path: '/w/units.svg', kind: 'chart', at: 1, afterMessageId: 'a0' }],
      },
    });
    await sendPrompt('draw a fox');
    forkMessages = [{ entryId: 'e1', text: 'draw a fox' }];
    unsendLastSend({ text: 'draw a fox', images: [] });
    await unsendSettled();
    expect(usePresentStore.getState().byChat['/s/branch.jsonl']?.map((r) => r.path)).toEqual([
      '/w/units.svg',
    ]);
  });

  it('forks nothing when pi never recorded the message (an abort that beat it)', async () => {
    await sendPrompt('draw a fox');
    forkMessages = [{ entryId: 'e0', text: 'hello' }];
    calls.length = 0;
    unsendLastSend({ text: 'draw a fox', images: [] });
    await unsendSettled();
    expect(channels()).toEqual(['pi:abort', 'pi:get-fork-messages']);
  });
});

describe('a message still parked before dispatch', () => {
  it('never reaches pi: nothing to stop, nothing to fork', async () => {
    parkSends = true;
    const sending = sendPrompt('draw a fox');
    await new Promise((r) => setTimeout(r, 0));
    expect(unsendLastSend({ text: 'draw a fox', images: [] })).toBe(true);
    serverReady();
    await sending;
    await unsendSettled();
    expect(channels()).not.toContain('pi:prompt');
    expect(channels()).not.toContain('pi:fork');
    expect(usePiStore.getState().messages.map((m) => m.id)).toEqual(['u0', 'a0']);
  });
});

describe('what is not the message just sent is never touched', () => {
  it('a message with a later turn after it', async () => {
    await sendPrompt('draw a fox');
    usePiStore.setState((s) => ({
      messages: [...s.messages, { kind: 'user', id: 'x', text: 'another', timestamp: 9 }],
    }));
    expect(unsendLastSend({ text: 'draw a fox', images: [] })).toBe(false);
  });

  it('a different text than the composer sent', async () => {
    await sendPrompt('draw a fox');
    expect(unsendLastSend({ text: 'draw an owl', images: [] })).toBe(false);
    expect(usePiStore.getState().messages).toHaveLength(3);
  });
});

describe('a chat that was nothing but the message taken back', () => {
  /* pi writes the branch of a FIRST message as a new, unlinked session, so the
     old file — only the taken-back message and its stopped reply — would stay
     in the sidebar as a chat of its own. SEEN on the real app. */
  const deletes = () => calls.filter((c) => c.channel === 'fs:delete-session').map((c) => c.req);

  it('is retired: hidden at once and removed through the delete path', async () => {
    usePiStore.setState({ messages: [] });
    await sendPrompt('draw a fox');
    forkMessages = [{ entryId: 'e1', text: 'draw a fox' }];
    unsendLastSend({ text: 'draw a fox', images: [] });
    await unsendSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(deletes()).toEqual([{ file: '/s/chat.jsonl', chain: [] }]);
    expect(useDeletedChats.getState().files.has('/s/chat.jsonl')).toBe(true);
    // The branch the chat now lives on is untouched.
    expect(useDeletedChats.getState().files.has('/s/branch.jsonl')).toBe(false);
  });

  it('never when the user had said anything before it', async () => {
    await sendPrompt('draw a fox');
    forkMessages = [
      { entryId: 'e0', text: 'hello' },
      { entryId: 'e1', text: 'draw a fox' },
    ];
    unsendLastSend({ text: 'draw a fox', images: [] });
    await unsendSettled();
    expect(deletes()).toEqual([]);
  });

  it('never when the two sides disagree — pi lists only it, the thread has more', async () => {
    // An earlier message with no text (a picture alone) is absent from pi's
    // fork list but is in the thread: the file holds it, so it stays.
    usePiStore.setState({
      messages: [
        { kind: 'user', id: 'img', text: '', images: ['data:image/png;base64,AA=='], timestamp: 1 },
      ],
    });
    await sendPrompt('what is this?');
    forkMessages = [{ entryId: 'e1', text: 'what is this?' }];
    unsendLastSend({ text: 'what is this?', images: [] });
    await unsendSettled();
    expect(deletes()).toEqual([]);
  });
});
