/**
 * A generation stopped on its way to the queue (pending-jobs.ts; review of the
 * 2026-09-23 wave, delete #3 and #5). The real JobQueue runs under a runner
 * that never finishes on its own, so "it ran" and "it was stopped" are both
 * visible.
 */
import { type GenJob, JobQueue, type JobRunner } from '@pi-desktop/gen-service';
import { describe, expect, it } from 'vitest';
import { CANCELED, PendingJobs, unlessStopped } from './pending-jobs';

function job(id: string): GenJob {
  return {
    id,
    modality: 'image',
    backend: 'mflux',
    outputDir: `/out/${id}`,
    image: { prompt: 'x', modelId: 'z-image-turbo', mfluxCommand: 'mflux-generate', seeds: [1] },
  };
}

function queue(): { q: JobQueue; started: string[] } {
  const started: string[] = [];
  const runner: JobRunner = (j, opts) => {
    started.push(j.id);
    return new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  return { q: new JobQueue({ runner }), started };
}

/** A gate that opens when told — the module / weights / consent wait. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('a job waiting at a gate', () => {
  /*
   * What gen-manager did: announce the id, await the gates, then enqueue — with
   * `cancel` going to the queue alone. The queue does not know the id yet.
   */
  it('without the pending record, a cancel reaches nothing and the job runs later', async () => {
    const { q, started } = queue();
    const g = gate();
    const onItsWay = (async () => {
      await g.wait;
      return q.enqueue(job('gen_1')).result;
    })();
    onItsWay.catch(() => undefined);

    expect(q.cancel('gen_1')).toBe(false); // the cancel, while it waits
    g.open(); // the install lands
    await tick();
    expect(started).toEqual(['gen_1']); // and it runs, for a chat that is gone
  });

  it('is stopped at the gate by a cancel, and never reaches the queue', async () => {
    const { q, started } = queue();
    const pending = new PendingJobs();
    const g = gate();
    const stop = pending.open('gen_1');
    const onItsWay = (async () => {
      await unlessStopped(stop, g.wait);
      pending.admit('gen_1');
      return q.enqueue(job('gen_1')).result;
    })();

    expect(pending.cancel('gen_1')).toBe(true);
    await expect(onItsWay).rejects.toThrow(CANCELED);
    g.open();
    await tick();
    expect(started).toEqual([]);
  });

  it('a cancel landing between the gate and the queue still stops it', async () => {
    const { q, started } = queue();
    const pending = new PendingJobs();
    const stop = pending.open('gen_1');
    await unlessStopped(stop, Promise.resolve()); // the last gate has opened…
    expect(pending.cancel('gen_1')).toBe(true); // …and the cancel arrives
    expect(() => pending.admit('gen_1')).toThrow(CANCELED);
    expect(started).toEqual([]);
    expect(q.cancel('gen_1')).toBe(false);
  });

  it('once queued, the cancel is the queue’s', async () => {
    const { q, started } = queue();
    const pending = new PendingJobs();
    const stop = pending.open('gen_1');
    await unlessStopped(stop, Promise.resolve());
    pending.admit('gen_1');
    const result = q.enqueue(job('gen_1')).result;
    result.catch(() => undefined);
    await tick();
    expect(started).toEqual(['gen_1']);
    expect(pending.cancel('gen_1')).toBe(false);
    expect(q.cancel('gen_1')).toBe(true);
    await expect(result).rejects.toThrow();
  });

  it('is stopped by its caller’s own signal too (a ComfyUI mesh, cancelled by its c3d id)', async () => {
    const pending = new PendingJobs();
    const caller = new AbortController();
    const g = gate();
    const stop = pending.open('gen3d_1', caller.signal);
    const onItsWay = unlessStopped(stop, g.wait);
    caller.abort();
    await expect(onItsWay).rejects.toThrow(CANCELED);
    expect(() => pending.admit('gen3d_1')).toThrow(CANCELED);
  });

  it('a gate that fails still fails with its own error', async () => {
    const pending = new PendingJobs();
    const stop = pending.open('gen_1');
    await expect(unlessStopped(stop, Promise.reject(new Error('module missing')))).rejects.toThrow(
      'module missing',
    );
  });
});
