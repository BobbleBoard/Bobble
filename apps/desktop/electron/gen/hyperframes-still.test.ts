import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { JobQueue } from '@pi-desktop/gen-service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApng, readPngChunks, readPngFrame } from './apng.js';
import {
  ANIMATION_FILE,
  buildSceneDocument,
  createStillRenderer,
  DEFAULT_FPS,
  FRAMES_DIR,
  frameFileName,
  frameRate,
  frameTimes,
  looksLikeScene,
  MAX_FRAMES,
  type StillRendererDeps,
  type StillWindow,
  seekScript,
} from './hyperframes-still.js';
import { HyperFramesRunner } from './video-dispatch.js';

/**
 * The file side of the renderer, in memory: what was written, which folders were
 * made, and what the join was asked to do. Every test that does not touch the
 * real disk goes through this, so nothing here writes to `/out`.
 */
function fakeFiles(assemble?: StillRendererDeps['assemble']) {
  const log: string[] = [];
  const joins: Array<{ frames: readonly string[]; outPath: string; fps: number }> = [];
  const warnings: Array<{ message: string; detail: Record<string, unknown> }> = [];
  const deps = {
    writeFile: async (p: string) => {
      log.push(`write ${p}`);
    },
    makeDir: async (d: string) => {
      log.push(`mkdir ${d}`);
    },
    assemble:
      assemble ??
      (async (frames: readonly string[], outPath: string, fps: number) => {
        joins.push({ frames: [...frames], outPath, fps });
      }),
    warn: (message: string, detail: Record<string, unknown>) => {
      warnings.push({ message, detail });
    },
  };
  const written = () => log.filter((l) => l.startsWith('write ')).map((l) => l.slice(6));
  return { deps, log, joins, warnings, written };
}

describe('frameTimes', () => {
  it('is inclusive of both ends', () => {
    // A 1s clip at 2fps settles at t=1.0; dropping it loses the frame most worth
    // checking, so three frames is right, not two.
    expect(frameTimes(1, 2)).toEqual([0, 0.5, 1]);
  });

  it('falls back on nonsense input rather than emitting NaN', () => {
    expect(frameTimes(Number.NaN, 2)).toEqual(frameTimes(3, 2));
    expect(frameTimes(1, 0)).toEqual(frameTimes(1, DEFAULT_FPS));
    expect(frameTimes(-4, 2)).toEqual(frameTimes(3, 2));
  });

  it('caps a mistyped duration', () => {
    expect(frameTimes(10_000, 60)).toHaveLength(MAX_FRAMES);
  });

  it('captures at the same rate the animation then plays at', () => {
    expect(frameRate(24)).toBe(24);
    expect(frameRate(0)).toBe(DEFAULT_FPS);
    expect(frameRate(Number.NaN)).toBe(DEFAULT_FPS);
  });

  it('never emits floating-point dust', () => {
    for (const t of frameTimes(2, 3)) expect(String(t)).not.toMatch(/\d{10}/);
  });
});

describe('frameFileName', () => {
  it('pads so frames sort correctly', () => {
    expect(frameFileName(7, 200)).toBe('frame_007.png');
    expect(frameFileName(7, 2000)).toBe('frame_0007.png');
  });

  it('sorts lexically in render order', () => {
    const names = Array.from({ length: 12 }, (_, i) => frameFileName(i, 12));
    expect([...names].sort()).toEqual(names);
  });
});

describe('looksLikeScene', () => {
  it('recognises an authored scene', () => {
    expect(looksLikeScene('<div class="a">hi</div>')).toBe(true);
    expect(looksLikeScene('<svg viewBox="0 0 10 10"></svg>')).toBe(true);
  });

  it('treats plain English as a prompt', () => {
    expect(looksLikeScene('a logo that resolves from three bars')).toBe(false);
  });
});

describe('buildSceneDocument', () => {
  const opts = { width: 800, height: 600, seconds: 2, fps: 10 };

  it('uses an authored scene as-is', () => {
    const doc = buildSceneDocument('<div id="stage">x</div>', opts);
    expect(doc).toContain('<div id="stage">x</div>');
    // The card RULE always ships in the stylesheet; what must not appear is the
    // card markup, which would mean the authored scene had been replaced.
    expect(doc).not.toContain('<div class="hf-card">');
  });

  it('turns a text prompt into a legible card, not a blank frame', () => {
    const doc = buildSceneDocument('Rising bars', opts);
    expect(doc).toContain('hf-card');
    expect(doc).toContain('Rising bars');
  });

  it('escapes a text prompt so it cannot inject markup', () => {
    const doc = buildSceneDocument('a <script>alert(1)</script> title', opts);
    expect(doc).not.toContain('<script>alert(1)</script>');
    expect(doc).toContain('&lt;script&gt;');
  });

  it('sizes the stage to the requested frame', () => {
    expect(buildSceneDocument('x', opts)).toContain('width: 800px; height: 600px');
  });
});

describe('seekScript', () => {
  it('pins animations to the requested instant, in ms', () => {
    const s = seekScript(1.5);
    expect(s).toContain('a.pause()');
    expect(s).toContain('a.currentTime = t * 1000');
    expect(s).toContain('const t = 1.5');
  });

  it('drives a scene that animates itself', () => {
    expect(seekScript(0)).toContain('window.hyperframesSeek');
  });

  it('forces layout so the capture cannot race the seek', () => {
    expect(seekScript(0)).toContain('document.body.offsetHeight');
  });
});

describe('createStillRenderer', () => {
  const makeWin = () => {
    const win: StillWindow & {
      seeks: string[];
      disposed: boolean;
    } = {
      seeks: [],
      disposed: false,
      load: vi.fn(async () => {}),
      evaluate: vi.fn(async (s: string) => {
        win.seeks.push(s);
        return 1;
      }),
      // Distinct bytes per capture by default — a real animation. Tests that
      // need a STATIC render override this.
      capture: vi.fn(async () => Buffer.from(`PNG-${win.seeks.length}`)),
      dispose: vi.fn(async () => {
        win.disposed = true;
      }),
    };
    return win;
  };

  const spec = {
    prompt: '<div>scene</div>',
    modelId: 'hyperframes',
    width: 640,
    height: 360,
    seconds: 1,
    fps: 2,
    seeds: [42],
  };

  it('writes one still per frame instant, into the frames folder', async () => {
    const files = fakeFiles();
    const render = createStillRenderer({ openWindow: async () => makeWin(), ...files.deps });
    await render(spec, '/out', () => {});
    expect(files.written()).toEqual([
      '/out/frames/frame_000.png',
      '/out/frames/frame_001.png',
      '/out/frames/frame_002.png',
    ]);
    // The folder exists before the first frame is written into it.
    expect(files.log[0]).toBe(`mkdir ${path.join('/out', FRAMES_DIR)}`);
  });

  /*
   * the user: "rendered 120 induvidual frames, each of which was placed as it's own
   * png card in the chat, severely cluttering it." One output per frame is what
   * became one card per frame. However many frames, the job returns ONE thing.
   */
  it('returns ONE output — the animated PNG — however many frames it rendered', async () => {
    const files = fakeFiles();
    const render = createStillRenderer({ openWindow: async () => makeWin(), ...files.deps });
    // the user's clip: the app's defaults, five seconds at 24 fps.
    const out = await render({ ...spec, seconds: 5, fps: 24 }, '/out', () => {});
    expect(files.written()).toHaveLength(121);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      outputPath: path.join('/out', ANIMATION_FILE),
      modality: 'image',
      model: 'hyperframes',
      width: 640,
      height: 360,
      seed: 42,
      frames: { dir: '/out/frames', count: 121, fps: 24, animated: true },
    });
  });

  it('a text prompt with no length set runs as long as it says; a scene never reads one from its CSS', async () => {
    const said = fakeFiles();
    await createStillRenderer({ openWindow: async () => makeWin(), ...said.deps })(
      { ...spec, prompt: 'a 2-second title card "Hi"', seconds: undefined, fps: 2 },
      '/out',
      () => {},
    );
    expect(said.written()).toHaveLength(5); // 0, 0.5 … 2 s
    const scene = fakeFiles();
    await createStillRenderer({ openWindow: async () => makeWin(), ...scene.deps })(
      {
        ...spec,
        prompt: '<div class="a">x</div><style>.a { animation: rise 0.5s both; }</style>',
        seconds: undefined,
        fps: 2,
      },
      '/out',
      () => {},
    );
    // The default length (3 s), not the 0.5 s of its CSS.
    expect(scene.written()).toHaveLength(7);
  });

  it('joins exactly the frames it wrote, in order, at the rate it captured them', async () => {
    const files = fakeFiles();
    const render = createStillRenderer({ openWindow: async () => makeWin(), ...files.deps });
    await render(spec, '/out', () => {});
    expect(files.joins).toEqual([
      { frames: files.written(), outPath: '/out/animation.png', fps: 2 },
    ]);
  });

  it('seeks a different instant for every frame', async () => {
    const win = makeWin();
    const render = createStillRenderer({ openWindow: async () => win, ...fakeFiles().deps });
    await render(spec, '/out', () => {});
    expect(win.seeks).toHaveLength(3);
    expect(win.seeks[0]).toContain('const t = 0');
    expect(win.seeks[1]).toContain('const t = 0.5');
    expect(win.seeks[2]).toContain('const t = 1');
  });

  it('reports progress per frame', async () => {
    const steps: Array<[number, number]> = [];
    const render = createStillRenderer({
      openWindow: async () => makeWin(),
      ...fakeFiles().deps,
    });
    await render(spec, '/out', (e) => {
      if (e.event === 'progress') steps.push([e.step, e.total]);
    });
    expect(steps).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  /* the user: "ensure we can see hyperframes stuff being generated and iterating in
   * the canvas." The canvas renders `previewPath` off a progress event, so
   * without it a render is a spinner that resolves all at once at the end. */
  it('previews each frame as it lands, so the canvas fills in live', async () => {
    const previews: string[] = [];
    const render = createStillRenderer({
      openWindow: async () => makeWin(),
      ...fakeFiles().deps,
    });
    await render(spec, '/out', (e) => {
      if (e.event === 'progress' && e.previewPath !== undefined) previews.push(e.previewPath);
    });
    expect(previews).toEqual([
      '/out/frames/frame_000.png',
      '/out/frames/frame_001.png',
      '/out/frames/frame_002.png',
    ]);
  });

  /* An offscreen window that outlives the job keeps a renderer process alive for
   * the life of the app, so it must go back even when the render throws. */
  it('disposes the window even when a capture fails', async () => {
    const win = makeWin();
    win.capture = vi.fn(async () => {
      throw new Error('capture blew up');
    });
    const files = fakeFiles();
    const render = createStillRenderer({ openWindow: async () => win, ...files.deps });
    await expect(render(spec, '/out', () => {})).rejects.toThrow('capture blew up');
    expect(win.disposed).toBe(true);
    expect(files.joins).toEqual([]);
  });

  /*
   * STOPPED IS NOT DONE. The queue, the guardian (shedRunning) and a chat's
   * delete all abort and expect the runner to REJECT — the queue calls a
   * resolve after an abort 'done'. This used to join the frames it had into
   * an animation and return it: a job the user or the guardian stopped was
   * reported as a finished render, and a deleted chat's job wrote new files.
   */
  it('stops between frames when aborted, and rejects without joining anything', async () => {
    const win = makeWin();
    const ac = new AbortController();
    let n = 0;
    const files = fakeFiles();
    const render = createStillRenderer({
      openWindow: async () => win,
      ...files.deps,
      writeFile: async () => {
        if (++n === 1) ac.abort();
      },
    });
    await expect(render(spec, '/out', () => {}, ac.signal)).rejects.toThrow('aborted');
    expect(n).toBe(1);
    expect(files.joins).toEqual([]);
    expect(win.disposed).toBe(true);
  });

  it('a render the queue cancels ends canceled, with the reason — not done', async () => {
    const win = makeWin();
    const files = fakeFiles();
    const queue = new JobQueue({
      runner: (job, opts) =>
        new HyperFramesRunner(
          createStillRenderer({ openWindow: async () => win, ...files.deps }),
        ).run(job, opts),
    });
    const statuses: string[] = [];
    queue.on((e) => {
      if (e.type === 'status') statuses.push(e.status);
    });
    const handle = queue.enqueue(
      {
        id: 'hf-1',
        modality: 'video',
        backend: 'hyperframes',
        outputDir: '/out',
        video: spec,
      },
      {
        onEvent: (e) => {
          // The guardian sheds it after the first frame lands.
          if (e.event === 'progress' && e.step === 1) {
            queue.cancel('hf-1', 'stopped: only 7% of memory was free');
          }
        },
      },
    );
    await expect(handle.result).rejects.toThrow('stopped: only 7% of memory was free');
    expect(statuses).toEqual(['queued', 'running', 'canceled']);
    expect(files.joins).toEqual([]);
  });

  it('fails loudly rather than reporting an empty success', async () => {
    const ac = new AbortController();
    ac.abort();
    const render = createStillRenderer({
      openWindow: async () => makeWin(),
      ...fakeFiles().deps,
    });
    await expect(render(spec, '/out', () => {}, ac.signal)).rejects.toThrow('no frames');
  });

  /*
   * THE JOIN CAN FAIL; THE JOB STILL MUST NOT BECOME 120 CARDS. The frames are
   * on disk and fine, so the honest fallback is the one frame the scene settles
   * to — as the single output — and a line in the log saying why.
   */
  it('falls back to the LAST frame, as the one output, when the join fails — and says so', async () => {
    const files = fakeFiles(async () => {
      throw new Error('frame 2 cannot join the animation: its header differs');
    });
    const render = createStillRenderer({ openWindow: async () => makeWin(), ...files.deps });
    const out = await render(spec, '/out', () => {});
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      outputPath: '/out/frames/frame_002.png',
      modality: 'image',
      seed: 42,
      frames: { dir: '/out/frames', count: 3, fps: 2, animated: false },
    });
    expect(files.warnings).toHaveLength(1);
    expect(files.warnings[0]?.message).toMatch(/could not join the frames/);
    expect(files.warnings[0]?.detail).toMatchObject({
      error: 'frame 2 cannot join the animation: its header differs',
      frames: 3,
      returned: '/out/frames/frame_002.png',
    });
  });
});

/*
 * THE WHOLE PATH ON A REAL DISK: frames written into a real `frames/` folder by
 * the default makeDir, joined by the default (streaming) assembler, and the file
 * that comes out read back as an animation whose frames are the captures.
 */
describe('createStillRenderer on a real disk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A real little PNG, one flat colour — what a capture of a changing scene gives. */
  const png = (shade: number): Buffer => {
    const crcOf = (b: Buffer): number => {
      let c = 0xffffffff;
      for (const byte of b) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer): Buffer => {
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const out = Buffer.alloc(body.length + 8);
      out.writeUInt32BE(data.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE(crcOf(body), body.length + 4);
      return out;
    };
    const w = 16;
    const h = 9;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++)
        raw.set([shade, 255 - shade, 128, 255], y * (w * 4 + 1) + 1 + x * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  };

  it('writes frames/, joins them into animation.png, and the animation IS those frames', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'hf-real-'));
    dirs.push(outputDir);
    const captures: Buffer[] = [];
    const win: StillWindow = {
      load: async () => {},
      evaluate: async () => 1,
      capture: async () => {
        const next = png(captures.length * 40);
        captures.push(next);
        return next;
      },
      dispose: async () => {},
    };
    const render = createStillRenderer({
      openWindow: async () => win,
      writeFile: (p, data) => writeFile(p, data),
    });
    const out = await render(
      {
        prompt: '<div>scene</div>',
        modelId: 'hyperframes',
        width: 16,
        height: 9,
        seconds: 1,
        fps: 4,
        seeds: [7],
      },
      outputDir,
      () => {},
    );

    expect(out).toHaveLength(1);
    const animation = path.join(outputDir, ANIMATION_FILE);
    expect(out[0]?.outputPath).toBe(animation);
    expect(readdirSync(path.join(outputDir, FRAMES_DIR)).sort()).toEqual([
      'frame_000.png',
      'frame_001.png',
      'frame_002.png',
      'frame_003.png',
      'frame_004.png',
    ]);

    const file = readFileSync(animation);
    expect(isApng(file)).toBe(true);
    const chunks = readPngChunks(file);
    const actl = chunks.find((c) => c.type === 'acTL')?.data;
    expect(actl?.readUInt32BE(0)).toBe(5); // num_frames
    expect(actl?.readUInt32BE(4)).toBe(0); // loops forever
    const controls = chunks.filter((c) => c.type === 'fcTL');
    expect(controls).toHaveLength(5);
    for (const c of controls) {
      expect([c.data.readUInt16BE(20), c.data.readUInt16BE(22)]).toEqual([1, 4]); // 1/4 s
    }
    // Frame 0 is the IDAT, frames 1–4 the fdATs — each the capture's own data.
    const data = [
      chunks.find((c) => c.type === 'IDAT')?.data,
      ...chunks.filter((c) => c.type === 'fdAT').map((c) => c.data.subarray(4)),
    ];
    captures.forEach((capture, i) => {
      expect(data[i]?.equals(readPngFrame(capture).data), `frame ${i}`).toBe(true);
    });
  });

  it('leaves the frames and returns the last one when a capture is not a PNG', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'hf-real-'));
    dirs.push(outputDir);
    let n = 0;
    const warnings: string[] = [];
    const render = createStillRenderer({
      openWindow: async () => ({
        load: async () => {},
        evaluate: async () => 1,
        capture: async () => Buffer.from(`not a png ${n++}`),
        dispose: async () => {},
      }),
      writeFile: (p, data) => writeFile(p, data),
      warn: (message) => {
        warnings.push(message);
      },
    });
    const out = await render(
      { prompt: 'x', modelId: 'hyperframes', width: 16, height: 9, seconds: 1, fps: 2, seeds: [] },
      outputDir,
      () => {},
    );
    expect(out.map((o) => o.outputPath)).toEqual([path.join(outputDir, 'frames', 'frame_002.png')]);
    expect(out[0]?.frames?.animated).toBe(false);
    expect(existsSync(path.join(outputDir, ANIMATION_FILE))).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

/*
 * A RENDER THAT DID NOT MOVE IS NOT A SUCCESS.
 *
 * Measured live: a real motion request produced 61 frames, ONE distinct, and the
 * job reported success — a directory of duplicates that looks like a finished
 * animation. The seek script already reported how many animations it pinned and
 * that number was being discarded.
 */
describe('a static render is reported, not passed off', () => {
  const spec = {
    prompt: '<div>scene</div>',
    modelId: 'hyperframes',
    width: 640,
    height: 360,
    seconds: 1,
    fps: 2,
    seeds: [42],
  };

  const staticWin = (animations: number) => {
    const win: StillWindow & { seeks: string[]; disposed: boolean } = {
      seeks: [],
      disposed: false,
      load: vi.fn(async () => {}),
      evaluate: vi.fn(async (s: string) => {
        win.seeks.push(s);
        return animations;
      }),
      capture: vi.fn(async () => Buffer.from('IDENTICAL')),
      dispose: vi.fn(async () => {
        win.disposed = true;
      }),
    };
    return win;
  };

  it('fails when every frame is byte-identical — before joining anything', async () => {
    const files = fakeFiles();
    const render = createStillRenderer({
      openWindow: async () => staticWin(3),
      ...files.deps,
    });
    await expect(render(spec, '/out', () => {})).rejects.toThrow(/IDENTICAL frames/);
    expect(files.joins).toEqual([]);
  });

  it('names the cause when nothing seekable was found', async () => {
    const render = createStillRenderer({
      openWindow: async () => staticWin(0),
      ...fakeFiles().deps,
    });
    await expect(render(spec, '/out', () => {})).rejects.toThrow(
      /No CSS\/Web animations were found to seek/,
    );
  });

  it('tells the author what CAN be seeked', async () => {
    const render = createStillRenderer({
      openWindow: async () => staticWin(0),
      ...fakeFiles().deps,
    });
    await expect(render(spec, '/out', () => {})).rejects.toThrow(/hyperframesSeek/);
  });

  it('still passes a genuinely animated render', async () => {
    const out = await createStillRenderer({
      openWindow: async () => {
        const w = staticWin(2);
        let n = 0;
        w.capture = vi.fn(async () => Buffer.from(`frame-${n++}`));
        return w;
      },
      ...fakeFiles().deps,
    })(spec, '/out', () => {});
    expect(out).toHaveLength(1);
    expect(out[0]?.frames?.count).toBe(3);
  });
});
