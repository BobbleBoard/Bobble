import { describe, expect, it, vi } from 'vitest';
import { orphanedServers, parseProcessRows, reapOrphanedServers } from './reap-orphans';

const ROOT = '/Users/user/.cache/pi-desktop/llamacpp/b9934/llama-b9934';

/* Real `ps -axo pid=,ppid=,command=` shape, from the session that motivated
 * this: three 6.5GB orphans left by closed app instances, one live server, and
 * unrelated processes that must never be touched. */
const PS = [
  ` 6199     1 ${ROOT}/llama-server -m /Users/user/.cache/pi-desktop/models/gemma.gguf`,
  `59322     1 ${ROOT}/llama-server -m /Users/user/.cache/pi-desktop/models/gemma.gguf`,
  `59479     1 ${ROOT}/llama-server -m /Users/user/.cache/pi-desktop/models/gemma.gguf`,
  `60888 60856 ${ROOT}/llama-server -m /Users/user/.cache/pi-desktop/models/gemma.gguf`,
  '60856     1 /Applications/Bobble.app/Contents/MacOS/Electron',
  '  501     1 /usr/sbin/cupsd',
  ' 7777     1 /opt/homebrew/bin/llama-server -m /Users/user/my-own/model.gguf',
].join('\n');

describe('parseProcessRows', () => {
  it('reads pid, ppid and the full command', () => {
    const rows = parseProcessRows(PS);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({ pid: 6199, ppid: 1 });
    expect(rows[0]?.command).toContain('llama-server');
  });

  it('ignores blank and malformed lines', () => {
    expect(parseProcessRows('\n\nnot a process line\n')).toEqual([]);
  });
});

describe('orphanedServers', () => {
  it('finds the servers whose owner is gone', () => {
    expect(orphanedServers(parseProcessRows(PS), ROOT).map((r) => r.pid)).toEqual([
      6199, 59322, 59479,
    ]);
  });

  /* THE important negative: a server owned by a LIVE app — a second window, or
   * a concurrent benchmark run — must survive. Killing it would take down a run
   * in progress, which is worse than the leak. */
  it('leaves a server with a living parent alone', () => {
    expect(orphanedServers(parseProcessRows(PS), ROOT).map((r) => r.pid)).not.toContain(60888);
  });

  it('never touches a llama-server the user started from their own build', () => {
    expect(orphanedServers(parseProcessRows(PS), ROOT).map((r) => r.pid)).not.toContain(7777);
  });

  it('treats a vanished parent as orphaned, not just ppid 1', () => {
    const rows = parseProcessRows(`4242 9999 ${ROOT}/llama-server -m x.gguf`);
    expect(orphanedServers(rows, ROOT).map((r) => r.pid)).toEqual([4242]);
  });

  it('cannot select the current process', () => {
    const rows = parseProcessRows(`${process.pid} 1 ${ROOT}/llama-server -m x.gguf`);
    expect(orphanedServers(rows, ROOT)).toEqual([]);
  });
});

describe('reapOrphanedServers', () => {
  it('kills exactly the orphans and reports them', () => {
    const killed: number[] = [];
    const stopped = reapOrphanedServers(ROOT, {
      ps: () => PS,
      kill: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([6199, 59322, 59479]);
    expect(stopped).toEqual([6199, 59322, 59479]);
  });

  /* This runs on the launch path: tidying up must never stop the app booting. */
  it('survives ps failing', () => {
    expect(
      reapOrphanedServers(ROOT, {
        ps: () => {
          throw new Error('ps unavailable');
        },
        kill: () => undefined,
      }),
    ).toEqual([]);
  });

  it('survives a kill failing, and still tries the rest', () => {
    const killed: number[] = [];
    const stopped = reapOrphanedServers(ROOT, {
      ps: () => PS,
      kill: (pid) => {
        if (pid === 6199) throw new Error('ESRCH');
        killed.push(pid);
      },
    });
    expect(killed).toEqual([59322, 59479]);
    expect(stopped).toEqual([59322, 59479]);
  });

  it('says nothing when there is nothing to reap', () => {
    const log = vi.fn();
    expect(reapOrphanedServers(ROOT, { ps: () => '', kill: () => undefined, log })).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
