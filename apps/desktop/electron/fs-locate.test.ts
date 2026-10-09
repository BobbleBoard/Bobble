/**
 * WHERE A NAMED FILE ACTUALLY IS — the user (2026-10-08): "'this file couldn't be
 * found' (when clicking on a file that should very much be there)". A path a
 * turn reported can miss by a folder; locateFile finds the file it meant.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: {} }));
vi.mock('./project/project-main', () => ({ activeProjectFullAccess: () => false }));

const { locateFile } = await import('./fs-handlers');

function tree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pd-locate-'));
  mkdirSync(path.join(root, 'chat-a', 'reports'), { recursive: true });
  mkdirSync(path.join(root, 'chat-b', 'reports'), { recursive: true });
  mkdirSync(path.join(root, 'chat-b', 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(root, 'chat-a', 'reports', 'summary.md'), 'a');
  writeFileSync(path.join(root, 'chat-b', 'summary.md'), 'b');
  writeFileSync(path.join(root, 'chat-b', 'node_modules', 'x', 'only-here.md'), 'nm');
  return root;
}

describe('locateFile', () => {
  it('a path that is there is itself', () => {
    const root = tree();
    const p = path.join(root, 'chat-b', 'summary.md');
    expect(locateFile(p, [])).toBe(p);
  });
  it('a relative path is tried under each root', () => {
    const root = tree();
    expect(
      locateFile('reports/summary.md', [path.join(root, 'chat-b'), path.join(root, 'chat-a')]),
    ).toBe(path.join(root, 'chat-a', 'reports', 'summary.md'));
  });
  it('a path that missed by a folder is found by name, the closest match winning', () => {
    const root = tree();
    // Reported under a folder the chat no longer uses.
    const reported = '/somewhere/else/reports/summary.md';
    expect(locateFile(reported, [root])).toBe(path.join(root, 'chat-a', 'reports', 'summary.md'));
  });
  it('never walks into generated folders, and gives up honestly', () => {
    const root = tree();
    expect(locateFile('/x/only-here.md', [root])).toBeNull();
    expect(locateFile('/x/not-anywhere.md', [root])).toBeNull();
    expect(locateFile('', [root])).toBeNull();
  });
});
