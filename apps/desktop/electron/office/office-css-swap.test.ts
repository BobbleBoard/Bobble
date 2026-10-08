import { describe, expect, it } from 'vitest';
import { type CssHost, swapCss } from './office-css-swap';

/** A view that remembers which sheets are in it now. */
function fakeView(): CssHost & { live: () => string[] } {
  const sheets = new Map<string, string>();
  let n = 0;
  return {
    isDestroyed: () => false,
    insertCSS: async (css) => {
      n += 1;
      const key = `k${n}`;
      sheets.set(key, css);
      return key;
    },
    removeInsertedCSS: async (key) => {
      sheets.delete(key);
    },
    live: () => [...sheets.values()],
  };
}

describe('swapCss — one theme at a time in an editor view', () => {
  it('takes the dark sheets out when the light ones go in', async () => {
    const view = fakeView();
    await swapCss(view, ['dark theme', 'dark chrome']);
    await swapCss(view, ['light theme', 'light chrome']);
    expect(view.live()).toEqual(['light theme', 'light chrome']);
  });

  it('lands on the last of two quick changes, not a mix', async () => {
    const view = fakeView();
    void swapCss(view, ['dark theme']);
    await swapCss(view, ['light theme']);
    expect(view.live()).toEqual(['light theme']);
  });

  it('keeps each view to its own sheets', async () => {
    const a = fakeView();
    const b = fakeView();
    await swapCss(a, ['a1']);
    await swapCss(b, ['b1']);
    await swapCss(a, ['a2']);
    expect(a.live()).toEqual(['a2']);
    expect(b.live()).toEqual(['b1']);
  });
});
