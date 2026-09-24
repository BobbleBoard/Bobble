import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTailscaleStatus } from './tailscale';
import { notifyNeedsRefresh, runWithReconnect, sleep, statusDigest } from './watch';

const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'tailscale-status.fixture.json'),
  'utf8',
);

describe('notifyNeedsRefresh', () => {
  it('reads the two MEASURED first messages: state is news, traffic counters are not', () => {
    expect(notifyNeedsRefresh('{"Version":"1.102.4","SessionID":"877983","State":6}')).toBe(true);
    expect(
      notifyNeedsRefresh('{"Version":"1.102.4","Engine":{"RBytes":1,"WBytes":2,"NumLive":1}}'),
    ).toBe(false);
  });

  it('treats netmap, health, login and prefs changes as news', () => {
    for (const line of [
      '{"NetMap":{"Peers":[]}}',
      '{"Health":{"Warnings":{}}}',
      '{"LoginFinished":{}}',
      '{"Prefs":{"WantRunning":true}}',
      '{"BrowseToURL":"https://login.tailscale.com/a/x"}',
      '{"SomethingNewer":{"x":1}}',
    ]) {
      expect(notifyNeedsRefresh(line)).toBe(true);
    }
  });

  it('ignores empty fields, junk and non-objects', () => {
    for (const line of [
      '{"ErrMessage":null,"NetMap":null,"Version":"x"}',
      '{}',
      'nope',
      '[1]',
      '6',
    ]) {
      expect(notifyNeedsRefresh(line)).toBe(false);
    }
  });
});

describe('statusDigest', () => {
  it('is equal for equal statuses and different when a device changes', () => {
    const a = parseTailscaleStatus(FIXTURE);
    const b = parseTailscaleStatus(FIXTURE);
    expect(statusDigest(a)).toBe(statusDigest(b));
    const doc = JSON.parse(FIXTURE) as { Peer: Record<string, Record<string, unknown>> };
    for (const peer of Object.values(doc.Peer))
      if (peer.HostName === 'linux-ms-7e59') peer.Online = false;
    expect(statusDigest(parseTailscaleStatus(JSON.stringify(doc)))).not.toBe(statusDigest(a));
  });

  it('changes when an address, an owner’s name or the version changes', () => {
    const base = parseTailscaleStatus(FIXTURE);
    const d = statusDigest(base);
    const withV6 = {
      ...base,
      peers: base.peers.map((p) =>
        p.self ? p : { ...p, ips: [...p.ips, 'fd7a:115c:a1e0::ffff'] },
      ),
    };
    expect(statusDigest(withV6)).not.toBe(d);
    const renamed = {
      ...base,
      users: Object.fromEntries(
        Object.entries(base.users ?? {}).map(([k, u]) => [k, { ...u, displayName: 'The user' }]),
      ),
    };
    expect(statusDigest(renamed)).not.toBe(d);
    expect(statusDigest({ ...base, version: '1.104.0' })).not.toBe(d);
  });

  it('does not depend on peer order', () => {
    const s = parseTailscaleStatus(FIXTURE);
    expect(statusDigest({ ...s, peers: [...s.peers].reverse() })).toBe(statusDigest(s));
  });
});

describe('sleep', () => {
  it('ends early, without throwing, when aborted', async () => {
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 10);
    await sleep(5000, ctl.signal);
    expect(Date.now() - started).toBeLessThan(1000);
    await sleep(5000, ctl.signal); // already aborted: immediate
  });
});

describe('runWithReconnect', () => {
  it('reconnects at once after a healthy stream ends (the ~60 s idle close)', async () => {
    const ctl = new AbortController();
    const waits: number[] = [];
    const lines: string[] = [];
    let attempts = 0;
    await runWithReconnect(
      async (onLine) => {
        attempts += 1;
        onLine(`hello ${attempts}`);
        if (attempts === 3) ctl.abort();
        // …then the daemon closes the idle stream: resolve.
      },
      (l) => lines.push(l),
      {
        signal: ctl.signal,
        minBackoffMs: 5,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(attempts).toBe(3);
    expect(lines).toEqual(['hello 1', 'hello 2', 'hello 3']);
    // Each healthy end waits only the minimum.
    expect(waits).toEqual([5, 5]);
  });

  it('backs off, doubling to the cap, while connections fail without a word', async () => {
    const ctl = new AbortController();
    const waits: number[] = [];
    const ends: Array<{ attempt: number; lines: number; failed: boolean }> = [];
    let attempts = 0;
    await runWithReconnect(
      async (onLine) => {
        attempts += 1;
        if (attempts === 6) {
          onLine('back');
          ctl.abort();
          return;
        }
        throw new Error('ECONNREFUSED');
      },
      () => undefined,
      {
        signal: ctl.signal,
        minBackoffMs: 100,
        maxBackoffMs: 500,
        onConnectionEnd: (e) =>
          ends.push({ attempt: e.attempt, lines: e.lines, failed: e.error !== undefined }),
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(waits).toEqual([100, 200, 400, 500, 500]);
    expect(ends.every((e) => e.failed && e.lines === 0)).toBe(true);
  });

  it('resets the backoff once the stream works again', async () => {
    const ctl = new AbortController();
    const waits: number[] = [];
    let attempts = 0;
    await runWithReconnect(
      async (onLine) => {
        attempts += 1;
        if (attempts === 1 || attempts === 2) throw new Error('down');
        if (attempts === 3) {
          onLine('up');
          return;
        }
        if (attempts === 4) throw new Error('down again');
        ctl.abort();
      },
      () => undefined,
      {
        signal: ctl.signal,
        minBackoffMs: 10,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(waits).toEqual([10, 20, 10, 10]);
  });

  it('stops promptly when aborted mid-stream, without reporting an end', async () => {
    const ctl = new AbortController();
    let ended = 0;
    const run = runWithReconnect(
      (_onLine, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      () => undefined,
      { signal: ctl.signal, onConnectionEnd: () => (ended += 1) },
    );
    setTimeout(() => ctl.abort(), 10);
    await run;
    expect(ended).toBe(0);
  });
});
