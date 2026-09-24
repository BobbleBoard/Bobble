/**
 * Paths two worktrees must not share (harness.mjs): the default screenshot
 * directory and stable probe homes carry the worktree's tag, and the tag can
 * never make a stable home look like a throwaway one the harness deletes.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - the harness is plain ESM for probes, not typed app code.
import { isThrowawayHome, tagged, worktreeTag } from './harness.mjs';

describe('worktreeTag', () => {
  it('is the worktree directory for a .claude/worktrees checkout', () => {
    expect(worktreeTag({}, '/Users/j/OSS-harness/.claude/worktrees/push-w0-b')).toBe('push-w0-b');
  });

  it('is empty for the main checkout, so its paths stay as they were', () => {
    expect(worktreeTag({}, '/Users/j/OSS-harness')).toBe('');
  });

  it('prefers PD_WORKTREE_TAG, reduced to file-name-safe characters', () => {
    expect(worktreeTag({ PD_WORKTREE_TAG: 'vq kit/2' }, '/x/.claude/worktrees/y')).toBe('vq-kit-2');
    expect(worktreeTag({ PD_WORKTREE_TAG: '' }, '/x/.claude/worktrees/y')).toBe('');
  });
});

describe('tagged', () => {
  it('joins with @ and leaves an untagged base alone', () => {
    expect(tagged('pd-home-chat-order', 'push-w0-b')).toBe('pd-home-chat-order@push-w0-b');
    expect(tagged('pd-home-chat-order', '')).toBe('pd-home-chat-order');
  });
});

describe('isThrowawayHome', () => {
  const tmp = '/var/folders/ab/T';
  it('recognises a mkdtemp home', () => {
    expect(isThrowawayHome(path.join(tmp, 'pd-home-probe-Ab12Cd'), tmp)).toBe(true);
  });

  it('never deletes a stable home, even when the tag ends in six letters', () => {
    // `-office` is six characters — the exact shape of a mkdtemp suffix.
    expect(isThrowawayHome(path.join(tmp, tagged('pd-home-probe', 'vq-office')), tmp)).toBe(false);
    expect(isThrowawayHome(path.join(tmp, 'pd-home-probe'), tmp)).toBe(false);
  });

  it('never deletes a home outside the temp dir', () => {
    expect(isThrowawayHome('/Users/user/pd-home-probe-Ab12Cd', tmp)).toBe(false);
  });
});
