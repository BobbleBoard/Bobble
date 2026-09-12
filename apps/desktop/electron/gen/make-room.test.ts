import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoomKeeper, type RoomDeps } from './make-room';

/**
 * The park/resume choreography, with every side effect a spy. The scenario is
 * the one that motivated it: a 24 GB Mac, the 4B chat resident, an illustration
 * that fits without it and not beside it.
 */
function deps(over: Partial<RoomDeps> = {}) {
  const calls: string[] = [];
  const d = {
    park: vi.fn(async () => {
      calls.push('park');
      return { ok: true };
    }),
    resume: vi.fn(async () => {
      calls.push('resume');
      return { ok: true };
    }),
    reconsider: vi.fn(async () => {
      calls.push('reconsider');
    }),
    busy: vi.fn(() => false),
    log: vi.fn(),
    graceMs: 1000,
    retryMs: 500,
    ...over,
  };
  return { d, calls };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('room keeper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('parks the chat model when a job is held, reconsiders, and resumes when the queue drains', async () => {
    const { d, calls } = deps();
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    await flush();
    expect(calls).toEqual(['park', 'reconsider']);
    expect(keeper.parked).toBe(true);

    keeper.started('j1');
    vi.advanceTimersByTime(5000); // well past the grace: a started job is never "hopeless"
    expect(d.resume).not.toHaveBeenCalled();

    keeper.finished('j1');
    await keeper.settle();
    expect(calls).toEqual(['park', 'reconsider', 'resume']);
    expect(keeper.parked).toBe(false);
  });

  it('settle() makes the caller wait for the resume, so the chat gets its model back with the result', async () => {
    let release: (() => void) | undefined;
    const { d } = deps({
      resume: vi.fn(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            release = () => resolve({ ok: true });
          }),
      ),
    });
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    await flush();
    keeper.started('j1');
    keeper.finished('j1');
    let settled = false;
    const p = keeper.settle().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    release?.();
    await p;
    expect(settled).toBe(true);
  });

  it('does not resume into another heavy job still queued or running', async () => {
    let busy = true;
    const { d } = deps({ busy: vi.fn(() => busy) });
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    await flush();
    keeper.started('j1');
    keeper.finished('j1'); // j2 is behind it
    await flush();
    expect(d.resume).not.toHaveBeenCalled();
    keeper.started('j2');
    busy = false;
    keeper.finished('j2');
    await keeper.settle();
    expect(d.resume).toHaveBeenCalledTimes(1);
  });

  it('asks again later when the chat was mid-request, and stops asking once the job is gone', async () => {
    let busyTurns = 2;
    const { d } = deps({
      park: vi.fn(async () => {
        if (busyTurns > 0) {
          busyTurns -= 1;
          return { ok: false, reason: 'a request is in flight' };
        }
        return { ok: true };
      }),
    });
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    await flush();
    expect(d.park).toHaveBeenCalledTimes(1);
    expect(keeper.parked).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(d.park).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(d.park).toHaveBeenCalledTimes(3);
    expect(keeper.parked).toBe(true);
    keeper.started('j1');
    keeper.finished('j1');
    await keeper.settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.park).toHaveBeenCalledTimes(3);
  });

  it('brings the chat straight back when parking did not make enough room, and does not retry that job', async () => {
    const { d, calls } = deps();
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    await flush();
    expect(keeper.parked).toBe(true);
    // The queue reconsidered and still holds it: the picture would not fit even so.
    keeper.held('j1');
    await vi.advanceTimersByTimeAsync(1000);
    await keeper.settle();
    expect(calls).toEqual(['park', 'reconsider', 'resume']);
    expect(keeper.parked).toBe(false);
    // The hold is honest now; the same job does not bounce the model again.
    keeper.held('j1');
    await flush();
    expect(d.park).toHaveBeenCalledTimes(1);
    // …but a different job may.
    keeper.held('j2');
    await flush();
    expect(d.park).toHaveBeenCalledTimes(2);
  });

  it('does nothing when there is no chat model to give up', async () => {
    const { d } = deps({ park: vi.fn(async () => ({ ok: false, reason: 'no server' })) });
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    await flush();
    keeper.held('j1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(d.park).toHaveBeenCalledTimes(1);
    expect(d.reconsider).not.toHaveBeenCalled();
    expect(keeper.parked).toBe(false);
  });

  it('never parks twice or resumes while a park is landing', async () => {
    let releasePark: ((v: { ok: boolean }) => void) | undefined;
    const { d } = deps({
      park: vi.fn(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            releasePark = resolve;
          }),
      ),
    });
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    keeper.held('j1');
    keeper.held('j2');
    await flush();
    expect(d.park).toHaveBeenCalledTimes(1);
    releasePark?.({ ok: true });
    await flush();
    expect(keeper.parked).toBe(true);
    keeper.held('j2');
    await flush();
    expect(d.park).toHaveBeenCalledTimes(1);
  });

  it('a job held while a resume is landing is asked about again once it has landed', async () => {
    let releaseResume: ((v: { ok: boolean }) => void) | undefined;
    const { d } = deps({
      resume: vi.fn(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            releaseResume = resolve;
          }),
      ),
    });
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    await flush();
    keeper.started('j1');
    keeper.finished('j1'); // resume starts, and hangs for now
    await flush();
    keeper.held('j2'); // arrives mid-resume
    await flush();
    expect(d.park).toHaveBeenCalledTimes(1);
    releaseResume?.({ ok: true });
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(d.park).toHaveBeenCalledTimes(2);
    expect(keeper.parked).toBe(true);
  });

  it('dispose brings a parked chat back', async () => {
    const { d } = deps();
    const keeper = createRoomKeeper(d);
    keeper.held('j1');
    await flush();
    keeper.dispose();
    await keeper.settle();
    expect(d.resume).toHaveBeenCalledTimes(1);
  });
});
