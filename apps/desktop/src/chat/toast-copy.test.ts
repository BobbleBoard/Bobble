import { describe, expect, it } from 'vitest';
import { toastCopy } from './toast-copy';

describe('toastCopy — a failure toast says what happened, never the raw line', () => {
  it('stays quiet for the bridge, which has its own toast', () => {
    expect(toastCopy('pi exited (143).')).toBeNull();
    expect(toastCopy('pi bridge error: stdin: Error: write EPIPE')).toBeNull();
  });
  it('names each engine line plainly', () => {
    expect(toastCopy('Loop guard aborted the turn: 6 identical calls.')?.title).toBe(
      'The turn was stopped',
    );
    expect(
      toastCopy('Compaction failed: llama-server http 500 {"error":1}')?.description,
    ).not.toMatch(/http|error/);
    expect(toastCopy('Extension error: TypeError: x is undefined')?.description).not.toMatch(
      /TypeError/,
    );
    expect(toastCopy('pi rejected set_model: model not found')?.title).toBe(
      'That did not go through',
    );
    expect(toastCopy('Unknown effort "ultra".')?.title).toBe('That setting did not apply');
  });
  it('keeps a sentence the app already wrote for people', () => {
    expect(toastCopy('Could not open that chat. Try again.')?.description).toBe(
      'Could not open that chat. Try again.',
    );
  });
  it('says anything else through plainError', () => {
    expect(toastCopy('TypeError: fetch failed')?.description).toMatch(/reach the internet/);
    expect(toastCopy("ENOENT: no such file or directory, open '/x'")?.description).toMatch(
      /not there any more/,
    );
  });
});
