import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GEMMA4_E2B, getCatalogModel } from './catalog.js';
import {
  buildMlxProviderBlock,
  buildProviderBlock,
  type ModelsJson,
  mergeProviderBlock,
  writeModelsJson,
} from './models-json.js';

describe('models-json', () => {
  const path = join(tmpdir(), `pi-models-${Math.random().toString(36).slice(2)}.json`);
  afterEach(async () => {
    await rm(path, { force: true });
  });

  it('builds a llamacpp-stream provider block matching pi shape', () => {
    const block = buildProviderBlock(GEMMA4_E2B, { baseUrl: 'http://127.0.0.1:8080/v1' });
    expect(block.api).toBe('llamacpp-stream');
    expect(block.apiKey).toBe('none');
    expect(block.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(block.compat.supportsDeveloperRole).toBe(false);
    expect(block.models).toHaveLength(1);
    expect(block.models[0]?.id).toBe('gemma-4-e2b-it');
    expect(block.models[0]?.contextWindow).toBe(32_768);
    expect(block.models[0]?.maxTokens).toBeGreaterThan(0);
  });

  it('merges into existing providers without clobbering them', () => {
    const existing: ModelsJson = {
      providers: {
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          api: 'llamacpp-stream',
          apiKey: 'x',
          compat: {
            supportsDeveloperRole: true,
            supportsReasoningEffort: true,
            supportsUsageInStreaming: true,
          },
          models: [],
        },
      },
    };
    const block = buildProviderBlock(GEMMA4_E2B, { baseUrl: 'http://127.0.0.1:8080/v1' });
    const merged = mergeProviderBlock(existing, 'llamacpp', block);
    expect(Object.keys(merged.providers).sort()).toEqual(['anthropic', 'llamacpp']);
    // Original object is not mutated.
    expect(existing.providers.llamacpp).toBeUndefined();
  });

  it('builds an mlx-stream provider block with usage-in-streaming ON', () => {
    const mlx = getCatalogModel('mlx-qwen3.5-4b-4bit');
    expect(mlx).toBeDefined();
    const block = buildMlxProviderBlock(mlx as NonNullable<typeof mlx>, {
      baseUrl: 'http://127.0.0.1:8181/v1',
      servedModelId: 'mlx-community/Qwen3.5-4B-MLX-4bit',
    });
    expect(block.api).toBe('mlx-stream');
    // MLX emits usage in streaming (client-side TPS depends on it).
    expect(block.compat.supportsUsageInStreaming).toBe(true);
    expect(block.models[0]?.id).toBe('mlx-community/Qwen3.5-4B-MLX-4bit');
  });

  it('writes and re-reads, preserving other providers', async () => {
    const block = buildProviderBlock(GEMMA4_E2B, {
      baseUrl: 'http://127.0.0.1:8080/v1',
      servedModelId: 'served-id',
    });
    await writeModelsJson(path, 'llamacpp', block);
    await writeModelsJson(path, 'other', block);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ModelsJson;
    expect(Object.keys(parsed.providers).sort()).toEqual(['llamacpp', 'other']);
    expect(parsed.providers.llamacpp?.models[0]?.id).toBe('served-id');
  });
});

describe('the declared context window is the one the SERVER has', () => {
  /*
   * THIS KILLED BOTH 27B RUNS. `chooseContextCap` steps the window down to fit
   * the machine (64k → 48k for Qwen3.8-27B once the projector is counted), but
   * this block kept declaring the CATALOG number — so models.json said 65536
   * while llama-server ran `-c 49152`.
   *
   * pi grows the prompt toward 64k and, with its 16,384-token reserve, first
   * considers compacting at 65536 − 16384 = 49152 — EXACTLY the server's
   * ceiling. The server truncates first, so compaction never fires: run 17
   * logged zero compaction events and died at tot=49152 with a 1,984-token
   * reply. Run 16 died identically.
   */
  const model = {
    id: 'qwen3.8-27b-mtp',
    displayName: 'Qwen3.8 27B (MTP)',
    hfRepo: 'unsloth/Qwen3.8-27B-GGUF',
    contextWindow: 65_536,
    input: ['text', 'image'],
  } as never;

  it('declares the LAUNCHED window when the cap stepped it down', () => {
    const block = buildProviderBlock(model, {
      baseUrl: 'http://127.0.0.1:8080/v1',
      launchedContextWindow: 49_152,
    });
    expect(block.models[0]?.contextWindow).toBe(49_152);
  });

  it('derives maxTokens from the REAL window, not the catalog one', () => {
    const block = buildProviderBlock(model, {
      baseUrl: 'http://127.0.0.1:8080/v1',
      launchedContextWindow: 49_152,
    });
    // 61440 (the old value) would let pi ask for more output than the server has.
    expect(block.models[0]?.maxTokens).toBe(49_152 - 4096);
  });

  it('falls back to the catalog window when nothing was launched', () => {
    const block = buildProviderBlock(model, { baseUrl: 'http://127.0.0.1:8080/v1' });
    expect(block.models[0]?.contextWindow).toBe(65_536);
  });

  it('never declares MORE than the model actually supports', () => {
    const block = buildProviderBlock(model, {
      baseUrl: 'http://127.0.0.1:8080/v1',
      launchedContextWindow: 131_072,
    });
    expect(block.models[0]?.contextWindow).toBe(65_536);
  });
});
