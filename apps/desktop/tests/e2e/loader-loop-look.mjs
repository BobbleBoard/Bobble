/**
 * THE LOADER'S LOOP IN THE REAL APP — what is on its canvas when the browser
 * paints, whether a finished one stays stopped, and whether Reduce Motion ever
 * lets a result out.
 *
 * Four findings from the review of the 2026-09-23 wave (renderer-ui), each
 * staged with no model and no GPU — the chat's card from seeded store state and
 * the gen-live store, the Image studio's from `gen:generate` stubbed in MAIN
 * (studio-leave-return-probe's seam):
 *
 *   A  a video card easing from square to 16:9 (its transition slowed to 4 s
 *      so a loaded machine still has frames to sample): the canvas read between
 *      frames — a ResizeObserver that clears after the draw reads as blank
 *   B  a live picture card whose first decoded step played the closing sweep,
 *      scrolled out of view and back: frames its canvas is drawn in 1.5 s — a
 *      finished loop that restarted and never stops draws every frame
 *   C  Reduce Motion, the Image studio: the waiting mark (a1), after a theme
 *      switch to light (a2), and whether the finished run is filed (a3) — the
 *      exit used to never reach a loader that had stopped drawing
 *
 * The checks assert the fixed behaviour, so the unmodified app fails them —
 * that run is the "before" picture.
 *
 *   OUT=<dir> node apps/desktop/tests/e2e/loader-loop-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { cropPng, eveningPng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page, check, finish, home, shotDir } = await launchApp('loader-loop', {
  waitFor: '[data-testid="composer-input"]',
});
const OUT = process.env.OUT ?? shotDir;
mkdirSync(OUT, { recursive: true });

const media = path.join(home, 'Bobble', 'generated', 'a-red-fox');
mkdirSync(media, { recursive: true });
const FOX = path.join(media, 'fox-1.png');
writeFileSync(FOX, eveningPng());

const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
/** A full-window shot, with the card cut out of it (a clipped capture of a
 * hidden Electron window re-lays the page out — see png.mjs). */
const cardShot = async (label, selector) => {
  const buf = await page.screenshot();
  writeFileSync(path.join(OUT, `${label}-window.png`), buf);
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) return;
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  writeFileSync(
    path.join(OUT, `${label}.png`),
    cropPng(buf, {
      x: Math.max(0, Math.round((box.x - 24) * dpr)),
      y: Math.max(0, Math.round((box.y - 24) * dpr)),
      width: Math.round((box.width + 48) * dpr),
      height: Math.round((box.height + 48) * dpr),
    }),
  );
};
/** How much of the card's canvas is inked right now — sampled, not every pixel. */
const inked = (scope) =>
  page.evaluate((scope) => {
    const c = document.querySelector(`${scope} canvas`);
    if (!(c instanceof HTMLCanvasElement)) return null;
    const ctx = c.getContext('2d');
    if (ctx === null || c.width === 0 || c.height === 0) return null;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    let dark = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      n += 1;
      if (d[i + 3] > 40) {
        lit += 1;
        if (d[i] < 128) dark += 1;
      }
    }
    return { lit, dark, samples: n, w: c.width, h: c.height };
  }, scope);

const user = { kind: 'user', id: 'u1', text: 'a red fox asleep in tall grass', timestamp: 1 };
const running = (name, args) => ({
  kind: 'assistant',
  id: 'a1',
  blocks: [{ type: 'toolCall', id: 'g1', name, arguments: args }],
  timestamp: 2,
  isStreaming: true,
});

try {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });
  await page.evaluate(() => {
    window.__pi_theme?.()?.setFlavor?.('bobble');
    window.__pi_theme?.()?.setMode?.('dark');
  });
  await sleep(800);

  /* ── A. a video card easing to 16:9 ─────────────────────────────────── */
  await set({
    session: { cwd: media },
    agent: { isStreaming: true },
    messages: [user, running('generate_video', { prompt: 'a red fox asleep in tall grass' })],
    runningToolCalls: ['g1'],
  });
  await page.evaluate(() =>
    window.__gen_live().getState().open({
      id: 'pi:gen-v1',
      jobId: 'v1',
      modality: 'video',
      outputs: [],
      status: 'generating',
      startedAt: Date.now(),
    }),
  );
  await page.waitForSelector('[data-testid="pending-media-card"] canvas', { timeout: 10_000 });
  await sleep(1500);
  const settled = await inked('[data-testid="pending-media-card"]');
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.dataset.probe = 'slow';
    s.textContent =
      '.pd-media-card--pending .pd-media-frame { transition-duration: 4s !important; }';
    document.head.appendChild(s);
    window
      .__gen_live()
      .getState()
      .update('pi:gen-v1', { aspect: 16 / 9 });
  });
  const reads = [];
  const t0 = Date.now();
  let midShot = false;
  while (Date.now() - t0 < 3600) {
    const r = await inked('[data-testid="pending-media-card"]');
    if (r !== null) reads.push(r);
    if (!midShot && Date.now() - t0 > 1400) {
      midShot = true;
      await cardShot('a-mid-resize', '[data-testid="pending-media-card"]');
    }
    await sleep(90);
  }
  const blank = reads.filter((r) => r.lit === 0).length;
  const widths = [...new Set(reads.map((r) => r.w))];
  console.log(
    'A resize:',
    JSON.stringify({ settled, reads: reads.length, blank, widths: widths.slice(0, 12) }),
  );
  check(widths.length > 3, `the frame really eased through widths (${widths.length} seen)`);
  check(
    reads.length > 5 && blank === 0,
    `the mark stays on the canvas while the card eases to its aspect (${blank} of ${reads.length} reads blank)`,
  );
  await page.evaluate(() => document.querySelector('style[data-probe="slow"]')?.remove());

  /* ── B. a finished live sweep, scrolled away and back ──────────────── */
  const filler = [];
  for (let i = 0; i < 24; i++) {
    filler.push({ kind: 'user', id: `fu${i}`, text: `Question ${i}?`, timestamp: 1 });
    filler.push({
      kind: 'assistant',
      id: `fa${i}`,
      blocks: [{ type: 'text', text: `Answer ${i}. `.repeat(40) }],
      timestamp: 1,
    });
  }
  await page.evaluate(() => window.__gen_live().getState().clear());
  await set({
    messages: [...filler, user, running('generate_image', { prompt: 'a red fox' })],
    runningToolCalls: ['g1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"] canvas', { timeout: 10_000 });
  const toBottom = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-scroll"]');
      if (el) el.scrollTop = el.scrollHeight;
    });
  await toBottom();
  await sleep(1200);
  // The engine's first decoded step: the card's live preview starts the sweep.
  await app.evaluate(({ BrowserWindow }, png) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('pi-desktop:event', {
        channel: 'gen3d:job',
        payload: {
          jobId: 'img1',
          stage: 'image',
          message: '',
          stagePercent: 10,
          overallPercent: 10,
          done: false,
          preview: {
            dataUri: `data:image/png;base64,${png}`,
            step: 1,
            totalSteps: 8,
            width: 384,
            height: 384,
          },
        },
      });
    }
  }, eveningPng().toString('base64'));
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="pending-media-card"]')?.getAttribute('data-swept') ===
        'true',
      undefined,
      { timeout: 8000 },
    )
    .catch(() => undefined);
  const swept = await page.evaluate(
    () =>
      document.querySelector('[data-testid="pending-media-card"]')?.getAttribute('data-swept') ??
      null,
  );
  await cardShot('b-swept', '[data-testid="pending-media-card"]');
  /* Every frame the loader draws starts with a clearRect on ITS canvas. (A
     MutationObserver on the sweep's style writes cannot see a finished loop:
     re-setting the same `1.0000` changes no attribute and records nothing.) */
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="pending-media-card"] canvas');
    window.__probeWrites = 0;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas === canvas) window.__probeWrites += 1;
      return clear.apply(this, args);
    };
  });
  await sleep(600);
  const idleBefore = await page.evaluate(() => window.__probeWrites);
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    if (el) el.scrollTop = 0;
  });
  await sleep(700);
  const offscreen = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="pending-media-card"]')?.getBoundingClientRect();
    return r ? r.top > window.innerHeight || r.bottom < 0 : null;
  });
  await toBottom();
  await sleep(500);
  await page.evaluate(() => {
    window.__probeWrites = 0;
  });
  await sleep(1500);
  const writes = await page.evaluate(() => window.__probeWrites);
  console.log('B scroll away and back:', JSON.stringify({ swept, idleBefore, offscreen, writes }));
  check(swept === 'true', 'the first decoded step played the closing sweep');
  check(idleBefore === 0, `…and then stopped drawing (${idleBefore} frames in 0.6 s)`);
  check(offscreen === true, 'the card really left the viewport');
  check(
    writes === 0,
    `a finished loader stays stopped after scrolling back (${writes} frames drawn in 1.5 s)`,
  );

  /* ── C. Reduce Motion: the Image studio ────────────────────────────── */
  await page.evaluate(() => window.__gen_live().getState().clear());
  await set({ messages: [], runningToolCalls: [], agent: { isStreaming: false } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const g = { jobs: [] };
    globalThis.__probeGen = g;
    g.emit = (channel, payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('pi-desktop:event', { channel, payload });
      }
    };
    ipcMain.removeHandler('gen:generate');
    ipcMain.handle(
      'gen:generate',
      (_e, req) =>
        new Promise((resolve) => {
          const jobId = `gen_probe_${g.jobs.length + 1}`;
          const job = { req, jobId, tabId: `pi:gen-${jobId}`, resolve };
          job.base = {
            modality: req.kind,
            model: { id: 'probe', label: 'Probe', license: 'Apache-2.0' },
            prompt: req.prompt,
            size: { width: 1024, height: 1024 },
            candidates: [{ seed: 7, status: 'pending' }],
            ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
          };
          g.jobs.push(job);
          g.emit('gen:open', { tabId: job.tabId, payload: { ...job.base, status: 'generating' } });
        }),
    );
  });
  if ((await page.$('[data-testid="modality-image"]')) === null) {
    await page.click('text=Modalities');
    await sleep(300);
  }
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('[data-testid="image-studio"]', { timeout: 30_000 });
  await sleep(700);
  const reduced = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  await page.click('[data-testid="studio-prompt"]');
  await page.keyboard.type('A red fox asleep in tall grass, low evening sun');
  await page.click('[data-testid="studio-run"]');
  await page.waitForSelector('[data-testid="studio-job"] canvas', { timeout: 15_000 });
  await sleep(1500);
  const c1 = await inked('[data-testid="studio-job"]');
  await cardShot('c1-reduced-waiting-dark', '[data-testid="studio-job"]');
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('light'));
  await sleep(800);
  const c2 = await inked('[data-testid="studio-job"]');
  await cardShot('c2-reduced-waiting-light', '[data-testid="studio-job"]');
  await app.evaluate((_e, file) => {
    const g = globalThis.__probeGen;
    const job = g.jobs[g.jobs.length - 1];
    g.emit('gen:update', {
      tabId: job.tabId,
      payload: {
        ...job.base,
        status: 'done',
        candidates: [{ seed: 7, status: 'done', finalSrc: `pd-file://f${file}` }],
      },
    });
    job.resolve({ jobId: job.jobId, outputs: [{ path: file, seed: 7, model: 'probe' }] });
  }, FOX);
  await sleep(3000);
  const c3 = await page.evaluate(() => ({
    pending: document.querySelector('[data-testid="studio-job"]') !== null,
    busy:
      document
        .querySelector('[data-testid="studio-job"] [data-testid="pending-media-card"]')
        ?.getAttribute('aria-busy') ?? null,
    filed: document.querySelectorAll('.pd-studio-run:not([data-testid="studio-job"])').length,
  }));
  await page.screenshot({ path: path.join(OUT, 'c3-reduced-finished.png') });
  console.log('C reduce motion:', JSON.stringify({ reduced, c1, c2, c3 }));
  check(reduced, 'Reduce Motion is on for this part');
  check(
    c1 !== null && c1.lit > 0,
    `the waiting mark is drawn under Reduce Motion (${JSON.stringify(c1)})`,
  );
  check(
    c2 !== null && c2.lit > 0 && c2.dark > 0,
    `…and is redrawn in the light theme's dark ink (${JSON.stringify(c2)})`,
  );
  check(
    !c3.pending && c3.filed >= 1,
    `the finished picture hands over and the run is filed (${JSON.stringify(c3)})`,
  );
} finally {
  await finish();
}
