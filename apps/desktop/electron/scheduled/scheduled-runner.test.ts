/**
 * The runner, against a FAKE bridge — no pi, no models. What is worth testing is
 * the orchestration: runs serialise, a run record moves running→ok→has-artifacts,
 * a crash becomes an error record, and the artifact scan only trawls a dedicated
 * per-run dir (never someone's named working folder).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
// The runner reads os.homedir() at import to root its runs dir; mock the module
// (spyOn is rejected in this env — os is frozen) BEFORE importing it.
vi.mock('node:os', async (orig) => {
  const actual = (await orig()) as typeof os;
  return { ...actual, homedir: () => HOME };
});

const RUNS_DIR = path.join(HOME, '.pi', 'desktop', 'scheduled-runs');
const { createScheduledRunner } = await import('./scheduled-runner.js');
const { normalizeTask } = await import('./schedule-logic.js');

/** A bridge that fires a scripted event sequence, then resolves its run. */
function fakeBridge(script: (emit: (e: unknown) => void, cwd: string) => void, cwd: string) {
  let onEvent: (e: unknown) => void = () => {};
  return {
    bridge: {
      ready: () => Promise.resolve(),
      alive: true,
      prompt: async () => {
        script(onEvent, cwd);
      },
      dispose: () => {},
    },
    attach: (fn: (e: unknown) => void) => {
      onEvent = fn;
    },
  };
}

const task = (over = {}) =>
  normalizeTask({
    id: 'task_x',
    name: 'T',
    prompt: 'do it',
    frequency: 'daily',
    createdAt: 0,
    ...over,
  });

let updates: Array<{ id: string; status: string }> = [];
let ranAt: Array<{ id: string; when: number }> = [];

function makeRunner(
  script: (emit: (e: unknown) => void, cwd: string) => void,
  opts: { onCreate?: (cwd: string) => void } = {},
) {
  return createScheduledRunner({
    createBridge: ({ cwd }, onEvent) => {
      opts.onCreate?.(cwd ?? '');
      const fb = fakeBridge(script, cwd ?? '');
      fb.attach(onEvent as (e: unknown) => void);
      return fb.bridge;
    },
    onRunUpdated: (run) => updates.push({ id: run.id, status: run.status }),
    markRan: (id, when) => ranAt.push({ id, when }),
    now: () => Date.now(),
  });
}

const OK_SCRIPT = (emit: (e: unknown) => void) => {
  emit({ type: 'message_start' });
  emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', name: 'web_search' },
  });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done. ' } });
  emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Made a report.' },
  });
  emit({ type: 'agent_end' });
};

async function settle() {
  // Let the queued promise chain flush.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  updates = [];
  ranAt = [];
});
afterEach(() => vi.clearAllMocks());

describe('a successful run', () => {
  it('records running → ok with the final text and the tools it used', async () => {
    const runner = makeRunner(OK_SCRIPT);
    const { runId } = runner.run(task());
    await settle();
    const runs = runner.listRuns('task_x');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.summary).toBe('Done. Made a report.');
    expect(runs[0]?.toolCalls).toEqual(['web_search']);
    // The record moved through running before ok.
    expect(updates.map((u) => u.status)).toEqual(['running', 'ok']);
  });

  it('stamps the task as run at its START, so a slow run cannot double-fire', async () => {
    const runner = makeRunner(OK_SCRIPT);
    runner.run(task());
    await settle();
    // Exactly one stamp, and it is the run's START time — a later tick during a
    // long run sees lastRunAt already moved, so dueTasks will not pick it again.
    expect(ranAt).toHaveLength(1);
    const run = runner.listRuns('task_x')[0];
    expect(ranAt[0]?.when).toBe(run?.startedAt);
    expect(run?.finishedAt).toBeGreaterThanOrEqual(run?.startedAt ?? 0);
  });

  it('captures artifacts the run created in its dedicated dir', async () => {
    const runner = makeRunner((emit, cwd) => {
      fs.writeFileSync(path.join(cwd, 'news.mp4'), 'x'.repeat(2048));
      fs.writeFileSync(path.join(cwd, 'face.png'), 'y'.repeat(1024));
      emit({ type: 'agent_end' });
    });
    runner.run(task());
    await settle();
    const arts = runner.listRuns('task_x')[0]?.artifacts ?? [];
    expect(arts.map((a) => a.name).sort()).toEqual(['face.png', 'news.mp4']);
    // Media is ordered first — it is what you opened the run to see.
    expect(arts[0]?.kind).toBe('image');
    expect(arts.every((a) => a.kind === 'image' || a.kind === 'video')).toBe(true);
  });

  it('does NOT trawl a task that names its own working folder', async () => {
    // A repo task must not have its whole tree scanned as "artifacts".
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    fs.writeFileSync(path.join(repo, 'unrelated.ts'), 'existing');
    const runner = makeRunner((emit, cwd) => {
      fs.writeFileSync(path.join(cwd, 'scratch.txt'), 'new');
      emit({ type: 'agent_end' });
    });
    runner.run(task({ cwd: repo }));
    await settle();
    expect(runner.listRuns('task_x')[0]?.artifacts).toEqual([]);
  });
});

describe('a failing run', () => {
  it('records an error when the bridge exits without ending cleanly', async () => {
    const runner = makeRunner((emit) => {
      emit({ type: '_bridge_exit' });
    });
    runner.run(task());
    await settle();
    const run = runner.listRuns('task_x')[0];
    expect(run?.status).toBe('error');
    expect(run?.error).toBeTruthy();
  });
});

describe('serialisation', () => {
  it('runs one at a time — the second bridge is not built until the first ends', async () => {
    const order: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const runner = createScheduledRunner({
      createBridge: (_opts, onEvent) => ({
        ready: () => Promise.resolve(),
        alive: true,
        prompt: async () => {
          order.push('start');
          if (gate.release === null) {
            await new Promise<void>((r) => {
              gate.release = r;
            });
          }
          (onEvent as (e: unknown) => void)({ type: 'agent_end' });
        },
        dispose: () => {},
      }),
      onRunUpdated: () => {},
      markRan: () => {},
      now: () => Date.now(),
    });
    runner.run(task({ id: 'a' }));
    runner.run(task({ id: 'b' }));
    await new Promise((r) => setTimeout(r, 20));
    // Only the first has started; the second is queued behind it.
    expect(order).toEqual(['start']);
    gate.release?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(['start', 'start']);
  });
});

describe('stopping', () => {
  /** A bridge whose prompt never ends on its own — the run stays live until stopped. */
  function hangingRunner(opts: { onDispose?: () => void } = {}) {
    let emit: (e: unknown) => void = () => {};
    const runner = createScheduledRunner({
      createBridge: (_opts, onEvent) => {
        emit = onEvent as (e: unknown) => void;
        return {
          ready: () => Promise.resolve(),
          alive: true,
          prompt: async () => {
            emit({ type: 'message_start' });
            emit({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'Half way ' },
            });
            await new Promise(() => {});
          },
          dispose: () => {
            opts.onDispose?.();
            // The real bridge reports its exit after dispose; that must not
            // turn a stopped run into a failed one.
            emit({ type: '_bridge_exit' });
          },
        };
      },
      onRunUpdated: (run) => updates.push({ id: run.id, status: run.status }),
      markRan: () => {},
      now: () => Date.now(),
    });
    return runner;
  }

  it('ends the live run as `stopped`, keeps what it had said, and frees the bridge', async () => {
    let disposed = 0;
    const runner = hangingRunner({ onDispose: () => disposed++ });
    const { runId } = runner.run(task(), 'manual');
    await settle();
    expect(runner.listRuns('task_x')[0]?.status).toBe('running');

    expect(runner.stop('task_x')).toBe(true);
    await settle();
    const run = runner.listRuns('task_x')[0];
    expect(run?.id).toBe(runId);
    expect(run?.status).toBe('stopped');
    expect(run?.error).toBeUndefined();
    expect(run?.summary).toBe('Half way');
    expect(run?.finishedAt).toBeGreaterThanOrEqual(run?.startedAt ?? 0);
    expect(disposed).toBe(1);
    expect(updates.map((u) => u.status)).toEqual(['running', 'stopped']);
  });

  it('drops a run still waiting in the queue, which then leaves no record', async () => {
    const runner = hangingRunner();
    runner.run(task({ id: 'a' }));
    runner.run(task({ id: 'b' }));
    await settle();
    // b is queued behind a: nothing of b's exists yet.
    expect(runner.listRuns('b')).toEqual([]);
    expect(runner.stop('b')).toBe(true);
    // a is still running; stop it so the queue drains and b's turn comes.
    expect(runner.stop('a')).toBe(true);
    await settle();
    await settle();
    expect(runner.listRuns('a')[0]?.status).toBe('stopped');
    expect(runner.listRuns('b')).toEqual([]);
  });

  it('says so when there is nothing to stop', async () => {
    const runner = makeRunner(OK_SCRIPT);
    runner.run(task());
    await settle();
    expect(runner.stop('task_x')).toBe(false);
    expect(runner.listRuns('task_x')[0]?.status).toBe('ok');
  });
});

describe('the model on the record', () => {
  it('stamps the loaded model at the start, and at the end if it came up during the run', async () => {
    let loaded: { id: string; displayName: string } | null = null;
    const runner = createScheduledRunner({
      createBridge: (_opts, onEvent) => ({
        ready: () => Promise.resolve(),
        alive: true,
        prompt: async () => {
          // The first run of the day: the model loads while it is going.
          loaded = { id: 'gemma-4-12b', displayName: 'Gemma 4 12B' };
          (onEvent as (e: unknown) => void)({ type: 'agent_end' });
        },
        dispose: () => {},
      }),
      onRunUpdated: () => {},
      markRan: () => {},
      now: () => Date.now(),
      currentModel: () => loaded,
    });
    runner.run(task());
    await settle();
    expect(runner.listRuns('task_x')[0]?.model).toEqual({
      id: 'gemma-4-12b',
      displayName: 'Gemma 4 12B',
    });
  });

  it('leaves the field off rather than guessing when nothing was ever loaded', async () => {
    const runner = makeRunner(OK_SCRIPT);
    runner.run(task());
    await settle();
    expect(runner.listRuns('task_x')[0]?.model).toBeUndefined();
  });
});

describe('pruning + deletion', () => {
  it('keeps a task deletable — deleteRunsForTask removes the whole history', async () => {
    const runner = makeRunner(OK_SCRIPT);
    runner.run(task());
    await settle();
    expect(runner.listRuns('task_x')).toHaveLength(1);
    runner.deleteRunsForTask('task_x');
    expect(runner.listRuns('task_x')).toEqual([]);
  });
});
