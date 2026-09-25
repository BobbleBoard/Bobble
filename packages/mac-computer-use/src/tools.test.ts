import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { MacBridge } from './bridge-client.js';
import { createMacConsentGate, type MacConsentGate } from './permissions.js';
import type { MacAgentMethod } from './protocol.js';
import { createMacSessionState } from './session-state.js';
import { registerChromeTools, registerMacComputerUseTools } from './tools.js';

type Handler = (params: Record<string, unknown> | undefined) => unknown;

/** A programmable fake bridge that records every call (the "mock helper"). */
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

  countOf(method: MacAgentMethod): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** The params of the LAST call to `method` — what actually went on the wire. */
  lastParams(method: MacAgentMethod): Record<string, unknown> | undefined {
    return this.calls.filter((c) => c.method === method).at(-1)?.params;
  }
}

const SNAP = (elements: unknown[] = [], pid = 4242) => ({
  app: 'TextEdit',
  pid,
  window: 'Untitled',
  windowId: 99,
  elements,
  summary: { app: 'TextEdit', window: 'Untitled', elementCount: elements.length, truncated: false },
});

/** ctx stub whose confirm returns yes (so the consent flow can be exercised). */
function ctxStub(hasUI = true, confirmResult = true): ExtensionContext {
  return {
    hasUI,
    ui: { confirm: vi.fn(async () => confirmResult) },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub.
  } as any as ExtensionContext;
}

function collectTools(
  bridge: MacBridge | null,
  consent: MacConsentGate = createMacConsentGate({ preConsented: true }),
): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  /* No Apple Events in a unit test. The real reader talks to whatever Chrome is
     open on the machine running the suite, and it answered BEFORE the fake
     bridge — so the tabs test passed only while that browser had two tabs and
     failed when it had one. Returning null here puts the fake bridge back in
     charge, which is the only thing these tests are supposed to be measuring. */
  registerMacComputerUseTools(pi, { bridge, consent, readChromeTabs: async () => null });
  registerChromeTools(pi, bridge, { isChromeRunning: async () => chromeUp, ...NO_APPLE_EVENTS });
  return tools;
}
/** What the fake "is Chrome running?" answers; tests flip it. */
let chromeUp = true;
/*
 * NEVER THE REAL CHROME. The Apple-Events route reads Chrome's setting, can
 * WRITE it (after a confirm the ctx stub answers yes to), and runs osascript
 * against whatever Chrome the machine running the suite has open. Every test
 * gets this instead: scripting allowed, and a page that never answers.
 */
const NO_APPLE_EVENTS = {
  chromeJsAllowed: async () => true,
  enableChromeJs: async () => ({ ok: false, stderr: 'not in a unit test' }),
  chromeEval: async () => ({ ok: false, value: '', error: 'no Chrome in a unit test' }),
};

async function run(
  tools: Map<string, ToolDefinition>,
  name: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext = ctxStub(),
) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  // biome-ignore lint/suspicious/noExplicitAny: minimal execute args for tests.
  return tool.execute('call-1', params as any, undefined, undefined, ctx);
}

// biome-ignore lint/suspicious/noExplicitAny: reach into the untyped details bag.
const details = (r: { details: unknown }) => r.details as any;

describe('registerMacComputerUseTools', () => {
  it("registers the full tool set — the mac_* set and Chrome's own", () => {
    const tools = collectTools(new FakeBridge());
    expect([...tools.keys()].sort()).toEqual(
      [
        'chrome_tab',
        'chrome_tabs',
        'mac_click',
        'mac_key',
        'mac_launch',
        'mac_scroll',
        'mac_snapshot',
        'mac_type',
        'chrome_click',
        'chrome_go',
        'chrome_snapshot',
        'chrome_type',
      ].sort(),
    );
  });

  it('reports a clear error (never throws) when the bridge is unavailable', async () => {
    const tools = collectTools(null);
    const r = await run(tools, 'mac_snapshot', {});
    expect(details(r).ok).toBe(false);
    /* The model quotes its errors back to the user, so this string is user
     * copy: it names neither the internal codename nor the extension. */
    expect(details(r).error).toBe("Mac control isn't available in this session.");
    expect(details(r).error).not.toMatch(/Pi Desktop|extension|bridge/i);
  });

  it('snapshot formats the indexed element list and passes app/cap', async () => {
    const bridge = new FakeBridge().on('snapshot', () =>
      SNAP([
        {
          index: 1,
          role: 'AXTextArea',
          name: 'text entry area',
          bbox: { x: 1, y: 2, w: 3, h: 4 },
          editable: true,
        },
      ]),
    );
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', { app: 'TextEdit' });
    expect(details(r).ok).toBe(true);
    expect(String(r.content[0]?.type === 'text' ? r.content[0].text : '')).toContain(
      '[1] AXTextArea',
    );
    expect(bridge.calls[0]).toMatchObject({
      method: 'snapshot',
      params: { app: 'TextEdit', cap: 60 },
    });
  });

  it('snapshot attaches a screenshot image when the helper returns base64', async () => {
    const bridge = new FakeBridge().on('snapshot', () => ({
      ...SNAP(),
      screenshot: { path: '/tmp/x.png', base64: 'AAAA', mimeType: 'image/png' },
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', { screenshot: true });
    const img = r.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
  });

  /* the user (2026-09-15): "add a flag … 'visual' or 'screenshot' … to force
     visual even on text based control apps". */
  /*
   * the user (2026-09-23): "the snapshot tool should accept a flag that gives a
   * visual snapshot no text, when this flag is here it just passes an image
   * back." And with no text to print the picture's offset, a coordinate click
   * right after it is read straight off the picture.
   */
  it('`visual` returns the picture and nothing else', async () => {
    const bridge = new FakeBridge().on('snapshot', () => ({
      ...SNAP([{ index: 1, role: 'AXButton', name: 'OK' }]),
      screenshot: {
        path: '/tmp/x.png',
        base64: 'BBBB',
        mimeType: 'image/jpeg',
        rect: { x: 244, y: 45, w: 1024, h: 822 },
        inlineWidth: 1024,
        inlineHeight: 822,
      },
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', { visual: true });
    expect(bridge.calls[0]).toMatchObject({ method: 'snapshot', params: { screenshot: true } });
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: 'image', data: 'BBBB' });
  });

  it('a click right after a visual look is a point ON the picture; after a plain look it is screen points', async () => {
    let withRect = true;
    const bridge = new FakeBridge()
      .on('snapshot', () => ({
        ...SNAP([{ index: 1, role: 'AXButton', name: 'OK' }]),
        screenshot: withRect
          ? {
              path: '/tmp/x.png',
              base64: 'BBBB',
              rect: { x: 244, y: 45, w: 1024, h: 822 },
              inlineWidth: 512,
              inlineHeight: 411,
            }
          : undefined,
      }))
      .on('click', () => ({ found: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { visual: true });
    const r = await run(tools, 'mac_click', { x: 100, y: 50 });
    // Half-size picture: (100, 50) on it is (244 + 200, 45 + 100) on screen.
    expect(bridge.lastParams('click')).toMatchObject({ x: 444, y: 145 });
    expect((r.content[0] as { text: string }).text).toContain('(100, 50) on the picture');
    withRect = false;
    await run(tools, 'mac_snapshot', {});
    await run(tools, 'mac_click', { x: 100, y: 50 });
    expect(bridge.lastParams('click')).toMatchObject({ x: 100, y: 50 });
  });

  it('a picture asked for and not taken says why, first — and names the grant', async () => {
    const bridge = new FakeBridge().on('snapshot', () => ({
      ...SNAP([{ index: 1, role: 'AXButton', name: 'OK' }]),
      screenshot: { error: 'screen-recording-denied' },
      permissions: { accessibility: true, screenRecording: false },
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', { screenshot: true });
    const text = (r.content[0] as { text: string }).text;
    expect(text.startsWith('You asked for a picture and none could be taken')).toBe(true);
    expect(text).toContain('Allow Screen Recording');
    expect(r.content.find((c) => c.type === 'image')).toBeUndefined();
    // --visual says the same, and points at the plain snapshot instead.
    const v = await run(tools, 'mac_snapshot', { visual: true });
    expect((v.content[0] as { text: string }).text).toContain('Screen Recording');
    expect((v.content[0] as { text: string }).text).toContain('plain mac_snapshot');
  });

  it('click by index re-snapshots + retries once on a stale index', async () => {
    let clicks = 0;
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP())
      .on('click', () => ({ found: ++clicks > 1 })); // first stale, then found
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_click', { index: 3 });
    expect(details(r).ok).toBe(true);
    expect(bridge.countOf('click')).toBe(2);
    expect(bridge.countOf('snapshot')).toBe(1); // one re-snapshot between attempts
    expect(bridge.calls[0]).toMatchObject({ method: 'click', params: { index: 3 } });
  });

  it('click accepts explicit x,y coordinates', async () => {
    const bridge = new FakeBridge().on('click', () => ({ ok: true }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_click', { x: 12, y: 34 });
    expect(details(r).ok).toBe(true);
    expect(bridge.calls[0]).toMatchObject({ method: 'click', params: { x: 12, y: 34 } });
  });

  it('type by index passes index+text; focused type omits index', async () => {
    const bridge = new FakeBridge().on('type', () => ({ found: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_type', { index: 1, text: 'hello from Pi' });
    expect(bridge.calls[0]).toMatchObject({
      method: 'type',
      params: { index: 1, text: 'hello from Pi' },
    });
    await run(tools, 'mac_type', { text: 'more' });
    expect(bridge.calls[1]).toMatchObject({ method: 'type', params: { text: 'more' } });
  });

  it('refuses index-less typing into an app that DOES expose Accessibility', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([{ index: 1, role: 'AXTextField', title: 'Search' }], 555))
      .on('type', () => ({ found: true }));
    const tools = collectTools(bridge);
    // Before any snapshot: focused typing is allowed (genuine frontmost use).
    await run(tools, 'mac_type', { text: 'ok before snapshot' });
    expect(bridge.countOf('type')).toBe(1);
    // After snapshotting a target app that has indices, index-less typing would
    // hit the user's frontmost app instead — and there IS a better way, so refuse.
    await run(tools, 'mac_snapshot', { app: 'Maps' });
    const r = await run(tools, 'mac_type', { text: 'San Francisco to Palo Alto', submit: true });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('index');
    expect(bridge.countOf('type')).toBe(1); // never reached the bridge again
  });

  /*
   * ...and the other half, which is the case that used to dead-end: an app with
   * NO Accessibility tree has no index to pass, so refusing for want of one told
   * the model to do something impossible. the user: "if an app is not visually
   * controllable … type needs to just type into active field."
   */
  it('types into an app that exposes no Accessibility, in the background', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([], 555)) // no elements → visual only
      .on('type', () => ({ found: true, background: true, mode: 'keystrokesToPid' }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { app: 'Preview' });
    const r = await run(tools, 'mac_type', { text: 'hello', submit: true });
    expect(details(r).ok).toBe(true);
    expect(bridge.countOf('type')).toBe(1);
    /* Stamped with the target's pid, so the helper delivers the keystrokes to
     * THAT process rather than to whatever the user is looking at — no window
     * comes forward, nothing is stolen. */
    expect(bridge.lastParams('type')).toMatchObject({ pid: 555, text: 'hello' });
    expect(bridge.countOf('launch')).toBe(0);
  });

  // --- background/foreground flag (AX-action path) ---------------------------

  it('surfaces the background flag + mode when the helper sets a value via AX', async () => {
    const bridge = new FakeBridge().on('type', () => ({
      found: true,
      mode: 'setValue',
      background: true,
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_type', { index: 1, text: 'hi' });
    expect(details(r).ok).toBe(true);
    expect(details(r).background).toBe(true);
    expect(details(r).mode).toBe('setValue');
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(String(text)).toContain('background via setValue');
  });

  it('marks a click as foreground when the helper falls back to a coordinate click', async () => {
    const bridge = new FakeBridge().on('click', () => ({
      found: true,
      mode: 'coord',
      background: false,
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_click', { index: 1 });
    expect(details(r).background).toBe(false);
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(String(text)).toContain('foreground');
  });

  it('type forwards submit:true so the helper can commit a search field', async () => {
    const bridge = new FakeBridge().on('type', () => ({
      found: true,
      mode: 'setValue+confirm',
      background: true,
      submitted: true,
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_type', { index: 1, text: 'san francisco', submit: true });
    expect(bridge.calls[0]).toMatchObject({
      method: 'type',
      params: { index: 1, text: 'san francisco', submit: true },
    });
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(String(text)).toContain('Submitted');
  });

  // --- per-pid concurrency namespacing --------------------------------------

  it('stamps the snapshotted pid onto later click/type (concurrency-safe indices)', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([], 7777))
      .on('click', () => ({ found: true, mode: 'AXPress', background: true }))
      .on('type', () => ({ found: true, mode: 'setValue', background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { app: 'TextEdit' });
    await run(tools, 'mac_click', { index: 2 });
    await run(tools, 'mac_type', { index: 3, text: 'x' });
    const click = bridge.calls.find((c) => c.method === 'click');
    const type = bridge.calls.find((c) => c.method === 'type');
    expect(click?.params).toMatchObject({ index: 2, pid: 7777 });
    expect(type?.params).toMatchObject({ index: 3, pid: 7777 });
  });

  it('launch opens in the background by default and foregrounds on request', async () => {
    const bridge = new FakeBridge().on('launch', () => ({ ok: true, app: 'Maps' }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'Maps' });
    await run(tools, 'mac_launch', { app: 'Maps', foreground: true });
    // (each launch also attempts its immediate snapshot — filter to launches)
    const launches = bridge.calls.filter((c) => c.method === 'launch');
    expect(launches[0]).toMatchObject({ method: 'launch', params: { background: true } });
    expect(launches[1]).toMatchObject({ method: 'launch', params: { background: false } });
  });

  it('names real tools, never a glob — a glob cannot be renamed for CLI mode', async () => {
    /*
     * The launch result said "All mac_* actions now target it automatically".
     * `mac_*` matches no tool, so the rename that teaches results to speak
     * commands could not touch it, and it shipped into a mode where none of
     * those names exist. MEASURED: a 4B launched Calculator, read a perfect
     * indexed snapshot, and then went off to edit a preferences file — it had
     * been handed a list and no runnable verb.
     */
    const bridge = new FakeBridge().on('launch', () => ({ ok: true, app: 'Calculator' }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'Calculator' });
    const text = r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).not.toContain('mac_*');
    expect(text).toContain('mac_snapshot');
    expect(text).toContain('mac_click');
  });

  it('key forwards the combo', async () => {
    const bridge = new FakeBridge().on('key', () => ({ ok: true }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_key', { combo: 'cmd+s' });
    expect(details(r).ok).toBe(true);
    expect(bridge.calls[0]).toMatchObject({ method: 'key', params: { combo: 'cmd+s' } });
  });

  it('launch focuses/launches the named app', async () => {
    const bridge = new FakeBridge().on('launch', () => ({ ok: true, app: 'TextEdit' }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'TextEdit' });
    expect(details(r).ok).toBe(true);
    expect(bridge.calls[0]).toMatchObject({ method: 'launch', params: { app: 'TextEdit' } });
  });

  it('surfaces a bridge failure as a structured error instead of throwing', async () => {
    const bridge = new FakeBridge().on('key', () => {
      throw new Error('boom');
    });
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_key', { combo: 'cmd+s' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toBe('boom');
  });

  // --- consent gating -------------------------------------------------------

  it('the first action asks for consent, then acts; a decline blocks without acting', async () => {
    const bridge = new FakeBridge().on('key', () => ({ ok: true }));
    // Fresh (not pre-consented) gate; ctx confirm returns NO.
    const declineGate = createMacConsentGate();
    const tools = collectTools(bridge, declineGate);
    const declined = await run(tools, 'mac_key', { combo: 'cmd+s' }, ctxStub(true, false));
    expect(details(declined).ok).toBe(false);
    expect(bridge.countOf('key')).toBe(0); // never reached the bridge

    // A fresh gate that says YES: acts, and remembers so the next call skips the prompt.
    const yesGate = createMacConsentGate();
    const tools2 = collectTools(bridge, yesGate);
    const ctx = ctxStub(true, true);
    await run(tools2, 'mac_key', { combo: 'cmd+s' }, ctx);
    await run(tools2, 'mac_key', { combo: 'cmd+z' }, ctx);
    expect(bridge.countOf('key')).toBe(2);
    expect((ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('refuses a denylisted target (mac_launch Pi Desktop) even when consented', async () => {
    const bridge = new FakeBridge().on('launch', () => ({ ok: true }));
    const tools = collectTools(bridge); // pre-consented
    const r = await run(tools, 'mac_launch', { app: 'Pi Desktop' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('denylist');
    expect(bridge.countOf('launch')).toBe(0);
  });

  // --- the controlled-app loop (snapshot-after-open contract) ----------------

  const DOC_RECT = { x: 100, y: 60, w: 900, h: 700 };
  const SHEET_RECT = { x: 300, y: 180, w: 560, h: 320 };

  const LAUNCH_ACK = {
    ok: true,
    app: 'TextEdit',
    pid: 4242,
    bounds: { ok: true, pid: 4242, x: 10, y: 20, w: 800, h: 600, windowId: 99 },
  };

  it('launch returns a fresh snapshot AND a window screenshot in the SAME tool result', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('snapshot', () => ({
        ...SNAP([
          {
            index: 1,
            role: 'AXTextArea',
            name: 'text entry area',
            bbox: { x: 1, y: 2, w: 3, h: 4 },
            editable: true,
          },
        ]),
        screenshot: { path: '/tmp/win.png', base64: 'IMGB64', mimeType: 'image/png' },
      }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'TextEdit' });

    // The immediate snapshot targeted the launched pid, with a screenshot.
    const snapCall = bridge.calls.find((c) => c.method === 'snapshot');
    expect(snapCall?.params).toMatchObject({ pid: 4242, screenshot: true });

    // The ONE result carries: launch note + controlled-app statement + indexed
    // elements (text) + the window screenshot (image).
    const text = String(r.content[0]?.type === 'text' ? r.content[0].text : '');
    expect(text).toContain('did NOT take focus');
    expect(text).toContain('controlling "TextEdit"');
    expect(text).toContain('[1] AXTextArea');
    const img = r.content.find((c) => c.type === 'image');
    expect(img).toMatchObject({ type: 'image', data: 'IMGB64', mimeType: 'image/png' });

    expect(details(r)).toMatchObject({
      action: 'launch',
      ok: true,
      app: 'TextEdit',
      pid: 4242,
      background: true,
      controlled: true,
      snapshot: true,
      screenshot: true,
    });
  });

  it('after launch, EVERY act stamps the controlled pid (unambiguous routing)', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('snapshot', () => SNAP([], 4242))
      .on('click', () => ({ found: true, mode: 'AXPress', background: true }))
      .on('key', () => ({ ok: true, background: true }))
      .on('scroll', () => ({ ok: true, background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'TextEdit' });
    await run(tools, 'mac_click', { index: 2 });
    await run(tools, 'mac_click', { x: 100, y: 200 }); // coordinate click too
    await run(tools, 'mac_key', { combo: 'cmd+s' });
    await run(tools, 'mac_scroll', { direction: 'down' });
    const acts = bridge.calls.filter((c) => c.method !== 'launch' && c.method !== 'snapshot');
    expect(acts).toHaveLength(4);
    for (const act of acts) expect(act.params).toMatchObject({ pid: 4242 });
  });

  it('mac_scroll surfaces the helper-verified ladder ack (mode + honest no-movement)', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('snapshot', () => SNAP([], 4242))
      .on('scroll', (params) =>
        params?.direction === 'down'
          ? { ok: true, background: true, mode: 'gestureToPid', moved: true }
          : { ok: true, background: true, mode: 'exhausted', moved: false },
      );
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'TextEdit' });

    const moved = await run(tools, 'mac_scroll', { direction: 'down' });
    expect(details(moved)).toMatchObject({ ok: true, mode: 'gestureToPid', moved: true });
    const movedText = String(moved.content[0]?.type === 'text' ? moved.content[0].text : '');
    expect(movedText).toContain('Scrolled down');

    const stuck = await run(tools, 'mac_scroll', { direction: 'up' });
    expect(details(stuck)).toMatchObject({ ok: true, mode: 'exhausted', moved: false });
    const stuckText = String(stuck.content[0]?.type === 'text' ? stuck.content[0].text : '');
    expect(stuckText).toContain('NO effect');
  });

  it('a default (app-less) snapshot targets the CONTROLLED app, not frontmost', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('snapshot', () => SNAP([], 4242));
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'TextEdit' });
    await run(tools, 'mac_snapshot', {});
    const second = bridge.calls.filter((c) => c.method === 'snapshot')[1];
    // The pid targets the running app; its name rides along so a pid that has
    // quit since (a relaunch) still resolves instead of failing the look.
    expect(second?.params).toMatchObject({ pid: 4242, app: 'TextEdit' });
  });

  it('launch degrades to text-only (still ok) when the post-open snapshot fails', async () => {
    const bridge = new FakeBridge().on('launch', () => LAUNCH_ACK); // no snapshot handler
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'TextEdit' });
    expect(details(r).ok).toBe(true);
    const text = String(r.content[0]?.type === 'text' ? r.content[0].text : '');
    expect(text).toContain('snapshot after launch failed');
    expect(r.content.find((c) => c.type === 'image')).toBeUndefined();
  });

  // --- the app's OWN dialogs, sheets and file pickers ------------------------

  /*
   * the user's named failure: "the model clicks Open in TextEdit, a file dialog
   * appears — that dialog is part of TextEdit, not Finder — and the model must
   * be able to see and drive it."
   */
  const SHEET_SNAP = (pid = 4242) => ({
    app: 'TextEdit',
    pid,
    window: 'Untitled',
    windowId: 3,
    windows: [
      { windowId: 3, role: 'AXWindow', title: 'Untitled', frame: DOC_RECT, main: true },
      {
        windowId: 7,
        role: 'AXSheet',
        title: 'Save',
        frame: SHEET_RECT,
        sheet: true,
        modal: true,
      },
    ],
    dialog: { title: 'Save', role: 'AXSheet' },
    elements: [
      { index: 1, role: 'AXTextArea', name: 'text entry area', editable: true, win: 3 },
      {
        index: 2,
        role: 'AXTextField',
        name: 'Save As:',
        value: 'Untitled',
        editable: true,
        focused: true,
        win: 7,
      },
      { index: 3, role: 'AXButton', name: 'Save', win: 7 },
      { index: 4, role: 'AXButton', name: 'Cancel', win: 7 },
    ],
    summary: { app: 'TextEdit', window: 'Untitled', elementCount: 4, truncated: false },
  });

  it('announces an open sheet BEFORE the indices, and names it in the details', async () => {
    const bridge = new FakeBridge().on('snapshot', () => SHEET_SNAP());
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', {});
    expect(details(r).dialog).toBe('Save');
    const text = String(r.content[0]?.type === 'text' ? r.content[0].text : '');
    expect(text.indexOf('A DIALOG IS OPEN')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('A DIALOG IS OPEN')).toBeLessThan(text.indexOf('[2]'));
    expect(text).toContain('It belongs to "TextEdit"');
    expect(text).toContain('[3] AXButton "Save"');
  });

  /*
   * THE RETRY THAT USED TO CLICK THROUGH THE PANEL.
   *
   * Indices are namespaced per APP, not per window, so once a sheet opens the
   * number the model is holding resolves to whatever the fresh walk assigned it
   * — quite possibly a control in the document behind the sheet. Retrying it
   * blind is the silent version of the user's complaint.
   */
  it('stops the blind retry when a dialog opened since, and hands the dialog over', async () => {
    let sheetUp = false;
    const bridge = new FakeBridge()
      .on('snapshot', () =>
        sheetUp ? SHEET_SNAP() : SNAP([{ index: 5, role: 'AXMenuItem', name: 'Save…' }], 4242),
      )
      .on('click', () => {
        if (!sheetUp) {
          sheetUp = true; // the click landed, the sheet came up, the index is gone
          return { found: false };
        }
        return { found: true, mode: 'AXPress', background: true };
      });
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { app: 'TextEdit' }); // indices read with no sheet up
    const r = await run(tools, 'mac_click', { index: 5 });

    expect(bridge.countOf('click')).toBe(1); // NOT retried behind the sheet
    expect(details(r).ok).toBe(false);
    expect(details(r).dialog).toBe('Save');
    const text = String(r.content[0]?.type === 'text' ? r.content[0].text : '');
    expect(text).toContain('BEHIND');
    expect(text).toContain('A DIALOG IS OPEN');
    expect(text).toContain('[3] AXButton "Save"'); // the dialog, ready to act on
  });

  it('mac_type stops the same way rather than typing behind the dialog', async () => {
    let sheetUp = false;
    const bridge = new FakeBridge()
      .on('snapshot', () =>
        sheetUp ? SHEET_SNAP() : SNAP([{ index: 5, role: 'AXTextField', name: 'Title' }], 4242),
      )
      .on('type', () => {
        if (!sheetUp) {
          sheetUp = true;
          return { found: false };
        }
        return { found: true, background: true };
      });
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { app: 'TextEdit' });
    const r = await run(tools, 'mac_type', { index: 5, text: 'report' });
    expect(bridge.countOf('type')).toBe(1);
    expect(details(r).ok).toBe(false);
    expect(details(r).dialog).toBe('Save');
  });

  /*
   * The OTHER way an act lands on the wrong surface, and the quieter one: the
   * index is not stale at all, it just belongs to the window the sheet is
   * blocking. macOS drops that input, so "Clicked element [1]" reads exactly
   * like success and the model believes it.
   */
  it('refuses an index in the window the dialog is blocking, instead of no-opping', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SHEET_SNAP())
      .on('click', () => ({ found: true, mode: 'AXPress', background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {});
    const r = await run(tools, 'mac_click', { index: 1 }); // the text area, behind the sheet
    expect(details(r).ok).toBe(false);
    expect(details(r).dialog).toBe('Save');
    expect(bridge.countOf('click')).toBe(0); // never reached the app
    const text = String(r.content[0]?.type === 'text' ? r.content[0].text : '');
    expect(text).toContain('BEHIND');
    expect(text).toContain('escape');
    // ...and the dialog's own controls still act normally.
    const ok = await run(tools, 'mac_click', { index: 4 });
    expect(details(ok).ok).toBe(true);
  });

  it('does not refuse once the dialog is gone — it looks again first', async () => {
    let sheetUp = true;
    const bridge = new FakeBridge()
      .on('snapshot', () =>
        sheetUp
          ? SHEET_SNAP()
          : SNAP([{ index: 1, role: 'AXTextArea', name: 'text entry area', win: 3 }], 4242),
      )
      .on('click', () => ({ found: true, mode: 'AXPress', background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {}); // [1] recorded as blocked
    sheetUp = false; // the user (or a key) dismissed it
    const r = await run(tools, 'mac_click', { index: 1 });
    expect(details(r).ok).toBe(true);
    expect(bridge.countOf('click')).toBe(1);
  });

  it('mac_type refuses a field behind the dialog too', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SHEET_SNAP())
      .on('type', () => ({ found: true, background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {});
    const r = await run(tools, 'mac_type', { index: 1, text: 'x' });
    expect(details(r).ok).toBe(false);
    expect(bridge.countOf('type')).toBe(0);
    // The sheet's own filename field types normally.
    const ok = await run(tools, 'mac_type', { index: 2, text: 'report.txt', submit: true });
    expect(details(ok).ok).toBe(true);
  });

  it('still retries normally when the SAME dialog was already up', async () => {
    // The dialog is not a reason to stop retrying — a dialog that APPEARED is.
    let clicks = 0;
    const bridge = new FakeBridge()
      .on('snapshot', () => SHEET_SNAP())
      .on('click', () => ({ found: ++clicks > 1 }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {}); // the sheet is already up and recorded
    const r = await run(tools, 'mac_click', { index: 3 });
    expect(details(r).ok).toBe(true);
    expect(bridge.countOf('click')).toBe(2);
  });

  it('aims a coordinate at the dialog UNTOUCHED — no correction toward the window', async () => {
    /* A sheet can extend past its parent window, and a panel can be a window of
     * its own somewhere else entirely. Any clamping toward the controlled
     * window's frame would send every click at a dialog into the document
     * behind it, so the point must reach the helper exactly as given (the pid
     * stamp is the aiming: the app hit-tests it against its OWN windows). */
    const bridge = new FakeBridge()
      .on('snapshot', () => SHEET_SNAP())
      .on('click', () => ({ found: true, mode: 'coordToPid', background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {});

    const inSheet = { x: SHEET_RECT.x + 20, y: SHEET_RECT.y + 20 };
    await run(tools, 'mac_click', inSheet);
    expect(bridge.lastParams('click')).toMatchObject({ ...inSheet, pid: 4242 });

    // ...and a point OUTSIDE the parent window is not pulled back into it.
    const faraway = { x: DOC_RECT.x + DOC_RECT.w + 500, y: DOC_RECT.y + DOC_RECT.h + 400 };
    await run(tools, 'mac_click', faraway);
    expect(bridge.lastParams('click')).toMatchObject({ ...faraway, pid: 4242 });
  });

  it('degrades silently for a helper that reports no windows/dialog at all', async () => {
    // The app ships a PREBUILT pi-mac: an older one sends none of these fields,
    // and the retry must behave exactly as it always did.
    let clicks = 0;
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([], 4242))
      .on('click', () => ({ found: ++clicks > 1 }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_click', { index: 3 });
    expect(details(r).ok).toBe(true);
    expect(bridge.countOf('click')).toBe(2);
  });

  // --- an app that exposes NOTHING never dead-ends ---------------------------

  it('steers a visual-only app to coordinates instead of asking for an index', async () => {
    const bridge = new FakeBridge().on('snapshot', () => SNAP([], 555));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { app: 'Preview' });
    const r = await run(tools, 'mac_click', {});
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('no indexes');
    expect(details(r).error).toContain('pass x');
  });

  it('does not send a visual-only app back for indices that cannot exist', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([], 555))
      .on('click', () => ({ found: false }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { app: 'Preview' });
    const r = await run(tools, 'mac_click', { index: 2 });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('click by x,y');
    expect(details(r).error).not.toContain('current indices');
  });

  /*
   * `visualOnly` is recorded by a LOOK, and mac_launch takes control without
   * one — so the flag can be genuinely UNDEFINED, which is the state the old
   * `visualOnly !== true` test refused in. Refusing on an unknown is how a model
   * with no indices gets told to pass an index.
   */
  it('resolves an unknown app by looking, and only then refuses', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK) // its post-launch snapshot fails: kind unknown
      .on('type', () => ({ found: true, background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_launch', { app: 'TextEdit' });
    bridge.on('snapshot', () => SNAP([{ index: 1, role: 'AXTextField', name: 'f' }], 4242));

    const r = await run(tools, 'mac_type', { text: 'hello' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('index');
    expect(bridge.countOf('type')).toBe(0); // it looked before it refused
  });

  it('types rather than dead-ending when it cannot find out what kind of app it is', async () => {
    const bridge = new FakeBridge()
      .on('launch', () => LAUNCH_ACK)
      .on('type', () => ({ found: true, background: true, mode: 'keystrokesToPid' }));
    const tools = collectTools(bridge); // no snapshot handler: the look throws
    await run(tools, 'mac_launch', { app: 'TextEdit' });
    const r = await run(tools, 'mac_type', { text: 'hello' });
    expect(details(r).ok).toBe(true);
    expect(bridge.lastParams('type')).toMatchObject({ pid: 4242, text: 'hello' });
  });

  // --- `--help` is the ONLY documentation in bash-CLI mode -------------------

  /*
   * In CLI mode the model reads `mac click --help`, which tool-cli.ts generates
   * from the SAME schema the tool validates against — so the schema's
   * descriptions are the documentation, and a parameter with none is a
   * parameter the model cannot discover. This is the drift-proofing that
   * convention buys, made into an assertion rather than a habit.
   */
  it('documents every parameter of every verb', () => {
    const tools = collectTools(new FakeBridge());
    for (const [name, def] of tools) {
      const schema = def.parameters as { properties?: Record<string, { description?: string }> };
      const props = schema?.properties ?? {};
      expect(Object.keys(props).length, `${name} has no parameters`).toBeGreaterThan(0);
      for (const [key, spec] of Object.entries(props)) {
        expect(spec?.description ?? '', `${name} --${key} is undocumented`).not.toBe('');
      }
    }
  });

  it('documents the things this round added: coordinates, and dialogs', () => {
    const tools = collectTools(new FakeBridge());
    const help = (n: string) => {
      const def = tools.get(n);
      const props = (def?.parameters as { properties?: Record<string, { description?: string }> })
        ?.properties;
      return `${def?.description ?? ''} ${Object.values(props ?? {})
        .map((p) => p?.description ?? '')
        .join(' ')}`;
    };
    // Coordinates: both axes, and what to read them off.
    expect(help('mac_click')).toContain('x,y');
    expect(help('mac_click')).toContain('pass with y');
    expect(help('mac_click')).toContain('pass with x');
    // Dialogs: every verb the model would reach for while one is open.
    for (const verb of ['mac_snapshot', 'mac_click', 'mac_type', 'mac_key']) {
      expect(help(verb).toLowerCase(), `${verb} says nothing about dialogs`).toContain('dialog');
    }
    // A union of literals renders as anyOf, so its values live in the prose.
    for (const dir of ['up', 'down', 'left', 'right']) {
      expect(help('mac_scroll')).toContain(dir);
    }
  });

  it('a failed launch surfaces the bridge error as a structured refusal', async () => {
    const bridge = new FakeBridge().on('launch', () => ({
      ok: false,
      app: 'NopeApp',
      error: 'no window appeared for "NopeApp"',
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_launch', { app: 'NopeApp' });
    expect(details(r).ok).toBe(false);
    expect(details(r).error).toContain('no window appeared');
    expect(bridge.countOf('snapshot')).toBe(0); // no phantom snapshot attempt
  });
});

/*
 * W3, at the tool layer. The truncation line now promises `find` and `from`;
 * those have to actually reach the helper, and a filtered look that matches
 * nothing must not be mistaken for an app with no Accessibility tree.
 */
describe('paging a big app', () => {
  it('sends find and from on the wire', async () => {
    const bridge = new FakeBridge().on('snapshot', () => SNAP([]));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { find: 'save', from: 60 });
    expect(bridge.lastParams('snapshot')).toMatchObject({ find: 'save', from: 60 });
  });

  it('leaves them off entirely when they were not asked for', async () => {
    const bridge = new FakeBridge().on('snapshot', () =>
      SNAP([{ index: 1, role: 'AXButton', name: 'Save' }]),
    );
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {});
    const p = bridge.lastParams('snapshot') ?? {};
    expect('find' in p).toBe(false);
    expect('from' in p).toBe(false);
  });

  it('does not forget page one when page two arrives', async () => {
    // The helper merges its own index->element map for a continuation, so the
    // tool layer has to as well: a click on something the model can still see in
    // its own transcript must not come back nameless.
    const pages: Record<string, unknown[]> = {
      first: [{ index: 7, role: 'AXButton', name: 'Save' }],
      second: [{ index: 61, role: 'AXButton', name: 'Bold' }],
    };
    const bridge = new FakeBridge()
      .on('snapshot', (p) => ({
        ...SNAP((p?.from === 60 ? pages.second : pages.first) as unknown[]),
        summary: {
          app: 'TextEdit',
          window: 'Untitled',
          elementCount: 812,
          truncated: true,
          ...(p?.from === 60 ? { offset: 60 } : {}),
        },
      }))
      .on('click', () => ({ found: true, background: true, mode: 'AXPress' }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {});
    await run(tools, 'mac_snapshot', { from: 60 });
    await run(tools, 'mac_click', { index: 7 });
    const r = await run(tools, 'mac_snapshot', {});
    expect(r.content[0]).toMatchObject({
      text: expect.stringContaining('your last act: clicked [7] "Save"'),
    });
  });

  it('does not re-take a filtered-to-nothing look as a screenshot', async () => {
    // An empty PAGE is not an empty app. The old isAxOpaque test (elements
    // empty) would have fired the screenshot retake and recorded the app as
    // visual-only for the rest of the session, because a search missed.
    const bridge = new FakeBridge().on('snapshot', () => ({
      ...SNAP([]),
      summary: {
        app: 'TextEdit',
        window: 'Untitled',
        elementCount: 812,
        truncated: false,
        find: 'zzz',
        matched: 0,
      },
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', { find: 'zzz' });
    expect(bridge.countOf('snapshot')).toBe(1);
    expect(details(r).visualOnly).toBe(false);
  });
});

/*
 * S3. The Apple menu's items — Shut Down…, Restart…, Log Out… — resolved like
 * any other path, guarded by nothing but a session consent the user gave to
 * "control your Mac". The helper refuses them outright; this is the only door
 * through, and it opens on the user's word, not the model's.
 */
describe('menu items that end the session', () => {
  const refusing = () =>
    new FakeBridge().on('menuClick', (p) =>
      p?.confirmDestructive === true
        ? { ok: true, path: 'Apple > Shut Down…' }
        : {
            ok: false,
            destructive: true,
            item: 'Apple > Shut Down…',
            error: 'ends the session',
          },
    );

  it('asks the user in their own UI, and presses only after a yes', async () => {
    const bridge = refusing();
    const ctx = ctxStub(true, true);
    const r = await run(tools2(bridge), 'mac_click', { menu: 'Apple > Shut Down…' }, ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      'Let Bobble use "Apple > Shut Down…"?',
      expect.stringContaining('cannot get back'),
    );
    expect(bridge.lastParams('menuClick')).toMatchObject({ confirmDestructive: true });
    expect(details(r).ok).toBe(true);
  });

  it('refuses on a no, and tells the model to hand it back to the user', async () => {
    const bridge = refusing();
    const r = await run(tools2(bridge), 'mac_click', { menu: 'Shut Down' }, ctxStub(true, false));
    expect(details(r).ok).toBe(false);
    expect(bridge.calls.filter((c) => c.params?.confirmDestructive === true)).toHaveLength(0);
    expect(details(r).error).toContain('have not asked for it');
  });

  it('has no door at all where there is no user to ask', async () => {
    // Print mode / a spawned subagent: fail safe, exactly like the consent gate.
    const bridge = refusing();
    const r = await run(tools2(bridge), 'mac_click', { menu: 'Shut Down' }, ctxStub(false));
    expect(details(r).ok).toBe(false);
    expect(bridge.calls.filter((c) => c.params?.confirmDestructive === true)).toHaveLength(0);
  });

  it('leaves an ordinary menu item alone', async () => {
    const bridge = new FakeBridge().on('menuClick', () => ({ ok: true, path: 'File > New' }));
    const ctx = ctxStub(true, true);
    const r = await run(tools2(bridge), 'mac_click', { menu: 'File > New' }, ctx);
    expect(details(r).ok).toBe(true);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
});

function tools2(bridge: MacBridge) {
  return collectTools(bridge);
}

/*
 * A7. The header reads the model its own last act back. It is written by the
 * tool that did the thing, so it has to survive a look and it has to name the
 * element rather than only its number.
 */
describe('what the snapshot header says the model just did', () => {
  it('names the element a click landed on, and survives the next look', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([{ index: 7, role: 'AXButton', name: 'Save' }]))
      .on('click', () => ({ found: true, background: true, mode: 'AXPress' }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {});
    await run(tools, 'mac_click', { index: 7 });
    const r = await run(tools, 'mac_snapshot', {});
    expect(r.content[0]).toMatchObject({
      text: expect.stringContaining('your last act: clicked [7] "Save"'),
    });
  });

  it('says nothing before the model has done anything', async () => {
    const bridge = new FakeBridge().on('snapshot', () =>
      SNAP([{ index: 1, role: 'AXButton', name: 'Save' }]),
    );
    const r = await run(collectTools(bridge), 'mac_snapshot', {});
    expect(r.content[0]).toMatchObject({ text: expect.not.stringContaining('your last act') });
  });

  it('records a key press and a menu press too', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => SNAP([{ index: 1, role: 'AXButton', name: 'Save' }]))
      .on('key', () => ({ ok: true, background: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', {});
    await run(tools, 'mac_key', { combo: 'cmd+s' });
    const r = await run(tools, 'mac_snapshot', {});
    expect(r.content[0]).toMatchObject({
      text: expect.stringContaining('your last act: pressed cmd+s'),
    });
  });
});

/*
 * W6 + S2 + H4. The tool descriptions are the only place a model reliably reads
 * before its first call, so the rules that cost turns belong in them — and the
 * one honest hazard (index-less typing with nothing under control) has to be
 * stated rather than described as safe.
 */
describe('what the tool descriptions promise', () => {
  const tools = collectTools(new FakeBridge());
  const desc = (n: string) => tools.get(n)?.description ?? '';

  it('puts the document-command rule in mac_click itself, not only in a parameter', () => {
    const head = desc('mac_click').split('\n').slice(0, 3).join('\n');
    expect(head).toContain('DOCUMENT COMMANDS');
    expect(head).toContain('activate:true');
  });

  it('tells mac_snapshot readers how to get past the cap', () => {
    expect(desc('mac_snapshot')).toContain('find:"save"');
    expect(desc('mac_snapshot')).toContain('from:60');
  });

  it('does not describe index-less typing as safe when nothing is controlled', () => {
    // With an app under control the keystrokes are pid-delivered and really are
    // background; with none there is nothing to aim at and they follow the
    // SYSTEM focus into whatever the user is doing. Both facts, plainly.
    const d = desc('mac_type');
    expect(d).toContain('SYSTEM focus');
    expect(d).toContain('snapshot or launch something first');
  });

  it('uses one kind of apostrophe', () => {
    for (const name of tools.keys()) {
      const t = tools.get(name);
      const blob = JSON.stringify([t?.description, t?.parameters, t?.promptSnippet]);
      expect(blob).not.toContain('’');
    }
  });
});

describe('browser tabs (the window around the page)', () => {
  it('lists tabs with the front one marked', async () => {
    const bridge = new FakeBridge().on('tabs', () => ({
      ok: true,
      app: 'Google Chrome',
      tabs: [
        { index: 1, title: 'Apple', active: false },
        { index: 2, title: 'Shop iPhone', active: true },
      ],
    }));
    const res = await run(collectTools(bridge), 'chrome_tabs', {});
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('2 tabs');
    expect(text).toContain('* [2] Shop iPhone');
    expect(text).toContain('  [1] Apple');
  });

  /* Switching is background; opening and closing are not, and the tool has to
     say which — the user losing their window is the cost of getting that
     wrong. */
  it('reports a tab switch as background', async () => {
    const bridge = new FakeBridge().on('tabSelect', () => ({
      ok: true,
      app: 'Google Chrome',
      selected: 'Apple',
      tabs: [{ index: 1, title: 'Apple', active: true }],
    }));
    const res = await run(collectTools(bridge), 'chrome_tab', { action: 'select', index: 1 });
    expect(details(res).background).toBe(true);
  });

  it('reports opening a tab as taking the screen, and passes on why', async () => {
    const bridge = new FakeBridge().on('tabNew', () => ({
      ok: true,
      app: 'Google Chrome',
      tookFocus: true,
      note: 'Google Chrome came to the front — a browser activates itself when it opens a tab.',
      tabs: [{ index: 1, title: 'New Tab', active: true }],
    }));
    const res = await run(collectTools(bridge), 'chrome_tab', { action: 'new' });
    expect(details(res).background).toBe(false);
    expect(res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')).toContain(
      'came to the front',
    );
  });
});

describe('chrome_* never launch Chrome by addressing it (the user: "chrome … steal focus upon computer use launch")', () => {
  it('launches a Chrome that is not running THROUGH THE BRIDGE, in the background, and says when it has no window yet', async () => {
    chromeUp = false;
    try {
      const bridge = new FakeBridge();
      bridge.handlers.set('policy', async () => ({ mode: 'always' }));
      // Chrome comes up showing its profile picker: a pid, no window bounds.
      bridge.handlers.set('launch', async () => ({ ok: true, app: 'Google Chrome', pid: 777 }));
      const tools = collectTools(bridge);
      const res = await run(tools, 'chrome_go', { url: 'https://www.geogebra.org/calculator' });
      const text = res.content.map((c) => ('text' in c ? c.text : '')).join('');
      expect(bridge.countOf('launch')).toBe(1);
      expect(bridge.lastParams('launch')).toMatchObject({ app: 'Google Chrome', background: true });
      expect(text).toContain('profile picker');
      expect(text).toContain('browser navigate');
    } finally {
      chromeUp = true;
    }
  });
});

describe('chrome snapshot --visual (the user 2026-09-23: "it just passes an image back")', () => {
  it('returns the window picture and no text, through Accessibility', async () => {
    const bridge = new FakeBridge().on('snapshot', () => ({
      ...SNAP([]),
      app: 'Google Chrome',
      screenshot: { path: '/tmp/c.png', base64: 'CCCC', mimeType: 'image/jpeg' },
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'chrome_snapshot', { visual: true });
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: 'image', data: 'CCCC' });
    expect(bridge.lastParams('snapshot')).toMatchObject({ app: 'Google Chrome', screenshot: true });
  });
});

/*
 * the user (2026-09-23): "the active application should be persisted better … the
 * model seems to at times randomly say 'the user is on activity monitor'."
 */
describe('the controlled app is remembered, and a fallback says what it is', () => {
  /** A pi stub that records `on` handlers so session_start can be fired. */
  function piWithEvents(tools: Map<string, ToolDefinition>) {
    const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
    const pi = {
      registerTool: (def: ToolDefinition) => tools.set(def.name, def),
      on: (name: string, fn: (e: unknown, ctx: unknown) => void) => handlers.set(name, fn),
      appendEntry: () => undefined,
    } as unknown as ExtensionAPI;
    const start = (entries: unknown[] = []) =>
      handlers.get('session_start')?.({}, { sessionManager: { getEntries: () => entries } });
    return { pi, start };
  }

  it('a look with no app named and nothing controlled is labelled as the USER’s front app', async () => {
    const bridge = new FakeBridge().on('snapshot', () => ({
      ...SNAP([{ index: 1, role: 'AXButton', name: 'CPU' }]),
      app: 'Activity Monitor',
    }));
    const tools = collectTools(bridge);
    const r = await run(tools, 'mac_snapshot', {});
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('the app the USER has in front');
    // Named, it is just a look at that app.
    const named = await run(tools, 'mac_snapshot', { app: 'TextEdit' });
    expect((named.content[0] as { text: string }).text).not.toContain('USER has in front');
  });

  it('a new chat picks up the app the last one controlled — and says it was carried over', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mac-last-')), 'last.json');
    const bridge = new FakeBridge().on('snapshot', () => SNAP([], process.pid));
    // Chat one controls "TextEdit" (this test process stands in for a live pid).
    const toolsA = new Map<string, ToolDefinition>();
    const a = piWithEvents(toolsA);
    registerMacComputerUseTools(a.pi, {
      bridge,
      consent: createMacConsentGate({ preConsented: true }),
      readChromeTabs: async () => null,
      lastControlFile: file,
    });
    a.start();
    await run(toolsA, 'mac_snapshot', { app: 'TextEdit' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      app: 'TextEdit',
      pid: process.pid,
    });
    // Chat two starts with no entries of its own.
    const toolsB = new Map<string, ToolDefinition>();
    const b = piWithEvents(toolsB);
    registerMacComputerUseTools(b.pi, {
      bridge,
      consent: createMacConsentGate({ preConsented: true }),
      readChromeTabs: async () => null,
      lastControlFile: file,
    });
    b.start();
    const r = await run(toolsB, 'mac_snapshot', {});
    expect(bridge.lastParams('snapshot')).toMatchObject({ pid: process.pid });
    expect((r.content[0] as { text: string }).text).toContain('Carried over from an earlier chat');
    // Said once.
    const again = await run(toolsB, 'mac_snapshot', {});
    expect((again.content[0] as { text: string }).text).not.toContain('Carried over');
  });

  it('Chrome’s own commands leave Chrome under control of the shared state', async () => {
    const session = createMacSessionState();
    const bridge = new FakeBridge().on('snapshot', () => ({
      ...SNAP([]),
      app: 'Google Chrome',
      screenshot: { path: '/tmp/c.png', base64: 'CCCC' },
    }));
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool: (def: ToolDefinition) => tools.set(def.name, def),
    } as unknown as ExtensionAPI;
    registerChromeTools(pi, bridge, {
      session,
      isChromeRunning: async () => true,
      chromePid: async () => 4321,
    });
    expect(session.controlled()).toBeNull();
    await run(tools, 'chrome_snapshot', { visual: true });
    expect(session.controlled()).toMatchObject({ app: 'Google Chrome', pid: 4321 });
  });
});

/*
 * THE REVIEW OF THE 2026-09-23 WAVE (deliverables/review/wave-0923-findings.md,
 * "computer-use"). Each case reproduces a finding against fakes — no real app,
 * no real Chrome, no real screen.
 */

const OK_BUTTON = { index: 1, role: 'AXButton', name: 'OK' };

describe('a --visual click maps the picture the helper actually sent', () => {
  it('uses the image’s own size when the helper sent no inline copy', async () => {
    const bridge = new FakeBridge()
      .on('snapshot', () => ({
        ...SNAP([OK_BUTTON]),
        // The composite at native pixels: the inline encoding failed, so the full-size
        // PNG went instead — 2000×1600 pixels of a 1000×800-point rect.
        screenshot: {
          path: '/tmp/x.png',
          base64: 'PPPP',
          mimeType: 'image/png',
          rect: { x: 100, y: 100, w: 1000, h: 800 },
          width: 2000,
          height: 1600,
        },
      }))
      .on('click', () => ({ found: true }));
    const tools = collectTools(bridge);
    await run(tools, 'mac_snapshot', { app: 'TextEdit', visual: true });
    await run(tools, 'mac_click', { x: 1000, y: 800 });
    // The middle of the picture is the middle of the rect.
    expect(bridge.lastParams('click')).toMatchObject({ x: 600, y: 500 });
  });
});
