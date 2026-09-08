import { execFileSync, spawnSync } from 'node:child_process';
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

describe('the redirect names the app that was actually asked for', () => {
  /*
   * MEASURED, the Calculator run. The message was hardcoded to TextEdit — the
   * app that happened to be in the run it was written during — so a 4B told to
   * use Calculator got `mac launch --app "TextEdit"`, tried `open -a` once more,
   * and then answered the arithmetic out of its own head. It never ran `mac`.
   * A signpost pointing somewhere else is barely better than a wall.
   */
  it('quotes the app back for every spelling of the flag', () => {
    for (const args of [
      ['-a', 'Calculator'],
      ['-a', 'Calculator', '--args', '-x'],
      ['--application', 'Calculator'],
      ['--application=Calculator'],
      ['-aCalculator'],
    ]) {
      const res = run(args);
      expect(res.code, args.join(' ')).toBe(127);
      expect(res.err, args.join(' ')).toContain('mac launch --app "Calculator"');
      expect(res.err, args.join(' ')).not.toContain('TextEdit');
    }
  });

  it('handles an app name with a space', () => {
    expect(run(['-a', 'System Settings']).err).toContain('mac launch --app "System Settings"');
  });

  it('points at the look as well as the launch — one call is never the whole job', () => {
    expect(run(['-a', 'Calculator']).err).toContain('mac snapshot --app "Calculator"');
  });

  it('still says something useful when it cannot tell which app', () => {
    const res = run(['-a']);
    expect(res.code).toBe(127);
    expect(res.err).toContain('the app');
  });
});

describe('with `mac` on the PATH, it translates rather than refuses', () => {
  /*
   * The refusal-with-a-signpost was MEASURED not being taken, twice. A 4B asked
   * to use Calculator ran `open -a Calculator`, read "use mac launch" as a
   * quoting complaint, re-ran `open -a "Calculator"`, and then answered from its
   * own head. CLI mode's whole promise is translation, so translate: the model
   * meant "open this app and give it to me", which is what `mac launch` does.
   */
  /** The wrapper plus a fake `mac` that records how it was called. */
  function withMac(args: string[]): { code: number; out: string; err: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-openwrap-mac-'));
    writeFileSync(path.join(dir, 'open'), buildOpenWrapper(), { mode: 0o755 });
    writeFileSync(path.join(dir, 'mac'), '#!/bin/sh\necho "mac $*"\n', { mode: 0o755 });
    chmodSync(path.join(dir, 'open'), 0o755);
    chmodSync(path.join(dir, 'mac'), 0o755);
    // spawnSync, not execFileSync: stderr is half the contract here, and
    // execFileSync only hands back stdout on success.
    const r = spawnSync(path.join(dir, 'open'), args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
  }

  it('runs `mac launch` for every spelling of the app flag', () => {
    for (const args of [
      ['-a', 'Calculator'],
      ['--application', 'Calculator'],
      ['--application=Calculator'],
      ['-aCalculator'],
    ]) {
      const res = withMac(args);
      expect(res.code, args.join(' ')).toBe(0);
      expect(res.out, args.join(' ')).toContain('mac launch --app Calculator');
    }
  });

  it('keeps an app name with a space in one argument', () => {
    expect(withMac(['-a', 'System Settings']).out).toContain('mac launch --app System Settings');
  });

  it('says what it did, so the substitution is never silent', () => {
    expect(withMac(['-a', 'Calculator']).err).toContain('in the background instead');
  });

  it('still opens a file or a URL for real', () => {
    // `open report.pdf` is legitimate and must not be turned into an app launch.
    expect(withMac(['--version']).code).not.toBe(127);
  });

  it('refuses a bundle id, which is not a name mac launch can take', () => {
    const res = withMac(['-b', 'com.apple.Calculator']);
    expect(res.code).toBe(127);
    expect(res.err).toContain('com.apple.Calculator');
  });

  it('tells it not to retry with different quoting — the shape of the measured loop', () => {
    expect(run(['-a', 'Calculator']).err).toContain('quoted differently, will not work');
  });
});
