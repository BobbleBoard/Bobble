/**
 * A STUDIO'S JOB OUTLIVES THE ROOM (the user, 2026-09-24: "leaving a studio with a
 * generation running and then going back doesn't keep it going, or maybe it
 * does but the UI resets").
 *
 * The IPC is stubbed: `gen:generate` answers when the test says so, and the
 * test plays main's `gen:open`/`gen:update` events itself. What is pinned: the
 * job's state lives in the store whether or not a room is mounted; events find
 * it by the request id and by nothing else; a result that lands with nobody in
 * the room is filed at once, one that lands with the room open waits for the
 * card's reveal; and the task tray hears how each run ended.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler[]>();
let answer: (res: unknown) => void = () => {};
const invoke = vi.fn(async (channel: string, _req: unknown) => {
  if (channel === 'gen:generate') return new Promise((resolve) => (answer = resolve));
  return { canceled: true };
});
(globalThis as unknown as { window: unknown }).window = {
  location: { search: '' },
  piDesktop: {
    invoke,
    onEvent: (channel: string, fn: Handler) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), fn]);
      return () => undefined;
    },
  },
};
const emit = (channel: string, payload: unknown): void => {
  for (const fn of handlers.get(channel) ?? []) fn(payload);
};

const jobs = await import('./studio-jobs');
const { useStudioRuns } = await import('./studio-runs');
const { useTaskTray, trayRows } = await import('./task-tray');
jobs.connectStudioJobs();

const REQ = { kind: 'image' as const, prompt: 'A red fox asleep in tall grass', size: '768x432' };
const slot = () => jobs.useStudioJobs.getState().slots.image;
const sentRequestId = (): string =>
  (invoke.mock.calls.find((c) => c[0] === 'gen:generate')?.[1] as { requestId: string }).requestId;
const surface = (payload: object, status = 'generating') => ({
  modality: 'image',
  model: { id: 'm', label: 'M', license: 'MIT' },
  candidates: [{ status: 'pending' }],
  status,
  ...payload,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invoke.mockClear();
  useStudioRuns.setState({ runs: { image: [], video: [], audio: [] } });
  jobs.useStudioJobs.setState({
    slots: {
      image: { job: null, busy: false, error: null },
      video: { job: null, busy: false, error: null },
      audio: { job: null, busy: false, error: null },
    },
  });
  useTaskTray.setState({ live: {}, ended: {}, surface: { kind: 'chat', sessionFile: null } });
});

describe('a studio job with nobody in the room', () => {
  it('keeps running, keeps counting, and files its result where the room will look', async () => {
    const done = jobs.runStudioJob('image', REQ);
    expect(slot().busy).toBe(true);
    expect(slot().job?.size).toBe('768x432');
    const requestId = sentRequestId();
    expect(requestId).toMatch(/^studio-image-/);

    // A CHAT's picture opening in the same second is not this room's job.
    emit('gen:open', { tabId: 'pi:gen-chat1', payload: surface({ prompt: 'a chat thing' }) });
    expect(slot().job?.cancellable).toBe(false);

    emit('gen:open', { tabId: 'pi:gen-gen_7', payload: surface({ requestId }) });
    emit('gen:update', {
      tabId: 'pi:gen-gen_7',
      payload: surface({ requestId, progress: { candidate: 0, step: 6, total: 8 } }),
    });
    expect(slot().job).toMatchObject({ step: 6, total: 8, cancellable: true });
    // The tray lists it while it runs somewhere you are not.
    expect(trayRows(useTaskTray.getState()).map((r) => `${r.key}:${r.state}`)).toEqual([
      'studio:image:running',
    ]);

    answer({ jobId: 'gen_7', outputs: [{ path: '/g/fox/fox-1.png', seed: 7, model: 'm' }] });
    await done;
    expect(slot()).toMatchObject({ busy: false, job: null, error: null });
    const runs = useStudioRuns.getState().runs.image;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ prompt: REQ.prompt, seed: 7 });
    expect(runs[0]?.items[0]).toMatchObject({ path: '/g/fox/fox-1.png', kind: 'image' });
    expect(trayRows(useTaskTray.getState()).map((r) => `${r.key}:${r.state}`)).toEqual([
      'studio:image:done',
    ]);
  });

  it('keeps the failure for when you come back, and reports it', async () => {
    const done = jobs.runStudioJob('image', REQ);
    answer({ jobId: '', outputs: [], error: 'Not enough free memory' });
    await done;
    expect(slot()).toMatchObject({ busy: false, job: null, error: 'Not enough free memory' });
    const [row] = trayRows(useTaskTray.getState());
    expect(row).toMatchObject({ state: 'failed', error: 'Not enough free memory' });
  });

  it('runs one job per room — a second Generate while one runs does nothing', async () => {
    const first = jobs.runStudioJob('image', REQ);
    await jobs.runStudioJob('image', { ...REQ, prompt: 'another' });
    expect(invoke.mock.calls.filter((c) => c[0] === 'gen:generate')).toHaveLength(1);
    answer({ jobId: 'g', outputs: [{ path: '/g/a.png' }] });
    await first;
  });

  it('is not news when the person stopped it', async () => {
    const done = jobs.runStudioJob('image', REQ);
    emit('gen:open', { tabId: 'pi:gen-gen_9', payload: surface({ requestId: sentRequestId() }) });
    jobs.cancelStudioJob('image');
    expect(invoke).toHaveBeenCalledWith('gen:cancel', { jobId: 'gen_9' });
    answer({ jobId: '', outputs: [], error: 'cancelled' });
    await done;
    expect(trayRows(useTaskTray.getState())).toEqual([]);
  });
});

describe('a studio job with the room open', () => {
  it('holds the result for the card to uncover, then files it', async () => {
    const close = jobs.studioRoomOpened('image');
    useTaskTray.getState().setSurface({ kind: 'studio', modality: 'image' });
    const done = jobs.runStudioJob('image', REQ);
    answer({ jobId: 'g', outputs: [{ path: '/g/fox.png' }] });
    await done;
    // On the card, not in the list yet — the same picture twice is the bug.
    expect(slot().job?.items?.[0]?.path).toBe('/g/fox.png');
    expect(useStudioRuns.getState().runs.image).toHaveLength(0);
    jobs.finishStudioReveal('image');
    expect(slot().job).toBeNull();
    expect(useStudioRuns.getState().runs.image).toHaveLength(1);
    // Watched it finish: nothing for the tray.
    expect(trayRows(useTaskTray.getState())).toEqual([]);
    close();
  });

  it('files a result mid-reveal the moment you leave the room', async () => {
    const close = jobs.studioRoomOpened('image');
    const done = jobs.runStudioJob('image', REQ);
    answer({ jobId: 'g', outputs: [{ path: '/g/fox.png' }] });
    await done;
    close();
    await flush();
    expect(slot().job).toBeNull();
    expect(useStudioRuns.getState().runs.image).toHaveLength(1);
  });
});
