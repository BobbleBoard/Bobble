import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionTombstones } from './session-tombstones';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tomb-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('session tombstones — a deleted chat stays deleted', () => {
  it('removes a file pi wrote back after the delete (the running-chat race)', () => {
    const store = path.join(dir, 'deleted.json');
    const file = path.join(dir, 'sessions', 'chat.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const t = createSessionTombstones({ storePath: store });
    t.add([file]);
    // pi appends the aborted reply a moment later — the file is back.
    fs.writeFileSync(file, '{"type":"message"}\n');
    expect(t.has(file)).toBe(true);
    expect(t.sweep()).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('survives a restart, and forgets after the TTL', () => {
    const store = path.join(dir, 'deleted.json');
    const file = path.join(dir, 'a.jsonl');
    let clock = 1_000;
    const first = createSessionTombstones({ storePath: store, now: () => clock, ttlMs: 100 });
    first.add([file]);
    const second = createSessionTombstones({ storePath: store, now: () => clock, ttlMs: 100 });
    expect(second.has(file)).toBe(true);
    clock += 100;
    const third = createSessionTombstones({ storePath: store, now: () => clock, ttlMs: 100 });
    expect(third.has(file)).toBe(false);
  });

  it('an unreadable record starts empty rather than throwing', () => {
    const store = path.join(dir, 'deleted.json');
    fs.writeFileSync(store, 'not json');
    const t = createSessionTombstones({ storePath: store });
    expect(t.has(path.join(dir, 'x.jsonl'))).toBe(false);
    expect(t.sweep()).toBe(0);
  });
});
