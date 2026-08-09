import { describe, expect, it } from 'vitest';
import { officeThemeCss } from './office-theme';

const DARK = {
  bgBase: '#262624',
  bgRaised: '#30302e',
  bgInset: '#1f1e1d',
  textPrimary: '#faf9f5',
  textSecondary: '#c2c0b6',
  textMuted: '#9c9a92',
  borderDefault: '#4a4844',
  accentPrimary: '#d97757',
};

describe('officeThemeCss', () => {
  it('remaps GenOffice chrome variables onto Bobble tokens', () => {
    const css = officeThemeCss(DARK, true);
    expect(css).toContain('--chrome-bg: #262624 !important');
    expect(css).toContain('--surface: #30302e !important');
    expect(css).toContain('--text: #faf9f5 !important');
    expect(css).toContain('--border: #4a4844 !important');
  });

  it('keeps the document PAGE white even in dark mode', () => {
    // A dark Word page reads as a broken document, not a themed one. Word,
    // Pages and Preview all keep the page white in dark mode; only the chrome
    // around it changes. If this ever flips, the editors will look wrong in a
    // way that is easy to mistake for a rendering bug.
    const css = officeThemeCss(DARK, true);
    // BOTH names: docs uses --page-bg (falling back to --surface, which we
    // darken), the others use --color-bg-page. Missing either turns a document
    // page dark grey with near-black text.
    expect(css).toContain('--page-bg: #ffffff !important');
    expect(css).toContain('--color-bg-page: #ffffff !important');
  });

  it('themes the area AROUND the page, which is chrome', () => {
    expect(officeThemeCss(DARK, true)).toContain('--canvas: #1f1e1d !important');
  });

  it('styles scrollbars in dark mode', () => {
    // A light scrollbar on dark chrome is the single most obvious "this is an
    // embedded foreign app" tell.
    expect(officeThemeCss(DARK, true)).toContain('::-webkit-scrollbar');
  });

  it('adds no dark-only rules in light mode', () => {
    const css = officeThemeCss({ bgBase: '#faf9f5' }, false);
    expect(css).not.toContain('::-webkit-scrollbar');
  });

  it('marks every declaration !important', () => {
    // insertCSS lands at the USER-stylesheet origin, which author styles beat.
    // Without !important the whole file is inert: insertCSS returns a valid key
    // and GenOffice's own :root wins. Measured, not theorised.
    const css = officeThemeCss(DARK, true);
    for (const line of css.split('\n')) {
      if (line.trim().startsWith('--')) {
        expect(line, `not !important: ${line}`).toContain('!important');
      }
    }
  });

  it('never emits an empty custom property when a token is missing', () => {
    // getComputedStyle returns '' for an unset variable. Passing that straight
    // through yields `--text: ;` — which does not merely fail, it makes the
    // whole declaration invalid and silently reverts that surface to GenOffice's
    // light default inside a dark app.
    const css = officeThemeCss({}, true);
    expect(css).not.toMatch(/--[a-z-]+:\s*;/);
    for (const line of css.split('\n')) {
      if (line.trim().startsWith('--')) {
        expect(line, `empty value in: ${line}`).toMatch(/--[a-z-]+:\s*\S+/);
      }
    }
  });

  it('maps every colour-bearing variable the renderers consume', () => {
    // Derived by enumerating `var(--x)` across the five vendored renderers.
    // Missing one does not error — that surface just keeps GenOffice's light
    // default, which is how the formula-bar strip stayed white under a dark
    // ribbon (--surface-subtle) and how hover states stayed pale (--accent,
    // ~100 uses). A list is cheap; noticing a pale strip in a screenshot is not.
    const REQUIRED = [
      '--surface',
      '--surface-subtle',
      '--surface-hover',
      '--chrome-bg',
      '--canvas',
      '--border',
      '--border-strong',
      '--text',
      '--text-dim',
      '--text-muted',
      '--text-caption',
      '--accent',
      '--hover',
      '--ribbon-hover',
      '--active-bg',
      '--color-text-primary',
      '--color-text-secondary',
      '--color-text-tertiary',
      '--color-bg-subtle',
      '--color-bg-page',
      '--color-border-default',
      '--page-bg',
    ];
    const css = officeThemeCss(DARK, true);
    for (const v of REQUIRED) {
      expect(css, `unmapped: ${v}`).toContain(`${v}:`);
    }
  });

  it('falls back to the light palette when nothing is supplied', () => {
    const css = officeThemeCss({}, false);
    expect(css).toContain('--chrome-bg: #faf9f5 !important');
  });
});
