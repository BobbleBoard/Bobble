import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelJobsOf, connectChatJobs, ownerOfJob, productionHome } from './chat-jobs';
import { useChildAgentStore } from './child-agent-store';
import { useDeletedChats } from './deleted-chats';
import { usePiStore } from './pi-slice';

describe('ownerOfJob — which chat a generation belongs to', () => {
  const idle = { bgRun: null, viewed: '/s/viewed.jsonl' };

  it("a subagent's job belongs to the chat that owns the subagent", () => {
    expect(ownerOfJob({ ...idle, agent: 'kid-1', childParent: '/s/parent.jsonl' })).toBe(
      '/s/parent.jsonl',
    );
    // An unknown child names no chat — never the one on screen by accident.
    expect(ownerOfJob({ ...idle, agent: 'kid-9', childParent: undefined })).toBeNull();
  });

  it("the chat's own pi works for the chat running in the background, when there is one", () => {
    expect(
      ownerOfJob({
        agent: undefined,
        childParent: undefined,
        bgRun: { sessionFile: '/s/bg.jsonl', streaming: true },
        viewed: '/s/viewed.jsonl',
      }),
    ).toBe('/s/bg.jsonl');
  });

  it('…and otherwise for the chat on screen', () => {
    expect(ownerOfJob({ ...idle, agent: undefined, childParent: undefined })).toBe(
      '/s/viewed.jsonl',
    );
    expect(
      ownerOfJob({
        agent: 'main',
        childParent: undefined,
        bgRun: { sessionFile: '/s/bg.jsonl', streaming: false },
        viewed: '/s/viewed.jsonl',
      }),
    ).toBe('/s/viewed.jsonl');
  });
});

describe('the jobs of a deleted chat, as main announces and ends them', () => {
  const calls: Array<{ channel: string; req: unknown }> = [];
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const emit = (channel: string, payload: unknown): void => {
    for (const fn of listeners.get(channel) ?? []) fn(payload);
  };
  (globalThis as unknown as { window: unknown }).window = {
    location: { search: '' },
    piDesktop: {
      invoke: vi.fn(async (channel: string, req: unknown) => {
        calls.push({ channel, req });
        return { canceled: true, ok: true };
      }),
      onEvent: (channel: string, fn: (payload: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
        return () => undefined;
      },
    },
  };
  connectChatJobs();

  const A = '/s/A.jsonl';
  const B = '/s/B.jsonl';
  const cancels = (): unknown[] =>
    calls.filter((c) => c.channel.endsWith(':cancel')).map((c) => c.req);

  beforeEach(() => {
    calls.length = 0;
    useDeletedChats.setState({ files: new Set() });
    useChildAgentStore.setState({ children: {}, viewedChildId: null });
    usePiStore.setState({ session: { sessionFile: B }, bgRun: null });
  });

  /*
   * Review wave-0923, delete #4. The delete's cancel pass reads the jobs a chat
   * owns ONCE; a mesh or a picture waiting for memory (20 s) or a cold engine
   * gets its id — and is announced — after that pass has run.
   */
  it('a job announced after the delete, for the deleted chat, is stopped at once', async () => {
    // A was deleted; its turn is still winding down behind B.
    useDeletedChats.getState().hide([A]);
    usePiStore.setState({ bgRun: { sessionFile: A, messages: [], streaming: true, title: null } });
    emit('gen3d:agent-job', { jobId: 'gen3d_late' });
    await Promise.resolve();
    expect(cancels()).toContainEqual({ jobId: 'gen3d_late' });
  });

  it("a job a deleted chat's subagent announces after it was removed is stopped too", async () => {
    useChildAgentStore.getState().ensureChild('kid-1', A, 'Researcher');
    useDeletedChats.getState().hide([A]);
    const pass = cancelJobsOf([A]);
    useChildAgentStore.getState().removeChild('kid-1'); // what deleteChatNow does next
    await pass;
    emit('gen:agent-job', { jobId: 'gen_late', agent: 'kid-1' });
    await Promise.resolve();
    expect(cancels()).toContainEqual({ jobId: 'gen_late' });
  });

  /*
   * A PRODUCTION FOR A CHAT THAT IS GONE nests nowhere (review wave-0923). The
   * delete is under way — the chat is hidden, its turn still winding down
   * behind the fresh chat that replaced it on screen — when main announces its
   * CEO's production. It is stopped at once; the situation room must not bind
   * it, or its roles nest under the fresh chat until the team has wound down.
   */
  it('a production announced for a deleted chat is stopped, and has no home to nest in', async () => {
    const F = '/s/fresh.jsonl';
    useDeletedChats.getState().hide([A]);
    usePiStore.setState({
      session: { sessionFile: F },
      bgRun: { sessionFile: A, messages: [], streaming: true, title: null },
    });
    emit('corp:attached', { taskId: 'task-late' });
    await Promise.resolve();
    expect(calls).toContainEqual({ channel: 'corp:abort', req: { taskId: 'task-late' } });
    expect(productionHome('task-late', F)).toBeNull();
  });

  it('a production of a live chat nests under that chat, even behind another one', async () => {
    usePiStore.setState({
      session: { sessionFile: B },
      bgRun: { sessionFile: A, messages: [], streaming: true, title: null },
    });
    emit('corp:attached', { taskId: 'task-live' });
    await Promise.resolve();
    expect(productionHome('task-live', B)).toEqual({ parentId: A });
  });

  /*
   * Review wave-0923, delete #9. Nothing serialises OmniSVG — the chat's pi and
   * a subagent can each be drawing — so the end of one drawing is not the end
   * of every drawing.
   */
  it('one drawing ending does not forget another that is still drawing', async () => {
    useChildAgentStore.getState().ensureChild('kid-2', A, 'Illustrator');
    emit('gen:agent-job', { jobId: 'svg-1' }); // B's own pi
    emit('gen:agent-job', { jobId: 'svg-2', agent: 'kid-2' }); // A's subagent
    emit('gen:svg-live', { status: 'done', jobId: 'svg-1', outputs: [] });

    await cancelJobsOf([A]);
    expect(cancels()).toContainEqual({ jobId: 'svg-2' });
  });
});
