/**
 * The fake `tailscale` CLI (_fake-tailscale.mjs), read by the REAL cluster code.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTailnet } from '../../../../packages/cluster/src/host';
import { parseTailscaleStatus } from '../../../../packages/cluster/src/tailscale';
// @ts-expect-error - the fake is plain ESM for probes, not typed app code.
import * as fake from './_fake-tailscale.mjs';

type Fake = ReturnType<typeof fake.createFakeTailscale>;
let ts: Fake | null = null;
afterEach(() => {
  ts?.cleanup();
  ts = null;
});

const run = (bin: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', env });
  return { out: r.stdout, err: r.stderr, code: r.status };
};

describe('readTailnet over the fake', () => {
  it('sees self and all eight peers when Running', async () => {
    ts = fake.createFakeTailscale();
    const status = await readTailnet({ candidates: [ts.bin] });
    expect(status.available).toBe(true);
    const hosts = status.peers.map((p) => p.hostname);
    expect(hosts).toEqual(['studio-mbp', ...Object.keys(fake.PEER_ROLES)]);
    expect(status.peers.find((p) => p.hostname === 'old-laptop')?.online).toBe(false);
    expect(status.peers.find((p) => p.self)?.ip).toBe('100.101.1.10');
  });

  it.each([
    ['needs-login', 'NeedsLogin'],
    ['needs-machine-auth', 'NeedsMachineAuth'],
    ['stopped', 'Stopped'],
  ])('reports %s as unavailable, with the state as the reason', async (state, backend) => {
    ts = fake.createFakeTailscale({ state });
    const status = await readTailnet({ candidates: [ts.bin] });
    // The fields this double is about; DEV-0/1 added more to the status on purpose.
    expect(status).toMatchObject({
      available: false,
      reason: `Tailscale is installed but not running (${backend}).`,
      peers: [],
    });
  });

  it('is not installed when there is no binary, and comes back when there is', async () => {
    ts = fake.createFakeTailscale({ state: 'not-installed' });
    const missing = await readTailnet({ candidates: [ts.bin] });
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain('ENOENT');
    ts.setState('running');
    expect((await readTailnet({ candidates: [ts.bin] })).available).toBe(true);
  });

  it('agrees with parsing the fixture directly', async () => {
    ts = fake.createFakeTailscale();
    const direct = parseTailscaleStatus(JSON.stringify(fake.statusFixture('running')));
    expect(await readTailnet({ candidates: [ts.bin] })).toEqual(direct);
  });
});

describe('the fixtures', () => {
  const running = fake.statusFixture('running');
  const peers = Object.values(running.Peer) as Array<Record<string, unknown>>;
  const byHost = (h: string) => peers.find((p) => p.HostName === h);

  it('have a peer for every role, with the fields that make each case', () => {
    for (const host of Object.keys(fake.PEER_ROLES)) expect(byHost(host)).toBeDefined();
    expect(byHost('linux-gpu')?.CurAddr).not.toBe('');
    expect(byHost('win-desktop')).toMatchObject({ CurAddr: '', Relay: 'nue', Online: true });
    expect(byHost('old-laptop')).toMatchObject({ Online: false, LastSeen: '2026-09-20T18:42:11Z' });
    expect(byHost('expired-pc')).toMatchObject({ Expired: true, Online: false });
    expect(byHost('friends-gpu')).toMatchObject({ ShareeNode: true, UserID: 2002 });
    expect(byHost('ci-runner')?.Tags).toEqual(['tag:ci']);
  });

  it('keep the zero LastSeen an online peer really reports (DEV-0 reads it as absent)', () => {
    expect(byHost('linux-gpu')?.LastSeen).toBe('0001-01-01T00:00:00Z');
  });

  it('give NeedsLogin an AuthURL and no peers', () => {
    const doc = fake.statusFixture('needs-login');
    expect(doc.AuthURL).toMatch(/^https:\/\/login\.tailscale\.com\//);
    expect(doc.Peer).toBeNull();
  });
});

describe('the CLI', () => {
  it('pings: direct once, relayed until it gives up, offline times out, unknown fails', () => {
    ts = fake.createFakeTailscale();
    const bin = ts.bin;
    expect(run(bin, ['ping', 'linux-gpu'])).toEqual({
      out: 'pong from linux-gpu (100.101.1.40) via 192.168.1.40:41641 in 8ms\n',
      err: '',
      code: 0,
    });
    const relayed = run(bin, ['ping', '--c', '3', 'win-desktop']);
    expect(relayed.out.trim().split('\n')).toHaveLength(3);
    expect(relayed.out).toContain('via DERP(nue) in 42ms');
    expect(relayed.err).toBe('direct connection not established\n');
    expect(relayed.code).toBe(1);
    expect(run(bin, ['ping', '--until-direct=false', '--c', '2', 'win-desktop']).code).toBe(0);
    expect(run(bin, ['ping', 'old-laptop'])).toMatchObject({
      err: 'ping "100.101.1.42" timed out\n',
      code: 1,
    });
    expect(run(bin, ['ping', 'expired-pc']).code).toBe(1);
    expect(run(bin, ['ping', 'nobody']).err).toContain('no such host');
    expect(run(bin, ['ping', 'paired-mini.tail1a2b3c.ts.net']).code).toBe(0);
  });

  it('answers whois with the node and its user, and ip with the address', () => {
    ts = fake.createFakeTailscale();
    const who = JSON.parse(run(ts.bin, ['whois', '--json', '100.101.1.46:8765']).out);
    expect(who.Node).toMatchObject({
      StableID: 'nShRd01AbCD11CNTRL',
      Name: 'friends-gpu.tail1a2b3c.ts.net.',
    });
    expect(who.UserProfile.LoginName).toBe('friend@example.org');
    expect(run(ts.bin, ['whois', '100.64.0.1']).code).toBe(1);
    expect(run(ts.bin, ['ip', '-4']).out).toBe('100.101.1.10\n');
    expect(run(ts.bin, ['ip', '-6', 'linux-gpu']).out).toBe('fd7a:115c:a1e0::1:a28\n');
    ts.setState('stopped');
    expect(run(ts.bin, ['ip', '-4'])).toMatchObject({
      code: 1,
      err: 'no current Tailscale IPs; state: Stopped\n',
    });
    expect(run(ts.bin, ['status'])).toMatchObject({ out: 'Tailscale is stopped.\n', code: 1 });
  });

  it('logs how it was run, including TAILSCALE_BE_CLI', () => {
    ts = fake.createFakeTailscale();
    run(ts.bin, ['status', '--json'], { ...process.env, TAILSCALE_BE_CLI: '1' });
    run(ts.bin, ['version'], { PATH: '/usr/bin:/bin' });
    const calls = ts.calls();
    expect(calls.map((c: { argv: string[] }) => c.argv)).toEqual([
      ['status', '--json'],
      ['version'],
    ]);
    expect(calls[0].env.TAILSCALE_BE_CLI).toBe('1');
    expect(calls[1].env.TAILSCALE_BE_CLI).toBeNull();
  });

  it('runs with no PATH at all, the way a Finder-launched app spawns it', () => {
    ts = fake.createFakeTailscale();
    const out = execFileSync(ts.bin, ['version'], { env: {}, encoding: 'utf8' });
    expect(out.split('\n')[0]).toBe('1.102.3');
  });

  it('accepts a hand-built status document', async () => {
    ts = fake.createFakeTailscale();
    const doc = fake.statusFixture('running');
    doc.Peer = {};
    ts.setState(doc);
    expect((await readTailnet({ candidates: [ts.bin] })).peers).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(ts.dir, 'state.json'), 'utf8')).state).toBe('custom');
  });
});
