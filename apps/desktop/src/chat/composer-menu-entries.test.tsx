// @vitest-environment jsdom
/**
 * The `+` menu with and without the rows features add (the W0-A pre-wire): with
 * none it is the menu it was — the same rows, the same one rule — and with
 * some, they are one more group at the end, behind exactly one more rule.
 */
import { type AddMenuEntry, ComposerAddMenu } from '@pi-desktop/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Radix measures and observes; jsdom has neither.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function openMenu(
  entries?: readonly AddMenuEntry[],
): Promise<{ rows: string[]; rules: number }> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const noop = () => undefined;
  await act(async () =>
    root?.render(
      <ComposerAddMenu
        open
        variant="full"
        onAddFiles={noop}
        onGenerateImage={noop}
        onGenerateVideo={noop}
        onGenerateMotion={noop}
        onPerception={noop}
        {...(entries !== undefined ? { entries } : {})}
      />,
    ),
  );
  const menu = document.body.querySelector('[role="menu"]');
  const rows = [
    ...(menu?.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]') ?? []),
  ].map((e) => e.textContent?.trim() ?? '');
  const rules = menu?.querySelectorAll('[role="separator"]').length ?? 0;
  return { rows, rules };
}

describe('the + menu and the rows features add', () => {
  it('without entries: the composer menu as it was', async () => {
    const { rows, rules } = await openMenu();
    expect(rows).toEqual([
      'Add files or photos⌘U',
      'Generate image',
      'Generate video',
      'Motion graphics',
      'Find / segment in image or video',
    ]);
    expect(rules).toBe(1);
  });

  it('an empty list is the same as none — no stray rule', async () => {
    const { rules } = await openMenu([]);
    expect(rules).toBe(1);
  });

  it('with entries: one more group at the end, behind one more rule', async () => {
    const onHelp = vi.fn();
    const { rows, rules } = await openMenu([
      {
        key: 'bobble-help',
        label: 'Bobble help',
        checked: false,
        onSelect: onHelp,
        testid: 'add-bobble-help',
      },
      { key: 'research', label: 'Research', testid: 'add-research' },
      { key: 'workflows', label: 'Workflows', children: [{ key: 'w1', label: 'Weekly brief' }] },
    ]);
    expect(rows.slice(0, 5)).toEqual([
      'Add files or photos⌘U',
      'Generate image',
      'Generate video',
      'Motion graphics',
      'Find / segment in image or video',
    ]);
    expect(rows.slice(5)).toEqual(['Bobble help', 'Research', 'Workflows']);
    expect(rules).toBe(2);
    expect(
      document.body.querySelector('[data-testid="add-bobble-help"]')?.getAttribute('role'),
    ).toBe('menuitemcheckbox');
  });
});
