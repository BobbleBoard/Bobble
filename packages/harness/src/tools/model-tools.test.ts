import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { ImageBridge } from './image-bridge-client.js';
import {
  BOBBLE_3D_READY_ENV,
  GENERATE_3D_TOOL,
  modelToolResult,
  REFINE_3D_TOOL,
  registerModelTools,
} from './model-tools.js';

function captureTools() {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  const get = (name: string): ToolDefinition => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return { pi, tools, get };
}

/** A bridge whose generic `call` answers with the given path and remembers what it was asked. */
function okBridge(path: string) {
  const call = vi.fn(async () => ({ ok: true as const, path }));
  const bridge = {
    generateImage: vi.fn(),
    editImage: vi.fn(),
    call,
  } as unknown as ImageBridge;
  return { bridge, call };
}

const ctx = { hasUI: true } as unknown as ExtensionContext;
const READY = { [BOBBLE_3D_READY_ENV]: '1', PI_DESKTOP_WORKSPACE_ROOT: '/w' };

async function run(tool: ToolDefinition, params: unknown) {
  return (await tool.execute('call-1', params as never, undefined, undefined, ctx)) as {
    content: { type: string; text?: string }[];
    details: { ok: boolean; path?: string; error?: string };
  };
}

describe('registerModelTools — only when the connector is on', () => {
  it('registers NOTHING without a bridge', () => {
    const { pi, tools } = captureTools();
    registerModelTools(pi, null, READY);
    expect(tools.size).toBe(0);
  });

  it('registers NOTHING when the app has said nothing about 3D', () => {
    const { pi, tools } = captureTools();
    registerModelTools(pi, okBridge('/m.glb').bridge, {});
    expect(tools.size).toBe(0);
  });

  it('with 3D in the app but off, generate_3d is there and says how to turn it on', async () => {
    /* MEASURED (4B): with no tool it denied 3D; with a prompt line it made a
       picture and called it a model. The command answers at the moment of asking. */
    const { pi, tools, get } = captureTools();
    const { bridge, call } = okBridge('/m.glb');
    registerModelTools(pi, bridge, { [BOBBLE_3D_READY_ENV]: '0' });
    expect([...tools.keys()]).toEqual([GENERATE_3D_TOOL]);
    const res = await run(get(GENERATE_3D_TOOL), { prompt: 'a low-poly treasure chest' });
    expect(res.details.ok).toBe(false);
    const text = res.content.map((c) => (c as { text?: string }).text ?? '').join('');
    expect(text).toContain('Connectors → Bobble 3D');
    expect(text).toContain('Do not hand over a picture as if it were a model');
    expect(call).not.toHaveBeenCalled();
  });

  it('registers both tools when the bridge exists and the connector is on', () => {
    const { pi, tools } = captureTools();
    registerModelTools(pi, okBridge('/m.glb').bridge, READY);
    expect([...tools.keys()].sort()).toEqual([GENERATE_3D_TOOL, REFINE_3D_TOOL]);
  });
});

describe('generate_3d', () => {
  it('needs a prompt or an image', async () => {
    const { pi, get } = captureTools();
    const { bridge, call } = okBridge('/m.glb');
    registerModelTools(pi, bridge, READY);
    const res = await run(get(GENERATE_3D_TOOL), {});
    expect(res.details.ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('sends the prompt and the default finish over the bridge as generate_3d', async () => {
    const { pi, get } = captureTools();
    const { bridge, call } = okBridge('/w/out/fox.glb');
    registerModelTools(pi, bridge, READY);
    const res = await run(get(GENERATE_3D_TOOL), { prompt: '  a low-poly fox  ' });
    expect(call).toHaveBeenCalledWith(
      'generate_3d',
      { prompt: 'a low-poly fox', finish: 'pbr', resolution: 'low' },
      undefined,
    );
    expect(res.details).toEqual({ ok: true, path: '/w/out/fox.glb' });
  });

  it('resolves a relative image against the working folder and passes the finish', async () => {
    const { pi, get } = captureTools();
    const { bridge, call } = okBridge('/w/out/fox.glb');
    registerModelTools(pi, bridge, READY);
    await run(get(GENERATE_3D_TOOL), {
      image_path: 'pics/fox.png',
      finish: 'grey',
      resolution: 'medium',
    });
    expect(call).toHaveBeenCalledWith(
      'generate_3d',
      { imagePath: '/w/pics/fox.png', finish: 'grey', resolution: 'medium' },
      undefined,
    );
  });

  it('relays the engine refusal as a readable failure', async () => {
    const { pi, get } = captureTools();
    const bridge = {
      call: vi.fn(async () => ({ ok: false as const, error: 'the engine is busy' })),
    } as unknown as ImageBridge;
    registerModelTools(pi, bridge, READY);
    const res = await run(get(GENERATE_3D_TOOL), { prompt: 'a cup' });
    expect(res.details.ok).toBe(false);
    expect(res.content[0]?.text).toContain('the engine is busy');
  });
});

describe('refine_3d', () => {
  it('sends op + absolute model path, with the prompt only when given', async () => {
    const { pi, get } = captureTools();
    const { bridge, call } = okBridge('/w/out/fox-rigged.glb');
    registerModelTools(pi, bridge, READY);
    await run(get(REFINE_3D_TOOL), { model_path: 'out/fox.glb', op: 'rig' });
    expect(call).toHaveBeenCalledWith(
      'refine_3d',
      { op: 'rig', modelPath: '/w/out/fox.glb' },
      undefined,
    );
    await run(get(REFINE_3D_TOOL), {
      model_path: '/abs/fox.glb',
      op: 'texture',
      prompt: 'weathered bronze',
    });
    expect(call).toHaveBeenLastCalledWith(
      'refine_3d',
      { op: 'texture', modelPath: '/abs/fox.glb', prompt: 'weathered bronze' },
      undefined,
    );
  });

  it('refuses an empty path', async () => {
    const { pi, get } = captureTools();
    const { bridge, call } = okBridge('/m.glb');
    registerModelTools(pi, bridge, READY);
    const res = await run(get(REFINE_3D_TOOL), { model_path: '  ', op: 'segment' });
    expect(res.details.ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('modelToolResult', () => {
  it('leads with the media URL, then the path, then how to say it', () => {
    const res = modelToolResult(
      GENERATE_3D_TOOL,
      'Generated 3D model saved at',
      { ok: true, path: '/w/out/fox.glb' },
      '/w',
    );
    const lines = res.content[0]?.type === 'text' ? res.content[0].text.split('\n') : [];
    expect(lines[0]).toBe('pd-file://f/w/out/fox.glb');
    expect(lines[1]).toBe('Generated 3D model saved at /w/out/fox.glb');
    expect(lines[2]).toContain('"out/fox.glb"');
  });

  it('says nothing about a relative name when there is no working folder', () => {
    const res = modelToolResult(
      GENERATE_3D_TOOL,
      'Generated 3D model saved at',
      { ok: true, path: '/w/out/fox.glb' },
      undefined,
    );
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).not.toContain('Refer to it as');
    expect(text).toContain('card the user can turn');
  });
});
