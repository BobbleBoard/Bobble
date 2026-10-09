/**
 * A FILE A TURN WROTE IS LOOKED UP WHERE IT IS. The user (2026-10-08): "'this file
 * couldn't be found' (when clicking on a file that should very much be
 * there)". Two of the misses: a `cd` before the redirect, and `~` taken as a
 * folder inside the chat's.
 */
import { describe, expect, it } from 'vitest';
import { bashWorkingDir, resolvePath } from './file-writes';

describe('bashWorkingDir — where a redirect lands after a cd', () => {
  it('follows the cd chained before the redirect', () => {
    expect(bashWorkingDir('cd reports && echo hi > out.md')).toBe('reports');
    expect(bashWorkingDir('cd a; cd "b c" && cat x > y.md')).toBe('b c');
    expect(bashWorkingDir('mkdir -p out && cd out && python3 make.py > log.txt')).toBe('out');
  });
  it('is nothing when there is no cd before it', () => {
    expect(bashWorkingDir('echo hi > out.md')).toBeUndefined();
    expect(bashWorkingDir('echo hi > out.md && cd elsewhere')).toBeUndefined();
    expect(bashWorkingDir('python3 -c "import os; os.chdir(\'x\')" > y.md')).toBeUndefined();
  });
});

describe('resolvePath — the home folder is main’s to expand', () => {
  it('leaves ~ alone instead of joining it onto the chat folder', () => {
    expect(resolvePath('/w/chat', '~/notes/a.md')).toBe('~/notes/a.md');
    expect(resolvePath('/w/chat', 'notes/a.md')).toBe('/w/chat/notes/a.md');
  });
});
