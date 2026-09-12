/**
 * Generation manager — the Electron-main glue that turns a pi `generate_image`
 * request into a running mflux/MLX job and a live INLINE surface in the thread.
 *
 * It stands up a token-authed line-delimited JSON-RPC server on a Unix-domain
 * socket (@pi-desktop/gen-tools/contract), publishes the socket path + token on
 * the env BEFORE the first pi spawn (mirroring browser-agent.ts), owns the
 * unified-memory-aware {@link JobQueue}, resolves the catalog model into a
 * {@link GenJob}, and streams each job's progress to the renderer as
 * `gen:open` / `gen:update` events (candidate previews + step progress).
 *
 * ── One-line app wire-ups this module needs (NOT done here, to keep round-12
 *    files untouched) ─────────────────────────────────────────────────────────
 *   1. apps/desktop/package.json deps: add `@pi-desktop/gen-service`,
 *      `@pi-desktop/gen-tools` (+ renderer `@pi-desktop/gen-canvas`).
 *   2. apps/desktop/electron/pi/pi-main.ts: add `'gen-tools'` to
 *      EXTENSION_PACKAGE_DIRS so the `generate_image` tool loads via `-e`.
 *   3. apps/desktop/electron/ipc-contract.ts: spread `GenEventMap` into
 *      AppEventMap and `GenInvokeMap` into AppInvokeMap (from ./gen/gen-ipc-contract).
 *   4. apps/desktop/electron/main.ts: call `registerGenIpc({...})` on app-ready
 *      BEFORE the first pi spawn (like registerBrowserAgentIpc), passing a
 *      `createIpcEventSender<AppEventMap>()` send fn + `isTrustedIpcEvent`.
 *   5. Renderer: `useGenStream()` at the app root (src/chat/gen-stream.ts) folds
 *      `gen:open` / `gen:update` into the live-generation store the THREAD reads.
 *      It used to open a `gen-image` canvas tab; the user, round 21: "image/video/
 *      audio/media generation tools DO NOT GET SHOWN IN THE CANVAS…. they get
 *      shown inline, the large card, same as each studio would show."
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  activeModels,
  ComfyClient,
  defaultGenSpawn,
  defaultImageModel,
  defaultVideoModel,
  type GenEvent,
  type GenJob,
  GenServiceClient,
  getModel,
  JobQueue,
  jobFootprintGB,
  MODALITY_CATALOG,
  type ModalityModel,
  previewCostGB,
} from '@pi-desktop/gen-service';
import {
  GEN_SOCK_ENV,
  GEN_TOKEN_ENV,
  type GenBridgeRequest,
  type GenBridgeResponse,
  type GenerateAudioParams,
  type GenerateAudioResult,
  type GenerateImageParams,
  type GenerateImageResult,
  type GenerateVideoParams,
  type GenerateVideoResult,
  type GenModelSummary,
} from '@pi-desktop/gen-tools/contract';
import { createLogger, registerIpcHandlers } from '@pi-desktop/shared';
import { type IpcMain, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { bobbleDir, GENERATED_DIR, slug, uniqueName } from '../bobble-paths';
import { tierChild } from '../inference/worker-tier';
import {
  type AssetConsent,
  type EnsureAssetFn,
  type GenAssetNeed,
  makeComfyAssetGate,
} from './asset-gate';
import { audioOutputName, buildAudioJob, defaultAudioModel } from './audio-dispatch';
import { type ComfyInstallManager, GPL_CONSENT_DISCLOSURE } from './comfy-install';
import { surfaceModalityCatalog } from './gen-catalog-dto';
import type {
  GenCatalogInvokeMap,
  GenEventMap,
  GenInvokeMap,
  GenSurfacePayload,
} from './gen-ipc-contract';
import { createStillRenderer } from './hyperframes-still';
import { openStillWindow } from './hyperframes-window';
import { generateSvg, omniSvgFiles } from './omnisvg';
import { canEnhance, type EnhancerEndpoint, enhancePrompt } from './prompt-enhancer';
import {
  buildVideoJob,
  defaultExtractPosterFrame,
  type FrameExtractor,
  type HyperFramesRender,
  HyperFramesRunner,
  makeVideoAwareRunner,
} from './video-dispatch';

const log = createLogger('desktop:gen');

export interface GenManagerOptions {
  /** Yields the app window to stream surface updates to. */
  readonly getWindow: () => WebContents | null;
  /** Typed main→renderer sender (app wires `createIpcEventSender<AppEventMap>()`). */
  readonly sendEvent: <K extends keyof GenEventMap>(
    wc: WebContents,
    channel: K,
    payload: GenEventMap[K],
  ) => void;
  /** Guard renderer→main invokes (app passes `isTrustedIpcEvent`). Default: allow. */
  readonly isTrusted?: (event: IpcMainInvokeEvent) => boolean;
  /** Injectable uv resolver (app passes web-tools `ensureUv`). Default: PATH probe. */
  readonly resolveUv?: () => Promise<string>;
  /** Root dir for generated outputs. Default `<tmp>/pi-generated`. */
  readonly outputRoot?: string;
  /** Explicit worker.py path. Defaults to {@link resolveGenWorkerScript}. */
  readonly workerScript?: string;
  /** Max concurrent LIGHT jobs (default 2). Heavy models always run alone. */
  readonly maxConcurrent?: number;
  /**
   * May a HEAVY generation start right now?
   *
   * The power policy's answer (packages/inference/src/power-policy.ts). Under
   * real memory pressure a heavy job is gigabytes of extra resident memory
   * beside an already-resident chat model, and it is the single worst thing to
   * begin — so it is HELD until the machine is breathing again, never refused.
   * Light jobs still go through. Default: always allowed.
   */
  readonly heavyAllowed?: (
    footprintGB?: number,
  ) => boolean | { ok: boolean; reason?: string; never?: boolean };
  /**
   * ComfyUI http origin resolver for `comfyui`-backed video (LTX/Wan) jobs.
   * Default REJECTS (ComfyUI not configured) — the real app starts the supervisor
   * and returns its `http://127.0.0.1:<port>` origin (or a remote host).
   */
  readonly comfyResolveOrigin?: () => Promise<string>;
  /**
   * Node HyperFrames motion-graphics renderer (ffmpeg + headless Chrome). Default
   * emits a clear "not installed" error until the aux deps land.
   */
  readonly hyperFramesRender?: HyperFramesRender;
  /**
   * Where the PROMPT ENHANCER's small model lives, or null when there is none.
   *
   * Injected rather than read here so this module keeps knowing nothing about
   * the inference supervisor: the app hands it `getInferenceUtility()` (with an
   * env override for a dedicated tiny model), and a null simply turns the
   * feature off — `gen:enhance` then returns the prompt it was given.
   */
  readonly resolveEnhancerEndpoint?: () => EnhancerEndpoint | null;
  /** Poster-frame extractor for video self-critique. Default: ffmpeg best-effort. */
  readonly extractPosterFrame?: FrameExtractor;
  /**
   * Download-then-CONTINUE gate: awaited before a job is enqueued so a job whose
   * model/pack is missing PROMPTS the user, downloads on accept, then continues
   * the SAME job (see asset-gate.ts). Throws to abort (declined / failed).
   * Default: none (assets assumed present). When {@link comfyInstall} is given
   * and this is omitted, a ComfyUI gate is derived from it automatically.
   */
  readonly ensureAsset?: EnsureAssetFn;
  /**
   * The ComfyUI install-manager (comfy-install.ts). When provided, the
   * `gen:comfy-status` / `gen:comfy-consent` / `gen:comfy-start` invokes answer
   * from it (the modular-download UI), and — unless {@link ensureAsset} is set —
   * a download-then-continue gate for `comfyui`-backed jobs is built from it.
   */
  readonly comfyInstall?: Pick<ComfyInstallManager, 'status' | 'recordConsent' | 'run'>;
}

/**
 * The download need for a model, or `undefined` when nothing must be fetched
 * up-front. Only `comfyui`-backed entries (LTX / Wan video, advanced ComfyUI
 * image/music) carry a downloadable pack — mflux image auto-fetches on the
 * worker, and HyperFrames is pure-CPU — so only they gate. The pack id matches
 * the catalog id (comfy-install keeps them in sync).
 */
function needForModel(model: ModalityModel): GenAssetNeed | undefined {
  if (model.backend !== 'comfyui') return undefined;
  return {
    kind: 'pack',
    id: model.id,
    label: model.label,
    approxSizeGB: model.approxSizeGB,
  };
}

let server: net.Server | null = null;
let token = '';

function defaultSocketPath(): string {
  return path.join(tmpdir(), `pi-gen-${process.pid}-${randomBytes(4).toString('hex')}.sock`);
}

function summariseModel(m: ModalityModel): GenModelSummary {
  return {
    id: m.id,
    modality: m.modality,
    label: m.label,
    license: m.license,
    commercialUse: m.commercialUse,
    runsLocally: m.runsLocally,
    reserved: m.reserved === true,
  };
}

/**
 * Parse `<w>x<h>` into even, bounded dims. Mirrors gen-tools.
 *
 * THE DEFAULT IS PER MODALITY, because a still and a clip are not the same ask.
 * 1024x1024 is a good picture and a bad video: MEASURED on an M5 Pro 24GB, Wan
 * 2.1 renders 512x512x49 in 521s and the same clip at 1024x1024 is four times
 * the pixels — a "two second video" that takes the better part of an hour. The
 * video tool says "Default per model" and the graphs carry 640x352 / 608x352 /
 * 512x512 for exactly this reason; a caller that names no size should land near
 * those, not four times above the largest of them.
 */
const IMAGE_DEFAULT_SIZE = { width: 1024, height: 1024 };
/** 0.2 megapixels at 16:9 — the first row of every LTX/H3 resolution table. */
const VIDEO_DEFAULT_SIZE = { width: 640, height: 352 };

function parseSize(
  size: string | undefined,
  fallback: { width: number; height: number } = IMAGE_DEFAULT_SIZE,
): { width: number; height: number } {
  if (size === undefined) return fallback;
  const m = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i.exec(size.trim());
  if (m === null) return fallback;
  const clamp = (n: number): number => Math.max(256, Math.min(1536, Math.round(n / 16) * 16));
  return { width: clamp(Number(m[1])), height: clamp(Number(m[2])) };
}

/**
 * A file path → a src the renderer can actually load.
 *
 * THE SWAP THIS COMMENT ASKED FOR. It used to read: "if the renderer's CSP
 * blocks file://, the app should serve these via its media protocol instead
 * (one-line swap here)." The CSP does block it, and always has —
 * `img-src 'self' data: blob: pd-file:` (vite.config.ts), no `file:` — so every
 * decoded step preview and every finished candidate this stream has ever
 * published was refused by the renderer before it reached a pixel. Nothing said
 * so; a blocked `<img>` is silent, and the studio simply showed its shimmer for
 * the whole run while the frames it was waiting for arrived and were dropped.
 *
 * `pd-file://f/<abs path>` is the app's own media scheme (canvas/canvas-main.ts):
 * fenced to the working roots, of which `~/Bobble` — where every generated file
 * lands — is one.
 */
function toSrc(p: string): string {
  return `pd-file://f${p.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * What main gets back: the guardian's levers on the queue.
 *
 * The queue is private to this file for every other purpose; these three are
 * the only things a process watching the machine needs — is heavy work running
 * (sample faster), stop it (with the reason the user will read), and re-ask
 * admission when the machine is breathing again.
 */
export interface GenQueueControl {
  /** Any generation running — the guardian samples every second while one is. */
  readonly running: () => boolean;
  readonly shedRunning: (reason: string) => string[];
  readonly reconsider: () => void;
}

export function registerGenIpc(opts: GenManagerOptions): GenQueueControl {
  /*
   * ~/Bobble/generated, not the OS temp tree. the user: "no complicated
   * var/askldfjh;lkh/... types of things". A rendered animation used to land in
   * /var/folders/4h/nq1c73…/T/pi-generated/gen_1785566138272_fc7490/ — which
   * nobody can find, the model cannot usefully name back to the user, and the OS
   * deletes whenever it likes.
   */
  const outputRoot = opts.outputRoot ?? bobbleDir(GENERATED_DIR);
  /*
   * TELL THE CLIENT WHERE worker.py IS. It cannot work it out for itself here.
   *
   * `resolveWorkerScript` falls back to `packageRoot()`, which is derived from
   * `import.meta.url` — and gen-service is BUNDLED into the Electron main, so
   * that resolves to apps/desktop/dist-electron/, and `..` yields
   * apps/desktop/python/worker.py. Which does not exist. Measured, from a real
   * generate_image call:
   *
   *   gen worker exited (code 2) … can't open file
   *   '/Users/user/Desktop/OSS-harness/apps/desktop/python/worker.py'
   *
   * So EVERY image generation failed, and the model — asked to annotate a
   * screenshot — watched its tool die and fell back to drawing on a blank canvas.
   * The PI_GEN_WORKER_PATH escape hatch existed for exactly this and nothing set
   * it.
   */
  const client = new GenServiceClient({
    resolveUv: opts.resolveUv,
    ...(opts.workerScript !== undefined ? { workerScript: opts.workerScript } : {}),
    // Behind the pointer — see inference/worker-tier.ts.
    spawnFn: (command, args, o) => {
      const child = defaultGenSpawn(command, args, o);
      tierChild(child, 'gen worker');
      return child;
    },
  });
  // Video routes to a persistent ComfyUI server (LTX/Wan) or the Node HyperFrames
  // runner — never the uv worker. Both default to a clear "not configured" error
  // until their runtimes install; image (mflux) still runs on the uv `client`.
  const comfy = new ComfyClient({
    resolveOrigin:
      opts.comfyResolveOrigin ??
      (() =>
        Promise.reject(
          new Error('ComfyUI is not configured for local video generation on this machine'),
        )),
  });
  /*
   * HYPERFRAMES NOW RENDERS. The default used to be
   * `hyperFramesRenderUnavailable` — a stub that refused with "needs ffmpeg +
   * headless Chrome" — so every motion commission ended in that message and the
   * motion specialist's charter described a renderer that did not exist. Neither
   * dependency was real: Chromium is the process we are in, and ffmpeg was only
   * for encoding, which is the part the user cut when he asked for stills.
   */
  const hyperframes = new HyperFramesRunner(
    opts.hyperFramesRender ??
      createStillRenderer({
        openWindow: openStillWindow,
        writeFile: (file: string, data: Buffer) => writeFile(file, data),
      }),
  );
  const extractPoster = opts.extractPosterFrame ?? defaultExtractPosterFrame;
  const jobQueue = new JobQueue({
    maxConcurrent: opts.maxConcurrent ?? 2,
    runner: makeVideoAwareRunner({ comfy, hyperframes, fallback: client }),
    ...(opts.heavyAllowed !== undefined ? { heavyAllowed: opts.heavyAllowed } : {}),
  });

  const send = <K extends keyof GenEventMap>(channel: K, payload: GenEventMap[K]): void => {
    const wc = opts.getWindow();
    if (wc !== null && !wc.isDestroyed()) opts.sendEvent(wc, channel, payload);
  };

  /*
   * A JOB HELD BY THE MACHINE SAYS SO. The queue steps over a heavy job that
   * does not fit (job-queue.ts) and, without this, the room would show the mark
   * animating over "Loading" indefinitely — the same picture as a hang. Each
   * handler registers where its own note goes; the queue's `held` event lands
   * there as the line under the bar.
   */
  const noteSinks = new Map<string, (line: string) => void>();
  jobQueue.on((e) => {
    if (e.type === 'held') noteSinks.get(e.jobId)?.(`Waiting for memory — ${e.reason}`);
  });

  // ── download-then-continue gate (asset-gate.ts) ─────────────────────────────
  // A job whose ComfyUI pack is missing PROMPTS the user, downloads on accept,
  // then continues the SAME job. Explicit `ensureAsset` wins (tests); otherwise a
  // ComfyUI gate is derived from the injected install-manager. A single-flight
  // pending consent is resolved by the `gen:comfy-start` invoke (renderer Accept).
  let pendingConsent: ((consent: AssetConsent) => void) | null = null;
  const awaitConsent = (_need: GenAssetNeed): Promise<AssetConsent> => {
    // Surface the one-time GPL disclosure; the modular-download UI drives Accept.
    send('gen:comfy-install', { kind: 'consent-required', disclosure: GPL_CONSENT_DISCLOSURE });
    return new Promise<AssetConsent>((resolve) => {
      pendingConsent = resolve;
    });
  };
  const ensureAsset: EnsureAssetFn | undefined =
    opts.ensureAsset ??
    (opts.comfyInstall !== undefined
      ? makeComfyAssetGate(opts.comfyInstall, { awaitConsent })
      : undefined);

  /**
   * The worker's own words, tidied enough to sit in a one-line status.
   *
   * These are stderr lines: progress bars, HuggingFace download tickers, mflux's
   * own logging. The last non-empty line is what the job is doing NOW, which is
   * the only part worth showing; carriage returns inside a progress bar mean the
   * "line" can carry several frames, so only the final segment is kept.
   */
  function noteFrom(text: string): string | undefined {
    const last = text
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .pop();
    if (last === undefined) return undefined;
    return last.length > 120 ? `${last.slice(0, 119)}…` : last;
  }

  /** A weights fetch, as a sentence rather than a tqdm frame. */
  function downloadNote(detail: string | undefined, ratio: number | undefined): string | undefined {
    const pct = ratio === undefined ? undefined : `${Math.round(ratio * 100)}%`;
    if (ratio === 1) return 'Weights ready';
    if (pct !== undefined) return `Fetching model weights · ${pct}`;
    return detail !== undefined && detail.length > 0 ? noteFrom(detail) : 'Fetching model weights';
  }

  async function handleGenerate(raw: GenerateImageParams): Promise<GenerateImageResult> {
    const model = getModel(raw.model ?? defaultImageModel().id);
    if (model === undefined || model.modality !== 'image' || model.mflux === undefined) {
      throw new Error(`unknown or non-image model "${raw.model ?? ''}"`);
    }
    const jobId = `gen_${Date.now()}_${randomBytes(3).toString('hex')}`;
    // The FOLDER is named after what was asked for; jobId stays the internal id.
    const outputDir = path.join(outputRoot, uniqueName(outputRoot, slug(raw.prompt, 'image')));
    await mkdir(outputDir, { recursive: true });

    const { width, height } = parseSize(raw.size);
    const n = Math.max(1, Math.min(8, Math.round(raw.n ?? 1)));
    const base = raw.seed ?? randomInt(0, 1_000_000_000);
    const seeds = Array.from({ length: n }, (_, i) => base + i);
    const steps = raw.steps ?? model.defaultSteps;
    // Only when asked for: absent means the model's own default, which is what
    // every caller that does not open the gears wants.
    const guidance = raw.guidance;

    /*
     * PREVIEWS, IF THE MACHINE CAN AFFORD THEM.
     *
     * The card's real denoise comes from a decode at every step, and MEASURED
     * that is ~4.5 GB on top of the job at 512² (catalog: previewCostGB) —
     * exactly the margin between a job that fits beside the reserve and one
     * that takes the machine to 20% free and gets shed. So the job is admitted
     * with previews when they fit, and without them when only the picture
     * does; the pending card plays the mark in that case, which is what it is
     * for. The user gets the picture either way, which is the point.
     */
    const bare = jobFootprintGB(model, width * height);
    const withPreviews = bare + previewCostGB(width * height);
    const previewsAllowed = opts.heavyAllowed?.(withPreviews) ?? true;
    const stepPreviews =
      typeof previewsAllowed === 'boolean' ? previewsAllowed : previewsAllowed.ok;
    const footprintGB = stepPreviews ? withPreviews : bare;

    const job: GenJob = {
      id: jobId,
      modality: 'image',
      backend: 'mflux',
      outputDir,
      image: {
        prompt: raw.prompt,
        modelId: model.id,
        mfluxCommand: model.mflux.command,
        mfluxModel: model.mflux.model,
        width,
        height,
        steps,
        seeds,
        stepPreviews,
        negativePrompt: raw.negativePrompt,
        ...(guidance !== undefined ? { guidance } : {}),
        // An edit rather than a fresh generation — see ImageJobSpec.imagePath.
        ...(raw.inputImage !== undefined && raw.inputImage.length > 0
          ? { imagePath: raw.inputImage }
          : {}),
        ...(raw.strength !== undefined ? { imageStrength: raw.strength } : {}),
        quantize: model.defaultQuantize,
      },
    };

    const tabId = `pi:gen-${jobId}`;
    const modelInfo = { id: model.id, label: model.label, license: model.license };
    // Mutable surface state we re-send on each event.
    const candidates: GenSurfacePayload['candidates'][number][] = seeds.map((seed) => ({
      seed,
      status: 'pending' as const,
    }));
    let progress: GenSurfacePayload['progress'];
    // What the worker last said it was doing — see GenSurfacePayload.note.
    let note: string | undefined;

    const payload = (status: GenSurfacePayload['status'], error?: string): GenSurfacePayload => ({
      modality: 'image',
      model: modelInfo,
      prompt: raw.prompt,
      size: { width, height },
      candidates: candidates.map((c) => ({ ...c })),
      progress,
      status,
      error,
      note,
    });

    send('gen:open', { tabId, payload: payload('generating') });

    const onEvent = (event: GenEvent): void => {
      if (event.event === 'progress') {
        const c = candidates[event.candidate];
        if (c !== undefined) {
          candidates[event.candidate] = {
            ...c,
            status: 'generating',
            previewSrc: event.previewPath !== undefined ? toSrc(event.previewPath) : c.previewSrc,
          };
        }
        progress = { candidate: event.candidate, step: event.step, total: event.total };
        send('gen:update', { tabId, payload: payload('generating') });
      } else if (event.event === 'candidate') {
        const c = candidates[event.index];
        if (c !== undefined) {
          candidates[event.index] = {
            ...c,
            status: 'done',
            finalSrc: toSrc(event.output.outputPath),
          };
        }
        send('gen:update', { tabId, payload: payload('generating') });
      } else if (event.event === 'log' || event.event === 'download') {
        /*
         * The pre-first-step phase is MOST of a cold run — MEASURED on the user's
         * Mac with the weights already cached: 94 seconds before step 1 — and
         * these are the only events that know what is happening in it. Both were
         * being dropped, so the room said "Starting…" throughout and he reported
         * the studio as not working at all.
         */
        const line =
          event.event === 'log' ? noteFrom(event.text) : downloadNote(event.detail, event.ratio);
        if (line !== undefined && line !== note) {
          note = line;
          send('gen:update', { tabId, payload: payload('generating') });
        }
      }
    };

    try {
      // Download-then-continue: an mflux image needs no up-front pack, so this is
      // a no-op here; the seam is uniform so a future comfyui-backed image gates too.
      const need = needForModel(model);
      if (need !== undefined && ensureAsset !== undefined) await ensureAsset(need);
      noteSinks.set(jobId, (line) => {
        note = line;
        send('gen:update', { tabId, payload: payload('generating') });
      });
      const outputs = await jobQueue.enqueue(job, {
        heavy: model.heavy,
        footprintGB,
        onEvent,
      }).result;
      progress = undefined;
      send('gen:update', { tabId, payload: payload('done') });
      return { jobId, outputs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send('gen:update', { tabId, payload: payload('error', message) });
      throw err;
    } finally {
      noteSinks.delete(jobId);
    }
  }

  async function handleGenerateVideo(raw: GenerateVideoParams): Promise<GenerateVideoResult> {
    const model = getModel(raw.model ?? defaultVideoModel().id);
    if (model === undefined || model.modality !== 'video') {
      throw new Error(`unknown or non-video model "${raw.model ?? ''}"`);
    }
    const jobId = `gen_${Date.now()}_${randomBytes(3).toString('hex')}`;
    // The FOLDER is named after what was asked for; jobId stays the internal id.
    const outputDir = path.join(outputRoot, uniqueName(outputRoot, slug(raw.prompt, 'animation')));
    await mkdir(outputDir, { recursive: true });

    const clamp = (n: number, lo: number, hi: number): number =>
      Math.max(lo, Math.min(hi, Math.round(n)));
    const { width, height } = parseSize(raw.size, VIDEO_DEFAULT_SIZE);
    const seconds = clamp(raw.seconds ?? 5, 1, 60);
    const fps = clamp(raw.fps ?? 24, 1, 60);
    const seed = raw.seed ?? randomInt(0, 1_000_000_000);

    const job: GenJob = buildVideoJob(
      model,
      {
        prompt: raw.prompt,
        width,
        height,
        seconds,
        fps,
        // The caller's step count when it sent one — the video studio's gears
        // offer it, and a knob the pipeline discards is worse than no knob.
        // Clamped because a stray 400 here is many minutes of frames.
        steps: raw.steps !== undefined ? clamp(raw.steps, 1, 100) : model.defaultSteps,
        negativePrompt: raw.negativePrompt,
        seed,
      },
      jobId,
      outputDir,
    );

    const tabId = `pi:gen-${jobId}`;
    const modelInfo = { id: model.id, label: model.label, license: model.license };
    // One candidate (video generation is one clip per job); reuse the image
    // surface payload shape (candidate.finalSrc carries the produced MP4 url).
    let candidate: GenSurfacePayload['candidates'][number] = { seed, status: 'pending' };
    let progress: GenSurfacePayload['progress'];
    // What the machine last said about this job — the held-for-memory line.
    let note: string | undefined;

    const payload = (status: GenSurfacePayload['status'], error?: string): GenSurfacePayload => ({
      modality: 'video',
      model: modelInfo,
      prompt: raw.prompt,
      size: { width, height },
      candidates: [{ ...candidate }],
      progress,
      status,
      error,
      note,
    });

    send('gen:open', { tabId, payload: payload('generating') });

    const onEvent = (event: GenEvent): void => {
      if (event.event === 'progress') {
        candidate = { ...candidate, status: 'generating' };
        progress = { candidate: 0, step: event.step, total: event.total };
        send('gen:update', { tabId, payload: payload('generating') });
      } else if (event.event === 'candidate') {
        candidate = { ...candidate, status: 'done', finalSrc: toSrc(event.output.outputPath) };
        send('gen:update', { tabId, payload: payload('generating') });
      }
    };

    try {
      // Download-then-continue: a comfyui-backed video (LTX / Wan) whose weights
      // pack is missing PROMPTS the user, downloads on accept, then continues here.
      const need = needForModel(model);
      if (need !== undefined && ensureAsset !== undefined) await ensureAsset(need);
      noteSinks.set(jobId, (line) => {
        note = line;
        send('gen:update', { tabId, payload: payload('generating') });
      });
      const outputs = await jobQueue.enqueue(job, {
        heavy: model.heavy,
        footprintGB: jobFootprintGB(model, width * height),
        onEvent,
        /*
         * THE MODEL'S OWN EXTRA DEPENDENCIES.
         *
         * MEASURED: the Audio Studio's first real run died with "mlx-audio TTS
         * exited with code 1". Kokoro's catalogue entry carries
         * `auxDeps: ['misaki[en]']` — its G2P front-end, without which the
         * KokoroPipeline import fails — and nothing was passing it to the uv
         * env. The queue has taken `extraWith` all along; no caller used it.
         */
        ...(model.auxDeps !== undefined && model.auxDeps.length > 0
          ? { extraWith: model.auxDeps }
          : {}),
      }).result;
      progress = undefined;
      send('gen:update', { tabId, payload: payload('done') });
      // A chat model can't watch an MP4 — extract a still poster frame (best-effort).
      let posterFramePath: string | undefined;
      const first = outputs[0];
      if (first !== undefined) {
        posterFramePath = await extractPoster(first.outputPath, outputDir);
      }
      return { jobId, outputs, posterFramePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send('gen:update', { tabId, payload: payload('error', message) });
      throw err;
    } finally {
      noteSinks.delete(jobId);
    }
  }

  /**
   * SPEECH, MUSIC AND SOUND EFFECTS.
   *
   * The audio side of the catalogue was the most complete unreachable thing in
   * the app — eleven models, three ComfyUI graphs, a fully written `run_audio`
   * in the Python worker, and a `GenJob.audio` arm in the protocol — with no
   * caller, because `dispatch()` knew `generate` and `generateVideo` and
   * nothing else. This is that caller.
   *
   * It runs through the SAME JobQueue as image and video, deliberately: one
   * queue means one cancel path, one heavy-job gate and one place where a
   * second request waits rather than fighting the first for the GPU.
   */
  async function handleGenerateAudio(raw: GenerateAudioParams): Promise<GenerateAudioResult> {
    const kind = raw.kind ?? 'speech';
    const fallback = defaultAudioModel(kind, activeModels());
    const requested = raw.model ?? fallback?.id ?? '';
    const model = getModel(requested);
    if (model === undefined || model.modality !== 'audio') {
      /*
       * SAY WHICH OF THE TWO THINGS WENT WRONG.
       *
       * `unknown or non-audio model ""` was the message for the COMMON case —
       * `generate_music` with no model named — and it described neither the
       * cause nor the fix. Music and SFX route to ComfyUI, every ComfyUI audio
       * entry is `reserved`, `activeModels()` drops reserved entries, so the
       * default resolved to nothing and the empty string was reported as if the
       * caller had asked for it.
       */
      if (requested === '') {
        throw new Error(
          kind === 'speech'
            ? 'no speech model is available on this machine'
            : `no ${kind === 'music' ? 'music' : 'sound-effect'} model is set up on this machine yet — those run on ComfyUI graphs, and the Audio studio is where they are installed. Speech (text-to-speech) works without any of that.`,
        );
      }
      throw new Error(`unknown or non-audio model "${requested}"`);
    }

    const jobId = `gen_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const outputDir = path.join(
      outputRoot,
      uniqueName(outputRoot, slug(raw.prompt, audioOutputName(kind, raw.prompt))),
    );
    await mkdir(outputDir, { recursive: true });

    const count = Math.max(1, Math.min(8, Math.round(raw.count ?? 1)));
    const base = raw.seed ?? randomInt(0, 1_000_000_000);
    const seeds = Array.from({ length: count }, (_, i) => base + i);

    const job: GenJob = buildAudioJob(
      model,
      {
        prompt: raw.prompt,
        kind,
        seeds,
        ...(raw.seconds !== undefined ? { seconds: raw.seconds } : {}),
        ...(raw.steps !== undefined ? { steps: raw.steps } : {}),
        ...(raw.voice !== undefined ? { voice: raw.voice } : {}),
        ...(raw.speed !== undefined ? { speed: raw.speed } : {}),
        ...(raw.lang !== undefined ? { lang: raw.lang } : {}),
        ...(raw.refAudio !== undefined ? { refAudio: raw.refAudio } : {}),
        ...(raw.refText !== undefined ? { refText: raw.refText } : {}),
      },
      jobId,
      outputDir,
    );

    const tabId = `pi:gen-${jobId}`;
    const modelInfo = { id: model.id, label: model.label, license: model.license };
    let candidates: GenSurfacePayload['candidates'] = seeds.map((seed) => ({
      seed,
      status: 'pending' as const,
    }));
    let progress: GenSurfacePayload['progress'];
    // What the machine last said about this job — the held-for-memory line.
    let note: string | undefined;

    const payload = (status: GenSurfacePayload['status'], error?: string): GenSurfacePayload => ({
      modality: 'audio',
      model: modelInfo,
      prompt: raw.prompt,
      candidates: candidates.map((c) => ({ ...c })),
      progress,
      status,
      error,
      note,
    });

    /*
     * AUDIO STREAMS AGAIN, BECAUSE THE STREAM NO LONGER MEANS "CANVAS".
     *
     * These events used to be built and thrown away. The only consumer was the
     * canvas hook, `gen-image` was the only registered surface, and it rendered
     * candidates as `<img>` — so an audio job drew a BROKEN IMAGE labelled
     * "Candidate 1 (seed …)" in the rail beside a thread already showing the
     * same clip with a working waveform. Suppressing the events was the right
     * fix for a stream that could only ever end up in a picture frame.
     *
     * Generation is inline now (the user: "they get shown inline, the large card"),
     * and `modality` above says which card. So the events are what they always
     * should have been: progress for the sound being made, delivered to the one
     * place the sound itself is going to appear.
     */
    const canvasPush = (name: 'gen:open' | 'gen:update', p: GenSurfacePayload): void => {
      send(name, { tabId, payload: p });
    };
    canvasPush('gen:open', payload('generating'));

    let doneCount = 0;
    const onEvent = (event: GenEvent): void => {
      if (event.event === 'progress') {
        progress = { candidate: doneCount, step: event.step, total: event.total };
        canvasPush('gen:update', payload('generating'));
      } else if (event.event === 'candidate') {
        candidates = candidates.map((c, i) =>
          i === doneCount ? { ...c, status: 'done', finalSrc: toSrc(event.output.outputPath) } : c,
        );
        doneCount += 1;
        canvasPush('gen:update', payload('generating'));
      }
    };

    try {
      // Same download-then-continue courtesy the video path gets: a ComfyUI music
      // or SFX model whose weights pack is missing prompts, downloads, continues.
      const need = needForModel(model);
      if (need !== undefined && ensureAsset !== undefined) await ensureAsset(need);
      noteSinks.set(jobId, (line) => {
        note = line;
        send('gen:update', { tabId, payload: payload('generating') });
      });
      const outputs = await jobQueue.enqueue(job, {
        heavy: model.heavy,
        footprintGB: jobFootprintGB(model),
        onEvent,
        /*
         * THE MODEL'S OWN EXTRA DEPENDENCIES.
         *
         * MEASURED: the Audio Studio's first real run died with "mlx-audio TTS
         * exited with code 1". Kokoro's catalogue entry carries
         * `auxDeps: ['misaki[en]']` — its G2P front-end, without which the
         * KokoroPipeline import fails — and nothing was passing it to the uv
         * env. The queue has taken `extraWith` all along; no caller used it.
         */
        ...(model.auxDeps !== undefined && model.auxDeps.length > 0
          ? { extraWith: model.auxDeps }
          : {}),
      }).result;
      progress = undefined;
      canvasPush('gen:update', payload('done'));
      return {
        jobId,
        outputs: outputs.map((o) => ({
          path: o.outputPath,
          model: o.model,
          ...(o.seed !== undefined ? { seed: o.seed } : {}),
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      canvasPush('gen:update', payload('error', message));
      throw err;
    } finally {
      noteSinks.delete(jobId);
    }
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'generate':
        return handleGenerate(params as unknown as GenerateImageParams);
      case 'generateVideo':
        return handleGenerateVideo(params as unknown as GenerateVideoParams);
      case 'generateAudio':
        return handleGenerateAudio(params as unknown as GenerateAudioParams);
      case 'generateSvg': {
        /* OmniSVG: its own short-lived llama-server, not the worker queue —
           see omnisvg.ts. The folder is named after the ask like every other
           generation, so it sits beside the images in Generated. */
        const p = params as {
          prompt?: string;
          images?: string[];
          candidates?: number;
          outPath?: string;
        };
        const name = slug(p.prompt ?? p.images?.[0] ?? 'svg', 'svg');
        const outputDir = path.join(outputRoot, uniqueName(outputRoot, name));
        const result = await generateSvg({ ...p, outputDir });
        for (const o of result.outputs) send('gen:open-file', { path: o.outputPath });
        return result;
      }
      case 'omnisvgStatus':
        return omniSvgFiles();
      case 'cancel': {
        const jobId = String((params as { jobId?: unknown }).jobId ?? '');
        return { canceled: jobQueue.cancel(jobId) };
      }
      case 'listModels':
        return activeModels().map(summariseModel);
      default:
        throw new Error(`unknown gen method: ${method}`);
    }
  }

  // ── socket server (mirrors browser-agent.ts) ────────────────────────────────
  async function handleLine(socket: net.Socket, line: string): Promise<void> {
    let req: GenBridgeRequest;
    try {
      req = JSON.parse(line) as GenBridgeRequest;
    } catch {
      return;
    }
    if (typeof req.id !== 'number') return;
    const respond = (patch: Partial<GenBridgeResponse>): void => {
      try {
        socket.write(`${JSON.stringify({ id: req.id, ok: true, ...patch })}\n`);
      } catch {
        /* peer gone */
      }
    };
    if (req.token !== token) {
      respond({ ok: false, error: 'unauthorized' });
      return;
    }
    try {
      respond({ ok: true, result: await dispatch(req.method, req.params ?? {}) });
    } catch (err) {
      respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleConnection(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const l = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (l.trim() !== '') void handleLine(socket, l);
        nl = buffer.indexOf('\n');
      }
    });
  }

  const socketPath = process.env[GEN_SOCK_ENV] ?? defaultSocketPath();
  token = process.env[GEN_TOKEN_ENV] ?? randomBytes(24).toString('hex');
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* stale socket */
  }
  server = net.createServer((socket) => handleConnection(socket));
  server.on('error', (e) => log.error('gen bridge server error', { error: String(e) }));
  server.listen(socketPath, () => log.info('gen bridge listening', { socketPath }));
  // Publish for the pi child spawned later (env read at spawn time).
  process.env[GEN_SOCK_ENV] = socketPath;
  process.env[GEN_TOKEN_ENV] = token;

  // Renderer→main: cancel + tab-mounted ack.
  const guard = (event: IpcMainInvokeEvent, channel: string): void => {
    if (opts.isTrusted !== undefined && !opts.isTrusted(event)) {
      throw new Error(`[gen] rejected "${channel}": untrusted`);
    }
  };
  /*
   * The renderer's way in — the studios. Routes to the SAME three handlers the
   * agent bridge reaches, so a studio job and a chat job are the same job: one
   * queue, one cancel, one heavy gate, one asset prompt. Errors come back as a
   * field rather than a rejection so a studio can render the sentence instead of
   * an unhandled promise.
   */
  ipcMain.handle(
    'gen:generate',
    async (
      _event,
      req: GenInvokeMap['gen:generate']['request'],
    ): Promise<GenInvokeMap['gen:generate']['response']> => {
      try {
        if (req.kind === 'audio') {
          const r = await handleGenerateAudio({
            prompt: req.prompt,
            kind: req.audioKind ?? 'speech',
            ...(req.model !== undefined ? { model: req.model } : {}),
            ...(req.seconds !== undefined ? { seconds: req.seconds } : {}),
            ...(req.steps !== undefined ? { steps: req.steps } : {}),
            ...(req.voice !== undefined ? { voice: req.voice } : {}),
            ...(req.speed !== undefined ? { speed: req.speed } : {}),
            ...(req.lang !== undefined ? { lang: req.lang } : {}),
            ...(req.refAudio !== undefined ? { refAudio: req.refAudio } : {}),
            ...(req.refText !== undefined ? { refText: req.refText } : {}),
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
            ...(req.n !== undefined ? { count: req.n } : {}),
          });
          return { jobId: r.jobId, outputs: r.outputs };
        }
        if (req.kind === 'video') {
          const r = await handleGenerateVideo({
            prompt: req.prompt,
            ...(req.model !== undefined ? { model: req.model } : {}),
            ...(req.seconds !== undefined ? { seconds: req.seconds } : {}),
            ...(req.size !== undefined ? { size: req.size } : {}),
            ...(req.fps !== undefined ? { fps: req.fps } : {}),
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
            ...(req.negativePrompt !== undefined ? { negativePrompt: req.negativePrompt } : {}),
          });
          return {
            jobId: r.jobId,
            outputs: r.outputs.map((o) => ({
              path: o.outputPath,
              ...(o.seed !== undefined ? { seed: o.seed } : {}),
              model: o.model,
            })),
          };
        }
        const r = await handleGenerate({
          prompt: req.prompt,
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.size !== undefined ? { size: req.size } : {}),
          ...(req.n !== undefined ? { n: req.n } : {}),
          ...(req.steps !== undefined ? { steps: req.steps } : {}),
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
          ...(req.negativePrompt !== undefined ? { negativePrompt: req.negativePrompt } : {}),
        });
        return {
          jobId: r.jobId,
          outputs: r.outputs.map((o) => ({
            path: o.outputPath,
            ...(o.seed !== undefined ? { seed: o.seed } : {}),
            model: o.model,
          })),
        };
      } catch (err) {
        return {
          jobId: '',
          outputs: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  /*
   * PROMPT ENHANCEMENT, on the way to the same button.
   *
   * Deliberately a separate round trip rather than a flag on `gen:generate`: the
   * studio shows the rewritten prompt in the composer BEFORE it runs, because a
   * rewrite you cannot see is a model quietly changing your words, and the whole
   * feature is only acceptable if you can read it, edit it, or switch it off.
   */
  ipcMain.handle(
    'gen:enhance',
    async (
      event,
      req: GenInvokeMap['gen:enhance']['request'],
    ): Promise<GenInvokeMap['gen:enhance']['response']> => {
      guard(event, 'gen:enhance');
      const endpoint = opts.resolveEnhancerEndpoint?.() ?? null;
      if (endpoint === null || !canEnhance(req.kind, req.model)) {
        return { prompt: req.prompt, changed: false };
      }
      const prompt = await enhancePrompt({
        kind: req.kind,
        prompt: req.prompt,
        endpoint,
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
      return { prompt, changed: prompt.trim() !== req.prompt.trim() };
    },
  );

  ipcMain.handle('gen:cancel', (event, req: { jobId: string }) => {
    guard(event, 'gen:cancel');
    return { canceled: jobQueue.cancel(req.jobId) };
  });
  ipcMain.handle('gen:register', (event) => {
    guard(event, 'gen:register');
    return { ok: true };
  });

  // ComfyUI modular-download install manager (comfy-install.ts). Registered only
  // when a manager is injected, so the model-browser install UI + the
  // download-then-continue gate answer from the SAME manager. The manager streams
  // its own progress via its `emit` dep (main wires it to `send('gen:comfy-install')`).
  const installer = opts.comfyInstall;
  if (installer !== undefined) {
    ipcMain.handle(
      'gen:comfy-status',
      async (event, req: GenInvokeMap['gen:comfy-status']['request']) => {
        guard(event, 'gen:comfy-status');
        return { state: await installer.status(req?.acceptedLicenses) };
      },
    );
    ipcMain.handle('gen:comfy-consent', async (event) => {
      guard(event, 'gen:comfy-consent');
      await installer.recordConsent();
      return { ok: true };
    });
    ipcMain.handle(
      'gen:comfy-start',
      async (event, req: GenInvokeMap['gen:comfy-start']['request']) => {
        guard(event, 'gen:comfy-start');
        // A pending download-then-continue gate takes precedence: Accept resolves
        // it (the gate runs the install + continues the job); don't double-run here.
        if (pendingConsent !== null) {
          const resolve = pendingConsent;
          pendingConsent = null;
          resolve({ accepted: true, acceptedLicenses: req.acceptedLicenses });
          return { state: await installer.status(req.acceptedLicenses) };
        }
        return { state: await installer.run(req.packIds, req.acceptedLicenses) };
      },
    );
  }

  return {
    running: () => jobQueue.runningCount > 0,
    shedRunning: (reason) => jobQueue.shedRunning(reason),
    reconsider: () => jobQueue.reconsider(),
  };
}

/**
 * Surface the vetted modality catalog to the renderer as plain DTOs
 * (`gen:modality-catalog`), mirroring how `registerLlmIpc` surfaces the
 * inference catalog. Deliberately SEPARATE from {@link registerGenIpc}: the
 * model browser must be able to enumerate every vetted generation model without
 * standing up the generation socket bridge (that lands with gen-as-tools). The
 * renderer's `useGenStore` consumes the result; nothing here touches the
 * gen-service barrel on the renderer side.
 */
export function registerGenCatalogIpc(
  ipc: IpcMain,
  allowSender: (event: unknown) => boolean,
): void {
  registerIpcHandlers<GenCatalogInvokeMap>(
    ipc,
    {
      // Tool-only rows (e.g. hyperframes) are filtered here — the model browser
      // enumerates MODELS, not the agent's generation tools.
      'gen:modality-catalog': () => ({ models: surfaceModalityCatalog(MODALITY_CATALOG) }),
    },
    { allowSender },
  );
}

/** Test/lifecycle hook: close the socket server. */
export function disposeGen(): void {
  server?.close();
  server = null;
}
