import { describe, expect, it } from 'vitest';
import { pickLibllama } from './engine-select.js';
import { variantArchiveUrl } from './llamacpp-source-build.js';
import {
  architecturesIn,
  K2_HORIZON_VARIANT,
  LLAMACPP_VARIANTS,
  resolveEngine,
  variantArchitectures,
  variantForArchitecture,
} from './llamacpp-variants.js';

/** A stand-in for libllama: C strings, NUL-delimited, exactly as the table holds them. */
const libWith = (...archs: string[]): Uint8Array =>
  Buffer.from(`\0${archs.join('\0')}\0some other symbol\0`, 'latin1');

describe('engine variants', () => {
  it('routes a model to the variant that declares its architecture', () => {
    expect(variantForArchitecture('k2-horizon')).toBe(K2_HORIZON_VARIANT);
    expect(variantForArchitecture('K2-Horizon')).toBe(K2_HORIZON_VARIANT);
    expect(variantForArchitecture('qwen35')).toBeUndefined();
  });

  it('leaves everything else on the pinned release', () => {
    expect(resolveEngine('qwen35')).toEqual({ kind: 'pinned', reason: 'no-variant' });
    expect(resolveEngine(undefined)).toEqual({ kind: 'pinned', reason: 'no-variant' });
    expect(resolveEngine('')).toEqual({ kind: 'pinned', reason: 'no-variant' });
  });

  it('uses the variant when the pinned engine does not have the architecture', () => {
    const pinned = architecturesIn(libWith('qwen35', 'bailingmoe3'), variantArchitectures());
    const choice = resolveEngine('k2-horizon', pinned);
    expect(choice).toEqual({ kind: 'variant', variant: K2_HORIZON_VARIANT });
  });

  /*
   * The reason this whole arrangement is safe to add: it ends by itself. Nobody
   * has to watch the upstream PR, and a stale fork cannot outlive its purpose.
   */
  it('RETIRES the variant the moment a pinned engine gains the architecture', () => {
    const caughtUp = architecturesIn(libWith('qwen35', 'k2-horizon'), variantArchitectures());
    expect(resolveEngine('k2-horizon', caughtUp)).toEqual({ kind: 'pinned', reason: 'supported' });
  });

  it('treats an unreadable engine as "unknown" and keeps the variant, never as "supported"', () => {
    // `undefined` is what engineArchitectures returns when libllama cannot be
    // read. Guessing "supported" there hands a model to an engine that cannot
    // load it; guessing "unsupported" only costs a build that already exists.
    expect(resolveEngine('k2-horizon', undefined)).toEqual({
      kind: 'variant',
      variant: K2_HORIZON_VARIANT,
    });
  });

  describe('architecturesIn', () => {
    it('will not let one architecture name match inside another', () => {
      // "qwen3" must not be reported from a binary that only has "qwen35" —
      // a false positive here silently routes a model to the wrong engine.
      const found = architecturesIn(libWith('qwen35'), ['qwen3', 'qwen35']);
      expect(found.has('qwen35')).toBe(true);
      expect(found.has('qwen3')).toBe(false);
    });

    it('only ever reports names it was asked about', () => {
      const found = architecturesIn(libWith('k2-horizon', 'llama'), ['k2-horizon']);
      expect([...found]).toEqual(['k2-horizon']);
    });
  });

  describe('the declared set', () => {
    it('pins a full commit sha, never a branch — this is a binary users execute', () => {
      for (const v of LLAMACPP_VARIANTS) {
        expect(v.source.commit).toMatch(/^[0-9a-f]{40}$/);
      }
    });

    it('declares at least one architecture each, or it can never be selected', () => {
      for (const v of LLAMACPP_VARIANTS) expect(v.architectures.length).toBeGreaterThan(0);
    });

    it('builds a source URL from the pinned commit', () => {
      expect(variantArchiveUrl(K2_HORIZON_VARIANT)).toBe(
        'https://github.com/MBZUAI-IFM/llama.cpp/archive/35999d101cf2233fc54f09c3c8d599da7303ce02.tar.gz',
      );
    });
  });
});

describe('finding the library that holds the architecture table', () => {
  /*
   * A build tree is full of near-misses. Getting this wrong does not error — it
   * reports an engine that supports nothing, with confidence.
   */
  it('picks the core libllama out of a real build directory', () => {
    const realBuildDir = [
      'ggml-metal-tuning',
      'libggml-base.0.dylib',
      'libllama-batched-bench-impl.dylib',
      'libllama-bench-impl.dylib',
      'libllama-cli-impl.dylib',
      'libllama-common.0.3.0.dylib',
      'libllama-server-impl.dylib',
      'libllama.0.3.0.dylib',
      'libllama.0.dylib',
      'libllama.dylib',
      'llama-server',
    ];
    expect(pickLibllama(realBuildDir)).toBe('libllama.dylib');
  });

  it('takes the versioned core library when there is no bare symlink (the release tarball)', () => {
    expect(pickLibllama(['libllama.0.dylib', 'libllama-common.0.dylib'])).toBe('libllama.0.dylib');
  });

  it('never mistakes a helper for the core library', () => {
    expect(pickLibllama(['libllama-server-impl.dylib', 'libggml-base.dylib'])).toBeUndefined();
  });
});
