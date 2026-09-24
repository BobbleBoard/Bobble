import { describe, expect, it, vi } from 'vitest';
import {
  REMOVE_OPTIONS,
  RENAME_RETRY_DELAYS_MS,
  type RetryFs,
  removeRetrying,
  renameRetrying,
} from './win-fs.js';

const held = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** A rename that fails `failures` times with `code`, then succeeds; sleeps are recorded. */
function fakeFs(platform: string, failures: number, code = 'EPERM', destIsDir = false) {
  const sleeps: number[] = [];
  let calls = 0;
  const fs: RetryFs = {
    platform,
    rename: async () => {
      calls++;
      if (calls <= failures) throw held(code);
    },
    isDirectory: async () => destIsDir,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { fs, sleeps, calls: () => calls };
}

describe('renameRetrying', () => {
  it.each([
    'EPERM',
    'EACCES',
    'EBUSY',
  ])('waits out a Windows scanner holding the file (%s)', async (code) => {
    const f = fakeFs('win32', 3, code);
    await renameRetrying('a', 'b', f.fs);
    expect(f.calls()).toBe(4);
    expect(f.sleeps).toEqual([100, 200, 400]);
  });

  it('gives up after 9.5 s of waiting and reports the last error', async () => {
    const f = fakeFs('win32', 99, 'EBUSY');
    await expect(renameRetrying('a', 'b', f.fs)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(f.sleeps).toEqual([...RENAME_RETRY_DELAYS_MS]);
    expect(f.sleeps.reduce((s, ms) => s + ms, 0)).toBe(9_500);
    expect(f.calls()).toBe(RENAME_RETRY_DELAYS_MS.length + 1);
  });

  it('does not wait on a destination folder that exists: Windows never renames onto one', async () => {
    const f = fakeFs('win32', 99, 'EPERM', true);
    await expect(renameRetrying('a', 'b', f.fs)).rejects.toMatchObject({ code: 'EPERM' });
    expect(f.calls()).toBe(1);
    expect(f.sleeps).toEqual([]);
  });

  it.each([
    'darwin',
    'linux',
  ])('reports the error at once on %s (a real permission problem)', async (platform) => {
    const f = fakeFs(platform, 1, 'EPERM');
    await expect(renameRetrying('a', 'b', f.fs)).rejects.toMatchObject({ code: 'EPERM' });
    expect(f.calls()).toBe(1);
    expect(f.sleeps).toEqual([]);
  });

  it('does not retry other errors on Windows', async () => {
    const f = fakeFs('win32', 1, 'ENOENT');
    await expect(renameRetrying('a', 'b', f.fs)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.sleeps).toEqual([]);
  });
});

describe('removeRetrying', () => {
  it('asks rm for its retries, which Node applies only in recursive mode', async () => {
    const rm = vi.fn(async () => {});
    await removeRetrying('/x/file.download', rm);
    expect(rm).toHaveBeenCalledWith('/x/file.download', REMOVE_OPTIONS);
    expect(REMOVE_OPTIONS).toEqual({
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
});
