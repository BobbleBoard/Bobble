import { beforeEach, describe, expect, it } from 'vitest';
import {
  publishConnectors,
  publishTool,
  resetToolBus,
  sharedConnectors,
  sharedTool,
  sharedToolNames,
  shareTool,
} from './index.js';

// biome-ignore lint/suspicious/noExplicitAny: a structural stand-in for pi's ExtensionAPI.
const fakePi = (sink: unknown[]) => ({ registerTool: (d: any) => sink.push(d) }) as any;

const tool = (name: string) => ({
  name,
  description: name,
  parameters: undefined,
  execute: async () => ({ content: [{ type: 'text', text: name }] }),
});

describe('tool bus', () => {
  beforeEach(resetToolBus);

  it('registers with pi AND publishes the executor', async () => {
    const registered: unknown[] = [];
    shareTool(fakePi(registered), tool('browser_click'));
    expect(registered).toHaveLength(1);
    const found = sharedTool('browser_click');
    expect(found).toBeDefined();
    await expect(found?.execute('id', {})).resolves.toMatchObject({
      content: [{ text: 'browser_click' }],
    });
  });

  it('survives separate module graphs — the whole point', () => {
    // pi loads each extension entry on its own, so a module-level Map would give
    // every extension its own bus. The map lives on globalThis for that reason;
    // this asserts the anchor, which is the part that was wrong the first time.
    const host = globalThis as unknown as Record<symbol, Map<string, unknown>>;
    publishTool(tool('web_search'));
    expect(host[Symbol.for('@pi-desktop/tool-bus')]?.has('web_search')).toBe(true);
  });

  it('is shared across callers', () => {
    // Extensions each get their OWN ExtensionAPI, so a tool registered by one is
    // visible-but-unrunnable to another. One module-level map is what makes
    // `browser click` dispatchable from the harness's CLI.
    publishTool(tool('mac_snapshot'));
    shareTool(fakePi([]), tool('generate_image'));
    expect(sharedToolNames()).toEqual(['mac_snapshot', 'generate_image']);
  });

  it('reports nothing for a name no one shared', () => {
    expect(sharedTool('nope')).toBeUndefined();
  });
});

describe('connector roster', () => {
  beforeEach(() => resetToolBus());

  it('is empty until published, then the published list in order', () => {
    expect(sharedConnectors()).toEqual([]);
    publishConnectors([
      { id: 'time', name: 'Time', description: 'Current time.' },
      { id: 'notion', name: 'Notion' },
    ]);
    expect(sharedConnectors().map((c) => c.id)).toEqual(['time', 'notion']);
  });

  it('is one list for the whole process, whichever module graph reads it', () => {
    publishConnectors([{ id: 'time', name: 'Time' }]);
    const key = Symbol.for('@pi-desktop/tool-bus/connectors');
    expect((globalThis as unknown as Record<symbol, unknown>)[key]).toEqual([
      { id: 'time', name: 'Time' },
    ]);
  });
});
