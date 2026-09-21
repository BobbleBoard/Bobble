/**
 * Driving the user's own Chrome through its DOM.
 *
 * the user: "for google chrome specifically I'm told something like Enabling
 * AppleScript JavaScript Execution via defaults write com.google.Chrome
 * AllowJavaScriptAppleEvents -bool true would allow for control without asking
 * the user to download an extension we provide them, that would be a very odd
 * process for a lot of users."
 *
 * The escaping and the failure explanations are the parts worth pinning: an
 * unescaped quote truncates the AppleScript and it "works" while doing something
 * else, and a bare osascript error tells the model nothing it can act on.
 */
import { describe, expect, it } from 'vitest';
import {
  CHROME_JS_KEY,
  CHROME_SNAPSHOT_JS,
  chromeActionJs,
  chromeEvalScript,
  explainChromeFailure,
  parseChromeTabs,
  parseDefaultsBool,
} from './chrome';

describe('is Chrome willing to run our JavaScript', () => {
  it('reads the preference in every spelling defaults returns', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes']) {
      expect(parseDefaultsBool({ ok: true, stdout: v, stderr: '' })).toBe(true);
    }
    for (const v of ['0', 'false', 'no']) {
      expect(parseDefaultsBool({ ok: true, stdout: v, stderr: '' })).toBe(false);
    }
  });

  it('treats an ABSENT key as off — which is Chrome’s default', () => {
    // `defaults read` exits non-zero when the key was never written.
    expect(parseDefaultsBool({ ok: false, stdout: '', stderr: 'does not exist' })).toBe(false);
  });

  it('uses the key the user named', () => {
    expect(CHROME_JS_KEY).toBe('AllowJavaScriptAppleEvents');
  });
});

describe('the AppleScript we send', () => {
  it('escapes quotes and backslashes so the script cannot be truncated', () => {
    const script = chromeEvalScript('document.querySelector("a[href=\\"/x\\"]").click()');
    // Every embedded quote is escaped for AppleScript's string literal…
    expect(script).toContain('\\"');
    // …and the outer literal is still balanced: an odd count means truncation.
    const unescaped = script.replace(/\\"/g, '');
    expect((unescaped.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it('targets the active tab of the front window', () => {
    expect(chromeEvalScript('1')).toContain("execute front window's active tab javascript");
  });
});

describe('the snapshot', () => {
  it('reports where it is, so the model is never guessing which page', () => {
    expect(CHROME_SNAPSHOT_JS).toContain('location.href');
    expect(CHROME_SNAPSHOT_JS).toContain('document.title');
  });

  it('indexes only what is actually visible and actionable', () => {
    expect(CHROME_SNAPSHOT_JS).toContain('getBoundingClientRect');
    expect(CHROME_SNAPSHOT_JS).toContain("visibility === 'hidden'");
    expect(CHROME_SNAPSHOT_JS).toContain('a[href],button,input');
  });

  it('says so plainly when a page has nothing to act on', () => {
    expect(CHROME_SNAPSHOT_JS).toContain('(no interactive elements found)');
  });
});

describe('acting on an index', () => {
  it('filters to the SAME visible set the snapshot numbered', () => {
    // If these two disagreed, [3] would click a different element than it named.
    const js = chromeActionJs(3, 'click');
    expect(js).toContain('a[href],button,input');
    expect(js).toContain('getBoundingClientRect');
    expect(js).toContain('vis[3]');
  });

  it('tells the model to re-snapshot when the index is gone', () => {
    expect(chromeActionJs(9, 'click')).toContain('re-snapshot, the page may have changed');
  });

  it('types by setting the value AND firing the events a page listens for', () => {
    const js = chromeActionJs(0, 'focus', 'hello');
    expect(js).toContain('"hello"');
    expect(js).toContain("new Event('input'");
    expect(js).toContain("new Event('change'");
  });

  it('never lets a negative or fractional index through', () => {
    expect(chromeActionJs(-5, 'click')).toContain('vis[0]');
    expect(chromeActionJs(2.7, 'click')).toContain('vis[2]');
  });
});

describe('when it fails, it says what would unblock it', () => {
  it('names the Automation prompt', () => {
    expect(explainChromeFailure('Not authorized to send Apple events (-1743)')).toContain(
      'Automation',
    );
  });

  it('says the chrome_* route is closed for the whole session', () => {
    // It used to name the restart the preference needs, which is advice for the
    // USER at a moment only the MODEL is reading. What the model needs to know
    // is that retrying this route cannot work — see the test below for the
    // route that does.
    const msg = explainChromeFailure('Error executing JavaScript (-2700)');
    expect(msg).toContain('none of them will work');
  });

  it('says when there is simply no window open', () => {
    expect(explainChromeFailure("can't get front window")).toContain('no open window');
    // macOS's own spelling, curly apostrophe and all — the raw error reached the
    // model eight times in one run because only the straight quote was matched.
    expect(
      explainChromeFailure(
        '36:151: execution error: Google Chrome got an error: Can’t get window 1. Invalid index. (-1719)',
      ),
    ).toContain('profile picker');
  });
});

describe('the Apple Events refusal names a route that works', () => {
  it('does not leave the model with a setting it cannot change', () => {
    /*
     * MEASURED on the user's machine: "Allow JavaScript from Apple Events" is off,
     * so every chrome_* call fails this way. The old message said to enable it —
     * which the model cannot do and must not try — and a 4B and a 9B each spent
     * a run re-trying the blocked route. A 27B found the way out unaided ("so I
     * typed the URL into the address bar") and finished the task.
     */
    const msg = explainChromeFailure('Error executing JavaScript (-2700)');
    expect(msg).toContain('mac_key');
    expect(msg).toContain('cmd+l');
    expect(msg).toMatch(/do NOT try|only the user/i);
  });
});

describe('the tab strip, read without the JavaScript gate', () => {
  it('parses a window/index/active/title/url record', () => {
    const tabs = parseChromeTabs(
      '1\t1\tfalse\tApple unveils iPhone Duo\thttps://www.apple.com/newsroom/\n' +
        '1\t2\ttrue\tShop iPhone Duo\thttps://www.apple.com/shop/buy-iphone/iphone-duo\n',
    );
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toEqual({
      window: 1,
      index: 2,
      active: true,
      title: 'Shop iPhone Duo',
      url: 'https://www.apple.com/shop/buy-iphone/iphone-duo',
    });
  });

  /* A title is user content: it can contain anything, and the separator has to
     survive it. Tabs cannot appear in a URL, so the tail is rejoined. */
  it('keeps a URL that contains the separator character', () => {
    const tabs = parseChromeTabs('2\t1\tfalse\tOdd\thttps://x.test/a\tb\n');
    expect(tabs[0]?.url).toBe('https://x.test/a\tb');
  });

  it('ignores lines that are not records', () => {
    expect(parseChromeTabs('\n\nnot a record\n')).toEqual([]);
  });
});
