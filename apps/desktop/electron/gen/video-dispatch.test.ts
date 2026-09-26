import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { type GenJob, type GenOutput, getModel } from '@pi-desktop/gen-service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeApng, isApng, readPngFrame } from './apng';
import { FRAMES_DIR, frameFileName } from './hyperframes-still';
import {
  buildVideoJob,
  clipSeconds,
  defaultExtractPosterFrame,
  HyperFramesRunner,
  hyperFramesRenderUnavailable,
  makeVideoAwareRunner,
  type VideoJobParams,
} from './video-dispatch';

/** A runner that records the jobs it received and returns a canned output. */
function fakeRunner(tag: string) {
  const calls: GenJob[] = [];
  return {
    calls,
    run: vi.fn(async (job: GenJob): Promise<GenOutput[]> => {
      calls.push(job);
      return [{ outputPath: `/out/${tag}.mp4`, modality: job.modality, model: tag }];
    }),
  };
}

const PARAMS: VideoJobParams = {
  prompt: 'a spinning logo',
  width: 768,
  height: 512,
  seconds: 4,
  fps: 24,
  seed: 7,
};

function jobOf(backend: GenJob['backend']): GenJob {
  return { id: 'j1', modality: 'video', backend, outputDir: '/out' };
}

describe('makeVideoAwareRunner', () => {
  it('routes comfyui → comfy, hyperframes → hyperframes, else → fallback', async () => {
    const comfy = fakeRunner('comfy');
    const hyperframes = fakeRunner('hf');
    const fallback = fakeRunner('uv');
    const runner = makeVideoAwareRunner({ comfy, hyperframes, fallback });

    await runner(jobOf('comfyui'), {});
    await runner(jobOf('hyperframes'), {});
    await runner(jobOf('mflux'), {});

    expect(comfy.run).toHaveBeenCalledTimes(1);
    expect(hyperframes.run).toHaveBeenCalledTimes(1);
    expect(fallback.run).toHaveBeenCalledTimes(1);
    // The image (mflux) path is unchanged — it still reaches the uv fallback.
    expect(fallback.calls[0]?.backend).toBe('mflux');
  });

  it('forwards onEvent/signal opts to the chosen runner', async () => {
    const comfy = fakeRunner('comfy');
    const runner = makeVideoAwareRunner({
      comfy,
      hyperframes: fakeRunner('hf'),
      fallback: fakeRunner('uv'),
    });
    const onEvent = vi.fn();
    await runner(jobOf('comfyui'), { onEvent });
    expect(comfy.run).toHaveBeenCalledWith(expect.objectContaining({ backend: 'comfyui' }), {
      onEvent,
    });
  });
});

describe('buildVideoJob', () => {
  it('builds a ComfyUI job for a comfyui-backed video model (frames = seconds × fps)', () => {
    const model = getModel('wan2.1-t2v-1.3b');
    if (model === undefined) throw new Error('missing wan2.1-t2v-1.3b in catalog');
    const job = buildVideoJob(model, PARAMS, 'job-c', '/out/dir');

    expect(job.backend).toBe('comfyui');
    expect(job.modality).toBe('video');
    expect(job.video).toBeUndefined();
    expect(job.comfy?.workflowTemplate).toBe(model.comfy?.workflowTemplate);
    expect(job.comfy?.modelId).toBe('wan2.1-t2v-1.3b');
    expect(job.comfy?.seeds).toEqual([7]);
    // 4s × 24fps = 96 frames; only template-bound keys are present (no fps/seconds).
    expect(job.comfy?.inputs).toMatchObject({
      prompt: 'a spinning logo',
      width: 768,
      height: 512,
      length: 96,
    });
    expect(job.comfy?.inputs.fps).toBeUndefined();
    expect(job.comfy?.inputs.seconds).toBeUndefined();
  });

  it('builds a HyperFrames video job for the hyperframes-backed model', () => {
    const model = getModel('hyperframes');
    if (model === undefined) throw new Error('missing hyperframes in catalog');
    const job = buildVideoJob(model, PARAMS, 'job-h', '/out/dir');

    expect(job.backend).toBe('hyperframes');
    expect(job.comfy).toBeUndefined();
    expect(job.video).toMatchObject({
      prompt: 'a spinning logo',
      modelId: 'hyperframes',
      width: 768,
      height: 512,
      seconds: 4,
      fps: 24,
      seeds: [7],
    });
  });

  it('rejects a non-video model', () => {
    const image = getModel('flux2-klein-4b');
    if (image === undefined) throw new Error('missing flux2-klein-4b');
    expect(() => buildVideoJob(image, PARAMS, 'x', '/out')).toThrow(/not a video model/);
  });
});

describe('HyperFramesRunner', () => {
  it("delegates to the injected renderer with the job's video spec", async () => {
    const render = vi.fn(async () => [
      { outputPath: '/out/hf.mp4', modality: 'video' as const, model: 'hyperframes' },
    ]);
    const runner = new HyperFramesRunner(render);
    const model = getModel('hyperframes');
    if (model === undefined) throw new Error('missing hyperframes');
    const job = buildVideoJob(model, PARAMS, 'job-h', '/out/dir');

    const onEvent = vi.fn();
    const outputs = await runner.run(job, { onEvent });

    expect(outputs).toHaveLength(1);
    expect(render).toHaveBeenCalledWith(job.video, '/out/dir', expect.any(Function), undefined);
  });

  it('throws when the job is missing its `video` spec', async () => {
    const runner = new HyperFramesRunner(async () => []);
    await expect(runner.run(jobOf('hyperframes'), {})).rejects.toThrow(/missing its `video` spec/);
  });

  it('the default (not-installed) renderer emits an error event and rejects', async () => {
    const model = getModel('hyperframes');
    if (model === undefined) throw new Error('missing hyperframes');
    const job = buildVideoJob(model, PARAMS, 'job-h', '/out/dir');
    const onEvent = vi.fn();
    const runner = new HyperFramesRunner(hyperFramesRenderUnavailable);

    await expect(runner.run(job, { onEvent })).rejects.toThrow(/not installed/);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'error' }));
  });
});

/*
 * THE POSTER NEEDS NO FFMPEG FOR A PNG. HyperFrames' one output is an animated
 * PNG (or, if joining failed, a lone frame); ffmpeg is not bundled, so the model
 * would otherwise get no picture of its own animation on any Mac but a
 * developer's.
 */
describe('defaultExtractPosterFrame, for a PNG', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const scratch = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'poster-test-'));
    dirs.push(d);
    return d;
  };

  /** A real 8x4 RGB PNG of one shade. */
  const still = (shade: number): Buffer => {
    const table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc = (b: Buffer) => {
      let c = 0xffffffff;
      for (const x of b) c = (table[(c ^ x) & 0xff] as number) ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const out = Buffer.alloc(body.length + 8);
      out.writeUInt32BE(data.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE(crc(body), body.length + 4);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(8, 0);
    ihdr.writeUInt32BE(4, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc((8 * 3 + 1) * 4, shade);
    for (let y = 0; y < 4; y++) raw[y * 25] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  };

  /*
   * THE POSTER IS THE FRAME THE ANIMATION SETTLES TO. It was frame 0 — for a
   * title card the words a third visible mid-entrance, for an authored scene
   * often an empty plate — and that is the one picture the model is shown to
   * judge its own work by (VQ-11 lite).
   */
  it("a HyperFrames animation's poster is its LAST frame, from the frames beside it", async () => {
    const dir = scratch();
    const frames = [still(10), still(120), still(250)];
    const animation = path.join(dir, 'animation.png');
    writeFileSync(animation, encodeApng(frames, { fps: 12 }));
    mkdirSync(path.join(dir, FRAMES_DIR));
    frames.forEach((f, i) => {
      writeFileSync(path.join(dir, FRAMES_DIR, frameFileName(i, frames.length)), f);
    });

    const poster = await defaultExtractPosterFrame(animation, dir);
    expect(poster).toBe(path.join(dir, 'poster.png'));
    const bytes = readFileSync(poster as string);
    expect(isApng(bytes)).toBe(false);
    expect(readPngFrame(bytes).data.equals(readPngFrame(frames[2] as Buffer).data)).toBe(true);
  });

  it('counts from the animation, so a stale frame from a longer earlier render is not the poster', async () => {
    const dir = scratch();
    const frames = [still(10), still(250)];
    writeFileSync(path.join(dir, 'animation.png'), encodeApng(frames, { fps: 12 }));
    mkdirSync(path.join(dir, FRAMES_DIR));
    frames.forEach((f, i) => {
      writeFileSync(path.join(dir, FRAMES_DIR, frameFileName(i, frames.length)), f);
    });
    // Left over from a five-frame render into the same folder.
    writeFileSync(path.join(dir, FRAMES_DIR, frameFileName(4, 5)), still(77));
    const poster = await defaultExtractPosterFrame(path.join(dir, 'animation.png'), dir);
    const bytes = readFileSync(poster as string);
    expect(readPngFrame(bytes).data.equals(readPngFrame(frames[1] as Buffer).data)).toBe(true);
  });

  it('an animation with no frames beside it falls back to its default image, frame 0', async () => {
    const dir = scratch();
    const frames = [still(10), still(120), still(250)];
    const animation = path.join(dir, 'animation.png');
    writeFileSync(animation, encodeApng(frames, { fps: 12 }));

    const poster = await defaultExtractPosterFrame(animation, dir);
    expect(poster).toBe(path.join(dir, 'poster.png'));
    const bytes = readFileSync(poster as string);
    expect(isApng(bytes)).toBe(false);
    expect(readPngFrame(bytes).data.equals(readPngFrame(frames[0] as Buffer).data)).toBe(true);
  });

  it('a PNG that is not animated is its own poster, and nothing is written', async () => {
    const dir = scratch();
    const frame = path.join(dir, 'frame_036.png');
    writeFileSync(frame, still(90));
    expect(await defaultExtractPosterFrame(frame, dir)).toBe(frame);
    expect(existsSync(path.join(dir, 'poster.png'))).toBe(false);
  });

  it('has no poster, rather than an error, for a PNG it cannot read', async () => {
    const dir = scratch();
    expect(await defaultExtractPosterFrame(path.join(dir, 'missing.png'), dir)).toBeUndefined();
    const broken = path.join(dir, 'broken.png');
    writeFileSync(broken, 'not a png');
    expect(await defaultExtractPosterFrame(broken, dir)).toBeUndefined();
  });
});

describe('a clip is as long as it was asked to be', () => {
  it('the prompt says the length when the caller did not', () => {
    // MEASURED: "a 6-second animated intro" came out 5.0 s.
    expect(clipSeconds(undefined, "a 6-second animated intro for 'Byte Sized'")).toBe(6);
    expect(clipSeconds(undefined, 'a title card, 10 seconds, in yellow')).toBe(10);
    expect(clipSeconds(8, 'a 6-second intro')).toBe(8);
    expect(clipSeconds(undefined, 'a title card')).toBe(5);
  });

  it('a scene’s CSS durations are not the clip’s; lengths stay within 1–60 s', () => {
    expect(clipSeconds(undefined, '<div style="animation: rise 0.9s">Hi</div>')).toBe(5);
    expect(clipSeconds(500, 'x')).toBe(60);
    expect(clipSeconds(0.2, 'x')).toBe(1);
  });
});
