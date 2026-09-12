import { describe, expect, it } from 'vitest';
import { JobQueue, type JobRunner, type JobStatus } from './job-queue.ts';
import type { GenJob, GenOutput } from './protocol.ts';

function imageJob(id: string): GenJob {
  return {
    id,
    modality: 'image',
    backend: 'mflux',
    outputDir: `/out/${id}`,
    image: {
      prompt: 'x',
      modelId: 'z-image-turbo',
      mfluxCommand: 'mflux-generate-z-image-turbo',
      seeds: [1],
    },
  };
}

function output(id: string): GenOutput[] {
  return [{ outputPath: `/out/${id}/o.png`, modality: 'image', model: 'z-image-turbo', seed: 1 }];
}

/**
 * A controllable runner: each started job hangs until the test resolves/rejects
 * it by id, and it records start order + exposes the AbortSignal it received.
 */
function controllableRunner(): {
  runner: JobRunner;
  started: string[];
  finish(id: string): void;
  fail(id: string, message: string): void;
  signalFor(id: string): AbortSignal | undefined;
} {
  const started: string[] = [];
  const resolvers = new Map<string, (o: GenOutput[]) => void>();
  const rejectors = new Map<string, (e: Error) => void>();
  const signals = new Map<string, AbortSignal | undefined>();
  const runner: JobRunner = (job, opts) => {
    started.push(job.id);
    signals.set(job.id, opts.signal);
    return new Promise<GenOutput[]>((resolve, reject) => {
      resolvers.set(job.id, resolve);
      rejectors.set(job.id, reject);
      // If aborted, reject like the real client does.
      opts.signal?.addEventListener('abort', () => reject(new Error('generation aborted')), {
        once: true,
      });
    });
  };
  return {
    runner,
    started,
    finish: (id) => resolvers.get(id)?.(output(id)),
    fail: (id, message) => rejectors.get(id)?.(new Error(message)),
    signalFor: (id) => signals.get(id),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('JobQueue concurrency', () => {
  it('runs up to maxConcurrent light jobs in parallel and queues the rest', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 2, runner: c.runner });
    q.enqueue(imageJob('a'));
    q.enqueue(imageJob('b'));
    q.enqueue(imageJob('c'));
    await tick();

    expect(c.started).toEqual(['a', 'b']); // c is queued
    expect(q.runningCount).toBe(2);
    expect(q.queuedCount).toBe(1);

    c.finish('a');
    await tick();
    expect(c.started).toEqual(['a', 'b', 'c']); // c starts when a slot frees
  });

  it('resolves each handle with the job outputs', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 2, runner: c.runner });
    const h = q.enqueue(imageJob('a'));
    await tick();
    c.finish('a');
    await expect(h.result).resolves.toEqual(output('a'));
  });

  it('rejects the handle and marks error status on runner failure', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 1, runner: c.runner });
    const statuses: JobStatus[] = [];
    q.on((e) => {
      if (e.type === 'status' && e.jobId === 'a') statuses.push(e.status);
    });
    const h = q.enqueue(imageJob('a'));
    await tick();
    c.fail('a', 'metal oom');
    await expect(h.result).rejects.toThrow('metal oom');
    expect(statuses).toEqual(['queued', 'running', 'error']);
  });
});

describe('JobQueue heavy (unified-memory) serialization', () => {
  it('runs a heavy job ALONE — it waits for running jobs to drain', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 2, runner: c.runner });
    q.enqueue(imageJob('light1'));
    q.enqueue(imageJob('heavy'), { heavy: true });
    q.enqueue(imageJob('light2'));
    await tick();

    // Only light1 runs; heavy must wait for the machine to be empty, and light2
    // is FIFO-behind the heavy job so it cannot jump ahead.
    expect(c.started).toEqual(['light1']);

    c.finish('light1');
    await tick();
    expect(c.started).toEqual(['light1', 'heavy']); // heavy now runs alone
    expect(q.runningCount).toBe(1);

    c.finish('heavy');
    await tick();
    expect(c.started).toEqual(['light1', 'heavy', 'light2']);
  });

  it('blocks new light jobs from starting while a heavy job runs', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 2, runner: c.runner });
    q.enqueue(imageJob('heavy'), { heavy: true });
    q.enqueue(imageJob('light'));
    await tick();
    expect(c.started).toEqual(['heavy']);
    expect(q.queuedCount).toBe(1);
    c.finish('heavy');
    await tick();
    expect(c.started).toEqual(['heavy', 'light']);
  });
});

describe('JobQueue cancel', () => {
  it('cancels a queued job before it starts', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 1, runner: c.runner });
    q.enqueue(imageJob('a'));
    const h = q.enqueue(imageJob('b'));
    await tick();
    expect(c.started).toEqual(['a']);

    expect(q.cancel('b')).toBe(true);
    await expect(h.result).rejects.toThrow(/canceled/);
    expect(q.statusOf('b')).toBeUndefined(); // removed
    // b never runs even after a frees.
    c.finish('a');
    await tick();
    expect(c.started).toEqual(['a']);
  });

  it('cancels a running job by aborting its signal', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 1, runner: c.runner });
    const h = q.enqueue(imageJob('a'));
    await tick();
    const signal = c.signalFor('a');
    expect(signal?.aborted).toBe(false);

    expect(q.cancel('a')).toBe(true);
    expect(signal?.aborted).toBe(true);
    await expect(h.result).rejects.toThrow(/canceled/);
  });

  it('frees the slot after cancelling a running job so the next starts', async () => {
    const c = controllableRunner();
    const q = new JobQueue({ maxConcurrent: 1, runner: c.runner });
    const ha = q.enqueue(imageJob('a'));
    ha.result.catch(() => {}); // the cancel rejects this handle; swallow it
    q.enqueue(imageJob('b'));
    await tick();
    expect(c.started).toEqual(['a']);
    q.cancel('a');
    await expect(ha.result).rejects.toThrow(/canceled/);
    await tick();
    expect(c.started).toEqual(['a', 'b']);
  });

  it('rejects a duplicate job id', () => {
    const c = controllableRunner();
    const q = new JobQueue({ runner: c.runner });
    q.enqueue(imageJob('dup'));
    expect(() => q.enqueue(imageJob('dup'))).toThrow(/already in queue/);
  });
});

describe('a heavy job waits for a machine that can take it', () => {
  /*
   * The power policy's answer under real memory pressure (power-policy.ts): a
   * heavy generation is gigabytes of extra resident memory and the single worst
   * thing to start. HELD, never refused — somebody who pressed Generate wants
   * their picture, just not at the cost of their machine.
   */
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('does not start a heavy job while the policy says no', async () => {
    let allowed = false;
    const { runner, started } = controllableRunner();
    const q = new JobQueue({ runner, heavyAllowed: () => allowed });
    q.enqueue(imageJob('a'), { heavy: true });
    await tick();
    expect(started).toEqual([]);

    // …and starts it the moment the machine is breathing again.
    allowed = true;
    q.reconsider();
    await tick();
    expect(started).toEqual(['a']);
  });

  it('lets a light job through while a heavy one is held — when it fits', async () => {
    // The machine holds the 12 GB job and passes the 300 MB one behind it. A
    // blanket "no" would hold both: every job asks now, proportionately.
    const { runner, started } = controllableRunner();
    const q = new JobQueue({ runner, heavyAllowed: (fp) => (fp ?? 0) < 1 });
    q.enqueue(imageJob('heavy'), { heavy: true, footprintGB: 12 });
    q.enqueue(imageJob('light'), { footprintGB: 0.3 });
    await tick();
    expect(started).toEqual(['light']);
  });

  it('holds a light job too, when the machine says it does not fit', async () => {
    const { runner, started } = controllableRunner();
    const q = new JobQueue({ runner, heavyAllowed: () => ({ ok: false, reason: 'tight' }) });
    q.enqueue(imageJob('render'), { footprintGB: 2 });
    await tick();
    expect(started).toEqual([]);
  });

  it('asks about THIS job, not about heavy jobs in general', async () => {
    // A machine with room for a 5 GB video and not a 12 GB image should run the
    // one that fits — the gate is a footprint question, not a switch.
    const { runner, started } = controllableRunner();
    const q = new JobQueue({
      runner,
      heavyAllowed: (footprintGB) => (footprintGB ?? 0) <= 8,
    });
    q.enqueue(imageJob('big'), { heavy: true, footprintGB: 12 });
    q.enqueue(imageJob('small'), { heavy: true, footprintGB: 5 });
    await tick();
    // The big one is held by the machine and stepped over; the small one runs.
    expect(started).toEqual(['small']);
  });

  it('says why a job is being held, once per reason', async () => {
    const { runner } = controllableRunner();
    const q = new JobQueue({
      runner,
      heavyAllowed: () => ({
        ok: false,
        reason: 'needs about 14.8 GB and only 9.6 GB is available',
      }),
    });
    const held: string[] = [];
    q.on((e) => {
      if (e.type === 'held') held.push(e.reason);
    });
    q.enqueue(imageJob('a'), { heavy: true, footprintGB: 12 });
    await tick();
    q.reconsider();
    q.reconsider();
    await tick();
    expect(held).toEqual(['needs about 14.8 GB and only 9.6 GB is available']);
  });

  it('sheds the running job with the reason, and leaves the queue alone', async () => {
    const { runner, started } = controllableRunner();
    const q = new JobQueue({ runner });
    const a = q.enqueue(imageJob('a'), { heavy: true });
    q.enqueue(imageJob('b'), { heavy: true });
    await tick();
    expect(started).toEqual(['a']);
    expect(q.runningHeavy).toBe(true);
    expect(q.shedRunning('only 7% of memory was free')).toEqual(['a']);
    await expect(a.result).rejects.toThrow(/7% of memory/);
    // b was never the problem; it starts (admission permitting) once a is gone.
    await tick();
    expect(started).toEqual(['a', 'b']);
  });

  it('counts a job once, however many readings arrive while its worker dies', async () => {
    const { runner, started } = controllableRunner();
    const q = new JobQueue({ runner });
    q.enqueue(imageJob('a'), { heavy: true }).result.catch(() => undefined);
    await tick();
    expect(started).toEqual(['a']);
    expect(q.shedRunning('critical')).toEqual(['a']);
    expect(q.shedRunning('critical')).toEqual([]);
    expect(q.cancel('a')).toBe(false);
  });

  it('sheds light jobs too, heavy first — at the wall every job is the wrong one', async () => {
    const { runner, started } = controllableRunner();
    const q = new JobQueue({ runner, maxConcurrent: 2 });
    q.enqueue(imageJob('l1')).result.catch(() => undefined);
    q.enqueue(imageJob('l2')).result.catch(() => undefined);
    await tick();
    expect(started).toEqual(['l1', 'l2']);
    expect(q.shedRunning('critical').sort()).toEqual(['l1', 'l2']);
    // The abort lands on the runner's own tick.
    await tick();
    expect(q.runningCount).toBe(0);
  });

  it('rejects, with the advice, a job the machine says can never fit', async () => {
    const { runner, started } = controllableRunner();
    const q = new JobQueue({
      runner,
      heavyAllowed: (fp) =>
        (fp ?? 0) > 20
          ? {
              ok: false,
              never: true,
              reason: 'needs about 22.9 GB and this Mac has 24 GB — try a smaller size',
            }
          : true,
    });
    const big = q.enqueue(imageJob('big'), { footprintGB: 22 });
    q.enqueue(imageJob('small'), { footprintGB: 5 });
    await expect(big.result).rejects.toThrow(/smaller size/);
    await tick();
    expect(q.statusOf('big')).toBeUndefined();
    expect(started).toEqual(['small']);
  });

  it('behaves exactly as before when no policy is supplied', async () => {
    const { runner, started } = controllableRunner();
    const q = new JobQueue({ runner });
    q.enqueue(imageJob('a'), { heavy: true });
    await tick();
    expect(started).toEqual(['a']);
  });
});
