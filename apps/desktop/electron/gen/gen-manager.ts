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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  activeModels,
  bundledWheelPath,
  ComfyClient,
  default3dModel,
  defaultGenSpawn,
  defaultImageModel,
  defaultVideoModel,
  type GenEvent,
  type GenJob,
  type GenOutput,
  GenServiceClient,
  getModel,
  imageTo3dTemplateFor,
  JobQueue,
  jobFootprintGB,
  MODALITY_CATALOG,
  type ModalityModel,
  type ModelFinish,
  modelsForModality,
  previewCostGB,
  resolveWorkerScript,
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
import { type GenModulesManager, moduleForBackend, weightsModuleFor } from './gen-modules';
import { guardRun } from './guardian-main';
import { createStillRenderer } from './hyperframes-still';
import { openStillWindow } from './hyperframes-window';
import { buildComfyImageJob, isComfyImageModel } from './image-dispatch';
import { createRoomKeeper, type RoomKeeper } from './make-room';
import { generateSvg, omniSvgFiles } from './omnisvg';
import { omniSvgPictureBase64, vfigFigureBase64 } from './omnisvg-picture';
import { PendingJobs, unlessStopped } from './pending-jobs';
import { canEnhance, type EnhancerEndpoint, enhancePrompt } from './prompt-enhancer';
import { parseTqdm } from './tqdm';
import { generateVfigSvg } from './vfig';
import {
  buildVideoJob,
  clipSeconds,
  defaultExtractPosterFrame,
  type FrameExtractor,
  type HyperFramesRender,
  HyperFramesRunner,
  makeVideoAwareRunner,
} from './video-dispatch';
import { preparedDir } from './weights-on-shelf';

const log = createLogger('desktop:gen');

/**
 * A job an agent asked for over the bridge. `agent` is the asking pi's
 * `PI_DESKTOP_AGENT_ID` — a subagent's id — and absent for the chat's own pi.
 * The studios call the handlers without one.
 */
interface AgentSource {
  readonly agent?: string;
}

/**
 * The studio request a job answers, echoed on every surface event it streams
 * (GenSurfacePayload.requestId). Absent on the agents' path. Spread into each
 * handler's payload, so a studio can follow its job while the room itself is
 * not mounted — see src/state/studio-jobs.ts.
 */
function studioTag(requestId: string | undefined): { readonly requestId?: string } {
  return requestId !== undefined && requestId !== '' ? { requestId } : {};
}

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
   * How gently to run the next heavy job — the power policy's lever, read at
   * admission. `pace` is the share of every second the worker's child rests;
   * `previews` false drops the per-step decode (≈4.5 GB of peak). Default: flat
   * out with previews.
   */
  readonly eco?: () => { pace: number; previews: boolean };
  /**
   * MAKE ROOM (make-room.ts): the chat model is the largest thing in memory,
   * and a job the machine holds for want of memory usually fits without it.
   * `park` stops the chat server's process (refused mid-request), `resume`
   * brings it back on the same URL, `refresh` takes a fresh pressure reading
   * so the queue's next look sees the memory that came back. Absent: jobs
   * that do not fit wait, as before.
   */
  readonly room?: {
    readonly park: () => Promise<{ ok: boolean; reason?: string }>;
    readonly resume: () => Promise<{ ok: boolean; reason?: string }>;
    readonly refresh: () => Promise<unknown>;
  };
  /**
   * A fresh pressure reading, awaited before a heavy job is offered to the
   * queue. The guardian looks every 15 s while nothing runs, and SEEN: a
   * picture admitted on a reading taken before the chat model had finished
   * loading (80% free on paper, 28% in fact) took the machine to 8% and was
   * shed. Admission is the one moment the number has to be current.
   */
  readonly freshReading?: () => Promise<unknown>;
  /**
   * ComfyUI http origin resolver for `comfyui`-backed video (LTX/Wan) jobs.
   * Default REJECTS (ComfyUI not configured) — the real app starts the supervisor
   * and returns its `http://127.0.0.1:<port>` origin (or a remote host).
   */
  readonly comfyResolveOrigin?: () => Promise<string>;
  /** The ComfyUI server's pid while it runs — the memory guard's handle on a
   * comfy job (studio-main). */
  readonly comfyPid?: () => number | undefined;
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
  /**
   * The generation MODULES (gen-modules.ts): a job whose runtime is not on
   * this Mac waits for the Download button rather than failing or installing
   * in silence, and continues when the install lands. Absent: no gate.
   */
  readonly modules?: GenModulesManager;
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
  /** Jobs waiting to start — a hold is only worth announcing when there is one. */
  readonly queued: () => number;
  readonly shedRunning: (reason: string) => string[];
  readonly reconsider: () => void;
  /** Image → 3D on ComfyUI through this same queue — see {@link Run3dFn}. */
  readonly run3d: Run3dFn;
}

/**
 * Image → 3D through the same door as every other generation: the module and
 * weights gates, the guardian's admission, the queue, the room-making.
 * gen3d-main calls this for the 3D studio and the chat when the job runs on
 * ComfyUI (the path that needs no engine built on this Mac).
 */
export interface Run3dParams {
  readonly imagePath: string;
  /** Catalog id of a `comfyui`-backed 3D entry; the recommended one when absent. */
  readonly model?: string;
  readonly seed?: number;
  /** Faces the textures are painted onto (0 = the graph's own budget). */
  readonly faces?: number;
  readonly textureSize?: number;
  /** How far to finish the model — grey shape, painted colour, or the full
   * PBR material (the default). Picks the graph; see comfy-workflow. */
  readonly finish?: ModelFinish;
  /** Where the GLB lands. */
  readonly outputDir: string;
  /**
   * Stops the job — at the gates or in the queue. The caller knows it by an id
   * of its own (gen3d-main's `c3d_…`), not the queue's, so this is the only
   * way its cancel reaches the job.
   */
  readonly signal?: AbortSignal;
  /**
   * A line about the wait, when there is one — "Waiting for memory — needs
   * about 14.8 GB and only 18.5 GB is available (keeping 4 GB for you)".
   * The chat and the studios get these through their note sinks; without this
   * the 3D studio sat on "Getting the 3D module ready…" for as long as a hold
   * lasted (MEASURED: a 24 GB Mac at 77% free never admits the 512³ job).
   */
  readonly onNote?: (text: string) => void;
}
export type Run3dFn = (
  params: Run3dParams,
  onEvent: (event: GenEvent) => void,
) => Promise<{ readonly jobId: string; readonly outputs: GenOutput[] }>;

export function registerGenIpc(opts: GenManagerOptions): GenQueueControl {
  /*
   * ~/Bobble/generated, not the OS temp tree. The user: "no complicated
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
  /** The uv worker's pid per running job — what the memory guard signals. */
  const workerPids = new Map<string, number>();
  const client = new GenServiceClient({
    resolveUv: opts.resolveUv,
    ...(opts.workerScript !== undefined ? { workerScript: opts.workerScript } : {}),
    // Behind the pointer — see inference/worker-tier.ts.
    spawnFn: (command, args, o) => {
      const child = defaultGenSpawn(command, args, o);
      tierChild(child, 'gen worker');
      return child;
    },
    onChild: (jobId, child) => {
      if (child.pid !== undefined) workerPids.set(jobId, child.pid);
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
   * for encoding, which is the part the user cut when the user asked for stills.
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
  const room = opts.room;
  const keeper: RoomKeeper | null =
    room === undefined
      ? null
      : createRoomKeeper({
          park: room.park,
          resume: room.resume,
          reconsider: async () => {
            /*
             * The memory comes back as the server's address space is torn
             * down — most of it at once, the rest over the next second — and
             * the guardian's own cadence while nothing runs is 15 s. Two looks,
             * a breath apart, so the queue decides on what is actually free.
             */
            await room.refresh();
            jobQueue.reconsider();
            await new Promise<void>((resolve) => setTimeout(resolve, 1500));
            await room.refresh();
            jobQueue.reconsider();
          },
          graceMs: 6_000,
          busy: () => jobQueue.runningCount > 0 || jobQueue.queuedCount > 0,
          log: (message, extra) => log.info(`make room: ${message}`, extra ?? {}),
        });
  /*
   * UNDER THE MEMORY GUARD (gen/guardian-main.ts, gen/pausables.ts). Every
   * running job is registered with the process it runs in: the uv worker's
   * tree for mflux/audio, the ComfyUI server for a comfy job (the job IS that
   * process while it runs — MEASURED 2026-09-15, a jetsam report with the
   * ComfyUI python at 9.6 GB and 165 MB free). A pause stops that tree in
   * place; a shed goes through the queue's own cancel so the job's bookkeeping
   * ends cleanly and the person reads why.
   */
  const guarded = new Map<string, () => void>();
  const jobLabel = (job: GenJob | undefined): string =>
    job?.modality === 'video'
      ? 'the video'
      : job?.modality === 'audio'
        ? 'the sound'
        : job?.modality === '3d'
          ? 'the 3D model'
          : 'the picture';
  jobQueue.on((e) => {
    if (e.type === 'held') {
      noteSinks.get(e.jobId)?.(`Waiting for memory — ${e.reason}`);
      keeper?.held(e.jobId);
    } else if (e.type === 'status' && e.status === 'running') {
      keeper?.started(e.jobId);
      if (keeper?.parked === true) {
        noteSinks.get(e.jobId)?.('Made room — the chat model is paused while this renders');
      }
      const job = jobQueue.jobOf(e.jobId);
      const comfy = job?.backend === 'comfyui';
      guarded.get(e.jobId)?.();
      guarded.set(
        e.jobId,
        guardRun({
          id: `gen:${e.jobId}`,
          label: jobLabel(job),
          kind: 'gen',
          pid: () => (comfy ? opts.comfyPid?.() : workerPids.get(e.jobId)),
          cancel: (reason) => {
            jobQueue.cancel(e.jobId, reason);
          },
        }),
      );
    } else if (
      e.type === 'status' &&
      (e.status === 'done' || e.status === 'error' || e.status === 'canceled')
    ) {
      keeper?.finished(e.jobId);
      guarded.get(e.jobId)?.();
      guarded.delete(e.jobId);
      workerPids.delete(e.jobId);
    }
  });
  /** The caller gets its answer only once a chat model we parked is back. */
  const settleRoom = (): Promise<void> => keeper?.settle() ?? Promise.resolve();

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

  // ── the module gate (gen-modules.ts) ────────────────────────────────────────
  // Before a job's weights, its RUNTIME: the uv environment for mflux / mlx-audio,
  // ComfyUI for the rest. Not ready → the job waits for the Download button the
  // renderer is now showing, and continues when the install lands.
  const modules = opts.modules;
  // `stop` is the job's: a stopped job stops waiting, and the card stops counting it.
  const ensureModule = async (backend: string, stop?: AbortSignal): Promise<void> => {
    const id = moduleForBackend(backend);
    if (id === undefined || modules === undefined) return;
    await modules.ensure(id, stop);
  };
  /**
   * AND THEN ITS WEIGHTS. A ComfyUI graph names its files; a catalog entry
   * that lists them (`weights`) gets the same gate for them — the same card,
   * the same wait, the same sentence for the model — one click after the
   * runtime's. An entry that lists nothing (its files arrive some other way)
   * passes through.
   */
  const ensureWeights = async (model: ModalityModel, stop?: AbortSignal): Promise<void> => {
    const id = weightsModuleFor(model);
    if (id === undefined || modules === undefined) return;
    await modules.ensure(id, stop);
  };
  const moduleSucceeded = (backend: string): void => {
    const id = moduleForBackend(backend);
    if (id !== undefined) modules?.markReady(id);
  };

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

  /**
   * AN AGENT'S JOB IS ANNOUNCED, a studio's is not. Sent as the job reaches the
   * gates — before the queue runs it, and with `pendingJobs` already holding it
   * — so a chat deleted while its picture is still waiting its turn, or waiting
   * for its runtime to install, stops that picture too (the user, 2026-09-23).
   * `from` is absent on the studios' own path (`gen:generate`).
   */
  /** OmniSVG drawings in flight, by the id `announceAgentJob` gave them. */
  const svgRuns = new Map<string, AbortController>();
  let svgSeq = 0;
  /** Jobs that have an id and are still at the gates, not yet queued. */
  const pendingJobs = new PendingJobs();
  /** Stop a job by id — one at the gates, a queue job, or a drawing (`svg-<n>`). */
  const cancelJob = (jobId: string): boolean => {
    const drawing = svgRuns.get(jobId);
    if (drawing !== undefined) {
      drawing.abort();
      return true;
    }
    return pendingJobs.cancel(jobId) || jobQueue.cancel(jobId);
  };

  const announceAgentJob = (jobId: string, from: AgentSource | undefined): void => {
    if (from === undefined) return;
    send('gen:agent-job', { jobId, ...(from.agent !== undefined ? { agent: from.agent } : {}) });
  };

  async function handleGenerate(
    raw: GenerateImageParams,
    from?: AgentSource,
    requestId?: string,
    /** The asking tool gave up (its turn was stopped) — see `abandon`. */
    signal?: AbortSignal,
  ): Promise<GenerateImageResult> {
    const model = getModel(raw.model ?? defaultImageModel().id);
    // An image model runs one of two ways: the mflux worker (its `mflux`
    // command) or a ComfyUI graph (`comfy`, Qwen-Image 2.1 — image-dispatch).
    const runsHere = (m: ModalityModel | undefined): m is ModalityModel =>
      m !== undefined &&
      m.modality === 'image' &&
      m.reserved !== true &&
      (m.mflux !== undefined || isComfyImageModel(m));
    if (!runsHere(model)) {
      const runnable = modelsForModality('image')
        .filter(runsHere)
        .map((m) => m.id)
        .join(', ');
      throw new Error(
        `unknown or non-image model "${raw.model ?? ''}" — image models that can run here: ${runnable}`,
      );
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
    const eco = opts.eco?.() ?? { pace: 0, previews: true };
    // Under 'low' the policy has already said no to previews — the 4.5 GB is
    // the headroom the user asked to keep — so the guardian is not even asked.
    // A ComfyUI graph decodes once at the end: no per-step frames, no
    // preview cost, and the footprint is the bare job.
    // …and never for a model whose per-step decode is the job's cost again
    // (ModalityModel.previews: Qwen-Image 2.1's 64-channel VAE, +14 GB).
    const canPreview = model.mflux !== undefined && model.previews !== false && eco.previews;
    const previewsAllowed = canPreview ? (opts.heavyAllowed?.(withPreviews) ?? true) : false;
    const stepPreviews =
      typeof previewsAllowed === 'boolean' ? previewsAllowed : previewsAllowed.ok;
    const footprintGB = stepPreviews ? withPreviews : bare;

    const job: GenJob =
      model.mflux !== undefined
        ? {
            id: jobId,
            modality: 'image',
            backend: 'mflux',
            outputDir,
            image: {
              prompt: raw.prompt,
              modelId: model.id,
              mfluxCommand: model.mflux.command,
              // A model MADE on this Mac (mflux.prepared) is loaded from its
              // library folder; a published one by its repo.
              mfluxModel:
                model.mflux.prepared !== undefined ? preparedDir(model) : model.mflux.model,
              ...(model.mflux.baseModel !== undefined ? { baseModel: model.mflux.baseModel } : {}),
              width,
              height,
              steps,
              seeds,
              stepPreviews,
              ...(eco.pace > 0 ? { pace: eco.pace } : {}),
              negativePrompt: raw.negativePrompt,
              ...(guidance !== undefined ? { guidance } : {}),
              // An edit rather than a fresh generation — see ImageJobSpec.imagePath.
              ...(raw.inputImage !== undefined && raw.inputImage.length > 0
                ? { imagePath: raw.inputImage }
                : {}),
              ...(raw.strength !== undefined ? { imageStrength: raw.strength } : {}),
              quantize: model.defaultQuantize,
            },
          }
        : /*
           * ComfyUI (Qwen-Image 2.1). No step previews — the adapter reports
           * progress, not frames — so the pending card plays the mark; the
           * pace is the guardian's SIGSTOP on the ComfyUI process (pausables).
           * An input picture is not offered on this path: editing needs the
           * encoder's vision tower, which the GGUF does not carry.
           */
          buildComfyImageJob(
            model,
            {
              prompt: raw.prompt,
              width,
              height,
              ...(steps !== undefined ? { steps } : {}),
              ...(raw.negativePrompt !== undefined ? { negativePrompt: raw.negativePrompt } : {}),
              ...(guidance !== undefined ? { guidance } : {}),
              seeds,
            },
            jobId,
            outputDir,
          );
    if (job.backend === 'comfyui' && raw.inputImage !== undefined && raw.inputImage.length > 0) {
      throw new Error(
        `${model.label} generates from text only here — editing a picture needs an mflux edit model (see edit_image)`,
      );
    }

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
      ...studioTag(requestId),
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
         * being dropped, so the room said "Starting…" throughout and the user reported
         * the studio as not working at all.
         */
        const steps = event.event === 'log' ? parseTqdm(event.text) : undefined;
        if (steps !== undefined) {
          /*
           * A worker that only PRINTS its steps (tqdm on stderr — the image-edit
           * path) still has a counter: it becomes the same progress a structured
           * event gives, and the line itself is never shown. The user (2026-09-24):
           * "that terminal logging style text below it needs to go". tqdm does
           * not say which candidate; the first one not yet done is being drawn.
           */
          const idx = Math.max(
            0,
            candidates.findIndex((c) => c.status !== 'done'),
          );
          const c = candidates[idx];
          if (c !== undefined && c.status === 'pending') {
            candidates[idx] = { ...c, status: 'generating' };
          }
          progress = { candidate: idx, step: steps.step, total: steps.total };
          send('gen:update', { tabId, payload: payload('generating') });
          return;
        }
        const line =
          event.event === 'log' ? noteFrom(event.text) : downloadNote(event.detail, event.ratio);
        if (line !== undefined && line !== note) {
          note = line;
          send('gen:update', { tabId, payload: payload('generating') });
        }
      }
    };

    const stop = pendingJobs.open(jobId, signal);
    announceAgentJob(jobId, from);
    try {
      // Download-then-continue: an mflux image needs no up-front pack, so this is
      // a no-op here; the seam is uniform so a future comfyui-backed image gates too.
      await unlessStopped(stop, ensureModule(job.backend, stop));
      await unlessStopped(stop, ensureWeights(model, stop));
      const need = needForModel(model);
      if (need !== undefined && ensureAsset !== undefined) {
        await unlessStopped(stop, ensureAsset(need));
      }
      noteSinks.set(jobId, (line) => {
        note = line;
        send('gen:update', { tabId, payload: payload('generating') });
      });
      await unlessStopped(stop, opts.freshReading?.());
      pendingJobs.admit(jobId);
      const queued = jobQueue.enqueue(job, {
        heavy: model.heavy,
        footprintGB,
        onEvent,
        // The model's own mflux build, when it ships one (the Qwen-Image 2.1
        // port): a wheel beside worker.py, in place of the pinned release.
        ...(model.mflux?.wheel !== undefined
          ? {
              mfluxWith: bundledWheelPath(
                resolveWorkerScript(opts.workerScript),
                model.mflux.wheel,
              ),
            }
          : {}),
      });
      // Stopped while queued or running: the queue's own cancel.
      stop.addEventListener('abort', () => jobQueue.cancel(jobId), { once: true });
      const outputs = await queued.result;
      moduleSucceeded(job.backend);
      progress = undefined;
      send('gen:update', { tabId, payload: payload('done') });
      return { jobId, outputs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send('gen:update', { tabId, payload: payload('error', message) });
      throw err;
    } finally {
      pendingJobs.close(jobId);
      noteSinks.delete(jobId);
      await settleRoom();
    }
  }

  async function handleGenerateVideo(
    raw: GenerateVideoParams,
    from?: AgentSource,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<GenerateVideoResult> {
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
    const seconds = clipSeconds(raw.seconds, raw.prompt);
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
      ...studioTag(requestId),
    });

    send('gen:open', { tabId, payload: payload('generating') });

    const onEvent = (event: GenEvent): void => {
      if (event.event === 'progress') {
        /* A FRAME AS IT LANDS. HyperFrames writes every frame to disk and names
           it on its progress event; this handler used to drop the path, so the
           chat's card and the Video studio showed only a percentage while the
           animation was being drawn. The image handler has always carried it. */
        candidate = {
          ...candidate,
          status: 'generating',
          ...(event.previewPath !== undefined ? { previewSrc: toSrc(event.previewPath) } : {}),
        };
        progress = { candidate: 0, step: event.step, total: event.total };
        send('gen:update', { tabId, payload: payload('generating') });
      } else if (event.event === 'candidate') {
        candidate = { ...candidate, status: 'done', finalSrc: toSrc(event.output.outputPath) };
        send('gen:update', { tabId, payload: payload('generating') });
      }
    };

    const stop = pendingJobs.open(jobId, signal);
    announceAgentJob(jobId, from);
    try {
      // Download-then-continue: a comfyui-backed video (LTX / Wan) whose weights
      // pack is missing PROMPTS the user, downloads on accept, then continues here.
      await unlessStopped(stop, ensureModule(job.backend, stop));
      await unlessStopped(stop, ensureWeights(model, stop));
      const need = needForModel(model);
      if (need !== undefined && ensureAsset !== undefined) {
        await unlessStopped(stop, ensureAsset(need));
      }
      noteSinks.set(jobId, (line) => {
        note = line;
        send('gen:update', { tabId, payload: payload('generating') });
      });
      await unlessStopped(stop, opts.freshReading?.());
      pendingJobs.admit(jobId);
      const queued = jobQueue.enqueue(job, {
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
      });
      // Stopped while queued or running: the queue's own cancel.
      stop.addEventListener('abort', () => jobQueue.cancel(jobId), { once: true });
      const outputs = await queued.result;
      moduleSucceeded(job.backend);
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
      pendingJobs.close(jobId);
      noteSinks.delete(jobId);
      await settleRoom();
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
  async function handleGenerateAudio(
    raw: GenerateAudioParams,
    from?: AgentSource,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<GenerateAudioResult> {
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
      ...studioTag(requestId),
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

    const stop = pendingJobs.open(jobId, signal);
    announceAgentJob(jobId, from);
    try {
      // Same download-then-continue courtesy the video path gets: a ComfyUI music
      // or SFX model whose weights pack is missing prompts, downloads, continues.
      await unlessStopped(stop, ensureModule(job.backend, stop));
      await unlessStopped(stop, ensureWeights(model, stop));
      const need = needForModel(model);
      if (need !== undefined && ensureAsset !== undefined) {
        await unlessStopped(stop, ensureAsset(need));
      }
      noteSinks.set(jobId, (line) => {
        note = line;
        send('gen:update', { tabId, payload: payload('generating') });
      });
      await unlessStopped(stop, opts.freshReading?.());
      pendingJobs.admit(jobId);
      const queued = jobQueue.enqueue(job, {
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
      });
      // Stopped while queued or running: the queue's own cancel.
      stop.addEventListener('abort', () => jobQueue.cancel(jobId), { once: true });
      const outputs = await queued.result;
      moduleSucceeded(job.backend);
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
      pendingJobs.close(jobId);
      noteSinks.delete(jobId);
      await settleRoom();
    }
  }

  async function dispatch(
    method: string,
    params: Record<string, unknown>,
    from: AgentSource = {},
    /** Fires when the tool that asked stopped waiting (`abandon`, or its pi went away). */
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case 'generate':
        return handleGenerate(params as unknown as GenerateImageParams, from, undefined, signal);
      case 'generateVideo':
        return handleGenerateVideo(
          params as unknown as GenerateVideoParams,
          from,
          undefined,
          signal,
        );
      case 'generateAudio':
        return handleGenerateAudio(
          params as unknown as GenerateAudioParams,
          from,
          undefined,
          signal,
        );
      case 'generateSvg': {
        /* OmniSVG: its own short-lived llama-server, not the worker queue —
           see omnisvg.ts. The folder is named after the ask like every other
           generation, so it sits beside the images in Generated. */
        const p = params as {
          engine?: 'omnisvg' | 'vfig';
          prompt?: string;
          images?: string[];
          candidates?: number;
          outPath?: string;
          /** VFIG: the SVG file to change (fenced to the working folder by the tool). */
          edit?: string;
        };
        // Named after the ask — or the picture or file's own name, never its whole path.
        const source = p.images?.[0] ?? p.edit;
        const name = slug(
          p.prompt ??
            (source !== undefined ? path.basename(source).replace(/\.[^.]+$/, '') : 'svg'),
          'svg',
        );
        const outputDir = path.join(outputRoot, uniqueName(outputRoot, name));
        const prompt = p.prompt === undefined ? {} : { prompt: p.prompt };
        /* A drawing is not a queue job, so it gets an id of its own that
           `cancel` understands — the chat that asked for it can stop it. */
        const svgId = `svg-${++svgSeq}`;
        const stop = new AbortController();
        svgRuns.set(svgId, stop);
        // The turn that asked was stopped: so is the drawing.
        if (signal?.aborted === true) stop.abort();
        else signal?.addEventListener('abort', () => stop.abort(), { once: true });
        announceAgentJob(svgId, from);
        let result: {
          outputs: ReadonlyArray<{
            outputPath: string;
            paths: number;
            source: string;
            stop: string;
          }>;
        };
        try {
          /* VFIG writes figures as SVG code and edits SVGs; OmniSVG draws pictures
             (gen-tools svgEngineFor decides). Both stream the drawing to the same card. */
          result =
            p.engine === 'vfig'
              ? await generateVfigSvg(
                  { ...p, outputDir, signal: stop.signal, figure: vfigFigureBase64 },
                  (partial) => send('gen:svg-live', { status: 'drawing', ...partial, ...prompt }),
                )
              : await generateSvg(
                  { ...p, outputDir, signal: stop.signal, picture: omniSvgPictureBase64 },
                  (partial) => send('gen:svg-live', { status: 'drawing', ...partial, ...prompt }),
                );
        } catch (err) {
          const message = stop.signal.aborted
            ? 'stopped — the chat that asked for this drawing stopped it, or was deleted'
            : err instanceof Error
              ? err.message
              : String(err);
          send('gen:svg-live', { status: 'error', error: message, ...prompt, jobId: svgId });
          throw err;
        } finally {
          svgRuns.delete(svgId);
        }
        /*
         * THE FINISHED DRAWING GOES TO THE THREAD, IN PLACE OF THE LIVE ONE.
         * It used to open as a file tab in the canvas (`gen:open-file`); the user
         * wants the drawing in the chat, as the card the live drawing was, and
         * the canvas only when its corner control is asked for — the same rule
         * a presented chart follows.
         */
        const outputs: { path: string; svg: string; paths: number }[] = [];
        for (const o of result.outputs) {
          let svg = '';
          try {
            svg = await readFile(o.outputPath, 'utf8');
          } catch {
            svg = '';
          }
          outputs.push({ path: o.outputPath, svg, paths: o.paths });
        }
        send('gen:svg-live', { status: 'done', outputs, ...prompt, jobId: svgId });
        return result;
      }
      case 'omnisvgStatus':
        return omniSvgFiles();
      case 'cancel': {
        const jobId = String((params as { jobId?: unknown }).jobId ?? '');
        return { canceled: cancelJob(jobId) };
      }
      case 'listModels':
        return activeModels().map(summariseModel);
      default:
        throw new Error(`unknown gen method: ${method}`);
    }
  }

  // ── socket server (mirrors browser-agent.ts) ────────────────────────────────
  /*
   * WHO IS STILL WAITING. A pi child keeps one connection for all its requests,
   * so each request gets a signal of its own: `abandon` fires it (the tool's
   * turn was stopped — gen-bridge-client), and so does the connection closing
   * (that pi is gone). Either way nobody will receive the job's result, and the
   * job is cancelled rather than left holding the machine for minutes.
   */
  async function handleLine(
    socket: net.Socket,
    line: string,
    waiting: Map<number, AbortController>,
  ): Promise<void> {
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
    if (req.method === 'abandon') {
      waiting.get(Number(req.params?.requestId))?.abort();
      return;
    }
    const asker = new AbortController();
    waiting.set(req.id, asker);
    try {
      const from: AgentSource =
        typeof req.agent === 'string' && req.agent !== '' ? { agent: req.agent } : {};
      const result = await dispatch(req.method, req.params ?? {}, from, asker.signal);
      waiting.delete(req.id);
      respond({ ok: true, result });
    } catch (err) {
      waiting.delete(req.id);
      respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  function handleConnection(socket: net.Socket): void {
    let buffer = '';
    const waiting = new Map<number, AbortController>();
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const asker of waiting.values()) asker.abort();
      waiting.clear();
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const l = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (l.trim() !== '') void handleLine(socket, l, waiting);
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
   * an unhandled promise. The studio's `requestId` rides on every event the job
   * streams (studioTag), which is how the room follows a job it is not in.
   */
  ipcMain.handle(
    'gen:generate',
    async (
      _event,
      req: GenInvokeMap['gen:generate']['request'],
    ): Promise<GenInvokeMap['gen:generate']['response']> => {
      try {
        if (req.kind === 'audio') {
          const r = await handleGenerateAudio(
            {
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
            },
            undefined,
            req.requestId,
          );
          return { jobId: r.jobId, outputs: r.outputs };
        }
        if (req.kind === 'video') {
          const r = await handleGenerateVideo(
            {
              prompt: req.prompt,
              ...(req.model !== undefined ? { model: req.model } : {}),
              ...(req.seconds !== undefined ? { seconds: req.seconds } : {}),
              ...(req.size !== undefined ? { size: req.size } : {}),
              ...(req.fps !== undefined ? { fps: req.fps } : {}),
              ...(req.seed !== undefined ? { seed: req.seed } : {}),
              ...(req.negativePrompt !== undefined ? { negativePrompt: req.negativePrompt } : {}),
              // The studio's Steps knob — dropped here the same way, so it
              // changed nothing (handleGenerateVideo clamps and uses it).
              ...(req.steps !== undefined ? { steps: req.steps } : {}),
            },
            undefined,
            req.requestId,
          );
          return {
            jobId: r.jobId,
            outputs: r.outputs.map((o) => ({
              path: o.outputPath,
              ...(o.seed !== undefined ? { seed: o.seed } : {}),
              model: o.model,
            })),
          };
        }
        /*
         * THE EDIT HALF WAS NEVER FORWARDED. The contract has carried
         * `inputImage` / `strength` / `guidance` since the studios learned to
         * edit, and `handleGenerate` has honoured them since the same day — but
         * this call dropped all three, so every "Edit" the Image Studio ever ran
         * was a plain text-to-image run of the instruction, and the round-2 edit
         * probe passed anyway (a fresh picture of the same subject is "different
         * from the input" too). Found wiring the image viewer's Edit bar to it.
         */
        const r = await handleGenerate(
          {
            prompt: req.prompt,
            ...(req.model !== undefined ? { model: req.model } : {}),
            ...(req.size !== undefined ? { size: req.size } : {}),
            ...(req.n !== undefined ? { n: req.n } : {}),
            ...(req.steps !== undefined ? { steps: req.steps } : {}),
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
            ...(req.negativePrompt !== undefined ? { negativePrompt: req.negativePrompt } : {}),
            ...(req.guidance !== undefined ? { guidance: req.guidance } : {}),
            ...(req.inputImage !== undefined && req.inputImage.length > 0
              ? { inputImage: req.inputImage }
              : {}),
            ...(req.strength !== undefined ? { strength: req.strength } : {}),
          },
          undefined,
          req.requestId,
        );
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
    return { canceled: cancelJob(req.jobId) };
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

  // The modules' own invokes (gen-modules.ts): a fresh status, the Download
  // button, the card's close. Progress rides the `gen:module` event the manager
  // emits through its port.
  if (modules !== undefined) {
    ipcMain.handle('gen:module-status', async (event) => {
      guard(event, 'gen:module-status');
      return { modules: await modules.refresh() };
    });
    ipcMain.handle(
      'gen:module-install',
      async (event, req: GenInvokeMap['gen:module-install']['request']) => {
        guard(event, 'gen:module-install');
        // Fire; the states carry the outcome. A failure is on the card, not
        // thrown at the button.
        modules.install(req.id).catch((err) => {
          log.warn('module install failed', {
            id: req.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return { modules: modules.status() };
      },
    );
    ipcMain.handle(
      'gen:module-dismiss',
      async (event, req: GenInvokeMap['gen:module-dismiss']['request']) => {
        guard(event, 'gen:module-dismiss');
        modules.dismiss(req.id);
        return { modules: modules.status() };
      },
    );
  }

  roomKeepers.add(() => keeper?.dispose());

  const run3d: Run3dFn = async (params, onEvent) => {
    const model = getModel(params.model ?? default3dModel().id);
    if (model === undefined || model.modality !== '3d' || model.comfy === undefined) {
      throw new Error(`unknown or non-ComfyUI 3D model "${params.model ?? ''}"`);
    }
    const jobId = `gen3d_${Date.now()}_${randomBytes(3).toString('hex')}`;
    await mkdir(params.outputDir, { recursive: true });
    const finish = params.finish ?? 'pbr';
    const inputs: Record<string, string | number | boolean> = {};
    if (params.faces !== undefined && params.faces > 0) inputs.faces = params.faces;
    // A grey model has no atlas, so its graph binds no texture size.
    if (params.textureSize !== undefined && finish !== 'grey')
      inputs.textureSize = params.textureSize;
    const job: GenJob = {
      id: jobId,
      modality: '3d',
      backend: 'comfyui',
      outputDir: params.outputDir,
      comfy: {
        prompt: '',
        modelId: model.id,
        workflowTemplate: imageTo3dTemplateFor(model.comfy.workflowTemplate, finish),
        inputs,
        seeds: [params.seed ?? randomInt(0, 1_000_000_000)],
        inputImage: params.imagePath,
      },
    };
    if (params.onNote !== undefined) noteSinks.set(jobId, params.onNote);
    const stop = pendingJobs.open(jobId, params.signal);
    try {
      await unlessStopped(stop, ensureModule(job.backend, stop));
      await unlessStopped(stop, ensureWeights(model, stop));
      await unlessStopped(stop, opts.freshReading?.());
      pendingJobs.admit(jobId);
      const queued = jobQueue.enqueue(job, {
        heavy: model.heavy,
        footprintGB: jobFootprintGB(model),
        onEvent,
      });
      // The caller knows this job by its own id; its signal is how it stops it.
      stop.addEventListener('abort', () => jobQueue.cancel(jobId), { once: true });
      const outputs = await queued.result;
      moduleSucceeded(job.backend);
      return { jobId, outputs };
    } finally {
      pendingJobs.close(jobId);
      noteSinks.delete(jobId);
      await settleRoom();
    }
  };

  return {
    running: () => jobQueue.runningCount > 0,
    run3d,
    queued: () => jobQueue.queuedCount,
    shedRunning: (reason) => jobQueue.shedRunning(reason),
    reconsider: () => jobQueue.reconsider(),
  };
}

/** Parked chat models to bring back at teardown — see make-room.ts. */
const roomKeepers = new Set<() => void>();

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
  for (const dispose of roomKeepers) dispose();
  roomKeepers.clear();
  server?.close();
  server = null;
}
