import { describe, expect, it } from 'vitest';
import {
  descendsFrom,
  type Listener,
  parseLsof,
  parsePs,
  type ServerProbe,
  serverStoppedText,
  withForegroundServerStop,
} from './foreground-server';

const ROOT = 100;

/** A bash stand-in: runs until its signal aborts (a server) or `ms` passes. */
function fakeBash(opts: { ms?: number; chatter?: number } = {}) {
  return {
    execute: (
      _id: string,
      _params: { command: string },
      signal: AbortSignal,
      onUpdate?: (u: unknown) => void,
    ) =>
      new Promise((resolve, reject) => {
        const talk =
          opts.chatter === undefined
            ? undefined
            : setInterval(() => onUpdate?.({ content: [] }), opts.chatter);
        const done = setTimeout(() => {
          if (talk) clearInterval(talk);
          resolve({ content: [{ type: 'text', text: 'ok' }] });
        }, opts.ms ?? 10_000);
        signal.addEventListener('abort', () => {
          clearTimeout(done);
          if (talk) clearInterval(talk);
          reject(new Error('Serving HTTP on :: port 8080 ...\n\nCommand aborted'));
        });
      }),
  };
}

/** The system as the probe reads it: before the command, and once it runs. */
function probe(listening: readonly Listener[], tree: Record<number, number>): ServerProbe {
  let calls = 0;
  return {
    listeners: async () => [...listening],
    // The first read is the "before" snapshot: only the root is alive.
    parents: async () => {
      calls += 1;
      const now: Record<number, number> = calls === 1 ? { [ROOT]: 1 } : { [ROOT]: 1, ...tree };
      return new Map(Object.entries(now).map(([k, v]) => [Number(k), v] as [number, number]));
    },
  };
}

const fast = { root: ROOT, graceMs: 5, everyMs: 5, quietMs: 15 };

describe('a foreground server is stopped once it is certain', () => {
  it('stops a quiet command whose own process listens, and says what to do instead', async () => {
    const tool = withForegroundServerStop(fakeBash(), {
      ...fast,
      probe: probe([{ pid: 201, port: '8080' }], { 200: ROOT, 201: 200 }),
    });
    const t0 = Date.now();
    const err = await (
      tool.execute(
        '1',
        { command: 'python3 -m http.server 8080' },
        new AbortController().signal,
      ) as Promise<unknown>
    ).catch((e: Error) => e);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(err).toBeInstanceOf(Error);
    const text = (err as Error).message;
    expect(text).toContain('Serving HTTP on :: port 8080');
    expect(text).toContain('listening on port 8080');
    expect(text).toContain('present opens the file itself');
    expect(text).toContain('background: true');
    expect(text).not.toContain('Command aborted');
  });

  it('leaves the same command alone the second time — the way through', async () => {
    const tool = withForegroundServerStop(fakeBash({ ms: 60 }), {
      ...fast,
      probe: probe([{ pid: 201, port: '8080' }], { 200: ROOT, 201: 200 }),
    });
    const signal = new AbortController().signal;
    await (tool.execute('1', { command: 'serve .' }, signal) as Promise<unknown>).catch(() => null);
    await expect(tool.execute('2', { command: 'serve .' }, signal)).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  it('does not stop a command that keeps printing (a test run with a port open)', async () => {
    const tool = withForegroundServerStop(fakeBash({ ms: 120, chatter: 5 }), {
      ...fast,
      probe: probe([{ pid: 201, port: '3000' }], { 200: ROOT, 201: 200 }),
    });
    await expect(
      tool.execute('1', { command: 'npm test' }, new AbortController().signal),
    ).resolves.toBeDefined();
  });

  it('ignores a port held by a process that was already running, or not its own', async () => {
    // Already alive before the command (a server started earlier in the background).
    const earlier = withForegroundServerStop(fakeBash({ ms: 80 }), {
      ...fast,
      probe: {
        listeners: async () => [{ pid: ROOT, port: '9000' }],
        parents: async () => new Map([[ROOT, 1]]),
      },
    });
    await expect(
      earlier.execute('1', { command: 'sleep 1' }, new AbortController().signal),
    ).resolves.toBeDefined();
    // Somebody else's server, not a descendant of this pi.
    const elsewhere = withForegroundServerStop(fakeBash({ ms: 80 }), {
      ...fast,
      probe: probe([{ pid: 999, port: '5432' }], { 200: ROOT, 999: 1 }),
    });
    await expect(
      elsewhere.execute('1', { command: 'sleep 1' }, new AbortController().signal),
    ).resolves.toBeDefined();
  });

  it('a Stop from the person stays a Stop', async () => {
    const tool = withForegroundServerStop(fakeBash(), {
      ...fast,
      graceMs: 10_000,
      probe: probe([], {}),
    });
    const user = new AbortController();
    const running = tool.execute('1', { command: 'sleep 100' }, user.signal) as Promise<unknown>;
    setTimeout(() => user.abort(), 5);
    await expect(running).rejects.toThrow(/Command aborted/);
  });
});

describe('reading the system', () => {
  it('parses lsof -Fpn and ps', () => {
    expect(parseLsof('p201\nf5\nn*:8080\nf6\nn[::1]:8080\np300\nn127.0.0.1:5173\n')).toEqual([
      { pid: 201, port: '8080' },
      { pid: 300, port: '5173' },
    ]);
    expect(parsePs('  100     1\n  200   100\n')).toEqual(
      new Map([
        [100, 1],
        [200, 100],
      ]),
    );
    const parents = new Map([
      [201, 200],
      [200, 100],
      [100, 1],
    ]);
    expect(descendsFrom(201, 100, parents)).toBe(true);
    expect(descendsFrom(100, 201, parents)).toBe(false);
    expect(serverStoppedText('', '8080')).toMatch(/^Stopped: this command started a server/);
  });
});
