import { describe, expect, it } from 'vitest';
import { excludeCacheFromIndexing } from './paths.js';

describe('excludeCacheFromIndexing', () => {
  it('writes the marker once and reports which it did', async () => {
    const written: string[] = [];
    let present = false;
    const deps = {
      root: '/tmp/x',
      mkdir: async () => undefined,
      writeFile: async (file: string) => {
        written.push(file);
        present = true;
      },
      exists: async () => present,
    };
    expect(await excludeCacheFromIndexing(deps)).toBe('created');
    expect(written).toEqual(['/tmp/x/.metadata_never_index']);
    expect(await excludeCacheFromIndexing(deps)).toBe('present');
    expect(written).toHaveLength(1);
  });

  it('is best-effort: an unwritable root is reported, not thrown', async () => {
    const r = await excludeCacheFromIndexing({
      root: '/nope',
      mkdir: async () => {
        throw new Error('EROFS');
      },
      writeFile: async () => undefined,
      exists: async () => false,
    });
    expect(r).toBe('failed');
  });
});
