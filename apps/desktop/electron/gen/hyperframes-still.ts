/**
 * HYPERFRAMES — the still-frame motion-graphics renderer.
 *
 * The user: "you can ignore video generation (not motion graphics, hyperframes has
 * to be in still renderer and all)."
 *
 * WHAT WAS HERE BEFORE. `hyperFramesRenderUnavailable` in ./video-dispatch.ts —
 * a stub that emits an error saying the toolchain "needs ffmpeg + headless
 * Chrome", and throws. Nothing ever replaced it, so the motion specialist's
 * charter described driving a renderer that did not exist, and every motion
 * commission ended in that message.
 *
 * BOTH DEPENDENCIES WERE ALWAYS WRONG. Headless Chrome is not missing — this is
 * Electron, Chromium is the process we are running inside, and an offscreen
 * BrowserWindow renders and captures without installing anything. And ffmpeg is
 * only needed to ENCODE, which is exactly the part the user cut. Rendering frames as
 * stills removes the whole dependency story: no aux downloads, no codecs, no
 * network, and output a vision model can actually look at.
 *
 * DETERMINISM IS THE POINT, and real time is its enemy. A scene animated by
 * `requestAnimationFrame` renders whatever the machine's load allowed, so two
 * runs differ and neither is reproducible. Instead every frame is rendered by
 * SEEKING a virtual clock: all Web Animations are paused and their `currentTime`
 * set explicitly, and a scene may expose `window.hyperframesSeek(t)` for anything
 * it drives itself. Same scene in, same pixels out, every time — which is what
 * lets a seed mean something for a renderer with no model weights.
 *
 * The pure parts (frame timing, filenames, document assembly, the seek script)
 * are exported and unit-tested; the Electron window is injected so none of that
 * needs a display.
 *
 * ONE ANIMATION, ONE FILE. The user: "rendered 120 induvidual frames, each of which
 * was placed as it's own png card in the chat, severely cluttering it." The
 * stills still land one by one — in a `frames/` folder, each shown live as it
 * arrives — and are then joined into ONE animated PNG (./apng.ts: no encoder, no
 * ffmpeg, the frames' own compressed data), which is the single output the job
 * returns and the single card the thread shows.
 */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { GenAbortError, type GenOutput } from '@pi-desktop/gen-service';
import { createLogger } from '@pi-desktop/shared';
import { writeApngFile } from './apng.js';
import {
  durationFromPrompt,
  looksLikeScene,
  planMotion,
  titleCardDocument,
} from './hyperframes-templates.js';
import type { HyperFramesRender } from './video-dispatch.js';

export { looksLikeScene };

const log = createLogger('desktop:hyperframes');

/** A scene the renderer can drive, and the window it draws into. */
export interface StillSceneOptions {
  readonly width: number;
  readonly height: number;
  readonly seconds: number;
  readonly fps: number;
}

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;
export const DEFAULT_FPS = 12;
export const DEFAULT_SECONDS = 3;
/** A ceiling so a mistyped duration cannot ask for ten thousand captures. */
export const MAX_FRAMES = 300;
/** The folder, inside the job's output folder, the stills are written to. */
export const FRAMES_DIR = 'frames';
/** The one file a render becomes: every frame, joined into an animated PNG. */
export const ANIMATION_FILE = 'animation.png';

/** The rate frames are captured at — and so the rate the animation plays at. */
export function frameRate(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
}

/**
 * The instants to capture, in seconds.
 *
 * Inclusive of t=0 and of the final frame: a 1s clip at 2fps is [0, 0.5, 1.0],
 * three frames, not two. A motion-graphics still set is usually read as
 * start/middle/end, and dropping the last frame loses the thing the scene
 * settles to — which is the frame most worth checking.
 */
export function frameTimes(seconds: number, fps: number): number[] {
  const secs = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SECONDS;
  const rate = frameRate(fps);
  const count = Math.min(MAX_FRAMES, Math.max(1, Math.round(secs * rate) + 1));
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Number((i / rate).toFixed(6)));
  return out;
}

/** Zero-padded so the frames sort correctly in any file browser. */
export function frameFileName(index: number, total: number): string {
  const width = Math.max(3, String(Math.max(0, total - 1)).length);
  return `frame_${String(index).padStart(width, '0')}.png`;
}

/**
 * "10-second", "6 s", "2.5 seconds" → seconds, when a prompt says how long
 * (never from its quoted words, and never a decade: "the 90s").
 */
export function secondsFromPrompt(prompt: string): number | undefined {
  return durationFromPrompt(prompt);
}

/**
 * Wrap whatever we were given into a full document at the right size.
 *
 * A prompt that is already a scene is used as-is inside a sized stage. A text
 * prompt goes through ./hyperframes-templates.ts: the words it quotes (or the
 * prompt itself, when it is the words) become a designed title card in the
 * colours it names — never the instruction printed as a title, which is what
 * this used to make of "10-second animated title card with the text 'Launch
 * day' in bright yellow …" (REAL, twice). A prompt it cannot read as a card —
 * a card with no words, a description of a picture — throws a message that
 * says what to send instead, and the job fails with it rather than rendering a
 * guess.
 */
export function buildSceneDocument(prompt: string, opts: StillSceneOptions): string {
  const plan = planMotion(prompt);
  if (plan.kind === 'refuse') throw new Error(plan.message);
  if (plan.kind === 'title-card') {
    return titleCardDocument(plan.card, {
      width: opts.width,
      height: opts.height,
      seconds: opts.seconds,
    });
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: ${opts.width}px; height: ${opts.height}px;
    overflow: hidden; background: #0b0b0f; color: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
</style></head><body>${prompt}</body></html>`;
}

/**
 * The script evaluated in the page before each capture.
 *
 * Pauses every animation and pins it to `t`, so the frame is a function of the
 * time we asked for and nothing else. A scene that animates itself can expose
 * `window.hyperframesSeek(t)` and will be driven through that too. Returns the
 * number of animations it found, which is how the caller can tell a genuinely
 * static scene from one whose animations never started.
 */
export function seekScript(t: number): string {
  return `(() => {
    const t = ${t};
    let n = 0;
    try {
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; n++; }
    } catch {}
    try { if (typeof window.hyperframesSeek === 'function') { window.hyperframesSeek(t); } } catch {}
    // Force style + layout so the capture cannot race the seek we just did.
    void document.body.offsetHeight;
    return n;
  })()`;
}

/** The Electron surface this needs — injected so the logic tests without a display. */
export interface StillWindow {
  /** Load a full HTML document and resolve once it has settled. */
  load(html: string, width: number, height: number): Promise<void>;
  /** Run a script in the page. */
  evaluate(script: string): Promise<unknown>;
  /** Capture the current frame as PNG bytes. */
  capture(): Promise<Buffer>;
  /** Tear the window down. */
  dispose(): Promise<void>;
}

export interface StillRendererDeps {
  readonly openWindow: (width: number, height: number) => Promise<StillWindow>;
  readonly writeFile: (filePath: string, data: Buffer) => Promise<void>;
  /** Create a folder and its parents. Default: `fs.mkdir(dir, { recursive: true })`. */
  readonly makeDir?: (dir: string) => Promise<void>;
  /**
   * Join the frames, in order, into one animated PNG at `outPath`, each shown
   * for 1/fps s. Default: {@link writeApngFile}, which streams them from disk.
   */
  readonly assemble?: (
    framePaths: readonly string[],
    outPath: string,
    fps: number,
  ) => Promise<void>;
  /** Where a join that failed is reported. Default: the app log. */
  readonly warn?: (message: string, detail: Record<string, unknown>) => void;
}

const defaultMakeDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
};

const defaultAssemble = (framePaths: readonly string[], outPath: string, fps: number) =>
  writeApngFile(framePaths, outPath, { fps });

/**
 * Build the renderer that replaces {@link hyperFramesRenderUnavailable}.
 *
 * Emits progress per frame, honours an abort between frames by rejecting (a
 * capture itself is short, so mid-capture cancellation would buy nothing and
 * risks a half-written file), writes each frame into `<outputDir>/frames/`,
 * and returns ONE {@link GenOutput}: the frames joined into
 * `<outputDir>/animation.png`, an animated PNG — modality `image`, because
 * that is what an `<img>` shows it as.
 * If the join fails, the one output is the last frame on its own; never one
 * output per frame, which is what put 120 cards in the thread.
 */
export function createStillRenderer(deps: StillRendererDeps): HyperFramesRender {
  const makeDir = deps.makeDir ?? defaultMakeDir;
  const assemble = deps.assemble ?? defaultAssemble;
  const warn = deps.warn ?? ((message, detail) => log.warn(message, detail));
  return async (spec, outputDir, onEvent, signal) => {
    const width = spec.width ?? DEFAULT_WIDTH;
    const height = spec.height ?? DEFAULT_HEIGHT;
    const fps = frameRate(spec.fps ?? DEFAULT_FPS);
    // A length the caller did not set is the one a text prompt says ("10-second
    // …") — never one read out of a scene's CSS ("animation: rise 0.9s").
    const said = looksLikeScene(spec.prompt) ? undefined : secondsFromPrompt(spec.prompt);
    const seconds = spec.seconds ?? said ?? DEFAULT_SECONDS;
    const times = frameTimes(seconds, fps);
    const seed = spec.seeds[0];
    const html = buildSceneDocument(spec.prompt, { width, height, seconds, fps });

    const framesDir = path.join(outputDir, FRAMES_DIR);
    await makeDir(framesDir);
    const win = await deps.openWindow(width, height);
    const frames: string[] = [];
    /*
     * A RENDER THAT DID NOT MOVE IS NOT A SUCCESS.
     *
     * Measured: a real motion request produced 61 frames, ONE of them distinct,
     * and the job reported success. The scene the model authored animated in a
     * way the seek cannot drive (JS/rAF, or SMIL, with no `hyperframesSeek`
     * hook), so every frame captured the same instant.
     *
     * `seekScript` already returns how many animations it found and pinned; that
     * return value was being thrown away. Now it is the evidence: zero animations
     * across the whole render, or every frame byte-identical, means the caller is
     * told plainly instead of handed a directory of duplicates that looks like a
     * finished animation.
     */
    let seekedAnimations = 0;
    const digests = new Set<string>();
    try {
      await win.load(html, width, height);
      for (let i = 0; i < times.length; i++) {
        if (signal?.aborted === true) break;
        const t = times[i] ?? 0;
        const found = await win.evaluate(seekScript(t));
        if (typeof found === 'number') seekedAnimations = Math.max(seekedAnimations, found);
        const png = await win.capture();
        digests.add(createHash('sha1').update(png).digest('hex'));
        const file = path.join(framesDir, frameFileName(i, times.length));
        await deps.writeFile(file, png);
        frames.push(file);
        /*
         * SHOW THE FRAME AS IT LANDS. The user: "ensure we can see hyperframes stuff
         * being generated and iterating in the canvas."
         *
         * The canvas renders `previewPath` off a progress event (see
         * ./gen-manager.ts `onEvent`), so pointing it at the frame just written
         * makes the render visibly build up rather than sitting on a spinner and
         * arriving all at once. `step`/`total` drive the same progress readout
         * every other backend uses.
         */
        onEvent({
          event: 'progress',
          jobId: spec.modelId,
          candidate: 0,
          step: i + 1,
          total: times.length,
          previewPath: file,
        });
      }
    } finally {
      // A leaked offscreen window keeps a renderer process alive for the life of
      // the app, so this is not optional and not conditional on success.
      await win.dispose().catch(() => {});
    }
    if (frames.length === 0) {
      throw new Error('hyperframes rendered no frames');
    }
    /*
     * STOPPED IS NOT DONE. Stop, a chat's delete and the guardian's shed all
     * abort, and all of them expect the runner to REJECT — the queue records
     * a resolve after an abort as 'done'. The frames already written stay on
     * disk; nothing is joined from them and nothing is reported finished.
     */
    if (signal?.aborted === true) throw new GenAbortError();
    if (frames.length > 1 && digests.size === 1) {
      throw new Error(
        `hyperframes rendered ${frames.length} IDENTICAL frames — the scene did not animate. ` +
          `${seekedAnimations === 0 ? 'No CSS/Web animations were found to seek: ' : ''}` +
          'every frame is rendered by pinning a virtual clock, so motion must come from CSS ' +
          'animations/transitions or Web Animations, or from a `window.hyperframesSeek(t)` ' +
          'function the scene defines. Motion driven by requestAnimationFrame, setTimeout or ' +
          'SMIL cannot be seeked and renders the same instant every time.',
      );
    }

    const output = (outputPath: string, animated: boolean): GenOutput => ({
      outputPath,
      modality: 'image',
      model: spec.modelId,
      width,
      height,
      ...(seed !== undefined ? { seed } : {}),
      frames: { dir: framesDir, count: frames.length, fps, animated },
    });
    const animation = path.join(outputDir, ANIMATION_FILE);
    try {
      await assemble(frames, animation, fps);
      return [output(animation, true)];
    } catch (err) {
      /*
       * The frames are on disk and fine; only the join failed. So the job still
       * delivers something honest — the frame the scene settles to, as ONE
       * output — and the frames folder is still named alongside it.
       */
      const last = frames[frames.length - 1] as string;
      warn(
        'hyperframes: could not join the frames into an animated PNG; returning the last frame alone',
        {
          error: err instanceof Error ? err.message : String(err),
          frames: frames.length,
          framesDir,
          returned: last,
        },
      );
      return [output(last, false)];
    }
  };
}
