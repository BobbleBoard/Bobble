/**
 * Two independent choosers can now ask for the same llama-server knob — the
 * per-hardware perf args (their own RAM estimate) and the live power policy
 * (measured pressure). llama.cpp takes the LAST value for a repeated flag, so
 * without this the winner would depend on array order rather than on intent.
 */
import { describe, expect, it } from 'vitest';
import { dedupeFlags } from './launch-args';

describe('dedupeFlags', () => {
  it('keeps the last value for a repeated flag', () => {
    expect(dedupeFlags(['--cache-type-k', 'f16', '--cache-type-k', 'q8_0'])).toEqual([
      '--cache-type-k',
      'q8_0',
    ]);
  });

  it('preserves the order the flags first appeared in', () => {
    expect(dedupeFlags(['-c', '4096', '-fa', 'on', '-c', '8192'])).toEqual([
      '-c',
      '8192',
      '-fa',
      'on',
    ]);
  });

  it('keeps a bare switch once', () => {
    expect(dedupeFlags(['--no-kv-offload', '--no-kv-offload'])).toEqual(['--no-kv-offload']);
  });

  it('does not swallow the value after a bare switch', () => {
    expect(dedupeFlags(['--no-kv-offload', '-t', '4'])).toEqual(['--no-kv-offload', '-t', '4']);
  });

  it('leaves an already-clean list alone', () => {
    const args = ['--chat-template-file', '/tmp/t.jinja', '-fa', 'on'];
    expect(dedupeFlags(args)).toEqual(args);
  });

  it('is empty for empty input', () => {
    expect(dedupeFlags([])).toEqual([]);
  });
});
