/**
 * A FAILED DELETE BRINGS THE ROW BACK (review wave-0923, delete #8).
 *
 * `deleteSession` remembers the files as deleted BEFORE it removes them, so a
 * listing racing the delete already hides them. When the removal then FAILS,
 * the record has to go again for the files still on disk — or the chat stays
 * hidden, every listing silently retries the rm, and the chat the user was
 * told could not be deleted reappears a week later when the record expires.
 *
 * fs-handlers reads HOME once, at load, so it is imported here only after HOME
 * points at a throwaway directory.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-delete-home-')));
const realHome = process.env.HOME;
process.env.HOME = home;
vi.resetModules();
const { fsHandlers } = await import('./fs-handlers');

afterAll(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const SESSION = [
  JSON.stringify({ type: 'session', id: 's1', cwd: home, timestamp: '2026-09-25T00:00:00.000Z' }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } }),
  '',
].join('\n');

function sessionFile(name: string): { dir: string; file: string } {
  const dir = path.join(home, '.pi', 'agent', 'sessions', `--${name}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '2026-09-25T00-00-00-000Z_s1.jsonl');
  fs.writeFileSync(file, SESSION);
  return { dir, file };
}

const listed = (file: string): boolean =>
  fsHandlers['fs:list-sessions']({}).some((s) => s.file === file);

describe('fs:delete-session', () => {
  it('a chat that is deleted is gone from the listing', () => {
    const { file } = sessionFile('gone');
    expect(listed(file)).toBe(true);
    expect(fsHandlers['fs:delete-session']({ file }).ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(listed(file)).toBe(false);
  });

  it('a chat whose file cannot be removed is listed again', () => {
    const { dir, file } = sessionFile('stuck');
    fs.chmodSync(dir, 0o555); // the file cannot be unlinked
    try {
      const res = fsHandlers['fs:delete-session']({ file });
      expect(res.ok).toBe(false);
      expect(fs.existsSync(file)).toBe(true);
      expect(listed(file)).toBe(true);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});
