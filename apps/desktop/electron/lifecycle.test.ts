import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findOrphans,
  orphanSignatures,
  parseProcessTable,
  quitReapers,
  reapRegisteredAtQuit,
  reapRegisteredOrphans,
  registerOrphanSignature,
  registerQuitReaper,
  resetLifecycleForTests,
} from './lifecycle';

afterEach(() => resetLifecycleForTests());

const PS = [
  '    1     0 /sbin/launchd',
  '  500     1 /Users/a/.cache/bobble/memory/venv/bin/hindsight-api --port 7777',
  '  501     1 /Users/a/.cache/bobble/memory/venv/bin/pip install hindsight',
  '  502   400 /Users/a/.cache/bobble/memory/venv/bin/hindsight-api --port 7778',
  '  503  9999 /Users/a/.cache/bobble/memory/pg0/bin/postgres -D db',
  '  504     1 /usr/local/bin/hindsight-api --port 1',
  '  400     1 /Applications/Bobble.app/Contents/MacOS/Bobble',
].join('\n');

const memoryApi = {
  id: 'memory-api',
  roots: () => ['/Users/a/.cache/bobble/memory'],
  matches: (c: string) => /\bhindsight-api\b/.test(c),
};
const postgres = {
  id: 'memory-postgres',
  roots: () => ['/Users/a/.cache/bobble/memory'],
  matches: (c: string) => /\/postgres\b/.test(c),
};

describe('quit reapers', () => {
  it('runs every registered teardown, and one that throws does not stop the rest', async () => {
    const ran: string[] = [];
    registerQuitReaper({ id: 'a', reap: () => void ran.push('a') });
    registerQuitReaper({
      id: 'b',
      reap: async () => {
        throw new Error('boom');
      },
    });
    registerQuitReaper({ id: 'c', reap: async () => void ran.push('c') });
    const log = vi.fn();
    const failed = await reapRegisteredAtQuit(log);
    expect(ran.sort()).toEqual(['a', 'c']);
    expect(failed).toEqual(['b']);
    expect(log).toHaveBeenCalledWith('quit reaper failed', expect.objectContaining({ id: 'b' }));
  });

  it('does nothing — and resolves at once — with nothing registered', async () => {
    expect(quitReapers()).toEqual([]);
    expect(await reapRegisteredAtQuit()).toEqual([]);
  });

  it('replaces by id, and an unregister only removes its own registration', () => {
    const first = registerQuitReaper({ id: 'svc', reap: () => {} });
    const second = { id: 'svc', reap: () => {} };
    registerQuitReaper(second);
    first(); // stale handle: must not remove the replacement
    expect(quitReapers()).toEqual([second]);
  });
});

describe('orphan signatures', () => {
  it('parses the process table', () => {
    const rows = parseProcessTable(PS);
    expect(rows).toHaveLength(7);
    expect(rows[1]).toEqual({
      pid: 500,
      ppid: 1,
      command: '/Users/a/.cache/bobble/memory/venv/bin/hindsight-api --port 7777',
    });
  });

  it('finds ours, orphaned, by root AND matcher — never a live child, never a stranger', () => {
    const found = findOrphans(parseProcessTable(PS), [memoryApi, postgres], 12345);
    expect(found.map((f) => [f.row.pid, f.signature])).toEqual([
      [500, 'memory-api'], // reparented to init
      [503, 'memory-postgres'], // parent gone from the table
    ]);
    // 501: ours, orphaned, but a pip install — the matcher says no.
    // 502: its parent (the app, pid 400) is alive.
    // 504: the same binary name outside our root.
  });

  it('never reaps itself', () => {
    expect(findOrphans(parseProcessTable(PS), [memoryApi], 500).map((f) => f.row.pid)).toEqual([]);
  });

  it('with no signature registered, the sweep does not even read ps', () => {
    const ps = vi.fn(() => PS);
    const kill = vi.fn();
    expect(orphanSignatures()).toEqual([]);
    expect(reapRegisteredOrphans({ ps, kill })).toEqual([]);
    expect(ps).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills what it found and reports it; a failed kill is skipped', () => {
    registerOrphanSignature(memoryApi);
    registerOrphanSignature(postgres);
    const kill = vi.fn((pid: number) => {
      if (pid === 503) throw new Error('ESRCH');
    });
    const log = vi.fn();
    const stopped = reapRegisteredOrphans({ ps: () => PS, kill, log });
    expect(stopped).toEqual([500]);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('reaped orphaned processes from a previous run', {
      by: { 'memory-api': [500] },
    });
  });

  it('survives a ps that fails', () => {
    registerOrphanSignature(memoryApi);
    expect(
      reapRegisteredOrphans({
        ps: () => {
          throw new Error('no ps');
        },
        kill: vi.fn(),
      }),
    ).toEqual([]);
  });
});
