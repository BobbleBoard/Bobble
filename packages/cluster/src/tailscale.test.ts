import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeHost, readTailnet } from './host';
import {
  CLUSTER_PORT,
  parseTailscaleStatus,
  peerUrl,
  probePeer,
  TAILSCALE_PATHS,
  type TailnetPeer,
} from './tailscale';

/*
 * A REAL capture from a real tailnet (keys and URLs stripped, shape and fields
 * intact): one macOS host, one Linux host that is online, two Macs that are not.
 * A hand-written fixture would agree with whatever the parser happens to do;
 * this one disagrees when Tailscale's output changes, which is the point.
 */
const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'tailscale-status.fixture.json'),
  'utf8',
);

describe('parseTailscaleStatus', () => {
  it('reads the real tailnet, self included', () => {
    const status = parseTailscaleStatus(FIXTURE);
    expect(status.available).toBe(true);
    const names = status.peers.map((p) => p.hostname);
    expect(names).toContain('linux-ms-7e59');
    expect(status.peers.filter((p) => p.self)).toHaveLength(1);
  });

  it('knows which machines are actually reachable', () => {
    const online = parseTailscaleStatus(FIXTURE).peers.filter((p) => p.online);
    // Self plus the Linux box; the two sleeping Macs are not scheduling targets.
    expect(online.map((p) => p.hostname).sort()).toEqual(
      ['My MacBook Pro', 'linux-ms-7e59'].sort(),
    );
  });

  it('carries the OS, because a scheduler has to know what it is talking to', () => {
    const linux = parseTailscaleStatus(FIXTURE).peers.find((p) => p.hostname === 'linux-ms-7e59');
    expect(linux?.os).toBe('linux');
    expect(linux?.ip).toMatch(/^100\./);
  });

  it('prefers the IPv4 tailnet address', () => {
    // Peers carry both; a v6-first pick would work everywhere except where it
    // does not, which is the worst kind of intermittent.
    for (const p of parseTailscaleStatus(FIXTURE).peers) expect(p.ip).toContain('.');
  });

  it('explains itself when Tailscale is present but not usable', () => {
    const s = parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin' }));
    expect(s.available).toBe(false);
    // The state IS the explanation, and the user can act on it.
    expect(s.reason).toContain('NeedsLogin');
    expect(s.peers).toEqual([]);
  });

  it('degrades rather than throwing on output it does not understand', () => {
    for (const junk of ['', 'not json', '{}', '{"BackendState":"Running","Peer":42}']) {
      expect(() => parseTailscaleStatus(junk)).not.toThrow();
    }
    // A running tailnet with an unreadable peer map still reports self-or-none,
    // never a crash — this runs on every cluster view.
    expect(parseTailscaleStatus('{"BackendState":"Running","Peer":42}').available).toBe(true);
  });

  it('drops a node with no usable address instead of inventing one', () => {
    const s = parseTailscaleStatus(
      JSON.stringify({ BackendState: 'Running', Peer: { a: { HostName: 'ghost' } } }),
    );
    expect(s.peers.map((p) => p.hostname)).not.toContain('ghost');
  });
});

describe('where the CLI lives', () => {
  it('looks inside the macOS app bundle, not just PATH', () => {
    // MEASURED: `which tailscale` fails on a Mac where Tailscale is running,
    // because the App Store build never puts it on PATH. Trusting PATH alone
    // reports "not installed" on a perfectly good machine.
    expect(TAILSCALE_PATHS.darwin?.[0]).toContain('Tailscale.app');
    expect(TAILSCALE_PATHS.darwin).toContain('tailscale');
  });

  it('knows the Windows and Linux locations too', () => {
    expect(TAILSCALE_PATHS.linux?.length ?? 0).toBeGreaterThan(0);
    expect(TAILSCALE_PATHS.win32?.some((p) => p.includes('.exe'))).toBe(true);
  });
});

describe('peerUrl', () => {
  it('brackets IPv6 so the URL is a URL', () => {
    expect(peerUrl('100.101.102.110')).toBe(`http://100.101.102.110:${CLUSTER_PORT}/cluster/hello`);
    expect(peerUrl('fd7a:115c:a1e0::1')).toBe(
      `http://[fd7a:115c:a1e0::1]:${CLUSTER_PORT}/cluster/hello`,
    );
  });
});

describe('probePeer', () => {
  const peer: TailnetPeer = {
    id: 'x',
    hostname: 'box',
    os: 'linux',
    ip: '100.101.102.110',
    online: true,
    self: false,
  };

  it('reports what the peer says it can do', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          version: '0.1.0',
          ramGB: 64,
          cpuCount: 16,
          accelerator: 'cuda',
          models: ['qwen3.5-9b'],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const caps = await probePeer(peer, { fetchImpl });
    expect(caps).toMatchObject({ reachable: true, ramGB: 64, accelerator: 'cuda' });
    expect(caps.models).toEqual(['qwen3.5-9b']);
  });

  it('treats an unreachable peer as ordinary, not exceptional', async () => {
    // Most machines on a tailnet are not running this app. That is the common
    // case, so it must be an answer rather than a thrown error.
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const caps = await probePeer(peer, { fetchImpl });
    expect(caps.reachable).toBe(false);
    expect(caps.error).toContain('ECONNREFUSED');
  });

  it('gives up quickly on a sleeping machine', async () => {
    const fetchImpl = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      })) as unknown as typeof fetch;
    const caps = await probePeer(peer, { fetchImpl, timeoutMs: 20 });
    expect(caps).toEqual({ reachable: false, error: 'timed out' });
  });

  it('ignores fields it does not recognise rather than passing them on', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ramGB: 'lots', surprise: true }), {
        status: 200,
      })) as unknown as typeof fetch;
    const caps = await probePeer(peer, { fetchImpl });
    expect(caps.reachable).toBe(true);
    expect(caps.ramGB).toBeUndefined();
  });
});

describe('readTailnet', () => {
  it('keeps trying locations instead of trusting the first', async () => {
    // The macOS bundle path is first for a reason, but a machine with the
    // Homebrew CLI and no app would report "not installed" if a single miss
    // ended the search.
    const tried: string[] = [];
    const status = await readTailnet({
      candidates: ['/nope/tailscale', '/also/nope', 'tailscale'],
      execFileImpl: async (file) => {
        tried.push(file);
        if (file !== 'tailscale') throw new Error('ENOENT');
        return { stdout: FIXTURE };
      },
    });
    expect(tried).toHaveLength(3);
    expect(status.available).toBe(true);
  });

  it('says what went wrong when nothing works', async () => {
    const status = await readTailnet({
      candidates: ['/nope'],
      execFileImpl: async () => {
        throw new Error('ENOENT: no such file');
      },
    });
    expect(status.available).toBe(false);
    expect(status.reason).toContain('ENOENT');
  });
});

describe('describeHost', () => {
  it('knows its own memory and cores on this platform', () => {
    const h = describeHost();
    expect(h.ramGB).toBeGreaterThan(0);
    expect(h.cpuCount).toBeGreaterThan(0);
    expect(h.hostname.length).toBeGreaterThan(0);
  });

  it("says 'unknown' rather than guessing when it has not looked for a GPU", () => {
    const h = describeHost();
    // "no accelerator" and "we did not check" schedule differently; conflating
    // them would send heavy work to a machine that cannot do it, or refuse a
    // machine that can.
    expect(['metal', 'cuda', 'rocm', 'cpu', 'unknown']).toContain(h.accelerator);
    if (process.platform !== 'darwin') expect(h.accelerator).toBe('unknown');
  });
});
