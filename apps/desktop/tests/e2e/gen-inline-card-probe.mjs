/**
 * MEDIA GENERATION IS INLINE NOW — this is the probe that looks at it.
 *
 * the user, round 21: "image/video/audio/media generation tools DO NOT GET SHOWN IN
 * THE CANVAS…. they get shown inline, the large card, same as each studio would
 * show. we need to have custom animations for when these are generating…
 * eg. show the bobble logo as a loader with the squares sliding clockwise like a
 * sliding tile puzzle, until there is a diffusion step ready… for audio you can
 * show some pulsing waveforms that eventually at the end form into a real
 * waveform that's playable."
 *
 * Four claims, none of which a unit test can defend:
 *
 *   1. NO CANVAS. A generate tool that runs and finishes opens no canvas tab and
 *      does not reveal the rail. Measured on the real controller.
 *   2. THE WAIT IS THE MARK. While an image or a video generates, the app's own
 *      three tiles are on the card, sliding — and they are actually MOVING, which
 *      one screenshot cannot show, so the tiles' positions are sampled over time.
 *   3. A DIFFUSION STEP REPLACES IT. The moment a real decoded frame lands the
 *      loader is gone and the picture is in the box.
 *   4. THE WAVEFORM RESOLVES. Audio pulses at exactly the bar geometry the
 *      finished transport uses, then travels onto the real decoded peaks.
 *
 * Everything is driven through the app's own stores and IPC events, so no GPU
 * and no weights are needed to look at how the wait is DRAWN — which is a
 * different question from whether the generator runs, and tying the two together
 * is what makes a visual check too slow to run.
 *
 * Headless by default (harness.mjs): the window is never shown and `finish()`
 * fails the probe if anything took the screen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { launchApp, probeHome } from './harness.mjs';

const OUT = process.env.OUT ?? path.join(process.env.TMPDIR ?? '/tmp', 'gen-inline-card');
mkdirSync(OUT, { recursive: true });
// launchApp writes its screenshots wherever SHOT_DIR points.
process.env.SHOT_DIR = OUT;

/* The app's own generated-media root, in the throwaway home — the `pd-file://`
   fence is scoped to it, so a fixture written anywhere else is served as a 403
   and the card renders a failure instead of the picture. */
const home = probeHome('gen-inline-card');
const MEDIA = path.join(home, 'Bobble', 'generated', 'probe');
mkdirSync(MEDIA, { recursive: true });

/**
 * A real, LOOKABLE picture for the decoded steps.
 *
 * Encoded here rather than pasted as a base64 one-liner because the screenshot
 * is the deliverable: a 2x1 near-black fixture satisfies every assertion about
 * frames arriving and shows a black rectangle to the person the screenshots are
 * for. This is a warm 320x240 field with a bright disc in it — enough shape and
 * enough contrast that "the picture is in the box, unblurring" is visible.
 */
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x / (w - 1), y / (h - 1));
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
writeFileSync(
  path.join(MEDIA, 'step.png'),
  /* Warm amber into teal, with a bright disc — deliberately NOT in the
     magenta/violet family, because these screenshots get read by a person and a
     purple test picture in a no-purple app is a false alarm waiting to happen. */
  png(320, 240, (u, v) => {
    const d = Math.hypot(u - 0.42, v - 0.44);
    const disc = Math.max(0, 1 - d / 0.3) ** 1.6;
    return [
      Math.round(215 * (1 - 0.72 * v) + 40 * disc),
      Math.round(95 + 105 * u + 110 * disc),
      Math.round(35 + 70 * u + 60 * disc),
    ];
  }),
);

/**
 * A real 0.7 s WAV, synthesised here so the waveform under test is a genuine
 * decode of genuine samples — a fixture with a flat or fake envelope would make
 * "the bars travel to their real peaks" unfalsifiable.
 */
function wav(seconds = 0.7, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // A decaying pluck with a tremolo, so the envelope has a shape to check.
    const env = Math.exp(-3.2 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 7 * t));
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * t) * env * 30000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const WAV = path.join(MEDIA, 'sound.wav');
writeFileSync(WAV, wav());
const STEP = path.join(MEDIA, 'step.png');

const { app, page, shot, check, finish } = await launchApp('gen-inline-card', {
  env: { HOME: home, PI_DESKTOP_GEN: '1' },
  args: ['--', '--piE2E=1'],
  timeout: 40_000,
});

/** Put a RUNNING generate tool call in the thread — the card's precondition. */
const runTool = (toolName) =>
  page.evaluate((name) => {
    const store = window.__pi_store();
    store.setState({
      messages: [
        { kind: 'user', id: 'u1', text: 'make me one', timestamp: Date.now() },
        {
          kind: 'assistant',
          id: 'a1',
          timestamp: Date.now(),
          isStreaming: true,
          blocks: [{ type: 'toolCall', id: 'c1', name, arguments: { prompt: 'a red fox' } }],
        },
      ],
      runningToolCalls: ['c1'],
      streaming: true,
    });
  }, toolName);

/** Finish it: the tool result the thread parses its media card out of. */
const finishTool = (toolName, resultText) =>
  page.evaluate(
    ([name, text]) => {
      const store = window.__pi_store();
      const s = store.getState();
      store.setState({
        messages: [
          ...s.messages.map((m) => (m.kind === 'assistant' ? { ...m, isStreaming: false } : m)),
          {
            kind: 'toolResult',
            id: 'tr-a1-c1',
            toolCallId: 'c1',
            assistantId: 'a1',
            toolName: name,
            text,
            isError: false,
            timestamp: Date.now(),
          },
        ],
        runningToolCalls: [],
        streaming: false,
      });
    },
    [toolName, resultText],
  );

/**
 * Push one `gen:open` / `gen:update` surface payload FROM MAIN, on the real
 * wire.
 *
 * Not faked in the page: the renderer subscribes at App mount, long before a
 * probe can get a hook in, and a tap installed afterwards would be testing the
 * tap. `pi-desktop:event` is the single channel the preload's hub dispatches
 * from (electron/preload.ts), so this is the app's own delivery path with only
 * the gen manager replaced.
 */
const stream = (channel, payload) =>
  app.evaluate(
    ({ BrowserWindow }, [ch, p]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('pi-desktop:event', {
        channel: ch,
        payload: { tabId: 'pi:gen-probe1', payload: p },
      });
    },
    [channel, payload],
  );

const canvasState = () =>
  page.evaluate(() => {
    const state = window.__pi_canvas?.().getState?.() ?? { tabs: [] };
    const rail = document.querySelector('[data-testid="canvas-tabs-panel"]');
    return {
      tabs: state.tabs.map((t) => `${t.kind}:${t.title}`),
      open: rail === null ? false : rail.getAttribute('data-open') === 'true',
    };
  });

const rect = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, sel);

try {
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });

  const canvasBefore = await canvasState();

  // ── 1. IMAGE: the wait is the mark, sliding ──────────────────────────────
  await runTool('generate_image');
  await page.waitForSelector('[data-testid="long-job-card"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="bobble-tile-loader"]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  check(
    (await page.$('[data-testid="thread-image-placeholder"]')) !== null,
    'the image placeholder did not mount inline in the thread',
  );
  const phase = await page.getAttribute('[data-testid="thread-image-placeholder"]', 'data-phase');
  check(phase === 'waiting', `expected the card to be waiting, got "${phase}"`);

  /*
   * THE TILES ACTUALLY MOVE, and they move around a BOARD. One screenshot of a
   * loader proves it exists; only a sample over time proves it is animating, and
   * only the set of positions proves it is sliding between four cells rather
   * than spinning or pulsing in place.
   */
  const tileTrack = await page.evaluate(async () => {
    const seen = new Map();
    const at = () =>
      [...document.querySelectorAll('.pd-bobble-tile')].map((el) => {
        const b = el.getBoundingClientRect();
        return `${el.dataset.tile}@${Math.round(b.x)},${Math.round(b.y)}`;
      });
    const t0 = performance.now();
    while (performance.now() - t0 < 5200) {
      for (const p of at()) {
        const [id, xy] = p.split('@');
        if (!seen.has(id)) seen.set(id, new Set());
        seen.get(id).add(xy);
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    return Object.fromEntries([...seen].map(([id, s]) => [id, s.size]));
  });
  const tiles = Object.entries(tileTrack);
  check(tiles.length === 3, `expected the mark's three tiles, saw ${tiles.length}`);
  for (const [id, positions] of tiles) {
    // A full 12-beat cycle at 340ms/beat is 4.08s, so in 5.2s every tile makes
    // all four of its moves. Many distinct positions = it slid; 1 = it is frozen.
    check(positions > 8, `tile "${id}" barely moved (${positions} distinct positions in 5.2s)`);
  }
  await shot('1-image-generating-dark');

  // The card takes the shape the job says it is rendering, from the first event.
  await stream('gen:open', {
    modality: 'image',
    model: { id: 'z-image-turbo', label: 'Z-Image Turbo', license: 'apache-2.0' },
    prompt: 'a red fox',
    size: { width: 1024, height: 768 },
    candidates: [{ status: 'generating', seed: 7 }],
    status: 'generating',
    note: 'Fetching model weights · 62%',
  });
  await page.waitForTimeout(400);
  const noteShown = await page.textContent('[data-testid="long-job-estimate"]');
  check(
    noteShown?.includes('Fetching model weights') === true,
    `the engine's own status line never reached the card (got "${noteShown}")`,
  );
  const box = await rect('.pd-denoise-plate');
  check(
    box !== null && Math.abs(box.w / box.h - 1024 / 768) < 0.06,
    `the card did not take the job's aspect ratio: ${JSON.stringify(box)}`,
  );
  await shot('2-image-generating-note');

  // ── 2. A DIFFUSION STEP REPLACES THE LOADER ──────────────────────────────
  const src = (p) => `pd-file://f${p.split('/').map(encodeURIComponent).join('/')}`;
  const pushStep = async (step) => {
    await stream('gen:update', {
      modality: 'image',
      model: { id: 'z-image-turbo', label: 'Z-Image Turbo', license: 'apache-2.0' },
      prompt: 'a red fox',
      size: { width: 1024, height: 768 },
      candidates: [{ status: 'generating', seed: 7, previewSrc: src(STEP) }],
      progress: { candidate: 0, step, total: 8 },
      status: 'generating',
    });
    await page.waitForTimeout(300);
  };
  // EARLY: the picture is in the box and still resolving — this is the frame
  // the user asked to be able to see ("the user can see image unblur in real time
  // as soon as it resembles anything at all").
  for (const step of [1, 2]) await pushStep(step);
  await page.waitForTimeout(400);
  const early = await page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(
        document.querySelector('[data-testid="thread-image-placeholder"]'),
      ).getPropertyValue('--pd-dn-resolve') || '0',
    ),
  );
  check(early > 0 && early < 0.9, `the card is not mid-resolve at step 2/8 (resolve=${early})`);
  await shot('3-image-unblurring');
  for (const step of [3, 4, 5, 6, 7, 8]) await pushStep(step);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="thread-image-placeholder"]')?.dataset.phase ===
      'resolving',
    undefined,
    { timeout: 10_000 },
  );
  const painted = await page.evaluate(() => {
    const img = document.querySelector('[data-testid="denoise-frame"]');
    const idle = document.querySelector('.pd-denoise-idle');
    return {
      frames: document.querySelector('[data-testid="thread-image-placeholder"]')?.dataset.frames,
      natural: img === null ? 0 : img.naturalWidth,
      caption: document.querySelector('.pd-denoise-caption')?.textContent ?? '',
      loaderOpacity: idle === null ? null : Number(getComputedStyle(idle).opacity),
    };
  });
  check(Number(painted.frames) >= 8, `only ${painted.frames} decoded frames reached the card`);
  check(painted.natural > 0, 'the decoded step never actually loaded (pd-file blocked?)');
  check(
    painted.caption.startsWith('Step '),
    `the card does not say which step is on screen (got "${painted.caption}")`,
  );
  check(
    painted.loaderOpacity === 0,
    `the tile loader is still visible at opacity ${painted.loaderOpacity} once the picture arrived`,
  );
  await shot('3b-image-resolved');

  // ── 3. FINISHED IMAGE: the large card, inline, and NO canvas tab ─────────
  await finishTool(
    'generate_image',
    `Generated 1 image on the canvas:\n  1. ${STEP} (seed 7)\nModel: Z-Image Turbo`,
  );
  await page.waitForSelector('[data-testid="media-card"][data-kind="image"]', { timeout: 10_000 });
  await page.waitForTimeout(700);
  const cards = await page.$$('[data-testid="media-card"]');
  check(cards.length === 1, `the finished picture mounted ${cards.length} cards, expected 1`);
  await shot('4-image-finished');

  const canvasAfter = await canvasState();
  check(
    canvasAfter.tabs.length === canvasBefore.tabs.length,
    `generation opened ${canvasAfter.tabs.length - canvasBefore.tabs.length} canvas tab(s): ${JSON.stringify(canvasAfter.tabs)}`,
  );
  check(canvasAfter.open !== true, 'generation revealed the canvas rail');

  // ── 4. VIDEO: the same loader, for a job with no step images ─────────────
  await runTool('generate_video');
  await stream('gen:open', {
    modality: 'video',
    model: { id: 'ltx-video-2b-distilled', label: 'LTX Video', license: 'other' },
    prompt: 'a boat',
    size: { width: 768, height: 432 },
    candidates: [{ status: 'generating' }],
    progress: { candidate: 0, step: 3, total: 30 },
    status: 'generating',
  });
  await page.waitForSelector('[data-testid="bobble-tile-loader"]', { timeout: 10_000 });
  await page.waitForTimeout(600);
  const vbox = await rect('.pd-denoise-plate');
  check(
    vbox !== null && Math.abs(vbox.w / vbox.h - 768 / 432) < 0.06,
    `the video card is not 16:9: ${JSON.stringify(vbox)}`,
  );
  const vtitle = await page.textContent('[data-testid="long-job-title"]');
  check(vtitle === 'Making your video', `the card calls a video "${vtitle}"`);
  await shot('5-video-generating');

  // ── 5. AUDIO: pulsing bars that resolve onto the real waveform ───────────
  await runTool('generate_sfx');
  await page.waitForSelector('[data-testid="audio-placeholder"]', { timeout: 10_000 });
  await page.waitForTimeout(500);
  const pulsing = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('[data-testid="audio-pending-wave"] span')];
    const card = document.querySelector('[data-testid="audio-placeholder"]');
    return {
      count: bars.length,
      state: card?.dataset.state,
      // A travelling swell means neighbours are at DIFFERENT points of the same
      // animation; identical transforms across the row would be one bar chart
      // breathing, which is what the per-bar delay exists to prevent.
      transforms: new Set(bars.slice(0, 24).map((b) => getComputedStyle(b).transform)).size,
      animated: bars.filter((b) => b.getAnimations().length > 0).length,
    };
  });
  check(pulsing.count === 96, `the pulsing waveform has ${pulsing.count} bars, expected 96`);
  check(pulsing.state === 'pulsing', `audio card state is "${pulsing.state}"`);
  check(pulsing.animated === 96, `only ${pulsing.animated} of 96 bars are animating`);
  check(pulsing.transforms > 4, `the swell is not travelling (${pulsing.transforms} phases seen)`);
  await shot('6-audio-generating');

  // The clip lands: the bars travel from their stand-in shape to the real peaks.
  const heightsBefore = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="audio-pending-wave"] span')].map(
      (b) => b.style.height,
    ),
  );
  await stream('gen:update', {
    modality: 'audio',
    model: { id: 'stable-audio-open-small', label: 'Stable Audio', license: 'other' },
    prompt: 'a door slam',
    candidates: [{ status: 'done', seed: 3, finalSrc: src(WAV) }],
    status: 'generating',
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="audio-placeholder"]')?.dataset.state === 'resolved',
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(800);
  const heightsAfter = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="audio-pending-wave"] span')].map(
      (b) => b.style.height,
    ),
  );
  const moved = heightsAfter.filter((h, i) => h !== heightsBefore[i]).length;
  check(moved > 40, `only ${moved} of 96 bars moved onto the decoded waveform`);
  check(
    new Set(heightsAfter).size > 10,
    'the resolved waveform is flat — the decode produced no shape',
  );
  await shot('7-audio-resolved');

  // ── 6. FINISHED AUDIO: the playable transport, same geometry ─────────────
  const waveBefore = await rect('[data-testid="audio-pending-wave"]');
  await finishTool('generate_sfx', `Generated 1 audio file:\n  1. ${WAV} (seed 3)\nModel: probe`);
  await page.waitForSelector('[data-testid="thread-audio"]', { timeout: 10_000 });
  await page.waitForTimeout(1200);
  const waveAfter = await rect('[data-testid="thread-audio-wave"]');
  check(
    waveBefore !== null &&
      waveAfter !== null &&
      Math.abs(waveBefore.w - waveAfter.w) < 12 &&
      Math.abs(waveBefore.h - waveAfter.h) < 6,
    `the waveform jumped at the handoff: ${JSON.stringify(waveBefore)} → ${JSON.stringify(waveAfter)}`,
  );
  const realBars = await page.$$('[data-testid="thread-audio-wave"] span');
  check(realBars.length === 96, `the playable waveform has ${realBars.length} bars`);
  await shot('8-audio-finished');

  // ── 7. LIGHT MODE, both animations ───────────────────────────────────────
  await page.evaluate(() => window.__pi_theme().setMode('light'));
  await page.waitForTimeout(500);
  await shot('9-audio-finished-light');
  await runTool('generate_image');
  await page.waitForSelector('[data-testid="bobble-tile-loader"]', { timeout: 10_000 });
  await page.waitForTimeout(700);
  await shot('10-image-generating-light');

  // ── 8. NARROW COLUMN: the card has to work at every size ─────────────────
  await page.setViewportSize({ width: 720, height: 820 });
  await page.waitForTimeout(600);
  await shot('11-image-generating-narrow-light');
  await page.evaluate(() => window.__pi_theme().setMode('dark'));
  await page.waitForTimeout(400);
  await runTool('generate_music');
  await page.waitForSelector('[data-testid="audio-placeholder"]', { timeout: 10_000 });
  await page.waitForTimeout(600);
  const narrowWave = await rect('[data-testid="audio-pending-wave"]');
  check(
    narrowWave !== null && narrowWave.w > 60,
    `the waveform collapsed in a narrow column: ${JSON.stringify(narrowWave)}`,
  );
  /*
   * AND IT FITS. the user: the card "must look good at every size the thread renders
   * it at". A card that is merely present while hanging off the right edge — and
   * putting a horizontal scrollbar under the whole conversation — is not.
   */
  const fit = await page.evaluate(() => {
    const card = document.querySelector('.pd-longjob');
    const thread = card?.closest('[data-testid="chat-scroll"]') ?? document.scrollingElement;
    const c = card?.getBoundingClientRect();
    const t = thread?.getBoundingClientRect();
    return {
      overflowRight: c === undefined || t === undefined ? 0 : Math.round(c.right - t.right),
      scrollX: (document.querySelector('[data-testid="chat-scroll"]') ?? document.body).scrollWidth,
      clientX: (document.querySelector('[data-testid="chat-scroll"]') ?? document.body).clientWidth,
    };
  });
  check(fit.overflowRight <= 0, `the card overflows the thread by ${fit.overflowRight}px`);
  check(
    fit.scrollX - fit.clientX <= 1,
    `the thread scrolls sideways (${fit.scrollX} > ${fit.clientX})`,
  );
  await shot('12-audio-generating-narrow-dark');

  // ── 9. THE STUDIO WAITS THE SAME WAY ────────────────────────────────────
  /*
   * ONE ANIMATION, NOT TWO. the user asked for the thread's card to be "the same
   * card its studio would show"; a generic shimmer in the room and the app's own
   * sliding mark in the conversation would be two answers to one question, from
   * one engine, in one app.
   *
   * The BACKEND is stubbed (a `gen:generate` that never resolves) and nothing
   * else is: the studio, its composer, its job card and the loader inside it are
   * the real ones. Weights and a GPU would prove the generator runs, which is a
   * different question from how the wait is drawn.
   */
  await page.setViewportSize({ width: 1440, height: 900 });
  /*
   * STUBBED IN MAIN, not in the page. `contextBridge` objects are frozen in the
   * isolated world, so reassigning `window.piDesktop.invoke` silently does
   * nothing — the first cut of this looked like it had stubbed the backend and
   * had in fact started a real generation, which announced itself by downloading
   * a Python runtime. Replacing the IPC handler is the seam that actually holds.
   */
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('gen:generate');
    ipcMain.handle('gen:generate', () => new Promise(() => {}));
  });
  // The Modalities group can start collapsed; the studio itself is a lazy chunk.
  if ((await page.$('[data-testid="modality-image"]')) === null) {
    await page.click('text=Modalities');
    await page.waitForTimeout(300);
  }
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('[data-testid="image-studio"], .pd-studio', { timeout: 30_000 });
  await page.waitForTimeout(800);
  const prompt = await page.$('[data-testid="studio-prompt"]');
  if (prompt !== null) {
    await prompt.click();
    await page.keyboard.type('a red fox in deep snow');
    await page.click('[data-testid="studio-run"]');
    await page.waitForSelector('[data-testid="studio-job"]', { timeout: 15_000 });
    await page.waitForTimeout(900);
    const inStudio = await page.$('[data-testid="studio-job"] [data-testid="bobble-tile-loader"]');
    check(inStudio !== null, 'the studio waits with a different animation from the thread');
    await shot('13-studio-generating');
  } else {
    check(false, 'the image studio never offered a prompt to run');
  }

  // Nothing anywhere in this run should have reached the canvas.
  const canvasEnd = await canvasState();
  check(
    canvasEnd.tabs.length === canvasBefore.tabs.length,
    `by the end, generation had opened canvas tabs: ${JSON.stringify(canvasEnd.tabs)}`,
  );
} finally {
  const ok = await finish();
  console.log(`gen-inline-card: shots in ${OUT}`);
  if (!ok) process.exitCode = 1;
}
