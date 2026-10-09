/**
 * gen3d main-process handlers — the REAL engine implementation behind the
 * contract: a uv/Python sidecar (packages/gen3d-engine) owns downloads, disk
 * truth and worker subprocesses (TRELLIS.2-on-MPS, Mage-Flow, CubePart,
 * Hunyuan Paint, AutoRemesher); this file supervises it lazily and translates
 * its NDJSON event stream into `gen3d:*` broadcasts.
 *
 * Honesty rules preserved from the stub: before the sidecar is up (or if uv /
 * the spawn fails) the catalog reports `engineReady:false` with real sizes and
 * a cheap TS-side installed probe (stamp files), and every action returns a
 * clear error instead of pretending.
 *
 * Artifacts land under ~/.pi/desktop/sandbox/gen3d/<jobId>/ — inside the
 * pd-file fence — while model weights live in ~/.cache/pi-desktop/gen3d/.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { default3dModel, type GenEvent, getModel } from '@pi-desktop/gen-service';
import {
  CORE_MODULE_MODELS,
  consumeNdjsonStream,
  detectInstalled,
  engineCacheDir,
  GEN3D_MODEL_SPECS,
  Gen3dSidecar,
  type Gen3dStage,
  gen3dSandboxDir,
  type JobUpdate,
  mapJobEvent,
  pickFreePort,
  planGenerate,
  planStageOp,
  resolveUv,
  type SidecarJobEvent,
  type StagePlan,
  specTotalBytes,
  TRELLIS_RESOLUTIONS,
  toSidecarRegistry,
} from '@pi-desktop/gen3d-engine';
import {
  createIpcEventSender,
  createLogger,
  type IpcHandlers,
  registerIpcHandlers,
} from '@pi-desktop/shared';
import { ensureUv } from '@pi-desktop/web-tools';
import { app, BrowserWindow, type IpcMain, shell, type WebContents } from 'electron';
import type { Run3dFn } from '../gen/gen-manager';
import { GenModuleMissingError, moduleMissingMessage } from '../gen/gen-modules';
import { guardRun } from '../gen/guardian-main';
import { weightsPresent } from '../gen/weights-on-shelf';
import { tieredSpawn } from '../inference/worker-tier';
import type { AppEventMap } from '../ipc-contract';
import { runLibraryMigration } from '../storage/storage-main';
import { comfyEngineInstalled } from '../studio/studio-main';
import { DictationSession, transcribe } from './dictation-main';
import type {
  Comfy3dInfo,
  DictationInvokeMap,
  Gen3dFinish,
  Gen3dGeometryModel,
  Gen3dInvokeMap,
  Gen3dModelId,
  Gen3dModelInfo,
  Gen3dResolution,
} from './gen3d-contract';
import { type ImageJobResult, ImageJobTracker } from './image-jobs';
import { installRendererHealth, startMemorySampling, stopMemorySampling } from './renderer-health';

const log = createLogger('desktop:gen3d');
const events = createIpcEventSender<AppEventMap>();

function broadcast<K extends keyof AppEventMap & string>(
  channel: K,
  payload: AppEventMap[K],
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) events.send(win.webContents, channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle (lazy: first catalog/download/generate boots it).
// ---------------------------------------------------------------------------

let sidecar: Gen3dSidecar | null = null;
let sidecarStarting: Promise<Gen3dSidecar | null> | null = null;
const eventsAbort = new AbortController();

/** The engine weight-cache root. Normally under the user's home; overridable
 * via GEN3D_CACHE_DIR (used by UI tests to force a clean "nothing installed"
 * state, since Electron's app.getPath('home') ignores a $HOME override). */
function cacheRoot(): string {
  const override = process.env.GEN3D_CACHE_DIR;
  return override !== undefined && override.length > 0
    ? override
    : engineCacheDir(app.getPath('home'));
}
/** jobId → stage plan captured when the job started (weights for percent math). */
const jobPlans = new Map<string, readonly StagePlan[]>();
/** Model ids with a download in flight (mirrored from sidecar events for the
 * catalog's `downloading` flag when composed TS-side). */
const downloading = new Set<string>();

/** Where python/server.py lives: packages/gen3d-engine/python (source tree in
 * dev; override with GEN3D_PY_DIR for packaged builds — see report).
 * The bundle runs from apps/desktop/dist-electron (3 hops to the repo root)
 * while ts-node-ish dev paths sit one deeper — probe both. */
/**
 * The shipped prebuilt tree beside the sidecar's python (see
 * packages/gen3d-engine/prebuilt/README.md) — unpacked from the asar like the
 * python is, and next to `GEN3D_PY_DIR` when a probe points at a checkout.
 */
function prebuiltDir(): string {
  return path.join(path.dirname(path.dirname(sidecarScriptPath())), 'prebuilt');
}

function sidecarScriptPath(): string {
  const override = process.env.GEN3D_PY_DIR;
  if (override !== undefined && override.length > 0) return path.join(override, 'server.py');
  // Packaged app: the @pi-desktop/gen3d-engine dependency is copied into the
  // asar and UNPACKED to real disk (electron-builder.yml asarUnpack), because
  // uv/python cannot exec a script from inside the asar.
  const packaged = path.join(
    process.resourcesPath ?? '',
    'app.asar.unpacked',
    'node_modules',
    '@pi-desktop',
    'gen3d-engine',
    'python',
    'server.py',
  );
  const tail = ['packages', 'gen3d-engine', 'python', 'server.py'];
  const bundlePath = path.join(__dirname, '..', '..', '..', ...tail);
  const devPath = path.join(__dirname, '..', '..', '..', '..', ...tail);
  return [packaged, bundlePath, devPath].find((p) => existsSync(p)) ?? devPath;
}

/** The audio venv's interpreter and the audio worker, resolved the same way
 * the sidecar's own script is: cache root for the venv (it is provisioned
 * there), and the python dir for the worker. */
/** The audio worker needs only its weight cache; everything else it imports
 * from its own venv. HF_HOME must match where the models were provisioned. */
function workerEnv(): NodeJS.ProcessEnv {
  // PATH, because the recogniser shells out to ffmpeg to decode the clip.
  // An app launched from Finder inherits a minimal PATH — no /opt/homebrew/bin,
  // no /usr/local/bin — so dictation died with "FFmpeg is not installed or not
  // in your PATH" on a machine where ffmpeg was installed and on MY shell's
  // PATH the whole time. Anything spawned from a GUI app has to be told.
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  const currentPath = process.env.PATH ?? '';
  return {
    ...process.env,
    PATH: [...extraPath, currentPath].filter((p) => p !== '').join(':'),
    HF_HOME: path.join(cacheRoot(), 'hf'),
    PYTHONUNBUFFERED: '1',
  };
}

/** Where macOS keeps the Microphone switch (Privacy & Security). */
const MIC_PRIVACY_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

function audioPaths(): { python: string; worker: string } {
  const python = dictationPaths().python;
  const worker = path.join(path.dirname(sidecarScriptPath()), 'workers', 'audio_worker.py');
  return { python, worker };
}

/** The speech model dictation loads (audio_worker.py ASR_MODEL). */
export const DICTATION_MODEL_REPO = 'mlx-community/parakeet-tdt-0.6b-v3';

/**
 * Where dictation's environment and speech model live: the audio venv the
 * worker runs in, and the Hugging Face cache it reads the model from (the
 * worker's HF_HOME). One place, so the check, the install and the worker
 * cannot disagree.
 */
export function dictationPaths(): { venv: string; python: string; hfHome: string; repo: string } {
  const venv = path.join(cacheRoot(), 'src', 'audio', '.venv');
  return {
    venv,
    python: path.join(venv, 'bin', 'python'),
    hfHome: path.join(cacheRoot(), 'hf'),
    repo: DICTATION_MODEL_REPO,
  };
}

/** The speech model's snapshot folder in the cache, or null when it is not all there. */
export function dictationModelDir(): string | null {
  const { hfHome, repo } = dictationPaths();
  const snapshots = path.join(hfHome, 'hub', `models--${repo.replace('/', '--')}`, 'snapshots');
  let revs: string[];
  try {
    revs = readdirSync(snapshots);
  } catch {
    return null;
  }
  for (const rev of revs) {
    const dir = path.join(snapshots, rev);
    if (
      existsSync(path.join(dir, 'config.json')) &&
      existsSync(path.join(dir, 'model.safetensors'))
    )
      return dir;
  }
  return null;
}

/** Dictation can run: its environment and its speech model are both on this Mac. */
export function dictationReady(): boolean {
  return existsSync(dictationPaths().python) && dictationModelDir() !== null;
}

/**
 * THE 3D MODULE, as gen-modules sees it. Ready once the sidecar is up (its
 * first start is its install: uv, then its pinned environment); the button
 * starts it and streams the log lines it prints on the way up.
 */
export function gen3dModuleReady(): boolean {
  return sidecar !== null;
}
export async function warmGen3dModule(
  report: (detail: string, percent?: number) => void,
): Promise<void> {
  report('Starting the 3D engine — its environment downloads on the first start…');
  const stop = moduleReporters.add(report);
  try {
    const instance = await ensureSidecar();
    if (instance === null) throw new Error('the 3D engine did not start — see the log');
    report('3D engine ready');
  } finally {
    stop();
  }
}
/** Card detail lines while the sidecar boots (see the log sink in startSidecar). */
const moduleReporters = {
  set: new Set<(detail: string, percent?: number) => void>(),
  add(fn: (detail: string, percent?: number) => void): () => void {
    this.set.add(fn);
    return () => this.set.delete(fn);
  },
  say(line: string): void {
    for (const fn of this.set) fn(line);
  },
};

async function ensureSidecar(): Promise<Gen3dSidecar | null> {
  if (sidecar !== null) return sidecar;
  if (sidecarStarting !== null) return sidecarStarting;
  sidecarStarting = startSidecar()
    .then((instance) => {
      // A boot that RESOLVED to nothing has also stopped starting. Without this
      // the renderer's "Starting the 3D engine…" (see ModuleGate) would be the
      // last thing it ever heard: the failure paths inside startSidecar return
      // null rather than throwing.
      if (instance === null) sidecarStarting = null;
      return instance;
    })
    .catch((err) => {
      log.warn('gen3d sidecar failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
      sidecarStarting = null;
      return null;
    })
    .finally(() => {
      // Tell the UI either way: a boot that finished — up or down — changes the
      // answer the catalog gives, and nothing else would ask again.
      broadcast('gen3d:catalog-changed', { at: Date.now() });
    });
  return sidecarStarting;
}

async function startSidecar(): Promise<Gen3dSidecar | null> {
  const serverScript = sidecarScriptPath();
  if (!existsSync(serverScript)) {
    log.warn('gen3d sidecar script missing', { serverScript });
    return null;
  }
  /*
   * FIND uv, OR FETCH IT. A Mac that has never run Python tooling has no uv, and
   * "install uv and retry" is a dead end for someone who just wants to make a 3D
   * model — the 3D module would be un-startable out of the box on most machines.
   *
   * `ensureUv` (packages/web-tools) is the app's existing bootstrap: it prefers
   * one already on PATH and otherwise downloads a PINNED release and verifies it
   * against the published checksum before use. It is what the web-tools Python
   * path already relies on, so this is the same trust decision, not a new one.
   */
  let uvPath = await resolveUv({ pathEnv: process.env.PATH, home: app.getPath('home') });
  if (uvPath === undefined) {
    try {
      log.info('gen3d: no uv found — bootstrapping a pinned copy');
      const install = await ensureUv();
      uvPath = install.uvPath;
      log.info('gen3d: uv ready', { source: install.source });
    } catch (error) {
      log.warn('gen3d: uv bootstrap failed — engine unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  if (uvPath === undefined) return null;
  const cacheDir = cacheRoot();
  // MUST agree with the pd-file fence, which is defined against os.homedir().
  // Electron's app.getPath('home') ignores $HOME, so the two disagreed whenever
  // HOME was overridden — artifacts landed outside the fence and every
  // `pd-file://` fetch of a finished result came back 403, silently dropping
  // the result on the floor. Observed in an e2e run; os.homedir() fixes it.
  const sandboxDir = gen3dSandboxDir(homedir());
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  const registryPath = path.join(cacheDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify(toSidecarRegistry(prebuiltDir()), null, 2));

  const port = await pickFreePort();
  const instance = new Gen3dSidecar({
    uvPath,
    /*
     * uv ON THE SIDECAR'S PATH. The Python side finds its own uv with
     * `shutil.which("uv") or ~/.local/bin/uv` (engine/registry.py) for every
     * stage it provisions; on a Mac where the only uv is the app's pinned copy,
     * neither answers, and every stage install died on a path that does not
     * exist while the sidecar itself was running on that very copy.
     */
    env: {
      PATH: `${path.dirname(uvPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    serverScript,
    // Behind the pointer — see inference/worker-tier.ts.
    spawnFn: tieredSpawn,
    cacheDir,
    sandboxDir,
    registryPath,
    port,
    log: (msg, meta) => {
      log.info(msg, meta);
      moduleReporters.say(msg);
    },
    onDown: () => {
      if (sidecar === instance) sidecar = null;
      sidecarStarting = null;
      /*
       * A DEAD SIDECAR TOOK ITS JOBS WITH IT, and nothing here noticed.
       *
       * `jobPlans` kept every plan for jobs that can no longer report, so the
       * next `generate_image` found a stale entry and image generation in chat
       * stayed broken until the app was restarted. And every caller awaiting a
       * job sat there until its own fifteen-minute timeout, because the thing
       * that would have settled it no longer exists.
       *
       * A crash here is expected, not exceptional: OOM is a normal outcome for
       * on-device generation on 24 GB. It has to be survivable, and it is a
       * prerequisite for any overnight batch — otherwise a night's work is one
       * image and several hundred lock errors by morning.
       */
      /*
       * …AND THE STUDIO HEARS IT. The panels watch `gen3d:job` for their job's
       * done; a sidecar that died mid-stage (killed by the memory guard, or
       * out of memory on its own) never sent one, so the stage sat on
       * "Running…" until the app was restarted. Each in-flight job ends here
       * with the reason.
       */
      for (const [jobId, plan] of jobPlans) {
        broadcast('gen3d:job', {
          jobId,
          stage: plan[plan.length - 1]?.stage ?? 'geometry',
          message: 'The 3D engine stopped',
          stagePercent: 0,
          overallPercent: 0,
          done: true,
          error: 'the 3D engine stopped before this finished — try again',
        });
        guardedJobs.get(jobId)?.();
        guardedJobs.delete(jobId);
      }
      jobPlans.clear();
      imageJobs.failAll('the generation sidecar stopped before this job finished');
      stopMemorySampling();
      broadcast('gen3d:catalog-changed', { at: Date.now() });
    },
  });
  await instance.ensureStarted();
  sidecar = instance;
  wireEventStream(instance);
  log.info('gen3d sidecar up', { baseUrl: instance.baseUrl });
  broadcast('gen3d:catalog-changed', { at: Date.now() });
  return instance;
}

/** URLs already being consumed — a crashed sidecar restarts on the SAME port,
 * and its old reconnecting stream loop would otherwise be joined by a second
 * one (double events) when the supervisor re-wires. */
const wiredEventUrls = new Set<string>();

function wireEventStream(instance: Gen3dSidecar): void {
  const url = `${instance.baseUrl}/events`;
  if (wiredEventUrls.has(url)) return;
  wiredEventUrls.add(url);
  void consumeNdjsonStream({
    url,
    signal: eventsAbort.signal,
    onValue: (value) => handleSidecarEvent(value),
  }).finally(() => wiredEventUrls.delete(url));
}

/** The repos the registry lists for these models — what a download writes. */
function reposOf(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const spec = GEN3D_MODEL_SPECS.find((m) => m.id === id);
    for (const r of spec?.repos ?? []) out.push(r.repo);
  }
  return out;
}

function handleSidecarEvent(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const event = value as Record<string, unknown>;
  if (event.type === 'download') {
    const id = String(event.id) as Gen3dModelId;
    const done = event.done === true;
    if (done) downloading.delete(id);
    else downloading.add(id);
    /* A finished download landed in the workers' hub cache; put it on its
       library shelf now (a link stays behind for the worker), leaving alone
       whatever is still downloading. */
    if (done && typeof event.error !== 'string') {
      try {
        runLibraryMigration({ skipRepos: reposOf([...downloading]) });
      } catch (err) {
        log.warn('could not shelve the download', { id, error: String(err) });
      }
    }
    broadcast('gen3d:download', {
      id,
      receivedBytes: Number(event.receivedBytes ?? 0),
      totalBytes: Number(event.totalBytes ?? 0),
      done,
      ...(typeof event.error === 'string' ? { error: event.error } : {}),
    });
    return;
  }
  if (event.type === 'job') {
    const jobId = String(event.jobId);
    const plan = jobPlans.get(jobId) ?? planGenerate('image', true);
    const update: JobUpdate = mapJobEvent(plan, event as unknown as SidecarJobEvent);
    // Feed the chat's image tools, which AWAIT a specific job (the studio's
    // panels just watch the broadcast below).
    imageJobs.note(update);
    if (update.done) {
      jobPlans.delete(jobId);
      guardedJobs.get(jobId)?.();
      guardedJobs.delete(jobId);
      stopMemorySampling();
    }
    broadcast('gen3d:job', {
      jobId: update.jobId,
      stage: update.stage,
      message: update.message,
      stagePercent: update.stagePercent,
      overallPercent: update.overallPercent,
      ...(update.artifact !== undefined ? { artifact: update.artifact } : {}),
      // The rig stage's shape measurement — the renderer asks the user
      // "humanoid?" from this, so it MUST survive the re-broadcast.
      ...(update.humanoid !== undefined ? { humanoid: update.humanoid } : {}),
      // A live denoising frame. Broadcast (the renderer animates it) but
      // deliberately NOT handed to `imageJobs` above: that tracker feeds the
      // chat tool's RESULT, which is the one place a preview must never reach.
      // It only ever reads `artifact`/`done`/`error`, so this stays UI-only by
      // construction rather than by remembering to filter it later.
      ...(update.preview !== undefined ? { preview: update.preview } : {}),
      done: update.done,
      ...(update.error !== undefined ? { error: update.error } : {}),
    });
    return;
  }
  if (event.type === 'catalog-changed') {
    broadcast('gen3d:catalog-changed', { at: Number(event.at ?? Date.now()) });
  }
}

async function sidecarPost<T>(route: string, body: unknown): Promise<T | null> {
  const instance = await ensureSidecar();
  if (instance === null) return null;
  try {
    const res = await fetch(`${instance.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    log.warn('gen3d sidecar request failed', {
      route,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Awaitable image jobs — the seam the CHAT's image tools call through.
//
// The studio panels are event-driven (fire `gen3d:generate`, watch `gen3d:job`
// broadcasts), but a tool call is a request/response: it must AWAIT one image
// and get back either a path or a reason. So a job started here registers a
// waiter that the same `handleSidecarEvent` branch settles — no polling, and
// exactly the same sidecar path (`/generate` with `imageOnly`) the Image panel
// uses, so there stays ONE engine, ONE model manager, ONE 24 GB job at a time.
// ---------------------------------------------------------------------------

// "Install uv and retry" sent the model off to pip-install things (MEASURED —
// see gen/gen-modules.ts); the sentence is the module's now, with the marker
// that puts the Download button in the chat.
const ENGINE_DOWN = moduleMissingMessage('3d');

export interface ImageJobRequest {
  /** Text→image prompt, or (with `editFrom`) the edit instruction. */
  readonly prompt: string;
  /** Absolute path of an image to EDIT instead of generating fresh. */
  readonly editFrom?: string;
  /** The asking pi — a subagent's id; absent for the chat's own pi. */
  readonly agent?: string;
  /** Aborted when the tool that asked has given up (gen3d-bridge). */
  readonly signal?: AbortSignal;
}

/**
 * Tell the renderer an AGENT owns this job, the moment it has an id — so the
 * chat that started it can stop it when the chat is deleted (the user, 2026-09-23).
 * Studio jobs never pass through here.
 */
function noteAgentJob(jobId: string, agent: string | undefined): void {
  broadcast('gen3d:agent-job', { jobId, ...(agent !== undefined ? { agent } : {}) });
}

/**
 * A JOB WHOSE ASKER IS GONE BEFORE IT HAD AN ID. A job waits for memory (up to
 * 20 s) or a cold engine before it has one, and in that time the tool that
 * asked can be stopped — its chat deleted, most likely — and has already
 * answered "cancelled". Nobody will receive what it makes, and announced now
 * it would belong to whichever chat is current, not the one that asked
 * (review wave-0923, delete #4). It is cancelled instead of announced.
 */
async function dropJob(jobId: string): Promise<ImageJobResult> {
  await cancelGen3dJob(jobId);
  return { ok: false, error: 'cancelled' };
}

/**
 * Wait for a job the asker may stop waiting for. The chat's image and 3D tools
 * answer "cancelled" and hang up the moment their turn is stopped; the job
 * then made a picture or a mesh nobody would ever receive, holding the engine
 * for minutes. Now it is cancelled when its asker goes.
 */
async function waitUnlessAbandoned(
  jobId: string,
  signal: AbortSignal | undefined,
  wait: () => Promise<ImageJobResult>,
): Promise<ImageJobResult> {
  const onAbandon = (): void => void cancelGen3dJob(jobId);
  signal?.addEventListener('abort', onAbandon, { once: true });
  try {
    return await wait();
  } finally {
    signal?.removeEventListener('abort', onAbandon);
  }
}

/** Image gen is ~11 s warm, but a cold call loads a ~15 GB model first. Generous
 * on purpose — the cap exists so nothing hangs forever, not to be tight. */
const IMAGE_JOB_TIMEOUT_MS = 15 * 60_000;

const imageJobs = new ImageJobTracker();

const MODEL_LABELS: Record<string, string> = {
  mageflow: 'Mage-Flow-Turbo (the image model)',
  'mageflow-edit': 'Mage-Flow-Edit-Turbo (the image-editing model)',
};

/**
 * Generate — or edit — ONE image and resolve with its path on disk.
 *
 * Every failure mode returns a reason rather than hanging: no engine runtime,
 * the model not downloaded, a missing source image, another job already
 * occupying the machine, an engine-side error, or the timeout.
 */
export async function runImageJob(
  req: ImageJobRequest,
  timeoutMs: number = IMAGE_JOB_TIMEOUT_MS,
): Promise<ImageJobResult> {
  const prompt = req.prompt.trim();
  if (prompt === '') return { ok: false, error: 'a prompt is required' };

  const editFrom = req.editFrom?.trim();
  const editing = editFrom !== undefined && editFrom !== '';
  if (editing) {
    if (!path.isAbsolute(editFrom)) {
      return { ok: false, error: `image_path must be an absolute path (got "${editFrom}")` };
    }
    if (!existsSync(editFrom)) return { ok: false, error: `no image at ${editFrom}` };
  }

  // Model gate FIRST, from the stamp files — a clear "download it" beats an
  // engine-side failure ten seconds in. (The sidecar only checks `mageflow`,
  // so an edit without the edit weights would otherwise die inside the worker.)
  const needed = editing ? 'mageflow-edit' : 'mageflow';
  const installed = detectInstalled(existsSync, cacheRoot());
  if (installed[needed] !== true) {
    return {
      ok: false,
      error: `${MODEL_LABELS[needed] ?? needed} is not downloaded yet. Open Bobble 3D → Image and download it first.`,
    };
  }

  // One heavy job at a time on a 24 GB machine. `jobPlans` holds every job this
  // process started — studio panels included — so this also refuses to pile on
  // top of a generation the user kicked off in the 3D studio.
  if (jobPlans.size > 0) {
    return {
      ok: false,
      error:
        'the generation engine is already running a job — only one runs at a time on this machine. Try again once it finishes.',
    };
  }

  startMemorySampling(editing ? 'chat:edit-image' : 'chat:generate-image');
  const res = await sidecarPost<{ ok: boolean; jobId?: string; error?: string }>('/generate', {
    kind: 'text',
    prompt,
    resolution: 'medium',
    texture: false,
    imageOnly: true,
    ...(editing ? { editFrom } : {}),
  });
  if (res === null) {
    stopMemorySampling();
    return { ok: false, error: ENGINE_DOWN };
  }
  if (!res.ok || res.jobId === undefined) {
    stopMemorySampling();
    return { ok: false, error: res.error ?? 'the engine refused the request' };
  }
  jobPlans.set(res.jobId, planGenerate('text', false));
  guardSidecarJob(res.jobId, 'the picture');
  if (req.signal?.aborted === true) return dropJob(res.jobId);
  noteAgentJob(res.jobId, req.agent);
  const jobId = res.jobId;
  return waitUnlessAbandoned(jobId, req.signal, () => imageJobs.wait(jobId, timeoutMs));
}

/**
 * A 3D MODEL FOR THE CHAT — the studio's own pipeline, awaited like the image
 * tools await theirs. The user (2026-09-17): "3d should be a connector". The
 * connector's tools reach here over the gen3d bridge (gen3d-bridge.ts): a
 * generation (a description, or a picture the model has) runs the same
 * `gen3d:generate` the 3D studio runs and resolves with the LAST `model-glb`
 * the job pushed (textured geometry replaces the untextured on the same job);
 * a refinement runs `gen3d:stage` (texture / segment / rig / retopo) on a
 * model the chat already has. The studio's panels watch the same broadcast,
 * so a job started from a chat shows up there too.
 */
export interface Model3dJobRequest {
  readonly prompt?: string;
  readonly imagePath?: string;
  readonly finish?: Gen3dFinish;
  readonly resolution?: Gen3dResolution;
  /** The asking pi — a subagent's id; absent for the chat's own pi. */
  readonly agent?: string;
  /** Aborted when the tool that asked has given up (gen3d-bridge). */
  readonly signal?: AbortSignal;
}

export type Stage3dOp = 'texture' | 'segment' | 'rig' | 'retopo';

export interface Stage3dJobRequest {
  readonly op: Stage3dOp;
  readonly modelPath: string;
  readonly prompt?: string;
  /** The asking pi — a subagent's id; absent for the chat's own pi. */
  readonly agent?: string;
  /** Aborted when the tool that asked has given up (gen3d-bridge). */
  readonly signal?: AbortSignal;
}

const MODEL_JOB_TIMEOUT_MS = 40 * 60_000;

function refuseIfBusy(): ImageJobResult | null {
  if (jobPlans.size > 0) {
    return {
      ok: false,
      error:
        'the generation engine is already running a job — only one runs at a time on this machine. Try again once it finishes.',
    };
  }
  return null;
}

export async function run3dJob(
  req: Model3dJobRequest,
  timeoutMs: number = MODEL_JOB_TIMEOUT_MS,
): Promise<ImageJobResult> {
  const prompt = req.prompt?.trim() ?? '';
  const imagePath = req.imagePath?.trim() ?? '';
  if (prompt === '' && imagePath === '')
    return { ok: false, error: 'a prompt or an image is required' };
  if (imagePath !== '') {
    if (!path.isAbsolute(imagePath)) {
      return { ok: false, error: `image_path must be an absolute path (got "${imagePath}")` };
    }
    if (!existsSync(imagePath)) return { ok: false, error: `no image at ${imagePath}` };
  }
  const busy = refuseIfBusy();
  if (busy !== null) return busy;
  const finish = req.finish ?? 'pbr';
  const res = await handlers['gen3d:generate']({
    kind: imagePath !== '' ? 'image' : 'text',
    ...(prompt !== '' ? { prompt } : {}),
    ...(imagePath !== '' ? { imagePaths: [imagePath] } : {}),
    resolution: req.resolution ?? 'medium',
    texture: finish !== 'grey',
    finish,
  });
  if (!res.ok || res.jobId === undefined) {
    return { ok: false, error: res.error ?? 'the engine refused the request' };
  }
  if (req.signal?.aborted === true) return dropJob(res.jobId);
  noteAgentJob(res.jobId, req.agent);
  const jobId = res.jobId;
  return withEndReason(
    jobId,
    await waitUnlessAbandoned(jobId, req.signal, () =>
      imageJobs.wait(jobId, timeoutMs, 'model-glb'),
    ),
  );
}

export async function runStage3dJob(
  req: Stage3dJobRequest,
  timeoutMs: number = MODEL_JOB_TIMEOUT_MS,
): Promise<ImageJobResult> {
  const modelPath = req.modelPath.trim();
  if (modelPath === '') return { ok: false, error: 'model_path is required' };
  if (!path.isAbsolute(modelPath)) {
    return { ok: false, error: `model_path must be an absolute path (got "${modelPath}")` };
  }
  if (!existsSync(modelPath)) return { ok: false, error: `no model at ${modelPath}` };
  const busy = refuseIfBusy();
  if (busy !== null) return busy;
  const res = await handlers['gen3d:stage']({
    op: req.op,
    modelPath,
    ...(req.prompt !== undefined && req.prompt.trim() !== '' ? { prompt: req.prompt.trim() } : {}),
    // A rig from the chat: the engine measures the shape and picks the rigger;
    // the studio is where a person answers "humanoid?" by hand.
    ...(req.op === 'retopo' ? { method: 'quick' as const } : {}),
  });
  if (!res.ok || res.jobId === undefined) {
    return { ok: false, error: res.error ?? 'the engine refused the request' };
  }
  if (req.signal?.aborted === true) return dropJob(res.jobId);
  noteAgentJob(res.jobId, req.agent);
  const jobId = res.jobId;
  return withEndReason(
    jobId,
    await waitUnlessAbandoned(jobId, req.signal, () =>
      imageJobs.wait(jobId, timeoutMs, 'model-glb'),
    ),
  );
}

/** Is the 3D module — an engine that can make a mesh — on this machine? */
export function model3dReady(): boolean {
  return sidecarCoreInstalled() || comfy3dInfo().ready;
}

// ---------------------------------------------------------------------------
// Catalog composition — TS labels/sizes/notes + sidecar (or stamp-file) truth.
// ---------------------------------------------------------------------------

function composeModels(
  installed: Record<string, boolean>,
  inFlight: ReadonlySet<string>,
): Gen3dModelInfo[] {
  return GEN3D_MODEL_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    role: spec.role,
    sizeBytes: specTotalBytes(spec),
    installed: installed[spec.id] === true,
    downloading: inFlight.has(spec.id),
    note: spec.note,
  }));
}

/**
 * The live-dictation recogniser. One per app: the model is 2.3 GB and a second
 * copy would be a second 2.3 GB, and there is one microphone anyway.
 * Constructed lazily so an app that never dictates never spawns it.
 */
let dictationSession: DictationSession | null = null;

function liveDictation(): DictationSession {
  if (dictationSession === null) {
    const { python, worker } = audioPaths();
    dictationSession = new DictationSession(python, worker, workerEnv(), (sessionId, partial) =>
      broadcast('audio:dictation', { sessionId, partial }),
    );
  }
  return dictationSession;
}

/*
 * IMAGE → 3D ON COMFYUI — the path with nothing to build on this Mac.
 *
 * The Bobble 3D engine (the sidecar above) is the fast one and the full one:
 * MLX TRELLIS.2 at 117s for 512³ with texture, then segment, retopo, rig,
 * motion. It is also the one that needs git and Xcode's Metal toolchain to
 * build its kernels, which a fresh Mac does not have. The user (2026-09-14): "any
 * user on any mac device can use video image 3d and audio generation with an
 * m1-m6 mac" — so the path a fresh Mac gets is ComfyUI's own TRELLIS.2 nodes
 * (0.35+, Comfy-Org int8 weights, no custom wheels): MEASURED 314s to a
 * 300k-face PBR GLB at 512³ on the M5 Pro 24GB. Slower, and it needs nothing.
 *
 * It runs through gen-manager's queue (`run3d`) — the same module and weights
 * gates, admission, room-making as a video job — and reports on this file's
 * `gen3d:job` channel in the sidecar's own shape, so the studio's panels and
 * viewport do not know which engine made the model.
 */
let comfy3dRunner: Run3dFn | null = null;
export function setComfy3dRunner(fn: Run3dFn): void {
  comfy3dRunner = fn;
}
/**
 * The ComfyUI meshes in flight, by the `c3d_` id this file gave them. Their
 * queue job has an id of its own that nothing here sees, so `gen3d:cancel`
 * reaches one through this — the sidecar has never heard of it.
 */
const comfyJobs = new Map<string, AbortController>();

/*
 * THE SIDECAR'S JOBS UNDER THE MEMORY GUARD.
 *
 * The engine's own stages — geometry on the MLX tree, texturing from a
 * picture, CubePart, the remesh, the riggers, ARDY — run in the sidecar's
 * worker processes, outside gen-manager's queue. That is the path the restart
 * of 2026-09-15 went through: nothing asked whether a 10 GB texturing job fit,
 * nothing sampled the machine faster than every 15 s while it ran, and
 * nothing could stop it. Now each accepted job is registered with the guard
 * (the sidecar's process tree is what a pause stops; `/cancel` is how a shed
 * ends the job in its own words), and a job is admitted only when the
 * guardian says its footprint fits beside the reserve.
 */
type Admit = (footprintGB?: number) => { ok: boolean; reason?: string; never?: boolean };
let admitFn: Admit | null = null;
/** Take a fresh reading — the guard's idle cadence is 15 s, and a stage waiting
 * at the door for the last one's memory to come back should not wait on that. */
let refreshFn: (() => Promise<unknown>) | null = null;
export function setGen3dAdmission(fn: Admit, refresh?: () => Promise<unknown>): void {
  admitFn = fn;
  refreshFn = refresh ?? null;
}
const guardedJobs = new Map<string, () => void>();

/** Rough resident footprints, GB, per sidecar op — the numbers admission is
 * asked about (MEASURED: TRELLIS 512 ≈ 10–12 GB, CubePart's pipeline 9.9 GB). */
function sidecarFootprintGB(op: string, resolution?: string, prompt?: string): number {
  switch (op) {
    case 'generate':
      return resolution === 'high' ? 20 : resolution === 'medium' ? 16 : 10;
    case 'texture':
      return 10;
    case 'segment':
      // MEASURED after cubepart_worker's re-sequencing: the 8.9 GB text
      // encoder is read and dropped before the 8.6 GB MLX denoiser loads, so
      // the peak is one of them plus the VAE — not all three (that was ~27 GB
      // at load, the number that put every segment into swap).
      return 12;
    case 'motion':
      // A prompt seen before costs ARDY alone (~2 GB); a new wording brings
      // the 8-bit MLX text encoder in for a second (~9.5 GB), then drops it.
      return prompt !== undefined && motionPromptCached(prompt) ? 4 : 10;
    case 'retopo':
      return 2;
    default:
      return 1;
  }
}

/**
 * Whether motion_worker.py has this prompt's embedding on disk — the same key
 * it uses (`_cache_path`: sha256 of "<model>\0<prompt>", first 32 hex chars,
 * under ~/.cache/bobble/gen3d/ardy-text). Read here only to size the
 * admission; the worker remains the one writer.
 */
function motionPromptCached(prompt: string): boolean {
  const digest = createHash('sha256')
    .update(`ARDY-Core-RP-20FPS-Horizon40\0${prompt}`)
    .digest('hex')
    .slice(0, 32);
  return existsSync(
    path.join(homedir(), '.cache', 'bobble', 'gen3d', 'ardy-text', `${digest}.npz`),
  );
}

/**
 * Why the guardian ended a job, by job id. The engine reports a job it was
 * told to cancel as "cancelled" and nothing more — which, relayed to the chat
 * as a tool result, read "generate_3d failed: cancelled" (SEEN 2026-09-18: a
 * grey build shed at 102 s on this 24 GB Mac). The guardian's own sentence is
 * the one worth passing on — it names the memory and what would change it.
 */
const endedBy = new Map<string, string>();

/** A tracker result, with the guardian's reason in place of a bare "cancelled". */
function withEndReason(jobId: string, res: ImageJobResult): ImageJobResult {
  const why = endedBy.get(jobId);
  endedBy.delete(jobId);
  if (why !== undefined && !res.ok && /^cancel/i.test(res.error)) return { ok: false, error: why };
  return res;
}

function guardSidecarJob(jobId: string, label: string): void {
  guardedJobs.get(jobId)?.();
  guardedJobs.set(
    jobId,
    guardRun({
      id: `gen3d:${jobId}`,
      label,
      kind: 'gen3d',
      pid: () => sidecar?.pid,
      // The sidecar is the server the stage runs under, not the stage: a
      // pause stops the whole tree (harmless — its HTTP waits with it), but
      // a termination ends the worker through /cancel and then only the
      // tree BELOW the server (uv → python server → worker), so the server
      // stays up for the next stage.
      spareDepth: 1,
      cancel: async (reason) => {
        endedBy.set(jobId, reason);
        await sidecarPost<{ ok: boolean }>('/cancel', { jobId });
      },
    }),
  );
}

/** How long a stage waits at the door for memory to come back before it is
 * refused. The seconds after a big stage ends are the common case: its worker
 * is gone but the kernel is still reclaiming (MEASURED, motion right after a
 * part split: "needs about 12.5 GB and only 13.9 GB is available" — twenty
 * seconds later there was plenty). A job that could never fit is refused at
 * once. */
const ADMISSION_WAIT_MS = 20_000;
const ADMISSION_POLL_MS = 1_000;

async function admitSidecarJob(
  op: string,
  resolution?: string,
  prompt?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (admitFn === null) return { ok: true };
  const footprint = sidecarFootprintGB(op, resolution, prompt);
  const deadline = Date.now() + ADMISSION_WAIT_MS;
  let verdict = admitFn(footprint);
  while (!verdict.ok && verdict.never !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ADMISSION_POLL_MS));
    if (refreshFn !== null) await refreshFn().catch(() => undefined);
    verdict = admitFn(footprint);
  }
  if (verdict.ok) return { ok: true };
  return {
    ok: false,
    error: `Not enough memory free right now — ${verdict.reason ?? 'the machine is under pressure'}. Close something or wait a moment and try again.`,
  };
}

/** The catalog id ComfyUI runs for a geometry model named on a request. */
const COMFY_3D_MODEL_IDS: Readonly<Record<Gen3dGeometryModel, string>> = {
  trellis2: 'trellis2-comfy',
  pixal3d: 'pixal3d-comfy',
};

export function comfy3dInfo(): Comfy3dInfo {
  const model = default3dModel();
  const runtimeReady = comfyEngineInstalled();
  const weightsReady = weightsPresent(model);
  const weightGB = (model.weights ?? []).reduce((n, f) => n + (f.bytes ?? 0), 0) / 1e9;
  const pixal = getModel(COMFY_3D_MODEL_IDS.pixal3d);
  return {
    runtimeReady,
    weightsReady,
    ready: runtimeReady && weightsReady,
    modelId: model.id,
    // The runtime is 1.5 GB on this platform (gen-modules GEN_MODULE_META).
    approxGB: Math.round(((runtimeReady ? 0 : 1.5) + (weightsReady ? 0 : weightGB)) * 10) / 10,
    pixal3dWeightsReady: pixal !== undefined && weightsPresent(pixal),
    pixal3dGB:
      pixal === undefined
        ? 0
        : Math.round(((pixal.weights ?? []).reduce((n, f) => n + (f.bytes ?? 0), 0) / 1e9) * 10) /
          10,
  };
}

/** The engine's own core set on disk (no boot) — what decides the default route. */
function sidecarCoreInstalled(): boolean {
  const installed = detectInstalled(existsSync, cacheRoot());
  return CORE_MODULE_MODELS.every((id) => installed[id] === true);
}

/**
 * The three samplers of the graph, in order, and their step counts (see
 * gen-service comfy-workflow trellis2ImageTo3dGraph). ComfyUI reports progress
 * per node with the step counter starting over at each, so a reset marks the
 * next phase; everything after the last one is the mesh stage, which has no
 * counter and is announced by name.
 */
const COMFY_3D_PHASES = [
  { label: 'Structure', steps: 12 },
  { label: 'Shape', steps: 20 },
  { label: 'Texture', steps: 12 },
] as const;
/** A grey model has no texture sampler — two phases, not three. */
function comfy3dPhases(finish: Gen3dFinish): readonly { label: string; steps: number }[] {
  return finish === 'grey' ? COMFY_3D_PHASES.slice(0, 2) : COMFY_3D_PHASES;
}

function runComfy3d(req: Gen3dInvokeMap['gen3d:generate']['request']): {
  ok: boolean;
  jobId?: string;
  error?: string;
} {
  const runner = comfy3dRunner;
  if (runner === null) return { ok: false, error: 'the ComfyUI 3D path is not wired' };
  const imagePath = req.imagePaths?.[0];
  if (req.kind !== 'image' || imagePath === undefined) {
    return {
      ok: false,
      error:
        'Without the Bobble 3D engine a model is made from a picture — make or drop an image first.',
    };
  }
  const finish: Gen3dFinish = req.finish ?? (req.texture ? 'pbr' : 'grey');
  const phases = comfy3dPhases(finish);
  const samplerSteps = phases.reduce((n, p) => n + p.steps, 0);
  const jobId = `c3d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputDir = path.join(gen3dSandboxDir(homedir()), jobId);
  const say = (
    stage: 'geometry' | 'texture',
    message: string,
    stagePercent: number,
    overallPercent: number,
  ): void => {
    broadcast('gen3d:job', { jobId, stage, message, stagePercent, overallPercent, done: false });
  };
  startMemorySampling(`comfy3d:${req.resolution}`);
  say('geometry', 'Getting the 3D module ready…', 0, 0);

  let phase = 0;
  let lastStep = 0;
  let stepsBefore = 0;
  // CPU passes after the last sampler (remesh, decimate, unwrap, the bakes)
  // report their own counters; each restart is one more of them.
  let meshPasses = 0;
  const onEvent = (event: GenEvent): void => {
    if (event.event !== 'progress') return;
    const { step, total } = event;
    // A counter that went backwards is the next sampler starting — or, past
    // the last sampler, the next mesh pass.
    if (step < lastStep) {
      if (phase < phases.length - 1) {
        stepsBefore += phases[phase]?.steps ?? total;
        phase += 1;
      } else {
        meshPasses += 1;
      }
    }
    lastStep = step;
    const current = phases[phase] ?? phases[phases.length - 1];
    const done = stepsBefore + step;
    // The samplers are ~55% of the wall clock at 512³ (145s of 314s MEASURED);
    // the decodes and the CPU mesh passes take the rest. Their number is not
    // known up front, so each pass moves the bar a tenth, capped short of done.
    const overall =
      meshPasses === 0
        ? Math.min(0.55, (done / samplerSteps) * 0.55)
        : Math.min(0.95, 0.55 + 0.1 * (meshPasses - 1) + 0.1 * (total > 0 ? step / total : 0));
    const label = meshPasses > 0 ? 'Mesh' : (current?.label ?? 'Sampling');
    say(
      phase >= 2 || (meshPasses > 0 && finish !== 'grey') ? 'texture' : 'geometry',
      `${label} (step ${step}/${total})…`,
      total > 0 ? step / total : 0,
      overall,
    );
  };

  const stop = new AbortController();
  comfyJobs.set(jobId, stop);
  void runner(
    {
      imagePath,
      outputDir,
      model: COMFY_3D_MODEL_IDS[req.model ?? 'trellis2'],
      finish,
      signal: stop.signal,
      // A hold's reason, or the room being made — said where the studio's
      // panels read, instead of "Getting the 3D module ready…" for the wait.
      onNote: (text) => say('geometry', text, 0, 0),
      ...(req.textureSize !== undefined ? { textureSize: req.textureSize } : {}),
      ...(req.faceBudget !== undefined && req.faceBudget > 0 ? { faces: req.faceBudget } : {}),
    },
    onEvent,
  )
    .then(({ outputs }) => {
      const glb = outputs.find((o) => o.outputPath.toLowerCase().endsWith('.glb'));
      if (glb === undefined) throw new Error('ComfyUI finished without a model file');
      const label = finish === 'grey' ? 'Untextured geometry' : 'Textured model';
      broadcast('gen3d:job', {
        jobId,
        stage: finish === 'grey' ? 'geometry' : 'texture',
        message: finish === 'grey' ? 'Model ready' : 'Textured model ready',
        stagePercent: 1,
        overallPercent: 1,
        artifact: { kind: 'model-glb', path: glb.outputPath, label },
        done: true,
      });
    })
    .catch((err: unknown) => {
      const message =
        err instanceof GenModuleMissingError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      broadcast('gen3d:job', {
        jobId,
        stage: 'geometry',
        message: 'Generation failed',
        stagePercent: 0,
        overallPercent: 0,
        done: true,
        error: message,
      });
    })
    .finally(() => {
      comfyJobs.delete(jobId);
      stopMemorySampling();
    });
  return { ok: true, jobId };
}

const handlers: IpcHandlers<Gen3dInvokeMap & DictationInvokeMap> = {
  /** Dictation. Not a job — see dictation-main.ts for why. */
  'audio:transcribe': async (req) => {
    const { python, worker } = audioPaths();
    if (!dictationReady()) {
      return { ok: false, error: 'the dictation model is not installed yet' };
    }
    const bytes = Buffer.from(req.audioBase64, 'base64');
    return await transcribe(python, worker, bytes, req.extension, workerEnv());
  },

  /** Live dictation. Partials arrive as `audio:dictation` events; the reply to
   * `stop` is the accurate full-context transcript. */
  'audio:dictation-start': async () => {
    if (!dictationReady()) {
      return { ok: false, error: 'the dictation model is not installed yet' };
    }
    return await liveDictation().start();
  },
  'audio:dictation-chunk': async (req) => {
    liveDictation().chunk(req.sessionId, req.pcmBase64);
    return { ok: true };
  },
  'audio:dictation-stop': async (req) => await liveDictation().stop(req.sessionId),
  'audio:dictation-cancel': async (req) => {
    liveDictation().cancel(req.sessionId);
    return { ok: true };
  },
  'audio:open-mic-settings': async () => {
    // A probe asking must not open System Settings over someone's work.
    if (process.env.PI_E2E === '1') {
      const g = globalThis as { __pdOsOpens?: unknown[] };
      g.__pdOsOpens = [
        ...(g.__pdOsOpens ?? []),
        { channel: 'audio:open-mic-settings', ran: false, at: Date.now() },
      ];
      return { ok: true };
    }
    try {
      await shell.openExternal(MIC_PRIVACY_PANE);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },

  /*
   * DISK ONLY — deliberately does not touch the sidecar. The sidebar renders the
   * 3D row constantly; making that spawn uv + Python for a user who never opens
   * the studio would be a real cost for a label.
   */
  'gen3d:module': () => {
    const installed = detectInstalled(existsSync, cacheRoot());
    const missing = CORE_MODULE_MODELS.filter((id) => installed[id] !== true);
    const remainingBytes = missing.reduce((n, id) => {
      const spec = GEN3D_MODEL_SPECS.find((sp) => sp.id === id);
      return n + (spec === undefined ? 0 : specTotalBytes(spec));
    }, 0);
    /*
     * Either path makes the studio usable, and the sidebar's number is the
     * path a fresh Mac will actually take: with none of the engine's core on
     * disk it quotes the ComfyUI module (10.5 GB), not the engine's 33 GB —
     * The user's "download module (nGB)" is the button they will press.
     */
    const comfy = comfy3dInfo();
    const engineUntouched = missing.length === CORE_MODULE_MODELS.length;
    return {
      installed: missing.length === 0 || comfy.ready,
      remainingBytes: comfy.ready
        ? 0
        : engineUntouched
          ? Math.round(comfy.approxGB * 1e9)
          : remainingBytes,
    };
  },
  'gen3d:catalog': async () => {
    // Report the live catalog ONLY if the sidecar is already up — never block
    // the first catalog call on booting it (that would leave the whole model
    // list / download UI blank for the seconds a uv boot takes). If it's not
    // up, boot it in the background; it broadcasts `catalog-changed` when ready,
    // which re-refreshes the UI (engineReady then flips to true).
    if (sidecar !== null) {
      try {
        const res = await fetch(`${sidecar.baseUrl}/catalog`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          const body = (await res.json()) as {
            models: { id: string; installed: boolean; downloading: boolean }[];
          };
          const installed: Record<string, boolean> = {};
          const inFlight = new Set<string>();
          for (const m of body.models) {
            installed[m.id] = m.installed;
            if (m.downloading) inFlight.add(m.id);
          }
          return {
            engineReady: true,
            engineBooting: false,
            models: composeModels(installed, inFlight),
            resolutions: TRELLIS_RESOLUTIONS,
            comfy: comfy3dInfo(),
          };
        }
      } catch (err) {
        log.warn('gen3d catalog fetch failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Kick off the boot without awaiting it.
      void ensureSidecar();
    }
    /*
     * "STILL STARTING" IS NOT "NOT AVAILABLE".
     *
     * The user: "3D studio shows 'runtime is not available' on every first open of
     * the app even when previously installed." That is this branch: the FIRST
     * catalog call after launch always finds `sidecar === null`, kicks off a uv
     * boot that takes seconds, and answers `engineReady:false` straight away so
     * the model list is not blank. The renderer had no way to tell that apart
     * from a broken runtime, so it drew the failure wall every single launch and
     * then quietly corrected itself once `catalog-changed` arrived.
     *
     * `engineBooting` is the missing distinction. A boot in flight says wait; a
     * boot that has actually failed (uv missing, script gone — `sidecarStarting`
     * is cleared in that catch) still says unavailable, which is the case the
     * wording was written for.
     */
    // Immediate honest degraded catalog from stamp files.
    const installed = detectInstalled(existsSync, cacheRoot());
    return {
      engineReady: false,
      engineBooting: sidecarStarting !== null,
      models: composeModels(installed, downloading),
      resolutions: TRELLIS_RESOLUTIONS,
      comfy: comfy3dInfo(),
    };
  },
  'gen3d:download': async (req) => {
    const res = await sidecarPost<{ ok: boolean; error?: string }>('/download', { ids: req.ids });
    if (res === null) return { ok: false, error: ENGINE_DOWN };
    return res;
  },
  'gen3d:cancel-download': async (req) => {
    const res = await sidecarPost<{ ok: boolean }>('/cancel-download', { id: req.id });
    return res ?? { ok: false };
  },
  'gen3d:generate': async (req) => {
    /*
     * WHICH ENGINE. The Bobble 3D engine when its core set is on disk (or asked
     * for by name); ComfyUI otherwise — a fresh Mac's first model comes out of
     * the path that needs nothing built. `engine: 'comfy'` picks it outright.
     */
    // Pixal3D has no engine port — it is ComfyUI's, whichever engine is installed.
    const useComfy =
      req.engine === 'comfy' ||
      req.model === 'pixal3d' ||
      (req.engine === undefined && !sidecarCoreInstalled());
    if (useComfy) return runComfy3d(req);
    // A grey finish is an untextured run; colour/PBR decide what the bake writes.
    const finish: Gen3dFinish = req.finish ?? (req.texture ? 'pbr' : 'grey');
    const body = { ...req, texture: finish !== 'grey', finish };
    const admitted = await admitSidecarJob(
      req.imageOnly === true ? 'image' : 'generate',
      req.resolution,
    );
    if (!admitted.ok) return { ok: false, error: admitted.error };
    startMemorySampling(`generate:${req.kind}:${req.resolution}`);
    const res = await sidecarPost<{ ok: boolean; jobId?: string; error?: string }>(
      '/generate',
      body,
    );
    if (res === null) return { ok: false, error: ENGINE_DOWN };
    if (res.ok && res.jobId !== undefined) {
      jobPlans.set(res.jobId, planGenerate(req.kind, body.texture));
      guardSidecarJob(res.jobId, req.imageOnly === true ? 'the picture' : 'the 3D model');
    }
    return res;
  },
  'gen3d:stage': async (req) => {
    const admitted = await admitSidecarJob(req.op, req.resolution, req.prompt);
    if (!admitted.ok) return { ok: false, error: admitted.error };
    startMemorySampling(`stage:${req.op}`);
    const res = await sidecarPost<{ ok: boolean; jobId?: string; error?: string }>('/stage', req);
    if (res === null) return { ok: false, error: ENGINE_DOWN };
    if (res.ok && res.jobId !== undefined) {
      jobPlans.set(res.jobId, planStageOp(req.op));
      guardSidecarJob(
        res.jobId,
        req.op === 'texture'
          ? 'the 3D texture'
          : req.op === 'segment'
            ? 'the part split'
            : req.op === 'retopo'
              ? 'the retopology'
              : req.op === 'rig'
                ? 'the rig'
                : 'the motion clip',
      );
    }
    return res;
  },
  'gen3d:cancel': (req) => cancelGen3dJob(req.jobId),
};

/** Stop a job by the id `gen3d:generate` / `gen3d:stage` gave it. */
async function cancelGen3dJob(jobId: string): Promise<{ ok: boolean }> {
  /*
   * A ComfyUI mesh is not the sidecar's. Posting its id there cancelled
   * nothing — and booted the engine, uv and all, to do it — while the real
   * job kept the GPU for its full 5–25 minutes.
   */
  const comfy = comfyJobs.get(jobId);
  if (comfy !== undefined) {
    comfy.abort();
    return { ok: true };
  }
  if (jobId.startsWith('c3d_')) return { ok: false }; // already over
  const res = await sidecarPost<{ ok: boolean }>('/cancel', { jobId });
  return res ?? { ok: false };
}

export function registerGen3dIpc(
  ipcMain: IpcMain,
  allowSender: (event: unknown) => boolean,
  _getWebContents: () => WebContents | null,
): void {
  registerIpcHandlers<Gen3dInvokeMap & DictationInvokeMap>(ipcMain, handlers, { allowSender });
  // Record HOW the renderer dies if it does. A blank window that ignores Cmd+R
  // is a dead render process, and only the main process can say why.
  installRendererHealth();
  app.on('before-quit', () => {
    // A held recogniser would outlive the window it was serving.
    dictationSession?.dispose();
    dictationSession = null;
    stopMemorySampling();
    eventsAbort.abort();
    sidecar?.dispose();
  });
}

/** Re-exported so tests can assert the stage union stays in sync. */
export type { Gen3dStage };
