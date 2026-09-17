import { describe, expect, it } from 'vitest';
import {
  ansiVariableName,
  codeThemeCss,
  codeThemeSelector,
  codeThemeStyleSheet,
  codeThemeVariables,
  houseFallbackVariables,
} from './css.ts';
import { codeTheme } from './registry.ts';
import { bobbleDark, bobbleLight } from './themes/bobble.ts';
import { dracula } from './themes/dark.ts';
import { githubLight } from './themes/light.ts';
import { ANSI_NAMES, SYNTAX_SLOTS } from './types.ts';

const names = (theme: Parameters<typeof codeThemeVariables>[0]) =>
  codeThemeVariables(theme).map(([n]) => n);

describe('variable names', () => {
  it('kebab-cases the ANSI names', () => {
    expect(ansiVariableName('red')).toBe('--pd-ansi-red');
    expect(ansiVariableName('brightBlack')).toBe('--pd-ansi-bright-black');
  });

  it('emits every slot the app consumes, once', () => {
    const all = names(dracula);
    expect(new Set(all).size).toBe(all.length);
    for (const slot of SYNTAX_SLOTS) expect(all).toContain(`--pd-syntax-${slot}`);
    for (const name of ANSI_NAMES) expect(all).toContain(ansiVariableName(name));
    for (const n of [
      '--pd-code-bg',
      '--pd-code-fg',
      '--pd-code-line-number',
      '--pd-code-selection',
      '--pd-code-cursor',
      '--pd-diff-added-bg',
      '--pd-diff-removed-bg',
      '--pd-diff-added-marker',
      '--pd-diff-removed-marker',
      '--pd-terminal-fg',
      '--pd-terminal-bg',
      '--pd-terminal-cursor',
      '--pd-terminal-selection',
    ]) {
      expect(all).toContain(n);
    }
    expect(all).toHaveLength(SYNTAX_SLOTS.length + ANSI_NAMES.length + 13);
  });

  it('carries the theme’s literal values', () => {
    const map = new Map(codeThemeVariables(dracula));
    expect(map.get('--pd-syntax-keyword')).toBe('#ff79c6');
    expect(map.get('--pd-ansi-bright-magenta')).toBe('#ff92df');
    expect(map.get('--pd-code-bg')).toBe('#282a36');
  });
});

describe('the house fallback for the generated sheet', () => {
  it('writes the palette literally but points the shared surfaces at app tokens', () => {
    const map = new Map(houseFallbackVariables(bobbleDark));
    expect(map.get('--pd-syntax-keyword')).toBe(bobbleDark.syntax.keyword);
    expect(map.get('--pd-ansi-red')).toBe(bobbleDark.terminal.ansi.red);
    expect(map.get('--pd-diff-added-bg')).toBe(bobbleDark.diff.addedBg);
    expect(map.get('--pd-code-bg')).toBe('var(--pd-code-block-bg)');
    expect(map.get('--pd-code-fg')).toBe('var(--pd-text-primary)');
    expect(map.get('--pd-code-line-number')).toBe('var(--pd-text-ghost)');
    expect(map.get('--pd-code-selection')).toBe(
      'color-mix(in srgb, var(--pd-accent-primary) 25%, transparent)',
    );
    expect(map.get('--pd-terminal-fg')).toBe('var(--pd-text-primary)');
    expect(map.get('--pd-terminal-bg')).toBe('transparent');
    expect(map.get('--pd-terminal-selection')).toBe('var(--pd-bg-selected)');
    // The caret stays the flavour's decision (see emit.ts TERMINAL_CURSOR).
    expect(map.has('--pd-terminal-cursor')).toBe(false);
  });

  it('refuses a third-party theme — those never enter the sheet', () => {
    expect(() => houseFallbackVariables(dracula)).toThrow(/not a house theme/);
  });
});

describe('the runtime override sheet', () => {
  it('is empty for the house pair: the fallback already is the theme', () => {
    expect(codeThemeStyleSheet({ light: bobbleLight, dark: bobbleDark })).toBe('');
  });

  it('scopes each third-party theme to its mode with a selector that outranks the sheet', () => {
    const css = codeThemeStyleSheet({ light: githubLight, dark: dracula });
    expect(css).toContain(`${codeThemeSelector('light')} {`);
    expect(css).toContain(`${codeThemeSelector('dark')} {`);
    expect(codeThemeSelector('dark')).toBe("html:root[data-flavor][data-mode='dark']");
    // GitHub Light's keyword under light, Dracula's under dark — and not the reverse.
    const [lightBlock, darkBlock] = css.split(codeThemeSelector('dark'));
    expect(lightBlock).toContain('--pd-syntax-keyword: #d73a49;');
    expect(darkBlock).toContain('--pd-syntax-keyword: #ff79c6;');
    expect(darkBlock).toContain('--pd-ansi-red: #ff5555;');
    expect(darkBlock).toContain('--pd-terminal-bg: #282a36;');
  });

  it('writes only the slot that is third-party', () => {
    const css = codeThemeStyleSheet({ light: bobbleLight, dark: dracula });
    expect(css).not.toContain(codeThemeSelector('light'));
    expect(css).toContain(codeThemeSelector('dark'));
  });

  it('refuses a theme in the wrong slot', () => {
    expect(() => codeThemeStyleSheet({ light: dracula, dark: bobbleDark })).toThrow(/dark theme/);
  });

  it('renders one rule per call to codeThemeCss', () => {
    const css = codeThemeCss(codeTheme('nord') as never, '.preview');
    expect(css.startsWith('.preview {\n')).toBe(true);
    expect(css.endsWith('\n}')).toBe(true);
    expect(css).toContain('  --pd-syntax-string: #a3be8c;');
  });
});
