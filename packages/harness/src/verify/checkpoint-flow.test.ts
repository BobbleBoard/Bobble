/**
 * b18: the checkpoint loop as the harness runs it.
 *
 * `capture` and `restore` are covered on their own; what this pins is the part
 * that made the old design wrong — WHERE it hooks. The pre-write `tool_call`
 * hook is the only moment the previous content still exists: the `edit` tool's
 * result hook fires solely on `isError`, so a successful edit would never be
 * captured at all.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Checkpoint, capture, restore } from './checkpoints.js';

let root: string;
let work: string;

/** What the harness does on `tool_call` for a write/edit, in miniature. */
function onWrite(turn: number, target: string, checkpoints: Checkpoint[]): void {
  const cp = capture(root, turn, target);
  if (cp !== null) checkpoints.push(cp);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pd-cpflow-'));
  work = mkdtempSync(path.join(os.tmpdir(), 'pd-cpwork-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('a turn that changes several files', () => {
  it('can put each one back independently', () => {
    const a = path.join(work, 'a.ts');
    const b = path.join(work, 'b.ts');
    writeFileSync(a, 'A0');
    writeFileSync(b, 'B0');
    const turn: Checkpoint[] = [];

    onWrite(1, a, turn);
    writeFileSync(a, 'A1');
    onWrite(1, b, turn);
    writeFileSync(b, 'B1');

    expect(turn).toHaveLength(2);
    restore(turn[0] as Checkpoint);
    expect(readFileSync(a, 'utf8')).toBe('A0');
    // The other file is untouched by that restore.
    expect(readFileSync(b, 'utf8')).toBe('B1');
  });

  it('captures the state before the FIRST write, not the latest one', () => {
    // A turn that edits the same file twice must restore to where the TURN
    // started, not to the intermediate state — which is why the recorder skips
    // a path it has already seen.
    const f = path.join(work, 'a.ts');
    writeFileSync(f, 'v0');
    const turn: Checkpoint[] = [];
    const seen = new Set<string>();

    for (const next of ['v1', 'v2']) {
      if (!seen.has(f)) {
        seen.add(f);
        onWrite(1, f, turn);
      }
      writeFileSync(f, next);
    }

    expect(turn).toHaveLength(1);
    restore(turn[0] as Checkpoint);
    expect(readFileSync(f, 'utf8')).toBe('v0');
  });

  it('undoes a file the turn created', () => {
    const f = path.join(work, 'new.ts');
    const turn: Checkpoint[] = [];
    onWrite(1, f, turn);
    writeFileSync(f, 'created');
    expect(existsSync(f)).toBe(true);
    restore(turn[0] as Checkpoint);
    expect(existsSync(f)).toBe(false);
  });

  it('keeps turns separate, so an old change is still restorable', () => {
    const f = path.join(work, 'a.ts');
    writeFileSync(f, 'v0');
    const t1: Checkpoint[] = [];
    onWrite(1, f, t1);
    writeFileSync(f, 'v1');

    const t2: Checkpoint[] = [];
    onWrite(2, f, t2);
    writeFileSync(f, 'v2');

    restore(t1[0] as Checkpoint);
    expect(readFileSync(f, 'utf8')).toBe('v0');
  });
});
