/**
 * THE CODE THEME, APPLIED. Appearance → Code appearance picks a light theme
 * and a dark one; this writes the chosen pair into the document as CSS custom
 * properties — `--pd-syntax-*`, `--pd-code-*`, `--pd-diff-*`, `--pd-ansi-*`,
 * `--pd-terminal-*` — scoped by `data-mode`, so the app's own light/dark
 * switch flips the code theme with it and nothing here needs to know which
 * mode is on.
 *
 * Every consumer reads those variables and nothing else: the canvas editor's
 * CodeMirror highlight style, the chat fences' hljs class map, the terminal
 * (which reads the computed values into xterm's theme), the diff rows. So a
 * theme lands everywhere from one `<style>` element.
 *
 * The house themes (Bobble Light / Bobble Dark) write NOTHING: the generated
 * theme sheet already carries their palette as every flavour's fallback, in
 * that flavour's own surface colours. Only a third-party theme is an override.
 *
 * Third-party themes never enter the generated sheet, and this is why: the
 * product has a no-purple rule, and Dracula's constants are purple. A purple
 * a person chose by name is their choice; a purple in the shipped sheet is
 * ours.
 */
import { codeThemeStyleSheet, resolveCodeTheme } from '@pi-desktop/code-themes';

export const CODE_THEME_STYLE_ID = 'pd-code-theme';

/** The DOM this needs — a `Document` in the app, a stub in a test. */
export interface CodeThemeTarget {
  getElementById(id: string): { textContent: string | null } | null;
  createElement(tag: 'style'): HTMLStyleElement;
  head: { appendChild(node: HTMLStyleElement): unknown };
  documentElement: {
    style: {
      setProperty(name: string, value: string): void;
      removeProperty(name: string): string;
    };
  };
}

/**
 * Write the pair into `<style id="pd-code-theme">` (created on first use).
 * An unknown id, or one of the wrong mode, resolves to the house theme — the
 * same rule the settings clamp applies on disk — so a settings file from a
 * future or a past build can never leave code uncoloured.
 */
export function applyCodeTheme(
  choice: { light?: string; dark?: string },
  doc: CodeThemeTarget = document,
): void {
  const css = codeThemeStyleSheet({
    light: resolveCodeTheme(choice.light, 'light'),
    dark: resolveCodeTheme(choice.dark, 'dark'),
  });
  let el = doc.getElementById(CODE_THEME_STYLE_ID);
  if (el === null) {
    const style = doc.createElement('style');
    style.id = CODE_THEME_STYLE_ID;
    doc.head.appendChild(style);
    el = style;
  }
  if (el.textContent !== css) el.textContent = css;
}

/**
 * The stack a custom code font sits in front of — the same one the themes
 * use, so an unrecognised name falls through to exactly what was there.
 */
const MONO_FALLBACK = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** The `font-family` value a custom font name becomes, or null for none. */
export function codeFontFamily(name: string): string | null {
  const family = name.trim();
  if (family === '') return null;
  return `'${family.replace(/'/g, '')}', ${MONO_FALLBACK}`;
}

/**
 * Apply (or clear) the custom code font as an inline `--pd-font-mono` on the
 * document root. An inline custom property wins over the theme sheet's
 * declaration for every element that reads the token — the chat's fences,
 * the canvas editor, inline code — and the terminal re-reads it when it
 * re-themes (native-surfaces.ts).
 */
export function applyCodeFont(name: string, doc: CodeThemeTarget = document): void {
  const family = codeFontFamily(name);
  if (family === null) doc.documentElement.style.removeProperty('--pd-font-mono');
  else doc.documentElement.style.setProperty('--pd-font-mono', family);
}
