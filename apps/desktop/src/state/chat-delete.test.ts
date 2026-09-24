/**
 * Delete is instant, and it stops what the chat was doing (the user, 2026-09-23).
 * The pi side (abandonChats) and the disk side (deleteChat) are mocked: this
 * pins the ORDER — hidden before anything is awaited — and that every kind of
 * work the chat owns is stopped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let diskResult: { ok: boolean; error?: string } = { ok: true };
let releaseDisk: () => void = () => {};

vi.mock('./pi-connect', () => ({
  abandonChats: vi.fn(async (files: readonly string[]) => {
    calls.push(`abandon:${files.join(',')}`);
  }),
}));
vi.mock('./chat-org', () => ({
  deleteChat: vi.fn(
    (file: string, chain: readonly string[]) =>
      new Promise((resolve) => {
        calls.push(`disk:${[file, ...chain].join(',')}`);
        releaseDisk = () => resolve(diskResult);
      }),
  ),
}));
vi.mock('./corp-connect', () => ({
  abortCorpTask: vi.fn(async (id: string) => {
    calls.push(`corp:${id}`);
  }),
}));

const invoke = vi.fn(async (channel: string, req: unknown) => {
  calls.push(`${channel}:${JSON.stringify(req)}`);
  return { ok: true, success: true, canceled: true };
});
(globalThis as unknown as { window: unknown }).window = {
  location: { search: '' },
  piDesktop: { invoke, onEvent: () => () => {} },
};

const { deleteChatNow } = await import('./chat-delete');
const { noteAgentJob } = await import('./chat-jobs');
const { useChildAgentStore } = await import('./child-agent-store');
const { useCorpStore } = await import('./corp-store');
const { useDeletedChats } = await import('./deleted-chats');
const { usePiStore } = await import('./pi-slice');

const A = '/s/A.jsonl';
const A0 = '/s/A-older.jsonl';

beforeEach(() => {
  calls.length = 0;
  diskResult = { ok: true };
  useDeletedChats.setState({ files: new Set() });
  usePiStore.setState({ session: { sessionFile: A }, bgRun: null });
  useCorpStore.setState({ taskId: 'task-1', corpRunning: true });
  useChildAgentStore.setState({ children: {}, viewedChildId: null });
});

describe('deleteChatNow', () => {
  it('hides every file of the chain BEFORE the disk answers', async () => {
    const done = deleteChatNow({ file: A, supersedes: [A0] });
    // Nothing awaited yet — the row is already gone.
    expect(useDeletedChats.getState().files.has(A)).toBe(true);
    expect(useDeletedChats.getState().files.has(A0)).toBe(true);
    releaseDisk();
    expect((await done).ok).toBe(true);
    expect(calls).toContain(`disk:${A},${A0}`);
  });

  it('stops the turn, the team, the subagents and the generations it owns', async () => {
    useChildAgentStore.getState().ensureChild('kid-1', A, 'Researcher');
    useChildAgentStore.getState().ensureChild('kid-2', '/s/other.jsonl', 'Someone else');
    noteAgentJob('gen', 'gen_1', undefined); // the chat's own pi, while A is on screen
    noteAgentJob('gen3d', 'gen3d_1', 'kid-1'); // its subagent's mesh
    const done = deleteChatNow({ file: A, supersedes: [] });
    releaseDisk();
    await done;
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain(`abandon:${A}`);
    expect(calls).toContain('corp:task-1');
    expect(calls).toContain('pi:child-dispose:{"childId":"kid-1"}');
    expect(calls).not.toContain('pi:child-dispose:{"childId":"kid-2"}');
    expect(calls).toContain('gen:cancel:{"jobId":"gen_1"}');
    expect(calls).toContain('gen3d:cancel:{"jobId":"gen3d_1"}');
    expect(useChildAgentStore.getState().children['kid-1']).toBeUndefined();
    expect(useChildAgentStore.getState().children['kid-2']).toBeDefined();
  });

  it('leaves another chat’s team alone when the deleted chat is not on screen', async () => {
    usePiStore.setState({ session: { sessionFile: '/s/other.jsonl' } });
    const done = deleteChatNow({ file: A, supersedes: [] });
    releaseDisk();
    await done;
    expect(calls.some((c) => c.startsWith('corp:'))).toBe(false);
  });

  it('brings the row back when the disk refuses', async () => {
    diskResult = { ok: false, error: 'refused' };
    const done = deleteChatNow({ file: A, supersedes: [A0] });
    releaseDisk();
    expect((await done).ok).toBe(false);
    expect(useDeletedChats.getState().files.has(A)).toBe(false);
    expect(useDeletedChats.getState().files.has(A0)).toBe(false);
  });
});
