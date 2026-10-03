/**
 * "inference-supervisor" utilityProcess entry (plan §D). Owns the single live
 * LlamaServerSupervisor plus the catalog / recommender / downloader, and writes
 * pi's models.json so pi's llamacpp provider points at the live server. Talks
 * to the main-process host (llm-main.ts) over parentPort using ./protocol.
 *
 * Bundled to dist-electron/inference-supervisor.js (vite.config main entry) and
 * forked by llm-main.ts. Isolated from Electron main so a wedged download or a
 * crash-looping llama-server never takes the UI process down.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile as readFileAsync, rm, unlink } from 'node:fs/promises';
import { freemem, homedir, loadavg, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  assembleEngineLaunch,
  type BlindReason,
  benchPrompts,
  buildMlxProviderBlock,
  buildProviderBlock,
  CATALOG,
  type CalibEngine,
  type CalibrationInput,
  type CalibrationRecord,
  type CalibrationResult,
  type CatalogFile,
  type CatalogModel,
  cacheRoot,
  chatTemplatePath,
  chatTemplateSupported,
  chooseContextCap,
  chooseProfile,
  chooseServerPerfArgs,
  classifyBottleneck,
  configFingerprint,
  createMlxSupervisor,
  createPowerManager,
  detectAccelerators,
  detectHardware,
  downloadModel,
  effectiveLaunchConfig,
  ensureChatTemplate,
  ensureEngineFor,
  ensureGgufChatTemplate,
  ensureMlx,
  estimateRamGB,
  flagsToArgs,
  getCatalogFile,
  getCatalogModel,
  type HfGgufFile,
  type HfModelHit,
  type HfSort,
  hardwareKey,
  hfModelToCatalogEntry,
  isMlxSupported,
  type LaunchMode,
  type LaunchProfile,
  LlamaServerSupervisor,
  type LlamaSpecType,
  listHfGgufFiles,
  listHfRepoFiles,
  MANAGED_LLAMA_FLAGS,
  mlxWeightsHaveVision,
  mmprojFileFor,
  modelDir,
  modelEngine,
  PINNED_LLAMACPP,
  parseArgparseHelp,
  parseLlamaHelp,
  patchModelDirTemplate,
  planCandidates,
  planVisionEngine,
  powerBudgetGB,
  probeServerFeatures,
  profileOf,
  recommend,
  resolveTierModels,
  type SpecMethod,
  type StartResult,
  sampleFromServerTimings,
  sampleFromTimings,
  searchHfModels,
  summarise,
  type TierPick,
  usableMemoryGB,
  writeModelsJson,
} from '@pi-desktop/inference';
import {
  discardRepo,
  downloadRepo,
  entryDir,
  readManifest,
  selectFiles,
} from '@pi-desktop/model-store';
import type {
  HfGgufFileDTO,
  HfModelHitDTO,
  HfSortOption,
  LlmCalibrationProgress,
  LlmCalibrationRecord,
  LlmCatalogEntry,
  LlmCompanion,
  LlmHardware,
  LlmStatus,
  LlmTierPick,
} from '../ipc-contract';
import type {
  EngineFlagValue,
  EngineLaunchSettings,
  ModelSpecChoice,
} from '../settings/settings-contract';
import { DownloadCancellation, discardPartials, partialPaths } from './download-cancellation';
import {
  calibrationDir,
  engineCommand,
  engineInstalled,
  installedVenvEngines,
  mlxVenvRoot,
  omlxModelRoot,
  rapidVisionCommand,
  rapidVisionReady,
  rapidVisionVenvRoot,
  type VenvEngine,
} from './engine-paths';
import { dedupeFlags } from './launch-args';
import { modelFitsInRam } from './model-fit';
import { fastTextSlotLaunch } from './parallel-launch';
import { setBackgroundPriority } from './process-priority';
import type {
  EngineFlagsReply,
  HfListFilesReply,
  HfRegisterReply,
  HfSearchReply,
  LlmCalibrateReply,
  LlmCatalogReply,
  LlmOutbound,
  LlmRequest,
  LlmVerifyReply,
  UtilityParentPort,
} from './protocol';

const parentPort = (process as unknown as { parentPort: UtilityParentPort }).parentPort;

/** Bounded command runner for the power probes (see `power()`). */
const execFileAsync = promisify(execFile);

// The launched context is now chosen per-hardware by chooseContextCap (up to
// ~64k when RAM allows, KV-/slot-aware) — see the launch sites. The footer gauge
// still uses the launched size as its denominator.
const MODELS_JSON = join(homedir(), '.pi', 'agent', 'models.json');
const PROVIDER_NAME = 'llamacpp';
/** models.json provider key for MLX models (bound to provider-mlx's mlx-stream). */
const MLX_PROVIDER_NAME = 'mlx';

/** Detected hardware, memoized — it never changes for a process lifetime and each
 * `detectHardware()` spawns a few `sysctl` calls, so we probe once and reuse it for
 * both the catalog reply and the per-hardware launch-arg chooser. */
let hardwareCache: Awaited<ReturnType<typeof detectHardware>> | null = null;
/** llama-server's prompt-cache decisions (reuse, checkpoints, a forced full re-read). */
const PROMPT_CACHE_LINE =
  /forcing full prompt|context checkpoint|checking checkpoint|n_past\s*=|memory_seq_rm|prompt cache|cache.reuse|selected slot/i;

/** Logged, and beside the request bodies when `PI_DIAG_PROMPTS=<file>` (request-tap). */
function noteCacheLine(line: string): void {
  const text = `[llama] ${line.trim().slice(0, 300)}`;
  console.log(text);
  const diag = process.env.PI_DIAG_PROMPTS;
  if (diag?.includes('/')) {
    try {
      appendFileSync(diag, `${text}\n`);
    } catch {
      /* a diagnostic never breaks a launch */
    }
  }
}

async function getHardware(): Promise<Awaited<ReturnType<typeof detectHardware>>> {
  if (hardwareCache === null) hardwareCache = await detectHardware();
  return hardwareCache;
}

/** Renderer-owned settings file (read-only here) — the source of the HF token
 * used to fetch a model's gated base-repo chat template. */
const SETTINGS_JSON = join(homedir(), '.pi', 'desktop', 'settings.json');
/** Bound a chat-template fetch so a slow/hung HF request can never wedge a launch. */
const CHAT_TEMPLATE_FETCH_TIMEOUT_MS = 15_000;

/** Read the persisted HF token (base repos like `google/gemma-4-*` are gated).
 * Best-effort: returns undefined when the file is absent/corrupt/empty. */
function persistedHfToken(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SETTINGS_JSON, 'utf8'));
    const raw =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { hfToken?: unknown }).hfToken
        : undefined;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the `--jinja --chat-template-file <path>` args for a model with a
 * canonical `baseRepo` (Gemma-4). Fetches + caches the official template (see
 * `chat-template.ts`); on any failure falls back to a previously-cached template
 * (e.g. pulled at download time with the user's token) and, absent that, returns
 * `[]` so the launch is UNCHANGED. Bounded so it can never hang a server start.
 */
async function resolveChatTemplateArgs(
  model: CatalogModel,
  hfToken: string | undefined,
  serverPath?: string,
  ggufPath?: string,
): Promise<string[]> {
  const baseRepo = model.baseRepo;
  if (baseRepo === undefined) {
    /*
     * No canonical repo: the GGUF's own template, patched where it needs it
     * (the preserved-thinking gate — see chat-template.ts). A template the
     * patch leaves alone is not passed at all, so the launch is unchanged.
     */
    if (ggufPath === undefined) return [];
    try {
      const patched = await ensureGgufChatTemplate(ggufPath);
      if (patched === undefined) return [];
      if (serverPath !== undefined) {
        const ok = await chatTemplateSupported(serverPath, patched, spawn).catch(() => true);
        if (!ok) return [];
      }
      console.log(
        `[chat-template] ${model.id}: using the GGUF's own template, patched (${patched})`,
      );
      return ['--jinja', '--chat-template-file', patched];
    } catch (error) {
      console.log(
        `[chat-template] ${model.id}: could not read the GGUF's template: ${String(error)}`,
      );
      return [];
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TEMPLATE_FETCH_TIMEOUT_MS);
  timer.unref?.();

  /*
   * A TEMPLATE THE ENGINE CANNOT PARSE IS WORSE THAN NO TEMPLATE.
   *
   * These come from the base (transformers) repo and are rendered by llama.cpp's
   * minja, which is a subset of Jinja. When they disagree llama-server refuses to
   * START — MEASURED on IFM/K2-Horizon-0.9B, whose 51KB template produces
   * "Parser Error: Expected %} (Got true)" — and the app's only symptom is
   * "llama-server never became healthy on port N", with nothing anywhere naming
   * the template. The GGUF's own embedded template was fine the whole time.
   *
   * So the engine is asked first (68ms, no weights read), and a template it
   * would reject is simply not passed.
   */
  const usable = async (templatePath: string): Promise<string[]> => {
    if (serverPath === undefined) return ['--jinja', '--chat-template-file', templatePath];
    const ok = await chatTemplateSupported(serverPath, templatePath, spawn).catch(() => true);
    if (ok) return ['--jinja', '--chat-template-file', templatePath];
    console.log(
      `[chat-template] ${model.id}: ${baseRepo}'s template is not valid for this engine — falling back to the GGUF's own`,
    );
    return [];
  };

  try {
    const res = await ensureChatTemplate(baseRepo, { hfToken, signal: controller.signal });
    return await usable(res.path);
  } catch {
    const cached = chatTemplatePath(baseRepo);
    if (existsSync(cached)) return await usable(cached);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort chat-template prefetch during download, when the user's token is
 * in hand — so the launcher finds a warm cache (no network) at start. Never
 * throws; a failure just defers the fetch to launch time. */
async function prefetchChatTemplate(baseRepo: string, hfToken: string | undefined): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TEMPLATE_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    await ensureChatTemplate(baseRepo, { hfToken, signal: controller.signal });
  } catch {
    // best-effort — retried (with the persisted token) at start.
  } finally {
    clearTimeout(timer);
  }
}

/** Discovered Browse-HF models, adapted to the catalog shape. Persisted so a
 * downloaded HF model survives a supervisor restart and stays in the local set. */
const HF_MODELS_JSON = join(homedir(), '.pi', 'desktop', 'hf-models.json');
const hfModels = new Map<string, CatalogModel>();

function loadHfModels(): void {
  try {
    const raw = readFileSync(HF_MODELS_JSON, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const m of parsed) {
        if (typeof m === 'object' && m !== null && typeof (m as CatalogModel).id === 'string') {
          hfModels.set((m as CatalogModel).id, m as CatalogModel);
        }
      }
    }
  } catch {
    // Absent/corrupt registry → start empty; a fresh add rewrites it.
  }
}

function persistHfModels(): void {
  try {
    mkdirSync(dirname(HF_MODELS_JSON), { recursive: true });
    writeFileSync(HF_MODELS_JSON, `${JSON.stringify([...hfModels.values()], null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort: an unwritable registry only costs cross-restart persistence.
  }
}

/** Resolve a model id against the curated catalog first, then discovered HF adds. */
function getModel(id: string): CatalogModel | undefined {
  return getCatalogModel(id) ?? hfModels.get(id);
}

/** All models the manager knows about: curated + discovered HF (dedup by id). */
/**
 * The catalogue as this MACHINE sees it.
 *
 * MLX entries are served by `mlx_lm.server`, which is Apple-Silicon-only by
 * construction (Metal). Listing them elsewhere offered models that cannot start
 * — the launch gate refuses correctly, but only after the user has picked one
 * and, on the model screen, tried to download it. The gate belongs where the
 * list is built, so a Linux or Windows host simply never sees them.
 */
function allModels(): CatalogModel[] {
  const mlxOk = isMlxSupported();
  const byId = new Map<string, CatalogModel>();
  for (const m of CATALOG) {
    if (!mlxOk && modelEngine(m) === 'mlx') continue;
    /* A tool's private model (OmniSVG) is not a thing to talk to: it stays out
       of every list this feeds — the picker, the quick menu, the model screen,
       pi's registration. `getModel` still resolves it by id, which is all a
       download or the `svg` command needs. */
    if (m.purpose !== undefined && m.purpose !== 'chat') continue;
    byId.set(m.id, m);
  }
  for (const m of hfModels.values()) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()];
}

/** Map the UI sort option onto the raw HF models-API sort key. */
function toHfSort(sort: HfSortOption | undefined): HfSort {
  if (sort === 'likes') return 'likes';
  if (sort === 'recent') return 'lastModified';
  if (sort === 'trending') return 'trendingScore';
  return 'downloads';
}

interface CurrentServer {
  supervisor: LlamaServerSupervisor;
  model: CatalogModel;
  file: CatalogFile;
  contextWindow: number;
  baseUrl: string;
  /** The launch mode this server came up in (fast-text speed, or multimodal
   * vision). Surfaced in LlmStatus so the app knows if vision is already on. */
  launchMode: LaunchMode;
  /**
   * Whether a vision projector was actually attached to THIS server.
   *
   * The truth the launch mode used to stand in for, badly. `mmprojFileFor` now
   * returns the projector on every launch (measured 0.9% cost), so a `fast-text`
   * server can read an image — and asking `launchMode === 'multimodal'` said it
   * could not.
   */
  visionReady: boolean;
  /** Why it cannot see, when it cannot (vision-launch.ts BlindReason). */
  blindReason?: BlindReason;
  /** Set when vision moved the launch off the engine that was chosen. */
  visionFallback?: { from: string; why: string };
  /** How this server was launched — the engine and the speculative method. */
  profile: LaunchProfile;
  /** The models.json block it is registered under (see LlmStatus.provider). */
  provider: 'llamacpp' | 'mlx';
  /** The model id requests to this server must carry. */
  servedModelId: string;
  /** The command line it was launched with, and the user's part of it. */
  launchCommand: string;
  launchArgs: string[];
  launchConfigFingerprint: string;
}

let current: CurrentServer | null = null;
/**
 * A supervisor whose child is spawned but not yet healthy. `current` is only
 * set once `start()` resolves, and an engine can take minutes to load — a
 * teardown in that window (the app quit, a probe closed) found nothing to
 * kill and left the half-started server reparented to init. MEASURED
 * 2026-09-12: three `rapid-mlx serve` orphans from three probes.
 */
let launching: LlamaServerSupervisor | null = null;
/** `await supervisor.start()`, with the child reachable by the teardown meanwhile. */
async function startTracked(supervisor: LlamaServerSupervisor): Promise<StartResult> {
  launching = supervisor;
  try {
    return await supervisor.start();
  } finally {
    if (launching === supervisor) launching = null;
  }
}
/** The pinned build's `--spec-type` list, learned at the first llama.cpp launch. */
let engineSpecTypes: readonly string[] = [];
let phase: LlmStatus['phase'] = 'idle';
/** Set only while an engine VARIANT is compiling — see LlmStatus.engineBuild. */
let engineBuild: LlmStatus['engineBuild'];
let lastError: string | undefined;
let metrics: LlmStatus['metrics'] = null;

/** In-flight download bookkeeping. `intent` disambiguates a deliberate
 * pause/cancel (an AbortSignal fires either way) from a genuine transfer error. */
const cancellation = new DownloadCancellation();

function post(message: LlmOutbound): void {
  parentPort.postMessage(message);
}

/**
 * Where this file lives locally. A file catalogued under an earlier name
 * (`previousNames`) is renamed to the current one the first time it is seen,
 * so the catalog can learn a file's real name without orphaning the copy a
 * user already has — MEASURED on the user's library: bartowski's Nanbeige GGUF was
 * on disk under the bare name the catalog used to (wrongly) carry.
 */
function modelPathFor(model: CatalogModel, file: CatalogFile): string {
  const dir = modelDir(model.id);
  const current = join(dir, file.name);
  if (!existsSync(current)) {
    for (const old of file.previousNames ?? []) {
      const was = join(dir, old);
      if (!existsSync(was)) continue;
      try {
        renameSync(was, current);
        console.log(`[catalog] renamed ${old} → ${file.name} in ${dir}`);
      } catch (error) {
        console.log(`[catalog] could not rename ${old}: ${String(error)}`);
        return was;
      }
      break;
    }
  }
  return current;
}

function isDownloaded(model: CatalogModel, file: CatalogFile): boolean {
  return existsSync(modelPathFor(model, file));
}

/**
 * Bytes this model actually occupies on disk, right now.
 *
 * Not derivable in the renderer: `LlmCatalogEntry.downloaded` is a boolean, and
 * the per-quant sizes describe what COULD be fetched, not what is here. The
 * delete confirmation was doing the arithmetic from the SELECTED quant and got
 * "Frees 56 GB" for a directory holding 14.4 GB — the number described a
 * different thing than the button did.
 *
 * Reads the directory rather than the catalog, so a partially-fetched or
 * hand-copied model is counted as it lies. `.part` files are included: they are
 * on the disk and deleting the model reclaims them too.
 */
function downloadedBytesFor(model: CatalogModel): number {
  const dirs = [
    modelDir(model.id),
    // The MLX twin and drafters fetched with it, which a delete frees too.
    ...(model.mlxRepo !== undefined ? [entryDir('text', model.mlxRepo)] : []),
    ...(model.mlxDrafts ?? []).map((d) => entryDir('text', d.repo)),
  ];
  let total = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        try {
          const s = statSync(join(dir, name));
          if (s.isFile()) total += s.size;
        } catch {
          /* raced with a delete — skip it */
        }
      }
    } catch {
      /* unreadable — counts as nothing */
    }
  }
  return total;
}

function pickFile(model: CatalogModel, quant?: string): CatalogFile | undefined {
  return quant !== undefined ? getCatalogFile(model, quant) : model.files[0];
}

/** What the status says while the chat model is parked for a generation. */
const PARKED_NOTE = 'Paused to make room for a generation — back when it finishes';

/**
 * The launch in progress, for the status's `loading` — see LlmStatus.loading.
 * Set as each launch begins (and again when a crashed server is brought back),
 * reported only while `phase` is `starting`.
 */
let loading: { modelId: string; displayName: string; since: number } | undefined;
function beginLoading(model: CatalogModel): void {
  loading = { modelId: model.id, displayName: model.displayName, since: Date.now() };
}

function status(): LlmStatus {
  const parked = current?.supervisor.parked === true;
  return {
    phase,
    ...(phase === 'starting' && loading !== undefined ? { loading } : {}),
    // Parked counts as running: the URL is still the URL and the model comes
    // back on it — see LlmStatus.parked.
    serverRunning: (current?.supervisor.running ?? false) || parked,
    ...(parked ? { parked: PARKED_NOTE } : {}),
    baseUrl: current?.baseUrl ?? null,
    model: current
      ? {
          id: current.model.id,
          displayName: current.model.displayName,
          quant: current.file.quant,
          contextWindow: current.contextWindow,
        }
      : null,
    metrics,
    downloadedModelIds: allModels()
      .filter((m) => m.files.some((f) => isDownloaded(m, f)))
      .map((m) => m.id),
    launchMode: current?.launchMode,
    ...(engineBuild !== undefined ? { engineBuild } : {}),
    /* A projector was attached → the server can read an image, whatever mode it
       was launched in. MLX has no projector path, so it reports false. */
    visionReady: current?.visionReady ?? false,
    ...(current?.blindReason !== undefined ? { blindReason: current.blindReason } : {}),
    ...(current?.visionFallback !== undefined ? { visionFallback: current.visionFallback } : {}),
    ...(current !== null
      ? {
          profile: current.profile,
          provider: current.provider,
          servedModelId: current.servedModelId,
          launchArgs: current.launchArgs,
          launchCommand: current.launchCommand,
          launchConfigFingerprint: current.launchConfigFingerprint,
        }
      : {}),
    ...(calibration !== null ? { calibrating: true } : {}),
    ...(engineSpecTypes.length > 0 ? { engineSpecTypes: [...engineSpecTypes] } : {}),
    error: lastError,
  };
}

function emitStatus(): void {
  post({ kind: 'status', status: status() });
}

function catalogEntry(model: CatalogModel, recommendedId: string | null): LlmCatalogEntry {
  return {
    id: model.id,
    displayName: model.displayName,
    quants: model.files.map((f) => ({ quant: f.quant, bytes: f.bytes })),
    minRamGB: model.minRamGB,
    contextWindow: model.contextWindow,
    input: [...model.input],
    license: model.license,
    mtp: model.mtpEmbedded === true || model.mtpFile !== undefined,
    spec: model.spec,
    variants: model.variants?.map((v) => ({
      method: v.method,
      draftRepo: v.draftRepo,
      embedded: v.embedded,
    })),
    vision: model.input.includes('image'),
    downloaded: model.files.some((f) => isDownloaded(model, f)),
    downloadedBytes: downloadedBytesFor(model),
    downloadedQuants: model.files.filter((f) => isDownloaded(model, f)).map((f) => f.quant),
    recommended: model.id === recommendedId,
    hfRepo: model.hfRepo,
    engine: modelEngine(model),
    publisher: model.publisher,
    tier: model.tier,
    sharded: model.sharded,
    gated: model.gated === true,
    source: hfModels.has(model.id) ? 'hf' : 'curated',
    verified: model.verified,
    draftersOnDisk: draftsOnDisk(model),
  };
}

/** Map a resolved {@link TierPick} → the renderer DTO, adding the downloaded flag. */
function tierPickDto(pick: TierPick): LlmTierPick {
  return {
    modelId: pick.model.id,
    displayName: pick.displayName,
    quant: pick.file.quant,
    launchMode: pick.launchMode,
    spec: pick.spec,
    vision: pick.vision,
    bytes: pick.bytes,
    downloaded: isDownloaded(pick.model, pick.file),
  };
}

/*
 * ACCELERATOR DETECTION IS CACHED FOR THE PROCESS. It spawns `nvidia-smi` /
 * `system_profiler` / `lspci`, none of which change while the app is open, and
 * the catalog is listed on every model-manager open.
 */
let acceleratorCache: Awaited<ReturnType<typeof detectAccelerators>> | null = null;
async function accelerators(): Promise<Awaited<ReturnType<typeof detectAccelerators>>> {
  acceleratorCache ??= await detectAccelerators();
  return acceleratorCache;
}

/*
 * THE LIVE POWER POLICY, for this process.
 *
 * the user: "ensuring we leave a certain amount of memory available as a buffer so
 * the user can use computer as normal while generation and such occurs … this
 * could be dynamic even tracking what the current user memory/cpu/gpu usage is",
 * and then: "you need to handle a range of hardware and a range of situations
 * and bottlenecks."
 *
 * It lives HERE because this is the process that launches servers — the decision
 * has to be in hand at the moment the args are assembled, and reaching across a
 * process boundary for it would make the launch wait on a poll.
 *
 * Built lazily from the accelerator probe, because which wall this machine is
 * nearest is the first thing the policy needs and the probe is the only thing
 * that knows. Sampling starts with it and never blocks a launch: a launch reads
 * whatever the last reading decided.
 */
let powerCache: ReturnType<typeof createPowerManager> | null = null;
async function power(): Promise<ReturnType<typeof createPowerManager>> {
  if (powerCache !== null) return powerCache;
  const acc = await accelerators();
  const bottleneck = classifyBottleneck(acc);
  const budgetGB = powerBudgetGB(acc);
  powerCache = createPowerManager({
    probes: {
      run: async (cmd, args) => {
        try {
          const { stdout } = await execFileAsync(cmd, [...args], { timeout: 4000 });
          return stdout;
        } catch {
          // No such tool, no permission, or it hung — all the same answer here.
          return null;
        }
      },
      readFile: async (path) => {
        try {
          return await readFileAsync(path, 'utf8');
        } catch {
          return null;
        }
      },
      loadAvg: () => loadavg(),
      cpuCount: acc.cpuCount ?? 1,
      memory: () => ({ total: totalmem(), free: freemem() }),
      platform: acc.platform,
      // Only worth spawning nvidia-smi on a machine that has one.
      hasNvidia: acc.gpus.some((g) => g.vendor === 'nvidia'),
    },
    bottleneck,
    budgetGB,
    ...(acc.cpuCount !== undefined ? { cpuCount: acc.cpuCount } : {}),
    onChange: (decision) => {
      // eslint-disable-next-line no-console
      console.log(`[pi-power] ${decision.level}: ${decision.reason}`);
      // Main gates heavy generation jobs on this — see the 'power' outbound.
      post({
        kind: 'power',
        level: decision.level,
        heavyJobPace: decision.heavyJobPace,
        heavyJobPreviews: decision.heavyJobPreviews,
        reason: decision.reason,
      });
    },
  });
  powerCache.start();
  return powerCache;
}

async function listCatalog(): Promise<LlmCatalogReply> {
  const hw = await getHardware();
  const acc = await accelerators().catch(() => null);
  const gpu = acc?.gpus[0];
  const hardware: LlmHardware = {
    totalRamGB: hw.totalRamGB,
    chip: hw.chip ?? null,
    isAppleSilicon: hw.isAppleSilicon,
    ...(acc === null
      ? {}
      : {
          platform: acc.platform,
          gpuVendor: gpu?.vendor ?? 'unknown',
          ...(gpu?.name === undefined ? {} : { gpuName: gpu.name }),
          ...(gpu?.vramGB === undefined ? {} : { vramGB: gpu.vramGB }),
          ...(gpu?.cudaMajor === undefined ? {} : { cudaMajor: gpu.cudaMajor }),
          unifiedMemory: acc.unifiedMemory,
          npu: acc.npu,
          usableMemoryGB: usableMemoryGB(acc),
        }),
  };
  let recommendedModelId: string | null = null;
  let recommendation: LlmCatalogReply['recommendation'] = null;
  try {
    const rec = recommend(hw);
    recommendedModelId = rec.model.id;
    const tiers = resolveTierModels(hw);
    recommendation = {
      modelId: rec.model.id,
      quant: rec.file.quant,
      tier: rec.tier,
      rationale: rec.rationale,
      simpleSet: rec.simpleSet.map((p) => ({
        role: p.role,
        modelId: p.model.id,
        displayName: p.model.displayName,
        quant: p.file.quant,
        launchMode: p.launchMode,
        spec: p.spec,
        vision: p.vision,
      })),
      tierModels: {
        fast: tierPickDto(tiers.fast),
        balanced: tierPickDto(tiers.balanced),
        intelligent: tierPickDto(tiers.intelligent),
      },
    };
  } catch {
    recommendedModelId = null;
    recommendation = null;
  }
  // Curated first (recommender picks live here), then discovered HF adds.
  return {
    models: allModels().map((m) => catalogEntry(m, recommendedModelId)),
    hardware,
    recommendedModelId,
    recommendation,
  };
}

// --- Hugging Face browse + register ------------------------------------------

function toHfHit(hit: HfModelHit): HfModelHitDTO {
  return {
    id: hit.id,
    author: hit.author,
    name: hit.name,
    downloads: hit.downloads,
    likes: hit.likes,
    tags: [...hit.tags],
    gated: hit.gated,
    pipelineTag: hit.pipelineTag,
    updatedAt: hit.updatedAt,
    createdAt: hit.createdAt,
    likesRecent: hit.likesRecent,
    paramsTotal: hit.paramsTotal,
  };
}

function toHfFile(file: HfGgufFile, contextWindow: number): HfGgufFileDTO {
  return {
    path: file.path,
    sizeBytes: file.sizeBytes,
    quant: file.quant,
    sha256: file.sha256,
    mmproj: file.mmproj,
    mtp: file.mtp,
    minRamGB:
      file.sizeBytes !== undefined && file.sizeBytes > 0
        ? estimateRamGB(file.sizeBytes, contextWindow)
        : undefined,
  };
}

async function hfSearch(req: Extract<LlmRequest, { type: 'hf-search' }>): Promise<HfSearchReply> {
  try {
    const hits = await searchHfModels(req.query, {
      filters: {
        family: req.family,
        task: req.task,
        gated: req.gated,
        minLikes: req.minLikes,
      },
      sort: toHfSort(req.sort),
      limit: req.limit,
      hfToken: req.hfToken,
      authors: req.authors,
      ggufOnly: req.ggufOnly,
    });
    return { hits: hits.map(toHfHit) };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    return { hits: [], error: message, rateLimited: /HTTP 429/.test(message) };
  }
}

async function hfListFiles(
  req: Extract<LlmRequest, { type: 'hf-list-files' }>,
): Promise<HfListFilesReply> {
  const contextWindow = req.contextWindow ?? 8192;
  try {
    const files = await listHfGgufFiles(req.repoId, { hfToken: req.hfToken });
    return { files: files.map((f) => toHfFile(f, contextWindow)) };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    // A 401/403 on the tree is the gated-repo signal (needs a token/licence).
    return { files: [], error: message, gated: /HTTP 40[13]/.test(message) };
  }
}

/** Coerce a serialized HfGgufFileDTO back to the package's HfGgufFile shape. */
function fromHfFileDTO(f: HfGgufFileDTO): HfGgufFile {
  return {
    path: f.path,
    sizeBytes: f.sizeBytes,
    quant: f.quant,
    sha256: f.sha256,
    mmproj: f.mmproj,
    mtp: f.mtp,
  };
}

function registerHfModel(req: Extract<LlmRequest, { type: 'register-hf-model' }>): HfRegisterReply {
  const entry = hfModelToCatalogEntry(req.hit, fromHfFileDTO(req.file), {
    contextWindow: req.contextWindow,
    mmproj: req.mmproj !== undefined ? fromHfFileDTO(req.mmproj) : undefined,
    mtpFile: req.mtpFile !== undefined ? fromHfFileDTO(req.mtpFile) : undefined,
  });
  hfModels.set(entry.id, entry);
  persistHfModels();
  emitStatus();
  // A discovered HF add is never the hardware recommendation (the recommender
  // only ever picks a curated model), so recommendedId is null here.
  return { modelId: entry.id, entry: catalogEntry(entry, null) };
}

/** Restore the phase after a download settles (running server → ready, else idle). */
function settleDownloadPhase(): void {
  phase = current?.supervisor.running === true ? 'ready' : 'idle';
}

/**
 * WHAT ELSE A MODEL NEEDS SO THE OTHER ENGINES CAN BE MEASURED OFFLINE.
 *
 * On Apple Silicon a model's download also brings its MLX twin and the MLX
 * drafters the catalogue names — the user: "when downloading any models from
 * recommended tab if applicable drafter(s) should also be downloaded right
 * there and then", and calibration "doesn't require internet to run". They go
 * to the model store (`store/text/<repo>`), which every engine is then pointed
 * at as a local path. Repos already complete on disk are not listed again.
 *
 * Best-effort in both directions: with no network the list is empty and the
 * GGUF download proceeds exactly as before; a twin that fails never fails the
 * weights. `total` per repo is what the tree API reports, so the ONE job bar
 * can be sized before the first byte.
 */
async function planMlxExtras(
  model: CatalogModel,
  hfToken: string | undefined,
  signal: AbortSignal,
): Promise<Array<{ repo: string; total: number; fileCount: number; what: string }>> {
  if (!isMlxSupported() || modelEngine(model) === 'mlx') return [];
  const wanted: Array<{ repo: string; what: string }> = [];
  if (model.mlxRepo !== undefined) wanted.push({ repo: model.mlxRepo, what: 'MLX weights' });
  for (const d of model.mlxDrafts ?? []) {
    const what =
      d.method === 'mtp'
        ? 'MTP head (MLX)'
        : `${d.method === 'dflash' ? 'DFlash' : d.method === 'dspark' ? 'DSpark' : d.method} drafter (MLX)`;
    wanted.push({
      repo: d.repo,
      what,
    });
  }
  const out: Array<{ repo: string; total: number; fileCount: number; what: string }> = [];
  for (const w of wanted) {
    if ((await storedRepoDir(w.repo)) !== undefined) continue;
    try {
      const files = selectFiles(
        await listHfRepoFiles(w.repo, {
          ...(hfToken === undefined ? {} : { hfToken }),
          signal,
        }),
      );
      const total = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
      if (files.length > 0) out.push({ ...w, total, fileCount: files.length });
    } catch (error) {
      console.log(
        `[download] skipping ${w.what} ${w.repo}: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`,
      );
    }
  }
  return out;
}

/** Free bytes on the volume the store lives on, or null when unknowable. */
function freeDiskBytes(dir: string): number | null {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

async function downloadOne(
  modelId: string,
  quant?: string,
  hfToken?: string,
): Promise<{ success: boolean; error?: string; paused?: boolean; cancelled?: boolean }> {
  const model = getModel(modelId);
  if (model === undefined) return { success: false, error: `unknown model: ${modelId}` };
  /*
   * MLX MODELS ARE NOT OURS TO DOWNLOAD. `mlx_lm.server` fetches the
   * `mlx-community/*` repo into the HF cache on first launch, so the catalogue
   * entry has no single file to fetch: its `files[0].name` is the REPO, and
   * `hfResolveUrl` on it resolves to a directory. Running this anyway wrote
   * nothing and reported success, and `isDownloaded` then stat'd a path
   * `mlx_lm.server` never writes — so the model never read as downloaded and the
   * button stayed live forever. Selecting the model is the whole flow.
   */
  if (modelEngine(model) === 'mlx') {
    return {
      success: false,
      error: `${model.displayName} downloads itself on first use — just select it.`,
    };
  }
  // Serialize: one download at a time. A second request while one runs is a
  // no-op so the UI can't fork two writers onto the same `.part`.
  if (cancellation.running) return { success: false, error: 'a download is already running' };

  const signal = cancellation.begin();
  phase = 'downloading';
  lastError = undefined;
  emitStatus();
  /* The MLX twin and drafters, sized up front so the job bar covers them. A
     volume without room for them keeps the GGUF and drops the extras. */
  let extras = await planMlxExtras(model, hfToken, signal).catch(() => []);
  const extrasTotal = extras.reduce((sum, e) => sum + e.total, 0);
  const extrasFiles = extras.reduce((sum, e) => sum + e.fileCount, 0);
  const free = freeDiskBytes(modelDir(model.id));
  const modelBytes = pickFile(model, quant)?.bytes ?? 0;
  if (extras.length > 0 && free !== null && free < modelBytes + extrasTotal + 4 * 1024 ** 3) {
    console.log(
      `[download] not enough disk for the MLX extras of ${model.id} (${(extrasTotal / 1024 ** 3).toFixed(1)} GB); fetching the GGUF only`,
    );
    extras = [];
  }
  let ggufDone = 0;
  let ggufTotal: number | null = 0;
  let ggufFiles = 1;
  let extrasRepo: string | null = null;
  try {
    await downloadModel(model, {
      quant,
      /*
       * A DOWNLOAD FETCHES WHAT THE MODEL NEEDS, not what the next launch
       * happens to want. This was `launchMode: 'fast-text'`, which skips the
       * vision projector — so a vision model read as fully downloaded and then
       * stalled for ~1 GB the first time it was shown an image. Unsloth Desktop
       * folds the projector into every variant's download for the same reason.
       */
      allCompanions: true,
      signal,
      hfToken,
      onProgress: (file, p) => {
        ggufDone = p.jobReceived;
        ggufTotal = p.jobTotal;
        ggufFiles = p.fileCount;
        post({
          kind: 'download-progress',
          progress: {
            modelId,
            file,
            received: p.received,
            total: p.total ?? null,
            fraction: p.fraction ?? null,
            fileIndex: p.fileIndex,
            fileCount: p.fileCount + extrasFiles,
            jobReceived: p.jobReceived,
            jobTotal: p.jobTotal === null ? null : p.jobTotal + extrasTotal,
          },
        });
      },
    });
    // Opportunistically warm the chat-template cache while the user's HF token
    // is in hand (base repos are gated) so the launcher finds it without a
    // network round-trip. Best-effort — never fails the download.
    if (model.baseRepo !== undefined) await prefetchChatTemplate(model.baseRepo, hfToken);
    /*
     * THEN THE EXTRAS, one repo at a time, on the same bar. A failure here is
     * logged and the weights stay downloaded: the GGUF is what the user asked
     * for, and a twin that did not arrive only means calibration has fewer
     * rows to measure.
     */
    let extrasDone = 0;
    let fileOffset = ggufFiles;
    for (const e of extras) {
      if (signal.aborted) break;
      extrasRepo = e.repo;
      try {
        await downloadRepo({
          repo: e.repo,
          kind: 'text',
          name: `${model.displayName} — ${e.what}`,
          family: model.id,
          backend: 'mlx',
          notes: `Fetched with ${model.id} so the MLX engines can be calibrated offline.`,
          signal,
          ...(hfToken === undefined ? {} : { hfToken }),
          onProgress: (p) =>
            post({
              kind: 'download-progress',
              progress: {
                modelId,
                file: `${e.what}: ${p.file}`,
                received: p.received,
                total: p.total,
                fraction: p.fraction,
                fileIndex: fileOffset + p.fileIndex,
                fileCount: ggufFiles + extrasFiles,
                jobReceived: ggufDone + extrasDone + p.received,
                jobTotal: ggufTotal === null ? null : ggufTotal + extrasTotal,
              },
            }),
        });
        extrasDone += e.total;
        fileOffset += e.fileCount;
        console.log(
          `[download] ${e.what} for ${model.id}: ${e.repo} (${(e.total / 1024 ** 3).toFixed(2)} GB)`,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        console.log(
          `[download] ${e.what} ${e.repo} failed: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
        );
      }
    }
    extrasRepo = null;
    settleDownloadPhase();
    emitStatus();
    return { success: true };
  } catch (error) {
    // An abort means the user paused or cancelled — not a failure.
    if (cancellation.intent === 'pause') {
      settleDownloadPhase();
      emitStatus();
      return { success: false, paused: true };
    }
    if (cancellation.intent === 'cancel') {
      await discardPartials(partialPaths(modelDir(model.id), model.files, quant, join), (p) =>
        unlink(p),
      );
      // A twin cut mid-way is not a model; the finished GGUF stays.
      if (extrasRepo !== null) await discardRepo('text', extrasRepo).catch(() => undefined);
      settleDownloadPhase();
      emitStatus();
      return { success: false, cancelled: true };
    }
    phase = 'error';
    lastError = String(error instanceof Error ? error.message : error);
    emitStatus();
    return { success: false, error: lastError };
  } finally {
    cancellation.clear();
  }
}

function pauseDownload(): { success: boolean } {
  return { success: cancellation.pause() };
}

async function cancelDownload(): Promise<{ success: boolean }> {
  return { success: cancellation.cancel() };
}

async function deleteModel(modelId: string): Promise<{ success: boolean; error?: string }> {
  const model = getModel(modelId);
  if (model === undefined) return { success: false, error: `unknown model: ${modelId}` };
  // Refuse to delete the model currently serving — stop it first.
  if (current?.model.id === modelId)
    return { success: false, error: 'model is running; stop it first' };
  try {
    await rm(modelDir(modelId), { recursive: true, force: true });
    // Its MLX twin and drafters were fetched for it and are useless without it.
    const repos = [
      ...(model.mlxRepo !== undefined ? [model.mlxRepo] : []),
      ...(model.mlxDrafts ?? []).map((d) => d.repo),
    ];
    for (const repo of repos) await discardRepo('text', repo).catch(() => undefined);
    for (const f of model.files) {
      await rm(recordPath(modelId, f.quant), { force: true }).catch(() => undefined);
    }
    emitStatus();
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error instanceof Error ? error.message : error) };
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Re-hash each on-disk file against its catalog sha256. Files with no catalog
 * sha are reported `checked: false` (nothing to verify), which still counts as
 * ok so a hash-less entry never shows as corrupt. */
async function verifyModel(modelId: string, quant?: string): Promise<LlmVerifyReply> {
  const model = getModel(modelId);
  if (model === undefined) return { ok: false, files: [], error: `unknown model: ${modelId}` };
  const files = quant !== undefined ? model.files.filter((f) => f.quant === quant) : model.files;
  const results: LlmVerifyReply['files'] = [];
  for (const file of files) {
    const filePath = modelPathFor(model, file);
    if (!existsSync(filePath)) continue;
    if (file.sha256 === undefined) {
      results.push({ file: file.name, ok: true, checked: false });
      continue;
    }
    try {
      const actual = await sha256File(filePath);
      results.push({ file: file.name, ok: actual === file.sha256, checked: true });
    } catch (error) {
      return {
        ok: false,
        files: results,
        error: String(error instanceof Error ? error.message : error),
      };
    }
  }
  return { ok: results.every((r) => r.ok), files: results };
}

/** llama-server prints a per-request generation timing line to stderr; parse
 * its tokens/s so the footer shows real throughput (the provider's own
 * onTimings runs inside pi and can't reach this process). */
function parseTps(line: string): number | undefined {
  if (!line.includes('eval time') || line.includes('prompt eval time')) return undefined;
  const m = line.match(/([\d.]+)\s*tokens per second/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Start the MLX server (round-12 foundation): `mlx_lm.server` via uv, health-
 * probed on `/v1/models`, with an `mlx-stream` models.json block bound to
 * provider-mlx. Gated on Apple Silicon. `mlx_lm.server` auto-downloads the
 * `mlx-community/*` repo on first launch (the app-side multi-file downloader is
 * a deferred follow-up). TPS surfaces client-side via provider-mlx, not here.
 */
async function startMlxServer(
  model: CatalogModel,
  file: CatalogFile,
): Promise<{ success: boolean; baseUrl?: string; error?: string }> {
  if (!isMlxSupported()) {
    return { success: false, error: 'MLX models require Apple Silicon (darwin/arm64)' };
  }
  beginLoading(model);
  phase = 'starting';
  lastError = undefined;
  metrics = null;
  emitStatus();
  try {
    if (current !== null) {
      await current.supervisor.dispose();
      current = null;
    }
    const uv = await ensureMlx();
    const hw = await getHardware();
    // Hardware-adaptive context (the user): mlx_lm.server auto-manages its KV, so this
    // is primarily the reported/gauge window — kept consistent with the llama.cpp
    // path (up to ~64k when RAM allows, KV-aware, ≤ the model's own max).
    const contextWindow = chooseContextCap({
      modelBytes: file.bytes,
      modelMaxContext: model.contextWindow,
      totalRamGB: hw.totalRamGB,
    });
    const supervisor = createMlxSupervisor({ uvPath: uv.uvPath, repo: model.hfRepo });
    supervisor.on((event) => {
      if (event.type === 'metrics') {
        metrics = { lastTps: event.metrics.lastTps, avgTps: event.metrics.avgTps };
        emitStatus();
      } else if (event.type === 'crash' || event.type === 'restart') {
        beginLoading(model);
        phase = 'starting';
        emitStatus();
      } else if (event.type === 'exit' && event.reason === 'failed') {
        phase = 'error';
        lastError = event.detail ?? 'mlx_lm.server failed';
        current = null;
        emitStatus();
      }
    });
    const started = await startTracked(supervisor);
    const baseUrl = supervisor.baseUrl;
    current = {
      supervisor,
      model,
      file,
      contextWindow,
      baseUrl,
      launchMode: 'fast-text',
      // mlx_lm.server takes no projector, so this engine cannot read an image.
      visionReady: false,
      profile: { engine: 'mlx-lm', spec: 'none' },
      provider: 'mlx',
      servedModelId: model.hfRepo,
      launchCommand: uv.uvPath,
      launchArgs: supervisor.argv(),
      launchConfigFingerprint: launchFingerprint('mlx-lm', model.id),
    };
    phase = 'ready';
    await writeModelsJson(
      MODELS_JSON,
      MLX_PROVIDER_NAME,
      buildMlxProviderBlock(model, { baseUrl, servedModelId: model.hfRepo }),
    );
    emitStatus();
    return { success: true, baseUrl: started.baseUrl };
  } catch (error) {
    phase = 'error';
    lastError = String(error instanceof Error ? error.message : error);
    current = null;
    emitStatus();
    return { success: false, error: lastError };
  }
}

// ── the user's launch flags ──────────────────────────────────────────────────

/** Pushed from main (settings) at child creation and on every change. */
let engineLaunch: EngineLaunchSettings = {};
let portableKnobs: Record<string, EngineFlagValue> = {};
let modelSpec: Record<string, ModelSpecChoice> = {};
/** Settings → engine menu → Vision (default ON). See SettingsState.loadVision. */
let loadVision = true;

const REFUSED_LLAMA_FLAGS = Object.keys(MANAGED_LLAMA_FLAGS).filter(
  (k) => MANAGED_LLAMA_FLAGS[k] === 'refused',
);

/**
 * The user's arguments for an engine, in the order they go on the command
 * line: known flags first, raw tokens after. The three flags a launch cannot
 * survive are dropped with a log line — the panel never offers them, so a
 * value here came from a pasted command.
 */
function userArgsFor(engine: string): string[] {
  /* The cross-engine knobs spelled in this engine's own flags, under the
     engine's explicit ones (portable-knobs.ts: the explicit flag wins). */
  const cfg = effectiveLaunchConfig(engine, { knobs: portableKnobs, engineLaunch });
  if (Object.keys(cfg.flags).length === 0 && cfg.rawArgs.length === 0) return [];
  const { args, refused } = flagsToArgs(cfg.flags, {
    refused: engine === 'llamacpp' ? REFUSED_LLAMA_FLAGS : ['--host', '--port', '--model'],
  });
  if (refused.length > 0) {
    console.log(`[engine] ignoring ${refused.join(', ')} for ${engine}: Bobble sets it`);
  }
  return [...args, ...cfg.rawArgs];
}

/** What the fingerprint on the status covers: the user's flags and spec choice for this launch. */
function launchFingerprint(engine: string, modelId: string): string {
  return configFingerprint({
    engine: effectiveLaunchConfig(engine, { knobs: portableKnobs, engineLaunch }),
    spec: modelSpec[modelId] ?? { method: 'auto' },
  });
}

/** The user's speculative choice for a model as a launch profile, or null for `auto`. */
function userProfileFor(model: CatalogModel): LaunchProfile | null {
  const choice = modelSpec[model.id];
  if (choice === undefined || choice.method === 'auto') return null;
  if (choice.method === 'custom') {
    if (choice.draftPath === undefined) return null;
    return {
      engine: 'llamacpp',
      spec: 'custom',
      custom: { draftPath: choice.draftPath, specType: choice.specType ?? 'draft-simple' },
    };
  }
  return { engine: 'llamacpp', spec: choice.method };
}

// ── engines and profiles ─────────────────────────────────────────────────────

/**
 * The launch a model gets when nothing has been measured: llama.cpp, with the
 * method the catalogue declares — exactly the launch that existed before
 * calibration did. `specDisabled` is honoured further down (mtpSupported).
 */
function defaultProfile(model: CatalogModel): LaunchProfile {
  if (model.spec === 'eagle3') return { engine: 'llamacpp', spec: 'eagle3' };
  // "MTP" only when the model HAS a head: the launch never passed MTP flags to
  // a model without one, but the profile said MTP and the engine menu showed
  // "Nanbeige 4.2 3B · llama.cpp · MTP" for a model that has no such thing.
  const hasMtp = model.mtpEmbedded === true || model.mtpFile !== undefined;
  return { engine: 'llamacpp', spec: hasMtp ? 'mtp' : 'none' };
}

function sameProfile(a: LaunchProfile, b: LaunchProfile): boolean {
  return a.engine === b.engine && a.spec === b.spec;
}

/** A profile's method as llama-server spells it, plus which draft file it needs. */
function llamaSpecFor(
  spec: LaunchProfile['spec'],
  model: CatalogModel,
  custom?: LaunchProfile['custom'],
): { specType: LlamaSpecType; draftMethod?: SpecMethod; customDraft?: string } {
  switch (spec) {
    case 'none':
      return { specType: 'none' };
    case 'custom':
      // The user's own draft GGUF with the type they picked for it; llama.cpp
      // also detects DFlash2 / DSpark heads from the file itself.
      return {
        specType: (custom?.specType ?? 'draft-simple') as LlamaSpecType,
        customDraft: custom?.draftPath,
      };
    case 'eagle3':
      return { specType: 'draft-eagle3', draftMethod: 'eagle3' };
    case 'dflash':
      return { specType: 'draft-dflash', draftMethod: 'dflash' };
    case 'dspark':
      return { specType: 'draft-dspark', draftMethod: 'dspark' };
    case 'ngram':
      return { specType: 'ngram-mod' };
    default:
      // 'mtp' and 'auto': the model's own heads, when it has them.
      return model.spec === 'eagle3' && spec === 'auto'
        ? { specType: 'draft-eagle3', draftMethod: 'eagle3' }
        : { specType: 'draft-mtp' };
  }
}

/** The draft GGUF for a method, if the catalogue names one and it is on disk. */
function draftPathFor(model: CatalogModel, method: SpecMethod): string | undefined {
  const dir = modelDir(model.id);
  const candidates: string[] = [];
  if (method === 'eagle3' && model.spec === 'eagle3' && model.draftModel !== undefined) {
    candidates.push(join(dir, model.draftModel.name));
  }
  for (const v of model.variants ?? []) {
    if (v.method === method && v.draftModel !== undefined)
      candidates.push(join(dir, v.draftModel.name));
  }
  return candidates.find((c) => existsSync(c));
}

/** Which draft methods have their GGUF on disk for this model. */
function draftsOnDisk(model: CatalogModel): ('eagle3' | 'dflash' | 'dspark')[] {
  return (['eagle3', 'dflash', 'dspark'] as const).filter(
    (m) => draftPathFor(model, m) !== undefined,
  );
}

/**
 * Everything the catalogue names beside a model, with whether each is on disk.
 *
 * the user: "when I go to minicpm 5 2b in bobble there's no fetch missing button
 * that fetches drafters and models" — the button used to hide inside a
 * finished calibration's skip list, so a model that was never calibrated (or
 * whose companions were catalogued after it was downloaded) had no way to ask
 * for them. This is the honest input for that button: nothing on the list →
 * no button.
 */
async function companionsOf(modelId: string, quant?: string): Promise<LlmCompanion[]> {
  const model = getModel(modelId);
  if (model === undefined) return [];
  const out: LlmCompanion[] = [];
  const isMlxEntry = modelEngine(model) === 'mlx';
  if (!isMlxEntry && model.mmproj !== undefined) {
    out.push({
      kind: 'mmproj',
      what: 'vision projector',
      source: model.mmproj.name,
      present: existsSync(join(modelDir(model.id), model.mmproj.name)),
    });
  }
  if (!isMlxEntry && model.mtpFile !== undefined && model.mtpEmbedded !== true) {
    out.push({
      kind: 'mtp',
      what: 'MTP head (GGUF)',
      source: model.mtpFile.name,
      present: existsSync(join(modelDir(model.id), model.mtpFile.name)),
    });
  }
  if (!isMlxEntry) {
    for (const m of ['eagle3', 'dflash', 'dspark'] as const) {
      const v = model.variants?.find((x) => x.method === m && x.draftModel !== undefined);
      if (v?.draftModel === undefined) continue;
      out.push({
        kind: `gguf-${m}`,
        what: `${m === 'eagle3' ? 'EAGLE-3' : m === 'dflash' ? 'DFlash' : 'DSpark'} drafter (GGUF)`,
        source: v.draftRepo ?? model.hfRepo,
        present: draftPathFor(model, m) !== undefined,
      });
    }
  }
  if (isMlxSupported()) {
    const twin = mlxRepoFor(model);
    if (twin !== undefined && !isMlxEntry) {
      out.push({
        kind: 'mlx',
        what: 'MLX weights',
        source: twin,
        present: (await storedRepoDir(twin)) !== undefined,
      });
    }
    for (const d of model.mlxDrafts ?? []) {
      out.push({
        kind: `mlx-${d.method}`,
        what:
          d.method === 'mtp'
            ? 'MTP head (MLX)'
            : `${d.method === 'dflash' ? 'DFlash' : d.method === 'dspark' ? 'DSpark' : d.method} drafter (MLX)`,
        source: d.repo,
        present: (await storedRepoDir(d.repo)) !== undefined,
      });
    }
  }
  /*
   * RAPID-MLX'S EYES. With Vision on, rapid-mlx reads an image only through
   * its vision runtime (engine-paths `rapidVisionVenvRoot`), and without it a
   * vision launch goes to llama.cpp instead (vision-launch.ts). Listed here so
   * "Fetch missing" offers it; `engine:` kinds are INSTALLED, not downloaded.
   */
  if (loadVision && isMlxSupported() && engineInstalled('rapid-mlx')) {
    const twinDir = await mlxDirFor(model);
    if (twinDir !== undefined && mlxTwinHasVision(twinDir)) {
      out.push({
        kind: 'engine:rapid-mlx-vision',
        what: 'rapid-mlx vision runtime',
        source: 'rapid-mlx[vision]',
        present: rapidVisionReady(),
      });
    }
  }
  void quant;
  return out;
}

/** The model's MLX twin repo: its own repo for an MLX entry, the catalogued twin otherwise. */
function mlxRepoFor(model: CatalogModel): string | undefined {
  return modelEngine(model) === 'mlx' ? model.hfRepo : model.mlxRepo;
}

/**
 * A repo's directory in the model store, only when the download FINISHED —
 * the manifest is written `incomplete` first and rewritten clean at the end,
 * so a half-fetched tree never looks like weights.
 */
async function storedRepoDir(repo: string): Promise<string | undefined> {
  const dir = entryDir('text', repo);
  const manifest = await readManifest(dir).catch(() => undefined);
  if (manifest === undefined || manifest.incomplete === true) return undefined;
  return dir;
}

async function mlxDirFor(model: CatalogModel): Promise<string | undefined> {
  const repo = mlxRepoFor(model);
  return repo === undefined ? undefined : storedRepoDir(repo);
}

async function mlxDraftDirFor(
  model: CatalogModel,
  method: 'dflash' | 'dspark' | 'mtp',
): Promise<string | undefined> {
  const d = model.mlxDrafts?.find((x) => x.method === method);
  return d === undefined ? undefined : storedRepoDir(d.repo);
}

/**
 * Does the MLX twin itself carry MTP heads? mlx-community conversions
 * usually drop them (`mtp.*` tensors are not part of the trunk) — MEASURED:
 * rapid-mlx refused MTP on Qwen3.5-4B-MLX-8bit, "MTP weights missing from the
 * target checkpoint" — which is why the catalogue names a separate MTP
 * sidecar. A twin that kept them needs none. Read from the safetensors
 * index, never from the model's name.
 */
function mlxTwinHasMtp(dir: string): boolean {
  try {
    const index = JSON.parse(readFileSync(join(dir, 'model.safetensors.index.json'), 'utf8')) as {
      weight_map?: Record<string, string>;
    };
    return Object.keys(index.weight_map ?? {}).some((k) => k.startsWith('mtp.'));
  } catch {
    return false;
  }
}

/**
 * Does the MLX twin carry a VISION TOWER? The evidence rapid-mlx's own lane
 * router reads (`vision_config` plus vision tensors — vision-launch.ts): the
 * qwen3.5-4b 8-bit twin on the user's Mac has 297 `vision_tower.*` tensors, the
 * MTP sidecar none. Read from the index (or a single file's header), never
 * from the repo's name.
 */
function mlxTwinHasVision(dir: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      vision_config?: unknown;
    };
    let names: string[] = [];
    const indexPath = join(dir, 'model.safetensors.index.json');
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
        weight_map?: Record<string, string>;
      };
      names = Object.keys(index.weight_map ?? {});
    } else {
      const single = join(dir, 'model.safetensors');
      if (existsSync(single)) {
        /* THE HEADER ONLY: a u64 length, then that much JSON. This read the
           whole file — up to 2 GiB on this process's event loop at every start
           and every menu open — and over 2 GiB readFileSync throws
           (ERR_FS_FILE_TOO_LARGE), which read as "no vision tower". */
        const fd = openSync(single, 'r');
        try {
          const len = Buffer.alloc(8);
          readSync(fd, len, 0, 8, 0);
          const n = Number(len.readBigUInt64LE(0));
          // The format caps its header at 100 MB; anything larger is not one.
          if (n > 100_000_000) return false;
          const buf = Buffer.alloc(n);
          if (readSync(fd, buf, 0, n, 8) !== n) return false;
          const header = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
          names = Object.keys(header).filter((k) => k !== '__metadata__');
        } finally {
          closeSync(fd);
        }
      }
    }
    return mlxWeightsHaveVision(config, names);
  } catch {
    return false;
  }
}

/**
 * Which lane a rapid-mlx server is ACTUALLY serving. It says so in `/v1/models`
 * (`serving_lane: "vision" | "text"`, with the reason) — the one answer that
 * cannot drift from what the launch meant to do.
 */
async function rapidServingLane(baseUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/v1/models`, {
      signal: AbortSignal.timeout(4000),
    });
    const body = (await res.json()) as { data?: Array<{ serving_lane?: unknown }> };
    const lane = body.data?.[0]?.serving_lane;
    return typeof lane === 'string' ? lane : undefined;
  } catch {
    return undefined;
  }
}

/** The hub cache the engines are given (see startExternalEngine's env). */
function engineHfHome(): string {
  const dir = join(cacheRoot(), 'hf');
  mkdirSync(join(dir, 'hub'), { recursive: true });
  return dir;
}

// ── calibration records ──────────────────────────────────────────────────────

function recordPath(modelId: string, quant: string): string {
  const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(calibrationDir(), `${safe(modelId)}--${safe(quant)}.json`);
}

let hardwareKeyCache: string | null = null;
function currentHardwareKey(): string | null {
  return hardwareKeyCache;
}
async function ensureHardwareKey(): Promise<string> {
  if (hardwareKeyCache === null) {
    const hw = await getHardware();
    hardwareKeyCache = hardwareKey({
      platform: process.platform,
      arch: process.arch,
      chip: hw.chip,
      totalRamGB: hw.totalRamGB,
    });
  }
  return hardwareKeyCache;
}

/**
 * The stored verdict for a model, when it was taken on THIS machine with THIS
 * llama.cpp build. A record from another Mac, or from before a pin bump, is
 * not wrong so much as unknown — it is left on disk and ignored.
 */
function readRecord(modelId: string, quant: string): CalibrationRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordPath(modelId, quant), 'utf8')) as CalibrationRecord;
    if (raw.chosen === undefined || raw.ranked === undefined) return null;
    const hwKey = currentHardwareKey();
    if (hwKey !== null && raw.hardwareKey !== hwKey) return null;
    if (raw.engineBuild !== PINNED_LLAMACPP.tag) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeRecord(record: CalibrationRecord): void {
  mkdirSync(calibrationDir(), { recursive: true });
  writeFileSync(recordPath(record.modelId, record.quant), JSON.stringify(record, null, 2));
}

/** The record as the renderer draws it (engine/spec split out of each id). */
function recordDto(record: CalibrationRecord): LlmCalibrationRecord {
  const split = (id: string) => {
    const p = profileOf(id);
    return { engine: p?.engine ?? id, spec: p?.spec ?? '' };
  };
  return {
    modelId: record.modelId,
    quant: record.quant,
    hardwareKey: record.hardwareKey,
    engineBuild: record.engineBuild,
    at: record.at,
    ranked: record.ranked.map((r) => ({
      id: r.id,
      ...split(r.id),
      ok: r.ok,
      ...(r.error !== undefined ? { error: r.error } : {}),
      prefillTps: r.prefillTps,
      decodeTps: r.decodeTps,
      ttftMs: r.ttftMs,
      startupMs: r.startupMs,
      score: r.score,
    })),
    skips: record.skips.map((k) => ({
      id: k.id,
      engine: k.engine,
      spec: k.spec,
      reason: k.reason,
    })),
    chosen: record.chosen,
  };
}

// ── the other engines ────────────────────────────────────────────────────────

/**
 * Bring the model up on one of the OpenAI-compatible engines (rapid-mlx,
 * dflash-mlx, mlx-dspark, oMLX, mlx-lm; vLLM on Linux) from LOCAL weights.
 *
 * Nothing here reaches the network: the engines are told the store directory
 * and run with the hub offline, so a launch either has its files or says which
 * one is missing. The server registers under the `mlx` provider block — every
 * one of these speaks the same SSE shape provider-mlx already parses, and
 * throughput is timed client-side there because none of them emit llama.cpp's
 * `timings`.
 */
async function startExternalEngine(
  model: CatalogModel,
  file: CatalogFile,
  profile: LaunchProfile,
  force = false,
  /** From the vision plan: serve rapid-mlx's vision lane, or why this launch is blind. */
  visionOpts: { vision?: boolean; blindReason?: BlindReason } = {},
): Promise<{ success: boolean; baseUrl?: string; error?: string }> {
  const engine = profile.engine as VenvEngine;
  /* rapid-mlx's vision lane runs from its OWN runtime (engine-paths
     `rapidVisionVenvRoot`): mlx-vlm 0.6.17 + torch, which the shared venv
     cannot hold beside oMLX's pin. Same rapid-mlx, other venv. */
  const laneVision = engine === 'rapid-mlx' && visionOpts.vision === true;
  const command = laneVision ? rapidVisionCommand() : engineCommand(engine);
  const venvBin = laneVision ? join(rapidVisionVenvRoot(), 'bin') : join(mlxVenvRoot(), 'bin');
  if (engine !== 'vllm' && !isMlxSupported()) {
    return { success: false, error: `${engine} needs Apple Silicon` };
  }
  if (!engineInstalled(engine)) return { success: false, error: `${engine} is not installed` };
  const modelDirPath = await mlxDirFor(model);
  if (modelDirPath === undefined) {
    return { success: false, error: 'MLX weights are not downloaded for this model' };
  }
  const draftMethod =
    profile.spec === 'dflash' || profile.spec === 'dspark' || profile.spec === 'mtp'
      ? profile.spec
      : undefined;
  const draftDir = draftMethod === undefined ? undefined : await mlxDraftDirFor(model, draftMethod);
  // MTP is the one method that may need no file: a twin that kept its heads.
  if (draftMethod !== undefined && draftDir === undefined) {
    if (draftMethod !== 'mtp' || !mlxTwinHasMtp(modelDirPath)) {
      return {
        success: false,
        error: `no ${draftMethod === 'mtp' ? 'MTP head' : `${draftMethod} drafter`} is downloaded for this model`,
      };
    }
  }
  if (
    !force &&
    current !== null &&
    current.model.id === model.id &&
    current.file.quant === file.quant &&
    sameProfile(current.profile, profile) &&
    current.launchConfigFingerprint === launchFingerprint(engine, model.id) &&
    current.launchCommand === command
  ) {
    return { success: true, baseUrl: current.baseUrl };
  }

  beginLoading(model);
  phase = 'starting';
  lastError = undefined;
  metrics = null;
  emitStatus();
  try {
    if (current !== null) {
      await current.supervisor.dispose();
      current = null;
    }
    /*
     * ONE ID PER ENGINE. The llama.cpp block registers the model under the
     * catalogue id; if the `mlx` block did too, pi would hold two models with
     * one id and `set_model('mlx', id)` could land on the llama.cpp one — the
     * server that had just been stopped. MEASURED: a reply that never arrived
     * after a swap to rapid-mlx. The served name carries the engine, so the
     * two can never be confused (and the menu can say which one pi is on).
     */
    const servedName = `${model.id}@${engine}`;
    /* oMLX serves a directory of models named by subdirectory: give it one
       with a link to the weights, named after the served name. */
    if (engine === 'omlx') {
      mkdirSync(omlxModelRoot(), { recursive: true });
      const link = join(omlxModelRoot(), servedName);
      try {
        // `force` covers a link that is already gone; `existsSync` would not
        // see a DANGLING one (it follows links), and the symlink would then
        // fail with EEXIST — the state every old link is in once the weights
        // have moved to the library.
        rmSync(link, { recursive: false, force: true });
        symlinkSync(modelDirPath, link, 'dir');
      } catch (error) {
        return { success: false, error: `could not link weights for oMLX: ${String(error)}` };
      }
    }
    const hw = await getHardware();
    const contextWindow = chooseContextCap({
      modelBytes: file.bytes,
      modelMaxContext: model.contextWindow,
      totalRamGB: hw.totalRamGB,
    });
    // The MLX engines render from the model directory: give its template the
    // preserved-thinking gate (idempotent) so the history renders the bytes it
    // was generated as and the engine's prefix cache holds across turns.
    const pinnedEffort = model.chatTemplateKwargs?.reasoning_effort;
    if (
      await patchModelDirTemplate(
        modelDirPath,
        typeof pinnedEffort === 'string' ? { reasoningEffort: pinnedEffort } : {},
      ).catch(() => false)
    ) {
      console.log(
        `[chat-template] ${model.id}: patched the MLX twin's template for preserved thinking`,
      );
    }
    const host = '127.0.0.1';
    let servedModelId = servedName;
    const supervisor = new LlamaServerSupervisor({
      serverPath: command,
      modelPath: modelDirPath,
      launchMode: 'fast-text',
      host,
      healthPath: '/v1/models',
      // Loading multi-GB weights into unified memory, plus a drafter, plus
      // whatever graph compile the engine does on first request.
      healthTimeoutMs: 300_000,
      maxRestarts: 0,
      buildArgsFn: (port) => {
        const launch = assembleEngineLaunch(profile, {
          command,
          modelDir: modelDirPath,
          servedModelId: servedName,
          host,
          port,
          ...(draftDir !== undefined ? { draftDir } : {}),
          modelRoot: omlxModelRoot(),
          ...(laneVision ? { vision: true } : {}),
        });
        servedModelId = launch.servedModelId;
        return [...launch.args, ...userArgsFor(engine)];
      },
      env: {
        ...process.env,
        PATH: `${venvBin}:${process.env.PATH ?? ''}`,
        // The whole point: a launch that would fetch from the hub fails
        // instead, with the hub's own message.
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        TOKENIZERS_PARALLELISM: 'false',
        /* rapid-mlx writes "[truncated — reasoning incomplete; raise
           max_tokens]" plus a tail of the thought INTO the reply when a
           generation is cut mid-think (its R12-8 "rescue"). the user saw it as a
           thought in the thread. The cut is already said by finish_reason
           "length"; the words are not for the user. */
        RAPID_MLX_REASONING_CUTOFF_NOTICE: 'disabled',
        /* THE TOOL-CALL LOOP. rapid-mlx constrains tool calls by default
           (llguidance, `RAPID_MLX_CONSTRAIN_TOOLS`) to the wire of the parser
           it auto-picks — `hermes`, the JSON form `{"name": …, "arguments":
           {…}}` — while the official Qwen3.5 template it renders tells the
           model to write `<function=NAME><parameter=X>…`. The mask and the
           model disagree from the first argument on. MEASURED 2026-09-13
           (Qwen3.5-4B 8-bit, the same request replayed ten times): with the
           constraint 6/10 replies degenerated into a whitespace loop inside
           `{"command"` until rapid-mlx's repetition guard cut them at ~1100
           tokens with finish_reason=length — the buffered `<tool_call>`
           fragment then flushed into the reply as text (the user's "tool
           leaking") and the turn ended with nothing said ("thought ending
           whole turns"); another came back as `>@|@|@|…`. Without it: 10/10
           clean (seven tool calls, three answers). The free-form parser
           reads both forms. llama.cpp's own grammar is lazy and follows the
           template's format, which is why it never showed this. */
        RAPID_MLX_CONSTRAIN_TOOLS: '0',
        /* A hub cache of our own. mlx_lm.server's `/v1/models` scans the HF
           cache and throws when the directory does not exist — MEASURED under
           a fresh HOME — so give every engine one that does, under the app's
           root rather than the user's. */
        HF_HOME: engineHfHome(),
      },
    });
    supervisor.on((event) => {
      if (event.type === 'log' && event.stream === 'stderr') {
        const tail = event.text.trim().split('\n').slice(-1)[0] ?? '';
        if (tail.length > 0) {
          console.log(`[${engine}] ${tail.slice(0, 300)}`);
          // The engine's own last words, for a bench failure to quote.
          if (/error|exception|failed|traceback/i.test(tail))
            lastEngineComplaint = tail.slice(0, 200);
        }
      } else if (event.type === 'exit' && event.reason === 'failed') {
        phase = 'error';
        lastError = event.detail ?? `${engine} failed`;
        current = null;
        emitStatus();
      }
    });
    const started = await startTracked(supervisor);
    const baseUrl = supervisor.baseUrl;
    /* WHAT IT ACTUALLY SERVES, from its own mouth: rapid-mlx names its lane in
       /v1/models. Only the vision lane can read an image; everything else on
       this path is text-only. */
    const lane = laneVision ? await rapidServingLane(baseUrl) : undefined;
    const sees = lane === 'vision';
    current = {
      supervisor,
      model,
      file,
      contextWindow,
      baseUrl,
      launchMode: 'fast-text',
      visionReady: sees,
      ...(sees
        ? {}
        : {
            blindReason:
              visionOpts.blindReason ??
              (laneVision || loadVision ? ('engine' as const) : ('off' as const)),
          }),
      profile,
      provider: 'mlx',
      servedModelId,
      launchCommand: command,
      launchArgs: supervisor.argv(),
      launchConfigFingerprint: launchFingerprint(engine, model.id),
    };
    phase = 'ready';
    console.log(
      `[engine] ${model.id} up on ${engine} · ${profile.spec} (${baseUrl}) as ${servedModelId}`,
    );
    await writeModelsJson(
      MODELS_JSON,
      MLX_PROVIDER_NAME,
      buildMlxProviderBlock(model, { baseUrl, servedModelId }),
    );
    emitStatus();
    return { success: true, baseUrl: started.baseUrl };
  } catch (error) {
    phase = 'error';
    lastError = String(error instanceof Error ? error.message : error);
    current = null;
    emitStatus();
    return { success: false, error: lastError };
  }
}

// ── calibration ──────────────────────────────────────────────────────────────

let calibration: { abort: AbortController; modelId: string } | null = null;
/** The last error-looking line an external engine printed (see startExternalEngine). */
let lastEngineComplaint: string | null = null;

function postCalibration(progress: LlmCalibrationProgress): void {
  post({ kind: 'calibration', progress });
}

/** A result without its raw samples — what the menu draws per row. */
function resultDto(
  r: CalibrationResult,
): Extract<LlmCalibrationProgress, { stage: 'result' }>['result'] {
  return {
    id: r.id,
    ok: r.ok,
    ...(r.error !== undefined ? { error: r.error } : {}),
    prefillTps: r.prefillTps,
    decodeTps: r.decodeTps,
    ttftMs: r.ttftMs,
    startupMs: r.startupMs,
  };
}

/**
 * One timed request against the running server. Streams so the first token's
 * arrival is observable; llama.cpp's own `timings` are used when present
 * (measured inside the server), wall-clock otherwise.
 */
async function timedRequest(
  baseUrl: string,
  servedModelId: string,
  prompt: { system: string; user: string; maxTokens: number },
  nonce: string,
  signal: AbortSignal,
): Promise<ReturnType<typeof sampleFromTimings>> {
  const body = {
    model: servedModelId,
    messages: [
      // The nonce defeats every engine's prefix cache, so prefill is real.
      { role: 'system', content: `${prompt.system}\n(session ${nonce})` },
      { role: 'user', content: prompt.user },
    ],
    max_tokens: prompt.maxTokens,
    /*
     * THE APP'S OWN SAMPLING, not greedy. Speculative decoding accepts more
     * drafts at temperature 0 than under the temperature 0.8 / top-p 0.9 a
     * chat actually runs with (supervisor.ts server defaults), so a greedy
     * bench flatters every drafted method. Sent explicitly so every engine
     * samples the same way whatever its own defaults are.
     */
    temperature: 0.8,
    top_p: 0.9,
    stream: true,
    stream_options: { include_usage: true },
    // llama.cpp: no prefix reuse, so prefill is measured every time.
    cache_prompt: false,
    /*
     * THINKING OFF, everywhere. A thinking model spends the whole 96-token
     * budget inside <think>, and the engines disagree about what to stream
     * for it: llama.cpp and rapid-mlx send `reasoning_content` deltas (and
     * rapid-mlx switches thinking off by itself for a casual request),
     * mlx_lm.server holds the block back until it closes — MEASURED as "no
     * tokens came back" on a request that had generated 16 of them. One
     * setting on every engine is what makes the rows comparable; the switch
     * is honoured by the Qwen / Gemma templates and ignored elsewhere.
     */
    chat_template_kwargs: { enable_thinking: false },
  };
  const sentAt = Date.now();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  let firstTokenAt: number | undefined;
  let lastTokenAt = sentAt;
  let chunks = 0;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let timings: Parameters<typeof sampleFromServerTimings>[0] | undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: {
        choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        timings?: Parameters<typeof sampleFromServerTimings>[0];
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      const text = `${delta?.content ?? ''}${delta?.reasoning_content ?? ''}`;
      if (text.length > 0) {
        const now = Date.now();
        firstTokenAt ??= now;
        lastTokenAt = now;
        chunks += 1;
      }
      if (chunk.usage != null) usage = chunk.usage;
      if (chunk.timings !== undefined) timings = chunk.timings;
    }
  }
  const fromServer = timings === undefined ? null : sampleFromServerTimings(timings);
  if (fromServer !== null) return fromServer;
  if (firstTokenAt === undefined) {
    throw new Error(
      usage?.completion_tokens !== undefined && usage.completion_tokens > 0
        ? `generated ${usage.completion_tokens} tokens but streamed none of them`
        : 'no tokens came back',
    );
  }
  const completionTokens = usage?.completion_tokens ?? chunks;
  const promptTokens =
    usage?.prompt_tokens ??
    // No usage from this engine: a rough count so the row is not empty.
    Math.round((prompt.system.length + prompt.user.length) / 3.8);
  return sampleFromTimings({ sentAt, firstTokenAt, lastTokenAt, promptTokens, completionTokens });
}

/** Warm the server once (graph compile, first-request paths), then measure. */
async function benchServer(
  baseUrl: string,
  servedModelId: string,
  signal: AbortSignal,
): Promise<CalibrationResult['samples']> {
  const prompts = benchPrompts();
  const nonce = () => Math.random().toString(16).slice(2, 10);
  const warm = prompts[0];
  if (warm !== undefined) {
    // Graph compile, lazy loads, first-request paths. Its outcome is not a
    // measurement, so a warm-up that streams nothing is not a failure either.
    await timedRequest(baseUrl, servedModelId, { ...warm, maxTokens: 24 }, nonce(), signal).catch(
      () => undefined,
    );
  }
  const samples: ReturnType<typeof sampleFromTimings>[] = [];
  for (let rep = 0; rep < 2; rep++) {
    for (const p of prompts) {
      if (signal.aborted) throw new Error('cancelled');
      samples.push(await timedRequest(baseUrl, servedModelId, p, nonce(), signal));
    }
  }
  return samples;
}

/**
 * CALIBRATE: try every (engine, method) that can run this model from what is
 * on disk, in turn, timing the app's own prompt shapes on each; keep the
 * verdict; come back up on the winner. the user: "clicking calibrate pauses
 * anything running in the current chat, then runs the calibration and swaps to
 * the proper engine and speculative method, ensure this doesn't require
 * internet to run the calibration".
 *
 * The chat's pause is the renderer's (it owns the turn); this owns the
 * servers. Every step is posted as it happens so the menu can show a row
 * filling in, and a cancel puts the previous launch back.
 */
/**
 * What the planner needs, read from the disk as it is right now: which files
 * and twins are here, which engines are installed, what llama.cpp can do — and
 * what the catalogue NAMES for this model, so a skip can say "a download away"
 * or "nothing published" instead of a bare "not on disk".
 */
async function calibrationInputFor(
  model: CatalogModel,
  file: CatalogFile,
  installableEngines: readonly string[] = [],
): Promise<{ input: CalibrationInput; specTypes: readonly string[] }> {
  const hw = await getHardware();
  const gguf = modelEngine(model) !== 'mlx' && existsSync(modelPathFor(model, file));
  let specTypes: readonly string[] = [];
  let mtpSupported = false;
  if (gguf) {
    const install = await ensureEngineFor(model, { execFileImpl: execFileAsync });
    const features = await probeServerFeatures(install.serverPath);
    specTypes = features.specTypes;
    mtpSupported = features.mtp;
  }
  const mtpSibling =
    model.mtpFile !== undefined && model.mtpEmbedded !== true
      ? existsSync(join(modelDir(model.id), model.mtpFile.name))
      : false;
  const supportsType = (t: string) => specTypes.includes(t);
  const drafts = draftsOnDisk(model).filter((m) => supportsType(`draft-${m}`));
  const mlxDir = await mlxDirFor(model);
  const mlxDrafts = (
    await Promise.all(
      (['dflash', 'dspark'] as const).map(async (m) =>
        (await mlxDraftDirFor(model, m)) === undefined ? null : m,
      ),
    )
  ).filter((m): m is 'dflash' | 'dspark' => m !== null);
  const mlxMtp =
    mlxDir !== undefined &&
    ((await mlxDraftDirFor(model, 'mtp')) !== undefined || mlxTwinHasMtp(mlxDir));
  const catalogued: NonNullable<CalibrationInput['catalogued']> = {
    drafts: (['eagle3', 'dflash', 'dspark'] as const).filter((m) =>
      model.variants?.some((v) => v.method === m && v.draftModel !== undefined),
    ),
    mlx: mlxRepoFor(model) !== undefined,
    mlxDrafts: (['dflash', 'dspark'] as const).filter((m) =>
      model.mlxDrafts?.some((d) => d.method === m),
    ),
    mlxMtp: model.mlxDrafts?.some((d) => d.method === 'mtp') === true,
  };
  const installed: CalibEngine[] = ['llamacpp', ...installedVenvEngines()];
  const input: CalibrationInput = {
    platform:
      process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'win32',
    appleSilicon: hw.isAppleSilicon,
    installedEngines: installed,
    ggufPresent: gguf,
    mtpAvailable: gguf && mtpSupported && (model.mtpEmbedded === true || mtpSibling),
    draftsPresent: drafts,
    mlxPresent: mlxDir !== undefined,
    mlxDraftsPresent: mlxDrafts,
    mlxMtpAvailable: mlxMtp,
    catalogued,
    installableEngines: installableEngines.filter(
      (e): e is CalibEngine => isCalibEngine(e) && !installed.includes(e),
    ),
  };
  return { input, specTypes };
}

const CALIB_ENGINES: readonly CalibEngine[] = [
  'llamacpp',
  'mlx-lm',
  'rapid-mlx',
  'dflash-mlx',
  'mlx-dspark',
  'omlx',
  'vllm',
];
function isCalibEngine(e: string): e is CalibEngine {
  return (CALIB_ENGINES as readonly string[]).includes(e);
}

/** The live plan for the menu: what a calibration would measure now, and what stands in the way of the rest. */
async function calibrationPlan(
  modelId: string,
  quant: string | undefined,
  installableEngines: readonly string[],
): Promise<{
  candidates: Array<{ id: string; engine: string; spec: string; label: string }>;
  skips: Array<{
    id: string;
    engine: string;
    spec: string;
    label: string;
    reason: string;
    fix: 'fetch' | 'install' | 'none';
  }>;
}> {
  const model = getModel(modelId);
  if (model === undefined) return { candidates: [], skips: [] };
  const file = pickFile(
    model,
    quant ?? (current?.model.id === modelId ? current.file.quant : undefined),
  );
  if (file === undefined) return { candidates: [], skips: [] };
  const { input } = await calibrationInputFor(model, file, installableEngines);
  const { candidates, skips } = planCandidates(input);
  return {
    candidates: candidates.map((c) => ({
      id: c.id,
      engine: c.engine,
      spec: c.spec,
      label: c.label,
    })),
    skips: skips.map((k) => ({
      id: k.id,
      engine: k.engine,
      spec: k.spec,
      label: k.label,
      reason: k.reason,
      fix: k.fix,
    })),
  };
}

async function calibrate(modelId?: string, quant?: string): Promise<LlmCalibrateReply> {
  if (calibration !== null) return { ok: false, error: 'a calibration is already running' };
  const id = modelId ?? current?.model.id;
  if (id === undefined) return { ok: false, error: 'no model is running' };
  const model = getModel(id);
  if (model === undefined) return { ok: false, error: `unknown model: ${id}` };
  const file = pickFile(
    model,
    quant ?? (current?.model.id === id ? current.file.quant : undefined),
  );
  if (file === undefined) return { ok: false, error: `unknown quant for ${id}` };

  const abort = new AbortController();
  calibration = { abort, modelId: model.id };
  const previous = current !== null && current.model.id === model.id ? current.profile : null;
  emitStatus();
  try {
    const hwKey = await ensureHardwareKey();
    const { input } = await calibrationInputFor(model, file);
    const { candidates, skips } = planCandidates(input);
    postCalibration({
      stage: 'planned',
      candidates: candidates.map((c) => ({
        id: c.id,
        engine: c.engine,
        spec: c.spec,
        label: c.label,
      })),
      skips: skips.map((k) => ({
        id: k.id,
        engine: k.engine,
        spec: k.spec,
        label: k.label,
        reason: k.reason,
        fix: k.fix,
      })),
    });
    if (candidates.length === 0) {
      const error = 'nothing to measure: no engine can run this model from disk';
      postCalibration({ stage: 'failed', error });
      return { ok: false, error };
    }

    const results: CalibrationResult[] = [];
    for (const [index, c] of candidates.entries()) {
      if (abort.signal.aborted) break;
      const total = candidates.length;
      postCalibration({ stage: 'starting', id: c.id, index, total });
      const t0 = Date.now();
      lastEngineComplaint = null;
      const started = await startServer(model.id, file.quant, 'fast-text', 1, {
        engine: c.engine,
        spec: c.spec,
      });
      const startupMs = Date.now() - t0;
      let result: CalibrationResult;
      if (!started.success || current === null) {
        result = summarise(c.id, [], startupMs, started.error ?? 'did not start');
      } else {
        postCalibration({ stage: 'measuring', id: c.id, index, total });
        try {
          const samples = await benchServer(current.baseUrl, current.servedModelId, abort.signal);
          result = summarise(c.id, samples, startupMs);
        } catch (error) {
          /* "no tokens came back" says what we saw; the engine's own last
             error line says why — MEASURED: a Metal out-of-memory that the
             stream reported as an empty 200. */
          const seen = String(error instanceof Error ? error.message : error).slice(0, 200);
          result = summarise(
            c.id,
            [],
            startupMs,
            lastEngineComplaint === null ? seen : `${seen} — ${lastEngineComplaint}`,
          );
        }
      }
      console.log(
        `[calibrate] ${c.id}: ${result.ok ? `${result.decodeTps.toFixed(1)} tok/s decode · ${result.prefillTps.toFixed(0)} tok/s prefill · ttft ${result.ttftMs.toFixed(0)} ms` : `failed: ${result.error}`} (up in ${startupMs} ms)`,
      );
      results.push(result);
      postCalibration({ stage: 'result', result: resultDto(result), index, total });
    }
    if (abort.signal.aborted) {
      postCalibration({ stage: 'cancelled' });
      if (previous !== null) await startServer(model.id, file.quant, 'fast-text', 1, previous);
      return { ok: false, error: 'cancelled' };
    }
    const { ranked, chosen } = chooseProfile(results);
    const record: CalibrationRecord = {
      modelId: model.id,
      quant: file.quant,
      hardwareKey: hwKey,
      engineBuild: PINNED_LLAMACPP.tag,
      at: new Date().toISOString(),
      ranked,
      skips,
      chosen: chosen === null ? null : profileOf(chosen.id),
    };
    writeRecord(record);
    const target = record.chosen ?? previous ?? defaultProfile(model);
    postCalibration({ stage: 'switching', chosen: target });
    /* The winner is the VERDICT, not a row anyone clicked: it comes up the way
       every later start of this model will (vision may hand a text-only winner
       to llama.cpp with the projector), not blind until the next launch. */
    const up = await startServer(
      model.id,
      file.quant,
      'fast-text',
      1,
      target,
      false,
      record.chosen === null,
    );
    if (!up.success) {
      const error = `calibrated, but the winner failed to start: ${up.error ?? 'unknown'}`;
      postCalibration({ stage: 'failed', error });
      return { ok: false, error, record: recordDto(record) };
    }
    postCalibration({ stage: 'done', record: recordDto(record) });
    return { ok: true, record: recordDto(record) };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    postCalibration({ stage: 'failed', error: message });
    return { ok: false, error: message };
  } finally {
    calibration = null;
    emitStatus();
  }
}

/**
 * Every GGUF the app has on disk, labelled with the model it belongs to and
 * what it is (weights, projector, MTP head, draft) — the custom-draft picker's
 * "downloaded models" list.
 */
function listLocalGgufs(): Array<{
  path: string;
  name: string;
  bytes: number;
  modelId: string;
  kind: string;
}> {
  const out: Array<{ path: string; name: string; bytes: number; modelId: string; kind: string }> =
    [];
  for (const model of allModels()) {
    const dir = modelDir(model.id);
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.gguf'));
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      let bytes = 0;
      try {
        bytes = statSync(full).size;
      } catch {
        continue;
      }
      const lower = name.toLowerCase();
      const kind = lower.startsWith('mmproj')
        ? 'projector'
        : lower.startsWith('mtp-')
          ? 'MTP head'
          : /dflash|dspark|eagle|draft/.test(lower)
            ? 'draft'
            : 'weights';
      out.push({ path: full, name, bytes, modelId: model.id, kind });
    }
  }
  return out;
}

/** Apply: the same model, mode and profile, launched again with the current flags. */
async function relaunch(): Promise<{ success: boolean; error?: string }> {
  /* A load still in flight (the Vision switch flipped mid-load) has not set
     `current` yet, and captured the old flags: wait for it to land, then
     relaunch what landed. */
  await startInFlight;
  if (current === null) return { success: false, error: 'no model is running' };
  const c = current;
  /* A MULTIMODAL launch exists to see (ensureVisionMode's relaunch). Vision
     switched off since: relaunched multimodal it would force llama.cpp and
     re-attach the projector behind the switch — and keep reading images with
     the switch saying Off. It comes back as the text launch instead. */
  const mode = c.launchMode === 'multimodal' && !loadVision ? 'fast-text' : c.launchMode;
  const res = await startServer(c.model.id, c.file.quant, mode, 1, undefined, true);
  return { success: res.success, ...(res.error !== undefined ? { error: res.error } : {}) };
}

/** Parsed `--help` per engine, read once per process. */
const engineFlagsCache = new Map<string, EngineFlagsReply>();

/**
 * Every flag an engine accepts, from the engine's own `--help`. llama.cpp is
 * the pinned binary's help (fetched if the binary is not here yet); the MLX
 * engines are their venv CLIs' argparse help.
 */
async function engineFlags(engine: string): Promise<EngineFlagsReply> {
  const cached = engineFlagsCache.get(engine);
  if (cached !== undefined) return cached;
  const helpOf = async (cmd: string, args: string[]): Promise<string> => {
    const r = await execFileAsync(cmd, args, {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    }).catch((e: { stdout?: string; stderr?: string }) => ({
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }));
    return `${r.stdout}\n${r.stderr}`;
  };
  try {
    let reply: EngineFlagsReply;
    if (engine === 'llamacpp') {
      const install = await ensureEngineFor(
        { displayName: 'llama.cpp' },
        { execFileImpl: execFileAsync },
      );
      reply = {
        engine,
        command: install.serverPath,
        flags: parseLlamaHelp(await helpOf(install.serverPath, ['--help'])),
      };
    } else {
      const venv = engine as VenvEngine;
      if (!engineInstalled(venv)) {
        return { engine, command: '', flags: [], error: `${engine} is not installed` };
      }
      const cmd = engineCommand(venv);
      const args = engine === 'mlx-lm' ? ['--help'] : ['serve', '--help'];
      reply = {
        engine,
        command: engine === 'mlx-lm' ? cmd : `${cmd} serve`,
        flags: parseArgparseHelp(await helpOf(cmd, args)),
      };
    }
    if (reply.flags.length > 0) engineFlagsCache.set(engine, reply);
    return reply;
  } catch (error) {
    return {
      engine,
      command: '',
      flags: [],
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

function cancelCalibration(): { ok: boolean } {
  if (calibration === null) return { ok: false };
  calibration.abort.abort();
  return { ok: true };
}

/** Relaunch the running model on a profile the user picked from the menu. */
async function applyProfile(profile: LaunchProfile): Promise<{ success: boolean; error?: string }> {
  const valid = profileOf(`${profile.engine}/${profile.spec}`);
  if (valid === null) return { success: false, error: 'unknown engine or method' };
  if (current === null) return { success: false, error: 'no model is running' };
  const res = await startServer(current.model.id, current.file.quant, 'fast-text', 1, valid);
  return { success: res.success, ...(res.error !== undefined ? { error: res.error } : {}) };
}

/*
 * ONE START AT A TIME.
 *
 * `startServer` disposes the running server before spawning the next — but it is
 * async and had no serialisation, so two concurrent callers both observed
 * `current === null`, both disposed nothing, and both spawned. MEASURED on a
 * 24GB Mac picking the Intelligent tier: two llama-servers came up 2s apart
 * (ports 60860 and 60828) BOTH holding the same ~16GB Qwen3.6-27B. The machine
 * went to swap, pi died at startup and retried with no extensions at all, the
 * turn never completed, and the user's whole desktop stuttered — "purple flashes ...
 * checkerboarding".
 *
 * Serialising is the actual fix: a second start now waits for the first to
 * settle, then runs against a known state (and usually finds its model already
 * resident, so it is a no-op).
 */
let startInFlight: Promise<{ success: boolean; baseUrl?: string; error?: string }> | null = null;

function startServer(
  modelId: string,
  quant?: string,
  launchMode: LaunchMode = 'fast-text',
  parallel?: number,
  profile?: LaunchProfile,
  force = false,
  /** `profile` is honoured as asked (planVisionEngine `explicit`); false = a verdict vision may move. */
  explicit = profile !== undefined,
): Promise<{ success: boolean; baseUrl?: string; error?: string }> {
  const run = (startInFlight ?? Promise.resolve()).then(() =>
    startServerExclusive(modelId, quant, launchMode, parallel, profile, force, explicit),
  );
  // Keep the chain alive even when a start fails, so one failure cannot wedge
  // every later start behind a rejected promise.
  startInFlight = run.catch(() => ({ success: false }));
  return run;
}

async function startServerExclusive(
  modelId: string,
  quant?: string,
  launchMode: LaunchMode = 'fast-text',
  parallel?: number,
  requestedProfile?: LaunchProfile,
  force = false,
  explicit = requestedProfile !== undefined,
): Promise<{ success: boolean; baseUrl?: string; error?: string }> {
  const model = getModel(modelId);
  if (model === undefined) return { success: false, error: `unknown model: ${modelId}` };
  const file = pickFile(model, quant);
  if (file === undefined) return { success: false, error: `unknown quant for ${modelId}` };
  /*
   * WHICH ENGINE, WHICH METHOD. An explicit ask (a calibration step, a row the
   * user clicked) wins; otherwise the calibrated verdict for this model on this
   * machine; otherwise llama.cpp with the model's declared method — the launch
   * exactly as it was before calibration existed. A vision launch is llama.cpp
   * whatever was chosen: none of the other engines takes a projector.
   */
  await ensureHardwareKey();
  const calibrated =
    requestedProfile === undefined ? readRecord(model.id, file.quant)?.chosen : null;
  /* The user's own speculative choice for this model (Settings → Advanced →
     Speculative) outranks the calibrated verdict: the verdict is what we
     measured, the choice is what they asked for. */
  const chosen = requestedProfile ?? userProfileFor(model) ?? calibrated ?? defaultProfile(model);
  const wished: LaunchProfile =
    launchMode === 'multimodal'
      ? {
          engine: 'llamacpp',
          spec: chosen.spec,
          ...(chosen.custom !== undefined ? { custom: chosen.custom } : {}),
        }
      : chosen;
  /*
   * VISION DECIDES THE ENGINE (vision-launch.ts). the user: "mmproj/vision should
   * always be loaded and usable by default unless explicitly turned off". The
   * wished profile is what calibration measured or the user picked; this is
   * where it meets the setting — rapid-mlx is asked for its vision lane (no
   * MTP there), and an engine that cannot see hands a calibrated launch to
   * llama.cpp with the projector, saying so, rather than coming up blind.
   */
  const visionWanted = launchMode === 'multimodal' || loadVision;
  const twinDir =
    wished.engine !== 'llamacpp' && modelEngine(model) !== 'mlx' && isMlxSupported()
      ? await mlxDirFor(model)
      : undefined;
  const plan =
    modelEngine(model) === 'mlx'
      ? null
      : planVisionEngine(
          {
            profile: wished,
            visionWanted,
            explicit,
            modelHasProjector: model.mmproj !== undefined,
            /* A GGUF llama.cpp can TAKE: a sharded model is refused below (its
               shards are never joined), so handing it a vision fallback would
               stop a model its calibrated MLX engine runs fine. */
            ggufOnDisk: model.sharded !== true && existsSync(modelPathFor(model, file)),
            mlxTwinHasVision: twinDir !== undefined && mlxTwinHasVision(twinDir),
            rapidVisionReady: rapidVisionReady(),
          },
          defaultProfile(model).spec,
        );
  const profile: LaunchProfile = plan?.profile ?? wished;
  const visionFallback =
    plan?.fallback !== undefined ? { from: plan.fallback.from, why: plan.fallback.why } : undefined;
  if (visionFallback !== undefined) {
    console.log(
      `[engine] vision: ${visionFallback.from} → llama.cpp for ${model.id} (${visionFallback.why})`,
    );
  }
  if (profile.engine !== 'llamacpp' && modelEngine(model) !== 'mlx') {
    const external = await startExternalEngine(model, file, profile, force, {
      vision: plan?.vision === 'lane',
      ...(plan?.blindReason !== undefined ? { blindReason: plan.blindReason } : {}),
    });
    /*
     * A VERDICT THAT CAN NO LONGER BE HONOURED must not stop the model. The
     * calibrated engine may have been uninstalled or its weights deleted since
     * the measurement; an implicit launch falls back to llama.cpp and says so,
     * and only an explicit ask (a row the user clicked) reports the failure.
     */
    if (external.success || requestedProfile !== undefined) return external;
    console.log(
      `[engine] calibrated ${profile.engine}/${profile.spec} for ${model.id} cannot start (${external.error ?? 'unknown'}); falling back to llama.cpp`,
    );
    return startServerExclusive(modelId, quant, launchMode, parallel, defaultProfile(model));
  }

  /*
   * A MULTI-SHARD MODEL CANNOT START, so say so instead of trying.
   *
   * `sharded` marks entries whose quants are split across several files. The
   * shard-join on download and launch is a follow-up that has not happened, and
   * until it does the failure is silent and confusing: one shard downloads,
   * `isDownloaded` sees a file and returns true, the fit guard cannot weigh it
   * (a sharded entry carries `bytes: 0`, and the guard passes unknown sizes on
   * purpose — a guard that guesses refuses things that would have worked), and
   * an 80 GB model launches on a 24 GB Mac and dies inside llama-server on the
   * shards that were never fetched.
   *
   * The flag's only other reader is a display string. This is the first time it
   * is allowed to decide anything.
   */
  if (model.sharded === true) {
    return {
      success: false,
      error:
        `${model.displayName} is published in multiple shards, and joining them is not ` +
        'implemented yet — only the first shard would download, and the server would fail ' +
        'on the rest. Choose a single-file quant of this model, or a different model.',
    };
  }

  // MLX engine → the mlx_lm.server path (its artifact is not a local GGUF).
  if (modelEngine(model) === 'mlx') {
    const res = await startMlxServer(model, file);
    if (res.success && current !== null) {
      // mlx_lm.server takes no images; say which of the three reasons it is.
      current.blindReason = !model.input.includes('image')
        ? 'model'
        : loadVision
          ? 'engine'
          : 'off';
      emitStatus();
    }
    return res;
  }

  const modelPath = modelPathFor(model, file);
  if (!existsSync(modelPath)) return { success: false, error: 'model not downloaded' };

  /*
   * ALREADY RESIDENT → REUSE IT. Restarting a server onto the model it is
   * already running costs a full unload/reload of tens of gigabytes for no
   * change. With starts now serialised, the common case of two callers racing
   * for the same model resolves here: the first starts it, the second finds it
   * up and returns the same endpoint.
   */
  if (
    !force &&
    current !== null &&
    current.model.id === model.id &&
    current.file.quant === file.quant &&
    current.launchMode === launchMode &&
    sameProfile(current.profile, profile) &&
    current.launchConfigFingerprint === launchFingerprint('llamacpp', model.id) &&
    // Vision switched on or off since: the projector is a launch argument —
    // for a model that has one. A text-only model launches the same either way
    // (its blindReason is 'model', never 'off'), so the switch changes nothing.
    (model.mmproj === undefined || (current.blindReason === 'off') === !visionWanted)
  ) {
    return { success: true, baseUrl: current.baseUrl };
  }

  /*
   * WILL IT EVEN FIT? A model whose weights exceed what this machine can hold
   * does not fail cleanly — it swaps, and the whole desktop goes with it. the user,
   * watching a 27B come up on a 24GB Mac: "whole computer now has lots of lag
   * and purple flashes ... stuttering of mouse cursor ... checkerboardings."
   *
   * Refusing with a readable reason is strictly better than delivering that. The
   * budget mirrors the corp's (75% of physical RAM, 2GiB held back for the OS)
   * so the two do not disagree about what this box can take.
   */
  const fit = modelFitsInRam(file.bytes, totalmem());
  if (!fit.ok) {
    phase = 'error';
    lastError = fit.reason;
    emitStatus();
    return { success: false, error: fit.reason };
  }

  beginLoading(model);
  phase = 'starting';
  lastError = undefined;
  metrics = null;
  emitStatus();

  // VISION IS ALWAYS ON when the model ships a projector. It used to be lazy —
  // resolved only for an explicit multimodal launch — so the default server came
  // up blind and anything wanting to look at something had to force a relaunch
  // first. Measured cost of loading it eagerly on qwen3.5-4b-mtp: 43.42 tok/s
  // with the projector against 43.80 without (0.9%, inside the noise) for
  // 641 MB. That is not worth a capability gap. the user: "all models are
  // multimodal here and the mmproj should always be loaded because all tasks
  // should be able to have vision."
  //
  // What remains asymmetric is FAILURE, not loading. An explicit vision launch
  // with no projector is a hard error — coming up blind while the app reports
  // vision is on is the bug that had a model spend five turns trying to read a
  // screenshot it was never going to see. On a default launch the same
  // situation only means this model cannot see, and text must still work.
  /* …UNLESS VISION IS OFF. The user's switch (engine menu → Vision) is the one
     thing that keeps a projector off a launch; an explicit multimodal launch
     still wants it whatever the switch says. */
  const mmprojFile = visionWanted ? mmprojFileFor(model, launchMode) : undefined;
  let mmprojPath: string | undefined;
  if (mmprojFile === undefined) {
    if (launchMode === 'multimodal') {
      phase = 'error';
      lastError = `${model.displayName} has no vision projector`;
      emitStatus();
      return { success: false, error: lastError };
    }
  } else {
    const candidate = join(modelDir(model.id), mmprojFile.name);
    if (existsSync(candidate)) {
      mmprojPath = candidate;
    } else {
      phase = 'downloading';
      emitStatus();
      try {
        await downloadModel(model, {
          quant: file.quant,
          launchMode: 'multimodal',
          onProgress: (f, p) =>
            post({
              kind: 'download-progress',
              progress: {
                modelId: model.id,
                file: f,
                received: p.received,
                total: p.total ?? null,
                fraction: p.fraction ?? null,
              },
            }),
        });
        mmprojPath = existsSync(candidate) ? candidate : undefined;
      } catch (error) {
        const detail = String(error instanceof Error ? error.message : error);
        if (launchMode === 'multimodal') {
          phase = 'error';
          lastError = `failed to fetch vision projector: ${detail}`;
          current = null;
          emitStatus();
          return { success: false, error: lastError };
        }
        // Default launch: a projector we could not fetch must never stop the
        // model answering text. Come up blind and let the vision state say so.
        mmprojPath = undefined;
      }
      phase = 'starting';
      emitStatus();
    }
  }

  try {
    if (current !== null) {
      await current.supervisor.dispose();
      current = null;
    }
    /*
     * THE ENGINE IS CHOSEN PER MODEL, not once for the app.
     *
     * Almost always that is the pinned release. A model whose GGUF declares an
     * architecture the pinned binary has never heard of gets the engine variant
     * declared for it instead (llamacpp-variants.ts) — MEASURED for K2 Horizon:
     * the pinned b10603 answers `unknown model architecture: 'k2-horizon'` and
     * refuses to start, which is not something the user can do anything about.
     * `ensureEngineFor` also asks the pinned binary whether it has caught up, so
     * the variant stops being used the moment a pin bump makes it unnecessary.
     */
    const install = await ensureEngineFor(model, {
      execFileImpl: execFileAsync,
      // A compile is not a model load, and the user is watching a spinner either
      // way — so say which it is, and that it is once.
      onProgress: (p) => {
        engineBuild = { variantId: model.architecture ?? 'engine', note: p.note };
        emitStatus();
      },
    });
    engineBuild = undefined;
    if (install.variantId !== undefined) {
      console.log(`[engine] ${model.id} → variant "${install.variantId}" (${install.serverPath})`);
    }
    const features = await probeServerFeatures(install.serverPath);
    engineSpecTypes = features.specTypes;
    const hw = await getHardware();
    // Per-slot context (the reported/gauge value): a single request/slot sees this.
    // Hardware-adaptive + KV-aware (the user): up to ~64k when RAM allows, stepped down
    // for a big model / tight machine, and SLOT-aware — K parallel corp slots each
    // hold their own KV, so the per-slot window shrinks as K grows (never above the
    // model's own max). Replaces the old flat 16k CONTEXT_CAP.
    const slots = launchMode === 'fast-text' ? Math.max(1, Math.floor(parallel ?? 1)) : 1;
    /*
     * THE PROJECTOR IS PART OF THE FOOTPRINT, so it has to be part of the sum
     * the context is sized against.
     *
     * MEASURED, run 16 (Qwen3.8-27B UD-Q3_K_XL, 13.44 GB + a 0.93 GB F16
     * projector, 24 GB machine): this sized a 64k window from the WEIGHTS
     * alone, the projector then landed on top, and llama-server came up
     * healthy — `/health` answering `{"status":"ok"}` — and returned HTTP 500
     * "Compute error." to every single completion. It fails at generation, so
     * nothing in the startup path notices; the CEO's first four requests came
     * back `fetch failed` and the run was dead on arrival.
     *
     * The same launch WITHOUT the projector runs at 16.4 tok/s. And the Model
     * Manager's own badge had already predicted it — "≈18.5 GB … (≈19.7 GB with
     * vision on)" against a 19.2 GB budget — because `quantFit` counts the
     * projector and this did not. Same estimator, two callers, one of them
     * missing a term.
     *
     * Feeding the real total in makes `chooseContextCap` do its job: it steps
     * the window down (64k → 48k here) and KEEPS vision, which is the trade it
     * exists to make. Dropping the projector instead would have been the
     * cheaper fix and the wrong one.
     */
    const mmprojBytes =
      mmprojPath !== undefined
        ? (() => {
            try {
              return statSync(mmprojPath).size;
            } catch {
              return 0;
            }
          })()
        : 0;
    /*
     * THE POWER POLICY GETS A SAY IN HOW BIG THIS LAUNCH IS.
     *
     * `memoryFraction` is the reserve made concrete: the share of the machine a
     * launch may occupy. At full speed it is 1 − reserve/total; under pressure
     * the policy hands back more, which steps the context down the ladder and so
     * shrinks the resident KV — the only lever that moves a unified-memory
     * machine (MEASURED: no clock knob does, see perf-args.ts).
     */
    const powerNow = (await power()).current();
    /*
     * THE BUDGET IS THE CARD'S MEMORY WHEN THERE IS A CARD.
     *
     * This passed `hw.totalRamGB` unconditionally, which is right on unified
     * memory and wrong everywhere else: on a machine with an 8 GB GPU and 64 GB
     * of system RAM it sized the context against 64 GB and handed llama.cpp a KV
     * cache the card cannot hold — so the server spills to the host and runs an
     * order of magnitude slower, with nothing in the logs to say why.
     * `powerBudgetGB` draws the same distinction `usableMemoryGB` already draws
     * for the recommender; the launch should have been drawing it too.
     */
    const budgetGB = powerBudgetGB(await accelerators());
    const contextWindow = chooseContextCap({
      modelBytes: file.bytes + mmprojBytes,
      modelMaxContext: model.contextWindow,
      totalRamGB: budgetGB,
      slots,
      memoryFraction: powerNow.memoryFraction,
    });
    // OOM-safe fan-out: for a K-slot fast-text launch the server `-c` must be
    // perSlot × K (llama.cpp splits `-c` across `--parallel` slots) so each slot
    // still gets the full `contextWindow`. K defaults to 1 (single slot, `-c` =
    // contextWindow — unchanged). Multimodal keeps its single-slot budget.
    const launch =
      launchMode === 'fast-text'
        ? fastTextSlotLaunch(contextWindow, parallel)
        : { parallel: 1, contextSize: contextWindow };

    // Resolve the speed-decode sibling for a FAST-TEXT launch (a multimodal
    // launch drops MTP/EAGLE — they are mutually exclusive with --mmproj):
    //   - Gemma4 MTP head (separate sibling in the same repo) → --model-draft.
    //   - EAGLE-3 draft (from draftRepo) → --spec-type draft-eagle3 --model-draft.
    // Both are downloaded alongside the main GGUF (see model-downloader).
    const dir = modelDir(model.id);
    const mtpSiblingPath =
      launchMode === 'fast-text' && model.mtpFile !== undefined && model.mtpEmbedded !== true
        ? join(dir, model.mtpFile.name)
        : undefined;
    /*
     * THE METHOD IS THE PROFILE'S, and the draft file follows from it: EAGLE-3,
     * DFlash and DSpark each have their own GGUF beside the weights
     * (model-downloader fetches every one the catalogue names). A method whose
     * file is missing launches plain rather than failing — the calibration
     * planner never proposes one, and a stale record cannot break a launch.
     */
    const launchSpec = llamaSpecFor(profile.spec, model, profile.custom);
    const draftPath =
      launchMode !== 'fast-text'
        ? undefined
        : launchSpec.customDraft !== undefined
          ? launchSpec.customDraft
          : launchSpec.draftMethod !== undefined
            ? draftPathFor(model, launchSpec.draftMethod)
            : undefined;

    // Force the model's OFFICIAL chat template (from its base repo) so llama.cpp
    // routes to the real chat/tool parser instead of the GGUF's stale embedded
    // template. Best-effort + bounded: no baseRepo (or no cached/fetchable
    // template) → `[]`, leaving the launch unchanged. Applies in both modes.
    const chatTemplateArgs = await resolveChatTemplateArgs(
      model,
      persistedHfToken(),
      install.serverPath,
      modelPath,
    );

    // Per-hardware performance args. On Apple Silicon with RAM headroom this is
    // intentionally EMPTY — the pinned llama.cpp's auto defaults (-ngl/-fa/-ub/
    // threads) are measured-optimal there (see packages/inference/src/perf-args.ts).
    // It only intervenes under memory pressure (q8_0 KV to avoid swap) or on a
    // discrete GPU (flash-attn on). Merged with the chat-template args via extraArgs.
    // (`hw` was resolved above for the context-cap decision.)
    const perf = chooseServerPerfArgs({
      isAppleSilicon: hw.isAppleSilicon,
      totalRamGB: hw.totalRamGB,
      modelBytes: file.bytes,
      contextSize: launch.contextSize,
      cpuCount: hw.cpuCount,
    });
    if (perf.rationale.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[pi-perf] ${perf.rationale.join(' · ')}${perf.args.length > 0 ? ` → ${perf.args.join(' ')}` : ''}`,
      );
    }
    /*
     * …AND IN WHICH ARGS IT LAUNCHES WITH — the lever chosen for THIS machine's
     * wall (power-policy.ts explains why they differ):
     *
     *   unified   nothing to add beyond the smaller context above and a
     *             quantised KV; there is no clock knob on Metal.
     *   discrete  give VRAM back — a quantised KV, and under real pressure the
     *             whole KV cache moved to system RAM — before the card spills
     *             WEIGHTS to the host, which is an order of magnitude, not a
     *             fraction.
     *   cpu       leave the user some cores.
     *
     * `perf.args` may already have asked for a quantised KV under its own
     * estimate; the flags are deduped below so the two cannot disagree on the
     * command line.
     */
    const powerArgs: string[] = [];
    if (powerNow.quantizeKv) {
      powerArgs.push('--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '-fa', 'on');
    }
    if (powerNow.threads !== undefined) powerArgs.push('-t', String(powerNow.threads));
    if (powerNow.keepKvOnHost === true) powerArgs.push('--no-kv-offload');
    if (powerNow.level !== 'full') {
      // eslint-disable-next-line no-console
      console.log(`[pi-power] launching ${powerNow.level}: ${powerNow.reason}`);
    }
    /* THE USER'S FLAGS GO LAST: llama.cpp takes the last value of a repeated
       flag, so anything they set outranks the perf and power choosers — and
       anything they set is theirs to set (Settings → Advanced → Engine). */
    const launchExtraArgs = dedupeFlags([
      ...chatTemplateArgs,
      ...perf.args,
      ...powerArgs,
      ...userArgsFor('llamacpp'),
    ]);

    const supervisor = new LlamaServerSupervisor({
      serverPath: install.serverPath,
      modelPath,
      launchMode,
      contextSize: launch.contextSize,
      // `--parallel N`: N fast-text slots (default 1), or 1 for multimodal.
      parallel: launch.parallel,
      // Undefined for every fast-text launch (mmprojFileFor is the chokepoint),
      // set only when vision was explicitly requested — the lazy guarantee.
      mmprojPath,
      /* `specDisabled` models keep their declared head and simply do not launch
         with it by DEFAULT — measured slower on this hardware (see CatalogModel).
         A calibration or a hand-picked profile that asks for MTP outranks that
         table: it is the measurement the table was standing in for. */
      mtpSupported:
        features.mtp && (model.specDisabled !== true || requestedProfile?.spec === 'mtp'),
      mtpEmbedded: launchMode === 'fast-text' ? model.mtpEmbedded : undefined,
      mtpPath:
        mtpSiblingPath !== undefined && existsSync(mtpSiblingPath) ? mtpSiblingPath : undefined,
      specType: launchSpec.specType,
      eagle3Supported: features.eagle3,
      draftPath: draftPath !== undefined && existsSync(draftPath) ? draftPath : undefined,
      // The model's own template variables (Qwen3.8's reasoning_effort: medium).
      ...(model.chatTemplateKwargs !== undefined
        ? { chatTemplateKwargs: model.chatTemplateKwargs }
        : {}),
      extraArgs: launchExtraArgs.length > 0 ? launchExtraArgs : undefined,
      // The parent-death watchdog (a modtest-only addition; the working repo has
      // none) was SIGKILLing the healthy llama-server a few seconds after it came
      // up — the model would load, `phase` go 'ready', then the server die and
      // chat "fetch failed". DISABLED to match the working baseline; the normal
      // teardown (this utilityProcess's SIGTERM/exit handlers reap the child on
      // quit) covers the common case. Re-introduce only once the false-fire is
      // fixed. TODO(orphan-guard): a hard SIGKILL of this process can still orphan
      // the llama-server — handle that without a live-server killer.
      // watchdogFactory: (pid) => startParentDeathWatchdog({ targetPid: pid }),
    });

    supervisor.on((event) => {
      if (event.type === 'metrics') {
        metrics = { lastTps: event.metrics.lastTps, avgTps: event.metrics.avgTps };
        emitStatus();
      } else if (event.type === 'log' && event.stream === 'stderr') {
        for (const line of event.text.split('\n')) {
          const tps = parseTps(line);
          if (tps !== undefined) supervisor.recordTimings({ predicted_per_second: tps });
          /* WHY A PROMPT WAS READ AGAIN, in the server's own words — a re-prefill
             is otherwise visible only as a slow turn. */
          if (PROMPT_CACHE_LINE.test(line)) noteCacheLine(line);
        }
      } else if (event.type === 'crash' || event.type === 'restart') {
        beginLoading(model);
        phase = 'starting';
        emitStatus();
      } else if (event.type === 'exit' && event.reason === 'failed') {
        phase = 'error';
        lastError = event.detail ?? 'llama-server failed';
        current = null;
        emitStatus();
      }
    });

    const started = await startTracked(supervisor);
    const baseUrl = supervisor.baseUrl;
    /*
     * ASK THE SCHEDULER TO PUT THE USER FIRST.
     *
     * The cheapest lever there is, and the only one that helps on a machine
     * whose bottleneck is contention rather than memory: a hint, not a cap, so
     * under no contention the server still runs flat out and only loses when
     * something the user is looking at wants the same core.
     */
    if (powerNow.backgroundPriority) {
      const applied = await setBackgroundPriority(started.pid, true);
      // eslint-disable-next-line no-console
      console.log(`[pi-power] background priority for pid ${started.pid}: ${applied}`);
    }
    current = {
      supervisor,
      model,
      file,
      contextWindow,
      baseUrl,
      launchMode,
      visionReady: mmprojPath !== undefined,
      ...(mmprojPath !== undefined
        ? {}
        : {
            blindReason: !visionWanted
              ? model.mmproj !== undefined
                ? ('off' as const)
                : ('model' as const)
              : mmprojFile === undefined
                ? ('model' as const)
                : ('projector' as const),
          }),
      ...(visionFallback !== undefined ? { visionFallback } : {}),
      profile,
      provider: 'llamacpp',
      servedModelId: model.id,
      launchCommand: install.serverPath,
      launchArgs: supervisor.argv(),
      launchConfigFingerprint: launchFingerprint('llamacpp', model.id),
    };
    phase = 'ready';
    console.log(`[engine] ${model.id} up on llama.cpp · ${profile.spec} (${baseUrl})`);

    await writeModelsJson(
      MODELS_JSON,
      PROVIDER_NAME,
      /* Tell pi the window the SERVER has, not the one the catalog wishes for —
         `chooseContextCap` may have stepped it down. See launchedContextWindow. */
      buildProviderBlock(model, {
        baseUrl,
        servedModelId: model.id,
        launchedContextWindow: contextWindow,
      }),
    );

    emitStatus();
    return { success: true, baseUrl: started.baseUrl };
  } catch (error) {
    phase = 'error';
    lastError = String(error instanceof Error ? error.message : error);
    current = null;
    emitStatus();
    return { success: false, error: lastError };
  }
}

async function stopServer(): Promise<{ success: boolean }> {
  if (current !== null) {
    await current.supervisor.dispose();
    current = null;
  }
  phase = 'idle';
  metrics = null;
  emitStatus();
  return { success: true };
}

/**
 * Is any slot of the running server mid-request? llama-server's `/slots` (on
 * by default in the builds we ship) lists them with `is_processing`; a server
 * that cannot answer is treated as busy — parking on a guess would cut a turn.
 */
async function serverBusy(baseUrl: string): Promise<boolean> {
  try {
    const origin = baseUrl.replace(/\/v1\/?$/, '');
    const res = await fetch(`${origin}/slots`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return true;
    const slots = (await res.json()) as Array<{ is_processing?: boolean }>;
    return !Array.isArray(slots) || slots.some((s) => s.is_processing === true);
  } catch {
    return true;
  }
}

/**
 * Stop the server's process to give its memory to a generation, keeping the
 * port and the launch. See LlamaServerSupervisor.park. `bytes` is the model
 * file's size — the floor of what parking gives back, so the caller can tell
 * whether it is worth asking before it asks.
 */
async function parkServer(): Promise<{ ok: boolean; reason?: string; bytes?: number }> {
  if (current === null) return { ok: false, reason: 'no server' };
  if (current.supervisor.parked) return { ok: true, bytes: current.file.bytes };
  if (phase !== 'ready') return { ok: false, reason: `server is ${phase}` };
  if (await serverBusy(current.baseUrl)) return { ok: false, reason: 'a request is in flight' };
  await current.supervisor.park();
  metrics = null;
  emitStatus();
  return { ok: true, bytes: current.file.bytes };
}

async function resumeServer(): Promise<{ ok: boolean; reason?: string }> {
  if (current === null) return { ok: false, reason: 'no server' };
  if (!current.supervisor.parked) return { ok: true };
  try {
    const back = await current.supervisor.resume();
    if ((await power()).current().backgroundPriority) {
      await setBackgroundPriority(back.pid, true);
    }
    emitStatus();
    return { ok: true };
  } catch (error) {
    phase = 'error';
    lastError = String(error instanceof Error ? error.message : error);
    current = null;
    emitStatus();
    return { ok: false, reason: lastError };
  }
}

async function handle(req: LlmRequest): Promise<unknown> {
  switch (req.type) {
    case 'get-status':
      return status();
    case 'list-catalog':
      return listCatalog();
    case 'download-model':
      return downloadOne(req.modelId, req.quant, req.hfToken);
    case 'pause-download':
      return pauseDownload();
    case 'cancel-download':
      return cancelDownload();
    case 'delete-model':
      return deleteModel(req.modelId);
    case 'verify-model':
      return verifyModel(req.modelId, req.quant);
    case 'start-server':
      return startServer(req.modelId, req.quant, req.launchMode, req.parallel, req.profile);
    case 'stop-server':
      return stopServer();
    case 'calibrate':
      return calibrate(req.modelId, req.quant);
    case 'calibrate-cancel':
      return cancelCalibration();
    case 'companions':
      return { companions: await companionsOf(req.modelId, req.quant) };
    case 'calibration-plan':
      return calibrationPlan(req.modelId, req.quant, req.installableEngines ?? []);
    case 'calibration-record': {
      const model = getModel(req.modelId);
      const file = model === undefined ? undefined : pickFile(model, req.quant);
      const record = file === undefined ? null : readRecord(req.modelId, file.quant);
      return { record: record === null ? null : recordDto(record) };
    }
    case 'use-profile':
      return applyProfile(req.profile);
    case 'set-engine-launch':
      engineLaunch = req.engineLaunch;
      portableKnobs = req.portableKnobs ?? {};
      modelSpec = req.modelSpec;
      loadVision = req.loadVision !== false;
      return { success: true };
    case 'relaunch':
      return relaunch();
    case 'engine-flags':
      return engineFlags(req.engine);
    case 'list-local-ggufs':
      return { files: listLocalGgufs() };
    case 'park-server':
      return parkServer();
    case 'resume-server':
      return resumeServer();
    case 'set-power': {
      /*
       * The user's choice, applied from the NEXT launch. A running server keeps
       * the args it started with — changing them would mean a relaunch, and a
       * relaunch costs a full cold prefill, which is a worse interruption than
       * whatever prompted the change.
       */
      const manager = await power();
      await manager.setMode(req.mode);
      await manager.setReserveGB(req.reserveGB);
      const d = manager.current();
      // eslint-disable-next-line no-console
      console.log(`[pi-power] mode=${req.mode} → ${d.level}: ${d.reason}`);
      return { success: true };
    }
    case 'hf-search':
      return hfSearch(req);
    case 'hf-list-files':
      return hfListFiles(req);
    case 'register-hf-model':
      return registerHfModel(req);
  }
}

parentPort.on('message', (event) => {
  const req = event.data as LlmRequest;
  handle(req)
    .then((result) => post({ id: req.id, kind: 'reply', result }))
    .catch((error) =>
      post({
        id: req.id,
        kind: 'error',
        error: String(error instanceof Error ? error.message : error),
      }),
    );
});

/**
 * Reap the llama-server grandchild when THIS utilityProcess is torn down.
 *
 * The app-quit path SIGTERMs this utilityProcess (llm-main.ts shutdownInference).
 * Without these handlers, killing the utilityProcess never runs the supervisor's
 * kill ladder, so the spawned llama-server is orphaned and keeps holding the
 * model in RAM/VRAM after quit. On a caught signal we synchronously SIGKILL the
 * child (the async dispose ladder can't be trusted to finish before the parent
 * force-exits us), then leave; `process.on('exit')` is the final synchronous
 * backstop for any path that skips the signal handlers.
 */
let reaped = false;
function reapAndExit(): void {
  if (reaped) return;
  reaped = true;
  const c = current;
  const l = launching;
  current = null;
  launching = null;
  for (const sup of [c?.supervisor, l]) {
    try {
      sup?.killImmediately();
    } catch {
      // best-effort — a dead child is exactly the outcome we want
    }
  }
  process.exit(0);
}
process.once('SIGTERM', reapAndExit);
process.once('SIGINT', reapAndExit);
process.on('exit', () => {
  for (const sup of [current?.supervisor, launching]) {
    try {
      sup?.killImmediately();
    } catch {
      // best-effort
    }
  }
});

// Restore any previously-registered HF models so they stay in the local set
// across a supervisor restart, then announce initial idle state so the host has
// something to broadcast on attach.
loadHfModels();
emitStatus();
