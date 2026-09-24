import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeHost, readTailnet, type TailscaleExecOptions, tailscaleCliEnv } from './host';
import {
  buildHello,
  CLUSTER_PORT,
  NODE_PROTOCOL,
  type NodeHello,
  parseHello,
  parseInfo,
  parseTailscaleStatus,
  peerUrl,
  probePeer,
  protocolCompat,
  sameUserPeers,
  TAILSCALE_PATHS,
  type TailnetPeer,
  timeField,
} from './tailscale';

/*
 * A REAL capture from a real tailnet (refreshed 2026-09-23 from Tailscale
 * 1.102.4 under `env -i … TAILSCALE_BE_CLI=1`; endpoints, keys, the tailnet
 * name, DNS suffix and login redacted, every field the parser reads intact):
 * one macOS host, one Linux host that is online on a direct LAN path, two Macs
 * that are not — one of them with an expired key. A hand-written fixture would
 * agree with whatever the parser happens to do; this one disagrees when
 * Tailscale's output changes, which is the point.
 */
const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'tailscale-status.fixture.json'),
  'utf8',
);

/** The real capture, edited — for shapes the user's tailnet does not have (tags, shares, v6-only). */
function withPeers(extra: Record<string, unknown>): string {
  const doc = JSON.parse(FIXTURE) as { Peer: Record<string, unknown> };
  doc.Peer = { ...doc.Peer, ...extra };
  return JSON.stringify(doc);
}

const ME = '3240365473728001';

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
    for (const junk of ['', 'not json', '{}', '{"BackendState":"Running","Peer":42}', '[]', '7']) {
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

describe('parseTailscaleStatus — the fields the Devices list needs', () => {
  const status = parseTailscaleStatus(FIXTURE);
  const self = status.peers.find((p) => p.self);
  const linux = status.peers.find((p) => p.hostname === 'linux-ms-7e59');
  const parents = status.peers.filter((p) => p.hostname === 'Parent’s MacBook Pro');

  it('reports the state, version and tailnet', () => {
    expect(status.state).toBe('Running');
    expect(status.version).toMatch(/^1\.102\.4/);
    expect(status.tailnet).toEqual({
      name: 'example.github',
      magicDnsSuffix: 'tail0f0f0f.ts.net',
      magicDnsEnabled: true,
    });
  });

  it('knows who owns this machine, and every user it mentions', () => {
    expect(status.selfUserId).toBe(ME);
    expect(status.users?.[ME]).toEqual({
      id: ME,
      loginName: 'someone@github',
      displayName: 'Someone',
    });
    for (const p of status.peers) expect(p.userId).toBe(ME);
  });

  it('keeps the MagicDNS name without the trailing dot', () => {
    // Tailscale writes the FQDN with a trailing dot; a Host header never has one.
    expect(linux?.dnsName).toBe('linux-ms-7e59.tail0f0f0f.ts.net');
    expect(self?.dnsName).toBe('my-macbook-pro.tail0f0f0f.ts.net');
  });

  it('tells a direct path from a relayed one', () => {
    // MEASURED: the Linux box is reached over the LAN (CurAddr set), home DERP lax.
    expect(linux?.curAddr).toBe('192.168.1.33:41641');
    expect(linux?.relay).toBe('lax');
    expect(linux?.active).toBe(true);
    // An offline Mac has no current address: no path at all right now.
    for (const p of parents) expect(p.curAddr).toBeUndefined();
    expect(linux?.peerRelay).toBeUndefined();
  });

  it('reads an online peer’s zero LastSeen as absent, and an offline one as a date', () => {
    // MEASURED: online peers report "0001-01-01T00:00:00Z" — "never", not year 1.
    expect(linux?.lastSeen).toBeUndefined();
    expect(self?.lastSeen).toBeUndefined();
    expect(parents.map((p) => p.lastSeen).sort()).toEqual([
      '2026-04-23T01:10:15.100Z',
      '2026-04-28T17:10:10.100Z',
    ]);
  });

  it('flags the Mac whose key expired, and only that one', () => {
    const expired = parents.filter((p) => p.expired);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.keyExpiry).toBe('2026-09-13T05:58:31.000Z');
    const other = parents.find((p) => !p.expired);
    expect(other?.keyExpiry).toBe('2026-10-25T15:04:34.000Z');
    expect(linux?.expired).toBe(false);
  });

  it('keeps every tailnet address, v4 first', () => {
    expect(linux?.ips).toEqual(['100.101.102.110', 'fd7a:115c:a1e0::ab12:cd40']);
  });

  it('reads tags and shared-in nodes, which are nobody’s own device', () => {
    const s = parseTailscaleStatus(
      withPeers({
        'nodekey:t': {
          ID: 'nTAG',
          HostName: 'build-box',
          OS: 'linux',
          TailscaleIPs: ['100.64.0.9'],
          UserID: 123,
          Tags: ['tag:server', 'tag:gpu'],
          Online: true,
        },
        'nodekey:s': {
          ID: 'nSHARE',
          HostName: 'friends-mac',
          OS: 'macOS',
          TailscaleIPs: ['100.64.0.10'],
          UserID: 456,
          ShareeNode: true,
          Online: true,
        },
      }),
    );
    const tagged = s.peers.find((p) => p.id === 'nTAG');
    expect(tagged?.tags).toEqual(['tag:server', 'tag:gpu']);
    expect(tagged?.sharee).toBe(false);
    const shared = s.peers.find((p) => p.id === 'nSHARE');
    expect(shared?.sharee).toBe(true);
    expect(shared?.tags).toEqual([]);
  });

  it('keeps a user id past 2^53 exact, so two owners never merge', () => {
    // As numbers these two ids are EQUAL (2^53 + 1 rounds to 2^53). A trust
    // rule comparing owners must not be fooled by float rounding.
    const s = parseTailscaleStatus(
      '{"BackendState":"Running","Self":{"ID":"nA","HostName":"me","TailscaleIPs":["100.64.0.1"],"UserID":9007199254740993},' +
        '"Peer":{"k":{"ID":"nB","HostName":"them","TailscaleIPs":["100.64.0.2"],"UserID":9007199254740992,"Online":true}}}',
    );
    expect(s.selfUserId).toBe('9007199254740993');
    expect(s.peers.find((p) => p.id === 'nB')?.userId).toBe('9007199254740992');
    expect(sameUserPeers(s)).toEqual([]);
  });

  it('uses the IPv6 address for a node that has no IPv4 one', () => {
    const s = parseTailscaleStatus(
      withPeers({
        'nodekey:v6': {
          ID: 'nV6',
          HostName: 'v6-only',
          OS: 'linux',
          TailscaleIPs: ['fd7a:115c:a1e0::1234'],
          Online: true,
        },
      }),
    );
    const v6 = s.peers.find((p) => p.id === 'nV6');
    expect(v6?.ip).toBe('fd7a:115c:a1e0::1234');
    expect(peerUrl(v6?.ip ?? '')).toBe(
      `http://[fd7a:115c:a1e0::1234]:${CLUSTER_PORT}/cluster/hello`,
    );
  });

  it('passes health warnings through verbatim', () => {
    const doc = JSON.parse(FIXTURE) as Record<string, unknown>;
    doc.Health = ['Tailscale can’t reach the configured DNS servers.'];
    expect(parseTailscaleStatus(JSON.stringify(doc)).health).toEqual([
      'Tailscale can’t reach the configured DNS servers.',
    ]);
    // None on the real capture: the field is absent rather than an empty list.
    expect(parseTailscaleStatus(FIXTURE).health).toBeUndefined();
  });

  it('carries the sign-in link and the exact state when Tailscale is waiting', () => {
    const s = parseTailscaleStatus(
      JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc' }),
    );
    expect(s.state).toBe('NeedsLogin');
    expect(s.authUrl).toBe('https://login.tailscale.com/a/abc');
    for (const state of ['Stopped', 'NeedsMachineAuth', 'Starting', 'NoState']) {
      expect(parseTailscaleStatus(JSON.stringify({ BackendState: state })).state).toBe(state);
    }
    expect(parseTailscaleStatus('{"BackendState":"Sideways"}').state).toBe('Unknown');
    expect(parseTailscaleStatus('not json').state).toBe('Unknown');
  });
});

describe('timeField', () => {
  it('reads Go’s zero time, empty and junk as absent', () => {
    expect(timeField('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(timeField('')).toBeUndefined();
    expect(timeField('yesterday')).toBeUndefined();
    expect(timeField(42)).toBeUndefined();
    // Nanoseconds and offsets, as Tailscale writes them.
    expect(timeField('2026-09-22T17:33:51.080303959-07:00')).toBe('2026-09-23T00:33:51.080Z');
  });
});

describe('sameUserPeers', () => {
  it('lists this user’s other devices on the real tailnet', () => {
    const peers = sameUserPeers(parseTailscaleStatus(FIXTURE));
    expect(peers.map((p) => p.hostname).sort()).toEqual(
      ['Parent’s MacBook Pro', 'Parent’s MacBook Pro', 'linux-ms-7e59'].sort(),
    );
    expect(peers.some((p) => p.self)).toBe(false);
  });

  it('never includes another user’s, a tagged, or a shared-in device', () => {
    const s = parseTailscaleStatus(
      withPeers({
        a: { ID: 'nOTHER', HostName: 'sisters-pc', TailscaleIPs: ['100.64.1.1'], UserID: 77 },
        b: {
          ID: 'nTAG',
          HostName: 'rack',
          TailscaleIPs: ['100.64.1.2'],
          UserID: Number(ME),
          Tags: ['tag:server'],
        },
        c: {
          ID: 'nSHARE',
          HostName: 'shared-in',
          TailscaleIPs: ['100.64.1.3'],
          UserID: Number(ME),
          ShareeNode: true,
        },
      }),
    );
    const ids = sameUserPeers(s).map((p) => p.id);
    expect(ids).not.toContain('nOTHER');
    expect(ids).not.toContain('nTAG');
    expect(ids).not.toContain('nSHARE');
    expect(ids).toContain('nbYS7qLqVy11CNTRL');
  });

  it('knows no one when it cannot tell who this machine belongs to', () => {
    expect(sameUserPeers({ available: false, peers: [] })).toEqual([]);
    const doc = JSON.parse(FIXTURE) as { Self: Record<string, unknown> };
    delete doc.Self.UserID;
    expect(sameUserPeers(parseTailscaleStatus(JSON.stringify(doc)))).toEqual([]);
  });

  it('gives a tagged machine no "own devices" at all', () => {
    const doc = JSON.parse(FIXTURE) as { Self: Record<string, unknown> };
    doc.Self.Tags = ['tag:server'];
    expect(sameUserPeers(parseTailscaleStatus(JSON.stringify(doc)))).toEqual([]);
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

  it('spells the Windows paths the way Windows does', () => {
    // The old literal evaluated to `C\:\\Program Files\\…`: not a path.
    expect(TAILSCALE_PATHS.win32).toEqual([
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
      'tailscale.exe',
    ]);
    expect(TAILSCALE_PATHS.win32?.[0]).toBe(String.raw`C:\Program Files\Tailscale\tailscale.exe`);
    for (const p of TAILSCALE_PATHS.win32?.slice(0, 2) ?? []) {
      expect(path.win32.isAbsolute(p)).toBe(true);
      expect(path.win32.basename(p)).toBe('tailscale.exe');
      expect(path.win32.dirname(p)).toMatch(/^C:\\Program Files( \(x86\))?\\Tailscale$/);
    }
  });
});

describe('peerUrl', () => {
  it('brackets IPv6 so the URL is a URL', () => {
    expect(peerUrl('100.101.102.110')).toBe(`http://100.101.102.110:${CLUSTER_PORT}/cluster/hello`);
    expect(peerUrl('fd7a:115c:a1e0::1')).toBe(
      `http://[fd7a:115c:a1e0::1]:${CLUSTER_PORT}/cluster/hello`,
    );
  });

  it('takes another port for a second instance on one machine', () => {
    expect(peerUrl('127.0.0.1', '/cluster/hello', 18765)).toBe(
      'http://127.0.0.1:18765/cluster/hello',
    );
  });
});

const HELLO: NodeHello = {
  app: 'bobble',
  protocol: NODE_PROTOCOL,
  version: '0.9.0',
  id: 'dev_abc',
  name: 'linux-ms-7e59',
  os: 'linux',
  sharing: true,
  pairing: 'auto',
};

describe('the public hello', () => {
  it('is built from exactly eight fields, whatever the caller spreads in', () => {
    const leaky = { ...HELLO, ramGB: 64, models: ['qwen3.5-9b'], token: 'secret' };
    const hello = buildHello(leaky);
    expect(Object.keys(hello).sort()).toEqual(
      ['app', 'id', 'name', 'os', 'pairing', 'protocol', 'sharing', 'version'].sort(),
    );
    expect(hello).toEqual(HELLO);
  });

  it('reads a Bobble hello and drops anything it should not carry', () => {
    const parsed = parseHello({ ...HELLO, ramGB: 64, accelerator: 'cuda', models: ['x'] });
    expect(parsed).toEqual(HELLO);
  });

  it('says "not a Bobble" for anything else on the port', () => {
    // AnkiConnect's default port is also 8765.
    expect(parseHello({ apiVersion: 'AnkiConnect v.6' })).toBeNull();
    expect(parseHello({ ...HELLO, app: 'other' })).toBeNull();
    expect(parseHello({ ...HELLO, pairing: 'open-to-all' })).toBeNull();
    expect(parseHello({ ...HELLO, protocol: 1.5 })).toBeNull();
    expect(parseHello({ ...HELLO, sharing: 'yes' })).toBeNull();
    expect(parseHello({ ...HELLO, name: 'x'.repeat(1000) })).toBeNull();
    expect(parseHello(null)).toBeNull();
    expect(parseHello('bobble')).toBeNull();
  });

  it('knows which side needs an update when protocols differ', () => {
    expect(protocolCompat(HELLO)).toBe('ok');
    expect(protocolCompat({ protocol: NODE_PROTOCOL + 1 })).toBe('peer-newer');
    expect(protocolCompat({ protocol: NODE_PROTOCOL - 1 })).toBe('peer-older');
  });
});

describe('the authenticated info', () => {
  const INFO = {
    id: 'dev_abc',
    name: 'linux-ms-7e59',
    version: '0.9.0',
    protocol: 1,
    os: 'linux',
    hardware: {
      platform: 'linux',
      arch: 'x64',
      ramGB: 64,
      cpuCount: 16,
      chip: 'AMD Ryzen 9',
      accelerator: 'cuda',
      vramGB: 24,
    },
    engines: [{ id: 'llamacpp', ready: true }, { id: 'vllm' }, { nope: 1 }],
    models: [{ id: 'qwen3.6-27b', name: 'Qwen3.6 27B' }, { id: 'qwen3.5-9b' }, 'junk'],
    loaded: {
      modelId: 'qwen3.6-27b',
      servedModelId: 'qwen3.6-27b-q4',
      provider: 'llamacpp',
      contextWindow: 65536,
      vision: true,
    },
    tiers: { fast: 'qwen3.5-9b', max: 'qwen3.6-27b', bad: 7 },
    gen: { image: ['flux2-klein'], video: 'not-a-list' },
    sharing: { slots: 2, scopes: { chat: true, generate: true } },
  };

  it('reads what a node can do', () => {
    const info = parseInfo(INFO);
    expect(info?.hardware).toEqual(INFO.hardware);
    expect(info?.engines).toEqual([
      { id: 'llamacpp', ready: true },
      { id: 'vllm', ready: false },
    ]);
    expect(info?.models).toEqual([
      { id: 'qwen3.6-27b', name: 'Qwen3.6 27B' },
      { id: 'qwen3.5-9b' },
    ]);
    expect(info?.loaded).toEqual(INFO.loaded);
    expect(info?.tiers).toEqual({ fast: 'qwen3.5-9b', max: 'qwen3.6-27b' });
    expect(info?.gen).toEqual({ image: ['flux2-klein'], video: [], audio: [], '3d': [] });
  });

  it('reads an absent scope as not granted', () => {
    expect(parseInfo(INFO)?.sharing).toEqual({
      slots: 2,
      scopes: { chat: true, generate: true, manage: false },
    });
  });

  it('refuses a body that does not say which node it is', () => {
    expect(parseInfo({ ...INFO, id: undefined })).toBeNull();
    expect(parseInfo({ ...INFO, protocol: 'one' })).toBeNull();
    expect(parseInfo(null)).toBeNull();
  });

  it('degrades a half-understood capacity block instead of failing the read', () => {
    const info = parseInfo({
      ...INFO,
      hardware: 'huge',
      loaded: { modelId: 'x', provider: 'tpu' },
    });
    expect(info?.hardware).toEqual({
      platform: 'unknown',
      arch: 'unknown',
      ramGB: 0,
      cpuCount: 0,
      accelerator: 'unknown',
    });
    expect(info?.loaded).toBeUndefined();
  });
});

describe('probePeer', () => {
  const peer: TailnetPeer = {
    id: 'x',
    hostname: 'box',
    os: 'linux',
    ip: '100.101.102.110',
    ips: ['100.101.102.110'],
    online: true,
    self: false,
    active: true,
    expired: false,
    tags: [],
    sharee: false,
  };

  it('reports the peer’s hello, how long it took, and whether we can talk', async () => {
    const urls: string[] = [];
    let t = 1000;
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      t += 11;
      return new Response(JSON.stringify(HELLO), { status: 200 });
    }) as unknown as typeof fetch;
    const probe = await probePeer(peer, { fetchImpl, now: () => t });
    expect(probe).toEqual({ reachable: true, hello: HELLO, compat: 'ok', rttMs: 11 });
    expect(urls).toEqual([`http://100.101.102.110:${CLUSTER_PORT}/cluster/hello`]);
  });

  it('does not take hardware or models from a hello', async () => {
    // The pre-split probe returned RAM, accelerator and model list from the
    // UNAUTHENTICATED route; they live behind a token now (NodeInfo).
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ...HELLO, ramGB: 64, accelerator: 'cuda', models: ['m'] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const probe = await probePeer(peer, { fetchImpl });
    expect(probe.reachable).toBe(true);
    if (probe.reachable) expect(probe.hello).toEqual(HELLO);
  });

  it('calls a pre-split, non-Bobble or non-JSON answer "not a Bobble"', async () => {
    for (const body of [
      JSON.stringify({ version: '0.1.0', ramGB: 64, models: ['qwen3.5-9b'] }),
      'AnkiConnect',
    ]) {
      const fetchImpl = (async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch;
      const probe = await probePeer(peer, { fetchImpl });
      expect(probe).toMatchObject({ reachable: false, kind: 'not-bobble' });
    }
  });

  it('treats an unreachable peer as ordinary, not exceptional', async () => {
    // Most machines on a tailnet are not running this app. That is the common
    // case, so it must be an answer rather than a thrown error.
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const probe = await probePeer(peer, { fetchImpl });
    expect(probe.reachable).toBe(false);
    if (!probe.reachable) {
      expect(probe.kind).toBe('network');
      expect(probe.error).toContain('ECONNREFUSED');
    }
  });

  it('reports an HTTP refusal as such', async () => {
    const fetchImpl = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
    expect(await probePeer(peer, { fetchImpl })).toEqual({
      reachable: false,
      kind: 'http',
      error: 'HTTP 503',
    });
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
    const probe = await probePeer(peer, { fetchImpl, timeoutMs: 20 });
    expect(probe).toEqual({ reachable: false, kind: 'timeout', error: 'timed out' });
  });

  it('knocks on another port when told to', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(HELLO), { status: 200 });
    }) as unknown as typeof fetch;
    await probePeer({ ip: '127.0.0.1' }, { fetchImpl, port: 18765 });
    expect(urls).toEqual(['http://127.0.0.1:18765/cluster/hello']);
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

  it('forces CLI mode on every spawn, even from an environment with no terminal', async () => {
    // A Finder-launched app has no TERM/SHLVL/PS1, which is exactly when the
    // macOS app binary would otherwise decide to be the GUI.
    const seen: TailscaleExecOptions[] = [];
    await readTailnet({
      candidates: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
      env: { HOME: '/Users/someone', PATH: '/usr/bin:/bin' },
      execFileImpl: async (_file, _args, opts) => {
        seen.push(opts ?? {});
        return { stdout: FIXTURE };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.env).toEqual({
      HOME: '/Users/someone',
      PATH: '/usr/bin:/bin',
      TAILSCALE_BE_CLI: '1',
    });
    expect(seen[0]?.env?.TERM).toBeUndefined();
    expect(seen[0]?.windowsHide).toBe(true);
    expect(seen[0]?.timeout).toBe(5000);
  });

  it('forces CLI mode on top of the process environment by default', async () => {
    let env: NodeJS.ProcessEnv | undefined;
    await readTailnet({
      candidates: ['tailscale'],
      execFileImpl: async (_file, _args, opts) => {
        env = opts?.env;
        return { stdout: FIXTURE };
      },
    });
    expect(env?.TAILSCALE_BE_CLI).toBe('1');
    expect(env?.PATH).toBe(process.env.PATH);
    expect(tailscaleCliEnv({ TAILSCALE_BE_CLI: '0' }).TAILSCALE_BE_CLI).toBe('1');
  });

  it('tells "not installed" from "installed but not answering"', async () => {
    const missing = Object.assign(new Error('spawn /nope ENOENT'), { code: 'ENOENT' });
    const notInstalled = await readTailnet({
      candidates: ['/a', '/b'],
      execFileImpl: async () => {
        throw missing;
      },
    });
    expect(notInstalled.state).toBe('NotInstalled');

    const notRunning = await readTailnet({
      candidates: ['/app-binary', '/missing'],
      execFileImpl: async (file) => {
        if (file === '/missing') throw missing;
        throw Object.assign(new Error('failed to connect to local Tailscale service'), { code: 1 });
      },
    });
    expect(notRunning.state).toBe('NotRunning');
    expect(notRunning.reason).toContain('failed to connect');
  });

  it('carries a stopped daemon’s own state through', async () => {
    const status = await readTailnet({
      candidates: ['tailscale'],
      execFileImpl: async () => ({ stdout: JSON.stringify({ BackendState: 'Stopped' }) }),
    });
    expect(status.state).toBe('Stopped');
    expect(status.available).toBe(false);
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
