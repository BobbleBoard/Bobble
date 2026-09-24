import { describe, expect, it, vi } from 'vitest';
import {
  createSecretBox,
  isSealedSecret,
  type SafeStorageLike,
  SecretUnavailableError,
} from './secret-box';

/**
 * A stand-in for Electron's safeStorage: reversible, keyed, and visibly not
 * the plaintext — enough to prove the box calls the right API and never
 * writes the secret itself.
 */
function fakeSafeStorage(
  opts: {
    sync?: boolean;
    async?: boolean;
    backend?: string;
    rotate?: boolean;
    broken?: boolean;
  } = {},
): SafeStorageLike & { calls: string[] } {
  const calls: string[] = [];
  const key = 0x5a;
  const enc = (s: string, tag: string) =>
    Buffer.concat([Buffer.from(tag), Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ key))]);
  const dec = (b: Buffer, tag: string) => {
    if (opts.broken === true || b.subarray(0, tag.length).toString() !== tag) {
      throw new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
      );
    }
    return Buffer.from(b.subarray(tag.length).map((x) => x ^ key)).toString('utf8');
  };
  const s: SafeStorageLike & { calls: string[] } = {
    calls,
    isEncryptionAvailable: () => opts.sync ?? true,
    encryptString: (p) => {
      calls.push('encryptString');
      return enc(p, 'S1');
    },
    decryptString: (b) => {
      calls.push('decryptString');
      return dec(b, 'S1');
    },
    ...(opts.backend !== undefined
      ? { getSelectedStorageBackend: () => opts.backend as string }
      : {}),
  };
  if (opts.async === true) {
    s.isAsyncEncryptionAvailable = async () => true;
    s.encryptStringAsync = async (p) => {
      calls.push('encryptStringAsync');
      return enc(p, 'A1');
    };
    s.decryptStringAsync = async (b) => {
      calls.push('decryptStringAsync');
      return { result: dec(b, 'A1'), shouldReEncrypt: opts.rotate === true };
    };
  }
  return s;
}

const SECRET = 'bdt_4mYl0fQ1cQh6H6JXbq9mQ9wz1l7m3n9pQ2r5s8t0u1v';

describe('the secret box', () => {
  it('seals with the OS keychain and never writes the secret itself', async () => {
    const ss = fakeSafeStorage();
    const box = createSecretBox(ss, 'darwin');
    const sealed = await box.seal(SECRET);
    expect(sealed.kind).toBe('os');
    expect(isSealedSecret(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(Buffer.from(sealed.data, 'base64').toString('latin1')).not.toContain(SECRET);
    expect(await box.open(sealed)).toEqual({ plain: SECRET, reseal: false });
    expect(await box.protection()).toBe('os');
  });

  it('prefers the async API when it is there, and opens with the same one', async () => {
    const ss = fakeSafeStorage({ async: true });
    const box = createSecretBox(ss, 'darwin');
    const sealed = await box.seal(SECRET);
    expect(sealed.kind).toBe('os-async');
    expect(await box.open(sealed)).toEqual({ plain: SECRET, reseal: false });
    expect(ss.calls).toEqual(['encryptStringAsync', 'decryptStringAsync']);
    // A secret sealed earlier with the sync API still opens with the sync API.
    const old = await createSecretBox(fakeSafeStorage(), 'darwin').seal(SECRET);
    expect((await box.open(old)).plain).toBe(SECRET);
  });

  it('asks for a re-seal when the OS rotated its key', async () => {
    const box = createSecretBox(fakeSafeStorage({ async: true, rotate: true }), 'darwin');
    expect((await box.open(await box.seal(SECRET))).reseal).toBe(true);
  });

  it('says "weak" on Linux with only basic_text, where "encrypted" is effectively plain text', async () => {
    const box = createSecretBox(fakeSafeStorage({ backend: 'basic_text' }), 'linux');
    expect(await box.protection()).toBe('weak');
    expect((await box.seal(SECRET)).kind).toBe('os');
    expect(
      await createSecretBox(fakeSafeStorage({ backend: 'gnome_libsecret' }), 'linux').protection(),
    ).toBe('os');
    // The backend name means nothing off Linux.
    expect(
      await createSecretBox(fakeSafeStorage({ backend: 'basic_text' }), 'darwin').protection(),
    ).toBe('os');
  });

  it('stores unprotected — and says so — when no encryption is available, then upgrades', async () => {
    const unavailable = createSecretBox(fakeSafeStorage({ sync: false }), 'linux');
    expect(await unavailable.protection()).toBe('none');
    const sealed = await unavailable.seal(SECRET);
    expect(sealed.kind).toBe('plain');
    expect(await unavailable.open(sealed)).toEqual({ plain: SECRET, reseal: false });
    // Later, on a machine (or a run) that can protect it: open, and ask for a re-seal.
    expect(await createSecretBox(fakeSafeStorage(), 'linux').open(sealed)).toEqual({
      plain: SECRET,
      reseal: true,
    });
    // No safeStorage at all (not Electron).
    expect((await createSecretBox(null).seal(SECRET)).kind).toBe('plain');
  });

  it('says plainly when a sealed secret cannot be opened (another machine, denied keychain)', async () => {
    const sealed = await createSecretBox(fakeSafeStorage(), 'darwin').seal(SECRET);
    await expect(
      createSecretBox(fakeSafeStorage({ broken: true }), 'darwin').open(sealed),
    ).rejects.toBeInstanceOf(SecretUnavailableError);
    await expect(createSecretBox(null).open(sealed)).rejects.toBeInstanceOf(SecretUnavailableError);
    await expect(
      createSecretBox(fakeSafeStorage(), 'darwin').open({
        v: 1,
        kind: 'os-async',
        data: sealed.data,
      }),
    ).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it('treats a throwing availability check as unavailable', async () => {
    const ss = fakeSafeStorage();
    ss.isEncryptionAvailable = vi.fn(() => {
      throw new Error('called before ready');
    });
    const box = createSecretBox(ss, 'win32');
    expect(await box.protection()).toBe('none');
    expect((await box.seal(SECRET)).kind).toBe('plain');
  });

  it('recognises only well-formed sealed secrets', () => {
    expect(isSealedSecret({ v: 1, kind: 'os', data: '' })).toBe(true);
    for (const bad of [
      null,
      {},
      { v: 2, kind: 'os', data: '' },
      { v: 1, kind: 'rot13', data: '' },
      { v: 1, kind: 'os' },
    ]) {
      expect(isSealedSecret(bad)).toBe(false);
    }
  });
});
