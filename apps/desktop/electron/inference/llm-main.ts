/**
 * Main-process host for the "inference-supervisor" utilityProcess: forks it,
 * proxies the trusted-sender-gated `llm:*` invoke channels to it over
 * parentPort, and rebroadcasts its status / download-progress messages to every
 * app window as `llm:*` events. The supervisor owns llama-server; main only
 * relays, so a crash there never takes the UI down.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { cacheRoot, type LaunchProfile } from '@pi-desktop/inference';
import {
  createIpcEventSender,
  createLogger,
  type IpcHandlers,
  registerIpcHandlers,
} from '@pi-desktop/shared';
import { app, BrowserWindow, type IpcMain, type UtilityProcess, utilityProcess } from 'electron';
import type {
  AppEventMap,
  DatasetInvokeMap,
  EngineInvokeMap,
  HarnessInvokeMap,
  HfInvokeMap,
  LlmInvokeMap,
  LlmStatus,
  ModelCardInvokeMap,
  OrgAvatarInvokeMap,
} from '../ipc-contract';
import { readSettings } from '../settings/settings-main';
import { searchDatasets } from './dataset-search-main';
import { ensureEngines, installEngine, listEngines, uninstallEngine } from './engines-main';
import { detectHarnesses } from './harness-main';
import { fetchModelCard } from './modelcard-main';
import { cacheRemoteImage, fetchOrgAvatar } from './org-avatar-main';
import type {
  HfListFilesReply,
  HfRegisterReply,
  HfSearchReply,
  LlmCalibrateReply,
  LlmCatalogReply,
  LlmOutbound,
  LlmRequestBody,
} from './protocol';
import { reapOrphanedServers } from './reap-orphans';

const log = createLogger('desktop:llm');
const events = createIpcEventSender<AppEventMap>();

let child: UtilityProcess | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

/** Last status the supervisor broadcast — the source of the utility endpoint the
 * pi child points its reliability engine at (task #54). */
let lastStatus: LlmStatus | null = null;

/**
 * The OpenAI-compatible endpoint of the currently-running local model, or null
 * when no server is up. `baseUrl` already ends in `/v1` (supervisor.baseUrl), so
 * it feeds `PI_DESKTOP_UTILITY_BASE_URL` directly; `model` is the served id.
 * pi-main reads this at spawn to point the harness fixer/review/classifier at
 * the same local server. Never a hardcoded URL — absent server ⇒ null ⇒ the
 * harness degrades to its heuristic fallback.
 */
/**
 * Whether the RUNNING server can actually see images.
 *
 * Published to the pi child so the provider never hands a vision model's tokens
 * to a text-only server. Without this the child has no idea: it builds a request
 * with image parts, llama-server (launched without --mmproj) cannot decode them,
 * and the model concludes its tools are broken. Measured exactly that — five
 * turns of a 4B trying to look at a screenshot it was never going to see.
 */
/**
 * The RUNNING server's context window, or null when nothing is up.
 *
 * Corp roles were built on `DEFAULT_CONTEXT_WINDOW = 16384` and
 * `DEFAULT_MAX_TOKENS = 8192` while the model in front of them declares 32768 and
 * 28672 — nobody chose those constants for this model, and mesh-host never passed
 * a contextWindow at all. MEASURED consequence: an engineer's turn spent its
 * output budget on thinking and was cut mid-tool-call, so a `write` landed 359
 * bytes into main.js at `preload: path.join(__` and the harness ran it anyway.
 *
 * Read live rather than captured at spawn — the server restarts (a vision
 * relaunch, an Auto tier switch) and a role opened before that would otherwise
 * hold a stale number.
 */
export function getInferenceContextWindow(): number | null {
  return lastStatus?.model?.contextWindow ?? null;
}

/**
 * The model the server has loaded RIGHT NOW, by id and display name, or null
 * while nothing is up. A scheduled run stamps this on its record so the run
 * history can say what ran it — read live, for the same reason as the context
 * window above.
 */
export function getLoadedModel(): { id: string; displayName: string } | null {
  const m = lastStatus?.model;
  if (m === undefined || m === null || lastStatus?.phase !== 'ready') return null;
  return { id: m.id, displayName: m.displayName };
}

/**
 * Whether the running server can READ AN IMAGE — ask this, not the launch mode.
 *
 * A projector is attached on every llama.cpp launch, so `fast-text` sees fine.
 */
export function getInferenceVisionReady(): boolean {
  return lastStatus?.visionReady ?? lastStatus?.launchMode === 'multimodal';
}

/** The file every pi process reads to learn whether the server can SEE. */
export function visionStateFilePath(): string {
  return path.join(app.getPath('userData'), 'vision-state');
}

/**
 * Keep that file current.
 *
 * A pi process gets `PI_DESKTOP_VISION` fixed at spawn, and a SUBAGENT spawns
 * mid-turn — normally before anything has asked for vision — so it inherited `0`
 * and kept it for life, reporting "text only mode" long after the server had
 * relaunched multimodal. A one-byte file both parent and children re-read is the
 * cheapest thing that cannot go stale.
 */
/**
 * The LIVE utility endpoint, for a pi child that started before the server did.
 *
 * `PI_DESKTOP_UTILITY_BASE_URL` is fixed at spawn, and on a normal app open pi
 * starts FIRST — so the harness saw no endpoint, and everything that needs one
 * was dead for that process: the fixer, the reviewer, and above all the
 * system-prompt WARM-UP. Measured consequence: a first message paid a full cold
 * prefill, ~12s of "processing" on a question worth milliseconds, because the
 * warm-up had never once run in a real session. It only worked in the probe,
 * which restarts pi after the server is up.
 *
 * Same one-file cure as vision above, for the same reason.
 */
export function utilityStateFilePath(): string {
  return path.join(app.getPath('userData'), 'utility-endpoint.json');
}

/** Keep that file current — written on every status change, cleared when the
 * server goes away so a stale URL is never handed to a child. */
function writeUtilityState(): void {
  try {
    const utility = getInferenceUtility();
    writeFileSync(utilityStateFilePath(), utility === null ? '{}' : JSON.stringify(utility));
  } catch {
    // Best effort — the env snapshot remains the fallback.
  }
}

/**
 * Record whether the running server can READ AN IMAGE.
 *
 * This used to be `launchMode === 'multimodal'`, which stopped being the same
 * question. The vision projector is attached on every launch now — measured at
 * 0.9% throughput on qwen3.5-4b-mtp, for 641 MB — so an ordinary `fast-text`
 * server can already see. Writing '0' for it meant the first image in a session
 * triggered an on-demand relaunch into multimodal: a full unload and reload
 * (~105s on the 9B) to acquire a capability the process already had, and one
 * that ALSO drops speculative decoding for the rest of the session.
 *
 * So it reads the fact the supervisor reports (`visionReady`, true when a
 * projector was actually attached) and falls back to the old test only when a
 * status predates the field.
 */
function writeVisionState(status: { visionReady?: boolean; launchMode?: string } | null): void {
  const canSee = status?.visionReady ?? status?.launchMode === 'multimodal';
  try {
    writeFileSync(visionStateFilePath(), canSee ? '1' : '0');
  } catch {
    // Best effort — the env snapshot remains the fallback.
  }
}

/**
 * Switch the RUNNING server into multimodal so images become readable.
 *
 * The trigger this exists for is an image a TOOL produced — a browser
 * screenshot, a rendered frame — which never passes through the composer's
 * `messageNeedsVision` check and so never reached `ensureVisionMode()`. That gap
 * is why the 4B, asked to look at a page it had just captured, tried four times
 * and concluded its tools were broken (LIVE-TEST-FINDINGS.md §2).
 *
 * DEFERRED BY THE CALLER, DELIBERATELY. Going multimodal is a hard RESTART of
 * llama-server, so firing it the instant a screenshot is taken would kill the
 * very turn that took it. Callers set the want and act on it at a turn boundary.
 *
 * Never throws, and no-ops when already multimodal (vision is sticky for the
 * session) or when nothing is running.
 */
export async function ensureVisionServer(): Promise<{ ok: boolean; reason?: string }> {
  const status = lastStatus;
  if (status === null || !status.serverRunning) return { ok: false, reason: 'no server running' };
  if (status.launchMode === 'multimodal') return { ok: true };
  const model = status.model;
  if (model === null || model === undefined) return { ok: false, reason: 'no model resolved' };
  log.info('ensureVisionServer: relaunching multimodal', { modelId: model.id });
  try {
    const res = await request<{ success: boolean; error?: string }>({
      type: 'start-server',
      modelId: model.id,
      quant: model.quant,
      launchMode: 'multimodal',
    });
    if (!res.success) log.warn('ensureVisionServer FAILED', { error: res.error });
    return res.success ? { ok: true } : { ok: false, reason: res.error ?? 'relaunch failed' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('ensureVisionServer threw', { reason });
    return { ok: false, reason };
  }
}

export function getInferenceUtility(): { baseUrl: string; model: string } | null {
  if (
    lastStatus === null ||
    !lastStatus.serverRunning ||
    lastStatus.baseUrl === null ||
    lastStatus.baseUrl.length === 0
  ) {
    return null;
  }
  return { baseUrl: lastStatus.baseUrl, model: lastStatus.model?.id ?? 'utility' };
}

/** The model the coordination harness starts when none is already running (the
 * utility/fast pick — sub-12B Q8 qwen). Named so a missing-model message can
 * point the user at the exact id to download. */
export const CORP_MODEL_ID = 'qwen3.5-4b-mtp';

/**
 * The outcome of {@link ensureCorpInferenceServer}: either a running endpoint,
 * or an honest failure carrying the model id + reason so the caller can SURFACE
 * a user-meaningful "model isn't available" instead of degrading silently.
 */
export type CorpInferenceResult =
  | { readonly ok: true; readonly baseUrl: string; readonly model: string }
  | { readonly ok: false; readonly modelId: string; readonly error: string };

/**
 * Ensure a local model server is up for the coordination harness. When a server
 * is already running it is reused AS-IS; otherwise the recommended sub-12B Q8 qwen
 * ({@link CORP_MODEL_ID} `Q8_0`) is started via the SAME supervisor path the Model
 * Manager uses.
 *
 * `parallel` (K) requests K fast-text slots: the server comes up with
 * `--parallel K` and `-c = 16384 × K`, so concurrency is REAL and each of the K
 * engineer turns still gets the full 16384-token context (default K = 1 → the
 * unchanged single-slot `-c 16384` launch).
 *
 * REUSE CAVEAT: if a server is ALREADY up (possibly with a different slot count)
 * it is reused as-is — we log the requested K but do not restart to re-slot it.
 * A fresh corp run (no server yet) is the common path and gets exactly K slots.
 *
 * Never throws: a model that cannot be found/started resolves to an `ok:false`
 * result carrying the model id + error, so the caller surfaces it (a missing
 * model is a loud, honest terminal state — never a silent degrade to a stub).
 */
export async function ensureCorpInferenceServer(
  opts: { parallel?: number } = {},
): Promise<CorpInferenceResult> {
  const parallel = opts.parallel;
  const existing = getInferenceUtility();
  if (existing !== null) {
    if (parallel !== undefined && parallel > 1) {
      log.info('ensureCorpInferenceServer: reusing running server as-is', {
        requestedParallel: parallel,
        note: 'existing server kept; its slot count is not changed for this run',
      });
    }
    return { ok: true, ...existing };
  }
  try {
    const res = await request<{ success: boolean; baseUrl?: string; error?: string }>({
      type: 'start-server',
      modelId: CORP_MODEL_ID,
      quant: 'Q8_0',
      launchMode: 'fast-text',
      ...(parallel !== undefined ? { parallel } : {}),
    });
    if (res.success && res.baseUrl !== undefined && res.baseUrl.length > 0) {
      return { ok: true, baseUrl: res.baseUrl, model: CORP_MODEL_ID };
    }
    // A server may have raced up during the start attempt — reuse it if so.
    const late = getInferenceUtility();
    if (late !== null) return { ok: true, ...late };
    return { ok: false, modelId: CORP_MODEL_ID, error: res.error ?? 'model not available' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn('ensureCorpInferenceServer: start-server failed', { error });
    const late = getInferenceUtility();
    if (late !== null) return { ok: true, ...late };
    return { ok: false, modelId: CORP_MODEL_ID, error };
  }
}

function broadcast<K extends keyof AppEventMap & string>(
  channel: K,
  payload: AppEventMap[K],
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) events.send(win.webContents, channel, payload);
  }
}

function ensureChild(): UtilityProcess {
  if (child !== null) return child;
  const entry = path.join(__dirname, 'inference-supervisor.js');
  const proc = utilityProcess.fork(entry, [], { serviceName: 'inference-supervisor' });
  // A fresh worker starts on its own default; tell it what the user chose. Done
  // on the next tick so `child` is set before the request goes out.
  setTimeout(() => pushPowerSettings(), 0);

  proc.on('message', (message: LlmOutbound) => {
    if (message.kind === 'status') {
      const before = lastStatus?.launchMode;
      const sawBefore = lastStatus?.visionReady;
      lastStatus = message.status;
      if (message.status.launchMode !== before || message.status.visionReady !== sawBefore) {
        writeVisionState(message.status);
      }
      // The endpoint file tracks EVERY status change, not just a launch-mode
      // flip: "the server just came up" is exactly the transition a pi child
      // that started first needs to hear about.
      writeUtilityState();
      broadcast('llm:status', message.status);
      return;
    }
    if (message.kind === 'power') {
      /*
       * The worker re-decided. Cache the part MAIN needs synchronously (how
       * gently the next heavy generation runs) and say so once, at the level
       * change — not on every sample, which would be a line every fifteen seconds.
       */
      setHeavyJobEco({ pace: message.heavyJobPace, previews: message.heavyJobPreviews });
      log.info('power policy', {
        level: message.level,
        pace: message.heavyJobPace,
        previews: message.heavyJobPreviews,
        reason: message.reason,
      });
      return;
    }
    if (message.kind === 'download-progress') {
      broadcast('llm:download-progress', message.progress);
      return;
    }
    if (message.kind === 'calibration') {
      broadcast('llm:calibration', message.progress);
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.kind === 'reply') waiter.resolve(message.result);
    else waiter.reject(new Error(message.error));
  });

  proc.on('exit', (code) => {
    log.warn('inference-supervisor exited', { code });
    child = null;
    lastStatus = null;
    for (const waiter of pending.values()) waiter.reject(new Error('inference-supervisor exited'));
    pending.clear();
  });

  child = proc;
  log.info('inference-supervisor forked', { pid: proc.pid });
  return proc;
}

/**
 * App-quit teardown for the inference stack. Killing the utilityProcess is what
 * makes its `process.on('SIGTERM'|'exit')` handlers reap the llama-server
 * grandchild (supervisor-entry.ts) — so no llama-server survives quit holding
 * the model in RAM/VRAM. Bounded: if the utilityProcess is wedged and never
 * emits `exit`, we resolve on the timeout rather than blocking the quit.
 *
 * Wired into the single ordered quit sequence (pi-main quit-hold `extraTeardown`),
 * which runs BEFORE `app.exit()`. `app.exit()` does not emit `will-quit`, so the
 * `will-quit` handler below is only a backstop for quit paths that bypass the hold.
 */
/**
 * Download a catalog model by id, for a caller that is not the model screen.
 *
 * The Connectors page installs a MODEL connector (OmniSVG) by fetching the
 * model behind it, and the fetch has always lived in the inference utility
 * process behind this file's private `request`. Progress reaches the renderer
 * the same way the model screen's does — `llm:download-progress` — so the
 * connector card can show the same bar without a second mechanism.
 */
export async function downloadCatalogModel(
  modelId: string,
): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
  return request({ type: 'download-model', modelId });
}

/** Remove a catalog model's files — a MODEL connector's uninstall. */
export async function deleteCatalogModel(
  modelId: string,
): Promise<{ success: boolean; error?: string }> {
  return request({ type: 'delete-model', modelId });
}

export async function shutdownInference(timeoutMs = 1500): Promise<void> {
  const proc = child;
  if (proc === null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  try {
    // Default SIGTERM: caught in supervisor-entry, which SIGKILLs llama-server.
    proc.kill();
  } catch {
    // already gone
  }
  const timed = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    t.unref?.();
  });
  await Promise.race([exited, timed]);
}

/**
 * Push the user's power choice into the worker.
 *
 * Called when the child is (re)created and whenever the setting changes. The
 * policy itself lives in the worker — that is the process which launches
 * servers, so the decision has to be in hand when the args are assembled — but
 * the CHOICE is the user's and lives in settings. Best-effort: a worker that is
 * still starting will get it on the next call, and its default ('auto') is the
 * one most people want anyway.
 */
export function pushPowerSettings(): void {
  const s = readSettings();
  void request<{ success: boolean }>({
    type: 'set-power',
    mode: s.powerMode,
    ...(s.powerReserveGB !== undefined ? { reserveGB: s.powerReserveGB } : {}),
  }).catch(() => {
    // The worker is not up yet, or is going down. Neither is an error here.
  });
}

/**
 * MAKE ROOM for a generation: park the chat server (its process stops, its
 * URL stays) and bring it back afterwards. See gen/make-room.ts for when, and
 * supervisor-entry's parkServer for the mid-request refusal.
 */
export async function parkChatModel(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await request<{ ok: boolean; reason?: string; bytes?: number }>({
      type: 'park-server',
    });
    log.info('park chat model', { ok: r.ok, reason: r.reason, bytes: r.bytes });
    return r;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
export async function resumeChatModel(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await request<{ ok: boolean; reason?: string }>({ type: 'resume-server' });
    log.info('resume chat model', { ok: r.ok, reason: r.reason });
    return r;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * How gently the next heavy generation runs — the policy's answer, cached
 * here for the gen queue's hot path. the user: "low can't stop image generation
 * requests, it just has to lessen compute intensivity in some way sacrificing
 * speed to keep headroom."
 */
export interface HeavyJobEco {
  /** Share of every second the job's process rests (0 = flat out). */
  readonly pace: number;
  /** Per-step previews (≈4.5 GB of peak at 512²), or the picture alone. */
  readonly previews: boolean;
}
let heavyEcoCache: HeavyJobEco = { pace: 0, previews: true };
export function heavyJobEco(): HeavyJobEco {
  return heavyEcoCache;
}
export function setHeavyJobEco(eco: HeavyJobEco): void {
  heavyEcoCache = {
    pace: Number.isFinite(eco.pace) ? Math.max(0, Math.min(0.8, eco.pace)) : 0,
    previews: eco.previews !== false,
  };
}

function request<T>(req: LlmRequestBody): Promise<T> {
  const proc = ensureChild();
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    proc.postMessage({ ...req, id });
  });
}

const handlers: IpcHandlers<LlmInvokeMap> = {
  'llm:get-status': () => request<LlmStatus>({ type: 'get-status' }),
  'llm:list-catalog': () => request<LlmCatalogReply>({ type: 'list-catalog' }),
  'llm:download-model': (req) =>
    request({
      type: 'download-model',
      modelId: req.modelId,
      quant: req.quant,
      hfToken: req.hfToken,
    }),
  'llm:pause-download': () => request({ type: 'pause-download' }),
  'llm:cancel-download': () => request({ type: 'cancel-download' }),
  'llm:delete-model': (req) => request({ type: 'delete-model', modelId: req.modelId }),
  'llm:verify-model': (req) =>
    request({ type: 'verify-model', modelId: req.modelId, quant: req.quant }),
  'llm:start-server': (req) => {
    log.info('llm:start-server requested', {
      modelId: req.modelId,
      quant: req.quant,
      launchMode: req.launchMode,
    });
    return request<{ success: boolean; baseUrl?: string; error?: string }>({
      type: 'start-server',
      modelId: req.modelId,
      quant: req.quant,
      launchMode: req.launchMode,
    }).then((res) => {
      if (res.success) log.info('llm:start-server ok', { baseUrl: res.baseUrl });
      else log.warn('llm:start-server FAILED', { modelId: req.modelId, error: res.error });
      return res;
    });
  },
  'llm:stop-server': () => request({ type: 'stop-server' }),
  'llm:calibrate': (req) => {
    log.info('llm:calibrate requested', { modelId: req.modelId, quant: req.quant });
    return request<LlmCalibrateReply>({
      type: 'calibrate',
      modelId: req.modelId,
      quant: req.quant,
    }).then((res) => {
      if (res.ok) log.info('llm:calibrate done', { chosen: res.record?.chosen });
      else log.warn('llm:calibrate FAILED', { error: res.error });
      return res;
    });
  },
  'llm:calibrate-cancel': () => request({ type: 'calibrate-cancel' }),
  'llm:calibration-record': (req) =>
    request({ type: 'calibration-record', modelId: req.modelId, quant: req.quant }),
  // The strings come from the renderer; the supervisor validates them
  // (`profileOf`) before launching anything.
  'llm:use-profile': (req) =>
    request({
      type: 'use-profile',
      profile: { engine: req.engine, spec: req.spec } as LaunchProfile,
    }),
};

/** Hugging Face browse/register channels — proxied to the same supervisor, which
 * owns hf-search + the discovered-model registry (see supervisor-entry.ts). */
const hfHandlers: IpcHandlers<HfInvokeMap> = {
  'hf:search': (req) =>
    request<HfSearchReply>({
      type: 'hf-search',
      query: req.query,
      family: req.family,
      task: req.task,
      authors: req.authors,
      ggufOnly: req.ggufOnly,
      gated: req.gated,
      minLikes: req.minLikes,
      sort: req.sort,
      limit: req.limit,
      hfToken: req.hfToken,
    }),
  'hf:list-files': (req) =>
    request<HfListFilesReply>({
      type: 'hf-list-files',
      repoId: req.repoId,
      contextWindow: req.contextWindow,
      hfToken: req.hfToken,
    }),
  'hf:register': (req) =>
    request<HfRegisterReply>({
      type: 'register-hf-model',
      hit: req.hit,
      file: req.file,
      mmproj: req.mmproj,
      mtpFile: req.mtpFile,
      contextWindow: req.contextWindow,
    }),
};

/*
 * Engine install/remove (Settings -> Engines). The renderer owns the CATALOG
 * (which engines exist, what they are for, which platforms can run them — see
 * settings/engine-catalog.ts) and passes the ids it wants state for; main owns
 * only the disk truth. Keeping the catalog renderer-side means adding an engine
 * is a data edit that the panel and onboarding pick up together, rather than a
 * change that has to land on both sides of the IPC boundary at once.
 */
const harnessHandlers: IpcHandlers<HarnessInvokeMap> = {
  'harness:detect': (req) => ({ found: detectHarnesses(req.probes) }),
};

const modelCardHandlers: IpcHandlers<ModelCardInvokeMap> = {
  /* `kind` picks the Hub namespace. Dropping it — which this did — sent every
     dataset README request to the model path, where HF answers 401, so the
     pane showed "HTTP 401" for a public dataset whose card loads fine. */
  'modelcard:fetch': (req) => fetchModelCard(req.repoId, req.kind ?? 'model'),
};

const orgAvatarHandlers: IpcHandlers<OrgAvatarInvokeMap> = {
  'orgavatar:fetch': (req) => fetchOrgAvatar(req.org),
  'image:cache': (req) => cacheRemoteImage(req.url),
};

const datasetHandlers: IpcHandlers<DatasetInvokeMap> = {
  'datasets:search': (req) => searchDatasets(req),
};

const engineHandlers: IpcHandlers<EngineInvokeMap> = {
  'engines:list': () => ({ engines: listEngines(KNOWN_ENGINE_IDS) }),
  'engines:install': (req) => installEngine(req.id),
  'engines:uninstall': (req) => uninstallEngine(req.id),
  'engines:ensure': (req) => ensureEngines(req.ids),
};

/** Ids main can report on. Mirrors settings/engine-catalog.ts. */
const KNOWN_ENGINE_IDS = [
  'llamacpp',
  'rapid-mlx',
  'dflash-mlx',
  'mlx-dspark',
  'omlx',
  'mlx-lm',
  'comfyui',
  'lemonade',
  'vllm',
  'ninfer',
  'ninfer-3090',
] as const;

export function registerLlmIpc(ipcMain: IpcMain, allowSender: (event: unknown) => boolean): void {
  registerIpcHandlers<LlmInvokeMap>(ipcMain, handlers, { allowSender });
  registerIpcHandlers<EngineInvokeMap>(ipcMain, engineHandlers, { allowSender });
  registerIpcHandlers<HarnessInvokeMap>(ipcMain, harnessHandlers, { allowSender });
  registerIpcHandlers<ModelCardInvokeMap>(ipcMain, modelCardHandlers, { allowSender });
  registerIpcHandlers<OrgAvatarInvokeMap>(ipcMain, orgAvatarHandlers, { allowSender });
  registerIpcHandlers<DatasetInvokeMap>(ipcMain, datasetHandlers, { allowSender });
  registerIpcHandlers<HfInvokeMap>(ipcMain, hfHandlers, { allowSender });
  /*
   * Clear out any model server a PREVIOUS run left behind before standing up
   * ours. The ordered quit kills its own server correctly; a crash, a
   * force-quit or an automated close never gets to run it, and what survives is
   * a llama-server reparented to init still holding the whole model resident.
   *
   * MEASURED: six accumulated in one session, three of them 6.5GB. Free memory
   * fell to 41% and a benchmark run produced no tokens at all for four minutes
   * — the app was competing with ghosts of itself, and nothing on screen said
   * so. A server belonging to a LIVE app always has a live parent, so a second
   * window or a concurrent run is never touched.
   */
  reapOrphanedServers(path.join(cacheRoot(), 'llamacpp'), {
    ps: () => execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }),
    kill: (pid) => process.kill(pid),
    log: (message, meta) => log.info(message, meta),
  });
  /*
   * PI_E2E_NO_SERVER already means "this window is not here to talk to a model"
   * — it skips the chat server in the renderer. It did NOT skip the inference
   * supervisor, so every layout/CSS probe still spawned a full llama-server and
   * paged the whole model in.
   *
   * MEASURED: a session of UI probes left six of them behind, three at 6.5GB,
   * and the benchmark run launched afterwards produced nothing for eight
   * minutes. A probe that only looks at pixels has no business holding a model
   * in memory, let alone competing with a real run for it.
   */
  if (process.env.PI_E2E_NO_SERVER === '1') {
    log.info('PI_E2E_NO_SERVER=1 — not standing up the inference supervisor');
    app.on('will-quit', () => child?.kill());
    return;
  }
  // Stand the supervisor up now so its initial idle status broadcasts to the
  // window as soon as the renderer subscribes.
  ensureChild();
  app.on('will-quit', () => child?.kill());
}
