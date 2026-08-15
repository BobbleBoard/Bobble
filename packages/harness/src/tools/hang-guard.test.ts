import { describe, expect, it } from 'vitest';
import { wouldHang } from './hang-guard.js';

describe('a GUI launcher that names no script', () => {
  /*
   * MEASURED, run 7. At 20:38 an engineer ran a globally-installed `electron .`
   * in the project. Bobble's own window went away four minutes later, the runner
   * logged "window went away — stopping", and the run died at 66 minutes having
   * never reached the CEO's verification turn. The engineer's process was still
   * running afterwards.
   *
   * The existing check only fires when the command names a .py/.js file it can
   * open and read for a blocking loop. `electron .` and `npm start` name no file
   * at all, so there was nothing to inspect and nothing was refused. One
   * engineer's foreground window can end the whole run.
   */
  it('refuses the exact command that killed run 7', () => {
    expect(wouldHang('electron .')).toMatch(/never returns/);
  });

  it('refuses the usual dev-server launchers', () => {
    for (const c of ['npm start', 'npm run dev', 'yarn dev', 'pnpm serve', 'open -a Foo.app']) {
      expect(wouldHang(c), c).not.toBeNull();
    }
  });

  /* The two escapes that genuinely come back, both named in the refusal. */
  it('allows it under a timeout, or backgrounded', () => {
    expect(wouldHang('timeout 20 electron .')).toBeNull();
    expect(wouldHang('electron . &')).toBeNull();
  });

  /* A build EXITS. Refusing it would block the one thing that must work. */
  it('does not touch commands that terminate on their own', () => {
    for (const c of ['npm run build', 'npm test', 'node build.js', 'npm ci']) {
      expect(wouldHang(c), c).toBeNull();
    }
  });
});
