import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  assembleServerArgs,
  findFreePort,
  type LlamaChildProcess,
  LlamaServerSupervisor,
  type SupervisorEvent,
} from './supervisor.js';

/** Minimal fake child: an EventEmitter with stdout/stderr + kill capture. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killed: string[] = [];
  constructor(
    readonly pid = 4242,
    private readonly linger = false,
  ) {
    super();
  }
  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.killed.push(signal);
    // A well-behaved child exits on SIGTERM; a lingering one only dies on
    // SIGKILL (used to exercise the dispose escalation timer).
    if (!this.linger || signal === 'SIGKILL') {
      queueMicrotask(() => this.emit('exit', 0, signal));
    }
  }
}

const asChild = (c: FakeChild): LlamaChildProcess => c as unknown as LlamaChildProcess;

const okFetch = (ok: () => boolean): typeof fetch =>
  (async () => ({ ok: ok() }) as unknown as Response) as unknown as typeof fetch;

describe('assembleServerArgs', () => {
  const base = { modelPath: '/m.gguf', host: '127.0.0.1', port: 8080 } as const;

  it('fast-text with MTP support + embedded head enables draft-mtp, single slot', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      mtpSupported: true,
      mtpEmbedded: true,
    });
    expect(args).toContain('--parallel');
    expect(args[args.indexOf('--parallel') + 1]).toBe('1');
    expect(args).toContain('--spec-type');
    expect(args[args.indexOf('--spec-type') + 1]).toBe('draft-mtp');
    expect(args).toContain('--spec-draft-n-max');
    expect(args).not.toContain('--mmproj');
  });

  it('fast-text passes a separate MTP head via --model-draft', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      mtpSupported: true,
      mtpPath: '/mtp.gguf',
    });
    expect(args).toContain('--model-draft');
    expect(args[args.indexOf('--model-draft') + 1]).toBe('/mtp.gguf');
  });

  it('fast-text omits draft-mtp when the build lacks MTP support', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      mtpSupported: false,
      mtpEmbedded: true,
    });
    expect(args).not.toContain('--spec-type');
    expect(args).toContain('--parallel');
  });

  it('fast-text EAGLE-3 enables draft-eagle3 + the draft model via --model-draft', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      specType: 'draft-eagle3',
      eagle3Supported: true,
      draftPath: '/eagle3.gguf',
    });
    expect(args).toContain('--spec-type');
    expect(args[args.indexOf('--spec-type') + 1]).toBe('draft-eagle3');
    expect(args).toContain('--model-draft');
    expect(args[args.indexOf('--model-draft') + 1]).toBe('/eagle3.gguf');
    expect(args).toContain('--spec-draft-n-max');
    // EAGLE-3 must NOT also emit the MTP spec-type.
    expect(args).not.toContain('draft-mtp');
    expect(args).not.toContain('--mmproj');
  });

  it('fast-text EAGLE-3 omits spec flags when the build lacks eagle3 support', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      specType: 'draft-eagle3',
      eagle3Supported: false,
      draftPath: '/eagle3.gguf',
    });
    expect(args).not.toContain('--spec-type');
    expect(args).not.toContain('--model-draft');
    expect(args).toContain('--parallel');
  });

  it('assembles every spec type the server has: none, dflash, dspark, ngram', () => {
    const none = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      specType: 'none',
      mtpSupported: true,
      mtpEmbedded: true,
    });
    expect(none).not.toContain('--spec-type');
    const dflash = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      specType: 'draft-dflash',
      draftPath: '/d/dflash.gguf',
    });
    expect(dflash.join(' ')).toContain(
      '--spec-type draft-dflash --spec-draft-n-max 7 --model-draft /d/dflash.gguf',
    );
    const dspark = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      specType: 'draft-dspark',
      draftPath: '/d/dspark.gguf',
      specDraftNMax: 5,
    });
    expect(dspark.join(' ')).toContain(
      '--spec-type draft-dspark --spec-draft-n-max 5 --model-draft /d/dspark.gguf',
    );
    // Without its draft on disk a drafted type is silently plain, never a broken launch.
    const missing = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      specType: 'draft-dspark',
    });
    expect(missing).not.toContain('--spec-type');
    const ngram = assembleServerArgs({ ...base, launchMode: 'fast-text', specType: 'ngram-mod' });
    expect(ngram.join(' ')).toContain('--spec-type ngram-mod');
    expect(ngram).not.toContain('--model-draft');
  });

  it('multimodal enables --mmproj, never draft-mtp, and honours --parallel', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'multimodal',
      mmprojPath: '/mmproj.gguf',
      parallel: 4,
    });
    expect(args).toContain('--mmproj');
    expect(args[args.indexOf('--mmproj') + 1]).toBe('/mmproj.gguf');
    expect(args[args.indexOf('--parallel') + 1]).toBe('4');
    expect(args).not.toContain('--spec-type');
  });

  it('adds --reasoning-preserve by default and omits it when disabled', () => {
    const on = assembleServerArgs({ ...base, launchMode: 'fast-text' });
    expect(on).toContain('--reasoning-preserve');
    // …and the same switch under the name Ling's template reads.
    expect(on[on.indexOf('--chat-template-kwargs') + 1]).toBe('{"preserved_thinking":true}');
    const off = assembleServerArgs({ ...base, launchMode: 'fast-text', reasoningPreserve: false });
    expect(off).not.toContain('--reasoning-preserve');
    expect(off).not.toContain('--chat-template-kwargs');
  });

  it('defaults reasoning budget to unrestricted (-1) with the wrap-up message', () => {
    const args = assembleServerArgs({ ...base, launchMode: 'fast-text' });
    expect(args[args.indexOf('--reasoning-budget') + 1]).toBe('-1');
    expect(args[args.indexOf('--reasoning-budget-message') + 1]).toBe(
      'time limit for reasoning reached',
    );
  });

  it('honours an explicit reasoning budget + custom budget message', () => {
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      reasoningBudget: 2048,
      reasoningBudgetMessage: 'wrap it up',
    });
    expect(args[args.indexOf('--reasoning-budget') + 1]).toBe('2048');
    expect(args[args.indexOf('--reasoning-budget-message') + 1]).toBe('wrap it up');
  });

  it('carries the projector on a fast-text launch (vision is always on)', () => {
    // Was: throws on fast-text + mmproj. Reversed after measuring that
    // --spec-type draft-mtp and --mmproj coexist at full speed (91.9 tok/s,
    // versus 43.8 with neither) — the exclusivity was our policy, not
    // llama.cpp's, and it left the default server blind.
    const args = assembleServerArgs({
      modelPath: '/models/qwen.gguf',
      host: '127.0.0.1',
      port: 8080,
      launchMode: 'fast-text',
      mmprojPath: '/models/mmproj-F16.gguf',
      mtpSupported: true,
      mtpEmbedded: true,
    });
    expect(args).toContain('--mmproj');
    expect(args[args.indexOf('--mmproj') + 1]).toBe('/models/mmproj-F16.gguf');
    // …and speculative decoding is untouched: both live on the same launch.
    expect(args).toContain('--spec-type');
  });

  it('throws on a multimodal launch missing its mmproj (would be vision-blind)', () => {
    // Symmetric invariant: a "vision" launch with no projector would come up
    // vision-blind while the app believes vision is on — fail loudly instead.
    expect(() => assembleServerArgs({ ...base, launchMode: 'multimodal' })).toThrow(
      /requires an --mmproj/,
    );
  });

  it('LAZY: a fast-text launch of a vision-capable model still emits no --mmproj', () => {
    // The default (text) launch of a model that HAS a projector must never load
    // it — full MTP speed, zero projector cost, even with the speed head present.
    const args = assembleServerArgs({
      ...base,
      launchMode: 'fast-text',
      mtpSupported: true,
      mtpEmbedded: true,
    });
    expect(args).not.toContain('--mmproj');
    expect(args).toContain('--spec-type');
  });
});

describe('findFreePort', () => {
  it('returns a usable port', async () => {
    const port = await findFreePort('127.0.0.1');
    expect(port).toBeGreaterThan(0);
  });
});

function collect(sup: LlamaServerSupervisor): SupervisorEvent[] {
  const events: SupervisorEvent[] = [];
  sup.on((e) => events.push(e));
  return events;
}

describe('LlamaServerSupervisor lifecycle', () => {
  it('spawns, health-checks, and emits ready', async () => {
    let child: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9099,
      healthIntervalMs: 1,
      spawnFn: () => {
        child = new FakeChild();
        return asChild(child);
      },
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    const result = await sup.start();
    expect(result.port).toBe(9099);
    expect(result.baseUrl).toBe('http://127.0.0.1:9099/v1');
    expect(events.some((e) => e.type === 'ready')).toBe(true);
    expect(child).toBeDefined();
    await sup.dispose();
  });

  it('fails FAST when the child dies during startup, instead of polling out the health timeout', async () => {
    // An engine that exits at import (missing wheel, bad drafter) used to cost
    // the full health timeout per calibration candidate. The death is the answer.
    let spawns = 0;
    const sup = new LlamaServerSupervisor({
      serverPath: '/venv/bin/rapid-mlx',
      modelPath: '/store/x',
      launchMode: 'fast-text',
      port: 9111,
      healthIntervalMs: 1,
      healthTimeoutMs: 60_000,
      maxRestarts: 0,
      spawnFn: () => {
        spawns += 1;
        const child = new FakeChild();
        setTimeout(() => child.emit('exit', 1, null), 5);
        return asChild(child);
      },
      fetchImpl: okFetch(() => false),
    });
    const events = collect(sup);
    const t0 = Date.now();
    await expect(sup.start()).rejects.toThrow(/never became healthy/);
    expect(Date.now() - t0).toBeLessThan(2000);
    // start() owns its retries: the exit must not have spawned a second child.
    expect(spawns).toBe(1);
    expect(events.some((e) => e.type === 'exit' && e.reason === 'failed')).toBe(true);
  });

  it('extracts TPS from timings via recordTimings', async () => {
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9100,
      healthIntervalMs: 1,
      spawnFn: () => asChild(new FakeChild()),
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    await sup.start();

    sup.recordTimings({ predicted_per_second: 42.5, predicted_n: 100 });
    expect(sup.metrics.lastTps).toBeCloseTo(42.5);
    expect(sup.metrics.totalPredictedTokens).toBe(100);
    expect(events.some((e) => e.type === 'metrics')).toBe(true);

    // Fallback: derive from predicted_n / predicted_ms.
    sup.recordTimings({ predicted_n: 50, predicted_ms: 500 });
    expect(sup.metrics.lastTps).toBeCloseTo(100);
    expect(sup.metrics.samples).toBe(2);
    await sup.dispose();
  });

  it('restarts with backoff after a crash', async () => {
    let spawnCount = 0;
    let lastChild: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9101,
      healthIntervalMs: 1,
      restartBaseDelayMs: 5,
      spawnFn: () => {
        spawnCount += 1;
        lastChild = new FakeChild();
        return asChild(lastChild);
      },
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    await sup.start();
    expect(spawnCount).toBe(1);

    // Simulate a crash; wait for the restart to bring a new child up.
    const restarted = new Promise<void>((resolve) => {
      const off = sup.on((e) => {
        if (e.type === 'ready' && spawnCount >= 2) {
          off();
          resolve();
        }
      });
    });
    lastChild?.emit('exit', 1, null);
    await restarted;

    expect(spawnCount).toBe(2);
    expect(events.some((e) => e.type === 'crash')).toBe(true);
    const restart = events.find((e) => e.type === 'restart');
    expect(restart).toBeDefined();
    await sup.dispose();
  });

  it('park stops the child without a restart, and resume brings it back on the same port', async () => {
    let spawnCount = 0;
    const children: FakeChild[] = [];
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9102,
      healthIntervalMs: 1,
      restartBaseDelayMs: 5,
      spawnFn: () => {
        spawnCount += 1;
        const c = new FakeChild(6000 + spawnCount);
        children.push(c);
        return asChild(c);
      },
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    const first = await sup.start();

    await sup.park();
    expect(children[0]?.killed).toEqual(['SIGTERM']);
    expect(sup.parked).toBe(true);
    expect(sup.running).toBe(false);
    // The exit the park caused is not a crash, so nothing restarts on its own.
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnCount).toBe(1);
    expect(events.some((e) => e.type === 'crash')).toBe(false);
    expect(events.some((e) => e.type === 'parked')).toBe(true);
    // The URL everyone holds is still the URL.
    expect(sup.baseUrl).toBe(first.baseUrl);

    const back = await sup.resume();
    expect(spawnCount).toBe(2);
    expect(back.port).toBe(first.port);
    expect(back.baseUrl).toBe(first.baseUrl);
    expect(sup.parked).toBe(false);
    expect(sup.running).toBe(true);
    expect(events.some((e) => e.type === 'resumed')).toBe(true);

    // A crash AFTER resuming is supervised again.
    const restarted = new Promise<void>((resolve) => {
      const off = sup.on((e) => {
        if (e.type === 'ready' && spawnCount >= 3) {
          off();
          resolve();
        }
      });
    });
    children[1]?.emit('exit', 1, null);
    await restarted;
    expect(spawnCount).toBe(3);
    await sup.dispose();
  });

  it('park and resume are idempotent and a disposed supervisor refuses to resume', async () => {
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9103,
      healthIntervalMs: 1,
      spawnFn: () => asChild(new FakeChild()),
      fetchImpl: okFetch(() => true),
    });
    await sup.start();
    const r0 = await sup.resume(); // not parked: a no-op that reports the running server
    expect(r0.port).toBe(9103);
    await sup.park();
    await sup.park();
    expect(sup.parked).toBe(true);
    await sup.dispose();
    expect(sup.parked).toBe(false);
    await expect(sup.resume()).rejects.toThrow(/disposed/);
  });

  /**
   * A child that ignores BOTH signals. Real llama-server does not, but a process
   * stuck in uninterruptible I/O while unmapping tens of gigabytes behaves
   * exactly like this for a while, and that is the window the model-switch bug
   * lived in.
   */
  class StubbornChild extends EventEmitter {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    readonly killed: string[] = [];
    constructor(readonly pid = 5150) {
      super();
    }
    kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
      this.killed.push(signal);
      // Deliberately never emits 'exit'.
    }
  }

  it('dispose does NOT resolve while the process is still alive after SIGKILL', async () => {
    // THE MODEL-SWITCH BUG. dispose() used to resolve on the same tick as
    // kill('SIGKILL'), so the switch path spawned the next (larger) model while
    // the previous one still held its weights — both resident at once on a
    // 24GB machine.
    vi.useFakeTimers();
    try {
      let child: StubbornChild | undefined;
      const sup = new LlamaServerSupervisor({
        serverPath: '/bin/llama-server',
        modelPath: '/m.gguf',
        launchMode: 'fast-text',
        port: 9107,
        healthIntervalMs: 1,
        killGraceMs: 3_000,
        spawnFn: () => {
          child = new StubbornChild();
          return asChild(child as unknown as FakeChild);
        },
        fetchImpl: okFetch(() => true),
      });
      await sup.start();

      let resolved = false;
      const disposing = sup.dispose().then(() => {
        resolved = true;
      });

      // SIGTERM ignored → escalate.
      await vi.advanceTimersByTimeAsync(3_100);
      expect(child?.killed).toEqual(['SIGTERM', 'SIGKILL']);

      // THE ASSERTION. Old behaviour resolved here, with the process still up.
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Bounded, so a wedged process can never hang a switch forever.
      await vi.advanceTimersByTimeAsync(5_100);
      await disposing;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose resolves as soon as a SIGKILLed child actually exits', async () => {
    vi.useFakeTimers();
    try {
      let child: FakeChild | undefined;
      const sup = new LlamaServerSupervisor({
        serverPath: '/bin/llama-server',
        modelPath: '/m.gguf',
        launchMode: 'fast-text',
        port: 9108,
        healthIntervalMs: 1,
        killGraceMs: 3_000,
        // Lingers through SIGTERM, exits on SIGKILL — the normal stubborn case.
        spawnFn: () => {
          child = new FakeChild(4242, true);
          return asChild(child);
        },
        fetchImpl: okFetch(() => true),
      });
      await sup.start();
      const disposing = sup.dispose();
      // Escalation fires, the child exits, and dispose returns without waiting
      // out the confirmation backstop.
      await vi.advanceTimersByTimeAsync(3_100);
      await disposing;
      expect(child?.killed).toEqual(['SIGTERM', 'SIGKILL']);
      expect(sup.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('killImmediately synchronously SIGKILLs the child and is idempotent', async () => {
    let child: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9103,
      healthIntervalMs: 1,
      // linger: even a child that ignores SIGTERM must die here.
      spawnFn: () => {
        child = new FakeChild(4242, true);
        return asChild(child);
      },
      fetchImpl: okFetch(() => true),
    });
    await sup.start();

    // The utilityProcess-teardown backstop: a single synchronous SIGKILL, no
    // async dispose ladder, so no orphaned llama-server survives quit.
    sup.killImmediately();
    expect(child?.killed).toEqual(['SIGKILL']);
    expect(sup.running).toBe(false);

    // Idempotent: the child is already cleared, so a second call is a no-op.
    sup.killImmediately();
    expect(child?.killed).toEqual(['SIGKILL']);
  });

  it('arms a parent-death watchdog with the child pid and stops it on dispose', async () => {
    const stops: number[] = [];
    const pids: number[] = [];
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9200,
      healthIntervalMs: 1,
      spawnFn: () => asChild(new FakeChild(7777)),
      fetchImpl: okFetch(() => true),
      watchdogFactory: (pid) => {
        pids.push(pid);
        const idx = pids.length - 1;
        return {
          stop() {
            stops.push(idx);
          },
        };
      },
    });
    await sup.start();
    expect(pids).toEqual([7777]);
    expect(stops).toEqual([]);
    await sup.dispose();
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it('stops the watchdog synchronously on killImmediately', async () => {
    let stopped = 0;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9201,
      healthIntervalMs: 1,
      spawnFn: () => asChild(new FakeChild(8888, true)),
      fetchImpl: okFetch(() => true),
      watchdogFactory: () => ({
        stop() {
          stopped += 1;
        },
      }),
    });
    await sup.start();
    sup.killImmediately();
    expect(stopped).toBeGreaterThanOrEqual(1);
  });

  it('re-arms a fresh watchdog on crash-restart and stops the old one', async () => {
    const pids: number[] = [];
    const stops: number[] = [];
    let nextPid = 1000;
    let lastChild: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9202,
      healthIntervalMs: 1,
      restartBaseDelayMs: 5,
      spawnFn: () => {
        nextPid += 1;
        lastChild = new FakeChild(nextPid);
        return asChild(lastChild);
      },
      fetchImpl: okFetch(() => true),
      watchdogFactory: (pid) => {
        pids.push(pid);
        const idx = pids.length - 1;
        return {
          stop() {
            stops.push(idx);
          },
        };
      },
    });
    await sup.start();
    expect(pids).toHaveLength(1);

    const restarted = new Promise<void>((resolve) => {
      const off = sup.on((e) => {
        if (e.type === 'ready' && pids.length >= 2) {
          off();
          resolve();
        }
      });
    });
    lastChild?.emit('exit', 1, null);
    await restarted;

    expect(pids).toHaveLength(2);
    expect(pids[0]).not.toBe(pids[1]);
    expect(stops).toContain(0); // the crashed child's watchdog was disarmed
    await sup.dispose();
  });

  it('dispose escalates SIGTERM → SIGKILL when the child lingers', async () => {
    let child: FakeChild | undefined;
    const sup = new LlamaServerSupervisor({
      serverPath: '/bin/llama-server',
      modelPath: '/m.gguf',
      launchMode: 'fast-text',
      port: 9102,
      healthIntervalMs: 1,
      killGraceMs: 20,
      spawnFn: () => {
        child = new FakeChild(4242, true);
        return asChild(child);
      },
      fetchImpl: okFetch(() => true),
    });
    const events = collect(sup);
    await sup.start();

    // Child never emits 'exit', forcing the SIGKILL escalation timer.
    await sup.dispose();
    expect(child?.killed).toContain('SIGTERM');
    expect(child?.killed).toContain('SIGKILL');
    expect(events.some((e) => e.type === 'exit')).toBe(true);
  });
});

/*
 * DRY MUST BE ABLE TO SEE STRUCTURED TEXT.
 *
 * llama.cpp's DRY defaults to breaking its match on '\n', ':', '"' and '*', and
 * a breaker RESETS the matched run — so on JSON/config content the longest run
 * is a couple of tokens, far below --dry-allowed-length, and DRY never fires.
 * That is how a write tool argument reached 1383 identical lines with DRY fully
 * configured. Measured on the 4B, continuing an already-repeating JSON block:
 * default breakers 30 repeats (still looping), cleared 3 (broke out).
 */
describe('DRY sequence breakers', () => {
  const base = { modelPath: '/m.gguf', host: '127.0.0.1', port: 8080 } as const;

  it('clears the defaults so DRY applies to JSON and config text', () => {
    const args = assembleServerArgs({ ...base, launchMode: 'fast-text' });
    const i = args.indexOf('--dry-sequence-breaker');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('none');
  });

  it('keeps the allowed run long enough not to punish real code', () => {
    // The breakers existed to protect legitimately repetitive text; the allowed
    // length is what protects it now, and it has to stay generous.
    const args = assembleServerArgs({ ...base, launchMode: 'fast-text' });
    const i = args.indexOf('--dry-allowed-length');
    expect(Number(args[i + 1])).toBeGreaterThanOrEqual(64);
  });
});
