/**
 * A VIDEO MODEL'S WEIGHTS, ONE CLICK — the user (2026-09-14): "one click download
 * of any of these modules … video image 3d and audio generation with an m1-m6
 * mac".
 *
 * Real cache (ComfyUI installed) and library, throwaway home, headless. Picks
 * a ComfyUI video model in the studio (MODEL=Wan2.1 by default; LTX-2.5 to
 * exercise the 32 GB one), presses Generate, and watches the modules layer do
 * its work: the model's weights card appears with the catalog's size, the
 * button fetches every file from its ungated repo onto the shelf (the same
 * download Model management runs), the job continues on its own, the guardian
 * admits it, and a clip lands in the results.
 *
 *   SHOT_DIR=/tmp/video-weights node apps/desktop/tests/e2e/video-weights-probe.mjs
 *   MODEL=LTX-2.5 … for the big one (needs RESERVE_GB on a 24 GB Mac — measured
 *   20 GB working set, which is why the catalog says 32).
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'Wan2.1';
const MODEL_ID = MODEL === 'LTX-2.5' ? 'ltx-2.5-distilled' : 'wan2.1-t2v-1.3b';
const { app, page, shot, check, finish, home } = await launchApp('video-weights', {
  realCache: true,
  args: ['--', '--piE2E=1'],
});
const mainLog = path.join(process.env.SHOT_DIR ?? '/tmp', 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout, arg) => {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 500 });
    return true;
  } catch {
    return false;
  }
};
try {
  if (process.env.RESERVE_GB !== undefined) {
    const file = path.join(home, '.pi', 'desktop', 'settings.json');
    const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(
      file,
      `${JSON.stringify({ ...current, powerReserveGB: Number(process.env.RESERVE_GB) }, null, 2)}\n`,
    );
  }
  await page.click('[data-testid="modality-video"]');
  await page.waitForSelector('[data-testid="video-studio"]', { timeout: 15_000 });
  await page.evaluate(() => {
    window.__guard = [];
    window.piDesktop.onEvent('gen:guardian', (g) => window.__guard.push(g));
  });
  await page.click('[data-testid="video-model"]');
  await sleep(300);
  const item = page
    .locator('[role="menuitemradio"]', { hasText: new RegExp(MODEL.replace('.', '\\.')) })
    .first();
  check((await item.count()) > 0, `${MODEL} is offered in the model menu`);
  await item.click();
  await sleep(300);
  const modules = await page.evaluate(async () => {
    const s = window.__gen_modules_store?.().getState();
    await s?.refresh();
    return (window.__gen_modules_store?.().getState().modules ?? []).map((m) => ({
      id: m.id,
      ready: m.ready,
      label: m.label,
    }));
  });
  console.log('modules:', JSON.stringify(modules));
  check(modules.find((m) => m.id === 'comfy')?.ready === true, 'the ComfyUI module is ready');
  await page.fill(
    '[data-testid="studio-prompt"]',
    'A red paper boat drifting across a calm pond at golden hour, gentle ripples',
  );
  await shot('01-ready');
  const t0 = Date.now();
  await page.click('[data-testid="studio-run"]');
  // The weights gate: a card for THIS model's files, sized from the catalog,
  // whose button fetches them and lets the same job continue.
  const cardSel = `[data-testid="module-card-weights:${MODEL_ID}"]`;
  const card = await until((sel) => document.querySelector(sel) !== null, 20_000, cardSel);
  if (card) {
    const text = await page.evaluate(
      (sel) => document.querySelector(sel)?.textContent ?? '',
      cardSel,
    );
    console.log(`weights card: ${text.slice(0, 160)}`);
    check(/GB, once/.test(text), 'the card says what it costs');
    await shot('02-weights-card');
    await page.click(`[data-testid="module-install-weights:${MODEL_ID}"]`);
    let lastDetail = '';
    const gone = await (async () => {
      const deadline = Date.now() + 30 * 60_000;
      while (Date.now() < deadline) {
        await sleep(4000);
        const st = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return {
            present: el !== null,
            detail: el?.querySelector('.pd-module-card-sub')?.textContent ?? '',
          };
        }, cardSel);
        if (st.detail !== lastDetail && st.detail !== '') {
          console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${st.detail.slice(0, 120)}`);
          lastDetail = st.detail;
        }
        if (!st.present) return true;
      }
      return false;
    })();
    check(gone, `the weights landed and the card left (${Math.round((Date.now() - t0) / 1000)}s)`);
  } else {
    console.log('no weights card: the files were already on the shelf');
  }
  let guardSeen = 0;
  let clip = false;
  const deadline = Date.now() + 15 * 60_000;
  let lastNote = '';
  while (Date.now() < deadline) {
    await sleep(3000);
    const guard = await page.evaluate(() => window.__guard ?? []);
    for (const g of guard.slice(guardSeen)) console.log(`  guardian: ${g.verdict} — ${g.reason}`);
    guardSeen = guard.length;
    const state = await page.evaluate(() => ({
      clip: document.querySelector('[data-testid="studio-results"] video') !== null,
      note:
        document.querySelector('[data-testid="pending-phase"]')?.textContent ??
        document.querySelector('[data-testid="studio-error"]')?.textContent ??
        '',
      err:
        document.querySelector('.pd-studio-error, [data-testid="studio-error"]')?.textContent ?? '',
    }));
    if (state.note !== lastNote && state.note !== '') {
      console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${state.note}`);
      lastNote = state.note;
    }
    if (state.err !== '' && /stopped|failed|error/i.test(state.err)) {
      console.log(`  error: ${state.err}`);
      break;
    }
    if (state.clip) {
      clip = true;
      break;
    }
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  check(clip, `a clip landed in the results (${elapsed}s)`);
  await sleep(1500);
  const src = await page.evaluate(
    () => document.querySelector('[data-testid="studio-results"] video')?.getAttribute('src') ?? '',
  );
  const file = decodeURIComponent(src.replace(/^pd-file:\/\/f/, ''));
  console.log('clip:', file);
  if (existsSync(file)) {
    console.log(`clip size: ${(statSync(file).size / 1e6).toFixed(2)} MB`);
    // The home goes at finish(); the clip is the evidence, so it comes out.
    copyFileSync(file, path.join(process.env.SHOT_DIR ?? '/tmp', 'clip.mp4'));
  }
  await shot('02-clip');
  console.log(`TOTAL ${elapsed}s through the studio`);
} finally {
  await finish();
}
