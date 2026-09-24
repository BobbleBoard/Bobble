import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLocalApiClient,
  describeTarget,
  LINUX_SOCKETS,
  LOCALAPI_HOST,
  type LocalApiTarget,
  locateLocalApi,
  MACOS_OSS_SOCKET,
  MACSYS_DIR,
  parseLsofSameUserProof,
  TAILSCALE_CAP_VERSION,
  WINDOWS_PIPE,
} from './localapi';
import { createFakeLocalApi, type FakeLocalApi, STATUS_FIXTURE } from './testing/fake-localapi';

describe('locateLocalApi', () => {
  it('finds the macOS Standalone app’s port and token — the shape MEASURED here', async () => {
    const read: string[] = [];
    const targets = await locateLocalApi({
      platform: 'darwin',
      readlink: async (p) => {
        expect(p).toBe(`${MACSYS_DIR}/ipnport`);
        return '49238';
      },
      readFile: async (p) => {
        read.push(p);
        return 'secret-token\n';
      },
      exists: async () => false,
      lsof: async () => {
        throw new Error('lsof must not run when the Standalone app answered');
      },
    });
    expect(read).toEqual([`${MACSYS_DIR}/sameuserproof-49238`]);
    expect(targets).toEqual([
      { kind: 'tcp', port: 49238, token: 'secret-token', variant: 'macsys' },
    ]);
  });

  it('falls back to the App Store variant through lsof, then the open-source socket', async () => {
    const lsof = [
      'p812',
      'cIPNExtension',
      'n/Users/x/Library/Group Containers/io.tailscale.ipn.macos/sameuserproof-61577-2ae2ec9e0aa2005784f1',
    ].join('\n');
    const targets = await locateLocalApi({
      platform: 'darwin',
      readlink: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readFile: async () => '',
      exists: async (p) => p === MACOS_OSS_SOCKET,
      lsof: async () => lsof,
    });
    expect(targets).toEqual([
      { kind: 'tcp', port: 61577, token: '2ae2ec9e0aa2005784f1', variant: 'appstore' },
      { kind: 'unix', path: MACOS_OSS_SOCKET, variant: 'macos-oss' },
    ]);
  });

  it('skips a Standalone install whose token this user cannot read (non-admin)', async () => {
    const targets = await locateLocalApi({
      platform: 'darwin',
      readlink: async () => '49238',
      readFile: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      exists: async () => false,
      lsof: async () => '',
    });
    expect(targets).toEqual([]);
  });

  it('ignores an ipnport that is not a port', async () => {
    const targets = await locateLocalApi({
      platform: 'darwin',
      readlink: async () => '../../etc/passwd',
      readFile: async () => 'x',
      exists: async () => false,
      lsof: async () => '',
    });
    expect(targets).toEqual([]);
  });

  it('uses the socket on Linux and the pipe on Windows', async () => {
    expect(
      await locateLocalApi({ platform: 'linux', exists: async (p) => p === LINUX_SOCKETS[0] }),
    ).toEqual([{ kind: 'unix', path: '/var/run/tailscale/tailscaled.sock', variant: 'linux' }]);
    expect(await locateLocalApi({ platform: 'linux', exists: async () => false })).toEqual([]);
    expect(await locateLocalApi({ platform: 'win32' })).toEqual([
      { kind: 'pipe', path: WINDOWS_PIPE, variant: 'windows' },
    ]);
    expect(WINDOWS_PIPE).toBe(
      String.raw`\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`,
    );
  });
});

describe('parseLsofSameUserProof', () => {
  it('reads only well-formed entries', () => {
    expect(parseLsofSameUserProof('n/x/.tailscale.ipn.macos/sameuserproof-1234-abc123')).toEqual({
      port: 1234,
      token: 'abc123',
    });
    expect(
      parseLsofSameUserProof('n/x/.tailscale.ipn.macos/sameuserproof-99999999-abc'),
    ).toBeNull();
    expect(parseLsofSameUserProof('n/x/.tailscale.ipn.macos/sameuserproof-12-a b')).toBeNull();
    expect(parseLsofSameUserProof('nothing here')).toBeNull();
  });
});

describe('describeTarget', () => {
  it('never shows the token', () => {
    const label = describeTarget({ kind: 'tcp', port: 49238, token: 'SECRET', variant: 'macsys' });
    expect(label).toContain('49238');
    expect(label).not.toContain('SECRET');
  });
});

describe('the LocalAPI client', () => {
  let dir: string;
  let fake: FakeLocalApi;

  beforeEach(() => {
    // Short: macOS caps a Unix socket path at 104 bytes.
    dir = mkdtempSync(path.join(tmpdir(), 'tsla-'));
  });
  afterEach(async () => {
    await fake?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks the Unix socket with the daemon’s Host and capability headers', async () => {
    fake = createFakeLocalApi();
    const socketPath = path.join(dir, 's.sock');
    await fake.listenUnix(socketPath);
    const client = createLocalApiClient({ kind: 'unix', path: socketPath, variant: 'linux' });
    const res = await client.status();
    expect(res.status).toBe(200);
    expect(res.body).toBe(STATUS_FIXTURE);
    expect(fake.requests[0]).toMatchObject({
      method: 'GET',
      url: '/localapi/v0/status',
      host: LOCALAPI_HOST,
      cap: String(TAILSCALE_CAP_VERSION),
      authorization: undefined,
    });
  });

  it('sends the same-user token as Basic auth on TCP, and a wrong one is refused', async () => {
    fake = createFakeLocalApi({ token: 'right' });
    const port = await fake.listenTcp();
    const good = createLocalApiClient({ kind: 'tcp', port, token: 'right', variant: 'macsys' });
    expect((await good.status()).status).toBe(200);
    const bad = createLocalApiClient({ kind: 'tcp', port, token: 'wrong', variant: 'macsys' });
    const refused = await bad.status();
    // MEASURED on the real daemon: 401 "auth required".
    expect(refused).toEqual({ status: 401, body: 'auth required\n' });
    expect(fake.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from(':right').toString('base64')}`,
    );
  });

  it('whois and ping reach exactly their routes, with the address encoded', async () => {
    fake = createFakeLocalApi();
    const socketPath = path.join(dir, 's.sock');
    await fake.listenUnix(socketPath);
    const client = createLocalApiClient({ kind: 'unix', path: socketPath, variant: 'linux' });
    expect((await client.whois('100.101.102.110:4567')).status).toBe(200);
    expect(await client.whois('100.99.99.99')).toEqual({
      status: 404,
      body: 'no match for IP:port\n',
    });
    expect((await client.ping('100.101.102.110')).status).toBe(200);
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /localapi/v0/whois?addr=100.101.102.110%3A4567',
      'GET /localapi/v0/whois?addr=100.99.99.99',
      'POST /localapi/v0/ping?ip=100.101.102.110&type=disco',
    ]);
  });

  it('gives up at the deadline, and on abort', async () => {
    fake = createFakeLocalApi({ delayMs: 2000 });
    const socketPath = path.join(dir, 's.sock');
    await fake.listenUnix(socketPath);
    const client = createLocalApiClient({ kind: 'unix', path: socketPath, variant: 'linux' });
    await expect(client.status({ timeoutMs: 30 })).rejects.toMatchObject({ name: 'TimeoutError' });
    const ctl = new AbortController();
    const pending = client.status({ signal: ctl.signal, timeoutMs: 5000 });
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects when nothing listens (the adapter then looks elsewhere)', async () => {
    fake = createFakeLocalApi();
    const client = createLocalApiClient({
      kind: 'unix',
      path: path.join(dir, 'none.sock'),
      variant: 'linux',
    });
    await expect(client.status({ timeoutMs: 1000 })).rejects.toBeInstanceOf(Error);
  });

  it('streams watch lines, reassembling lines split across chunks, until the daemon closes', async () => {
    fake = createFakeLocalApi({ idleKillMs: 80 });
    const socketPath = path.join(dir, 's.sock');
    await fake.listenUnix(socketPath);
    const client = createLocalApiClient({ kind: 'unix', path: socketPath, variant: 'linux' });
    const lines: string[] = [];
    const ctl = new AbortController();
    const watching = client.watchIpnBus((l) => lines.push(l), ctl.signal);
    await new Promise((r) => setTimeout(r, 20));
    // Half a line, then the rest: one line arrives, whole.
    fake.pushRaw('{"NetMap":');
    await new Promise((r) => setTimeout(r, 10));
    fake.pushRaw('{}}\n{"Health":{}}\n');
    await watching; // the idle kill ends the stream: the promise resolves
    expect(lines[0]).toContain('"State":6');
    expect(lines.slice(1)).toEqual(['{"NetMap":{}}', '{"Health":{}}']);
    expect(fake.watchConnections()).toBe(1);
    expect(fake.requests.at(-1)?.url).toBe('/localapi/v0/watch-ipn-bus?mask=274');
  });

  it('ends the watch cleanly on abort', async () => {
    fake = createFakeLocalApi();
    const socketPath = path.join(dir, 's.sock');
    await fake.listenUnix(socketPath);
    const client = createLocalApiClient({ kind: 'unix', path: socketPath, variant: 'linux' });
    const ctl = new AbortController();
    const watching = client.watchIpnBus(() => undefined, ctl.signal);
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  it('rejects a watch the daemon refuses', async () => {
    fake = createFakeLocalApi({ token: 'right' });
    const port = await fake.listenTcp();
    const client = createLocalApiClient({
      kind: 'tcp',
      port,
      token: 'wrong',
      variant: 'macsys',
    } as LocalApiTarget);
    await expect(client.watchIpnBus(() => undefined, new AbortController().signal)).rejects.toThrow(
      /HTTP 401/,
    );
  });
});
