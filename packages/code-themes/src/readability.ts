/**
 * The contrast checker: does every colour a theme paints text in reach a
 * ratio against the ground it is painted on? Returns the misses rather than
 * throwing, so a test can list them and a settings screen could show them.
 */
import { contrastRatio } from './contrast.ts';
import {
  ANSI_NAMES,
  type AnsiName,
  type CodeTheme,
  SYNTAX_SLOTS,
  type SyntaxSlot,
} from './types.ts';

export interface ContrastMiss {
  /** `syntax.keyword`, `ansi.red`, `editor.fg`, `diff.addedMarker`. */
  slot: string;
  color: string;
  /** The ground it was judged against. */
  background: string;
  ratio: number;
  required: number;
}

export interface ReadabilityOptions {
  /** Minimum ratio for the syntax slots and the editor foreground. */
  minSyntax: number;
  /** Minimum ratio for the terminal's colours (the ANSI sixteen and its
   * foreground). Omit to skip the terminal. */
  minAnsi?: number;
  /** Grounds to judge against. Defaults to the theme's own editor
   * background; the house themes are also held to the app's code-block
   * backgrounds, which the caller passes in. */
  backgrounds?: readonly string[];
  /** Slots exempt from the check, e.g. `ansi.black` on a dark theme, where
   * being near the ground is the point. */
  exempt?: readonly string[];
}

/** Black on a dark theme and white on a light one are dim BY DESIGN. */
export function defaultExemptions(theme: CodeTheme): string[] {
  return theme.mode === 'dark'
    ? ['ansi.black', 'ansi.brightBlack']
    : ['ansi.white', 'ansi.brightWhite'];
}

/**
 * Every (slot, ground) pair that falls short. The editor foreground is held
 * to the syntax minimum; diff markers to the syntax minimum too, since they
 * are read as text in a gutter.
 */
export function checkReadability(theme: CodeTheme, options: ReadabilityOptions): ContrastMiss[] {
  const grounds = options.backgrounds ?? [theme.editor.bg];
  const exempt = new Set(options.exempt ?? defaultExemptions(theme));
  const misses: ContrastMiss[] = [];
  const judge = (slot: string, color: string, required: number): void => {
    if (exempt.has(slot)) return;
    for (const background of grounds) {
      const ratio = contrastRatio(color, background, theme.mode === 'dark' ? '#000000' : '#ffffff');
      if (ratio < required) misses.push({ slot, color, background, ratio, required });
    }
  };
  judge('editor.fg', theme.editor.fg, options.minSyntax);
  for (const slot of SYNTAX_SLOTS satisfies readonly SyntaxSlot[]) {
    judge(`syntax.${slot}`, theme.syntax[slot], options.minSyntax);
  }
  judge('diff.addedMarker', theme.diff.addedMarker, options.minSyntax);
  judge('diff.removedMarker', theme.diff.removedMarker, options.minSyntax);
  if (options.minAnsi !== undefined) {
    judge('terminal.fg', theme.terminal.fg, options.minAnsi);
    for (const name of ANSI_NAMES satisfies readonly AnsiName[]) {
      judge(`ansi.${name}`, theme.terminal.ansi[name], options.minAnsi);
    }
  }
  return misses;
}

/** `syntax.comment #5c6370 on #f6f6f8: 2.61 < 4.5` — one line per miss. */
export function describeMisses(misses: readonly ContrastMiss[]): string[] {
  return misses.map(
    (m) => `${m.slot} ${m.color} on ${m.background}: ${m.ratio.toFixed(2)} < ${m.required}`,
  );
}
