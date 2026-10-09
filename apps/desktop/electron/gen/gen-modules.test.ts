import { describe, expect, it, vi } from 'vitest';
import {
  GEN_MODULE_IDS,
  GenModuleMissingError,
  GenModulesManager,
  MODULE_MARKER_RE,
  MODULE_WAIT_MS,
  moduleForBackend,
  moduleMissingMessage,
  plainInstallError,
  uvLineToDetail,
  weightsModelId,
  weightsModuleFor,
} from './gen-modules';

function manager(overrides: { ready?: Set<string>; installMs?: number; fail?: boolean } = {}) {
  const ready = overrides.ready ?? new Set<string>();
  const emitted: unknown[][] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const m = new GenModulesManager({
    ready: async (id) => ready.has(id),
    install: async (id, report) => {
      report('Resolved 96 packages');
      report('Downloading torch', 0.4);
      if (overrides.fail === true) throw new Error('no network');
      ready.add(id);
    },
    emit: (states) => emitted.push(states as unknown[]),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { m, ready, emitted, timers };
}

describe('the gate — a job waits for the button, then continues', () => {
  it('passes at once when the module is ready', async () => {
    const { m, emitted } = manager({ ready: new Set(['image']) });
    await expect(m.ensure('image')).resolves.toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it('holds the job, shows it wanted, and continues the SAME job when the install lands', async () => {
    const { m, emitted, timers } = manager();
    let continued = false;
    const job = m.ensure('image').then(() => {
      continued = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(continued).toBe(false);
    const shown = emitted.at(-1) as Array<{ id: string; wanted: boolean; ready: boolean }>;
    expect(shown.find((s) => s.id === 'image')).toMatchObject({ wanted: true, ready: false });
    expect(timers[0]?.ms).toBe(MODULE_WAIT_MS);

    await m.install('image');
    await job;
    expect(continued).toBe(true);
    expect(timers[0]?.cleared).toBe(true);
    const after = emitted.at(-1) as Array<{ id: string; wanted: boolean; ready: boolean }>;
    expect(after.find((s) => s.id === 'image')).toMatchObject({ wanted: false, ready: true });
  });

  it('streams the install detail and percent to the renderer', async () => {
    const { m, emitted } = manager();
    await m.install('audio');
    const details = emitted
      .flat()
      .filter((s) => (s as { id: string }).id === 'audio')
      .map((s) => (s as { detail?: string; percent?: number }).detail);
    expect(details).toContain('Resolved 96 packages');
    expect(details).toContain('Downloading torch');
  });

  it('a dismissed card ends the waiting job with the sentence for the model', async () => {
    const { m } = manager();
    const job = m.ensure('comfy');
    await new Promise((r) => setTimeout(r, 0));
    m.dismiss('comfy');
    await expect(job).rejects.toBeInstanceOf(GenModuleMissingError);
    await expect(job).rejects.toThrow(/Video, music, sound-effect and 3D generation is not set up/);
  });

  it('nobody pressing it for the wait ends the job the same way', async () => {
    const { m, timers } = manager();
    const job = m.ensure('3d');
    await new Promise((r) => setTimeout(r, 0));
    timers[0]?.fn();
    await expect(job).rejects.toBeInstanceOf(GenModuleMissingError);
  });

  /*
   * A CANCELLED JOB IS NOT WAITING (review of the 2026-09-23 wave). A job
   * stopped at the gate — its turn stopped, its chat deleted — left its waiter
   * registered, so the card kept saying a generation was waiting on the module
   * until the four-minute clock ran out.
   */
  it('a job stopped while it waits stops waiting — the card no longer counts it', async () => {
    const { m, emitted, timers } = manager();
    const stop = new AbortController();
    const job = m.ensure('image', stop.signal);
    job.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    const waiting = emitted.at(-1) as Array<{ id: string; wanted: boolean }>;
    expect(waiting.find((s) => s.id === 'image')?.wanted).toBe(true);

    stop.abort();
    await expect(job).rejects.toThrow(/canceled/);
    const after = m.status().find((s) => s.id === 'image');
    expect(after?.wanted).toBe(false);
    expect(timers[0]?.cleared).toBe(true);
    const shown = emitted.at(-1) as Array<{ id: string; wanted: boolean }>;
    expect(shown.find((s) => s.id === 'image')?.wanted).toBe(false);
  });

  it('…and one other job still waiting keeps the card', async () => {
    const { m } = manager();
    const stop = new AbortController();
    const stopped = m.ensure('image', stop.signal);
    stopped.catch(() => undefined);
    const other = m.ensure('image');
    other.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    stop.abort();
    await expect(stopped).rejects.toThrow(/canceled/);
    expect(m.status().find((s) => s.id === 'image')?.wanted).toBe(true);
    m.dismiss('image');
  });

  it('a job already stopped does not wait at all', async () => {
    const { m, emitted } = manager();
    const stop = new AbortController();
    stop.abort();
    await expect(m.ensure('audio', stop.signal)).rejects.toThrow(/canceled/);
    expect(m.status().find((s) => s.id === 'audio')?.wanted).toBe(false);
    expect(
      emitted.some((states) =>
        (states as Array<{ id: string; wanted: boolean }>).some(
          (s) => s.id === 'audio' && s.wanted,
        ),
      ),
    ).toBe(false);
  });

  it('a failed install keeps the job waiting for a retry, and says why', async () => {
    const { m, emitted } = manager({ fail: true });
    const job = m.ensure('image');
    await new Promise((r) => setTimeout(r, 0));
    await expect(m.install('image')).rejects.toThrow('no network');
    const shown = emitted.at(-1) as Array<{ id: string; error?: string; wanted: boolean }>;
    // Said so the person can act on it — not the raw line.
    expect(shown.find((s) => s.id === 'image')).toMatchObject({
      error: 'Could not reach the download server. Check the internet connection, then Try again.',
      wanted: true,
    });
    m.dismiss('image');
    await expect(job).rejects.toBeInstanceOf(GenModuleMissingError);
  });

  it('a second press joins the install in flight', async () => {
    const install = vi.fn(async (_id: string, report: (d: string) => void) => {
      report('x');
      await new Promise((r) => setTimeout(r, 5));
    });
    const m = new GenModulesManager({ ready: async () => false, install, emit: () => {} });
    const a = m.install('image');
    const b = m.install('image');
    await Promise.all([a, b]);
    expect(install).toHaveBeenCalledTimes(1);
  });
});

describe('what the model reads', () => {
  it('names the modality, the button, and what not to do — with the marker the card reads', () => {
    const text = moduleMissingMessage('image');
    expect(text).toMatch(/^Image generation is not set up on this Mac yet\./);
    expect(text).toMatch(/Download image module/);
    expect(text).toMatch(/Do not install uv, pip, Python/);
    expect(MODULE_MARKER_RE.exec(text)?.[1]).toBe('image');
  });

  it('maps a job to its module by backend', () => {
    expect(moduleForBackend('mflux')).toBe('image');
    expect(moduleForBackend('mlx-audio')).toBe('audio');
    expect(moduleForBackend('comfyui')).toBe('comfy');
    expect(moduleForBackend('hyperframes')).toBeUndefined();
    expect(GEN_MODULE_IDS).toEqual(['image', 'audio', 'comfy', '3d', 'dictation']);
  });

  it("tidies uv's progress into one line", () => {
    expect(
      uvLineToDetail('Resolved 96 packages in 1.20s\n\x1b[2mDownloading torch (215MiB)\x1b[0m\n'),
    ).toBe('Downloading torch (215MiB)');
    expect(uvLineToDetail('   \n')).toBeUndefined();
  });
});

describe('the press stops the clock', () => {
  it('a job waits on a running install past MODULE_WAIT_MS, and is told only if the install fails and nobody retries', async () => {
    const done: { finish: (() => void) | null; failWith: Error | null } = {
      finish: null,
      failWith: null,
    };
    const ready = new Set<string>();
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const m = new GenModulesManager({
      ready: async (id) => ready.has(id),
      install: (id) =>
        new Promise<void>((resolve, reject) => {
          done.finish = () => {
            if (done.failWith !== null) reject(done.failWith);
            else {
              ready.add(id);
              resolve();
            }
          };
        }),
      emit: () => undefined,
      setTimeout: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimeout: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    });
    let outcome: 'pending' | 'continued' | 'ended' = 'pending';
    const job = m.ensure('weights:wan2.1-t2v-1.3b').then(
      () => {
        outcome = 'continued';
      },
      () => {
        outcome = 'ended';
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(timers).toHaveLength(1);
    // The press: the waiter's clock is cleared; a long download is fine.
    void m.install('weights:wan2.1-t2v-1.3b').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(timers[0]?.cleared).toBe(true);
    expect(outcome).toBe('pending');
    // It fails: the clock is armed again, and firing it ends the job.
    done.failWith = new Error('no network');
    done.finish?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(outcome).toBe('pending');
    expect(timers).toHaveLength(2);
    timers[1]?.fn();
    await job;
    expect(outcome).toBe('ended');
  });
});

describe("a model's weights are a module of their own", () => {
  const meta = (id: string) =>
    id === 'weights:ltx-2.5-distilled'
      ? {
          label: 'LTX-2.5 22B distilled weights',
          blurb: 'The 4 files this model loads.',
          approxGB: 24.5,
          noun: 'LTX-2.5 22B distilled',
        }
      : undefined;

  it('names one only for an entry that lists files — or makes them here (mflux.prepared)', () => {
    expect(weightsModuleFor({ id: 'ltx-2.5-distilled', weights: [{}] })).toBe(
      'weights:ltx-2.5-distilled',
    );
    expect(weightsModuleFor({ id: 'hyperframes' })).toBeUndefined();
    expect(weightsModuleFor({ id: 'x', weights: [] })).toBeUndefined();
    // Qwen-Image 2.1: no files listed, a conversion made on this Mac instead.
    expect(weightsModuleFor({ id: 'qwen-image-2.1', mflux: { prepared: {} } })).toBe(
      'weights:qwen-image-2.1',
    );
    expect(weightsModuleFor({ id: 'flux2-klein-4b', mflux: {} })).toBeUndefined();
    expect(weightsModelId('weights:ltx-2.5-distilled')).toBe('ltx-2.5-distilled');
    expect(weightsModelId('comfy')).toBeNull();
  });

  it('is unknown until a job asks, then shows with the catalog’s name and size', async () => {
    const ready = new Set<string>();
    const emitted: unknown[][] = [];
    const m = new GenModulesManager({
      ready: async (id) => ready.has(id),
      install: async (id, report) => {
        report('Downloading comfyicu/LTX-2.5…', 0.2);
        ready.add(id);
      },
      emit: (states) => emitted.push(states as unknown[]),
      meta,
      setTimeout: () => ({}),
      clearTimeout: () => undefined,
    });
    expect(m.status().map((s) => s.id)).toEqual([...GEN_MODULE_IDS]);
    const job = m.ensure('weights:ltx-2.5-distilled');
    await new Promise((r) => setTimeout(r, 0));
    const shown = m.status().find((s) => s.id === 'weights:ltx-2.5-distilled');
    expect(shown).toMatchObject({
      label: 'LTX-2.5 22B distilled weights',
      approxGB: 24.5,
      wanted: true,
      ready: false,
    });
    await m.install('weights:ltx-2.5-distilled');
    await job;
    expect(m.status().find((s) => s.id === 'weights:ltx-2.5-distilled')?.ready).toBe(true);
  });

  it('the marker and the sentence carry the weights id, and the model is told the name', () => {
    const msg = moduleMissingMessage(
      'weights:ltx-2.5-distilled',
      meta('weights:ltx-2.5-distilled'),
    );
    expect(msg).toContain('LTX-2.5 22B distilled is not set up on this Mac yet');
    expect(msg).toContain('"Download ltx-2.5 22b distilled weights"');
    expect(MODULE_MARKER_RE.exec(msg)?.[1]).toBe('weights:ltx-2.5-distilled');
    // A dismissal names the module the same way.
    const err = new GenModuleMissingError(
      'weights:ltx-2.5-distilled',
      meta('weights:ltx-2.5-distilled'),
    );
    expect(err.message).toContain('[[bobble-module:weights:ltx-2.5-distilled]]');
  });
});

describe('plainInstallError — a failed install says what the person can do', () => {
  it('names the cause they can act on, never the raw line', () => {
    expect(
      plainInstallError('error: Failed to fetch: https://pypi.org/simple/mlx (ENOTFOUND)'),
    ).toMatch(/internet connection/);
    expect(plainInstallError('OSError: [Errno 28] No space left on device')).toMatch(
      /disk is full/,
    );
    expect(plainInstallError('huggingface_hub.errors.GatedRepoError: 401 Client Error')).toMatch(
      /refused/,
    );
    expect(plainInstallError('PermissionError: [Errno 13] Permission denied')).toMatch(
      /could not write/,
    );
    expect(plainInstallError('× No solution found when resolving dependencies')).toMatch(
      /could not be put together/,
    );
    const other = plainInstallError('Traceback (most recent call last): KeyError: x');
    expect(other).toMatch(/Try again/);
    expect(other).not.toMatch(/Traceback|KeyError/);
  });
});
