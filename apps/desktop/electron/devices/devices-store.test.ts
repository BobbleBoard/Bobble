import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClientIdConflictError,
  clientFingerprint,
  createDevicesStore,
  DevicesFileReadOnlyError,
  type DevicesFs,
  devicesFilePath,
  parseDevicesFile,
} from './devices-store';
import { createSecretBox, type SafeStorageLike } from './secret-box';
import { hashToken, mintToken, tokenFingerprint } from './tokens';

const keychain: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (p) => Buffer.from(`K:${Buffer.from(p).toString('hex')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(2), 'hex').toString(),
};
const box = createSecretBox(keychain, 'darwin');
const SCOPES = { chat: true, generate: true, manage: false };

const realFs: DevicesFs = {
  readFile: (f, e) => fsp.readFile(f, e),
  mkdir: (d, o) => fsp.mkdir(d, o),
  open: (f, flags, mode) => fsp.open(f, flags, mode),
  rename: (a, b) => fsp.rename(a, b),
  rm: (f, o) => fsp.rm(f, o),
  chmod: (f, m) => fsp.chmod(f, m),
};

const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe('devices.json', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'devices-'));
    file = path.join(dir, '.pi', 'desktop', 'devices.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lives at ~/.pi/desktop/devices.json', () => {
    expect(devicesFilePath('/Users/someone')).toBe('/Users/someone/.pi/desktop/devices.json');
  });

  it('is created on first load with a device id, owner-only (0600)', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    const loaded = await store.load();
    expect(loaded.selfId).toMatch(/^dev_[A-Za-z0-9_-]{22}$/);
    expect(fs.existsSync(file)).toBe(true);
    expect(mode(file)).toBe(0o600);
    // The same id on the next start.
    expect(await createDevicesStore({ file, secretBox: box }).selfId()).toBe(loaded.selfId);
  });

  it('keeps a paired device’s token sealed on disk, and opens it on request', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    const token = mintToken();
    const device = await store.addPaired({
      id: 'dev_linuxbox000000000000',
      tsStableId: 'nbYS7qLqVy11CNTRL',
      name: 'linux-ms-7e59',
      os: 'linux',
      ip: '100.101.102.110',
      dnsName: 'linux-ms-7e59.tail0f0f0f.ts.net',
      token,
      scopes: SCOPES,
    });
    expect(device.tokenFingerprint).toBe(tokenFingerprint(token));
    expect(device.autoConnect).toBe(true);
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain('"kind": "os"');
    expect(await store.pairedToken(device.id)).toBe(token);
    expect(await store.pairedToken('dev_unknown')).toBeNull();
    // A fresh process reads the same thing back.
    expect(await createDevicesStore({ file, secretBox: box }).pairedToken(device.id)).toBe(token);
  });

  it('stores only the hash of a client’s token, and finds the client by its token', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    const token = mintToken();
    const client = await store.addClient({
      id: 'dev_laptop00000000000000',
      name: 'My MacBook Pro',
      tsStableId: 'nLAPTOP',
      tsUserId: '3240365473728001',
      loginName: 'someone@github',
      token,
      scopes: SCOPES,
      auto: true,
    });
    expect(client.tokenHash).toBe(hashToken(token));
    expect(clientFingerprint(client)).toBe(tokenFingerprint(token));
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token);
    expect((await store.findClientByToken(token))?.id).toBe(client.id);
    expect(await store.findClientByToken(mintToken())).toBeUndefined();
    // Accepts a hash from the pairing flow, which never hands the store a token.
    const other = mintToken();
    await store.addClient({
      id: 'dev_other000000000000000',
      name: 'Other',
      tsStableId: 'nOTHER',
      tsUserId: '77',
      tokenHash: hashToken(other),
      scopes: SCOPES,
      auto: false,
    });
    expect((await store.findClientByToken(other))?.id).toBe('dev_other000000000000000');
  });

  it('re-pairing replaces the client’s record, which revokes its old token', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    const first = mintToken();
    const second = mintToken();
    const base = {
      id: 'dev_laptop00000000000000',
      name: 'Mac',
      tsStableId: 'n1',
      tsUserId: '1',
      scopes: SCOPES,
      auto: true,
    };
    await store.addClient({ ...base, token: first });
    await store.addClient({ ...base, token: second });
    expect(store.snapshot()?.clients).toHaveLength(1);
    expect(await store.findClientByToken(first)).toBeUndefined();
    expect((await store.findClientByToken(second))?.id).toBe(base.id);
    expect(await store.removeClient(base.id)).toBe(true);
    expect(await store.findClientByToken(second)).toBeUndefined();
    expect(await store.removeClient(base.id)).toBe(false);
  });

  it('tightens an existing file to 0600 on the next write', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    await store.load();
    fs.chmodSync(file, 0o644);
    await store.addEndpoint({
      name: 'llama-server on linux-ms-7e59',
      url: 'http://100.101.102.110:8080/v1',
      api: 'llamacpp-stream',
    });
    expect(mode(file)).toBe(0o600);
  });

  it('never leaves a half-written file: a failed rename keeps the old one, and cleans up', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    await store.addEndpoint({ name: 'one', url: 'http://100.64.0.1:8080/v1', api: 'mlx-stream' });
    const before = fs.readFileSync(file, 'utf8');
    const failing = createDevicesStore({
      file,
      secretBox: box,
      fs: {
        ...realFs,
        rename: async (from, to) => {
          if (to === file && from.endsWith('.tmp'))
            throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          return fsp.rename(from, to);
        },
      },
    });
    await expect(
      failing.addEndpoint({ name: 'two', url: 'http://100.64.0.2:8080/v1', api: 'mlx-stream' }),
    ).rejects.toThrow('ENOSPC');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // Memory did not run ahead of the disk.
    expect(failing.snapshot()?.endpoints.map((e) => e.name)).toEqual(['one']);
  });

  it('never leaves a half-written file: a write that dies midway keeps the old one', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    await store.load();
    const before = fs.readFileSync(file, 'utf8');
    const dying = createDevicesStore({
      file,
      secretBox: box,
      fs: {
        ...realFs,
        open: async (f, flags, m) => {
          const handle = await fsp.open(f, flags, m);
          return {
            chmod: (x: number) => handle.chmod(x),
            sync: () => handle.sync(),
            close: () => handle.close(),
            // Half the bytes, then the disk "fills".
            writeFile: async (data: string) => {
              await handle.writeFile(data.slice(0, Math.floor(data.length / 2)), 'utf8');
              throw Object.assign(new Error('EIO'), { code: 'EIO' });
            },
          };
        },
      },
    });
    await expect(
      dying.addEndpoint({ name: 'x', url: 'http://100.64.0.3/v1', api: 'mlx-stream' }),
    ).rejects.toThrow('EIO');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).selfId).toBe(JSON.parse(before).selfId);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes each temporary file 0600 from its first byte', async () => {
    const opened: Array<{ flags: string; mode: number | undefined }> = [];
    const store = createDevicesStore({
      file,
      secretBox: box,
      fs: {
        ...realFs,
        open: (f, flags, m) => {
          opened.push({ flags, mode: m });
          return fsp.open(f, flags, m);
        },
      },
    });
    await store.load();
    expect(opened).toEqual([{ flags: 'wx', mode: 0o600 }]);
  });

  it('applies simultaneous changes one at a time, losing none', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.addClient({
          id: `dev_client${String(i).padStart(14, '0')}`,
          name: `c${i}`,
          tsStableId: `n${i}`,
          tsUserId: '1',
          token: mintToken(),
          scopes: SCOPES,
          auto: false,
        }),
      ),
    );
    const onDisk = parseDevicesFile(fs.readFileSync(file, 'utf8'));
    expect(onDisk?.file.clients).toHaveLength(12);
  });

  it('moves an unreadable file aside and starts again', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');
    const store = createDevicesStore({ file, secretBox: box, now: () => 1234 });
    const loaded = await store.load();
    expect(loaded.paired).toEqual([]);
    expect(fs.readFileSync(`${file}.corrupt-1234`, 'utf8')).toBe('{ this is not json');
    expect(mode(file)).toBe(0o600);
  });

  it('drops malformed entries and reads a missing scope as not granted', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const token = mintToken();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        selfId: 'dev_self',
        paired: [{ id: 'no-token' }, 'junk'],
        clients: [
          {
            id: 'good',
            name: 'Good',
            tsStableId: 'n1',
            tsUserId: '1',
            tokenHash: hashToken(token),
            scopes: { chat: true },
          },
          { id: 'bad-hash', name: 'Bad', tsStableId: 'n2', tsUserId: '1', tokenHash: 'nope' },
        ],
        endpoints: [{ id: 'e', name: 'E', url: 'http://x', api: 'grpc' }],
      }),
    );
    const loaded = await createDevicesStore({ file, secretBox: box }).load();
    expect(loaded.paired).toEqual([]);
    expect(loaded.clients.map((c) => c.id)).toEqual(['good']);
    expect(loaded.clients[0]?.scopes).toEqual({ chat: true, generate: false, manage: false });
    expect(loaded.endpoints).toEqual([]);
  });

  it('reads a file from a newer Bobble but never overwrites it', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const future = JSON.stringify({
      version: 2,
      selfId: 'dev_future',
      paired: [],
      clients: [],
      endpoints: [],
      extra: {},
    });
    fs.writeFileSync(file, future);
    const store = createDevicesStore({ file, secretBox: box });
    expect((await store.load()).selfId).toBe('dev_future');
    expect(store.readOnly()).toBe(true);
    await expect(store.removePaired('x')).rejects.toBeInstanceOf(DevicesFileReadOnlyError);
    expect(fs.readFileSync(file, 'utf8')).toBe(future);
  });

  it('updates and forgets paired devices', async () => {
    const store = createDevicesStore({ file, secretBox: box, now: () => 5 });
    const d = await store.addPaired({
      id: 'dev_a',
      tsStableId: 'nA',
      name: 'A',
      os: 'macOS',
      ip: '100.64.0.5',
      token: mintToken(),
      scopes: SCOPES,
    });
    expect(d.addedAt).toBe(5);
    expect(
      await store.updatePaired('dev_a', { lastSeenAt: 9, autoConnect: false, name: 'Studio' }),
    ).toMatchObject({
      lastSeenAt: 9,
      autoConnect: false,
      name: 'Studio',
    });
    expect(await store.updatePaired('dev_missing', { name: 'x' })).toBeNull();
    expect(await store.removePaired('dev_a')).toBe(true);
    expect(await store.pairedToken('dev_a')).toBeNull();
  });

  it('keeps an endpoint’s key sealed and hands it back', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    const ep = await store.addEndpoint({
      name: 'LM Studio',
      url: 'http://100.101.102.110:1234/v1',
      key: 'lm-key-123',
      api: 'mlx-stream',
    });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('lm-key-123');
    expect(await store.endpointKey(ep.id)).toBe('lm-key-123');
    const keyless = await store.addEndpoint({
      name: 'llama',
      url: 'http://100.101.102.110:8080/v1',
      api: 'llamacpp-stream',
    });
    expect(keyless.keyEnc).toBeUndefined();
    expect(await store.endpointKey(keyless.id)).toBeNull();
    expect(await store.removeEndpoint(ep.id)).toBe(true);
  });

  it('re-seals a token that was stored unprotected, once protection exists', async () => {
    const unprotected = createSecretBox(null);
    const token = mintToken();
    const early = createDevicesStore({ file, secretBox: unprotected });
    await early.addPaired({
      id: 'dev_a',
      tsStableId: 'nA',
      name: 'A',
      os: 'macOS',
      ip: '100.64.0.5',
      token,
      scopes: SCOPES,
    });
    expect(fs.readFileSync(file, 'utf8')).toContain('"kind": "plain"');
    const later = createDevicesStore({ file, secretBox: box });
    expect(await later.pairedToken('dev_a')).toBe(token);
    expect(fs.readFileSync(file, 'utf8')).toContain('"kind": "os"');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('"kind": "plain"');
  });
  it('never lets one node’s pairing replace another node’s record (ids are public claims)', async () => {
    const store = createDevicesStore({ file, secretBox: box });
    const laptopToken = mintToken();
    const base = { name: 'x', tsUserId: '1', scopes: SCOPES, auto: false };
    await store.addClient({ ...base, id: 'dev_laptop', tsStableId: 'nLAPTOP', token: laptopToken });
    // Another node claims the laptop's id (it is in the laptop's public hello).
    await expect(
      store.addClient({ ...base, id: 'dev_laptop', tsStableId: 'nINTRUDER', token: mintToken() }),
    ).rejects.toBeInstanceOf(ClientIdConflictError);
    expect((await store.findClientByToken(laptopToken))?.tsStableId).toBe('nLAPTOP');
    expect(store.clientIdTakenByOtherNode('dev_laptop', 'nINTRUDER')).toBe(true);
    expect(store.clientIdTakenByOtherNode('dev_laptop', 'nLAPTOP')).toBe(false);
    expect(store.clientIdTakenByOtherNode('dev_new', 'nINTRUDER')).toBe(false);
    // A second install on the same machine (another account) is a separate client.
    await store.addClient({
      ...base,
      id: 'dev_laptop_user2',
      tsStableId: 'nLAPTOP',
      token: mintToken(),
    });
    expect(
      store
        .snapshot()
        ?.clients.map((c) => c.id)
        .sort(),
    ).toEqual(['dev_laptop', 'dev_laptop_user2']);
  });

  it('finds a client by token even before anything loaded the file', async () => {
    const token = mintToken();
    await createDevicesStore({ file, secretBox: box }).addClient({
      id: 'dev_a',
      name: 'A',
      tsStableId: 'nA',
      tsUserId: '1',
      token,
      scopes: SCOPES,
      auto: true,
    });
    const fresh = createDevicesStore({ file, secretBox: box });
    expect(fresh.snapshot()).toBeNull();
    expect((await fresh.findClientByToken(token))?.id).toBe('dev_a');
  });

  it('writes lastUsedAt at most once a minute per client', async () => {
    let writes = 0;
    const counting: DevicesFs = {
      ...realFs,
      rename: async (a, b) => {
        writes += 1;
        return fsp.rename(a, b);
      },
    };
    const store = createDevicesStore({ file, secretBox: box, fs: counting });
    await store.addClient({
      id: 'dev_a',
      name: 'A',
      tsStableId: 'nA',
      tsUserId: '1',
      token: mintToken(),
      scopes: SCOPES,
      auto: true,
    });
    const base = writes;
    await store.touchClient('dev_a', 1_000_000);
    await store.touchClient('dev_a', 1_030_000); // 30 s later: nothing written
    await store.touchClient('dev_a', 1_059_999);
    expect(writes).toBe(base + 1);
    await store.touchClient('dev_a', 1_061_000);
    expect(writes).toBe(base + 2);
    expect(store.snapshot()?.clients[0]?.lastUsedAt).toBe(1_061_000);
    await store.touchClient('dev_unknown', 2_000_000);
    expect(writes).toBe(base + 2);
  });

  it('never seals an old token over a re-pair that landed first', async () => {
    const oldToken = mintToken();
    const newToken = mintToken();
    // Stored unprotected at first, so the next read asks for a re-seal.
    await createDevicesStore({ file, secretBox: createSecretBox(null) }).addPaired({
      id: 'dev_a',
      tsStableId: 'nA',
      name: 'A',
      os: 'macOS',
      ip: '100.64.0.5',
      token: oldToken,
      scopes: SCOPES,
    });
    const store = createDevicesStore({ file, secretBox: box });
    await store.load();
    // The read opens the OLD token; the re-pair commits the NEW one before the re-seal runs.
    const [opened] = await Promise.all([
      store.pairedToken('dev_a'),
      store.addPaired({
        id: 'dev_a',
        tsStableId: 'nA',
        name: 'A',
        os: 'macOS',
        ip: '100.64.0.5',
        token: newToken,
        scopes: SCOPES,
      }),
    ]);
    expect(opened).toBe(oldToken);
    expect(await store.pairedToken('dev_a')).toBe(newToken);
    expect(await createDevicesStore({ file, secretBox: box }).pairedToken('dev_a')).toBe(newToken);
    expect(store.snapshot()?.paired[0]?.tokenFingerprint).toBe(tokenFingerprint(newToken));
  });

  it('never moves aside or rewrites a newer Bobble’s file, even one this version cannot parse', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const future = JSON.stringify({
      version: 3,
      selfId: { kind: 'uuid', value: 'x' },
      devices: [],
    });
    fs.writeFileSync(file, future);
    const store = createDevicesStore({ file, secretBox: box });
    const loaded = await store.load();
    expect(store.readOnly()).toBe(true);
    expect(loaded.selfId).toBe('');
    await expect(
      store.addEndpoint({ name: 'x', url: 'http://x', api: 'mlx-stream' }),
    ).rejects.toBeInstanceOf(DevicesFileReadOnlyError);
    expect(fs.readFileSync(file, 'utf8')).toBe(future);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('corrupt'))).toEqual([]);
  });
});
