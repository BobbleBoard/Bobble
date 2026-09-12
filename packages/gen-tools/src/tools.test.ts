import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { defaultVideoModel, getModel } from '@pi-desktop/gen-service';
import { describe, expect, it } from 'vitest';
import type { GenBridge } from './gen-bridge-client.ts';
import type { GenBridgeMethod } from './gen-contract.ts';
import {
  GENERATE_IMAGE_TOOL,
  GENERATE_SVG_TOOL,
  GENERATE_VIDEO_TOOL,
  parseSize,
  registerGenTools,
  saveOutputs,
} from './tools.ts';

type Handler = (params: Record<string, unknown> | undefined) => unknown;

class FakeBridge implements GenBridge {
  readonly calls: Array<{ method: GenBridgeMethod; params?: Record<string, unknown> }> = [];
  readonly handlers = new Map<GenBridgeMethod, Handler>();
  on(method: GenBridgeMethod, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }
  async request<T>(method: GenBridgeMethod, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (handler === undefined) throw new Error(`no fake handler for ${method}`);
    return handler(params) as T;
  }
}

function collectTools(
  bridge: GenBridge | null,
  readImage?: (p: string) => Promise<Buffer>,
): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerGenTools(pi, { bridge, readImage });
  return tools;
}

async function run(tools: Map<string, ToolDefinition>, params: Record<string, unknown>) {
  const tool = tools.get(GENERATE_IMAGE_TOOL);
  if (tool === undefined) throw new Error('missing generate_image tool');
  // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for tests.
  return tool.execute('call-1', params as any, undefined, undefined, {} as any);
}

async function runVideo(tools: Map<string, ToolDefinition>, params: Record<string, unknown>) {
  const tool = tools.get(GENERATE_VIDEO_TOOL);
  if (tool === undefined) throw new Error('missing generate_video tool');
  // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for tests.
  return tool.execute('call-1', params as any, undefined, undefined, {} as any);
}

// biome-ignore lint/suspicious/noExplicitAny: reach into the untyped details bag.
const details = (r: { details: unknown }) => r.details as any;

describe('parseSize', () => {
  it('parses WxH and rounds to a multiple of 16', () => {
    expect(parseSize('512x512')).toEqual({ width: 512, height: 512 });
    expect(parseSize('257x257')).toEqual({ width: 256, height: 256 });
  });
  it('clamps to the supported range', () => {
    expect(parseSize('16x16')).toEqual({ width: 256, height: 256 });
    expect(parseSize('4000x4000')).toEqual({ width: 1536, height: 1536 });
  });
  it('defaults to 1024x1024 on garbage / missing', () => {
    expect(parseSize(undefined)).toEqual({ width: 1024, height: 1024 });
    expect(parseSize('big')).toEqual({ width: 1024, height: 1024 });
  });

  it("takes the caller's default, because a clip is not a still", () => {
    // 1024² is a good picture and a bad video: four times the pixels of a job
    // already measured at 521s on this machine.
    const video = { width: 640, height: 352 };
    expect(parseSize(undefined, video)).toEqual(video);
    expect(parseSize('nonsense', video)).toEqual(video);
    expect(parseSize('768x512', video)).toEqual({ width: 768, height: 512 });
  });
});

describe('generate_image tool', () => {
  it('registers the tool and advertises the catalog models it can actually run', () => {
    const tools = collectTools(new FakeBridge());
    const tool = tools.get(GENERATE_IMAGE_TOOL);
    expect(tool?.label).toBe('Generate: Image');
    expect(tool?.description).toContain('z-image-turbo');
    // A ComfyUI-backed image model is not one the mflux path can run — SEEN
    // offered and then refused in the same turn.
    expect(tool?.description).not.toContain('flux1-dev-gguf');
  });

  it('reports unavailable when no bridge (loaded outside Pi Desktop)', async () => {
    const tools = collectTools(null);
    const res = await run(tools, { prompt: 'a cat' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('bridge unavailable');
  });

  it('rejects an unknown model against the catalog', async () => {
    const tools = collectTools(new FakeBridge());
    const res = await run(tools, { prompt: 'a cat', model: 'stable-diffusion-xl' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('unknown image model');
  });

  it('enqueues via the bridge and returns paths + the model footnote + image blocks', async () => {
    const bridge = new FakeBridge().on('generate', (params) => ({
      jobId: 'job-9',
      outputs: [
        {
          outputPath: '/out/a.png',
          modality: 'image',
          model: params?.model,
          seed: 1,
          width: 512,
          height: 512,
        },
        {
          outputPath: '/out/b.png',
          modality: 'image',
          model: params?.model,
          seed: 2,
          width: 512,
          height: 512,
        },
      ],
    }));
    const reads: string[] = [];
    const readImage = async (p: string): Promise<Buffer> => {
      reads.push(p);
      return Buffer.from(`png:${p}`);
    };
    const tools = collectTools(bridge, readImage);

    const res = await run(tools, {
      prompt: 'a fox',
      model: 'z-image-turbo',
      size: '512x512',
      n: 2,
    });

    // The generate RPC carried the normalised params.
    expect(bridge.calls[0]?.method).toBe('generate');
    expect(bridge.calls[0]?.params).toMatchObject({
      prompt: 'a fox',
      model: 'z-image-turbo',
      n: 2,
    });

    expect(details(res).ok).toBe(true);
    expect(details(res).jobId).toBe('job-9');
    // Text lists both paths + the FOOTNOTE with the model + license.
    const text = (res.content.find((c) => c.type === 'text') as { text: string }).text;
    expect(text).toContain('/out/a.png');
    expect(text).toContain('/out/b.png');
    expect(text).toContain('Model: Z-Image Turbo (z-image-turbo, apache-2.0)');
    // Both images attached as image blocks.
    const images = res.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    expect(reads).toEqual(['/out/a.png', '/out/b.png']);
  });

  it('saves the picture where the user said (save_to), and says so', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gen-tools-save-'));
    const src = path.join(dir, 'cand0.png');
    writeFileSync(src, 'png-bytes');
    const bridge = new FakeBridge().on('generate', (params) => ({
      jobId: 'job-2',
      outputs: [{ outputPath: src, modality: 'image', model: params?.model, seed: 1 }],
    }));
    const tools = collectTools(bridge, async () => Buffer.from('x'));
    const folder = path.join(dir, 'book', 'pages');
    // A trailing slash says "folder" — a bare name with one picture is the file.
    const res = await run(tools, {
      prompt: 'Title slide: a tree with a hidden forest',
      save_to: `${folder}/`,
    });
    const text = (res.content.find((c) => c.type === 'text') as { text: string }).text;
    const saved = path.join(folder, 'title-slide-a-tree-with-a-hidden-forest.png');
    expect(text).toContain(`Saved to:\n  1. ${saved}`);
    expect(readFileSync(saved, 'utf8')).toBe('png-bytes');
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to the catalog default model when none is given', async () => {
    const bridge = new FakeBridge().on('generate', (params) => ({
      jobId: 'job-1',
      outputs: [{ outputPath: '/out/x.png', modality: 'image', model: params?.model, seed: 1 }],
    }));
    const tools = collectTools(bridge, async () => Buffer.from('x'));
    await run(tools, { prompt: 'a tree' });
    expect(bridge.calls[0]?.params?.model).toBe('flux2-klein-4b');
  });

  it('surfaces a generator error as a structured (never-thrown) result', async () => {
    const bridge = new FakeBridge().on('generate', () => {
      throw new Error('metal out of memory');
    });
    const tools = collectTools(bridge, async () => Buffer.from('x'));
    const res = await run(tools, { prompt: 'a cat', model: 'z-image-turbo' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('metal out of memory');
  });
});

describe('generate_video tool', () => {
  const okVideo = (params?: Record<string, unknown>) => ({
    jobId: 'vid-7',
    outputs: [{ outputPath: '/out/clip.mp4', modality: 'video', model: params?.model, seed: 3 }],
    posterFramePath: '/out/poster.png',
  });

  it('registers the tool and advertises the catalog video models', () => {
    const tools = collectTools(new FakeBridge());
    const tool = tools.get(GENERATE_VIDEO_TOOL);
    expect(tool?.label).toBe('Generate: Video');
    expect(tool?.description).toContain('hyperframes');
    expect(tool?.description).toContain('wan2.1-t2v-1.3b');
  });

  it('reports unavailable when no bridge (loaded outside Pi Desktop)', async () => {
    const tools = collectTools(null);
    const res = await runVideo(tools, { prompt: 'a wave' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('bridge unavailable');
  });

  it('rejects an unknown model against the catalog', async () => {
    const tools = collectTools(new FakeBridge());
    const res = await runVideo(tools, { prompt: 'a wave', model: 'sora' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('unknown video model');
  });

  it('routes a motion-graphics prompt to hyperframes by default', async () => {
    const bridge = new FakeBridge().on('generateVideo', okVideo);
    const tools = collectTools(bridge, async () => Buffer.from('x'));
    await runVideo(tools, { prompt: 'animated title card with kinetic typography' });
    expect(bridge.calls[0]?.method).toBe('generateVideo');
    expect(bridge.calls[0]?.params?.model).toBe('hyperframes');
  });

  /*
   * This pinned `wan2.1-t2v-1.3b`, which is `reserved: true` — a backend that is
   * not installed and cannot execute. So any prompt missing the motion-graphics
   * regex was routed to a dead model and failed. The assertion is now the
   * INTENT: a non-motion prompt goes to whatever the catalog's default is, and
   * that default must be something that can actually run.
   */
  it('routes a photoreal prompt to the default video model, which must be runnable', async () => {
    const bridge = new FakeBridge().on('generateVideo', okVideo);
    const tools = collectTools(bridge, async () => Buffer.from('x'));
    await runVideo(tools, { prompt: 'a photoreal drone shot over a canyon at sunset' });
    const chosen = bridge.calls[0]?.params?.model;
    expect(chosen).toBe(defaultVideoModel().id);
    expect(getModel(chosen as string)?.reserved).not.toBe(true);
  });

  it('enqueues via the bridge and returns the path + footnote + the poster-frame image', async () => {
    const bridge = new FakeBridge().on('generateVideo', okVideo);
    const reads: string[] = [];
    const readImage = async (p: string): Promise<Buffer> => {
      reads.push(p);
      return Buffer.from(`png:${p}`);
    };
    const tools = collectTools(bridge, readImage);

    const res = await runVideo(tools, {
      prompt: 'a fox running',
      model: 'wan2.1-t2v-1.3b',
      size: '768x512',
      seconds: 4,
    });

    expect(bridge.calls[0]?.method).toBe('generateVideo');
    expect(bridge.calls[0]?.params).toMatchObject({
      prompt: 'a fox running',
      model: 'wan2.1-t2v-1.3b',
      seconds: 4,
    });

    expect(details(res).ok).toBe(true);
    expect(details(res).jobId).toBe('vid-7');
    const text = (res.content.find((c) => c.type === 'text') as { text: string }).text;
    expect(text).toContain('/out/clip.mp4');
    expect(text).toContain('Model: Wan2.1 T2V (1.3B) (wan2.1-t2v-1.3b, apache-2.0)');
    // The extracted poster frame is attached for self-critique.
    const images = res.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(1);
    expect(reads).toEqual(['/out/poster.png']);
  });

  it('omits the self-critique image when no poster frame was extracted', async () => {
    const bridge = new FakeBridge().on('generateVideo', () => ({
      jobId: 'vid-8',
      outputs: [{ outputPath: '/out/c.mp4', modality: 'video', model: 'hyperframes' }],
      // posterFramePath absent (extraction failed)
    }));
    const reads: string[] = [];
    const tools = collectTools(bridge, async (p) => {
      reads.push(p);
      return Buffer.from('x');
    });
    const res = await runVideo(tools, { prompt: 'a spinning logo', model: 'hyperframes' });
    expect(details(res).ok).toBe(true);
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(reads).toEqual([]);
  });

  it('surfaces a generator error as a structured (never-thrown) result', async () => {
    const bridge = new FakeBridge().on('generateVideo', () => {
      throw new Error('comfyui not configured');
    });
    const tools = collectTools(bridge, async () => Buffer.from('x'));
    const res = await runVideo(tools, { prompt: 'a wave', model: 'wan2.1-t2v-1.3b' });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('comfyui not configured');
  });
});

function collectSvgTools(bridge: GenBridge | null): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerGenTools(pi, { bridge, svg: true });
  return tools;
}

async function runSvg(tools: Map<string, ToolDefinition>, params: Record<string, unknown>) {
  const tool = tools.get(GENERATE_SVG_TOOL);
  if (tool === undefined) throw new Error('missing generate_svg tool');
  // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for tests.
  return tool.execute('call-1', params as any, undefined, undefined, {} as any);
}

describe('generate_svg tool', () => {
  const okSvg = (params: Record<string, unknown> | undefined) => ({
    outputs: [
      {
        outputPath: `${(params?.outPath as string) ?? '/Generated/heart'}/01.svg`,
        paths: 1,
        source: 'prompt',
        stop: 'eos',
        tokPerSec: 60,
        tokens: 40,
      },
    ],
  });

  it("names the cases where nobody says 'SVG': a site's graphics, a simple illustration", () => {
    const tool = collectSvgTools(new FakeBridge()).get(GENERATE_SVG_TOOL);
    expect(tool?.description).toMatch(/website|logo|illustration/i);
    expect(tool?.description).toContain('Never write SVG markup by hand');
  });

  it('passes a fenced out path through to the bridge', async () => {
    const bridge = new FakeBridge().on('generateSvg', okSvg);
    const root = process.cwd();
    const tools = collectSvgTools(bridge);
    const res = await runSvg(tools, { prompt: 'a gear', out: 'assets/gear.svg' });
    expect(details(res).ok).toBe(true);
    expect(bridge.calls[0]?.params?.outPath).toBe(`${root}/assets/gear.svg`);
    // the reply tells the model HOW to use it — an <img>, not the markup.
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');
    expect(text).toContain('assets/gear.svg');
    expect(text).toContain('<img');
  });

  it('refuses an out path that climbs out of the working folder', async () => {
    const bridge = new FakeBridge().on('generateSvg', okSvg);
    const res = await runSvg(collectSvgTools(bridge), {
      prompt: 'a gear',
      out: '../../etc/evil.svg',
    });
    expect(details(res).ok).toBe(false);
    expect(details(res).error).toContain('inside the working folder');
    expect(bridge.calls.length).toBe(0);
  });

  it('needs a prompt or an image', async () => {
    const res = await runSvg(collectSvgTools(new FakeBridge()), {});
    expect(details(res).ok).toBe(false);
  });
});

describe('saveOutputs', () => {
  const fake = () => {
    const copies: Array<[string, string]> = [];
    const dirs: string[] = [];
    return {
      copies,
      dirs,
      deps: {
        copy: async (from: string, to: string) => void copies.push([from, to]),
        ensureDir: async (d: string) => void dirs.push(d),
        isDir: async () => false,
      },
    };
  };

  it('does nothing without a destination', async () => {
    const f = fake();
    expect(await saveOutputs(['/g/a.png'], undefined, 'x', f.deps)).toEqual({ paths: [] });
    expect(f.copies).toEqual([]);
  });

  it('treats a .png path as the file, numbering further candidates beside it', async () => {
    const f = fake();
    const r = await saveOutputs(['/g/a.png', '/g/b.png'], '/pics/fox.png', 'a fox', f.deps);
    expect(r.paths).toEqual(['/pics/fox.png', '/pics/fox-2.png']);
    expect(f.dirs).toEqual(['/pics']);
    expect(f.copies).toEqual([
      ['/g/a.png', '/pics/fox.png'],
      ['/g/b.png', '/pics/fox-2.png'],
    ]);
  });

  it('treats anything else as a folder and names the pictures from the prompt', async () => {
    const f = fake();
    const r = await saveOutputs(
      ['/g/a.png', '/g/b.png'],
      '/pics/book/',
      "Bramble's discovery — a fox looking up",
      f.deps,
    );
    expect(r.paths).toEqual([
      '/pics/book/bramble-s-discovery-a-fox-looking-up-1.png',
      '/pics/book/bramble-s-discovery-a-fox-looking-up-2.png',
    ]);
    expect(f.dirs).toEqual(['/pics/book']);
  });

  it('reads a bare name (no extension, one picture) as the file, and a trailing slash as a folder', async () => {
    const f = fake();
    const one = await saveOutputs(['/g/a.png'], '/pics/book/title-slide', 'title', f.deps);
    expect(one.paths).toEqual(['/pics/book/title-slide.png']);
    const many = await saveOutputs(
      ['/g/a.png', '/g/b.png'],
      '/pics/book/title-slide',
      'title',
      f.deps,
    );
    expect(many.paths).toEqual([
      '/pics/book/title-slide/title-1.png',
      '/pics/book/title-slide/title-2.png',
    ]);
    const slash = await saveOutputs(['/g/a.png'], '/pics/book/', 'title', f.deps);
    expect(slash.paths).toEqual(['/pics/book/title.png']);
    const existing = await saveOutputs(['/g/a.png'], '/pics/book', 'title', {
      ...f.deps,
      isDir: async () => true,
    });
    expect(existing.paths).toEqual(['/pics/book/title.png']);
  });

  it('keeps the name but not a wrong extension: the bytes are PNG', async () => {
    const f = fake();
    const r = await saveOutputs(['/g/cand0.png'], '/pics/fox-storybook.jpg', 'fox', f.deps);
    expect(r.paths).toEqual(['/pics/fox-storybook.png']);
  });

  it('expands ~ and reports a destination it could not write instead of throwing', async () => {
    const f = fake();
    const r = await saveOutputs(['/g/a.png'], '~/Pictures/x', 'p', {
      ...f.deps,
      copy: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(f.dirs[0]?.startsWith('/')).toBe(true);
    // One picture, a bare name: the file is x.png and its folder is made.
    expect(f.dirs[0]?.endsWith('/Pictures')).toBe(true);
    expect(r.error).toContain('EACCES');
    expect(r.paths).toEqual([]);
  });
});
