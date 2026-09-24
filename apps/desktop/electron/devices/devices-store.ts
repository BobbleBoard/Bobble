/**
 * devices.json — who this computer is, who it can use, and who may use it.
 *
 * One file, written by main only, at `~/.pi/desktop/devices.json`
 * (devices-tailscale §4.12). Kept out of settings.json on purpose: other
 * processes read settings.json raw, and the secrets here are sealed with
 * `safeStorage`, which exists only in main.
 *
 *   selfId     this install's device id (the hello's `id`, the SAS's serverId)
 *   paired     devices THIS computer can use: their pinned Tailscale node and
 *              the token they issued, sealed (client side)
 *   clients    computers allowed to use THIS one: sha256 of the token only
 *              (serving side)
 *   endpoints  "Add a server by address" entries, key sealed (DEV-10)
 *
 * WRITTEN ATOMICALLY, 0600: a temporary file created exclusively with mode
 * 0600, written and fsynced, then renamed over the old one. A crash or a full
 * disk leaves the previous file intact, never half of a new one, and the
 * secrets are never readable by another user even for a moment. Writes are
 * serialized, and the in-memory copy changes only after the disk does.
 *
 * Reading is forgiving: malformed entries are dropped, an unreadable file is
 * moved aside (`devices.json.corrupt-<time>`) and replaced, and a file from a
 * NEWER Bobble is read but never overwritten.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSealedSecret, type SealedSecret, type SecretBox } from './secret-box.js';
import {
  findByToken,
  fingerprintFromHash,
  hashToken,
  mintId,
  normalizeTokenHash,
  type RandomBytes,
  tokenFingerprint,
} from './tokens.js';
import type { DeviceScopes } from './trust-policy.js';

export const DEVICES_FILE_VERSION = 1;

/** `~/.pi/desktop/devices.json` under `home`. */
export function devicesFilePath(home: string = os.homedir()): string {
  return path.join(home, '.pi', 'desktop', 'devices.json');
}

/** A device this computer can use (client side). */
export interface PairedDevice {
  /** The serving install's device id (its hello `id`). */
  readonly id: string;
  /** Its Tailscale node, pinned at pairing: the token goes to this node only. */
  readonly tsStableId: string;
  readonly name: string;
  readonly os: string;
  readonly ip: string;
  readonly dnsName?: string;
  readonly tokenEnc: SealedSecret;
  /** First 12 hex digits of sha256(token): the same on both sides, for Details. */
  readonly tokenFingerprint: string;
  readonly scopes: DeviceScopes;
  readonly addedAt: number;
  readonly lastSeenAt?: number;
  readonly autoConnect: boolean;
}

/** A computer allowed to use this one (serving side). */
export interface ApprovedClient {
  /** The client install's device id. */
  readonly id: string;
  readonly name: string;
  readonly tsStableId: string;
  readonly tsUserId: string;
  readonly loginName?: string;
  /** sha256(token), hex. The token itself is never stored here. */
  readonly tokenHash: string;
  readonly scopes: DeviceScopes;
  readonly approvedAt: number;
  readonly lastUsedAt?: number;
  /** Approved automatically as one of the owner's own devices. */
  readonly auto: boolean;
}

/** "Add a server by address" (DEV-10). */
export interface CustomEndpoint {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly keyEnc?: SealedSecret;
  readonly api: 'llamacpp-stream' | 'mlx-stream';
  readonly addedAt: number;
}

export interface DevicesFile {
  readonly version: 1;
  readonly selfId: string;
  readonly paired: readonly PairedDevice[];
  readonly clients: readonly ApprovedClient[];
  readonly endpoints: readonly CustomEndpoint[];
}

/** The file operations the store uses — injected by tests to prove atomicity. */
export interface DevicesFs {
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  mkdir(dir: string, opts: { recursive: true; mode?: number }): Promise<unknown>;
  open(
    file: string,
    flags: string,
    mode?: number,
  ): Promise<{
    writeFile(data: string, encoding: 'utf8'): Promise<void>;
    sync(): Promise<void>;
    chmod(mode: number): Promise<void>;
    close(): Promise<void>;
  }>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string, opts: { force: true }): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
}

const realFs: DevicesFs = {
  readFile: (f, e) => fsp.readFile(f, e),
  mkdir: (d, o) => fsp.mkdir(d, o),
  open: (f, flags, mode) => fsp.open(f, flags, mode),
  rename: (a, b) => fsp.rename(a, b),
  rm: (f, o) => fsp.rm(f, o),
  chmod: (f, m) => fsp.chmod(f, m),
};

export class DevicesFileReadOnlyError extends Error {
  constructor(version: number) {
    super(
      `devices.json was written by a newer Bobble (format ${version}); this version will not overwrite it.`,
    );
    this.name = 'DevicesFileReadOnlyError';
  }
}

export interface DevicesStoreDeps {
  readonly file: string;
  readonly secretBox: SecretBox;
  readonly fs?: DevicesFs;
  readonly now?: () => number;
  readonly random?: RandomBytes;
}

export interface AddPairedInput {
  readonly id: string;
  readonly tsStableId: string;
  readonly name: string;
  readonly os: string;
  readonly ip: string;
  readonly dnsName?: string;
  readonly token: string;
  readonly scopes: DeviceScopes;
  readonly autoConnect?: boolean;
}

export interface AddClientInput {
  readonly id: string;
  readonly name: string;
  readonly tsStableId: string;
  readonly tsUserId: string;
  readonly loginName?: string;
  /** The token itself, or its hash when the pairing flow already hashed it. */
  readonly token?: string;
  readonly tokenHash?: string;
  readonly scopes: DeviceScopes;
  readonly auto: boolean;
  readonly approvedAt?: number;
}

export interface DevicesStore {
  /** Read the file (once; later calls return the loaded copy). Creates it on first run. */
  load(): Promise<DevicesFile>;
  /** The loaded copy, or null before `load`. Secrets stay sealed. */
  snapshot(): DevicesFile | null;
  selfId(): Promise<string>;
  /** Written by a newer Bobble: readable, never overwritten. */
  readOnly(): boolean;

  addPaired(input: AddPairedInput): Promise<PairedDevice>;
  /** The token for a paired device, unsealed; null when there is none or it cannot be opened. */
  pairedToken(id: string): Promise<string | null>;
  updatePaired(
    id: string,
    patch: Partial<
      Pick<PairedDevice, 'name' | 'os' | 'ip' | 'dnsName' | 'lastSeenAt' | 'autoConnect' | 'scopes'>
    >,
  ): Promise<PairedDevice | null>;
  removePaired(id: string): Promise<boolean>;

  addClient(input: AddClientInput): Promise<ApprovedClient>;
  /** The client this token belongs to (constant-time over every record). */
  findClientByToken(token: string): ApprovedClient | undefined;
  touchClient(id: string, at?: number): Promise<void>;
  setClientScopes(id: string, scopes: DeviceScopes): Promise<ApprovedClient | null>;
  removeClient(id: string): Promise<boolean>;

  addEndpoint(input: {
    readonly name: string;
    readonly url: string;
    readonly key?: string;
    readonly api: CustomEndpoint['api'];
  }): Promise<CustomEndpoint>;
  endpointKey(id: string): Promise<string | null>;
  removeEndpoint(id: string): Promise<boolean>;
}

// --- reading, tolerantly --------------------------------------------------------

function str(v: unknown, max = 512): string | undefined {
  return typeof v === 'string' && v !== '' && v.length <= max ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function scopesOf(v: unknown): DeviceScopes {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  // Anything unreadable is NOT granted: a scope is a permission.
  return { chat: o.chat === true, generate: o.generate === true, manage: o.manage === true };
}

function readPaired(v: unknown): PairedDevice | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const tsStableId = str(o.tsStableId);
  const name = str(o.name, 200);
  const ip = str(o.ip, 64);
  if (id === undefined || tsStableId === undefined || name === undefined || ip === undefined)
    return null;
  if (!isSealedSecret(o.tokenEnc)) return null;
  const dnsName = str(o.dnsName, 255);
  const lastSeenAt = num(o.lastSeenAt);
  return {
    id,
    tsStableId,
    name,
    os: str(o.os, 64) ?? 'unknown',
    ip,
    ...(dnsName !== undefined ? { dnsName } : {}),
    tokenEnc: o.tokenEnc,
    tokenFingerprint: str(o.tokenFingerprint, 64) ?? '',
    scopes: scopesOf(o.scopes),
    addedAt: num(o.addedAt) ?? 0,
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
    autoConnect: o.autoConnect === true,
  };
}

function readClient(v: unknown): ApprovedClient | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name, 200);
  const tsStableId = str(o.tsStableId);
  const tsUserId = str(o.tsUserId, 64);
  const tokenHash = normalizeTokenHash(o.tokenHash);
  if (
    id === undefined ||
    name === undefined ||
    tsStableId === undefined ||
    tsUserId === undefined ||
    tokenHash === null
  ) {
    return null;
  }
  const loginName = str(o.loginName, 320);
  const lastUsedAt = num(o.lastUsedAt);
  return {
    id,
    name,
    tsStableId,
    tsUserId,
    ...(loginName !== undefined ? { loginName } : {}),
    tokenHash,
    scopes: scopesOf(o.scopes),
    approvedAt: num(o.approvedAt) ?? 0,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    auto: o.auto === true,
  };
}

function readEndpoint(v: unknown): CustomEndpoint | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name, 200);
  const url = str(o.url, 2048);
  if (id === undefined || name === undefined || url === undefined) return null;
  if (o.api !== 'llamacpp-stream' && o.api !== 'mlx-stream') return null;
  if (o.keyEnc !== undefined && !isSealedSecret(o.keyEnc)) return null;
  return {
    id,
    name,
    url,
    ...(isSealedSecret(o.keyEnc) ? { keyEnc: o.keyEnc } : {}),
    api: o.api,
    addedAt: num(o.addedAt) ?? 0,
  };
}

function list<T>(v: unknown, read: (x: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    const r = read(x);
    if (r !== null) out.push(r);
  }
  return out;
}

/** Parse a devices.json document; `null` when it is not one at all. */
export function parseDevicesFile(text: string): { file: DevicesFile; version: number } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  const version = typeof o.version === 'number' && Number.isInteger(o.version) ? o.version : 1;
  const selfId = str(o.selfId, 128);
  if (selfId === undefined) return null;
  return {
    version,
    file: {
      version: 1,
      selfId,
      paired: list(o.paired, readPaired),
      clients: list(o.clients, readClient),
      endpoints: list(o.endpoints, readEndpoint),
    },
  };
}

// --- the store ------------------------------------------------------------------

export function createDevicesStore(deps: DevicesStoreDeps): DevicesStore {
  const fs = deps.fs ?? realFs;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? nodeRandomBytes;
  let current: DevicesFile | null = null;
  let loading: Promise<DevicesFile> | null = null;
  let readOnlyVersion: number | null = null;
  /** Mutations run one at a time, in the order they were asked for. */
  let queue: Promise<unknown> = Promise.resolve();

  const writeAtomic = async (file: DevicesFile): Promise<void> => {
    await fs.mkdir(path.dirname(deps.file), { recursive: true, mode: 0o700 });
    const tmp = `${deps.file}.${process.pid}.${random(6).toString('hex')}.tmp`;
    try {
      // `wx`: never follow or reuse an existing path; 0600 from the first byte.
      const handle = await fs.open(tmp, 'wx', 0o600);
      try {
        await handle.chmod(0o600); // whatever the umask did
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, deps.file);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const load = (): Promise<DevicesFile> => {
    if (current !== null) return Promise.resolve(current);
    if (loading !== null) return loading;
    loading = (async () => {
      let text: string | null = null;
      try {
        text = await fs.readFile(deps.file, 'utf8');
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
      }
      if (text !== null) {
        const parsed = parseDevicesFile(text);
        if (parsed !== null) {
          if (parsed.version > DEVICES_FILE_VERSION) readOnlyVersion = parsed.version;
          current = parsed.file;
          return parsed.file;
        }
        // Unreadable: keep it for a human, start over.
        await fs.rename(deps.file, `${deps.file}.corrupt-${now()}`).catch(() => undefined);
      }
      const fresh: DevicesFile = {
        version: 1,
        selfId: mintId('dev', random),
        paired: [],
        clients: [],
        endpoints: [],
      };
      await writeAtomic(fresh);
      current = fresh;
      return fresh;
    })().finally(() => {
      loading = null;
    });
    return loading;
  };

  /** Apply `change` to the current file, write it, then adopt it. Serialized. */
  const mutate = <T>(
    change: (file: DevicesFile) => Promise<{ next: DevicesFile; result: T }>,
  ): Promise<T> => {
    const run = queue.then(async () => {
      const file = await load();
      if (readOnlyVersion !== null) throw new DevicesFileReadOnlyError(readOnlyVersion);
      const { next, result } = await change(file);
      if (next !== file) {
        await writeAtomic(next);
        current = next;
      }
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    load,
    snapshot: () => current,
    selfId: async () => (await load()).selfId,
    readOnly: () => readOnlyVersion !== null,

    addPaired(input) {
      return mutate(async (file) => {
        const device: PairedDevice = {
          id: input.id,
          tsStableId: input.tsStableId,
          name: input.name,
          os: input.os,
          ip: input.ip,
          ...(input.dnsName !== undefined ? { dnsName: input.dnsName } : {}),
          tokenEnc: await deps.secretBox.seal(input.token),
          tokenFingerprint: tokenFingerprint(input.token),
          scopes: scopesOf(input.scopes),
          addedAt: now(),
          autoConnect: input.autoConnect ?? true,
        };
        // Pairing again with the same device replaces the old record and token.
        const paired = [...file.paired.filter((p) => p.id !== input.id), device];
        return { next: { ...file, paired }, result: device };
      });
    },
    async pairedToken(id) {
      const file = await load();
      const device = file.paired.find((p) => p.id === id);
      if (device === undefined) return null;
      try {
        const { plain, reseal } = await deps.secretBox.open(device.tokenEnc);
        if (reseal && readOnlyVersion === null) {
          await mutate(async (f) => {
            const tokenEnc = await deps.secretBox.seal(plain);
            return {
              next: { ...f, paired: f.paired.map((p) => (p.id === id ? { ...p, tokenEnc } : p)) },
              result: undefined,
            };
          }).catch(() => undefined);
        }
        return plain;
      } catch {
        return null;
      }
    },
    updatePaired(id, patch) {
      return mutate(async (file) => {
        const existing = file.paired.find((p) => p.id === id);
        if (existing === undefined) return { next: file, result: null };
        const updated: PairedDevice = {
          ...existing,
          ...patch,
          ...(patch.scopes !== undefined ? { scopes: scopesOf(patch.scopes) } : {}),
        };
        return {
          next: { ...file, paired: file.paired.map((p) => (p.id === id ? updated : p)) },
          result: updated,
        };
      });
    },
    removePaired(id) {
      return mutate(async (file) => {
        const paired = file.paired.filter((p) => p.id !== id);
        return paired.length === file.paired.length
          ? { next: file, result: false }
          : { next: { ...file, paired }, result: true };
      });
    },

    addClient(input) {
      return mutate(async (file) => {
        const tokenHash =
          input.token !== undefined ? hashToken(input.token) : normalizeTokenHash(input.tokenHash);
        if (tokenHash === null) throw new Error('addClient needs a token or a sha256 token hash');
        const client: ApprovedClient = {
          id: input.id,
          name: input.name,
          tsStableId: input.tsStableId,
          tsUserId: input.tsUserId,
          ...(input.loginName !== undefined ? { loginName: input.loginName } : {}),
          tokenHash,
          scopes: scopesOf(input.scopes),
          approvedAt: input.approvedAt ?? now(),
          auto: input.auto,
        };
        // Re-pairing replaces the old record, which revokes the old token.
        const clients = [...file.clients.filter((c) => c.id !== input.id), client];
        return { next: { ...file, clients }, result: client };
      });
    },
    findClientByToken(token) {
      return current === null ? undefined : findByToken(current.clients, token);
    },
    async touchClient(id, at = now()) {
      await mutate(async (file) => {
        if (!file.clients.some((c) => c.id === id)) return { next: file, result: undefined };
        return {
          next: {
            ...file,
            clients: file.clients.map((c) => (c.id === id ? { ...c, lastUsedAt: at } : c)),
          },
          result: undefined,
        };
      });
    },
    setClientScopes(id, scopes) {
      return mutate(async (file) => {
        const existing = file.clients.find((c) => c.id === id);
        if (existing === undefined) return { next: file, result: null };
        const updated: ApprovedClient = { ...existing, scopes: scopesOf(scopes) };
        return {
          next: { ...file, clients: file.clients.map((c) => (c.id === id ? updated : c)) },
          result: updated,
        };
      });
    },
    removeClient(id) {
      return mutate(async (file) => {
        const clients = file.clients.filter((c) => c.id !== id);
        return clients.length === file.clients.length
          ? { next: file, result: false }
          : { next: { ...file, clients }, result: true };
      });
    },

    addEndpoint(input) {
      return mutate(async (file) => {
        const endpoint: CustomEndpoint = {
          id: mintId('ep', random),
          name: input.name,
          url: input.url,
          ...(input.key !== undefined && input.key !== ''
            ? { keyEnc: await deps.secretBox.seal(input.key) }
            : {}),
          api: input.api,
          addedAt: now(),
        };
        return { next: { ...file, endpoints: [...file.endpoints, endpoint] }, result: endpoint };
      });
    },
    async endpointKey(id) {
      const file = await load();
      const endpoint = file.endpoints.find((e) => e.id === id);
      if (endpoint?.keyEnc === undefined) return null;
      try {
        return (await deps.secretBox.open(endpoint.keyEnc)).plain;
      } catch {
        return null;
      }
    },
    removeEndpoint(id) {
      return mutate(async (file) => {
        const endpoints = file.endpoints.filter((e) => e.id !== id);
        return endpoints.length === file.endpoints.length
          ? { next: file, result: false }
          : { next: { ...file, endpoints }, result: true };
      });
    },
  };
}

/** The Details view's "key fingerprint" for a client record. */
export function clientFingerprint(client: Pick<ApprovedClient, 'tokenHash'>): string {
  return fingerprintFromHash(client.tokenHash);
}
