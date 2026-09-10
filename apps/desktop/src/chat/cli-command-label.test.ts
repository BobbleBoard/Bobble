import { describe, expect, it } from 'vitest';
import { cliCommandLabel } from './cli-command-label';

describe('a Bobble command, said as what it did', () => {
  it('names the app it looked at, and carries it for the icon', () => {
    /*
     * the user: "cli tools showing directly to the user as terminal tools even when
     * they're very parsable and should have special display/handling for
     * visuals eg. 'snapshotted <app icon inline><app>'."
     */
    expect(cliCommandLabel('mac snapshot "Google Chrome"')).toEqual({
      running: 'Looking at Google Chrome',
      done: 'Snapshotted Google Chrome',
      app: 'Google Chrome',
    });
    expect(cliCommandLabel('mac launch Blender')).toEqual({
      running: 'Opening Blender',
      done: 'Opened Blender',
      app: 'Blender',
    });
  });

  it('says the plain verb when there is nothing to name', () => {
    expect(cliCommandLabel('mac scroll down --amount 400')?.done).toBe('Scrolled');
    expect(cliCommandLabel('mac type "hello"')?.done).toBe('Typed');
  });

  it('does not mistake a click INDEX for an application', () => {
    // `mac click 28` acts on element 28 — there is no app called 28, and an
    // icon lookup for one would be a wrong picture rather than none.
    const l = cliCommandLabel('mac click 28');
    expect(l?.done).toBe('Clicked');
    expect(l?.app).toBeUndefined();
  });

  it('calls a --help read what it is, on any command', () => {
    // A surprising amount of a run's wall clock goes here, so it is worth
    // saying rather than hiding inside "Ran a command".
    expect(cliCommandLabel('mac --help')?.done).toBe('Read the guide for mac');
    expect(cliCommandLabel('mac scroll --help')?.done).toBe('Read the guide for mac scroll');
  });

  it('handles the Chrome sub-group', () => {
    const l = cliCommandLabel('mac chrome go "https://example.com"');
    expect(l?.done).toBe('Drove Chrome');
    expect(cliCommandLabel('mac chrome snapshot')?.done).toBe('Read the page in Chrome');
  });

  it('leaves an ordinary shell command alone', () => {
    // The row is honest about what it is; only OUR lines get the special read.
    expect(cliCommandLabel('ls -la /tmp')).toBeNull();
    expect(cliCommandLabel('python3 build.py')).toBeNull();
    expect(cliCommandLabel('')).toBeNull();
  });
});
