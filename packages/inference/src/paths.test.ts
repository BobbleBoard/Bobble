import { describe, expect, it } from 'vitest';
import { excludeCacheFromIndexing, rerootRecorded } from './paths.js';

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

describe('rerootRecorded', () => {
  it('re-roots a marker path recorded under the old support-root name', () => {
    expect(
      rerootRecorded(
        '/Users/me/.cache/pi-desktop/llamacpp/b10603/llama-b10603/llama-server',
        '/Users/me/.cache/bobble/llamacpp/b10603',
      ),
    ).toBe('/Users/me/.cache/bobble/llamacpp/b10603/llama-b10603/llama-server');
  });
  it('leaves a path that already lives under the dir unchanged', () => {
    expect(rerootRecorded('/c/llamacpp/x/build/bin/llama-server', '/c/llamacpp/x')).toBe(
      '/c/llamacpp/x/build/bin/llama-server',
    );
  });
  it('returns the recorded path when it does not share the dir’s last segment', () => {
    expect(rerootRecorded('/elsewhere/llama-server', '/c/llamacpp/x')).toBe(
      '/elsewhere/llama-server',
    );
  });
});
