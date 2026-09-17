/**
 * A theme as CSS custom properties — the names the app consumes.
 *
 *   --pd-syntax-<slot>            keyword, string, … (the CodeMirror highlight
 *                                 style and the hljs class map read these)
 *   --pd-code-bg / -fg / -line-number / -selection / -cursor
 *                                 the editor surface (canvas editor, chat fences)
 *   --pd-diff-added-bg / -removed-bg / -added-marker / -removed-marker
 *   --pd-terminal-fg / -bg / -cursor / -selection
 *   --pd-ansi-<name>              the sixteen terminal colours, kebab-cased
 *                                 (`--pd-ansi-bright-black`)
 *
 * Two emitters, for the two places these land:
 *
 *  - {@link houseFallbackVariables}: what `packages/themes` writes into the
 *    generated sheet for EVERY flavour, from the house theme of that mode. The
 *    slots a house theme shares with the app — the code surface, the text
 *    colour, the selection wash — are written as references to the app's own
 *    tokens rather than as Bobble's literal values, so the claude and codex
 *    flavours keep their own surfaces under the house palette.
 *
 *  - {@link codeThemeStyleSheet}: the runtime override for a chosen pair of
 *    themes, scoped by `data-mode` so switching the app's mode switches the
 *    code theme with it. A first-party theme writes nothing: the fallback the
 *    sheet already carries IS that theme.
 */
import {
  ANSI_NAMES,
  type AnsiName,
  type CodeTheme,
  type CodeThemeMode,
  SYNTAX_SLOTS,
} from './types.ts';

export type CssVariable = [name: string, value: string];

/** `brightBlack` → `--pd-ansi-bright-black`. */
export function ansiVariableName(name: AnsiName): string {
  return `--pd-ansi-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Every variable, with the theme's literal values. */
export function codeThemeVariables(theme: CodeTheme): CssVariable[] {
  const out: CssVariable[] = [];
  for (const slot of SYNTAX_SLOTS) out.push([`--pd-syntax-${slot}`, theme.syntax[slot]]);
  out.push(['--pd-code-bg', theme.editor.bg]);
  out.push(['--pd-code-fg', theme.editor.fg]);
  out.push(['--pd-code-line-number', theme.editor.lineNumber]);
  out.push(['--pd-code-selection', theme.editor.selection]);
  out.push(['--pd-code-cursor', theme.editor.cursor]);
  out.push(['--pd-diff-added-bg', theme.diff.addedBg]);
  out.push(['--pd-diff-removed-bg', theme.diff.removedBg]);
  out.push(['--pd-diff-added-marker', theme.diff.addedMarker]);
  out.push(['--pd-diff-removed-marker', theme.diff.removedMarker]);
  out.push(['--pd-terminal-fg', theme.terminal.fg]);
  out.push(['--pd-terminal-bg', theme.terminal.bg]);
  out.push(['--pd-terminal-cursor', theme.terminal.cursor]);
  out.push(['--pd-terminal-selection', theme.terminal.selection]);
  for (const name of ANSI_NAMES) out.push([ansiVariableName(name), theme.terminal.ansi[name]]);
  return out;
}

/**
 * The slots a house theme shares with the app, and the app token each one
 * follows. The terminal caret is absent on purpose: the generated sheet
 * already decides it per flavour (bobble blue, claude orange, codex a blue of
 * its own because its accent is near-black).
 */
const FOLLOWS_APP: Readonly<Record<string, string>> = {
  '--pd-code-bg': 'var(--pd-code-block-bg)',
  '--pd-code-fg': 'var(--pd-text-primary)',
  '--pd-code-line-number': 'var(--pd-text-ghost)',
  // A quarter-strength wash of the flavour's accent: strong enough to read as
  // a selection over code, translucent so every token keeps its colour.
  '--pd-code-selection': 'color-mix(in srgb, var(--pd-accent-primary) 25%, transparent)',
  '--pd-code-cursor': 'var(--pd-text-primary)',
  '--pd-terminal-fg': 'var(--pd-text-primary)',
  '--pd-terminal-bg': 'transparent',
  '--pd-terminal-selection': 'var(--pd-bg-selected)',
};

/**
 * The fallback block the generated theme sheet carries for one mode, from
 * that mode's house theme. Requires a first-party theme — a third-party
 * palette must never be baked into the sheet (see packages/themes'
 * no-purple test for why that line is drawn where it is).
 */
export function houseFallbackVariables(theme: CodeTheme): CssVariable[] {
  if (!theme.firstParty) {
    throw new Error(`${theme.id} is not a house theme and cannot be the sheet's fallback`);
  }
  return codeThemeVariables(theme)
    .filter(([name]) => name !== '--pd-terminal-cursor')
    .map(([name, value]) => [name, FOLLOWS_APP[name] ?? value]);
}

/** One rule: `selector { --a: b; … }`. */
export function codeThemeCss(theme: CodeTheme, selector: string): string {
  const lines = codeThemeVariables(theme).map(([name, value]) => `  ${name}: ${value};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
}

/**
 * The selector for one mode's override. It must beat the generated sheet's
 * `:root[data-flavor='x'][data-mode='y']` (0,3,0) wherever the override
 * element lands in the document, so it carries the type selector too:
 * (0,3,1) wins on specificity alone, regardless of order.
 */
export function codeThemeSelector(mode: CodeThemeMode): string {
  return `html:root[data-flavor][data-mode='${mode}']`;
}

/**
 * The runtime override sheet for a chosen pair. The light theme applies
 * under `[data-mode='light']`, the dark one under `[data-mode='dark']`, so
 * the app's mode toggle switches code themes on its own. A house theme in
 * either slot contributes nothing (the fallback is the theme); two house
 * themes give an empty string.
 */
export function codeThemeStyleSheet(pair: { light: CodeTheme; dark: CodeTheme }): string {
  const blocks: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const theme = pair[mode];
    if (theme.firstParty) continue;
    if (theme.mode !== mode) {
      throw new Error(`${theme.id} is a ${theme.mode} theme and cannot fill the ${mode} slot`);
    }
    blocks.push(codeThemeCss(theme, codeThemeSelector(mode)));
  }
  return blocks.join('\n');
}
