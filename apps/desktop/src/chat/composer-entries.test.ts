import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_ENTRY_ROWS,
  composerMenuEntries,
  hasSubmitInterceptors,
  interceptSubmit,
  registerComposerAction,
  registerSubmitInterceptor,
} from './composer-entries';

const icon = (g: string) => `icon:${g}`;
let off: Array<() => void> = [];
afterEach(() => {
  for (const f of off) f();
  off = [];
});

describe('+ menu rows', () => {
  it('holds the four planned rows, and draws none until a lane registers one', () => {
    expect(COMPOSER_ENTRY_ROWS.map((r) => r.id)).toEqual([
      'bobble-help',
      'research',
      'workflows',
      'temporary-chat',
    ]);
    expect(composerMenuEntries(icon)).toEqual([]);
  });

  it('draws a registered row in its place, as a checkbox, a submenu or a plain row', () => {
    const onHelp = vi.fn();
    let helpOn = false;
    off.push(
      registerComposerAction({ id: 'temporary-chat', onSelect: vi.fn(), checked: () => false }),
      registerComposerAction({ id: 'bobble-help', onSelect: onHelp, checked: () => helpOn }),
      registerComposerAction({
        id: 'workflows',
        items: () => [{ key: 'wf-1', label: 'Weekly brief' }],
      }),
      registerComposerAction({ id: 'research', onSelect: vi.fn(), visible: () => false }),
    );
    const entries = composerMenuEntries(icon);
    expect(entries.map((e) => e.key)).toEqual(['bobble-help', 'workflows', 'temporary-chat']);
    expect(entries[0]).toMatchObject({
      label: 'Bobble help',
      testid: 'add-bobble-help',
      icon: 'icon:help',
      checked: false,
    });
    expect(entries[1]?.children).toEqual([{ key: 'wf-1', label: 'Weekly brief' }]);
    entries[0]?.onSelect?.();
    expect(onHelp).toHaveBeenCalledTimes(1);
    helpOn = true;
    expect(composerMenuEntries(icon)[0]?.checked).toBe(true);
  });
});

describe('submit interceptors', () => {
  const submission = { text: 'hi', agentMessage: 'hi', images: [] };

  it('are absent by default, so the composer never awaits them', () => {
    expect(hasSubmitInterceptors()).toBe(false);
  });

  it('first one to take the send wins; one that throws passes; none taking it passes', async () => {
    const seen: string[] = [];
    const onError = vi.fn();
    off.push(
      registerSubmitInterceptor({
        id: 'broken',
        intercept: () => {
          seen.push('broken');
          throw new Error('bug');
        },
      }),
      registerSubmitInterceptor({
        id: 'help',
        intercept: async (s) => {
          seen.push('help');
          return s.text.startsWith('help');
        },
      }),
      registerSubmitInterceptor({
        id: 'after',
        intercept: () => {
          seen.push('after');
          return false;
        },
      }),
    );
    expect(hasSubmitInterceptors()).toBe(true);
    expect(await interceptSubmit({ ...submission, text: 'help me' }, onError)).toBe(true);
    expect(seen).toEqual(['broken', 'help']);
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
    expect(await interceptSubmit(submission)).toBe(false);
  });
});
