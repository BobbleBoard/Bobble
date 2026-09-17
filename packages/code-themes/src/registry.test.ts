import { describe, expect, it } from 'vitest';
import {
  CODE_THEMES,
  codeTheme,
  codeThemesFor,
  DARK_CODE_THEMES,
  DEFAULT_CODE_THEME_IDS,
  filterCodeThemes,
  isCodeThemeId,
  LIGHT_CODE_THEMES,
  resolveCodeTheme,
} from './registry.ts';

/** The lists the user asked for, house theme first, in this order. */
const LIGHT_NAMES = [
  'Bobble Light',
  'GitHub Light',
  'Pierre Light',
  'One Light',
  'Catppuccin Latte',
  'Solarized Light',
  'Vitesse Light',
  'Min Light',
  'Rosé Pine Dawn',
  'Slack Ochin',
];
const DARK_NAMES = [
  'Bobble Dark',
  'GitHub Dark',
  'GitHub Dark Dimmed',
  'Pierre Dark',
  'One Dark Pro',
  'Dracula',
  'Dracula Soft',
  'Catppuccin Mocha',
  'Nord',
  'Solarized Dark',
  'Vitesse Dark',
  'Min Dark',
  'Monokai',
  'Tokyo Night',
  'Night Owl',
  'Rosé Pine',
  'Ayu Dark',
];

describe('registry', () => {
  it('lists every theme, in order, the house theme first', () => {
    expect(LIGHT_CODE_THEMES.map((t) => t.name)).toEqual(LIGHT_NAMES);
    expect(DARK_CODE_THEMES.map((t) => t.name)).toEqual(DARK_NAMES);
    expect(CODE_THEMES.length).toBe(LIGHT_NAMES.length + DARK_NAMES.length);
  });

  it('ids are unique, kebab-case, and each theme sits in the list of its mode', () => {
    const ids = CODE_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of CODE_THEMES) expect(t.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const t of LIGHT_CODE_THEMES) expect(t.mode).toBe('light');
    for (const t of DARK_CODE_THEMES) expect(t.mode).toBe('dark');
  });

  it('exactly the two house themes are first-party, and they are the defaults', () => {
    expect(CODE_THEMES.filter((t) => t.firstParty).map((t) => t.id)).toEqual([
      'bobble-light',
      'bobble-dark',
    ]);
    expect(DEFAULT_CODE_THEME_IDS).toEqual({ light: 'bobble-light', dark: 'bobble-dark' });
    expect(codeThemesFor('light')[0]?.id).toBe('bobble-light');
    expect(codeThemesFor('dark')[0]?.id).toBe('bobble-dark');
  });

  it('looks a theme up by id', () => {
    expect(codeTheme('dracula')?.name).toBe('Dracula');
    expect(codeTheme('nope')).toBeUndefined();
  });

  it('resolves a persisted id for a mode, falling back to the house theme', () => {
    expect(resolveCodeTheme('dracula', 'dark').id).toBe('dracula');
    // Unknown → the house theme.
    expect(resolveCodeTheme('vaporwave', 'dark').id).toBe('bobble-dark');
    expect(resolveCodeTheme(undefined, 'light').id).toBe('bobble-light');
    // A dark theme cannot fill the light slot: never checked on a light ground.
    expect(resolveCodeTheme('dracula', 'light').id).toBe('bobble-light');
    expect(resolveCodeTheme('github-light', 'dark').id).toBe('bobble-dark');
  });

  it('validates ids per mode for the settings clamp', () => {
    expect(isCodeThemeId('nord', 'dark')).toBe(true);
    expect(isCodeThemeId('nord', 'light')).toBe(false);
    expect(isCodeThemeId(42, 'dark')).toBe(false);
    expect(isCodeThemeId('', 'light')).toBe(false);
  });

  it('filters by name, ignoring case and accents', () => {
    expect(filterCodeThemes(DARK_CODE_THEMES, 'drac').map((t) => t.id)).toEqual([
      'dracula',
      'dracula-soft',
    ]);
    expect(filterCodeThemes(LIGHT_CODE_THEMES, 'rose').map((t) => t.id)).toEqual([
      'rose-pine-dawn',
    ]);
    expect(filterCodeThemes(LIGHT_CODE_THEMES, 'ROSÉ').map((t) => t.id)).toEqual([
      'rose-pine-dawn',
    ]);
    expect(filterCodeThemes(LIGHT_CODE_THEMES, '  ')).toHaveLength(LIGHT_CODE_THEMES.length);
    expect(filterCodeThemes(LIGHT_CODE_THEMES, 'zzz')).toEqual([]);
  });
});
