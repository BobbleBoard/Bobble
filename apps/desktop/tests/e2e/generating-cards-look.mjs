/**
 * LOOK at the generating cards (the user, 2026-09-23): "image/video/other
 * 'generating' inline cards should have no border at all, but with some
 * falloff into the background color of the chat, the animations need to be
 * procedural and not locked to a square aspect ratio or anything."
 *
 * Puts a waiting image, a waiting 16:9 clip and a waiting 3D model in the
 * thread (no GPU: the running tool call and the live job are set in the
 * stores), waits for the cascade act, and measures:
 *   - the frame: border and ground transparent, the loader masked to fade out;
 *   - the field: ink drawn at the left AND right edges of a wide card;
 *   - the light theme: the blocks are visible on a light chat with no plate.
 *
 *   SHOT_DIR=/tmp/gen-cards node apps/desktop/tests/e2e/generating-cards-look.mjs
 */
import { mkdirSync } from 'node:fs';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/gen-cards';
mkdirSync(SHOT_DIR, { recursive: true });
const { page, check, finish } = await launchApp('gen-cards', {
  waitFor: '[data-testid="composer-input"]',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const setTheme = async (mode) => {
  await page.evaluate(
    (mode) =>
      window
        .__settings_store()
        .getState()
        .update({ theme: { flavor: 'bobble', mode } }),
    mode,
  );
  await page.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
    timeout: 5000,
  });
};
const clip = async (label) => {
  const box = await page.locator('[data-testid="pending-media-card"]').first().boundingBox();
  if (box === null) return page.screenshot({ path: `${SHOT_DIR}/${label}.png` });
  return page.screenshot({
    path: `${SHOT_DIR}/${label}.png`,
    clip: {
      x: Math.max(0, box.x - 40),
      y: Math.max(0, box.y - 40),
      width: box.width + 80,
      height: box.height + 80,
    },
  });
};

/** The frame's chrome and how far the drawn field reaches, mid-cascade. */
const measure = () =>
  page.evaluate(() => {
    const card = document.querySelector('[data-testid="pending-media-card"]');
    const frame = card?.querySelector('.pd-media-frame');
    const host = card?.querySelector('.pd-bobble-loader-host');
    const canvas = card?.querySelector('canvas');
    const cs = frame ? getComputedStyle(frame) : null;
    const hs = host ? getComputedStyle(host) : null;
    let reach = null;
    if (canvas instanceof HTMLCanvasElement) {
      const ctx = canvas.getContext('2d');
      if (ctx !== null) {
        const { width, height } = canvas;
        /* The outer 12%: the band the mask fades across (13%). A square board
           centred in a wide card leaves it empty; a field reaches into it. */
        const edge = Math.max(2, Math.round(width * 0.12));
        const inked = (x, y, w, h) => {
          const d = ctx.getImageData(x, y, w, h).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n += 1;
          return n;
        };
        reach = {
          left: inked(0, 0, edge, height),
          right: inked(width - edge, 0, edge, height),
          width,
          height,
        };
      }
    }
    const box = frame?.getBoundingClientRect();
    return {
      kind: card?.getAttribute('data-kind') ?? null,
      border: cs?.borderTopColor ?? null,
      ground: cs?.backgroundColor ?? null,
      mask: hs ? hs.maskImage || hs.webkitMaskImage : null,
      aspect: box ? Math.round((box.width / box.height) * 100) / 100 : null,
      reach,
    };
  });

const transparent = (c) => c === null || /rgba\(0, 0, 0, 0\)|transparent/.test(c);
const user = { kind: 'user', id: 'u1', text: 'make it', timestamp: 1 };
const running = (name, args) => ({
  kind: 'assistant',
  id: 'a1',
  blocks: [{ type: 'toolCall', id: 'g1', name, arguments: args }],
  timestamp: 2,
  isStreaming: true,
});
/* Puzzle 12 × 340 ms + split 1500 ms: the cascade is on screen from ~5.6 s. */
const CASCADE_AT = 6400;

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1200);
  await setTheme('dark');

  /* ── A. a waiting picture ── */
  await set({
    session: { cwd: '/w' },
    agent: { isStreaming: true },
    messages: [user, running('generate_image', { prompt: 'a cat', size: '512x512' })],
    runningToolCalls: ['g1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });
  await sleep(CASCADE_AT);
  const pic = await measure();
  await clip('a-image-dark');
  check(transparent(pic.border), `a waiting picture has no border (${pic.border})`);
  check(transparent(pic.ground), `…and no plate: the chat shows through (${pic.ground})`);
  check(/gradient/.test(pic.mask ?? ''), `…and fades out at its edges (mask ${pic.mask})`);

  /* ── B. a waiting 16:9 clip — the field must run edge to edge ── */
  await set({ messages: [], runningToolCalls: [] });
  await sleep(300);
  await page.evaluate(() => {
    const live = window.__gen_live?.();
    live?.getState().open({
      id: 'pi:gen-probe',
      jobId: 'probe',
      modality: 'video',
      aspect: 16 / 9,
      outputs: [],
      status: 'generating',
      startedAt: Date.now(),
    });
  });
  await set({
    messages: [user, running('generate_video', { prompt: 'waves', size: '1280x720' })],
    runningToolCalls: ['g1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });
  await sleep(CASCADE_AT);
  const clipWide = await measure();
  await clip('b-video-wide-dark');
  check(
    (clipWide.aspect ?? 0) > 1.6,
    `the clip's card is wide, as the job said (${clipWide.aspect})`,
  );
  check(
    clipWide.reach !== null && clipWide.reach.left > 0 && clipWide.reach.right > 0,
    `the field reaches BOTH edges of a wide card, not a centred square: ${JSON.stringify(clipWide.reach)}`,
  );
  check(transparent(clipWide.border), `…with no border (${clipWide.border})`);

  /* ── C. a waiting 3D model — its box is 330×240 ── */
  await set({ messages: [], runningToolCalls: [] });
  await page.evaluate(() => window.__gen_live?.().getState().clear());
  await sleep(300);
  await set({
    messages: [user, running('generate_3d', { prompt: 'a chair' })],
    runningToolCalls: ['g1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });
  await sleep(CASCADE_AT);
  const model = await measure();
  await clip('c-model-dark');
  check(transparent(model.border), `a waiting 3D model has no border either (${model.border})`);
  check(
    model.reach !== null && model.reach.left > 0 && model.reach.right > 0,
    `…and its field fills the wide viewport: ${JSON.stringify(model.reach)}`,
  );

  /* ── D. the light theme: no plate, so the ink must carry itself ── */
  await set({ messages: [], runningToolCalls: [] });
  await setTheme('light');
  await sleep(300);
  await set({
    messages: [user, running('generate_image', { prompt: 'a cat', size: '512x512' })],
    runningToolCalls: ['g1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });
  await sleep(CASCADE_AT);
  const light = await measure();
  await clip('d-image-light');
  const ink = await page.evaluate(() => {
    const host = document.querySelector(
      '[data-testid="pending-media-card"] .pd-bobble-loader-host',
    );
    return host ? getComputedStyle(host).getPropertyValue('--pd-bobble-ink').trim() : null;
  });
  check(transparent(light.ground), `light theme: no plate (${light.ground})`);
  check(
    ink !== null && !/^#fff(fff)?$|255, 255, 255/.test(ink),
    `light theme: the ink is not white-on-white (${ink})`,
  );
} finally {
  await finish();
}
