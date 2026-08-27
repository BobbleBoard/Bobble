/**
 * b11: the `@` picker has to be able to reach every part of the project.
 *
 * The walk was depth-first under a fixed budget, so the first big subtree spent
 * it and everything after was invisible — not ranked low, ABSENT. Measured on
 * the repo at the shipped settings: an empty `@` collected 618 entries and
 * `scripts/` and `tools/` never appeared.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsHandlers } from './fs-handlers';

let root: string;

const list = (query = '', limit = 400) =>
  fsHandlers['fs:list-files']({ cwd: root, query, limit }) as Array<{ rel: string }>;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pd-listfiles-'));
  // A fat subtree first (alphabetically and on disk), a small one after. Under
  // a depth-first budget the second is unreachable.
  mkdirSync(path.join(root, 'aaa-big/nested'), { recursive: true });
  for (let i = 0; i < 900; i++) {
    writeFileSync(path.join(root, 'aaa-big/nested', `f${i}.ts`), '');
  }
  mkdirSync(path.join(root, 'zzz-small'), { recursive: true });
  writeFileSync(path.join(root, 'zzz-small/needle.ts'), '');
  writeFileSync(path.join(root, 'top.ts'), '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('fs:list-files', () => {
  it('reaches a small directory that sits behind a huge one', () => {
    const tops = new Set(list().map((r) => r.rel.split('/')[0]));
    expect(tops.has('zzz-small')).toBe(true);
    expect(tops.has('top.ts')).toBe(true);
  });

  it('finds a file by name wherever it sits', () => {
    expect(list('needle').some((r) => r.rel === 'zzz-small/needle.ts')).toBe(true);
  });

  it('still returns the fat subtree — fairness is not exclusion', () => {
    expect(list().some((r) => r.rel.startsWith('aaa-big/'))).toBe(true);
  });

  it('honours the caller’s limit', () => {
    expect(list('', 5).length).toBeLessThanOrEqual(5);
  });

  it('skips dot-directories, which is what keeps ~/.ssh out of the picker', () => {
    mkdirSync(path.join(root, '.ssh'), { recursive: true });
    writeFileSync(path.join(root, '.ssh/id_rsa'), 'secret');
    expect(list('id_rsa')).toHaveLength(0);
    expect(list().some((r) => r.rel.includes('.ssh'))).toBe(false);
  });
});
