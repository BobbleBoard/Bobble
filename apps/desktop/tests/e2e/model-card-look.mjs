/**
 * LOOK at the 3D card in the chat — the Bobble 3D connector's result. the user
 * (2026-09-17): "the card for during generation/texturing/segmentation/
 * rigging/.... should be the same as all the others but the card should just
 * be a little embedded viewport rotatable, not all the controls but below the
 * card itself show some basic controls eg. coloring/normals/grey, if rig,
 * skeleton and if segment, then explode."
 *
 * Drives the real app (hidden, throwaway HOME) with three REAL engine outputs
 * from this Mac's own runs — a textured model, a rigged one, a three-part
 * segmentation — seeded as generate_3d / refine_3d results, and reads the
 * viewport's own facts back (framing, bodies, skin, parts) beside the strip:
 * Color / Normals / Grey on all three, Skeleton only under the rig (on by
 * default), Explode only under the parts. Also the waiting card for a running
 * generate_3d, and the chain row that says "Built a 3D model".
 *
 *   SHOT_DIR=/tmp/model-card node apps/desktop/tests/e2e/model-card-look.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { decodePng } from './png.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/model-card';
mkdirSync(SHOT_DIR, { recursive: true });

/* Real engine outputs from this Mac's own runs, copied into the probe HOME's
   engine sandbox — where a result lands today, inside the pd-file fence —
   before the app starts.

   POST-FIX FILES ONLY. the user (2026-09-18), on a card showing f184ded6efb6:
   "what's with this artifacting" — that model was baked 2026-08-18 15:45,
   nine hours BEFORE the dark-crackle fix (65b6ae02, `dilate_atlas`): MEASURED
   37.8% near-black gutter texels in its 4096² atlas against 0.5% in a bake
   from the next morning. The card draws what the file carries, so the
   fixtures are bakes from after the fix; the segmentation is vertex-coloured
   (no atlas) and was never affected. */
const SANDBOX = path.join(homedir(), '.pi', 'desktop', 'sandbox', 'gen3d');
const OLD_SANDBOX = path.join(homedir(), '.cache', 'bobble', 'gen3d', 'sandbox');
/* The rig of 385fa85ad18b (62cbf654a14b, Aug 19) with its TEXCOORD_0 V put the
   right way up — the skinned writer's own fix of 2026-09-18 (_glbskin.py),
   applied to the file; a fresh rig of the same source through today's engine
   renders identically (model-tool-real-probe.mjs). Rebuilt from the Aug 19
   file by flipping V if it is missing. */
const FIXTURES = path.join(process.cwd(), 'scratchpad', 'fixtures', 'gen3d');
const SOURCES = {
  model: process.env.MODEL_FIXTURE ?? path.join(SANDBOX, '385fa85ad18b', 'model.glb'),
  rigged:
    process.env.RIG_FIXTURE ??
    (existsSync(path.join(FIXTURES, 'rigged-v-fixed.glb'))
      ? path.join(FIXTURES, 'rigged-v-fixed.glb')
      : path.join(SANDBOX, '62cbf654a14b', 'rigged.glb')),
  parts: path.join(OLD_SANDBOX, '1b71bafc10f9', 'parts.glb'),
};
for (const [k, f] of Object.entries(SOURCES)) {
  if (!existsSync(f)) throw new Error(`fixture ${k} is missing: ${f}`);
}

const { page, check, finish, home } = await launchApp('model-card', {
  waitFor: '[data-testid="composer-input"]',
});
const FILES = {};
for (const [k, f] of Object.entries(SOURCES)) {
  const dir = path.join(home, '.pi', 'desktop', 'sandbox', 'gen3d', `probe-${k}`);
  mkdirSync(dir, { recursive: true });
  FILES[k] = path.join(dir, path.basename(f));
  copyFileSync(f, FILES[k]);
}
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
const shot = (label) => page.screenshot({ path: `${SHOT_DIR}/${label}.png` });
const clip = async (label, selector) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box) {
    await page.screenshot({
      path: `${SHOT_DIR}/${label}.png`,
      clip: {
        x: Math.max(0, box.x - 24),
        y: Math.max(0, box.y - 24),
        width: box.width + 48,
        height: box.height + 48,
      },
    });
  } else await shot(label);
};

const pdUrl = (abs) => `pd-file://f${abs.split('/').map(encodeURIComponent).join('/')}`;
const resultText = (verb, abs) =>
  `${pdUrl(abs)}\n${verb} ${abs}\nRefer to it as "out/${path.basename(abs)}" — the path relative to the working folder; the model is shown in the chat as a card the user can turn.`;

const user = (id, text, ts) => ({ kind: 'user', id, text, timestamp: ts });
const call = (id, name, args, ts) => ({
  kind: 'assistant',
  id: `a-${id}`,
  blocks: [{ type: 'toolCall', id, name, arguments: args }],
  timestamp: ts,
  isStreaming: false,
});
const result = (id, name, text, ts) => ({
  kind: 'toolResult',
  id: `tr-${id}`,
  toolCallId: id,
  toolName: name,
  text,
  isError: false,
  timestamp: ts,
});

/** The viewport's own account of what it loaded, per card, in thread order. */
const readCards = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="media-card"][data-kind="model"]')].map((card) => {
      const host = card.querySelector('.pd-media-model-host');
      const frame = card.querySelector('.pd-media-frame');
      const strip = card.querySelector('[data-testid="model-controls"]');
      const fb = frame?.getBoundingClientRect();
      const sb = strip?.getBoundingClientRect();
      return {
        framing: host?.dataset.pdFraming ? JSON.parse(host.dataset.pdFraming) : null,
        shading: host?.dataset.pdShading ?? null,
        skeleton: host?.dataset.pdSkeleton ?? null,
        explode: host?.dataset.pdExplode ?? null,
        frameW: fb ? Math.round(fb.width) : null,
        frameH: fb ? Math.round(fb.height) : null,
        stripBelow: fb && sb ? sb.top >= fb.bottom - 1 : null,
        stripW: sb ? Math.round(sb.width) : null,
        buttons: strip
          ? [...strip.querySelectorAll('button')].map((b) => ({
              label: b.textContent,
              on:
                b.getAttribute('aria-pressed') === 'true' ||
                b.getAttribute('aria-checked') === 'true',
            }))
          : [],
        caption: card.querySelector('.pd-media-meta')?.textContent ?? null,
      };
    }),
  );

/** Wait until every 3D card on screen has framed its file. */
const framed = (n) =>
  page.waitForFunction(
    (n) => {
      const hosts = [
        ...document.querySelectorAll(
          '[data-testid="media-card"][data-kind="model"] .pd-media-model-host',
        ),
      ];
      return hosts.length === n && hosts.every((h) => h.dataset.pdFraming !== undefined);
    },
    n,
    { timeout: 90_000, polling: 500 },
  );

/**
 * The card's viewport as pixels, from a full-page screenshot (a WebGL canvas
 * drawn into a 2D copy comes back empty — the drawing buffer is not
 * preserved). Mean colour, and the pixels that are not the frame's ground.
 */
const canvasTone = async (index) => {
  const box = await page.evaluate((index) => {
    const host = document.querySelectorAll(
      '[data-testid="media-card"][data-kind="model"] .pd-media-model-host',
    )[index];
    const r = host?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth } : null;
  }, index);
  if (box === null) return null;
  const png = decodePng(await page.screenshot());
  const scale = png.width / box.vw;
  const x0 = Math.round((box.x + 4) * scale);
  const y0 = Math.round((box.y + 4) * scale);
  const w = Math.round((box.w - 8) * scale);
  const h = Math.round((box.h - 8) * scale);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const pixels = [];
  for (let yy = 0; yy < h; yy += 2) {
    for (let xx = 0; xx < w; xx += 2) {
      const i = ((y0 + yy) * png.width + (x0 + xx)) * png.channels;
      const pr = png.data[i];
      const pg = png.data[i + 1];
      const pb = png.data[i + 2];
      pixels.push(pr, pg, pb);
      r += pr;
      g += pg;
      b += pb;
      n += 1;
    }
  }
  return n === 0
    ? null
    : { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), n, pixels };
};
/** How many sampled pixels differ between two reads of the same viewport. */
const changed = (a, b) => {
  if (!a || !b || a.pixels.length !== b.pixels.length) return -1;
  let n = 0;
  for (let i = 0; i < a.pixels.length; i += 3) {
    const d =
      Math.abs(a.pixels[i] - b.pixels[i]) +
      Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
      Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
    if (d > 40) n += 1;
  }
  return n;
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1200);
  await setTheme('dark');

  /* ── 1. The waiting card for a running generate_3d ── */
  await set({
    session: { cwd: '/w' },
    agent: { isStreaming: true },
    messages: [
      user('u1', 'make me a low-poly fox', 1),
      {
        kind: 'assistant',
        id: 'a-g1',
        blocks: [
          {
            type: 'toolCall',
            id: 'g1',
            name: 'generate_3d',
            arguments: { prompt: 'a low-poly fox' },
          },
        ],
        timestamp: 2,
        isStreaming: true,
      },
    ],
    runningToolCalls: ['g1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });
  await sleep(600);
  const pending = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="pending-media-card"]');
    const frame = card?.querySelector('.pd-media-frame');
    const fb = frame?.getBoundingClientRect();
    const cs = frame ? getComputedStyle(frame) : null;
    return {
      kind: card?.getAttribute('data-kind'),
      w: fb ? Math.round(fb.width) : null,
      h: fb ? Math.round(fb.height) : null,
      cssW: cs?.width,
      boxSizing: cs?.boxSizing,
      figureW: card ? Math.round(card.getBoundingClientRect().width) : null,
      parentW: card?.parentElement
        ? Math.round(card.parentElement.getBoundingClientRect().width)
        : null,
      row: document.querySelector('.pd-chain-step .pd-chain-step-label')?.textContent ?? null,
    };
  });
  console.log('pending', JSON.stringify(pending));
  await clip('1-pending-3d', '[data-testid="pending-media-card"]');
  check(
    pending.kind === 'model' && pending.h >= 240 && pending.h <= 244,
    `a running generate_3d gets the model waiting card (${JSON.stringify(pending)})`,
  );
  check(
    pending.row === 'Building a 3D model',
    `the chain row says what is being made (${pending.row})`,
  );

  /* ── 2. Three results: a model, a rig, a segmentation ── */
  await set({
    agent: { isStreaming: false },
    runningToolCalls: [],
    messages: [
      user('u1', 'make me a low-poly fox', 1),
      call('g1', 'generate_3d', { prompt: 'a low-poly fox' }, 2),
      result('g1', 'generate_3d', resultText('Generated 3D model saved at', FILES.model), 3),
      user('u2', 'now rig it', 4),
      call('g2', 'refine_3d', { model_path: 'out/model.glb', op: 'rig' }, 5),
      result('g2', 'refine_3d', resultText('Rigged model saved at', FILES.rigged), 6),
      user('u3', 'and split the car into parts', 7),
      call('g3', 'refine_3d', { model_path: 'out/car.glb', op: 'segment' }, 8),
      result(
        'g3',
        'refine_3d',
        resultText('Segmented model (named parts) saved at', FILES.parts),
        9,
      ),
    ],
  });
  /* The first result hands over from the waiting card with the loader's sweep
     — which runs only while the card is on screen (its loop stops when nobody
     is looking). Three tall cards push it above the fold, so look at it. */
  await sleep(1500);
  const pendingCard = page.locator('[data-testid="pending-media-card"]');
  if ((await pendingCard.count()) > 0) await pendingCard.first().scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="pending-media-card"]').length === 0,
    undefined,
    { timeout: 30_000, polling: 300 },
  );
  await framed(3).catch(async (e) => {
    await dump('timeout');
    throw e;
  });
  await sleep(800);
  let cards = await readCards();
  console.log('cards', JSON.stringify(cards, null, 1));
  await shot('2-three-cards-dark');
  check(cards.length === 3, `three 3D cards on screen (${cards.length})`);
  const [model, rig, parts] = cards;
  check(
    model?.framing?.bodies >= 1 && model.framing.skinned === false && model.framing.parts === 0,
    `the textured model loaded as a plain body: ${JSON.stringify(model?.framing)}`,
  );
  check(
    rig?.framing?.skinned === true,
    `the rigged file is seen as rigged: ${JSON.stringify(rig?.framing)}`,
  );
  check(
    parts?.framing?.parts === 3,
    `the segmentation is seen as three parts: ${JSON.stringify(parts?.framing)}`,
  );
  const labels = (c) => c.buttons.map((b) => b.label);
  check(
    JSON.stringify(labels(model)) === JSON.stringify(['Color', 'Normals', 'Grey']),
    `a plain model gets Color / Normals / Grey and nothing else: ${JSON.stringify(labels(model))}`,
  );
  check(
    JSON.stringify(labels(rig)) === JSON.stringify(['Color', 'Normals', 'Grey', 'Skeleton']),
    `a rig adds Skeleton: ${JSON.stringify(labels(rig))}`,
  );
  check(
    JSON.stringify(labels(parts)) === JSON.stringify(['Color', 'Normals', 'Grey', 'Explode']),
    `a segmentation adds Explode: ${JSON.stringify(labels(parts))}`,
  );
  check(
    rig?.skeleton === 'true' && rig.buttons.find((b) => b.label === 'Skeleton')?.on === true,
    `the rig is shown the moment it arrives (skeleton ${rig?.skeleton})`,
  );
  check(
    cards.every(
      (c) =>
        c.frameH >= 240 &&
        c.frameH <= 244 &&
        c.frameW >= 240 &&
        Math.abs(c.frameW - pending.w) <= 4,
    ),
    `the viewport is the little embedded one, the waiting card's size (${pending.w}×${pending.h}): ${cards.map((c) => `${c.frameW}×${c.frameH}`)}`,
  );
  check(
    cards.every((c) => c.stripBelow === true && Math.abs((c.stripW ?? 0) - (c.frameW ?? 0)) <= 6),
    `the strip sits under the viewport, as wide as it: ${cards.map((c) => `${c.stripBelow}/${c.stripW}`)}`,
  );
  check(
    cards.every((c) => c.caption?.startsWith('3D')),
    `the caption says 3D and the size: ${cards.map((c) => c.caption)}`,
  );
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-chain-step .pd-chain-step-label')].map((r) => r.textContent),
  );
  check(
    rows.includes('Built a 3D model') &&
      rows.filter((r) => r === 'Refined a 3D model').length === 2,
    `the chain rows name the work: ${JSON.stringify(rows)}`,
  );
  const summaries = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-chain-summary')].map((r) => r.textContent?.trim() ?? ''),
  );
  check(
    summaries.filter((t) => t.startsWith('Built a 3D model')).length === 1 &&
      summaries.filter((t) => t.startsWith('Refined a 3D model')).length === 2,
    `the collapsed lines say built once and refined twice: ${JSON.stringify(summaries)}`,
  );
  await clip('3-card-model-color', '[data-testid="media-card"][data-kind="model"]');

  /* ── 3. The shadings, read off the pixels ── */
  const colorTone = await canvasTone(0);
  await page.locator('[data-testid="model-shading-normals"]').first().click();
  await sleep(500);
  const normalsTone = await canvasTone(0);
  await clip('4-card-model-normals', '[data-testid="media-card"][data-kind="model"]');
  await page.locator('[data-testid="model-shading-grey"]').first().click();
  await sleep(500);
  const greyTone = await canvasTone(0);
  await clip('5-card-model-grey', '[data-testid="media-card"][data-kind="model"]');
  cards = await readCards();
  const brief = (t) => (t ? { r: t.r, g: t.g, b: t.b, n: t.n } : null);
  console.log(
    'tones',
    JSON.stringify({ color: brief(colorTone), normals: brief(normalsTone), grey: brief(greyTone) }),
  );
  check(cards[0]?.shading === 'grey', `the viewport follows the strip (${cards[0]?.shading})`);
  const dist = (a, b) =>
    a && b ? Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) : -1;
  check(
    dist(colorTone, normalsTone) > 12 && dist(normalsTone, greyTone) > 12,
    `Color, Normals and Grey are three different pictures (Δ ${dist(colorTone, normalsTone)}, ${dist(normalsTone, greyTone)})`,
  );

  /* ── 4. Skeleton off/on, Explode on ── */
  await page.locator('[data-testid="model-skeleton"]').click();
  await sleep(300);
  cards = await readCards();
  check(cards[1]?.skeleton === 'false', `Skeleton toggles off (${cards[1]?.skeleton})`);
  await page.locator('[data-testid="model-skeleton"]').click();
  await sleep(300);
  cards = await readCards();
  check(cards[1]?.skeleton === 'true', `…and on again (${cards[1]?.skeleton})`);
  await page
    .locator('[data-testid="media-card"][data-kind="model"]')
    .nth(1)
    .scrollIntoViewIfNeeded();
  await sleep(300);
  await clip('6-card-rig-skeleton', '[data-testid="media-card"][data-kind="model"] >> nth=1');

  await page
    .locator('[data-testid="media-card"][data-kind="model"]')
    .nth(2)
    .scrollIntoViewIfNeeded();
  await sleep(300);
  const togetherTone = await canvasTone(2);
  await clip('7-card-parts-together', '[data-testid="media-card"][data-kind="model"] >> nth=2');
  await page.locator('[data-testid="model-explode"]').click();
  await sleep(900);
  cards = await readCards();
  const apartTone = await canvasTone(2);
  await clip('8-card-parts-exploded', '[data-testid="media-card"][data-kind="model"] >> nth=2');
  check(cards[2]?.explode === 'true', `Explode is on (${cards[2]?.explode})`);
  const moved = changed(togetherTone, apartTone);
  check(
    moved > (togetherTone?.n ?? 0) * 0.04,
    `the parts moved: ${moved} of ${togetherTone?.n} sampled pixels changed`,
  );

  /* ── 5. Light theme, the whole thread ── */
  await setTheme('light');
  await sleep(600);
  await page
    .locator('[data-testid="media-card"][data-kind="model"]')
    .first()
    .scrollIntoViewIfNeeded();
  await sleep(300);
  await shot('9-three-cards-light');
  const strip = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="model-controls"] .pd-segmented');
    const on = document.querySelector('[data-testid="model-controls"] .pd-segment[data-state]');
    return s && on
      ? {
          track: getComputedStyle(s).backgroundColor,
          pill: getComputedStyle(on).backgroundColor,
          h: Math.round(on.getBoundingClientRect().height),
        }
      : null;
  });
  console.log('strip', JSON.stringify(strip));
  check(
    strip !== null && strip.track !== strip.pill && strip.h <= 26,
    `the strip is the app's segmented control at caption scale: ${JSON.stringify(strip)}`,
  );
} finally {
  await finish();
}
