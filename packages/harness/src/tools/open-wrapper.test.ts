import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenWrapper } from './tool-cli-bridge';

/** The wrapper as it is actually installed: a real executable on disk. */
function installed(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-openwrap-'));
  const p = path.join(dir, 'open');
  writeFileSync(p, buildOpenWrapper(), { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

function run(args: string[]): { code: number; err: string } {
  try {
    execFileSync(installed(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, err: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? -1, err: err.stderr ?? '' };
  }
}

describe('the open wrapper', () => {
  it('refuses the form that takes the user’s screen, and names the one that does not', () => {
    // MEASURED across two models: `open -a "TextEdit"` is the first thing either
    // reaches for when asked to work in a Mac app — before, and instead of, the
    // `mac` command on the same PATH. It activates the app.
    for (const args of [
      ['-a', 'TextEdit'],
      ['-b', 'com.apple.TextEdit'],
    ]) {
      const res = run(args);
      expect(res.code).toBe(127);
      expect(res.err).toContain('mac launch');
      expect(res.err).toContain('BACKGROUND');
    }
  });

  it('lets the background flag through — that form was never the problem', () => {
    // -g is what `mac launch` itself uses; refusing it would be superstition.
    const res = run(['-g', '-a', 'NoSuchApplicationZZZ']);
    expect(res.code).not.toBe(127);
  });

  it('leaves every other use of open alone', () => {
    // A file, a URL, a directory. Refusing these would be a dead end rather
    // than a signpost, and none of them steals focus from the user.
    expect(run(['--help']).code).not.toBe(127);
  });
});
