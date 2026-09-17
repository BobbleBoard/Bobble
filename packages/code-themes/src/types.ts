/**
 * The shape of a code theme — everything the app colours when it shows code:
 * the editor chrome, the syntax slots, diff rows and the terminal's sixteen
 * ANSI colours. One object per theme, authored by hand from the theme's
 * canonical palette, consumed by the canvas editor, the chat's code fences,
 * the terminal and the Appearance settings preview.
 *
 * Every colour is a CSS hex string: `#rrggbb`, or `#rrggbbaa` where a theme
 * genuinely defines a translucent value (a selection wash, a diff row tint).
 */

export type CodeThemeMode = 'light' | 'dark';

/** The syntax slots. They are the `--pd-syntax-*` custom properties the app
 * already consumes, plus `variable`. */
export type SyntaxSlot =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'property'
  | 'punctuation'
  | 'invalid'
  | 'variable';

export const SYNTAX_SLOTS: readonly SyntaxSlot[] = [
  'keyword',
  'string',
  'number',
  'comment',
  'function',
  'type',
  'property',
  'punctuation',
  'invalid',
  'variable',
];

export type SyntaxPalette = Record<SyntaxSlot, string>;

/** The sixteen ANSI colours, in the terminal's own order (0–7, then 8–15). */
export type AnsiName =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite';

export const ANSI_NAMES: readonly AnsiName[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

export type AnsiPalette = Record<AnsiName, string>;

export interface EditorColors {
  /** The surface code sits on. */
  bg: string;
  /** Plain text — identifiers with no slot of their own. */
  fg: string;
  lineNumber: string;
  selection: string;
  cursor: string;
}

export interface DiffColors {
  /** Row tint behind an added line. */
  addedBg: string;
  /** Row tint behind a removed line. */
  removedBg: string;
  /** The `+` marker and gutter accent of an added line. */
  addedMarker: string;
  /** The `-` marker and gutter accent of a removed line. */
  removedMarker: string;
}

export interface TerminalColors {
  fg: string;
  /** May be transparent (`#00000000`) — the house themes let the canvas panel
   * show through so the terminal has no rectangle of its own. */
  bg: string;
  cursor: string;
  selection: string;
  ansi: AnsiPalette;
}

export interface CodeTheme {
  /** Stable id, the value persisted in settings (`github-dark`, `bobble-light`). */
  id: string;
  /** Display name. */
  name: string;
  mode: CodeThemeMode;
  /** True for the house themes (Bobble Light / Bobble Dark). A first-party
   * theme follows the app's own surfaces — the generated theme sheet already
   * carries its palette as the fallback for every flavour, so applying one
   * writes no override at all (see css.ts). */
  firstParty: boolean;
  editor: EditorColors;
  syntax: SyntaxPalette;
  diff: DiffColors;
  terminal: TerminalColors;
}
