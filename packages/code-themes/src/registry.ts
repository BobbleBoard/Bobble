/**
 * The registry: every theme, in the order the settings lists show them — the
 * house theme first, then the well-known ones in their published order.
 */
import { bobbleDark, bobbleLight } from './themes/bobble.ts';
import { DARK_THIRD_PARTY } from './themes/dark.ts';
import { LIGHT_THIRD_PARTY } from './themes/light.ts';
import type { CodeTheme, CodeThemeMode } from './types.ts';

export const LIGHT_CODE_THEMES: readonly CodeTheme[] = [bobbleLight, ...LIGHT_THIRD_PARTY];
export const DARK_CODE_THEMES: readonly CodeTheme[] = [bobbleDark, ...DARK_THIRD_PARTY];
export const CODE_THEMES: readonly CodeTheme[] = [...LIGHT_CODE_THEMES, ...DARK_CODE_THEMES];

/** The ids a fresh install uses — one per mode. */
export const DEFAULT_CODE_THEME_IDS: Readonly<Record<CodeThemeMode, string>> = {
  light: bobbleLight.id,
  dark: bobbleDark.id,
};

const byId = new Map<string, CodeTheme>(CODE_THEMES.map((t) => [t.id, t]));

/** The theme with this id, or undefined. */
export function codeTheme(id: string): CodeTheme | undefined {
  return byId.get(id);
}

/** The themes of one mode, house theme first. */
export function codeThemesFor(mode: CodeThemeMode): readonly CodeTheme[] {
  return mode === 'light' ? LIGHT_CODE_THEMES : DARK_CODE_THEMES;
}

/**
 * The theme a persisted id names FOR THIS MODE — the house theme when the id
 * is unknown (a theme removed in an update, a hand-edited settings file) or
 * names a theme of the other mode (a dark theme cannot be the light slot's
 * choice: its palette was never checked against a light ground).
 */
export function resolveCodeTheme(id: string | undefined, mode: CodeThemeMode): CodeTheme {
  const found = id === undefined ? undefined : byId.get(id);
  if (found !== undefined && found.mode === mode) return found;
  const fallback = byId.get(DEFAULT_CODE_THEME_IDS[mode]);
  if (fallback === undefined) throw new Error(`no default code theme for ${mode}`);
  return fallback;
}

/** Is this id a theme of the given mode? What the settings clamp asks. */
export function isCodeThemeId(id: unknown, mode: CodeThemeMode): id is string {
  return typeof id === 'string' && byId.get(id)?.mode === mode;
}

/**
 * The themes whose name contains the query, case- and accent-insensitively —
 * the filter box above each list. An empty query keeps everything.
 */
export function filterCodeThemes(themes: readonly CodeTheme[], query: string): CodeTheme[] {
  const q = fold(query);
  if (q === '') return [...themes];
  return themes.filter((t) => fold(t.name).includes(q) || fold(t.id).includes(q));
}

/** Lower-case, trimmed, with the accents stripped ("Rosé" matches "rose"). */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();
}
