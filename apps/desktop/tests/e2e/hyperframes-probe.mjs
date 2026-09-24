/**
 * A HYPERFRAMES RENDER IS ONE ANIMATED CARD IN THE THREAD — this probe looks.
 *
 * the user: "attempting a hyperframes animation generation, rendered 120 induvidual
 * frames, each of which was placed as it's own png card in the chat, severely
 * cluttering it."
 *
 * End to end, headless (harness.mjs: a throwaway HOME, the window never shown,
 * and the run fails if anything took the screen):
 *
 *   1. THE REAL RENDERER IN THE APP'S OWN CHROMIUM. `createStillRenderer` (this
 *      tree's source) drives an offscreen BrowserWindow made in the running
 *      app's main process with hyperframes-window.ts's exact options, pins the
 *      virtual clock per frame, and writes each capture into `frames/`, live.
 *      The seek must genuinely move pixels.
 *   2. ONE OUTPUT: `animation.png`, every frame joined into an APNG. Checked by
 *      ffprobe/ffmpeg when this Mac has them — frame count, and every decoded
 *      frame pixel-identical to its capture.
 *   3. WHAT THE MODEL READS — the real `generate_video` tool over a fake bridge —
 *      names one file and the frames by their folder, with a poster attached
 *      that needed no ffmpeg.
 *   4. THE THREAD SHOWS ONE CARD, AND IT MOVES. The old text (one line per
 *      frame) lands first, as the before picture; then the new one. Exactly one
 *      media card; Chromium decodes the file as an animation of every frame
 *      (ImageDecoder); and the card's pixels change over time.
 *
 *   node tests/e2e/hyperframes-probe.mjs          (OUT=<dir> keeps the pictures)
 *
 * The renderer, the APNG writer and the tool are bundled from SOURCE at the top
 * of the run; only the thread comes from the built app (dist/). So this proves
 * the tree as it is without a rebuild — the thread code it drives
 * (thread-media.ts, MediaCard) is unchanged by the fix.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, launchApp, probeHome, REPO_ROOT } from './harness.mjs';

const OUT = process.env.OUT ?? path.join(tmpdir(), 'hyperframes-probe');
mkdirSync(OUT, { recursive: true });
process.env.SHOT_DIR = OUT;
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

// ── the source under test ────────────────────────────────────────────────────
const entry = path.join(OUT, 'probe-entry.mjs');
writeFileSync(
  entry,
  [
    `export { ANIMATION_FILE, FRAMES_DIR, createStillRenderer } from ${JSON.stringify(path.join(APP_ROOT, 'electron/gen/hyperframes-still.ts'))};`,
    `export { isApng, readPngChunks } from ${JSON.stringify(path.join(APP_ROOT, 'electron/gen/apng.ts'))};`,
    `export { defaultExtractPosterFrame } from ${JSON.stringify(path.join(APP_ROOT, 'electron/gen/video-dispatch.ts'))};`,
    `export { registerGenTools } from ${JSON.stringify(path.join(REPO_ROOT, 'packages/gen-tools/src/tools.ts'))};`,
  ].join('\n'),
);
const bundle = path.join(OUT, 'probe-bundle.mjs');
execFileSync(
  path.join(APP_ROOT, 'node_modules/.bin/esbuild'),
  [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${bundle}`,
    '--external:@mariozechner/*',
    '--external:electron',
    '--log-level=error',
  ],
  { cwd: APP_ROOT },
);
const src = await import(pathToFileURL(bundle).href);

/**
 * Moves every frame — an orange ball rolling the width of the frame under a
 * title that rises in — so "did the card animate" is a question with an answer.
 * CSS animations only: exactly what the seek drives.
 */
const SCENE = `
<div class="stage"><h1>Bobble makes motion graphics</h1><div class="ball"></div></div>
<style>
  body { background: #0e1116; }
  .stage { position: relative; width: 640px; height: 352px; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  h1 { position: absolute; top: 64px; left: 40px; margin: 0; color: #f5f5f7; font-size: 40px;
    animation: rise 1.2s ease-out both; }
  @keyframes rise { from { opacity: 0.2; transform: translateY(24px); } to { opacity: 1; transform: none; } }
  .ball { position: absolute; top: 212px; left: 24px; width: 72px; height: 72px; border-radius: 50%;
    background: #ff8a3d; animation: roll 5s linear both; }
  @keyframes roll { from { transform: translateX(0); } to { transform: translateX(520px); } }
</style>`;

const home = probeHome('hyperframes');
const outputDir = path.join(home, 'Bobble', 'generated', 'bobble-makes-motion-graphics');
const framesDir = path.join(outputDir, 'frames');
mkdirSync(outputDir, { recursive: true });

const { app, page, shot, check, finish } = await launchApp('hyperframes-probe', {
  env: { HOME: home, PI_DESKTOP_GEN: '1' },
  args: ['--', '--piE2E=1'],
  timeout: 40_000,
});

/**
 * hyperframes-window.ts, reached through the running app: the same options, the
 * same settle, the same capture — only the window lives in the probe's app
 * rather than being opened by the gen manager.
 */
async function openWindowInApp(width, height) {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = new BrowserWindow({
        width: w,
        height: h,
        show: false,
        frame: false,
        webPreferences: {
          offscreen: true,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.setZoomFactor(1);
      globalThis.__hfProbeWin = win;
    },
    [width, height],
  );
  return {
    load: (html) =>
      app.evaluate(async (_electron, doc) => {
        await globalThis.__hfProbeWin.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`,
        );
        await new Promise((r) => setTimeout(r, 150));
      }, html),
    evaluate: (script) =>
      app.evaluate(
        (_electron, s) => globalThis.__hfProbeWin.webContents.executeJavaScript(s, true),
        script,
      ),
    capture: async () =>
      Buffer.from(
        await app.evaluate(async () =>
          (await globalThis.__hfProbeWin.webContents.capturePage()).toPNG().toString('base64'),
        ),
        'base64',
      ),
    dispose: () =>
      app.evaluate(() => {
        const win = globalThis.__hfProbeWin;
        if (win !== undefined && !win.isDestroyed()) win.destroy();
        globalThis.__hfProbeWin = undefined;
      }),
  };
}

/** Every absolute media path in a result text — what the thread mounts as cards. */
const mediaPaths = (text) =>
  [...text.matchAll(/(?<![:\w/])(\/[^\s()]+\.(png|jpe?g|webp|gif|mp4|webm|mov))/g)].map(
    (m) => m[1],
  );

/** The conversation's height, as a reader would put it. */
const tall = (px) => (px === null ? 'which fits without scrolling' : `${px}px tall`);

const has = (bin) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', undefined, {
    timeout: 30_000,
  });

  // ── 1. render: the real renderer in the app's Chromium ─────────────────────
  // the user's clip: the app's own defaults (640x352, five seconds at 24 fps).
  const progress = [];
  const renderStart = Date.now();
  const outputs = await src.createStillRenderer({
    openWindow: openWindowInApp,
    writeFile: (file, data) => writeFile(file, data),
  })(
    {
      prompt: SCENE,
      modelId: 'hyperframes',
      width: 640,
      height: 352,
      seconds: 5,
      fps: 24,
      seeds: [7],
    },
    outputDir,
    (e) => {
      if (e.event === 'progress') progress.push(e);
    },
  );
  say(`rendered in ${((Date.now() - renderStart) / 1000).toFixed(1)}s`);

  const frameFiles = readdirSync(framesDir)
    .filter((f) => f.endsWith('.png'))
    .sort();
  const frameBytes = frameFiles.map((f) => readFileSync(path.join(framesDir, f)));
  const distinct = new Set(frameBytes.map((b) => createHash('sha1').update(b).digest('hex'))).size;
  say(`frames/: ${frameFiles.length} PNGs, ${distinct} distinct`);
  check(frameFiles.length === 121, `expected 121 frames in frames/, found ${frameFiles.length}`);
  check(distinct > 100, `the seek barely moved the scene: ${distinct} distinct frames`);
  check(
    progress.length === 121 &&
      progress.every((e) => e.previewPath === path.join(framesDir, frameFileAt(e.step - 1))),
    `every frame should preview live from frames/ as it lands (got ${progress.length} events)`,
  );

  // ── 2. one output: the APNG ────────────────────────────────────────────────
  say(`outputs: ${JSON.stringify(outputs)}`);
  check(outputs.length === 1, `the job returned ${outputs.length} outputs — must be ONE`);
  const out = outputs[0];
  const animation = path.join(outputDir, src.ANIMATION_FILE);
  check(out?.outputPath === animation, `the output is not animation.png: ${out?.outputPath}`);
  check(
    out?.frames?.animated === true && out.frames.count === 121 && out.frames.fps === 24,
    `the output's frames are wrong: ${JSON.stringify(out?.frames)}`,
  );
  const apng = readFileSync(animation);
  const chunks = src.readPngChunks(apng);
  const actl = chunks.find((c) => c.type === 'acTL')?.data;
  const count = (t) => chunks.filter((c) => c.type === t).length;
  const framesTotal = frameBytes.reduce((n, b) => n + b.length, 0);
  say(
    `animation.png: ${(apng.length / 1024).toFixed(0)} KB (the frames total ${(framesTotal / 1024).toFixed(0)} KB); ` +
      `acTL ${actl?.readUInt32BE(0)} frames, plays ${actl?.readUInt32BE(4)}; ` +
      `${count('fcTL')} fcTL, ${count('IDAT')} IDAT, ${count('fdAT')} fdAT`,
  );
  check(src.isApng(apng), 'animation.png is not an animated PNG');
  check(
    actl?.readUInt32BE(0) === 121 && count('fcTL') === 121,
    'the APNG does not hold 121 frames',
  );
  // What the capture actually produced — capturePage works in device pixels, so
  // on a Retina display a 640x352 request comes back at twice that.
  const pixels = { w: chunks[0]?.data.readUInt32BE(0), h: chunks[0]?.data.readUInt32BE(4) };
  say(`requested 640x352; the frames are ${pixels.w}x${pixels.h} device pixels`);

  if (has('ffprobe') && has('ffmpeg')) {
    const probe = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,width,height,nb_read_frames',
        '-of',
        'json',
        animation,
      ],
      { encoding: 'utf8' },
    );
    const stream = JSON.parse(probe).streams?.[0] ?? {};
    say(`ffprobe: ${JSON.stringify(stream)}`);
    check(
      stream.codec_name === 'apng' && Number(stream.nb_read_frames) === 121,
      `ffprobe does not read a 121-frame APNG: ${JSON.stringify(stream)}`,
    );
    const md5s = (args) =>
      execFileSync('ffmpeg', ['-v', 'error', ...args, '-f', 'framemd5', '-'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l !== '' && !l.startsWith('#'))
        .map((l) => l.split(',').pop()?.trim());
    const fromApng = md5s(['-i', animation]);
    const fromFrames = md5s(['-framerate', '24', '-i', path.join(framesDir, 'frame_%03d.png')]);
    const same =
      fromApng.length === fromFrames.length && fromApng.every((m, i) => m === fromFrames[i]);
    say(`ffmpeg: ${fromApng.length} decoded APNG frames, pixel-identical to the captures: ${same}`);
    check(same, 'a decoded APNG frame differs from the capture it was made from');
  } else {
    say('ffmpeg not on this Mac — the independent decode is skipped (Chromium still checks below)');
  }

  // ── 3. what the model reads ────────────────────────────────────────────────
  const poster = await src.defaultExtractPosterFrame(animation, outputDir);
  check(
    poster === path.join(outputDir, 'poster.png') && !src.isApng(readFileSync(poster)),
    `the poster should be a plain still beside the animation, got ${poster}`,
  );
  const tools = new Map();
  src.registerGenTools(
    { registerTool: (def) => tools.set(def.name, def) },
    {
      bridge: {
        request: async (method) => {
          if (method !== 'generateVideo') throw new Error(`unexpected ${method}`);
          return { jobId: 'probe', outputs, posterFramePath: poster };
        },
      },
    },
  );
  const result = await tools
    .get('generate_video')
    .execute(
      'c1',
      { prompt: 'kinetic typography: Bobble makes motion graphics', model: 'hyperframes' },
      undefined,
      undefined,
      {},
    );
  const toolText = result.content.find((c) => c.type === 'text')?.text ?? '';
  console.log(`\n── what the model reads ──\n${toolText}\n──`);
  check(
    JSON.stringify(mediaPaths(toolText)) === JSON.stringify([animation]),
    `the result names ${mediaPaths(toolText).length} media files — must be exactly animation.png`,
  );
  check(toolText.includes(`in the folder ${framesDir}/`), 'the frames folder is not named');
  check(
    result.content.filter((c) => c.type === 'image').length === 1,
    'the poster was not attached for the model to see',
  );

  // ── 4. the thread ──────────────────────────────────────────────────────────
  const ASK = 'Make me a 5 second motion graphics title: Bobble makes motion graphics';
  const startCall = (n) =>
    page.evaluate(
      ([i, ask]) => {
        window.__pi_store().setState({
          messages: [
            { kind: 'user', id: `u${i}`, text: ask, timestamp: Date.now() },
            {
              kind: 'assistant',
              id: `a${i}`,
              timestamp: Date.now(),
              isStreaming: true,
              blocks: [
                {
                  type: 'toolCall',
                  id: `c${i}`,
                  name: 'generate_video',
                  arguments: { prompt: ask, model: 'hyperframes' },
                },
              ],
            },
          ],
          runningToolCalls: [`c${i}`],
          streaming: true,
        });
      },
      [n, ASK],
    );
  const finishCall = (n, text) =>
    page.evaluate(
      ([i, t]) => {
        const store = window.__pi_store();
        const s = store.getState();
        store.setState({
          messages: [
            ...s.messages.map((m) => (m.kind === 'assistant' ? { ...m, isStreaming: false } : m)),
            {
              kind: 'toolResult',
              id: `tr-a${i}-c${i}`,
              toolCallId: `c${i}`,
              assistantId: `a${i}`,
              toolName: 'generate_video',
              text: t,
              isError: false,
              timestamp: Date.now(),
            },
          ],
          runningToolCalls: [],
          streaming: false,
        });
      },
      [n, text],
    );
  /** Run one generate_video call through the thread, pending card to finished card. */
  /**
   * Every picture the result put in the thread: the finished cards, plus the
   * one still coming out from under the handover sweep (PendingMediaCard holds
   * the FIRST item until its sweep ends — and its loader stops while scrolled
   * out of view, so under a pile of cards that sweep never ends).
   */
  const pictures = () =>
    page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="media-card"]').length;
      const handing = document.querySelectorAll('[data-testid="pending-image"]').length;
      // The conversation's own scroller: the nearest ancestor that scrolls.
      let scroller = document.querySelector(
        '[data-testid="pending-media-card"], [data-testid="media-card"]',
      );
      while (scroller !== null) {
        const overflow = getComputedStyle(scroller).overflowY;
        if (
          (overflow === 'auto' || overflow === 'scroll') &&
          scroller.scrollHeight > scroller.clientHeight
        )
          break;
        scroller = scroller.parentElement;
      }
      return {
        cards,
        handing,
        total: cards + handing,
        pendingLeft: document.querySelectorAll('[data-testid="pending-media-card"]').length,
        threadHeight: scroller?.scrollHeight ?? null,
      };
    });
  const land = async (n, text) => {
    await startCall(n);
    await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 15_000 });
    await finishCall(n, text);
  };

  // BEFORE — the text the old renderer's 121 outputs produced: one line per frame.
  const oldText =
    `Generated ${frameFiles.length} videos on the canvas:\n` +
    frameFiles.map((f, i) => `  ${i + 1}. ${path.join(framesDir, f)} (seed 7)`).join('\n') +
    '\nModel: HyperFrames (motion graphics) (hyperframes, apache-2.0)';
  await land(1, oldText);
  await page.waitForFunction(
    (want) =>
      document.querySelectorAll('[data-testid="media-card"], [data-testid="pending-image"]')
        .length >= want,
    frameFiles.length,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);
  const before = await pictures();
  say(
    `BEFORE (old result text): ${before.total} pictures in the thread, ${tall(before.threadHeight)}`,
  );
  await shot('1-before-one-card-per-frame');

  // AFTER — the real tool text, through the real handover, which must finish.
  await land(2, toolText);
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="pending-media-card"]') === null &&
        document.querySelector('[data-testid="media-card"]') !== null,
      undefined,
      { timeout: 20_000 },
    );
  } catch (err) {
    say(`the handover never finished: ${JSON.stringify(await pictures())}`);
    await shot('handover-stuck');
    throw err;
  }
  await page.waitForTimeout(800);
  const after = await pictures();
  say(
    `AFTER (new result text): ${after.total} picture(s) in the thread, ${tall(after.threadHeight)}`,
  );
  check(
    after.total === 1 && after.cards === 1,
    `the thread shows ${after.total} pictures for one animation`,
  );
  await shot('2-after-one-animated-card');

  const img = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="media-card"] img[data-testid="media-image"]');
    return el === null
      ? null
      : { src: el.getAttribute('src'), w: el.naturalWidth, h: el.naturalHeight, ok: el.complete };
  });
  say(`card image: ${JSON.stringify(img)}`);
  check(
    img?.src?.endsWith('/animation.png') === true && img.w === pixels.w && img.h === pixels.h,
    `the card is not showing animation.png at ${pixels.w}x${pixels.h}: ${JSON.stringify(img)}`,
  );

  // Chromium's own decoder: an animation, every frame, looping.
  const decoded = await page.evaluate(async (url) => {
    if (typeof ImageDecoder === 'undefined') return { supported: false };
    const data = await (await fetch(url)).arrayBuffer();
    const dec = new ImageDecoder({ data, type: 'image/png' });
    await dec.tracks.ready;
    await dec.completed;
    const track = dec.tracks.selectedTrack;
    const samples = [];
    for (const i of [0, Math.floor(track.frameCount / 2), track.frameCount - 1]) {
      const { image } = await dec.decode({ frameIndex: i });
      samples.push({ frame: i, w: image.displayWidth, h: image.displayHeight, us: image.duration });
      image.close();
    }
    return {
      supported: true,
      animated: track.animated,
      frameCount: track.frameCount,
      loops: track.repetitionCount === Number.POSITIVE_INFINITY ? 'forever' : track.repetitionCount,
      samples,
    };
  }, img?.src);
  say(`Chromium ImageDecoder: ${JSON.stringify(decoded)}`);
  check(
    decoded.supported === false || (decoded.animated === true && decoded.frameCount === 121),
    `Chromium does not decode a 121-frame animation: ${JSON.stringify(decoded)}`,
  );

  // And it MOVES, in the thread: the card sampled over one loop.
  const card = page.locator('[data-testid="media-card"] .pd-media-frame').first();
  await card.scrollIntoViewIfNeeded();
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const buf = await card.screenshot();
    samples.push(buf);
    if (i % 2 === 0) writeFileSync(path.join(OUT, `3-card-t${i}.png`), buf);
    await page.waitForTimeout(700);
  }
  const moving = new Set(samples.map((b) => createHash('sha1').update(b).digest('hex'))).size;
  say(`the card over ${samples.length} samples, 0.7 s apart: ${moving} distinct pictures`);
  check(moving >= 3, `the card did not animate in the thread (${moving} distinct samples)`);

  // Keep the files for the report — the throwaway home is deleted by finish().
  copyFileSync(animation, path.join(OUT, 'animation.png'));
  copyFileSync(poster, path.join(OUT, 'poster.png'));
  writeFileSync(path.join(OUT, 'tool-result.txt'), `${toolText}\n`);
} catch (err) {
  check(false, `probe threw: ${err?.stack ?? err}`);
} finally {
  await finish();
  console.log(`pictures: ${OUT}`);
}

function frameFileAt(i) {
  return `frame_${String(i).padStart(3, '0')}.png`;
}
