import { describe, expect, it } from 'vitest';
import { flagLabel, humanizeFlag } from './flag-names';

describe('flagLabel', () => {
  it('names the flags people reach for', () => {
    expect(flagLabel({ key: '--ctx-size', aliases: ['-c', '--ctx-size'] })).toBe('Context window');
    expect(flagLabel({ key: '--n-gpu-layers' })).toBe('GPU layers');
    expect(flagLabel({ key: '--spec-draft-n-max' })).toBe('Draft tokens (max)');
    expect(flagLabel({ key: '--kv-cache-dtype' })).toBe('KV cache quantization');
  });

  it('names a flag by an alias when only the alias is known', () => {
    expect(flagLabel({ key: '--predict', aliases: ['-n', '--predict', '--n-predict'] })).toBe(
      'Max reply length',
    );
  });

  it('derives a readable name for anything else, expanding the engines’ abbreviations', () => {
    expect(humanizeFlag('--spec-draft-ngl-batch')).toBe('Draft GPU layers batch');
    expect(humanizeFlag('--embd-gemma-default')).toBe('Embedding gemma default');
    expect(humanizeFlag('--cpu-mask-batch')).toBe('CPU mask batch');
    expect(humanizeFlag('--some-new-flag')).toBe('Some new flag');
    // Never the literal flag.
    expect(flagLabel({ key: '--pflash-keep-ratio' })).not.toMatch(/^-/);
  });
});
