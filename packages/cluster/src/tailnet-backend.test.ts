import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliRunner } from './cli-backend';
import type { LocalApiTarget } from './localapi';
import { chooseBackend, createTailnetAdapter, NOT_INSTALLED_REASON } from './tailnet-backend';
import type { TailnetStatus } from './tailscale';
import { createFakeLocalApi, type FakeLocalApi, STATUS_FIXTURE } from './testing/fake-localapi';

/** The real fixture with linux-ms-7e59 switched offline — a change a watcher must report. */
function linuxOffline(): string {
  const doc = JSON.parse(STATUS_FIXTURE) as { Peer: Record<string, Record<string, unknown>> };
  for (const p of Object.values(doc.Peer)) if (p.HostName === 'linux-ms-7e59') p.Online = false;
  return JSON.stringify(doc);
}

function cliAnswering(stdout: () => string): { run: CliRunner; calls: () => number } {
  let n = 0;
  return {
    run: async () => {
      n += 1;
      return { stdout: stdout(), stderr: '', code: 0, missing: false, timedOut: false };
    },
    calls: () => n,
  };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const linux = (s: TailnetStatus) => s.peers.find((p) => p.hostname === 'linux-ms-7e59');

/** The four read-only LocalAPI calls — the only ones this package can make. */
const ALLOWED =
  /^(GET \/localapi\/v0\/status|GET \/localapi\/v0\/whois\?addr=[^&]+|POST \/localapi\/v0\/ping\?ip=[^&]+&type=disco|GET \/localapi\/v0\/watch-ipn-bus\?mask=\d+)$/;

describe('chooseBackend and the adapter', () => {
  let dir: string;
  let socketPath: string;
  let fake: FakeLocalApi | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tsba-'));
    socketPath = path.join(dir, 's.sock');
    fake = undefined;
  });
  afterEach(async () => {
    await fake?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const unixTarget = (): LocalApiTarget => ({ kind: 'unix', path: socketPath, variant: 'linux' });

  it('prefers the LocalAPI when it answers', async () => {
    fake = createFakeLocalApi();
    await fake.listenUnix(socketPath);
    const choice = await chooseBackend({
      locateLocalApi: async () => [unixTarget()],
      locateCli: async () => '/usr/bin/tailscale',
    });
    expect(choice.backend?.kind).toBe('localapi');
    expect(choice.tried).toEqual([`LocalAPI ${socketPath}`]);
  });

  it('falls back to the CLI when no LocalAPI answers', async () => {
    const choice = await chooseBackend({
      locateLocalApi: async () => [unixTarget()], // nothing listening there
      locateCli: async () => '/usr/bin/tailscale',
      probeTimeoutMs: 500,
    });
    expect(choice.backend?.kind).toBe('cli');
    expect(choice.tried).toEqual([`LocalAPI ${socketPath}`, 'CLI /usr/bin/tailscale']);
    expect(choice.backend !== null && 'localApiSeen' in choice && choice.localApiSeen).toBe(true);
  });

  it('does not use a LocalAPI that refuses this user (wrong token)', async () => {
    fake = createFakeLocalApi({ token: 'right' });
    const port = await fake.listenTcp();
    const choice = await chooseBackend({
      locateLocalApi: async () => [{ kind: 'tcp', port, token: 'stale', variant: 'macsys' }],
      locateCli: async () => '/usr/local/bin/tailscale',
    });
    expect(choice.backend?.kind).toBe('cli');
  });

  it('says "not installed" when there is neither', async () => {
    const choice = await chooseBackend({
      locateLocalApi: async () => [],
      locateCli: async () => null,
    });
    expect(choice.backend).toBeNull();
    if (choice.backend === null) {
      expect(choice.status).toEqual({
        available: false,
        state: 'NotInstalled',
        reason: NOT_INSTALLED_REASON,
        peers: [],
      });
    }
  });

  it('answers status, whois and ping through the LocalAPI', async () => {
    fake = createFakeLocalApi();
    await fake.listenUnix(socketPath);
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [unixTarget()],
      locateCli: async () => null,
    });
    expect(adapter.backendKind()).toBe('unknown');
    const status = await adapter.status();
    expect(adapter.backendKind()).toBe('localapi');
    expect(status.state).toBe('Running');
    expect(status.peers).toHaveLength(4);
    expect(await adapter.whois('100.101.102.110')).toMatchObject({
      found: true,
      userId: '3240365473728001',
    });
    expect(await adapter.whois('100.99.99.99')).toMatchObject({
      found: false,
      reason: 'not-found',
    });
    expect(await adapter.ping('100.101.102.110')).toMatchObject({ ok: true, path: 'direct' });
    expect(await adapter.ping('100.101.102.120')).toMatchObject({ ok: false, reason: 'key-expired' });
    expect(await adapter.ping('100.64.9.9', { timeoutMs: 50 })).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
    for (const r of fake.requests) expect(`${r.method} ${r.url}`).toMatch(ALLOWED);
  });

  it('chooses again when the LocalAPI goes away mid-session, and keeps answering', async () => {
    fake = createFakeLocalApi();
    await fake.listenUnix(socketPath);
    const cli = cliAnswering(() => STATUS_FIXTURE);
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [unixTarget()],
      locateCli: async () => '/usr/bin/tailscale',
      runCli: cli.run,
      probeTimeoutMs: 300,
    });
    expect((await adapter.status()).state).toBe('Running');
    expect(adapter.backendKind()).toBe('localapi');
    await fake.close(); // Tailscale restarts; the socket is gone
    fake = undefined;
    const after = await adapter.status();
    expect(after.state).toBe('Running');
    expect(adapter.backendKind()).toBe('cli');
    expect(cli.calls()).toBe(1);
  });

  it('chooses again when the LocalAPI starts refusing (a rotated same-user token)', async () => {
    fake = createFakeLocalApi({ token: 'first' });
    const port = await fake.listenTcp();
    let onDisk = 'first'; // what /Library/Tailscale/sameuserproof-<port> holds
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [{ kind: 'tcp', port, token: onDisk, variant: 'macsys' }],
      locateCli: async () => null,
    });
    expect((await adapter.status()).state).toBe('Running');
    // Tailscale restarts: same port, new token. The old client now gets 401.
    fake.setToken('second');
    onDisk = 'second';
    const after = await adapter.status();
    expect(after.state).toBe('Running');
    expect(adapter.backendKind()).toBe('localapi');
    expect(
      fake.requests.filter((r) =>
        r.authorization?.endsWith(Buffer.from(':second').toString('base64')),
      ).length,
    ).toBeGreaterThan(0);
    // whois and ping through the fresh client work too.
    expect(await adapter.whois('100.101.102.110')).toMatchObject({ found: true });
  });

  it('reports "not answering" rather than a stale target when nothing answers after a re-choose', async () => {
    fake = createFakeLocalApi({ token: 'first' });
    const port = await fake.listenTcp();
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [{ kind: 'tcp', port, token: 'first', variant: 'macsys' }],
      locateCli: async () => null,
    });
    await adapter.status();
    fake.setToken('rotated-but-unreadable'); // e.g. a non-admin user after an upgrade
    const s = await adapter.status();
    // The LocalAPI no longer counts as installed-and-answering, and no CLI: not installed here.
    expect(s.available).toBe(false);
    expect(['NotInstalled', 'NotRunning']).toContain(s.state);
  });

  it('notices Tailscale being installed', async () => {
    let t = 0;
    let installed = false;
    const cli = cliAnswering(() => STATUS_FIXTURE);
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [],
      locateCli: async () => (installed ? '/usr/bin/tailscale' : null),
      runCli: cli.run,
      now: () => t,
      rechooseAfterMs: 5000,
    });
    expect((await adapter.status()).state).toBe('NotInstalled');
    expect(await adapter.whois('100.1.1.1')).toMatchObject({
      found: false,
      detail: NOT_INSTALLED_REASON,
    });
    expect(await adapter.ping('100.1.1.1')).toMatchObject({ ok: false, reason: 'error' });
    installed = true;
    t = 1000;
    expect((await adapter.status()).state).toBe('NotInstalled'); // not re-checked yet
    t = 6000;
    expect((await adapter.status()).state).toBe('Running');
    expect(adapter.backendKind()).toBe('cli');
  });

  it('goes back to the LocalAPI after standing in with the CLI', async () => {
    let t = 0;
    const cli = cliAnswering(() => STATUS_FIXTURE);
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [unixTarget()],
      locateCli: async () => '/usr/bin/tailscale',
      runCli: cli.run,
      probeTimeoutMs: 300,
      now: () => t,
      upgradeAfterMs: 60_000,
    });
    await adapter.status(); // the LocalAPI is down (restarting): the CLI stands in
    expect(adapter.backendKind()).toBe('cli');
    fake = createFakeLocalApi();
    await fake.listenUnix(socketPath);
    t = 30_000;
    await adapter.status();
    expect(adapter.backendKind()).toBe('cli');
    t = 61_000;
    await adapter.status();
    expect(adapter.backendKind()).toBe('localapi');
  });

  it('watch: reports now, then each real change, and survives the daemon’s idle close', async () => {
    fake = createFakeLocalApi({ idleKillMs: 60 });
    await fake.listenUnix(socketPath);
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [unixTarget()],
      locateCli: async () => null,
      reconnectMinMs: 10,
    });
    const seen: TailnetStatus[] = [];
    const ctl = new AbortController();
    const watching = adapter.watch((s) => seen.push(s), {
      signal: ctl.signal,
      pushPollMs: 60_000,
      debounceMs: 10,
    });

    await until(() => seen.length === 1);
    expect(linux(seen[0] as TailnetStatus)?.online).toBe(true);

    // Traffic counters are not news: nothing new is reported.
    await until(() => (fake?.openWatches() ?? 0) === 1);
    fake.push('{"Version":"fake","Engine":{"RBytes":1}}');
    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toHaveLength(1);

    // The daemon closes the idle stream (shortened ~60 s kill); the watcher is back.
    await until(() => (fake?.watchConnections() ?? 0) >= 2);
    await until(() => (fake?.openWatches() ?? 0) === 1);

    // A real change after the reconnect still arrives, once.
    fake.setStatus(linuxOffline());
    fake.push('{"NetMap":{}}');
    await until(() => seen.length === 2);
    expect(linux(seen[1] as TailnetStatus)?.online).toBe(false);
    await new Promise((r) => setTimeout(r, 120)); // more idle closes: no repeats
    expect(seen).toHaveLength(2);
    expect(fake.watchConnections()).toBeGreaterThanOrEqual(3);

    ctl.abort();
    await watching;
    for (const r of fake.requests) expect(`${r.method} ${r.url}`).toMatch(ALLOWED);
  });

  it('watch: polls the CLI and reports only changes', async () => {
    let body = STATUS_FIXTURE;
    const cli = cliAnswering(() => body);
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [],
      locateCli: async () => '/usr/bin/tailscale',
      runCli: cli.run,
    });
    const seen: TailnetStatus[] = [];
    const ctl = new AbortController();
    const watching = adapter.watch((s) => seen.push(s), { signal: ctl.signal, pollMs: 15 });
    await until(() => cli.calls() >= 4);
    expect(seen).toHaveLength(1);
    body = linuxOffline();
    await until(() => seen.length === 2);
    expect(linux(seen[1] as TailnetStatus)?.online).toBe(false);
    ctl.abort();
    await watching;
  });

  it('watch: follows Tailscale from the LocalAPI to the CLI when the daemon moves', async () => {
    fake = createFakeLocalApi();
    await fake.listenUnix(socketPath);
    const cli = cliAnswering(() => linuxOffline());
    const adapter = createTailnetAdapter({
      locateLocalApi: async () => [unixTarget()],
      locateCli: async () => '/usr/bin/tailscale',
      runCli: cli.run,
      reconnectMinMs: 10,
      probeTimeoutMs: 200,
    });
    const seen: TailnetStatus[] = [];
    const ctl = new AbortController();
    const watching = adapter.watch((s) => seen.push(s), {
      signal: ctl.signal,
      pollMs: 20,
      pushPollMs: 60_000,
      debounceMs: 5,
    });
    await until(() => seen.length === 1 && (fake?.openWatches() ?? 0) === 1);
    await fake.close(); // the stream drops and nothing answers there any more
    fake = undefined;
    // Without waiting out the minute-long safety poll: the failed stream pokes a read,
    // the read re-chooses, and the CLI's (different) status is reported.
    await until(() => seen.length === 2, 2000);
    expect(adapter.backendKind()).toBe('cli');
    expect(linux(seen[1] as TailnetStatus)?.online).toBe(false);
    ctl.abort();
    await watching;
  });
});
