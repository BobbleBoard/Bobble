/**
 * b18: a copy of every file a turn is about to change.
 *
 * The only way to undo a turn was git, if the work happened to be in a repo and
 * happened to be committed. The failure modes worth pinning are the ones that
 * make a safety net worse than none: corrupting what it protected, and growing
 * without bound.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capture, KEEP_TURNS, MAX_CHECKPOINT_BYTES, prune, restore } from './checkpoints.js';

let root: string;
let work: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pd-cp-'));
  work = mkdtempSync(path.join(os.tmpdir(), 'pd-work-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

/** A capture the test needs to have happened; null fails here rather than at the restore. */
function captured(...args: Parameters<typeof capture>) {
  const cp = capture(...args);
  if (cp === null) throw new Error('capture returned null');
  return cp;
}

describe('capture + restore', () => {
  it('puts a file back exactly as it was', () => {
    const f = path.join(work, 'a.ts');
    writeFileSync(f, 'const before = 1;\n');
    const cp = captured(root, 1, f);
    writeFileSync(f, 'const after = 2;\n');
    expect(restore(cp)).toEqual({ ok: true });
    expect(readFileSync(f, 'utf8')).toBe('const before = 1;\n');
  });

  it('does not corrupt a binary', () => {
    // The fence's own snapshot reads utf8, which mangles anything non-text —
    // a checkpoint that damages what it protected is worse than none.
    const f = path.join(work, 'img.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
    writeFileSync(f, bytes);
    const cp = captured(root, 1, f);
    writeFileSync(f, Buffer.from([0x00]));
    restore(cp);
    expect(readFileSync(f).equals(bytes)).toBe(true);
  });

  it('records a CREATED file as having no backup, and restoring deletes it', () => {
    // Pretending it had empty content would leave an empty file behind.
    const f = path.join(work, 'new.ts');
    const cp = captured(root, 1, f);
    expect(cp).toEqual({ target: f, backup: null, bytes: 0 });
    writeFileSync(f, 'created by the turn');
    expect(restore(cp)).toEqual({ ok: true });
    expect(existsSync(f)).toBe(false);
  });

  it('restores into a directory the turn removed', () => {
    const dir = path.join(work, 'nested');
    mkdirSync(dir);
    const f = path.join(dir, 'a.ts');
    writeFileSync(f, 'x');
    const cp = captured(root, 1, f);
    rmSync(dir, { recursive: true, force: true });
    expect(restore(cp).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('x');
  });

  it('skips a file too large to be worth shadowing', () => {
    const f = path.join(work, 'big.bin');
    writeFileSync(f, Buffer.alloc(MAX_CHECKPOINT_BYTES + 1));
    expect(capture(root, 1, f)).toBeNull();
  });

  it('never throws on an unreadable target', () => {
    expect(capture(root, 1, path.join(work, 'nested', 'deep', 'gone.ts'))).toEqual({
      target: path.join(work, 'nested', 'deep', 'gone.ts'),
      backup: null,
      bytes: 0,
    });
    expect(capture('/nope/cannot/write/here', 1, path.join(work, 'x'))).toBeTruthy();
  });

  it('reports a missing backup rather than claiming success', () => {
    const f = path.join(work, 'a.ts');
    writeFileSync(f, 'v1');
    const cp = captured(root, 1, f);
    rmSync(cp.backup as string, { force: true });
    expect(restore(cp).ok).toBe(false);
  });
});

describe('prune', () => {
  it('keeps the newest turns and drops the rest', () => {
    for (let i = 1; i <= KEEP_TURNS + 5; i++) {
      const f = path.join(work, `f${i}.ts`);
      writeFileSync(f, String(i));
      capture(root, i, f);
    }
    prune(root);
    expect(existsSync(path.join(root, String(KEEP_TURNS + 5)))).toBe(true);
    expect(existsSync(path.join(root, '1'))).toBe(false);
  });

  it('orders turns numerically — turn 10 is newer than turn 9', () => {
    // Sorting the directory names as strings deletes 10 before 9.
    for (const n of [8, 9, 10]) {
      const f = path.join(work, `f${n}.ts`);
      writeFileSync(f, String(n));
      capture(root, n, f);
    }
    prune(root, 2);
    expect(existsSync(path.join(root, '10'))).toBe(true);
    expect(existsSync(path.join(root, '9'))).toBe(true);
    expect(existsSync(path.join(root, '8'))).toBe(false);
  });

  it('is silent on a root that does not exist', () => {
    expect(() => prune('/nope/not/here')).not.toThrow();
  });
});
