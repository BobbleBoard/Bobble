import { describe, expect, it } from 'vitest';
import { flatten, isHexColor, isPurple } from './contrast.ts';
import { checkReadability, describeMisses } from './readability.ts';
import { CODE_THEMES } from './registry.ts';
import { bobbleDark, bobbleLight } from './themes/bobble.ts';
import { ANSI_NAMES, type CodeTheme, SYNTAX_SLOTS } from './types.ts';

/*
 * THE GROUNDS THE APP ACTUALLY PAINTS CODE ON.
 *
 * A house theme is judged against more than its own editor background: the
 * chat's code fences sit on the bobble base, the canvas editor on the raised
 * panel, and both wash the code-block tint over that. These are the bobble
 * flavour's tokens from packages/themes (which holds the same check against
 * the live token objects, so a retoken there fails a test there); here they
 * are the measured composites, so this package stays dependency-free.
 */
const APP_GROUNDS = {
  light: ['#f6f6f8', flatten('#f6f6f8', '#f5f5f7'), '#ffffff'],
  dark: ['#27272a', flatten('#ffffff0a', '#151517'), flatten('#ffffff0a', '#1e1e21')],
};

/**
 * Third-party slots a canonical theme genuinely sets below 3:1 against its
 * own ground. Each is the theme's published value — kept, because the theme
 * is somebody else's identity — and named here so a NEW miss still fails.
 */
const KNOWN_DIM: Readonly<Record<string, readonly string[]>> = {
  // Atom's comment grey, deliberately faint.
  'one-light': ['syntax.comment'],
  // Latte's pastel accents (green, peach, yellow, lavender) sit around 2.3–3.0.
  'catppuccin-latte': [
    'syntax.string',
    'syntax.number',
    'syntax.type',
    'syntax.property',
    'diff.addedMarker',
  ],
  // Solarized is designed around ~3:1 accents, and its comments at base1.
  'solarized-light': [
    'syntax.keyword',
    'syntax.string',
    'syntax.comment',
    'syntax.type',
    'diff.addedMarker',
  ],
  'solarized-dark': ['syntax.comment'],
  // Vitesse's muted comment and punctuation greys.
  'vitesse-light': ['syntax.comment', 'syntax.punctuation'],
  // Min's whole idea is that comments recede.
  'min-light': ['syntax.comment'],
  // Dawn's gold and rose are pastel by design; so is its muted comment.
  'rose-pine-dawn': ['syntax.string', 'syntax.number', 'syntax.comment', 'syntax.function'],
  // Ochin's function green.
  'slack-ochin': ['syntax.function'],
  // The dark themes whose comment colour is a tone lighter than the ground.
  'one-dark-pro': ['syntax.comment'],
  nord: ['syntax.comment'],
  'tokyo-night': ['syntax.comment'],
};

function allColors(theme: CodeTheme): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(theme.editor)) out.push([`editor.${k}`, v]);
  for (const slot of SYNTAX_SLOTS) out.push([`syntax.${slot}`, theme.syntax[slot]]);
  for (const [k, v] of Object.entries(theme.diff)) out.push([`diff.${k}`, v]);
  out.push(['terminal.fg', theme.terminal.fg]);
  out.push(['terminal.bg', theme.terminal.bg]);
  out.push(['terminal.cursor', theme.terminal.cursor]);
  out.push(['terminal.selection', theme.terminal.selection]);
  for (const name of ANSI_NAMES) out.push([`ansi.${name}`, theme.terminal.ansi[name]]);
  return out;
}

describe('every theme', () => {
  for (const theme of CODE_THEMES) {
    it(`${theme.id}: every colour is a hex colour`, () => {
      for (const [slot, color] of allColors(theme)) {
        expect(isHexColor(color), `${theme.id} ${slot} = ${color}`).toBe(true);
      }
    });
  }
});

describe('the house themes are readable everywhere the app paints code', () => {
  for (const theme of [bobbleLight, bobbleDark]) {
    it(`${theme.id}: every syntax slot and every ANSI colour reaches 4.5:1`, () => {
      const misses = checkReadability(theme, {
        minSyntax: 4.5,
        minAnsi: 4.5,
        backgrounds: [theme.editor.bg, ...APP_GROUNDS[theme.mode]],
      });
      expect(describeMisses(misses)).toEqual([]);
    });

    it(`${theme.id}: contains no purple, anywhere`, () => {
      const offenders = allColors(theme)
        .filter(([, color]) => isPurple(color))
        .map(([slot, color]) => `${slot} ${color}`);
      expect(offenders).toEqual([]);
    });

    it(`${theme.id}: the exempt black/white are still visible, not the ground`, () => {
      // Exempt from 4.5:1, not from existing: a dark theme's "black" and a
      // light theme's "white" are the greys a program prints dim text in.
      const dim =
        theme.mode === 'dark'
          ? [theme.terminal.ansi.black, theme.terminal.ansi.brightBlack]
          : [theme.terminal.ansi.white, theme.terminal.ansi.brightWhite];
      const misses = checkReadability(
        { ...theme, terminal: { ...theme.terminal, ansi: { ...theme.terminal.ansi } } },
        { minSyntax: 1, minAnsi: 2, backgrounds: [theme.editor.bg], exempt: [] },
      ).filter((m) => dim.includes(m.color));
      expect(describeMisses(misses)).toEqual([]);
    });
  }

  it('the red that started this is readable on the dark ground', () => {
    const misses = checkReadability(bobbleDark, {
      minSyntax: 1,
      minAnsi: 5,
      backgrounds: APP_GROUNDS.dark,
    }).filter((m) => m.slot === 'ansi.red' || m.slot === 'ansi.brightRed');
    expect(describeMisses(misses)).toEqual([]);
  });
});

describe('third-party themes keep their palettes and stay legible', () => {
  for (const theme of CODE_THEMES) {
    if (theme.firstParty) continue;
    it(`${theme.id}: syntax slots reach 3:1 on its own ground, bar the known-dim ones`, () => {
      const known = new Set(KNOWN_DIM[theme.id] ?? []);
      const misses = checkReadability(theme, { minSyntax: 3 }).filter((m) => !known.has(m.slot));
      expect(describeMisses(misses)).toEqual([]);
    });

    it(`${theme.id}: the known-dim list is not stale`, () => {
      // A relaxation that no longer relaxes anything should be removed, or the
      // list quietly grows into "everything".
      const actual = new Set(checkReadability(theme, { minSyntax: 3 }).map((m) => m.slot));
      for (const slot of KNOWN_DIM[theme.id] ?? []) {
        expect(actual.has(slot), `${theme.id} ${slot} now passes 3:1 — drop it`).toBe(true);
      }
    });
  }
});
