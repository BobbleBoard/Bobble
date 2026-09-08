/**
 * the user: "whatever browser or app it opens something in via terminal (which is a
 * common issue I face) immediately give it the tools it needs and the initial
 * snapshot of whatever app or the browser snapshot of chrome."
 *
 * The failure is quiet: `open -a "Google Chrome" https://…` returns empty stdout
 * and exit 0, so the model either declares success without looking or falls back
 * to the BUILT-IN browser — a different browser, different logins, different page.
 */
import { describe, expect, it } from 'vitest';
import { detectOpenedApp, openedAppNote } from './opened-app';

describe('spotting that a command opened an app', () => {
  it('reads `open -a` with a quoted app and a URL', () => {
    const got = detectOpenedApp('open -a "Google Chrome" https://mail.google.com');
    expect(got?.app).toBe('Google Chrome');
    expect(got?.chrome).toBe(true);
    expect(got?.target).toBe('https://mail.google.com');
  });

  it('reads an unquoted app with no target', () => {
    const got = detectOpenedApp('open -a Safari');
    expect(got?.app).toBe('Safari');
    expect(got?.chrome).toBe(false);
    expect(got?.target).toBeUndefined();
  });

  it('handles a bare URL, where the SYSTEM picks the app', () => {
    const got = detectOpenedApp('open https://example.com');
    expect(got?.target).toBe('https://example.com');
    // We cannot name the app, and must not pretend to.
    expect(got?.app).toContain('default browser');
    expect(got?.chrome).toBe(false);
  });

  it('handles a file, and a command chained after a cd', () => {
    expect(detectOpenedApp('open ~/report.pdf')?.target).toBe('~/report.pdf');
    expect(detectOpenedApp('cd /tmp && open -a Preview shot.png')?.app).toBe('Preview');
  });

  it('recognises Chrome however it is spelled', () => {
    for (const name of ['Google Chrome', 'chrome', 'google chrome']) {
      expect(detectOpenedApp(`open -a "${name}"`)?.chrome).toBe(true);
    }
  });

  it('ignores commands that did not open an app', () => {
    for (const cmd of ['ls -la', 'python3 open.py', 'grep open file.txt', 'open', 'open .']) {
      expect(detectOpenedApp(cmd)).toBeUndefined();
    }
  });
});

describe('what the model is told afterwards', () => {
  it('sends Chrome down the DOM path, and warns off the built-in browser', () => {
    const note = openedAppNote({ app: 'Google Chrome', chrome: true, target: 'https://x.test' });
    expect(note).toContain('chrome_snapshot');
    expect(note).toContain('different browser');
    expect(note).not.toContain('mac_snapshot');
    // It must NOT route through `use`: `use` only reaches the harness's own
    // tools, and Chrome's belong to another extension — measured on a real run,
    // the model followed that instruction, was refused, and gave up.
    expect(note).not.toContain('use with tool=');
  });

  it('sends everything else to computer use, and says a screenshot is automatic', () => {
    const note = openedAppNote({ app: 'Preview', chrome: false, target: 'shot.png' });
    expect(note).toContain('mac_snapshot');
    expect(note).not.toContain('use with tool=');
    expect(note).toContain('act by x,y coordinates');
  });

  it('names the COMMAND when the CLI is the interface', () => {
    // The note is an instruction, and an instruction naming a call the model
    // cannot make is worse than none: it spends a turn and then a fallback.
    const note = openedAppNote({ app: 'TextEdit', chrome: false }, (tool) =>
      tool === 'mac_snapshot' ? 'mac snapshot' : tool === 'mac_click' ? 'mac click' : null,
    );
    expect(note).toContain('mac snapshot --app "TextEdit"');
    expect(note).toContain('mac click --index N');
  });

  it('names the tool itself when tools are called by name', () => {
    const note = openedAppNote({ app: 'TextEdit', chrome: false });
    expect(note).toContain('call mac_snapshot with app "TextEdit"');
  });

  it('names what was opened, so the model is not guessing', () => {
    expect(openedAppNote({ app: 'Safari', chrome: false })).toContain('Safari');
  });
});

describe('a web page opened from the shell with no browser named', () => {
  // the user: "bias it to use the built in browser instead of bash to open safari
  // when no specific is requested."
  it('is redirected to browser_navigate, which it can actually drive', () => {
    const opened = detectOpenedApp('open https://example.com');
    if (opened === undefined) throw new Error('not detected');
    expect(opened.strayWebPage).toBe(true);
    const note = openedAppNote(opened);
    expect(note).toContain('browser_navigate("https://example.com")');
    expect(note).toContain('cannot drive');
  });

  it('does NOT redirect when the user named a browser — that was deliberate', () => {
    const opened = detectOpenedApp('open -a Safari https://example.com');
    if (opened === undefined) throw new Error('not detected');
    expect(opened.strayWebPage).toBeUndefined();
    expect(openedAppNote(opened)).toContain('mac_snapshot');
  });

  it('leaves a FILE open alone — that is not a web page', () => {
    const opened = detectOpenedApp('open ~/report.pdf');
    if (opened === undefined) throw new Error('not detected');
    expect(opened.strayWebPage).toBeUndefined();
  });
});

describe('AppleScript is the other way into a Mac app', () => {
  it('recognises `tell application "X"` and treats it like open -a', () => {
    // MEASURED, qwen3.5-9b: with `open -a` refused, it ran
    // `osascript -e 'tell application "TextEdit" to activate'` and scripted the
    // document instead — reporting success while `activate` did exactly the
    // thing the refusal was protecting against.
    const t = detectOpenedApp(
      `osascript -e 'tell application "TextEdit" to set text of document 1 to "hi"'`,
    );
    expect(t?.app).toBe('TextEdit');
    expect(t?.chrome).toBe(false);
  });

  it('knows when the app it is scripting is Chrome', () => {
    const t = detectOpenedApp(`osascript -e 'tell application "Google Chrome" to activate'`);
    expect(t?.chrome).toBe(true);
  });

  it('leaves System Events and Finder alone — those are the OS, not an app being driven', () => {
    expect(
      detectOpenedApp(`osascript -e 'tell application "System Events" to keystroke "a"'`),
    ).toBeUndefined();
  });

  it('ignores osascript that is not telling an application anything', () => {
    expect(detectOpenedApp(`osascript -e 'return 1 + 1'`)).toBeUndefined();
  });
});
