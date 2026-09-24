import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  describePing,
  parseGoDurationMs,
  parsePingJson,
  parsePingOutput,
  stripGoLogPrefix,
} from './ping-parse';

/* The LocalAPI's answer for a direct LAN ping, captured on this Mac (LAN address redacted). */
const PING_JSON = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'tailscale-ping.fixture.json'),
    'utf8',
  ),
) as unknown;

describe('parseGoDurationMs', () => {
  it('reads what time.Duration prints', () => {
    expect(parseGoDurationMs('9ms')).toBe(9);
    expect(parseGoDurationMs('1.2s')).toBe(1200);
    expect(parseGoDurationMs('1m2.5s')).toBe(62_500);
    expect(parseGoDurationMs('850µs')).toBeCloseTo(0.85);
    expect(parseGoDurationMs('0s')).toBe(0);
    expect(parseGoDurationMs('0')).toBe(0);
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'ms', '9', '9 ms', '9msx', 'fast']) {
      expect(parseGoDurationMs(bad)).toBeUndefined();
    }
  });
});

describe('parsePingOutput (the CLI)', () => {
  it('reads a direct LAN pong — MEASURED', () => {
    expect(
      parsePingOutput(
        'pong from linux-ms-7e59 (100.101.102.110) via 192.168.1.33:41641 in 9ms\n',
        '',
        0,
      ),
    ).toEqual({
      ok: true,
      latencyMs: 9,
      path: 'direct',
      endpoint: '192.168.1.33:41641',
      nodeName: 'linux-ms-7e59',
      nodeIp: '100.101.102.110',
    });
  });

  it('reads a DERP-relayed pong', () => {
    expect(
      parsePingOutput('pong from box (100.64.0.2) via DERP(nue) in 46ms', '', 0),
    ).toMatchObject({
      ok: true,
      path: 'derp',
      derpRegion: 'nue',
      latencyMs: 46,
    });
  });

  it('reads a peer-relay pong, with the peerapi port in the parentheses', () => {
    expect(
      parsePingOutput(
        'pong from box (100.64.0.2, 41000) via peer-relay(203.0.113.5:7777:vni:3) in 20ms',
        '',
        0,
      ),
    ).toMatchObject({
      ok: true,
      path: 'peer-relay',
      peerRelay: '203.0.113.5:7777:vni:3',
      nodeIp: '100.64.0.2',
    });
  });

  it('reads an IPv6 direct endpoint', () => {
    expect(
      parsePingOutput('pong from box (fd7a:115c:a1e0::1) via [2001:db8::5]:41641 in 3ms', '', 0),
    ).toMatchObject({ ok: true, path: 'direct', endpoint: '[2001:db8::5]:41641' });
  });

  it('takes the last pong when the path improves (--until-direct)', () => {
    const out = [
      'pong from box (100.64.0.2) via DERP(lax) in 40ms',
      'pong from box (100.64.0.2) via 192.168.1.9:41641 in 4ms',
    ].join('\n');
    expect(parsePingOutput(out, '', 0)).toMatchObject({ path: 'direct', latencyMs: 4 });
  });

  it('calls a protocol-only "via" unknown rather than direct', () => {
    expect(parsePingOutput('pong from box (100.64.0.2) via TSMP in 5ms', '', 0)).toMatchObject({
      ok: true,
      path: 'unknown',
    });
  });

  it('reads a timeout — MEASURED: "timed out" on stdout, "no reply" on stderr, exit 1', () => {
    expect(
      parsePingOutput('ping "100.101.102.121" timed out\n', '2026/09/23 18:17:20 no reply\n', 1),
    ).toEqual({ ok: false, reason: 'timeout', detail: 'ping "100.101.102.121" timed out' });
  });

  it('reads an expired key — MEASURED', () => {
    expect(parsePingOutput('', "2026/09/23 18:17:09 peer's node key has expired\n", 1)).toEqual({
      ok: false,
      reason: 'key-expired',
      detail: "peer's node key has expired",
    });
  });

  it('reads this machine’s own address — MEASURED', () => {
    expect(parsePingOutput('100.101.102.103 is local Tailscale IP\n', '', 0)).toMatchObject({
      ok: false,
      reason: 'local',
    });
  });

  it('reads "no reply" alone, a missing peer, and a daemon that is not there', () => {
    expect(parsePingOutput('', 'no reply', 1)).toMatchObject({ reason: 'no-reply' });
    expect(parsePingOutput('', '2026/09/23 18:17:09 no matching peer', 1)).toMatchObject({
      reason: 'not-found',
    });
    expect(
      parsePingOutput('', 'failed to connect to local Tailscale daemon; not running?', 1),
    ).toMatchObject({ reason: 'error' });
    expect(parsePingOutput('', '', null)).toMatchObject({ reason: 'error' });
  });
});

describe('parsePingJson (the LocalAPI)', () => {
  it('reads the captured direct ping', () => {
    const r = parsePingJson(PING_JSON);
    expect(r).toMatchObject({
      ok: true,
      path: 'direct',
      endpoint: '192.168.1.33:41641',
      nodeName: 'linux-ms-7e59',
    });
    if (r.ok) expect(r.latencyMs).toBeCloseTo(7.139333, 5);
  });

  it('prefers a peer relay, then DERP, then the endpoint — the CLI’s order', () => {
    expect(
      parsePingJson({ LatencySeconds: 0.02, Endpoint: '1.2.3.4:5', PeerRelay: '9.9.9.9:1:vni:2' }),
    ).toMatchObject({ path: 'peer-relay', peerRelay: '9.9.9.9:1:vni:2' });
    expect(
      parsePingJson({ LatencySeconds: 0.046, DERPRegionID: 17, DERPRegionCode: 'lax' }),
    ).toMatchObject({ path: 'derp', derpRegion: 'lax', latencyMs: 46 });
  });

  it('reads the errors — MEASURED expired key', () => {
    expect(
      parsePingJson({ IP: '100.101.102.120', Err: "peer's node key has expired", LatencySeconds: 0 }),
    ).toMatchObject({ ok: false, reason: 'key-expired' });
    expect(
      parsePingJson({ Err: '100.101.102.103 is local Tailscale IP', IsLocalIP: true }),
    ).toMatchObject({
      ok: false,
      reason: 'local',
    });
    expect(parsePingJson({ Err: 'no matching peer' })).toMatchObject({ reason: 'not-found' });
    expect(parsePingJson(null)).toMatchObject({ ok: false, reason: 'error' });
    expect(parsePingJson({ LatencySeconds: 'fast' })).toMatchObject({ ok: false, reason: 'error' });
  });
});

describe('describePing — the words the Devices row uses', () => {
  it('names the path and the time', () => {
    expect(describePing({ ok: true, latencyMs: 8.2, path: 'direct' })).toBe('direct · 8 ms');
    expect(describePing({ ok: true, latencyMs: 46, path: 'derp', derpRegion: 'lax' })).toBe(
      'relayed via DERP (lax) · 46 ms',
    );
    expect(describePing({ ok: false, reason: 'timeout', detail: '' })).toBe(
      'no reply: the device may be asleep',
    );
    expect(describePing({ ok: false, reason: 'key-expired', detail: '' })).toContain('key expired');
  });
});

describe('stripGoLogPrefix', () => {
  it('drops the log timestamp and blank lines', () => {
    expect(stripGoLogPrefix('2026/09/23 18:17:20 no reply\n\n')).toBe('no reply');
    expect(stripGoLogPrefix('plain')).toBe('plain');
  });
});
