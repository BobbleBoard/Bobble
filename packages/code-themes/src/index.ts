/**
 * @pi-desktop/code-themes — the code colour themes (the house Bobble pair and
 * the well-known editor themes), their CSS variable emitters and a WCAG
 * contrast checker. Pure: no DOM anywhere, so it runs in the main process,
 * the renderer, the theme generator and the unit tests alike.
 */
export {
  composite,
  contrastRatio,
  flatten,
  isHexColor,
  isPurple,
  parseHex,
  type Rgba,
  relativeLuminance,
  toHex,
} from './contrast.ts';
export {
  ansiVariableName,
  type CssVariable,
  codeThemeCss,
  codeThemeSelector,
  codeThemeStyleSheet,
  codeThemeVariables,
  houseFallbackVariables,
} from './css.ts';
export {
  type ContrastMiss,
  checkReadability,
  defaultExemptions,
  describeMisses,
  type ReadabilityOptions,
} from './readability.ts';
export {
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
export { bobbleDark, bobbleLight } from './themes/bobble.ts';
export {
  ANSI_NAMES,
  type AnsiName,
  type AnsiPalette,
  type CodeTheme,
  type CodeThemeMode,
  type DiffColors,
  type EditorColors,
  SYNTAX_SLOTS,
  type SyntaxPalette,
  type SyntaxSlot,
  type TerminalColors,
} from './types.ts';
