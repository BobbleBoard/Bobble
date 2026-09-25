/**
 * The machine-wide slots every lane shares (_locks.mjs).
 *
 * Every test works in its own temp lock root — never /tmp/bobble-locks, which
 * a dozen other worktrees are using while this runs.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  orphanedServers,
  parseProcessRows as reapParse,
} from '../../electron/inference/reap-orphans';
// @ts-expect-error - the lock module is plain ESM for probes and scripts, not typed app code.
import * as locks from './_locks.mjs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'locks-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A pid that existed a moment ago and does not now. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  return Number(r.stdout);
}

/** A slot on disk as another process would have left it. */
function plant(cls: string, i: number, pid: number, extra: { started?: string } = {}): string {
  const dir = path.join(root, `${cls}-${i}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'pid'), String(pid));
  writeFileSync(path.join(dir, 'cmd'), 'planted\n/somewhere\n');
  if (extra.started !== undefined) writeFileSync(path.join(dir, 'started'), `${extra.started}\n`);
  return dir;
}

describe('slots', () => {
  it('hands out distinct slots up to the cap, then none', () => {
    const got = [0, 1, 2].map(() => locks.tryAcquire('probe', { root }));
    expect(new Set(got).size).toBe(3);
    expect(locks.tryAcquire('probe', { root })).toBeNull();
    // The layout the old with-lock.mjs reads: <root>/<class>-<n>/pid.
    expect(readFileSync(path.join(root, 'probe-0', 'pid'), 'utf8')).toBe(String(process.pid));
    expect(readFileSync(path.join(root, 'probe-0', 'cmd'), 'utf8')).toContain(process.cwd());
  });

  it('takes over a slot whose owner is dead', () => {
    plant('heavy', 0, deadPid());
    expect(locks.slotState(path.join(root, 'heavy-0'))).toBe('stale');
    const dir = locks.tryAcquire('heavy', { root });
    expect(dir).toBe(path.join(root, 'heavy-0'));
    expect(readFileSync(path.join(dir, 'pid'), 'utf8')).toBe(String(process.pid));
  });

  it('does not take a slot whose owner is alive', () => {
    plant('heavy', 0, process.pid);
    expect(locks.tryAcquire('heavy', { root, pid: 424242 })).toBeNull();
  });

  it('treats a RECYCLED pid as dead: alive, but started at a different time', () => {
    // The owner crashed and its pid came back as somebody's shell.
    plant('heavy', 0, process.pid, { started: 'Mon Jan  1 00:00:00 2024' });
    expect(locks.slotState(path.join(root, 'heavy-0'))).toBe('stale');
    // …while the same pid with the matching start time is the owner.
    const start = locks.processStart(process.pid);
    plant('build', 0, process.pid, { started: start });
    expect(locks.slotState(path.join(root, 'build-0'))).toBe('held');
  });

  it('leaves a slot being written alone, and reclaims one whose writer died mid-write', () => {
    const dir = path.join(root, 'test-0');
    mkdirSync(dir);
    expect(locks.slotState(dir)).toBe('writing');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(dir, old, old);
    expect(locks.slotState(dir)).toBe('stale');
    expect(locks.tryAcquire('test', { root })).toBe(dir);
  });

  it('shrinks probes and builds to one slot while a heavy job holds', () => {
    expect(locks.capNow('probe', { root })).toBe(3);
    plant('heavy', 0, process.pid);
    expect(locks.capNow('probe', { root })).toBe(1);
    expect(locks.capNow('build', { root })).toBe(1);
    expect(locks.capNow('test', { root })).toBe(6);
    expect(locks.tryAcquire('probe', { root })).toBe(path.join(root, 'probe-0'));
    expect(locks.tryAcquire('probe', { root })).toBeNull();
  });

  it('releases only its own slot', () => {
    const mine = locks.tryAcquire('build', { root });
    expect(locks.releaseSlot(mine, 999_999)).toBe(false);
    expect(locks.slotState(mine)).toBe('held');
    expect(locks.releaseSlot(mine)).toBe(true);
    expect(locks.slotState(mine)).toBe('free');
  });

  it('cleans stale slots and nothing else', () => {
    plant('probe', 0, deadPid());
    plant('probe', 1, process.pid);
    expect(locks.cleanStaleSlots({ root })).toEqual([path.join(root, 'probe-0')]);
    expect(locks.slotState(path.join(root, 'probe-1'))).toBe('held');
  });
});

describe('acquire', () => {
  it('waits for a held slot and gets it when it is released', async () => {
    const first = await locks.acquire('heavy', { root, run: noBlockers, log: () => {} });
    let second: { release(): void } | null = null;
    const waiting = locks
      .acquire('heavy', { root, run: noBlockers, pollMs: 20, log: () => {} })
      .then((l: { release(): void }) => {
        second = l;
      });
    await new Promise((r) => setTimeout(r, 120));
    expect(second).toBeNull();
    first.release();
    await waiting;
    expect(second).not.toBeNull();
  });

  it('gives up with LockTimeoutError (exit code 75) and says why', async () => {
    plant('build', 0, process.pid);
    plant('build', 1, process.pid);
    const err = await locks
      .acquire('build', { root, waitMs: 60, pollMs: 20, log: () => {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(locks.LockTimeoutError);
    expect((err as { exitCode: number }).exitCode).toBe(75);
    expect(String(err)).toContain('planted');
  });

  it('hands its children BOBBLE_LOCK_HELD, adding to what it inherited', async () => {
    const lease = await locks.acquire('probe', { root, env: { BOBBLE_LOCK_HELD: 'heavy' } });
    expect(lease.env()).toEqual({ BOBBLE_LOCK_HELD: 'heavy,probe' });
    lease.release();
    expect(locks.heldByAncestor('probe', { BOBBLE_LOCK_HELD: 'heavy,probe' })).toBe(true);
    expect(locks.heldByAncestor('probe', {})).toBe(false);
  });

  it('while a heavy job waits for probes to drain, new probes are held to one (no starvation)', async () => {
    const p1 = plant('probe', 1, process.pid);
    plant('probe', 2, process.pid);
    expect(locks.capNow('probe', { root })).toBe(3);
    let heavy: { release(): void } | null = null;
    const waiting = locks
      .acquire('heavy', { root, run: noBlockers, pollMs: 20, log: () => {} })
      .then((l: { release(): void }) => {
        heavy = l;
      });
    await new Promise((r) => setTimeout(r, 120));
    expect(heavy).toBeNull();
    expect(locks.heavyPending({ root })).toBe(true);
    expect(locks.capNow('probe', { root })).toBe(1);
    expect(locks.capNow('build', { root })).toBe(1);
    expect(locks.lockStatus({ root, run: noBlockers }).heavyPending).toMatchObject({
      pid: process.pid,
    });
    rmSync(p1, { recursive: true, force: true }); // one probe finishes: one left
    await waiting;
    expect(heavy).not.toBeNull();
    expect(locks.heavyPending({ root })).toBe(false);
  });

  it('does not hold probes back for a heavy job that is waiting on something else', async () => {
    plant('probe', 0, process.pid);
    plant('probe', 1, process.pid);
    const battery = fakeRun({ batt: "Now drawing from 'Battery Power'\n\t50%;" });
    const seen: boolean[] = [];
    await locks
      .acquire('heavy', {
        root,
        waitMs: 80,
        pollMs: 20,
        platform: 'darwin',
        run: battery,
        log: () => seen.push(locks.heavyPending({ root })),
      })
      .catch(() => undefined);
    expect(seen.every((p) => p === false)).toBe(true);
    expect(locks.heavyPending({ root })).toBe(false);
  });

  it('holds a heavy job while it has blockers', async () => {
    const err = await locks
      .acquire('heavy', {
        root,
        waitMs: 50,
        pollMs: 10,
        log: () => {},
        platform: 'darwin',
        run: fakeRun({
          batt: "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t41%;",
        }),
      })
      .catch((e: unknown) => e);
    expect(String(err)).toContain('on battery (41%)');
    expect(locks.slotState(path.join(root, 'heavy-0'))).toBe('free');
  });
});

const AC =
  "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; AC attached; not charging";

function fakeRun({ batt = AC, ps = '' }: { batt?: string; ps?: string }) {
  return (cmd: string) => {
    if (cmd === 'pmset') return batt;
    if (cmd === 'ps') return ps;
    throw new Error(`unexpected ${cmd}`);
  };
}
const noBlockers = fakeRun({});

const HOME_CACHE = '/Users/user/.cache/bobble';
const PS = [
  '    1     0 /sbin/launchd',
  // the user's installed Bobble with a model loaded, through its helper.
  '  500     1 /Applications/Bobble.app/Contents/MacOS/Bobble',
  '  510   500 /Applications/Bobble.app/Contents/Frameworks/Bobble Helper.app/Contents/MacOS/Bobble Helper --type=utility',
  `  520   510 ${HOME_CACHE}/llamacpp/b10603/llama-server -m /Users/user/Bobble/Models/q.gguf --port 8080`,
  // An orphan from a probe that was SIGKILLed.
  `  600     1 ${HOME_CACHE}/llamacpp/b10603/llama-server -m x.gguf --port 8090`,
  // An orphan from a throwaway probe home's own cache.
  '  610     1 /var/folders/x/T/pd-home-foo-Ab12Cd/.cache/bobble/engines/rapid-mlx/venv/bin/rapid-mlx serve m',
  // A server someone started by hand: not ours, never touched.
  '  700     1 /opt/homebrew/bin/llama-server -m y.gguf',
  // A probe's app from a worktree, with its own server: busy, but not the user's.
  '  800   300 /Users/user/Desktop/OSS-harness/.claude/worktrees/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/user/Desktop/OSS-harness/.claude/worktrees/x/apps/desktop --user-data-dir=/var/folders/x/T/pd-probe-Qw12Er',
  `  810   800 ${HOME_CACHE}/llamacpp/b10603/llama-server -m z.gguf`,
  // A pip install from our venv is not a server.
  `  900     1 ${HOME_CACHE}/engines/rapid-mlx/venv/bin/python -m pip install x`,
].join('\n');

describe('processes', () => {
  it('finds orphaned model servers from our own cache roots only', () => {
    const rows = locks.parseProcessRows(PS);
    expect(locks.findOrphanServers(rows).map((r: { pid: number }) => r.pid)).toEqual([600, 610]);
  });

  it('agrees with the app reaper (reap-orphans.ts) on the same rows and roots', () => {
    const rows = reapParse(PS);
    expect(locks.parseProcessRows(PS)).toEqual(rows);
    const roots = [`${HOME_CACHE}/llamacpp`, `${HOME_CACHE}/engines`];
    const underRoot = (c: string) => roots.some((r) => c.includes(r));
    expect(locks.findOrphanServers(rows, { underRoot, self: 42 })).toEqual(
      orphanedServers(rows, roots, 42),
    );
  });

  it("knows the user's installed app and his dev checkout from a probe's app", () => {
    const main = '/Users/user/Desktop/OSS-harness';
    expect(locks.isUserAppCommand('/Applications/Bobble.app/Contents/MacOS/Bobble', main)).toBe(
      true,
    );
    const dev = `${main}/node_modules/.pnpm/electron@28.3.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`;
    expect(locks.isUserAppCommand(dev, main)).toBe(true);
    const probe = `${dev} --user-data-dir=/var/folders/ab/cd/T/pd-my-probe-Xy12Zz`;
    expect(locks.isUserAppCommand(probe, main)).toBe(false);
    const worktree = `${main}/.claude/worktrees/w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`;
    expect(locks.isUserAppCommand(worktree, main)).toBe(false);
    // Someone else's Electron app is not the user's Bobble.
    expect(locks.isUserAppCommand('/opt/other/Electron.app/Contents/MacOS/Electron .', main)).toBe(
      false,
    );
  });

  it('finds the main checkout from a worktree', () => {
    expect(locks.MAIN_CHECKOUT.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)).toBe(
      false,
    );
    expect(path.resolve(__dirname, '../../../..').startsWith(locks.MAIN_CHECKOUT)).toBe(true);
  });

  it("names every reason a heavy job must wait: battery, the user's app, orphans, busy", () => {
    plant('probe', 0, process.pid);
    plant('probe', 1, process.pid);
    const b = locks.heavyBlockers({
      root,
      platform: 'darwin',
      run: fakeRun({ batt: "Now drawing from 'Battery Power'\n\t12%;", ps: PS }),
    });
    expect(b.map((x: { kind: string }) => x.kind)).toEqual([
      'battery',
      'user-app',
      'orphans',
      'busy',
    ]);
    expect(b[1].pids).toEqual([520]);
    expect(b[2].pids).toEqual([600, 610]);
  });

  it('has nothing to say on AC with an idle machine', () => {
    expect(locks.heavyBlockers({ root, platform: 'darwin', run: noBlockers })).toEqual([]);
  });

  it('sweeps orphans with SIGTERM, then SIGKILL for whatever stays', async () => {
    const sent: string[] = [];
    const stubborn = new Set([610]);
    const pids = await locks.sweepOrphanServers({
      run: fakeRun({ ps: PS }),
      graceMs: 50,
      kill: (pid: number, sig: string) => {
        sent.push(`${sig} ${pid}`);
        if (sig === 'SIGKILL') stubborn.delete(pid);
      },
      alive: (pid: number) => stubborn.has(pid),
    });
    expect(pids).toEqual([600, 610]);
    expect(sent).toEqual(['SIGTERM 600', 'SIGTERM 610', 'SIGKILL 610']);
  });
});

describe('pacing a running heavy job', () => {
  const BATTERY = "Now drawing from 'Battery Power'\n\t38%; discharging;";
  // The job (900) → its model client (910) → the model server (920); 930 is a
  // sibling of the job's, never touched.
  const TREE = [
    '  900   1 bash run-all.sh',
    '  910 900 node omni-run.mjs',
    '  920 910 llama-server -m omni.gguf',
    '  930   1 node something-else.mjs',
  ].join('\n');

  it('reads the power source from pmset, and only on macOS', () => {
    expect(locks.onBattery({ platform: 'darwin', run: fakeRun({ batt: BATTERY }) })).toBe(true);
    expect(locks.onBattery({ platform: 'darwin', run: noBlockers })).toBe(false);
    expect(locks.onBattery({ platform: 'linux', run: fakeRun({ batt: BATTERY }) })).toBe(false);
  });

  it('finds a job and everything under it, parents first', () => {
    expect(locks.processTree(locks.parseProcessRows(TREE), 900)).toEqual([900, 910, 920]);
  });

  it('pauses the whole tree on battery and lets it go on at AC', () => {
    let batt = BATTERY;
    const sent: string[] = [];
    const pace = locks.paceHeavy(900, {
      platform: 'darwin',
      run: (cmd: string) => (cmd === 'pmset' ? batt : TREE),
      kill: (pid: number, sig: string) => sent.push(`${sig} ${pid}`),
      log: () => {},
      intervalMs: 60_000,
    });
    try {
      pace.tick();
      expect(pace.paused).toBe(true);
      expect(sent).toEqual(['SIGSTOP 920', 'SIGSTOP 910', 'SIGSTOP 900']);
      pace.tick(); // still on battery: nothing new
      expect(sent).toHaveLength(3);
      batt = AC;
      pace.tick();
      expect(pace.paused).toBe(false);
      expect(sent.slice(3)).toEqual(['SIGCONT 900', 'SIGCONT 910', 'SIGCONT 920']);
    } finally {
      pace.stop();
    }
  });

  it('never pauses on AC, and stop() lets a paused job go on so it can be ended', () => {
    const sent: string[] = [];
    const onAc = locks.paceHeavy(900, {
      platform: 'darwin',
      run: fakeRun({ ps: TREE }),
      kill: (pid: number, sig: string) => sent.push(`${sig} ${pid}`),
      log: () => {},
    });
    onAc.tick();
    onAc.stop();
    expect(sent).toEqual([]);

    const onBatt = locks.paceHeavy(900, {
      platform: 'darwin',
      run: fakeRun({ batt: BATTERY, ps: TREE }),
      kill: (pid: number, sig: string) => sent.push(`${sig} ${pid}`),
      log: () => {},
    });
    onBatt.tick();
    onBatt.stop();
    expect(sent.filter((x) => x.startsWith('SIGCONT'))).toEqual([
      'SIGCONT 900',
      'SIGCONT 910',
      'SIGCONT 920',
    ]);
  });
});

describe('lockStatus', () => {
  it('reports every class, its cap now, and its holders', () => {
    plant('heavy', 0, process.pid);
    const s = locks.lockStatus({ root, platform: 'darwin', run: noBlockers });
    expect(s.classes.heavy.slots[0]).toMatchObject({ state: 'held', pid: process.pid });
    expect(s.classes.probe.capNow).toBe(1);
    expect(s.classes.test.cap).toBe(6);
  });
});
