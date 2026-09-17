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
      /* The app is a NAMED PART of the row now, not a word inside the sentence
         — the user: "<connectors icon> Used <connector app icon> <connector app
         name> <action>". So the verb phrase comes back on its own as well. */
      action: { running: 'Looking at', done: 'Snapshotted' },
      running: 'Looking at Google Chrome',
      done: 'Snapshotted Google Chrome',
      app: 'Google Chrome',
    });
    expect(cliCommandLabel('mac launch Blender')).toEqual({
      action: { running: 'Opening', done: 'Opened' },
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

describe("Chrome's own set reads as connector usage", () => {
  it('names the browser and the action separately', () => {
    expect(cliCommandLabel('chrome tabs')).toEqual({
      running: 'Listing tabs in Chrome',
      done: 'Listed tabs in Chrome',
      app: 'Google Chrome',
      action: { running: 'Listing tabs', done: 'Listed tabs' },
    });
  });

  it('reads a page without mentioning a shell', () => {
    const l = cliCommandLabel('chrome snapshot "2TB"');
    expect(l?.action?.done).toBe('Read the page');
    expect(l?.app).toBe('Google Chrome');
  });

  it('leaves an ordinary shell command alone', () => {
    expect(cliCommandLabel('ls -la /tmp')).toBeNull();
  });
});

describe('a chart command is the chart tool in CLI clothes', () => {
  it('names the kind of chart and carries the title', () => {
    expect(cliCommandLabel('chart bar "Units Sold by Year" --labels "a" --values "1"')).toEqual({
      running: 'Rendering a bar chart',
      done: 'Rendered a bar chart',
      chart: { type: 'bar', title: 'Units Sold by Year' },
    });
    expect(cliCommandLabel('chart --type hbar --title "Top 5" --labels a --values 1')?.running).toBe(
      'Rendering a horizontal bar chart',
    );
    expect(cliCommandLabel('chart edit units.svg --look sunset')).toEqual({
      running: 'Redrawing the chart',
      done: 'Redrew the chart',
      chart: { type: 'chart', title: 'units.svg' },
    });
  });
});
