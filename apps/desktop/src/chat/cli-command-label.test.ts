import { describe, expect, it } from 'vitest';
import { cliCommandLabel } from './cli-command-label';

describe('a Bobble command, said as what it did', () => {
  it('names the app it looked at, and carries it for the icon', () => {
    /*
     * The user: "cli tools showing directly to the user as terminal tools even when
     * they're very parsable and should have special display/handling for
     * visuals eg. 'snapshotted <app icon inline><app>'."
     */
    expect(cliCommandLabel('mac snapshot "Google Chrome"')).toEqual({
      /* The app is a NAMED PART of the row now, not a word inside the sentence
         — The user: "<connectors icon> Used <connector app icon> <connector app
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
    expect(
      cliCommandLabel('chart --type hbar --title "Top 5" --labels a --values 1')?.running,
    ).toBe('Rendering a horizontal bar chart');
    expect(cliCommandLabel('chart edit units.svg --look sunset')).toEqual({
      running: 'Redrawing the chart',
      done: 'Redrew the chart',
      chart: { type: 'chart', title: 'units.svg' },
    });
  });
});

describe("browser rows — the app's own kinds, not terminal lines (the user 2026-09-21)", () => {
  it('reads both spellings of every argument, as one real run typed them', () => {
    expect(cliCommandLabel('browser navigate https://www.desmos.com/calculator')).toEqual({
      running: 'Visiting in the browser',
      done: 'Visited in the browser',
      kind: 'browser-navigate',
      url: 'https://www.desmos.com/calculator',
      detail: 'https://www.desmos.com/calculator',
    });
    expect(cliCommandLabel('browser navigate --url=https://a.b/c')?.url).toBe('https://a.b/c');
    expect(cliCommandLabel('browser click 4')).toMatchObject({
      running: 'Clicking in the browser',
      kind: 'browser-click',
      target: 'element 4',
      detail: 'element 4',
    });
    expect(cliCommandLabel('browser click --index=13')?.target).toBe('element 13');
    expect(cliCommandLabel('browser type 14 --text "x^2 + y^2 = 1" --submit true')).toMatchObject({
      kind: 'browser-type',
      target: 'element 14',
      typed: 'x^2 + y^2 = 1',
      detail: 'x^2 + y^2 = 1',
    });
    expect(cliCommandLabel('browser type --index=13 "x^2 + (y-5)^2 = 9"')).toMatchObject({
      target: 'element 13',
      typed: 'x^2 + (y-5)^2 = 9',
    });
    expect(cliCommandLabel('browser key t')).toMatchObject({
      running: 'Pressing a key in the browser',
      kind: 'browser-type',
      typed: 't',
    });
    expect(cliCommandLabel('browser scroll --direction=down --amount=300')).toMatchObject({
      kind: 'browser-click',
      target: 'down 300 px',
    });
    // The user: "scrolled element 5000" — a scroll's number is a distance, never an index.
    expect(cliCommandLabel('browser scroll 5000')?.target).toBe('5,000 px');
    expect(cliCommandLabel('browser scroll down 10000')?.target).toBe('down 10,000 px');
    expect(cliCommandLabel('browser scroll 5000')?.target).not.toContain('element');
    /* An --amount with no number attached is a bare flag ('true' — the next word
       starts with '-', so the CLI does not take it either); the row must not
       read "down NaN px". */
    expect(cliCommandLabel('browser scroll --direction down --amount -300')?.target).toBe('down');
    expect(cliCommandLabel('browser scroll down --amount')?.target).toBe('down');
    expect(cliCommandLabel('browser scroll --amount')?.target).toBeUndefined();
    expect(cliCommandLabel('browser snapshot')).toMatchObject({
      running: 'Reading the page in the browser',
      kind: 'browser-read',
    });
    expect(cliCommandLabel('browser read --selector="input, textarea"')?.target).toBe(
      'input, textarea',
    );
    expect(cliCommandLabel('browser back')?.kind).toBe('browser-navigate');
  });

  it('`open <url>` is a visit — the wrapper turns it into one', () => {
    expect(cliCommandLabel('open https://www.desmos.com/calculator')).toMatchObject({
      running: 'Visiting in the browser',
      kind: 'browser-navigate',
      url: 'https://www.desmos.com/calculator',
    });
    // Naming an app is the launch guard's business, not a visit.
    expect(cliCommandLabel('open -a Safari https://x.y')).toBeNull();
    expect(cliCommandLabel('open .')).toBeNull();
  });

  it('a drawing is "Drawing an SVG" with the file named, never the prompt as a command', () => {
    const l = cliCommandLabel(
      'svg "--prompt=A clean educational SVG showing a 5-wide smiley face" assets/smileys.svg',
    );
    expect(l).toMatchObject({ running: 'Drawing an SVG', done: 'Drew an SVG', kind: 'svg' });
    expect(l?.detail).toContain('smiley face');
  });
});
