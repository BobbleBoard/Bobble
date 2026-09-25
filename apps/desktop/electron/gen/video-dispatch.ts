/**
 * Video dispatch — the electron-free routing + job-building seam for
 * `generateVideo`. It keeps the {@link registerGenIpc} gen-manager thin and,
 * crucially, keeps this module importable by a `node`-environment unit test with
 * NO `electron` dependency (see apps/desktop/vitest.config.ts).
 *
 * A video job never goes through the uv worker (worker.py `dispatch()`
 * deliberately errors on video). Instead a {@link makeVideoAwareRunner}
 * dispatching runner splits by `job.backend`:
 *
 *   - `comfyui`     → the persistent ComfyUI adapter (LTX / Wan text→video),
 *   - `hyperframes` → the Node HyperFrames runner (motion graphics rendered as
 *                     stills in the app's own Chromium and joined into one
 *                     animated PNG — deterministic, no ffmpeg, commercial-safe),
 *   - everything else (mflux image / mlx-audio / triposr / trellis) → the uv
 *     worker fallback, exactly as before (image generation is unchanged).
 *
 * {@link buildVideoJob} resolves a catalog {@link ModalityModel} + normalised
 * params into the right {@link GenJob} arm (`comfy` for ComfyUI, `video` for
 * HyperFrames). {@link defaultExtractPosterFrame} pulls one still out of the
 * produced clip — for a HyperFrames animation the frame it settles to (its
 * last), in plain TypeScript; for an MP4 the first, with ffmpeg; best-effort —
 * so a chat model can critique output it cannot watch.
 * Everything real-runtime is injectable so the routing/builder
 * logic unit-tests against fakes — no ComfyUI, ffmpeg, or Chrome is required.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ComfyJobSpec,
  GenEvent,
  GenJob,
  GenOutput,
  GenRunnerLike,
  JobRunner,
  ModalityModel,
  VideoJobSpec,
} from '@pi-desktop/gen-service';
import { readPngChunks, readPngHead, stillOfApng } from './apng.js';
import { FRAMES_DIR, frameFileName } from './hyperframes-still.js';

/** Options a runner accepts (the {@link JobRunner} tail). */
export interface VideoRunOptions {
  readonly onEvent?: (event: GenEvent) => void;
  readonly signal?: AbortSignal;
  readonly extraWith?: readonly string[];
  /** The mflux build for an image job (a bundled wheel's path); the uv arm reads it. */
  readonly mfluxWith?: string;
}

/**
 * The Node HyperFrames renderer: renders an HTML/CSS/JS scene from the spec frame
 * by frame in the app's own Chromium and joins the stills into one animated PNG
 * (./hyperframes-still.ts), emitting {@link GenEvent}s as it goes. Injected so
 * the routing/dispatch is testable without a display. Resolves with the produced
 * artifact(s).
 */
export type HyperFramesRender = (
  spec: VideoJobSpec,
  outputDir: string,
  onEvent: (event: GenEvent) => void,
  signal?: AbortSignal,
) => Promise<GenOutput[]>;

/**
 * The default HyperFrames renderer for an environment where the motion-graphics
 * toolchain (ffmpeg + headless Chrome) is not installed: it emits a terminal
 * `error` and rejects with a clear message. Swapped for the real renderer once
 * the HyperFrames aux deps land.
 */
export const hyperFramesRenderUnavailable: HyperFramesRender = async (spec, _dir, onEvent) => {
  const message =
    'HyperFrames motion-graphics runner is not installed (needs ffmpeg + headless Chrome). ' +
    `Cannot render "${spec.modelId}".`;
  onEvent({ event: 'error', jobId: spec.modelId, message, recoverable: false });
  throw new Error(message);
};

/**
 * Adapts a {@link HyperFramesRender} to the `run(job, opts) → GenOutput[]`
 * contract the {@link JobQueue} takes (same shape as ComfyClient /
 * GenServiceClient), reading its params off the job's `video` arm.
 */
export class HyperFramesRunner implements GenRunnerLike {
  readonly #render: HyperFramesRender;

  constructor(render: HyperFramesRender = hyperFramesRenderUnavailable) {
    this.#render = render;
  }

  async run(job: GenJob, opts: VideoRunOptions = {}): Promise<GenOutput[]> {
    const spec = job.video;
    if (spec === undefined) {
      throw new Error(`hyperframes job "${job.id}" is missing its \`video\` spec`);
    }
    return this.#render(spec, job.outputDir, (event) => opts.onEvent?.(event), opts.signal);
  }
}

/** The runners a {@link makeVideoAwareRunner} dispatches to. */
export interface VideoAwareRunnerDeps {
  /** `comfyui`-backend jobs (LTX / Wan text→video, and advanced ComfyUI image). */
  readonly comfy: GenRunnerLike;
  /** `hyperframes`-backend jobs (Node motion graphics). */
  readonly hyperframes: GenRunnerLike;
  /** Every other backend (mflux image, mlx-audio, triposr, trellis) → uv worker. */
  readonly fallback: GenRunnerLike;
}

/**
 * Compose one {@link JobRunner} that routes by `job.backend`: `comfyui` → the
 * ComfyUI adapter, `hyperframes` → the Node runner, and everything else → the uv
 * worker. A superset of gen-service's `makeGenRunner` that adds the HyperFrames
 * arm; image generation (mflux → fallback) is unaffected. Heavy/light
 * unified-memory gating keys off the catalog entry, not the backend, so it works
 * across all three for free.
 */
export function makeVideoAwareRunner(deps: VideoAwareRunnerDeps): JobRunner {
  return (job, opts) => {
    switch (job.backend) {
      case 'comfyui':
        return deps.comfy.run(job, opts);
      case 'hyperframes':
        return deps.hyperframes.run(job, opts);
      default:
        return deps.fallback.run(job, opts);
    }
  };
}

/** Normalised, backend-agnostic video params the app resolves before building a job. */
export interface VideoJobParams {
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly fps: number;
  readonly steps?: number;
  readonly negativePrompt?: string;
  /** The single candidate seed (video generation is one-clip-per-job). */
  readonly seed: number;
}

/**
 * Resolve a catalog VIDEO {@link ModalityModel} + normalised params into the
 * right {@link GenJob}: a `comfy` spec for ComfyUI (LTX/Wan) — with frame count
 * derived as `round(seconds × fps)` and only param keys the workflow template
 * binds — or a `video` spec for the HyperFrames runner. Throws on a
 * non-video / mis-wired model so the caller never enqueues an invalid job.
 */
export function buildVideoJob(
  model: ModalityModel,
  params: VideoJobParams,
  jobId: string,
  outputDir: string,
): GenJob {
  if (model.modality !== 'video') {
    throw new Error(`model "${model.id}" is not a video model`);
  }
  const seeds = [params.seed];

  if (model.backend === 'comfyui') {
    if (model.comfy === undefined) {
      throw new Error(`video model "${model.id}" has no ComfyUI workflow config`);
    }
    // Only include keys the workflow template's paramMap binds (fillWorkflow
    // throws on an unbound input). `seconds × fps` collapses to a frame `length`.
    const length = Math.max(1, Math.round(params.seconds * params.fps));
    const inputs: Record<string, string | number | boolean> = {
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      length,
    };
    // A negative prompt only where the graph has a tower for one: H3 has none,
    // and the LTX-2.5 distilled graph dropped its encode (measured identical
    // frames at cfg 1). fillWorkflow throws on an unbound input, so the
    // template's own map decides.
    const binds = (key: string): boolean => key in (model.comfy?.paramMap ?? {});
    if (params.negativePrompt !== undefined && binds('negativePrompt')) {
      inputs.negativePrompt = params.negativePrompt;
    }
    if (params.steps !== undefined) inputs.steps = params.steps;
    const comfy: ComfyJobSpec = {
      prompt: params.prompt,
      modelId: model.id,
      workflowTemplate: model.comfy.workflowTemplate,
      inputs,
      seeds,
    };
    return { id: jobId, modality: 'video', backend: 'comfyui', outputDir, comfy };
  }

  if (model.backend === 'hyperframes') {
    const video: VideoJobSpec = {
      prompt: params.prompt,
      modelId: model.id,
      width: params.width,
      height: params.height,
      seconds: params.seconds,
      fps: params.fps,
      negativePrompt: params.negativePrompt,
      seeds,
    };
    return { id: jobId, modality: 'video', backend: 'hyperframes', outputDir, video };
  }

  throw new Error(`video model "${model.id}" has unsupported backend "${model.backend}"`);
}

/** Extracts a still poster frame from a produced video, or `undefined` on failure. */
export type FrameExtractor = (videoPath: string, outDir: string) => Promise<string | undefined>;

/**
 * Default poster-frame extractor: a still of the clip as `<outDir>/poster.png`
 * — for a HyperFrames animation, the frame it SETTLES to. Best-effort —
 * resolves `undefined` when it cannot, so a failed extraction never fails the
 * generation itself (the output is still on disk); the `generate_video` tool
 * simply omits the self-critique image.
 *
 * A PNG needs no decoder (a lone frame is already a still). Only a real video
 * goes to ffmpeg — which is not bundled, so on a Mac without it a clip gets no
 * poster.
 */
export const defaultExtractPosterFrame: FrameExtractor = (videoPath, outDir) =>
  /\.png$/i.test(videoPath) ? pngPoster(videoPath, outDir) : ffmpegPoster(videoPath, outDir);

/**
 * An animated PNG's poster is ONE plain still: a vision model's decoder is not
 * an APNG player, and the whole animation is far over the size a tool result
 * may attach.
 *
 * WHICH still. It used to be frame 0 — for a title card, the words at a third
 * of their opacity halfway into their entrance; for an authored scene often an
 * empty plate — and that is the picture the model was shown to judge its own
 * work by. The poster is the frame the animation settles to: the LAST one the
 * renderer wrote into `frames/` beside it (counted from the animation's own
 * header, so a stale frame from an earlier render cannot stand in). Only the
 * animation's head is read. Without that folder (an animation from elsewhere)
 * it falls back to the default image, frame 0; a PNG that is not animated is
 * its own poster.
 */
async function pngPoster(pngPath: string, outDir: string): Promise<string | undefined> {
  try {
    const head = await readPngHead(pngPath);
    const actl = readPngChunks(head).find((c) => c.type === 'acTL');
    if (actl === undefined) return pngPath;
    const outPath = path.join(outDir, 'poster.png');
    const count = Buffer.from(actl.data).readUInt32BE(0);
    if (count > 0) {
      const settled = path.join(path.dirname(pngPath), FRAMES_DIR, frameFileName(count - 1, count));
      try {
        const bytes = await readFile(settled);
        if (stillOfApng(bytes) === undefined && readPngChunks(bytes).length > 0) {
          await writeFile(outPath, bytes);
          return outPath;
        }
      } catch {
        /* no frames beside it: the animation's own default image below */
      }
    }
    const still = stillOfApng(head);
    if (still === undefined) return pngPath;
    await writeFile(outPath, still);
    return outPath;
  } catch {
    return undefined;
  }
}

const ffmpegPoster: FrameExtractor = (videoPath, outDir) =>
  new Promise<string | undefined>((resolve) => {
    const outPath = path.join(outDir, 'poster.png');
    try {
      const proc = spawn(
        'ffmpeg',
        ['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', outPath],
        { stdio: 'ignore' },
      );
      proc.on('error', () => resolve(undefined));
      proc.on('close', (code) => resolve(code === 0 ? outPath : undefined));
    } catch {
      resolve(undefined);
    }
  });
