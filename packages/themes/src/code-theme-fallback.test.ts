import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANSI_NAMES,
  ansiVariableName,
  bobbleDark,
  bobbleLight,
  checkReadability,
  describeMisses,
  flatten,
  SYNTAX_SLOTS,
} from '@pi-desktop/code-themes';
import { describe, expect, it } from 'vitest';
import { parseThemeId, themeIds, themes } from './tokens.ts';

/*
 * ONE SOURCE FOR THE CODE PALETTE.
 *
 * The generated sheet carries the house code theme of each mode as the
 * fallback every flavour resolves to, and the Appearance preview draws the
 * same theme from its object. If those two ever disagreed, the preview would
 * promise one thing and the canvas paint another — so the sheet is read back
 * here and compared with the objects, slot by slot, for every flavour.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(path.join(here, 'generated/themes.css'), 'utf8');

/** The `--pd-*` declarations inside one flavour×mode block of the sheet. */
function blockVars(flavor: string, mode: string): Map<string, string> {
  const head = `:root[data-flavor='${flavor}'][data-mode='${mode}'] {`;
  const start = sheet.indexOf(head);
  expect(start, `${flavor}/${mode} block`).toBeGreaterThanOrEqual(0);
  const end = sheet.indexOf('\n}', start);
  const out = new Map<string, string>();
  for (const m of sheet.slice(start, end).matchAll(/(--pd-[a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
}

const house = { light: bobbleLight, dark: bobbleDark } as const;

describe('the generated sheet carries the house code theme as its fallback', () => {
  for (const id of themeIds) {
    const { flavor, mode } = parseThemeId(id);
    it(`${id}: syntax, diff and ANSI variables equal Bobble ${mode}'s`, () => {
      const vars = blockVars(flavor, mode);
      const theme = house[mode];
      for (const slot of SYNTAX_SLOTS) {
        expect(vars.get(`--pd-syntax-${slot}`), slot).toBe(theme.syntax[slot]);
      }
      for (const name of ANSI_NAMES) {
        expect(vars.get(ansiVariableName(name)), name).toBe(theme.terminal.ansi[name]);
      }
      expect(vars.get('--pd-diff-added-bg')).toBe(theme.diff.addedBg);
      expect(vars.get('--pd-diff-removed-bg')).toBe(theme.diff.removedBg);
      expect(vars.get('--pd-diff-added-marker')).toBe(theme.diff.addedMarker);
      expect(vars.get('--pd-diff-removed-marker')).toBe(theme.diff.removedMarker);
    });

    it(`${id}: the shared surfaces follow the flavour's own tokens`, () => {
      const vars = blockVars(flavor, mode);
      expect(vars.get('--pd-code-bg')).toBe('var(--pd-code-block-bg)');
      expect(vars.get('--pd-code-fg')).toBe('var(--pd-text-primary)');
      expect(vars.get('--pd-terminal-fg')).toBe('var(--pd-text-primary)');
      expect(vars.get('--pd-terminal-bg')).toBe('transparent');
      // The caret is still the flavour's decision — bobble/claude accent,
      // codex its own blue — not something the code theme overrode.
      expect(vars.get('--pd-terminal-cursor')).toBe(
        flavor === 'codex' ? '#4a9eff' : 'var(--pd-accent-primary)',
      );
    });
  }
});

describe('the house themes match the bobble flavour they preview', () => {
  const light = themes['bobble-light'];
  const dark = themes['bobble-dark'];

  it('Bobble Light is drawn on the bobble light surfaces', () => {
    expect(bobbleLight.editor.bg).toBe(light.codeSurface.blockBg);
    expect(bobbleLight.editor.fg).toBe(light.text.primary);
    expect(bobbleLight.editor.lineNumber).toBe(light.text.ghost);
    expect(bobbleLight.editor.selection).toBe(`${light.accent.primary}40`);
    expect(bobbleLight.terminal.selection).toBe(light.bg.selected);
    expect(bobbleLight.editor.cursor).toBe(light.accent.primary);
    expect(bobbleLight.terminal.fg).toBe(light.text.primary);
    expect(bobbleLight.terminal.cursor).toBe(light.accent.primary);
  });

  it('Bobble Dark is drawn on the bobble dark surfaces', () => {
    // The dark code-block token is a wash; the preview shows it over the
    // raised canvas panel, which is where the editor actually sits.
    expect(bobbleDark.editor.bg).toBe(flatten(dark.codeSurface.blockBg, dark.bg.raised));
    expect(bobbleDark.editor.fg).toBe(dark.text.primary);
    expect(bobbleDark.editor.lineNumber).toBe(dark.text.ghost);
    expect(bobbleDark.editor.selection).toBe(`${dark.accent.primary}40`);
    expect(bobbleDark.terminal.selection).toBe(dark.bg.selected);
    expect(bobbleDark.editor.cursor).toBe(dark.accent.primary);
    expect(bobbleDark.terminal.fg).toBe(dark.text.primary);
    expect(bobbleDark.terminal.cursor).toBe(dark.accent.primary);
  });

  /*
   * READABLE WHERE THE APP PAINTS CODE. The chat's fences sit on the base,
   * the canvas editor on the raised panel, both under the code-block wash —
   * the grounds are computed from the live tokens, so a retoken that dims the
   * ground fails here rather than in a screenshot.
   */
  for (const [theme, tokens] of [
    [bobbleLight, light],
    [bobbleDark, dark],
  ] as const) {
    it(`${theme.id}: every syntax slot and ANSI colour clears 4.5:1 on the app's code grounds`, () => {
      const backgrounds = [
        flatten(tokens.codeSurface.blockBg, tokens.bg.base),
        flatten(tokens.codeSurface.blockBg, tokens.bg.raised),
      ];
      const misses = checkReadability(theme, { minSyntax: 4.5, minAnsi: 4.5, backgrounds });
      expect(describeMisses(misses)).toEqual([]);
    });
  }
});
