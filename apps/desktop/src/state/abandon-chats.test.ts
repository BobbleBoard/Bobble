/**
 * DELETING A CHAT THAT IS WAITING ON THE USER (review of the 2026-09-23 wave,
 * delete #1).
 *
 * pi acknowledges `abort` only once its turn has ENDED (rpc-mode awaits
 * `session.abort()`, which awaits `agent.waitForIdle()`), and a turn sitting in
 * `ask_user` or a permission prompt ends only when that dialog is answered: the
 * harness calls `ctx.ui.input` with no signal and no timeout, and the agent loop
 * awaits the tool without racing the abort. The fake pi below keeps exactly
 * those rules, so it hangs where the real one hangs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../chat/auto-router', () => ({
  maybeRouteAuto: vi.fn(async () => undefined),
  ensureChatServerReady: vi.fn(async () => undefined),
}));

type Call = { channel: string; req: unknown };
const calls: Call[] = [];
const channels = (): string[] => calls.map((c) => c.channel);
const handlers = new Map<string, (payload: unknown) => void>();

/** The fake pi's turn. */
const pi = {
  running: false,
  /** A dialog the turn is blocked on (ask_user, a permission prompt). */
  dialogOpen: false,
  /** Inside a tool that ignores the abort signal (talk_to_manager, a generation). */
  stuck: false,
  abortRequested: false,
  waitingAborts: [] as Array<() => void>,
};

let mods: {
  connect: typeof import('./pi-connect');
  slice: typeof import('./pi-slice');
  deleted: typeof import('./deleted-chats');
};

/** The turn ends when it was told to stop and nothing holds it: agent_end. */
function settleTurn(): void {
  if (!pi.running || !pi.abortRequested || pi.dialogOpen || pi.stuck) return;
  pi.running = false;
  const sink = mods.slice.createPiSink();
  sink.setAgentStatus({ isStreaming: false });
  sink.agentEnd();
  for (const ack of pi.waitingAborts.splice(0)) ack();
}

const invoke = vi.fn(async (channel: string, req: unknown) => {
  calls.push({ channel, req });
  switch (channel) {
    case 'pi:abort':
      if (!pi.running) return { success: true };
      pi.abortRequested = true;
      return new Promise((resolve) => {
        pi.waitingAborts.push(() => resolve({ success: true }));
        settleTurn();
      });
    case 'pi:respond-ui':
      pi.dialogOpen = false;
      settleTurn();
      return { delivered: true };
    case 'pi:get-state':
      return { success: true, state: { sessionFile: '/s/fresh.jsonl', sessionId: 'fresh' } };
    case 'fs:read-session':
      return { text: null };
    default:
      return { success: true };
  }
});
(globalThis as unknown as { window: unknown }).window = {
  location: { search: '' },
  piDesktop: {
    invoke,
    onEvent: (channel: string, fn: (payload: unknown) => void) => {
      handlers.set(channel, fn);
      return () => handlers.delete(channel);
    },
  },
};

const A = '/s/A.jsonl';
const B = '/s/B.jsonl';

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mods = {
    connect: await import('./pi-connect'),
    slice: await import('./pi-slice'),
    deleted: await import('./deleted-chats'),
  };
  calls.length = 0;
  handlers.clear();
  Object.assign(pi, {
    running: false,
    dialogOpen: false,
    stuck: false,
    abortRequested: false,
    waitingAborts: [],
  });
  /* A fresh import of pi-connect's whole module graph, per test. MEASURED: past
     the default 10 s hook clock once in a full parallel run on a loaded Mac
     (load average 23); it is 50 ms alone. Nothing here is timed in real time. */
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

/** Run a delete's pi half and let every timer it could arm run out. */
async function abandon(files: string[]): Promise<boolean> {
  mods.deleted.useDeletedChats.getState().hide(files);
  let settled = false;
  void mods.connect.abandonChats(files).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(60_000);
  return settled;
}

describe('deleting a chat whose turn is waiting on the user', () => {
  it('in the background: its question gets "no answer", the turn ends, pi moves to the chat on screen', async () => {
    const { usePiStore } = mods.slice;
    usePiStore.setState({
      session: { sessionFile: B },
      bgRun: { sessionFile: A, messages: [], streaming: true, title: null },
      uiRequests: [{ id: 'q1', method: 'askUser', title: 'Which colour?', sessionFile: A }],
      unread: { [A]: 'needs-input' },
    });
    Object.assign(pi, { running: true, dialogOpen: true });

    expect(await abandon([A])).toBe(true);

    const answer = calls.find((c) => c.channel === 'pi:respond-ui');
    expect(answer?.req).toEqual({ id: 'q1', answer: { cancelled: true } });
    // Answered BEFORE the abort — the abort is only acknowledged once it is.
    expect(channels().indexOf('pi:respond-ui')).toBeLessThan(channels().indexOf('pi:abort'));
    expect(usePiStore.getState().bgRun).toBeNull();
    expect(calls).toContainEqual({ channel: 'pi:switch-session', req: { sessionPath: B } });
    expect(usePiStore.getState().uiRequests).toEqual([]);
    expect(usePiStore.getState().unread[A]).toBeUndefined();
  });

  it('on screen: its permission prompt gets "no answer", and the fresh chat gets its pi session', async () => {
    const { usePiStore } = mods.slice;
    usePiStore.setState((s) => ({
      session: { sessionFile: A },
      bgRun: null,
      agent: { ...s.agent, isStreaming: true },
      uiRequests: [{ id: 'p1', method: 'permission', title: 'Allow bash?', sessionFile: A }],
    }));
    Object.assign(pi, { running: true, dialogOpen: true });

    expect(await abandon([A])).toBe(true);

    expect(calls).toContainEqual({
      channel: 'pi:respond-ui',
      req: { id: 'p1', answer: { cancelled: true } },
    });
    expect(channels()).toContain('pi:new-session');
    expect(usePiStore.getState().bgRun).toBeNull();
    expect(usePiStore.getState().session?.sessionFile).toBe('/s/fresh.jsonl');
  });

  it('a turn stuck in a tool that ignores the abort is let go, not waited on forever', async () => {
    const { usePiStore } = mods.slice;
    usePiStore.setState({
      session: { sessionFile: B },
      bgRun: { sessionFile: A, messages: [], streaming: true, title: null },
      uiRequests: [],
    });
    Object.assign(pi, { running: true, stuck: true });

    expect(await abandon([A])).toBe(true);

    // Moving pi disposes the stuck turn; the chat on screen can send again.
    expect(usePiStore.getState().bgRun).toBeNull();
    expect(calls).toContainEqual({ channel: 'pi:switch-session', req: { sessionPath: B } });
    expect(mods.slice.canDrainQueue(usePiStore.getState())).toBe(true);
  });

  it('a question the dying turn asks AFTER the delete is answered at once, and raises nothing', async () => {
    const { usePiStore } = mods.slice;
    mods.connect.connectPi();
    mods.deleted.useDeletedChats.getState().hide([A]);
    usePiStore.setState({
      session: { sessionFile: B },
      bgRun: { sessionFile: A, messages: [], streaming: true, title: null },
      uiRequests: [],
      unread: {},
    });
    calls.length = 0;

    handlers.get('pi:event')?.({
      type: 'extension_ui_request',
      id: 'q2',
      method: 'input',
      title: 'Which colour?',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toContainEqual({
      channel: 'pi:respond-ui',
      req: { id: 'q2', answer: { cancelled: true } },
    });
    // No dialog, no banner, no orange dot, no dock badge for a chat that is gone.
    expect(usePiStore.getState().uiRequests).toEqual([]);
    expect(usePiStore.getState().unread[A]).toBeUndefined();
  });
});

/*
 * A SUBAGENT BELONGS TO THE CHAT WHOSE TURN SPAWNED IT (review wave-0923,
 * delete #6). Main nests a spawn_subagent child under the session the renderer
 * last reported; that was the chat on SCREEN, so a background chat's subagent
 * landed under whichever chat the user was reading — deleting that chat killed
 * it, and deleting its real owner left it running.
 */
describe('which chat main is told pi is working for', () => {
  const reported = (): unknown =>
    calls.filter((c) => c.channel === 'pi:report-active-session').at(-1)?.req;

  it('is the chat running in the background while one runs, and the viewed chat otherwise', () => {
    const { usePiStore } = mods.slice;
    mods.connect.connectPi();
    usePiStore.setState({ session: { sessionFile: A }, bgRun: null });
    expect(reported()).toEqual({ sessionFile: A });

    // The user opens B while A's turn keeps running behind it.
    usePiStore.setState({
      session: { sessionFile: B },
      bgRun: { sessionFile: A, messages: [], streaming: true, title: null },
    });
    expect(reported()).toEqual({ sessionFile: A });

    // A finishes; the next turn pi runs is B's.
    usePiStore.setState({
      bgRun: { sessionFile: A, messages: [], streaming: false, title: null },
    });
    expect(reported()).toEqual({ sessionFile: B });
  });
});

/*
 * A DELETED CHAT CANNOT BE OPENED AGAIN (review wave-0923, delete #7). A
 * notification about it can outlive it in Notification Center, and clicking
 * that opens its file: pi's SessionManager creates a fresh session at a missing
 * path, and everything written there is swept by the tombstones.
 */
describe('opening a chat that was deleted', () => {
  it('does not point pi at its file', async () => {
    const { usePiStore } = mods.slice;
    usePiStore.setState({ session: { sessionFile: B }, bgRun: null });
    mods.deleted.useDeletedChats.getState().hide([A]);

    const res = await mods.connect.switchSession(A);
    await vi.advanceTimersByTimeAsync(0);

    expect(res.ok).toBe(false);
    expect(usePiStore.getState().session?.sessionFile).toBe(B);
    expect(channels()).not.toContain('pi:switch-session');
  });

  it('does not bring its parked thread back on screen', async () => {
    const { usePiStore } = mods.slice;
    usePiStore.setState({
      session: { sessionFile: B },
      bgRun: { sessionFile: A, messages: [], streaming: false, title: null },
    });
    mods.deleted.useDeletedChats.getState().hide([A]);

    await mods.connect.switchSession(A);

    expect(usePiStore.getState().session?.sessionFile).toBe(B);
    expect(usePiStore.getState().bgRun?.sessionFile).toBe(A);
  });
});
