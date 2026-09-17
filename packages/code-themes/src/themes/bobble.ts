/**
 * THE HOUSE THEMES — Bobble Light and Bobble Dark, the defaults.
 *
 * These are the one place the code palette is authored; `packages/themes`
 * imports them and emits their values into the generated theme sheet as the
 * fallback every flavour carries, so the two cannot drift (a test there diffs
 * them). Everything here is checked, not eyeballed: every syntax slot and
 * every ANSI colour reaches WCAG 4.5:1 against the surfaces the app actually
 * paints code on (readability.test.ts), and none of it is purple — the user's rule
 * for the whole product, and the syntax palette was once its largest violet
 * surface. Keywords are rose, properties a desaturated blue.
 *
 * The dark red that started this: xterm's default `#cd3131` on our near-black
 * ground reads at 3.3:1 and is the "dark red colour that's a bit unreadable".
 * Bobble Dark's red is `#ff7a72`, which clears 5:1.
 *
 * The editor and terminal surfaces below are the app's own — the bobble
 * flavour's code-block background composited over its raised panel, its text
 * colour, its selection wash, its accent caret — so the Appearance preview
 * shows exactly what the canvas shows. When one of these is the active theme,
 * the runtime writes NO override: the generated sheet already says all this,
 * in every flavour's own colours.
 */
import type { CodeTheme } from '../types.ts';

export const bobbleLight: CodeTheme = {
  id: 'bobble-light',
  name: 'Bobble Light',
  mode: 'light',
  firstParty: true,
  editor: {
    // The bobble flavour's code-block surface (themes/tokens.ts
    // codeSurface.blockBg): white on the grey page since the design audit
    // (2026-09-16) — the old #f6f6f8 sat 1.01:1 over #f5f5f7 and the hairline
    // was the whole box. Kept in step by code-theme-fallback.test.ts.
    bg: '#ffffff',
    fg: '#1d1d1f',
    lineNumber: '#1d1d1f4d',
    selection: '#0071e340',
    cursor: '#0071e3',
  },
  syntax: {
    keyword: '#a3236b',
    string: '#0a6b3d',
    number: '#9a4600',
    comment: '#5c6370',
    function: '#1a52c4',
    type: '#0f6f7a',
    property: '#4a6fa5',
    punctuation: '#4a5160',
    invalid: '#c0392b',
    variable: '#1d1d1f',
  },
  diff: {
    addedBg: '#1f8a4c26',
    removedBg: '#c0392b26',
    addedMarker: '#1a7a44',
    removedMarker: '#c0392b',
  },
  terminal: {
    fg: '#1d1d1f',
    bg: '#00000000',
    cursor: '#0071e3',
    selection: '#7878801f',
    ansi: {
      black: '#1d1d1f',
      red: '#c0392b',
      green: '#0a6b3d',
      yellow: '#7d5a00',
      blue: '#1a52c4',
      magenta: '#a3236b',
      cyan: '#0f6f7a',
      white: '#86868b',
      brightBlack: '#5c5c61',
      brightRed: '#c62828',
      brightGreen: '#0f7a44',
      brightYellow: '#8f6200',
      brightBlue: '#2160d8',
      brightMagenta: '#c2308a',
      brightCyan: '#0e7381',
      /* White on a light ground is faint by definition; these two are the
       * greys the app already uses for muted text, so a program that prints in
       * "white" is still legible rather than invisible. */
      brightWhite: '#a5a5aa',
    },
  },
};

export const bobbleDark: CodeTheme = {
  id: 'bobble-dark',
  name: 'Bobble Dark',
  mode: 'dark',
  firstParty: true,
  editor: {
    // Dark: the same token, now an opaque step below the raised panel.
    bg: '#1e1e21',
    fg: '#f5f5f7',
    lineNumber: '#f5f5f74d',
    selection: '#0a84ff40',
    cursor: '#0a84ff',
  },
  syntax: {
    keyword: '#ff9ac8',
    string: '#7ee2a8',
    number: '#ffb27a',
    comment: '#8b94a6',
    function: '#82b8ff',
    type: '#6fe0e0',
    property: '#9fbcd8',
    punctuation: '#b8c0d0',
    invalid: '#ff8a80',
    variable: '#f5f5f7',
  },
  diff: {
    addedBg: '#7ee2a826',
    removedBg: '#ff8a8026',
    addedMarker: '#7ee2a8',
    removedMarker: '#ff8a80',
  },
  terminal: {
    fg: '#f5f5f7',
    bg: '#00000000',
    cursor: '#0a84ff',
    selection: '#ffffff17',
    ansi: {
      black: '#5c5c64',
      red: '#ff7a72',
      green: '#5fd68a',
      yellow: '#f5c542',
      blue: '#6ab0ff',
      magenta: '#ff8ac8',
      cyan: '#5fd6d6',
      white: '#e8e8ec',
      brightBlack: '#8e8e96',
      brightRed: '#ff9d96',
      brightGreen: '#8ff0b0',
      brightYellow: '#ffd866',
      brightBlue: '#8fc4ff',
      brightMagenta: '#ffa8d6',
      brightCyan: '#8ff0f0',
      brightWhite: '#ffffff',
    },
  },
};
