/**
 * SECRETS AT REST — device tokens and endpoint keys, sealed by the OS.
 *
 * Electron's `safeStorage` encrypts with the macOS Keychain, Windows DPAPI or
 * the Linux secret service (kwallet / libsecret). This wraps it for the one
 * job devices.json needs: turn a secret into something safe to write to disk,
 * and back (devices-tailscale §3.12, §4.12).
 *
 * THE UI MUST BE ABLE TO SAY HOW SAFE IT IS. On Linux with no secret service,
 * Electron falls back to `basic_text` — a hardcoded key, effectively plain
 * text — and before the app is ready, or on a machine with no backend at all,
 * encryption is unavailable. Those cases still store the secret (refusing to
 * pair is worse), but `protection()` reports `weak` / `none` so the Devices
 * panel can say so, and a secret stored unprotected is re-sealed the first
 * time it is read on a machine that can protect it.
 *
 * The async API (Electron ≥ 39, present in the shipped 43) is preferred when it
 * is available; which API sealed a secret is recorded with it, so it is always
 * opened by the same one.
 *
 * Electron-free: `safeStorage` is injected (structurally), so this runs under
 * vitest and in any process main hands it to.
 */

/** The part of Electron's `safeStorage` this uses (Electron 43's shape). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptStringAsync?(plainText: string): Promise<Buffer>;
  decryptStringAsync?(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
  /** Linux only. */
  getSelectedStorageBackend?(): string;
}

/** A secret as written to disk. `data` is base64 either way. */
export interface SealedSecret {
  readonly v: 1;
  /**
   * `os`: sealed with safeStorage's synchronous API. `os-async`: with its async
   * API. `plain`: NOT encrypted (no protection was available) — only base64.
   */
  readonly kind: 'os' | 'os-async' | 'plain';
  readonly data: string;
}

/** How well a secret written now would be protected. */
export type SecretProtection =
  /** OS keychain / DPAPI / secret service. */
  | 'os'
  /** Linux `basic_text`: "encrypted" with a hardcoded key — effectively plain text. */
  | 'weak'
  /** No protection available: stored as plain base64. */
  | 'none';

export class SecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnavailableError';
  }
}

export interface SecretBox {
  /** How a secret sealed now would be protected — for the Devices panel's wording. */
  protection(): Promise<SecretProtection>;
  seal(plain: string): Promise<SealedSecret>;
  /**
   * The secret, and whether it should be sealed again (it was stored with less
   * protection than is now available, or the OS rotated its key).
   */
  open(sealed: SealedSecret): Promise<{ readonly plain: string; readonly reseal: boolean }>;
}

export function isSealedSecret(value: unknown): value is SealedSecret {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    o.v === 1 &&
    (o.kind === 'os' || o.kind === 'os-async' || o.kind === 'plain') &&
    typeof o.data === 'string'
  );
}

export function createSecretBox(
  safeStorage: SafeStorageLike | null | undefined,
  platform: NodeJS.Platform = process.platform,
): SecretBox {
  const syncAvailable = (): boolean => {
    try {
      return safeStorage?.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  };
  const asyncAvailable = async (): Promise<boolean> => {
    if (
      safeStorage?.isAsyncEncryptionAvailable === undefined ||
      safeStorage.encryptStringAsync === undefined ||
      safeStorage.decryptStringAsync === undefined
    ) {
      return false;
    }
    try {
      return (await safeStorage.isAsyncEncryptionAvailable()) === true;
    } catch {
      return false;
    }
  };
  const weakBackend = (): boolean => {
    if (platform !== 'linux') return false;
    try {
      return safeStorage?.getSelectedStorageBackend?.() === 'basic_text';
    } catch {
      return false;
    }
  };

  const protection = async (): Promise<SecretProtection> => {
    if (!(await asyncAvailable()) && !syncAvailable()) return 'none';
    return weakBackend() ? 'weak' : 'os';
  };

  return {
    protection,
    async seal(plain) {
      if (safeStorage !== null && safeStorage !== undefined) {
        if (await asyncAvailable()) {
          const buf = await (safeStorage.encryptStringAsync as (p: string) => Promise<Buffer>)(
            plain,
          );
          return { v: 1, kind: 'os-async', data: Buffer.from(buf).toString('base64') };
        }
        if (syncAvailable()) {
          return { v: 1, kind: 'os', data: safeStorage.encryptString(plain).toString('base64') };
        }
      }
      return { v: 1, kind: 'plain', data: Buffer.from(plain, 'utf8').toString('base64') };
    },
    async open(sealed) {
      if (!isSealedSecret(sealed)) throw new SecretUnavailableError('Not a sealed secret.');
      const bytes = Buffer.from(sealed.data, 'base64');
      if (sealed.kind === 'plain') {
        // Stored unprotected; seal it properly as soon as this machine can.
        return { plain: bytes.toString('utf8'), reseal: (await protection()) !== 'none' };
      }
      if (safeStorage === null || safeStorage === undefined) {
        throw new SecretUnavailableError('The system keychain is not available here.');
      }
      try {
        if (sealed.kind === 'os-async') {
          if (safeStorage.decryptStringAsync === undefined) {
            throw new Error('this build cannot open secrets sealed with the async API');
          }
          const r = await safeStorage.decryptStringAsync(bytes);
          return { plain: r.result, reseal: r.shouldReEncrypt === true };
        }
        return { plain: safeStorage.decryptString(bytes), reseal: false };
      } catch (error) {
        /*
         * Keychain access denied, a devices.json copied from another machine or
         * user, or a rotated key that cannot open it: the secret is gone, and
         * the device has to be paired again. Said plainly, never swallowed.
         */
        throw new SecretUnavailableError(
          `The saved secret could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
