/**
 * The primitives both the chat's terminal router and the corp's activity tab
 * render with. The property that matters here is GROWTH: a mirror's text must
 * only ever be extended as a command runs, because that is what lets the xterm
 * append the new characters instead of resetting and rewriting the whole buffer
 * — the difference between a live terminal and a screen that rebuilds itself
 * every tick and throws away wherever the user had scrolled to.
 */
import { describe, expect, it } from 'vitest';
import {
  isInteractiveCommand,
  mirrorCommandText,
  plainMirrorText,
  shortCommandTitle,
} from './agent-surfaces';

describe('a mirror only ever grows', () => {
  it('a running command is its prompt line and nothing else', () => {
    // What a real terminal shows while something works — and it means the output
    // that follows is an APPEND, not a rewrite. The line stays OPEN (no newline)
    // because the command itself may still be arriving.
    expect(plainMirrorText(mirrorCommandText('npm test', '', true))).toBe('$ npm test');
  });

  it('a command being TYPED extends its own line', () => {
    // A bash call's command streams in with its arguments; every tick must be an
    // extension of the last, or the xterm rebuilds per keystroke (2026-09-13:
    // `$ echo` / `$ echo hello` / `$ echo hello-from` stacked as four lines).
    const typed = ['echo', 'echo hello', 'echo hello-from', 'echo hello-from-tool'].map((c) =>
      mirrorCommandText(c, '', true, '/w/proj'),
    );
    for (let i = 1; i < typed.length; i++) {
      expect(typed[i]?.startsWith(typed[i - 1] as string)).toBe(true);
    }
    const ran = mirrorCommandText('echo hello-from-tool', 'hello-from-tool', false, '/w/proj');
    expect(ran.startsWith(typed[typed.length - 1] as string)).toBe(true);
  });

  it('output arriving EXTENDS the running text', () => {
    const running = mirrorCommandText('npm test', '', true);
    const partial = mirrorCommandText('npm test', 'PASS a.test.ts', true);
    const settled = mirrorCommandText('npm test', 'PASS a.test.ts\nPASS b.test.ts', false);
    expect(partial.startsWith(running)).toBe(true);
    expect(settled.startsWith(partial)).toBe(true);
  });

  it('a finished command that printed nothing SAYS so', () => {
    // Distinct from "still going" — the corp's old copy reported every quiet
    // mkdir as running forever.
    expect(plainMirrorText(mirrorCommandText('mkdir -p out', '', false))).toBe(
      '$ mkdir -p out\n(no output)\n',
    );
    expect(
      mirrorCommandText('mkdir -p out', '', false).startsWith(
        mirrorCommandText('mkdir -p out', '', true),
      ),
    ).toBe(true);
  });

  it('presses Enter the moment the command is complete and executing', () => {
    // the user (2026-09-17): "when the model's command finishes streaming in the
    // terminal move the cursor down a line … as if the user pressed enter".
    const typing = mirrorCommandText('npm test', '', true, '/w/proj');
    const entered = mirrorCommandText('npm test', '', true, '/w/proj', { executing: true });
    expect(typing.endsWith('\n')).toBe(false);
    expect(entered.endsWith('\n')).toBe(true);
    expect(entered.startsWith(typing)).toBe(true);
    // The output then lands right under the prompt line, no blank line, and
    // each chunk extends the last — as a shell prints it.
    const chunk = mirrorCommandText('npm test', 'PASS a.te', true, '/w/proj', { executing: true });
    const more = mirrorCommandText('npm test', 'PASS a.test.ts\nPASS b', true, '/w/proj', {
      executing: true,
    });
    const done = mirrorCommandText('npm test', 'PASS a.test.ts\nPASS b.test.ts', false, '/w/proj');
    expect(chunk.startsWith(entered)).toBe(true);
    expect(more.startsWith(chunk)).toBe(true);
    expect(done.startsWith(more)).toBe(true);
    expect(plainMirrorText(done)).toBe('bobble proj $ npm test\nPASS a.test.ts\nPASS b.test.ts\n');
  });

  it('a second command extends the transcript rather than replacing it', () => {
    const one = [mirrorCommandText('ls', 'a\nb', false)].join('\n');
    const two = [
      mirrorCommandText('ls', 'a\nb', false),
      mirrorCommandText('npm test', '', true),
    ].join('\n');
    expect(two.startsWith(one)).toBe(true);
  });
});

describe('the mirror is colour-coded like the shell it mirrors', () => {
  // the user (2026-09-12): "need color coded text in the terminal in the canvas."
  it('paints the prompt: user green, folder blue, a dim $, the command bold', () => {
    const out = mirrorCommandText('ls', 'a', false, '/w/proj');
    expect(out).toContain('\x1b[1m\x1b[32mbobble\x1b[0m');
    expect(out).toContain('\x1b[1m\x1b[34mproj\x1b[0m');
    expect(out).toContain('\x1b[2m$\x1b[0m \x1b[1mls\x1b[0m');
    expect(plainMirrorText(out)).toBe('bobble proj $ ls\na\n');
  });

  it('paints a failed command’s output red, and a quiet one dim', () => {
    expect(mirrorCommandText('false', 'boom', false, undefined, { failed: true })).toContain(
      '\x1b[31mboom\x1b[0m',
    );
    expect(mirrorCommandText('true', '', false)).toContain('\x1b[2m(no output)\x1b[0m');
  });

  it('lets output that carries its own colour through untouched', () => {
    const coloured = '\x1b[33mwarn\x1b[0m done';
    expect(mirrorCommandText('npm test', coloured, false)).toContain(coloured);
  });

  it('still only grows, colour and all', () => {
    const running = mirrorCommandText('npm test', '', true, '/w/proj');
    const done = mirrorCommandText('npm test', 'PASS', false, '/w/proj');
    expect(done.startsWith(running)).toBe(true);
  });
});

describe('which commands earn a terminal of their own in the chat', () => {
  it('takes the long-running and interactive ones', () => {
    for (const c of ['npm run dev', 'vite', 'tail -f log.txt', 'python3 -m http.server', 'x &']) {
      expect(isInteractiveCommand(c)).toBe(true);
    }
  });

  it('leaves an ordinary one-shot in the activity chain', () => {
    for (const c of ['ls', 'git status', 'cat x.txt', '  ']) {
      expect(isInteractiveCommand(c)).toBe(false);
    }
  });
});

describe('the short title', () => {
  it('is the first few words, clipped', () => {
    expect(shortCommandTitle('npm run build --workspace apps/desktop')).toBe('npm run build');
    expect(shortCommandTitle('a'.repeat(40)).length).toBeLessThanOrEqual(28);
  });
});

describe('the terminal mirror shows where the command ran', () => {
  /*
   * the user: "would be appreciated if you can show in the terminal something like
   * the user being 'bobble' and the directory ... this removes confusion about
   * the initial working directory."
   *
   * That confusion is real and has cost runs: the model is told its cwd is the
   * home directory while its tools resolve to the workspace, and a bare `$` gave
   * the reader nothing to check it against.
   */
  it('renders a prompt line with the folder name', () => {
    const out = plainMirrorText(
      mirrorCommandText('ls -la', 'a\nb', false, '/Users/user/bobble-testbed/buggyapp'),
    );
    expect(out.startsWith('bobble buggyapp $ ls -la')).toBe(true);
    expect(out).toContain('a\nb');
  });

  it('shows ~ for the home directory, the way a shell does', () => {
    const home = process.env.HOME ?? '';
    if (home === '') return;
    expect(
      plainMirrorText(mirrorCommandText('pwd', '', true, home)).startsWith('bobble ~ $ pwd'),
    ).toBe(true);
  });

  it('falls back to a bare $ when there is no cwd to show', () => {
    expect(plainMirrorText(mirrorCommandText('echo hi', 'hi', false)).startsWith('$ echo hi')).toBe(
      true,
    );
  });

  it('still marks a finished command with no output', () => {
    expect(mirrorCommandText('true', '', false, '/w/proj')).toContain('(no output)');
  });
});
