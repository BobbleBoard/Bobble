/**
 * THE SUPERVISOR'S VISION DECISIONS, DRIVEN THROUGH ITS OWN PORT.
 *
 * supervisor-entry.ts is the inference utilityProcess: every decision it makes
 * arrives as a message on `process.parentPort`, and every launch goes through
 * a LlamaServerSupervisor. So that is where this stands — a fake port that asks,
 * and a fake supervisor that records each launch and spawns nothing. Weights
 * and engines are empty files in the scratch library and cache the test setup
 * pins (vitest.library-guard), HOME is a folder of its own, and fetch is
 * answered here: nothing starts a model, touches the network, or reads the
 * user's files.
 */
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardwareKey, modelDir, PINNED_LLAMACPP } from '@pi-desktop/inference';
import { entryDir, slugFor, writeManifest } from '@pi-desktop/model-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmCompanion, LlmStatus } from '../ipc-contract';
import {
  calibrationDir,
  engineCommand,
  rapidVisionCommand,
  rapidVisionMarker,
} from './engine-paths';
import type { LlmRequestBody } from './protocol';

/** What each server the supervisor built was told to run. */
interface Launch {
  readonly serverPath: string;
  readonly mmprojPath?: string;
  readonly launchMode?: string;
  readonly args: string[];
  readonly port: number;
}

const h = vi.hoisted(() => ({
  launches: [] as Launch[],
  port: 41_000,
  /** Held open while set: a model that is still loading. */
  hold: null as Promise<void> | null,
}));

vi.mock('@pi-desktop/inference', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pi-desktop/inference')>();
  class FakeServer {
    running = false;
    parked = false;
    #port = 0;
    #args: string[] = [];
    constructor(
      readonly opts: {
        serverPath: string;
        mmprojPath?: string;
        launchMode?: string;
        buildArgsFn?: (port: number) => string[];
      },
    ) {}
    get baseUrl(): string {
      return `http://127.0.0.1:${this.#port}/v1`;
    }
    on(): void {}
    async start() {
      this.#port = h.port++;
      this.#args = this.opts.buildArgsFn?.(this.#port) ?? [];
      h.launches.push({
        serverPath: this.opts.serverPath,
        ...(this.opts.mmprojPath !== undefined ? { mmprojPath: this.opts.mmprojPath } : {}),
        ...(this.opts.launchMode !== undefined ? { launchMode: this.opts.launchMode } : {}),
        args: this.#args,
        port: this.#port,
      });
      if (h.hold !== null) await h.hold;
      this.running = true;
      return { baseUrl: this.baseUrl, port: this.#port, pid: 1 };
    }
    argv(): string[] {
      return this.#args;
    }
    async dispose(): Promise<void> {
      this.running = false;
    }
    killImmediately(): void {}
    recordTimings(): void {}
  }
  return {
    ...real,
    LlamaServerSupervisor: FakeServer,
    ensureEngineFor: async () => ({ serverPath: '/fake/llama-server' }),
    probeServerFeatures: async () => ({ specTypes: [], mtp: true, eagle3: false }),
    detectHardware: async () => ({
      chip: 'Apple M5',
      totalRamGB: 64,
      isAppleSilicon: true,
      cpuCount: 10,
    }),
    detectAccelerators: async () => ({
      platform: 'darwin',
      arch: 'arm64',
      appleSilicon: true,
      totalRamGB: 64,
      gpus: [{ vendor: 'apple', name: 'Apple M5' }],
      unifiedMemory: true,
      npu: true,
      cpuCount: 10,
    }),
    createPowerManager: () => ({
      start() {},
      current: () => ({
        level: 'full',
        reason: 'test',
        memoryFraction: 0.75,
        quantizeKv: false,
        backgroundPriority: false,
      }),
      setMode: async () => {},
      setReserveGB: async () => {},
    }),
    writeModelsJson: async () => {},
    downloadModel: async () => {
      throw new Error('no downloads in a unit test');
    },
    ensureChatTemplate: async () => {
      throw new Error('offline');
    },
    ensureGgufChatTemplate: async () => undefined,
    patchModelDirTemplate: async () => false,
  };
});

/* A calibration benchmark's answer: llama.cpp-style timings, faster on the
   DFlash engine so it can win; rapid-mlx names the lane it serves. */
vi.stubGlobal('fetch', async (url: string) => {
  const port = Number(new URL(url).port);
  const launch = h.launches.find((l) => l.port === port);
  if (url.endsWith('/v1/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'm', serving_lane: 'vision' }] }));
  }
  const fast = launch?.serverPath.endsWith('/dflash') === true;
  const timings = {
    prompt_n: 100,
    prompt_ms: 100,
    predicted_n: 96,
    predicted_ms: fast ? 300 : 2000,
  };
  const body = [{ choices: [{ delta: { content: 'hi' } }] }, { choices: [{ delta: {} }], timings }]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join('');
  return new Response(`${body}data: [DONE]\n\n`);
});

type Reply = { id?: number; kind: string; result?: unknown; error?: string };
const waiting = new Map<number, (reply: Reply) => void>();
let deliver: (event: { data: unknown }) => void = () => {};
(process as unknown as { parentPort: unknown }).parentPort = {
  on: (_event: string, listener: (event: { data: unknown }) => void) => {
    deliver = listener;
  },
  postMessage: (message: Reply) => {
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  },
};
let nextId = 1;
function ask<T>(req: LlmRequestBody): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, (reply) => {
      waiting.delete(id);
      if (reply.kind === 'reply') resolve(reply.result as T);
      else reject(new Error(reply.error));
    });
    deliver({ data: { ...req, id } });
  });
}

process.env.HOME = mkdtempSync(join(tmpdir(), 'pd-supervisor-home-'));
await import('./supervisor-entry');

const status = () => ask<LlmStatus>({ type: 'get-status' });
const vision = (on: boolean) =>
  ask({ type: 'set-engine-launch', engineLaunch: {}, modelSpec: {}, loadVision: on });
const lastLaunch = (): Launch | undefined => h.launches[h.launches.length - 1];

function file(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}
/** A catalogued GGUF (and its projector) on disk. */
function gguf(modelId: string, name: string, projector = false): void {
  file(join(modelDir(modelId), name));
  if (projector) file(join(modelDir(modelId), 'mmproj-F16.gguf'));
}
/** A finished download of a repo in the model store; returns its directory. */
async function stored(repo: string): Promise<string> {
  const dir = entryDir('text', repo);
  await writeManifest({
    id: slugFor(repo),
    repo,
    name: repo,
    org: repo.split('/')[0] ?? repo,
    kind: 'text',
    dir,
    files: [],
    bytes: 0,
    installedAt: new Date(0).toISOString(),
    source: 'llm',
  });
  return dir;
}
/** An MLX twin whose weights carry a vision tower, as ONE model.safetensors of `bytes`. */
async function visionTwin(repo: string, bytes: number): Promise<string> {
  const dir = await stored(repo);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ vision_config: {} }));
  const header = Buffer.from(
    JSON.stringify({
      __metadata__: { format: 'mlx' },
      'vision_tower.blocks.0.attn.qkv.weight': { dtype: 'F16', shape: [1], data_offsets: [0, 2] },
      'language_model.layers.0.mlp.weight': { dtype: 'F16', shape: [1], data_offsets: [2, 4] },
    }),
  );
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(header.length));
  const fd = openSync(join(dir, 'model.safetensors'), 'w');
  writeSync(fd, Buffer.concat([size, header]));
  // Sparse: the length is real, the disk is not spent.
  ftruncateSync(fd, Math.max(bytes, 8 + header.length + 4));
  closeSync(fd);
  return dir;
}
function engine(path: string): void {
  file(path, '#!/bin/sh\n');
}
/** A calibration verdict for this (fake) machine and the pinned llama.cpp build. */
function calibrated(
  modelId: string,
  quant: string,
  chosen: { engine: string; spec: string },
): void {
  const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, '_');
  file(
    join(calibrationDir(), `${safe(modelId)}--${safe(quant)}.json`),
    JSON.stringify({
      modelId,
      quant,
      hardwareKey: hardwareKey({
        platform: process.platform,
        arch: process.arch,
        chip: 'Apple M5',
        totalRamGB: 64,
      }),
      engineBuild: PINNED_LLAMACPP.tag,
      at: new Date(0).toISOString(),
      ranked: [],
      skips: [],
      chosen,
    }),
  );
}

beforeEach(async () => {
  await ask({ type: 'stop-server' });
  await vision(true);
  rmSync(calibrationDir(), { recursive: true, force: true });
  h.hold = null;
});

describe('the reuse gate (ALREADY RESIDENT)', () => {
  it('a text-only model with vision off is reused, not reloaded', async () => {
    gguf('nanbeige4.2-3b', 'Nanbeige_Nanbeige4.2-3B-Q8_0.gguf');
    await vision(false);
    expect(
      (await ask<{ success: boolean }>({ type: 'start-server', modelId: 'nanbeige4.2-3b' }))
        .success,
    ).toBe(true);
    const launched = h.launches.length;
    // Models → Use on the loaded model; or a second start racing the first.
    expect(
      (await ask<{ success: boolean }>({ type: 'start-server', modelId: 'nanbeige4.2-3b' }))
        .success,
    ).toBe(true);
    expect(h.launches.length).toBe(launched);
  });

  it('still relaunches a model with a projector when the switch changed', async () => {
    gguf('qwen3.5-0.8b-mtp', 'Qwen3.5-0.8B-Q8_0.gguf', true);
    await ask({ type: 'start-server', modelId: 'qwen3.5-0.8b-mtp' });
    expect(lastLaunch()?.mmprojPath).toBeDefined();
    await vision(false);
    await ask({ type: 'start-server', modelId: 'qwen3.5-0.8b-mtp' });
    expect(lastLaunch()?.mmprojPath).toBeUndefined();
    expect((await status()).blindReason).toBe('off');
  });
});

describe('Vision off, then Apply (relaunch)', () => {
  it('a server launched multimodal to see comes back without its projector', async () => {
    gguf('qwen3.5-0.8b-mtp', 'Qwen3.5-0.8B-Q8_0.gguf', true);
    await ask({ type: 'start-server', modelId: 'qwen3.5-0.8b-mtp', launchMode: 'multimodal' });
    expect(lastLaunch()?.mmprojPath).toBeDefined();
    await vision(false);
    expect((await ask<{ success: boolean }>({ type: 'relaunch' })).success).toBe(true);
    expect(lastLaunch()?.mmprojPath).toBeUndefined();
    const s = await status();
    expect(s.visionReady).toBe(false);
    expect(s.blindReason).toBe('off');
  });

  it('a switch flipped while the model is still loading is applied when it lands', async () => {
    gguf('qwen3.5-0.8b-mtp', 'Qwen3.5-0.8B-Q8_0.gguf', true);
    let release: () => void = () => {};
    h.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launched = h.launches.length;
    const loading = ask<{ success: boolean }>({
      type: 'start-server',
      modelId: 'qwen3.5-0.8b-mtp',
    });
    await vi.waitFor(() => expect(h.launches.length).toBe(launched + 1));
    expect((await status()).serverRunning).toBe(false);
    await vision(false);
    const applied = ask<{ success: boolean }>({ type: 'relaunch' });
    h.hold = null;
    release();
    expect((await loading).success).toBe(true);
    expect(await applied).toEqual({ success: true });
    expect(lastLaunch()?.mmprojPath).toBeUndefined();
    expect((await status()).blindReason).toBe('off');
  });
});

describe('rapid-mlx rows keep the method they name', () => {
  const twin = 'mlx-community/Qwen3.5-4B-MLX-8bit';
  const setUp = async () => {
    engine(engineCommand('rapid-mlx'));
    engine(rapidVisionCommand());
    file(rapidVisionMarker());
    await visionTwin(twin, 64);
    await stored('mlx-community/Qwen3.5-4B-MTP-bf16');
  };

  it('a clicked rapid-mlx · MTP row runs MTP on the text lane, not the vision lane without it', async () => {
    await setUp();
    await ask({
      type: 'start-server',
      modelId: 'qwen3.5-4b-mtp',
      profile: { engine: 'rapid-mlx', spec: 'none' },
    });
    // Plain rapid-mlx IS the vision lane's launch, so it sees.
    expect(lastLaunch()?.serverPath).toBe(rapidVisionCommand());
    expect((await status()).visionReady).toBe(true);
    expect(
      (
        await ask<{ success: boolean }>({
          type: 'use-profile',
          profile: { engine: 'rapid-mlx', spec: 'mtp' },
        })
      ).success,
    ).toBe(true);
    const launch = lastLaunch();
    expect(launch?.serverPath).toBe(engineCommand('rapid-mlx'));
    expect(launch?.args.join(' ')).toContain('"method":"mtp"');
    const s = await status();
    expect(s.profile).toEqual({ engine: 'rapid-mlx', spec: 'mtp' });
    expect(s.blindReason).toBe('engine');
  });

  it('calibration measures each rapid-mlx method on its own server', async () => {
    await setUp();
    engine(engineCommand('dflash-mlx'));
    await stored('z-lab/Qwen3.5-4B-DFlash');
    const before = h.launches.length;
    const reply = await ask<{ ok: boolean }>({ type: 'calibrate', modelId: 'qwen3.5-4b-mtp' });
    expect(reply.ok).toBe(true);
    const runs = h.launches.slice(before);
    // rapid-mlx/none (the vision lane), rapid-mlx/mtp, rapid-mlx/dflash, dflash-mlx/dflash — then the winner.
    const rapid = runs.filter(
      (l) => l.serverPath === engineCommand('rapid-mlx') || l.serverPath === rapidVisionCommand(),
    );
    expect(rapid.map((l) => l.args.find((a) => a.startsWith('{"method"')) ?? 'plain')).toEqual([
      'plain',
      expect.stringContaining('"method":"mtp"'),
      expect.stringContaining('"method":"dflash"'),
    ]);
  });

  it("calibration's text-only winner comes up where every later start will: on llama.cpp, seeing", async () => {
    await setUp();
    engine(engineCommand('dflash-mlx'));
    await stored('z-lab/Qwen3.5-4B-DFlash');
    gguf('qwen3.5-4b-mtp', 'Qwen3.5-4B-Q8_0.gguf', true);
    const reply = await ask<{ ok: boolean; record?: { chosen: { engine: string } | null } }>({
      type: 'calibrate',
      modelId: 'qwen3.5-4b-mtp',
    });
    expect(reply.ok).toBe(true);
    expect(reply.record?.chosen?.engine).toBe('dflash-mlx');
    const afterCalibration = await status();
    // The next implicit start — the app reopening, Apply — goes here too.
    await ask({ type: 'stop-server' });
    await ask({ type: 'start-server', modelId: 'qwen3.5-4b-mtp' });
    const implicit = await status();
    expect(implicit.profile?.engine).toBe('llamacpp');
    expect(implicit.visionReady).toBe(true);
    expect(afterCalibration.profile).toEqual(implicit.profile);
    expect(afterCalibration.visionReady).toBe(true);
  });
});

describe('a vision fallback llama.cpp cannot take', () => {
  it('a sharded model calibrated to an MLX engine still starts there, blind', async () => {
    engine(engineCommand('dflash-mlx'));
    await stored('mlx-community/Qwen3.5-122B-A10B-4bit');
    await stored('z-lab/Qwen3.5-122B-A10B-DFlash');
    // Shard 1 of 3 is on disk (and the projector): llama.cpp cannot join the rest.
    const dir = modelDir('qwen3.5-122b-a10b-mtp');
    file(join(dir, 'UD-Q4_K_M', 'Qwen3.5-122B-A10B-UD-Q4_K_M-00001-of-00003.gguf'));
    file(join(dir, 'mmproj-F16.gguf'));
    calibrated('qwen3.5-122b-a10b-mtp', 'UD-Q4_K_M', { engine: 'dflash-mlx', spec: 'dflash' });
    const started = await ask<{ success: boolean; error?: string }>({
      type: 'start-server',
      modelId: 'qwen3.5-122b-a10b-mtp',
    });
    expect(started.error).toBeUndefined();
    expect(started.success).toBe(true);
    const s = await status();
    expect(s.profile).toEqual({ engine: 'dflash-mlx', spec: 'dflash' });
    expect(s.blindReason).toBe('engine');
  });
});

describe("rapid-mlx's vision runtime is offered for a big single-file twin", () => {
  it('reads the safetensors HEADER, so a twin over 2 GiB still counts as seeing', async () => {
    engine(engineCommand('rapid-mlx'));
    rmSync(rapidVisionMarker(), { force: true });
    // 2.2 GB, the size readFileSync refuses (ERR_FS_FILE_TOO_LARGE).
    await visionTwin('mlx-community/Qwen3.5-9B-MLX-8bit', 2_200_000_000);
    const { companions } = await ask<{ companions: LlmCompanion[] }>({
      type: 'companions',
      modelId: 'qwen3.5-9b-mtp',
    });
    expect(companions.map((c) => c.kind)).toContain('engine:rapid-mlx-vision');
  });
});
