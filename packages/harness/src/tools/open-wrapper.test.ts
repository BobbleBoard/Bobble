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

  it('does not open a Finder window for `open .`', () => {
    /*
     * the user, twice, with no run in flight: "finder keeps on opening up to exactly
     * /Users/user/Desktop/OSS-harness/packages/harness" — pi's own cwd, so the
     * line was `open .`. Only -a and URLs were flagged, so a bare path fell
     * through to /usr/bin/open and put a Finder window in front of him.
     *
     * The static assertion comes FIRST and deliberately: if the guard is gone,
     * this test must fail without ever executing the line, because executing it
     * is the bug — it would take the screen of whoever is running the suite.
     */
    expect(buildOpenWrapper()).toContain('if [ -d "$target" ]; then');

    const dir = mkdtempSync(path.join(tmpdir(), 'pi-openwrap-dir-'));
    writeFileSync(path.join(dir, 'a-file.txt'), 'hi');
    const res = spawnSync(installed(), [dir], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('a-file.txt');
    expect(res.stderr).toContain('Finder window');
  });

  it('names the read tool instead of handing a file to a GUI app', () => {
    expect(buildOpenWrapper()).toContain('if [ -e "$target" ]; then');

    const dir = mkdtempSync(path.join(tmpdir(), 'pi-openwrap-file-'));
    const file = path.join(dir, 'notes.txt');
    writeFileSync(file, 'hi');
    const res = spawnSync(installed(), [file], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('read tool');
  });

  it('treats a bare app name as a launch, not a missing file', () => {
    /*
     * the user, mid-run: "keychain not found popup persists, chrome profile screen
     * taking focus". The line was `open -n "Google Chrome"` — /usr/bin/open reads
     * that as a PATH and fails, and `-n` asks for a SECOND Chrome, which comes up
     * with no profile and no keychain and shows both prompts in front of him.
     * Same intent as `open -a`, so it gets the same translation.
     */
    const res = run(['-n', 'Google Chrome']);
    expect(res.err).toContain('mac launch');
    expect(res.err).not.toContain('does not exist');
  });

  it('carries the user’s real HOME into anything it still passes through', () => {
    // A probe's throwaway HOME is what produced the keychain prompt; the wrapper
    // is the last place that can put the right one back for the model's shell.
    const script = buildOpenWrapper();
    expect(script).toMatch(/^HOME='.+'$/m);
    expect(script).toContain('export HOME');
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

describe('a bare URL open is the OTHER way to take the screen', () => {
  /*
   * MEASURED, and the user watched it happen: a run asked to use Chrome ran
   *
   *     open chrome://new-tab
   *
   * which is not the `-a` form, so the wrapper passed it straight through — and
   * `open <url>` hands the page to the default browser AND brings it to the
   * front. A browser sat in front of him for the rest of the run, from a run
   * that had asked for the background at every other step.
   *
   * Same shape as `open -a`, same answer: translate it to the command that does
   * the job without taking the screen.
   */
  function withCommands(args: string[]): { code: number; out: string; err: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-openwrap-url-'));
    writeFileSync(path.join(dir, 'open'), buildOpenWrapper(), { mode: 0o755 });
    for (const name of ['mac', 'browser']) {
      writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*"\n`, { mode: 0o755 });
      chmodSync(path.join(dir, name), 0o755);
    }
    chmodSync(path.join(dir, 'open'), 0o755);
    const r = spawnSync(path.join(dir, 'open'), args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
  }

  it('sends an http URL to the app’s own browser', () => {
    const r = withCommands(['https://example.com/page']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('browser navigate --url https://example.com/page');
  });

  it('catches a browser scheme too — that is the one that was measured', () => {
    expect(withCommands(['chrome://new-tab']).out).toContain('browser navigate');
  });

  it('names the route to the user’s OWN Chrome, since that is often the ask', () => {
    expect(withCommands(['https://example.com']).err).toContain('mac chrome go');
  });

  it('still opens a FILE, a folder or a flag for real', () => {
    // `open report.pdf` and `open .` are legitimate and must not be hijacked.
    for (const args of [['report.pdf'], ['.'], ['--version']]) {
      expect(withCommands(args).out, args.join(' ')).not.toContain('browser navigate');
    }
  });
});

describe('reaching for an app the wrong way is answered with the whole toolkit', () => {
  /*
   * the user: "after a terminal command for 'open -a' anything ... give a tidbit as
   * if it ran mac --help give the full thing and tell it 'this app is best
   * controlled with the cli tools above'. that should bias it away from writing
   * these files and attempting to do this directly."
   *
   * MEASURED, and it is the dominant failure in the app matrix: asked to search
   * Maps, models wrote `/tmp/maps_search.txt` seven times, ran `pkill -9 Maps`,
   * and wrote an AppleScript file — after successfully opening the app. They had
   * the commands on the PATH the whole time and no reason to believe they were
   * the answer. This is the one moment we KNOW they are thinking about the app.
   */
  function withMacHelp(args: string[]): { code: number; out: string; err: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-openwrap-help-'));
    writeFileSync(path.join(dir, 'open'), buildOpenWrapper(), { mode: 0o755 });
    writeFileSync(
      path.join(dir, 'mac'),
      '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "mac snapshot — look at an app"; echo "mac click — click by index"; exit 0; fi\necho "mac $*"\n',
      { mode: 0o755 },
    );
    chmodSync(path.join(dir, 'open'), 0o755);
    chmodSync(path.join(dir, 'mac'), 0o755);
    const r = spawnSync(path.join(dir, 'open'), args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
  }

  it('opens the app AND lists everything that can drive it', () => {
    const r = withMacHelp(['-a', 'Maps']);
    expect(r.out).toContain('mac launch --app Maps');
    expect(r.out).toContain('mac snapshot');
    expect(r.out).toContain('mac click');
  });

  it('says plainly that files and AppleScript are not the route', () => {
    const r = withMacHelp(['-a', 'Maps']);
    expect(r.out).toContain('best controlled with the commands above');
    expect(r.out).toContain('Do not write files or AppleScript');
  });

  it('still reports the launch’s own exit status', () => {
    expect(withMacHelp(['-a', 'Maps']).code).toBe(0);
  });
});
