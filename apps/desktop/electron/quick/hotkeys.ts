/**
 * THE QUICK PANEL'S GLOBAL HOTKEYS — parsing, display, recording and conflicts.
 *
 * A global hotkey is the one setting in the app that can break every OTHER app
 * on the Mac: whatever it is bound to stops reaching them. So a key is checked
 * before it is registered, and the checks say what would break in plain words:
 *
 *   block  the system already owns it (⌘Space, ⌘Tab, the screenshot keys), every
 *          app uses it (⌘ plus a letter), it has no ⌘/⌥/⌃ so ordinary typing would
 *          vanish into it, or another quick action already has it.
 *   warn   it works, but something common shares it — a launcher (⌥Space is
 *          Alfred's and the ChatGPT launcher's), VS Code's ⌘⇧Space, VoiceOver's
 *          ⌃⌥, or a character that ⌥ types in a text field.
 *
 * Pure: no electron, no DOM. Main registers what {@link hotkeyPlan} allows; the
 * Settings recorder shows {@link hotkeyConflicts} as the user presses keys.
 *
 * Accelerators are Electron's strings (`Alt+Shift+Space`); everything here
 * canonicalises to `Control+Alt+Shift+Command+<Key>` so two spellings of one
 * chord compare equal.
 */

/** Everything the quick panel can be summoned to do, each with its own key. */
export type QuickAction = 'summon' | 'region' | 'window' | 'screen' | 'dictate';

export const QUICK_ACTIONS: readonly QuickAction[] = [
  'summon',
  'region',
  'window',
  'screen',
  'dictate',
];

/** What each key does, as Settings lists it. */
export const QUICK_ACTION_LABELS: Readonly<Record<QuickAction, string>> = {
  summon: 'Open the quick panel',
  region: 'Ask about an area of the screen',
  window: 'Ask about the window in front',
  screen: 'Ask about the whole screen',
  dictate: 'Talk to Bobble',
};

/**
 * THE DEFAULTS, and why.
 *
 * `⌥⇧Space` to summon: next to the ⌘Space and ⌥Space muscle memory without
 * taking either — ⌘Space is Spotlight and ⌥Space is already Alfred's and the
 * ChatGPT launcher's out of the box. No system shortcut uses it, no common app
 * binds it, and the only thing it types is a non-breaking space.
 *
 * `⌥⇧⌘4` to ask about an area: macOS's own area screenshot is ⇧⌘4, so this is
 * "the screenshot you already know, plus ⌥, asked of Bobble". Free by default.
 *
 * The rest start unassigned: two keys is enough to take from a person's Mac
 * without asking, and each of the others is one click from the panel anyway.
 */
export const DEFAULT_HOTKEYS: Readonly<Record<QuickAction, string | null>> = {
  summon: 'Alt+Shift+Space',
  region: 'Alt+Shift+Command+4',
  window: null,
  screen: null,
  dictate: null,
};

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'cmd';

/** macOS order (Apple's HIG): Control, Option, Shift, Command. */
const MOD_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'cmd'];
const MOD_ACCEL: Readonly<Record<Modifier, string>> = {
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  cmd: 'Command',
};
const MOD_SYMBOL: Readonly<Record<Modifier, string>> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  cmd: '⌘',
};

export interface Hotkey {
  /** In {@link MOD_ORDER}, no repeats. */
  readonly mods: readonly Modifier[];
  /** Electron's key name: `Space`, `A`, `4`, `F5`, `Up`, `-`. */
  readonly key: string;
}

const MOD_ALIASES: Readonly<Record<string, Modifier>> = {
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  command: 'cmd',
  cmd: 'cmd',
  super: 'cmd',
  meta: 'cmd',
  // A per-platform alias; on the Mac, where this ships, it is ⌘.
  commandorcontrol: 'cmd',
  cmdorctrl: 'cmd',
};

const NAMED_KEYS: ReadonlyMap<string, string> = new Map(
  [
    'Space',
    'Tab',
    'Backspace',
    'Delete',
    'Insert',
    'Return',
    'Escape',
    'Up',
    'Down',
    'Left',
    'Right',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Plus',
  ].map((k) => [k.toLowerCase(), k]),
);
const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'Return',
  esc: 'Escape',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
};
const PUNCTUATION = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);

/** One key token → Electron's canonical name, or null when it is not a key. */
function canonicalKey(token: string): string | null {
  const t = token.trim();
  if (t === '') return null;
  const lower = t.toLowerCase();
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(t)) return t;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  if (/^num[0-9]$/.test(lower)) return lower;
  if (PUNCTUATION.has(t)) return t;
  const alias = KEY_ALIASES[lower];
  if (alias !== undefined) return alias;
  return NAMED_KEYS.get(lower) ?? null;
}

/** An Electron accelerator → its parts; null for anything that is not one key + modifiers. */
export function parseHotkey(accelerator: string | null | undefined): Hotkey | null {
  if (typeof accelerator !== 'string') return null;
  // `+` is the separator, so a literal plus is spelled `Plus` (as Electron does).
  const tokens = accelerator.split('+').map((t) => t.trim());
  if (tokens.length === 0 || tokens.some((t) => t === '')) return null;
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const token of tokens) {
    const mod = MOD_ALIASES[token.toLowerCase()];
    if (mod !== undefined) {
      if (key !== null) return null; // a modifier after the key is not a chord
      mods.add(mod);
      continue;
    }
    if (key !== null) return null; // two keys
    key = canonicalKey(token);
    if (key === null) return null;
  }
  if (key === null) return null;
  return { mods: MOD_ORDER.filter((m) => mods.has(m)), key };
}

export function hotkeyToAccelerator(hotkey: Hotkey): string {
  return [...hotkey.mods.map((m) => MOD_ACCEL[m]), hotkey.key].join('+');
}

/** The canonical spelling of an accelerator, or null when it is not one. */
export function normalizeHotkey(accelerator: string | null | undefined): string | null {
  const parsed = parseHotkey(accelerator);
  return parsed === null ? null : hotkeyToAccelerator(parsed);
}

const KEY_SYMBOL: Readonly<Record<string, string>> = {
  Space: 'Space',
  Return: '↩',
  Escape: 'esc',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘',
  Plus: '+',
};

/** The key caps a person reads, in order: `['⌥', '⇧', 'Space']`. Empty for none. */
export function hotkeyCaps(accelerator: string | null | undefined): string[] {
  const parsed = parseHotkey(accelerator);
  if (parsed === null) return [];
  return [...parsed.mods.map((m) => MOD_SYMBOL[m]), KEY_SYMBOL[parsed.key] ?? parsed.key];
}

/** One string for prose and tooltips: `⌥⇧Space`. */
export function formatHotkey(accelerator: string | null | undefined): string {
  return hotkeyCaps(accelerator).join('');
}

// ── recording ───────────────────────────────────────────────────────────────

/** The part of a KeyboardEvent the recorder reads — so it tests without a DOM. */
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const CODE_KEYS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

/**
 * The key a KeyboardEvent names — read from `code`, the PHYSICAL key, because
 * `key` is what the chord types: ⌥⇧A arrives as "Å", ⌥4 as "¢", and neither is
 * something a global hotkey can be bound to.
 */
export function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) return digit[1] ?? null;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad !== null) return `num${numpad[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] ?? null;
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS']);

export type RecordedKey =
  /** Only modifiers so far — show them and keep listening. */
  | { readonly kind: 'pending'; readonly caps: readonly string[] }
  /** Escape on its own: stop recording, keep what was there. */
  | { readonly kind: 'cancel' }
  /** Backspace or Delete on its own: take the key away. */
  | { readonly kind: 'clear' }
  | { readonly kind: 'chord'; readonly accelerator: string };

/** What one keydown means to the shortcut recorder. */
export function recordKey(e: KeyEventLike): RecordedKey {
  const mods = MOD_ORDER.filter(
    (m) =>
      (m === 'ctrl' && e.ctrlKey) ||
      (m === 'alt' && e.altKey) ||
      (m === 'shift' && e.shiftKey) ||
      (m === 'cmd' && e.metaKey),
  );
  if (MODIFIER_KEYS.has(e.key)) return { kind: 'pending', caps: mods.map((m) => MOD_SYMBOL[m]) };
  const key = keyFromCode(e.code);
  if (mods.length === 0 && key === 'Escape') return { kind: 'cancel' };
  if (mods.length === 0 && (key === 'Backspace' || key === 'Delete')) return { kind: 'clear' };
  if (key === null) return { kind: 'pending', caps: mods.map((m) => MOD_SYMBOL[m]) };
  return { kind: 'chord', accelerator: hotkeyToAccelerator({ mods, key }) };
}

// ── conflicts ───────────────────────────────────────────────────────────────

export interface HotkeyConflict {
  readonly severity: 'block' | 'warn';
  /** One plain sentence: what it collides with. */
  readonly reason: string;
}

/** Chords macOS itself owns — binding one breaks the Mac, not an app. */
const SYSTEM: ReadonlyMap<string, string> = new Map(
  (
    [
      ['Command+Space', 'Spotlight'],
      ['Alt+Command+Space', 'the Finder search window'],
      ['Control+Space', 'switching keyboard input sources'],
      ['Control+Alt+Space', 'switching keyboard input sources'],
      ['Control+Command+Space', 'the emoji and symbols viewer'],
      ['Command+Tab', 'switching apps'],
      ['Shift+Command+Tab', 'switching apps'],
      ['Command+`', 'switching windows'],
      ['Alt+Command+Escape', 'Force Quit'],
      ['Shift+Command+3', 'taking a screenshot'],
      ['Shift+Command+4', 'taking a screenshot'],
      ['Shift+Command+5', 'the screenshot toolbar'],
      ['Control+Shift+Command+3', 'taking a screenshot'],
      ['Control+Shift+Command+4', 'taking a screenshot'],
      ['Control+Command+Q', 'locking the screen'],
      ['Shift+Command+Q', 'logging out'],
      ['Control+Command+F', 'full screen'],
      ['Alt+Command+D', 'hiding the Dock'],
      ['Control+Up', 'Mission Control'],
      ['Control+Down', 'App Exposé'],
      ['Control+Left', 'moving between Spaces'],
      ['Control+Right', 'moving between Spaces'],
    ] as const
  ).map(([accel, what]) => [normalizeHotkey(accel) ?? accel, what]),
);

/** Taken by apps people commonly have open, out of the box. */
const COMMON: ReadonlyMap<string, string> = new Map(
  (
    [
      ['Alt+Space', 'Alfred and the ChatGPT launcher use it out of the box'],
      ['Shift+Command+Space', 'VS Code uses it to show parameter hints'],
      ['Control+Shift+Space', 'code editors use it for suggestions'],
    ] as const
  ).map(([accel, why]) => [normalizeHotkey(accel) ?? accel, why]),
);

function isTypingKey(key: string): boolean {
  return /^[A-Z0-9]$/.test(key) || PUNCTUATION.has(key) || key === 'Space';
}

/**
 * Everything wrong with binding `accelerator` to `action`, worst first. Empty
 * when it is fine. `assigned` is every action's current key, so a key already
 * in use by another action is reported against this one.
 */
export function hotkeyConflicts(
  accelerator: string,
  ctx: {
    readonly action: QuickAction;
    readonly assigned: Readonly<Partial<Record<QuickAction, string | null>>>;
  },
): HotkeyConflict[] {
  const parsed = parseHotkey(accelerator);
  if (parsed === null) {
    return [{ severity: 'block', reason: 'That is not a key Bobble can listen for.' }];
  }
  const accel = hotkeyToAccelerator(parsed);
  const out: HotkeyConflict[] = [];
  const has = (m: Modifier) => parsed.mods.includes(m);
  const strong = has('cmd') || has('alt') || has('ctrl');
  const fKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(parsed.key);

  for (const other of QUICK_ACTIONS) {
    if (other === ctx.action) continue;
    if (normalizeHotkey(ctx.assigned[other] ?? null) === accel) {
      out.push({
        severity: 'block',
        reason: `Already used to ${QUICK_ACTION_LABELS[other].toLowerCase()}.`,
      });
    }
  }
  const system = SYSTEM.get(accel);
  if (system !== undefined) {
    out.push({ severity: 'block', reason: `macOS uses it for ${system}.` });
  }
  if (parsed.key === 'Escape' && !strong) {
    out.push({ severity: 'block', reason: 'Escape is how you stop Bobble using an app.' });
  }
  if (!strong && !fKey) {
    out.push({
      severity: 'block',
      reason: 'Add ⌘, ⌥ or ⌃, or ordinary typing would be swallowed by it.',
    });
  } else if (!strong && fKey) {
    out.push({
      severity: 'warn',
      reason: 'Some keyboards use the F keys for brightness and volume.',
    });
  }
  // ⌘ with a letter or digit and nothing stronger: every app's own commands.
  if (
    has('cmd') &&
    !has('alt') &&
    !has('ctrl') &&
    isTypingKey(parsed.key) &&
    parsed.key !== 'Space'
  ) {
    if (has('shift')) {
      out.push({
        severity: 'warn',
        reason: 'Many apps use ⌘⇧ with a letter for their own commands.',
      });
    } else {
      out.push({
        severity: 'block',
        reason: 'Every app uses ⌘ with a letter for its own commands.',
      });
    }
  }
  const common = COMMON.get(accel);
  if (common !== undefined) out.push({ severity: 'warn', reason: `${common}.` });
  if (has('ctrl') && has('alt') && !has('cmd')) {
    out.push({ severity: 'warn', reason: 'VoiceOver uses ⌃⌥ for its own commands.' });
  }
  if (
    has('alt') &&
    !has('cmd') &&
    !has('ctrl') &&
    isTypingKey(parsed.key) &&
    parsed.key !== 'Space'
  ) {
    out.push({ severity: 'warn', reason: 'It types a special character in text fields.' });
  }
  // Worst first, and each reason once.
  const seen = new Set<string>();
  return [
    ...out.filter((c) => c.severity === 'block'),
    ...out.filter((c) => c.severity === 'warn'),
  ].filter((c) => {
    if (seen.has(c.reason)) return false;
    seen.add(c.reason);
    return true;
  });
}

/** True when the key can be registered at all (no blocking conflict). */
export function hotkeyUsable(
  accelerator: string,
  ctx: Parameters<typeof hotkeyConflicts>[1],
): boolean {
  return !hotkeyConflicts(accelerator, ctx).some((c) => c.severity === 'block');
}

/**
 * What main registers: every assigned, usable key, canonicalised. A key two
 * actions share is blocked for BOTH, so neither silently wins.
 */
export function hotkeyPlan(
  assigned: Readonly<Partial<Record<QuickAction, string | null>>>,
): Array<{ readonly action: QuickAction; readonly accelerator: string }> {
  const out: Array<{ action: QuickAction; accelerator: string }> = [];
  for (const action of QUICK_ACTIONS) {
    const accel = normalizeHotkey(assigned[action] ?? null);
    if (accel === null) continue;
    if (!hotkeyUsable(accel, { action, assigned })) continue;
    out.push({ action, accelerator: accel });
  }
  return out;
}
