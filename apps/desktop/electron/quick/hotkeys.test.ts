import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOTKEYS,
  formatHotkey,
  hotkeyCaps,
  hotkeyConflicts,
  hotkeyPlan,
  keyFromCode,
  normalizeHotkey,
  parseHotkey,
  recordKey,
} from './hotkeys';

const ev = (
  code: string,
  mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>>,
  key = '',
) => ({
  code,
  key,
  metaKey: mods.meta === true,
  ctrlKey: mods.ctrl === true,
  altKey: mods.alt === true,
  shiftKey: mods.shift === true,
});

describe('parseHotkey / normalizeHotkey', () => {
  it('canonicalises spellings and modifier order', () => {
    expect(normalizeHotkey('shift+alt+space')).toBe('Alt+Shift+Space');
    expect(normalizeHotkey('Cmd+Option+Shift+4')).toBe('Alt+Shift+Command+4');
    expect(normalizeHotkey('CommandOrControl+K')).toBe('Command+K');
    expect(normalizeHotkey('Ctrl+Alt+Cmd+b')).toBe('Control+Alt+Command+B');
    expect(normalizeHotkey('Control+Esc')).toBe('Control+Escape');
    expect(normalizeHotkey('Alt+F13')).toBe('Alt+F13');
  });

  it('refuses what is not one key plus modifiers', () => {
    expect(parseHotkey('')).toBeNull();
    expect(parseHotkey('Alt+')).toBeNull();
    expect(parseHotkey('Alt+Shift')).toBeNull();
    expect(parseHotkey('A+B')).toBeNull();
    expect(parseHotkey('Space+Alt')).toBeNull();
    expect(parseHotkey('Alt+Banana')).toBeNull();
    expect(parseHotkey(null)).toBeNull();
  });

  it('draws key caps in the macOS order', () => {
    expect(hotkeyCaps('Shift+Alt+Space')).toEqual(['⌥', '⇧', 'Space']);
    expect(formatHotkey('Command+Shift+Control+Alt+Up')).toBe('⌃⌥⇧⌘↑');
    expect(formatHotkey('Alt+Shift+Command+4')).toBe('⌥⇧⌘4');
    expect(hotkeyCaps(null)).toEqual([]);
  });
});

describe('recording a key', () => {
  it('reads the physical key, not the character the chord types', () => {
    // ⌥⇧A types "Å"; the hotkey is still A.
    expect(recordKey(ev('KeyA', { alt: true, shift: true }, 'Å'))).toEqual({
      kind: 'chord',
      accelerator: 'Alt+Shift+A',
    });
    expect(recordKey(ev('Digit4', { alt: true, shift: true, meta: true }, '›'))).toEqual({
      kind: 'chord',
      accelerator: 'Alt+Shift+Command+4',
    });
    expect(recordKey(ev('Space', { alt: true, shift: true }, ' '))).toEqual({
      kind: 'chord',
      accelerator: 'Alt+Shift+Space',
    });
  });

  it('waits while only modifiers are held', () => {
    expect(recordKey(ev('AltLeft', { alt: true }, 'Alt'))).toEqual({
      kind: 'pending',
      caps: ['⌥'],
    });
    expect(recordKey(ev('ShiftLeft', { alt: true, shift: true }, 'Shift'))).toEqual({
      kind: 'pending',
      caps: ['⌥', '⇧'],
    });
  });

  it('Escape cancels and Backspace clears, on their own', () => {
    expect(recordKey(ev('Escape', {}, 'Escape'))).toEqual({ kind: 'cancel' });
    expect(recordKey(ev('Backspace', {}, 'Backspace'))).toEqual({ kind: 'clear' });
    expect(recordKey(ev('Escape', { ctrl: true }, 'Escape'))).toEqual({
      kind: 'chord',
      accelerator: 'Control+Escape',
    });
  });

  it('maps codes', () => {
    expect(keyFromCode('ArrowLeft')).toBe('Left');
    expect(keyFromCode('Numpad3')).toBe('num3');
    expect(keyFromCode('F19')).toBe('F19');
    expect(keyFromCode('Slash')).toBe('/');
    expect(keyFromCode('IntlBackslash')).toBeNull();
  });
});

describe('conflicts', () => {
  const none = { summon: null, region: null, window: null, screen: null, dictate: null };

  it('the defaults are free of every conflict, and of each other', () => {
    for (const [action, accel] of Object.entries(DEFAULT_HOTKEYS)) {
      if (accel === null) continue;
      expect(
        hotkeyConflicts(accel, {
          action: action as keyof typeof DEFAULT_HOTKEYS,
          assigned: DEFAULT_HOTKEYS,
        }),
      ).toEqual([]);
    }
  });

  it('blocks what macOS owns', () => {
    const c = hotkeyConflicts('Command+Space', { action: 'summon', assigned: none });
    expect(c[0]).toEqual({ severity: 'block', reason: 'macOS uses it for Spotlight.' });
    expect(
      hotkeyConflicts('Shift+Command+4', { action: 'region', assigned: none })[0]?.severity,
    ).toBe('block');
    expect(
      hotkeyConflicts('Control+Space', { action: 'summon', assigned: none })[0]?.severity,
    ).toBe('block');
  });

  it('blocks ⌘ with a letter and keys with no strong modifier', () => {
    expect(hotkeyConflicts('Command+K', { action: 'summon', assigned: none })[0]?.reason).toMatch(
      /Every app uses ⌘/,
    );
    expect(hotkeyConflicts('Shift+A', { action: 'summon', assigned: none })[0]?.reason).toMatch(
      /ordinary typing/,
    );
    expect(hotkeyConflicts('Space', { action: 'summon', assigned: none })[0]?.severity).toBe(
      'block',
    );
  });

  it('warns about launchers, editors, VoiceOver and special characters', () => {
    expect(hotkeyConflicts('Alt+Space', { action: 'summon', assigned: none })).toEqual([
      { severity: 'warn', reason: 'Alfred and the ChatGPT launcher use it out of the box.' },
    ]);
    expect(
      hotkeyConflicts('Shift+Command+Space', { action: 'summon', assigned: none })[0]?.reason,
    ).toMatch(/VS Code/);
    expect(
      hotkeyConflicts('Control+Alt+B', { action: 'summon', assigned: none })[0]?.reason,
    ).toMatch(/VoiceOver/);
    expect(hotkeyConflicts('Alt+Shift+A', { action: 'summon', assigned: none })[0]?.reason).toMatch(
      /special character/,
    );
    expect(
      hotkeyConflicts('Shift+Command+K', { action: 'summon', assigned: none })[0]?.severity,
    ).toBe('warn');
  });

  it('blocks a key another action already has, and names it', () => {
    const c = hotkeyConflicts('alt+shift+space', {
      action: 'dictate',
      assigned: { ...none, summon: 'Alt+Shift+Space' },
    });
    expect(c).toEqual([{ severity: 'block', reason: 'Already used to open the quick panel.' }]);
  });

  it('blocks a bare Escape — it is the computer-use brake', () => {
    expect(
      hotkeyConflicts('Escape', { action: 'summon', assigned: none }).map((c) => c.reason),
    ).toContain('Escape is how you stop Bobble using an app.');
  });
});

describe('hotkeyPlan', () => {
  it('registers usable keys, canonicalised, and skips unassigned ones', () => {
    expect(hotkeyPlan(DEFAULT_HOTKEYS)).toEqual([
      { action: 'summon', accelerator: 'Alt+Shift+Space' },
      { action: 'region', accelerator: 'Alt+Shift+Command+4' },
    ]);
  });

  it('a shared key is registered for neither action', () => {
    expect(
      hotkeyPlan({
        summon: 'Alt+Shift+Space',
        dictate: 'shift+alt+space',
        window: 'Command+Space',
      }),
    ).toEqual([]);
  });

  it('a warned key is still registered', () => {
    expect(hotkeyPlan({ summon: 'Alt+Space' })).toEqual([
      { action: 'summon', accelerator: 'Alt+Space' },
    ]);
  });
});
