import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { MacBridge } from './bridge-client.js';
import { formatMacSnapshot } from './format.js';
import { createMacConsentGate } from './permissions.js';
import type { MacAgentMethod, MacSnapshot } from './protocol.js';
import { registerMacComputerUseTools } from './tools.js';

type Handler = (params: Record<string, unknown> | undefined) => unknown;

class FakeBridge implements MacBridge {
  readonly calls: Array<{ method: MacAgentMethod; params?: Record<string, unknown> }> = [];
  readonly handlers = new Map<MacAgentMethod, Handler>();
  on(method: MacAgentMethod, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }
  async request<T>(method: MacAgentMethod, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new Error(`no fake handler for ${method}`);
    return handler(params) as T;
  }
  lastParams(method: MacAgentMethod): Record<string, unknown> | undefined {
    return this.calls.filter((c) => c.method === method).at(-1)?.params;
  }
}

function toolsOf(bridge: MacBridge): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  registerMacComputerUseTools(
    { registerTool: (def: ToolDefinition) => tools.set(def.name, def) } as unknown as ExtensionAPI,
    { bridge, consent: createMacConsentGate({ preConsented: true }) },
  );
  return tools;
}

const ctx = {
  hasUI: true,
  ui: { confirm: vi.fn(async () => true) },
} as unknown as ExtensionContext;

async function click(bridge: MacBridge, params: Record<string, unknown>) {
  const tool = toolsOf(bridge).get('mac_click');
  if (tool === undefined) throw new Error('missing mac_click');
  // biome-ignore lint/suspicious/noExplicitAny: minimal execute args for tests.
  return tool.execute('call-1', params as any, undefined, undefined, ctx);
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('\n');

const SNAP = (extra: Partial<MacSnapshot> = {}): MacSnapshot =>
  ({
    app: 'TextEdit',
    pid: 4242,
    window: 'Untitled',
    elements: [{ index: 1, role: 'AXTextArea', name: 'text', bbox: { x: 1, y: 1, w: 9, h: 9 } }],
    summary: { app: 'TextEdit', window: 'Untitled', elementCount: 1, truncated: false },
    ...extra,
  }) as MacSnapshot;

describe('the menu bar', () => {
  it('presses an item by path, in the background, without opening a menu', async () => {
    const bridge = new FakeBridge().on('menuClick', () => ({
      ok: true,
      path: 'File > New',
      shortcut: '⌘N',
    }));
    const res = await click(bridge, { menu: 'File > New' });
    expect(bridge.lastParams('menuClick')?.path).toBe('File > New');
    const text = textOf(res);
    expect(text).toContain('File > New');
    expect(text).toContain('⌘N');
    expect(text.toLowerCase()).toContain('background');
  });

  it('LISTS a menu when the path names one rather than an item', async () => {
    const bridge = new FakeBridge().on('menuClick', () => ({
      ok: true,
      listed: true,
      path: 'Format',
      items: [
        { path: 'Format > Font', title: 'Font', submenu: true },
        { path: 'Format > Bold', title: 'Bold', shortcut: '⌘B' },
        { path: 'Format > Make Plain Text', title: 'Make Plain Text', enabled: false },
      ],
    }));
    const text = textOf(await click(bridge, { menu: 'Format' }));
    // Every item is offered back in the exact form the model must pass again.
    expect(text).toContain('Format > Font');
    expect(text).toContain('Format > Bold');
    expect(text).toContain('⌘B');
    expect(text).toContain('disabled');
    expect(text).toContain('▸');
  });

  it('names the app’s real menus when a path does not match', async () => {
    const bridge = new FakeBridge().on('menuClick', () => ({
      ok: false,
      error: 'no menu item matching Fyle > New',
      menus: ['File', 'Edit', 'Format'],
    }));
    const text = textOf(await click(bridge, { menu: 'Fyle > New' }));
    expect(text).toContain('File, Edit, Format');
  });

  it('borrows the focus only when asked, and says so both ways', async () => {
    const quiet = new FakeBridge().on('menuClick', () => ({ ok: true, path: 'File > New' }));
    expect(textOf(await click(quiet, { menu: 'File > New' }))).toContain(
      'stayed in the background',
    );
    expect(quiet.lastParams('menuClick')?.activate).toBe(false);

    const borrowed = new FakeBridge().on('menuClick', () => ({
      ok: true,
      path: 'File > Save',
      focusBorrowed: true,
      focusRestored: true,
    }));
    const text = textOf(await click(borrowed, { menu: 'File > Save', activate: true }));
    expect(borrowed.lastParams('menuClick')?.activate).toBe(true);
    expect(text).toContain('handed straight back');
    expect(text).not.toContain('stayed in the background');
  });

  it('does not hide it when the focus could NOT be handed back', async () => {
    const stuck = new FakeBridge().on('menuClick', () => ({
      ok: true,
      path: 'File > Save',
      focusBorrowed: true,
      focusRestored: false,
    }));
    expect(textOf(await click(stuck, { menu: 'File > Save', activate: true }))).toContain(
      'could NOT be handed back',
    );
  });

  it('does not reach the menu path when an index or a point was given', async () => {
    const bridge = new FakeBridge().on('click', () => ({ found: true, background: true }));
    await click(bridge, { index: 1 });
    await click(bridge, { x: 10, y: 20 });
    expect(bridge.calls.filter((c) => c.method === 'menuClick')).toHaveLength(0);
  });

  it('puts the top-level menus in the snapshot, with how to use them', () => {
    const text = formatMacSnapshot(SNAP({ menus: ['File', 'Edit', 'Format'] }));
    expect(text).toContain('File, Edit, Format');
    expect(text).toContain('menu:');
  });

  it('says nothing about menus when the helper could not read any', () => {
    expect(formatMacSnapshot(SNAP())).not.toContain('Menus:');
  });
});

describe('an act reports what it opened', () => {
  it('names a dialog that appeared as a result of the click', async () => {
    const bridge = new FakeBridge().on('click', () => ({
      found: true,
      background: true,
      dialog: { title: 'Save', sheet: true, windowId: 7 },
    }));
    const text = textOf(await click(bridge, { index: 1 }));
    expect(text).toContain('"Save"');
    expect(text).toContain('sheet');
    // and tells the model the sheet is this app's to drive
    expect(text).toContain('belongs to this app');
  });

  it('names a plain new window too', async () => {
    const bridge = new FakeBridge().on('click', () => ({
      found: true,
      background: true,
      opened: [{ title: 'Untitled 2', windowId: 8 }],
    }));
    expect(textOf(await click(bridge, { index: 1 }))).toContain('Untitled 2');
  });

  it('stays quiet when the act opened nothing', async () => {
    const bridge = new FakeBridge().on('click', () => ({ found: true, background: true }));
    const text = textOf(await click(bridge, { index: 1 }));
    expect(text).not.toContain('is now open');
    expect(text).not.toContain('A new window opened');
  });
});
