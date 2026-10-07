// @vitest-environment jsdom
/**
 * "+ › Connectors" (the user, 2026-10-07, after Claude's own menu): Browse, Manage,
 * a rule, then each installed connector — its mark, its name, a switch. A
 * switch is a checkbox row that keeps the menu open.
 */
import { type AddMenuEntry, ComposerAddMenu } from '@pi-desktop/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { switchableConnectors } from './composer-connectors';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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

const CATALOG = [
  { id: 'gmail', name: 'Gmail', icon: '✉️', iconSvg: '<svg data-mark="gmail"></svg>' },
  { id: 'bobble-3d', name: 'Bobble 3D', icon: '🧊', iconSvg: '<svg data-mark="3d"></svg>' },
] as never;

describe('switchableConnectors', () => {
  it('lists the registry servers with their marks and state, then ready modules', () => {
    const list = switchableConnectors({
      catalog: CATALOG,
      registry: {
        version: 1,
        mode: 'bash-cli',
        servers: [
          { id: 'gmail', name: 'Gmail', command: 'npx', enabled: false },
          { id: 'mine', name: 'My server', icon: '🔧', command: '/x' },
        ],
      },
      moduleConnectors: {
        'bobble-3d': { ready: true, on: true, approxGB: 9 },
        other: { ready: false, on: false, approxGB: 1 },
      },
    });
    expect(list.map((c) => [c.id, c.on, c.kind])).toEqual([
      ['gmail', false, 'server'],
      ['mine', true, 'server'],
      ['bobble-3d', true, 'module'],
    ]);
    expect(list[0]?.iconSvg).toContain('data-mark="gmail"');
    expect(list[1]?.icon).toBe('🔧');
  });
});

describe('a switch row in the + menu', () => {
  it('is a checkbox row with the switch drawn on, and flipping it keeps the menu open', async () => {
    const onSelect = vi.fn();
    const entries: AddMenuEntry[] = [
      {
        key: 'connectors',
        label: 'Connectors',
        testid: 'add-connectors',
        children: [
          { key: 'browse', label: 'Browse connectors', onSelect: () => undefined },
          { key: 'rule', label: '', separator: true },
          { key: 'gmail', label: 'Gmail', switchOn: true, testid: 'sw-gmail', onSelect },
        ],
      },
    ];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const noop = () => undefined;
    await act(async () =>
      root?.render(<ComposerAddMenu open variant="full" onAddFiles={noop} entries={entries} />),
    );
    const trigger = document.body.querySelector('[data-testid="add-connectors"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    // Open the submenu the way the keyboard does.
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const row = document.body.querySelector('[data-testid="sw-gmail"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute('role')).toBe('menuitemcheckbox');
    expect(row.getAttribute('aria-checked')).toBe('true');
    expect(row.querySelector('.pd-switch[data-state="checked"]')).not.toBeNull();
    await act(async () => row.click());
    expect(onSelect).toHaveBeenCalledOnce();
    // Still open: the row is still in the document.
    expect(document.body.querySelector('[data-testid="sw-gmail"]')).not.toBeNull();
  });
});
