/**
 * Produce / merge the pi `models.json` provider block for a running llama-server.
 *
 * Mirrors the shape pi reads from `~/.pi/agent/models.json`:
 *   providers.<name> = { baseUrl, api:"llamacpp-stream", apiKey, compat, models[] }
 *
 * `api` is "llamacpp-stream" (not "openai-completions") so these models bind to
 * @pi-desktop/provider-llamacpp's custom streamSimple handler (tool-call repair +
 * TPS) instead of pi's built-in openai-completions path. The provider extension
 * registers that api id; the two MUST agree or models silently use the built-in.
 * The build is a pure function; `writeModelsJson` read-merge-writes so it never
 * clobbers other providers already in the file. Electron-free.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CatalogModel } from './catalog.js';

export interface ModelsJsonModel {
  readonly id: string;
  readonly name: string;
  readonly input: ('text' | 'image')[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ModelsJsonCompat {
  readonly supportsDeveloperRole: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly supportsUsageInStreaming: boolean;
}

export interface ProviderBlock {
  readonly baseUrl: string;
  /**
   * The custom pi api this block binds to:
   *   - `llamacpp-stream` → @pi-desktop/provider-llamacpp (repair + TPS from timings),
   *   - `mlx-stream`      → @pi-desktop/provider-mlx (repair + CLIENT-side TPS; MLX
   *     `mlx_lm.server` emits no `timings`). See {@link buildMlxProviderBlock}.
   */
  readonly api: 'llamacpp-stream' | 'mlx-stream';
  readonly apiKey: string;
  readonly compat: ModelsJsonCompat;
  readonly models: ModelsJsonModel[];
}

export interface ModelsJson {
  providers: Record<string, ProviderBlock>;
}

export interface BuildProviderBlockOptions {
  /** OpenAI-compatible base URL, e.g. "http://127.0.0.1:8080/v1". */
  readonly baseUrl: string;
  /** Model id the llama-server advertises (defaults to the catalog id). */
  readonly servedModelId?: string;
  /** Cap on output tokens (defaults to contextWindow - 4096, min 1024). */
  readonly maxTokens?: number;
  /**
   * The context the server ACTUALLY launched with (`-c`), when it differs from
   * the catalog's declared maximum.
   *
   * THIS KILLED BOTH 27B RUNS. `chooseContextCap` steps the window down to fit
   * the machine — 64k → 48k for Qwen3.8-27B once the projector is counted — but
   * this block kept declaring the CATALOG number. So models.json told pi
   * `contextWindow: 65536` while llama-server was running `-c 49152`.
   *
   * pi then grows the prompt toward 64k and, with its default 16,384-token
   * reserve, would first consider compacting at 65536 − 16384 = 49152 — which is
   * EXACTLY where the server runs out. The server truncates the generation
   * before pi ever reaches its own threshold, so compaction never fires at all:
   * run 17 logged zero compaction events and died at `tot=49152` with a
   * 1,984-token reply. Run 16 died the same way.
   *
   * A model told it has more room than it has cannot manage the room it has.
   */
  readonly launchedContextWindow?: number;
}

/**
 * Build a single provider block for one catalog model served by a llama-server.
 * `apiKey: "none"` matches the live example — llama-server needs no auth but pi
 * requires the field present.
 */
export function buildProviderBlock(
  model: CatalogModel,
  opts: BuildProviderBlockOptions,
): ProviderBlock {
  /* The real ceiling, never the aspirational one — see launchedContextWindow. */
  const contextWindow =
    opts.launchedContextWindow !== undefined && opts.launchedContextWindow > 0
      ? Math.min(opts.launchedContextWindow, model.contextWindow)
      : model.contextWindow;
  const maxTokens = opts.maxTokens ?? Math.max(1024, contextWindow - 4096);
  return {
    baseUrl: opts.baseUrl,
    api: 'llamacpp-stream',
    apiKey: 'none',
    compat: {
      // llama-server is not OpenAI: it wants "system" not "developer", exposes
      // no reasoning_effort, and (by default) omits usage from stream chunks.
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
    },
    models: [
      {
        id: opts.servedModelId ?? model.id,
        name: model.displayName,
        input: [...model.input],
        contextWindow,
        maxTokens,
      },
    ],
  };
}

/**
 * Build a provider block for one MLX model served by `mlx_lm.server`.
 *
 * Same OpenAI-compat shape as {@link buildProviderBlock}, but binds to
 * `api:'mlx-stream'` (→ @pi-desktop/provider-mlx) and flips
 * `supportsUsageInStreaming` ON: MLX emits `usage` in stream chunks (which the
 * provider needs for CLIENT-side TPS, since MLX has no llama.cpp `timings`
 * block). The served id is typically the `mlx-community/*` repo the server
 * loaded. Round-12 MLX foundation.
 */
export function buildMlxProviderBlock(
  model: CatalogModel,
  opts: BuildProviderBlockOptions,
): ProviderBlock {
  const maxTokens = opts.maxTokens ?? Math.max(1024, model.contextWindow - 4096);
  return {
    baseUrl: opts.baseUrl,
    api: 'mlx-stream',
    apiKey: 'none',
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      // MLX emits usage in streaming (unlike llama.cpp's default) → client TPS.
      supportsUsageInStreaming: true,
    },
    models: [
      {
        id: opts.servedModelId ?? model.hfRepo,
        name: model.displayName,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens,
      },
    ],
  };
}

/** Pure merge: set `providers[name]` on a copy of `existing`. */
export function mergeProviderBlock(
  existing: ModelsJson | undefined,
  name: string,
  block: ProviderBlock,
): ModelsJson {
  const providers = { ...(existing?.providers ?? {}) };
  providers[name] = block;
  return { providers };
}

/** Parse existing models.json, tolerating a missing/corrupt file. */
async function readModelsJson(path: string): Promise<ModelsJson | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ModelsJson>;
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.providers === 'object') {
      return { providers: parsed.providers ?? {} };
    }
    return { providers: {} };
  } catch {
    return undefined;
  }
}

/** Read-merge-write the provider block into `path`, preserving other providers. */
export async function writeModelsJson(
  path: string,
  name: string,
  block: ProviderBlock,
): Promise<ModelsJson> {
  const existing = await readModelsJson(path);
  const merged = mergeProviderBlock(existing, name, block);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
