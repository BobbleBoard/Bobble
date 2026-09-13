import { describe, expect, it } from 'vitest';
import {
  effectiveLaunchConfig,
  KNOB_ENGINES,
  knobById,
  knobEngines,
  PORTABLE_KNOBS,
  portableFlagsFor,
  resolveKnob,
} from './portable-knobs.js';

const ctx = (knobs: Record<string, string | number | boolean>, engineLaunch = {}) => ({
  knobs,
  engineLaunch,
});

describe('portable knobs', () => {
  it('every knob has a distinct id and at least two engines that spell it', () => {
    const ids = PORTABLE_KNOBS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const k of PORTABLE_KNOBS) expect(knobEngines(k).length).toBeGreaterThanOrEqual(2);
  });

  it('spells a context window in each engine that has one, and nowhere else', () => {
    const c = ctx({ context: 32768 });
    expect(portableFlagsFor('llamacpp', c)).toEqual({ '--ctx-size': 32768 });
    expect(portableFlagsFor('mlx-dspark', c)).toEqual({ '--context-window': 32768 });
    expect(portableFlagsFor('dflash-mlx', c)).toEqual({ '--dflash-max-ctx': 32768 });
    expect(portableFlagsFor('vllm', c)).toEqual({ '--max-model-len': 32768 });
    expect(portableFlagsFor('mlx-lm', c)).toEqual({});
    expect(portableFlagsFor('rapid-mlx', c)).toEqual({});
    expect(portableFlagsFor('omlx', c)).toEqual({});
    expect(portableFlagsFor('not-an-engine', c)).toEqual({});
  });

  it('KV quantization speaks each grammar and reads back', () => {
    for (const bits of ['off', '8', '4'] as const) {
      const c = ctx({ kvQuant: bits });
      const llama = portableFlagsFor('llamacpp', c);
      expect(llama['--cache-type-k']).toBe(llama['--cache-type-v']);
      expect(llama['--cache-type-k']).toBe(bits === '8' ? 'q8_0' : bits === '4' ? 'q4_0' : 'f16');
      expect(portableFlagsFor('rapid-mlx', c)).toEqual({
        '--kv-cache-dtype': bits === '8' ? 'int8' : bits === '4' ? 'int4' : 'bf16',
      });
      expect(portableFlagsFor('mlx-dspark', c)).toEqual({
        '--kv-bits': bits === 'off' ? 0 : Number(bits),
      });
      // and each spelling reads back to the same knob value (4 → 8 where 8 is all there is)
      const knob = knobById('kvQuant');
      if (knob === undefined) throw new Error('kvQuant');
      for (const e of knobEngines(knob)) {
        const spelling = knob.per[e];
        if (spelling === undefined) throw new Error(e);
        const back = spelling.read(spelling.write(bits));
        const lossy = e === 'dflash-mlx' || e === 'vllm';
        expect(back).toBe(lossy && bits === '4' ? '8' : bits);
      }
    }
  });

  it('scales units: MB on the knob, bytes on the engines that count bytes', () => {
    const c = ctx({ promptCacheMB: 2048 });
    expect(portableFlagsFor('llamacpp', c)).toEqual({ '--cache-ram': 2048 });
    expect(portableFlagsFor('mlx-lm', c)).toEqual({ '--prompt-cache-bytes': 2048 * 1024 * 1024 });
    expect(portableFlagsFor('dflash-mlx', c)).toEqual({
      '--prefix-cache-max-bytes': 2048 * 1024 * 1024,
    });
    expect(portableFlagsFor('rapid-mlx', c)).toEqual({ '--cache-memory-mb': 2048 });
  });

  it("an engine's own explicit flag wins over the knob", () => {
    const c = ctx({ context: 32768 }, { llamacpp: { flags: { '--ctx-size': 8192 }, rawArgs: [] } });
    expect(portableFlagsFor('llamacpp', c)).toEqual({});
    expect(effectiveLaunchConfig('llamacpp', c).flags).toEqual({ '--ctx-size': 8192 });
    // …and either cache-type flag set explicitly keeps the knob's hands off both
    const c2 = ctx(
      { kvQuant: '8' },
      { llamacpp: { flags: { '--cache-type-v': 'q4_0' }, rawArgs: [] } },
    );
    expect(portableFlagsFor('llamacpp', c2)).toEqual({});
  });

  it('carries a meaning set on one engine across to the others when no knob is set', () => {
    const c = ctx(
      {},
      { llamacpp: { flags: { '--ctx-size': 16384, '--parallel': 4 }, rawArgs: [] } },
    );
    expect(portableFlagsFor('mlx-dspark', c)).toEqual({
      '--context-window': 16384,
      '--max-batch': 4,
    });
    expect(portableFlagsFor('vllm', c)).toEqual({ '--max-model-len': 16384, '--max-num-seqs': 4 });
    const knob = knobById('context');
    if (knob === undefined) throw new Error('context');
    expect(resolveKnob(knob, { ...c, engine: 'mlx-dspark' })).toEqual({
      value: 16384,
      source: 'llamacpp',
    });
  });

  it('prefers the shared value, then the engine being launched, then a fixed order', () => {
    const knob = knobById('parallel');
    if (knob === undefined) throw new Error('parallel');
    const launch = {
      llamacpp: { flags: { '--parallel': 2 }, rawArgs: [] },
      'rapid-mlx': { flags: { '--max-num-seqs': 6 }, rawArgs: [] },
    };
    expect(
      resolveKnob(knob, { knobs: { parallel: 3 }, engineLaunch: launch, engine: 'omlx' }),
    ).toEqual({
      value: 3,
      source: 'shared',
    });
    expect(resolveKnob(knob, { knobs: {}, engineLaunch: launch, engine: 'rapid-mlx' })).toEqual({
      value: 6,
      source: 'rapid-mlx',
    });
    expect(resolveKnob(knob, { knobs: {}, engineLaunch: launch, engine: 'omlx' })).toEqual({
      value: 2,
      source: 'llamacpp',
    });
    expect(resolveKnob(knob, { knobs: {}, engineLaunch: {}, engine: 'omlx' })).toBeNull();
  });

  it('an absent or empty flag reads as unset, not as zero', () => {
    const kv = knobById('kvQuant');
    if (kv === undefined) throw new Error('kvQuant');
    expect(kv.per['mlx-dspark']?.read({})).toBeUndefined();
    expect(kv.per['mlx-dspark']?.read({ '--kv-bits': '' })).toBeUndefined();
    expect(kv.per['mlx-dspark']?.read({ '--kv-bits': 0 })).toBe('off');
    expect(portableFlagsFor('vllm', ctx({}, { llamacpp: { flags: {}, rawArgs: [] } }))).toEqual({});
  });

  it('an empty string is no value', () => {
    expect(portableFlagsFor('llamacpp', ctx({ context: '' }))).toEqual({});
    expect(portableFlagsFor('llamacpp', ctx({ context: 'lots' }))).toEqual({});
  });

  it('the engine list is the one the app launches', () => {
    expect(KNOB_ENGINES).toEqual([
      'llamacpp',
      'mlx-lm',
      'rapid-mlx',
      'dflash-mlx',
      'mlx-dspark',
      'omlx',
      'vllm',
    ]);
  });
});
