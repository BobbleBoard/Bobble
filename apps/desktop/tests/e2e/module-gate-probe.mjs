/**
 * THE GATE, END TO END — a real picture, held for the Download button.
 *
 * Real app, throwaway home AND throwaway app cache (so no module marker exists,
 * as on a fresh install), real uv (on PATH here; the app's own pinned copy on a
 * Mac without one) and the real Hugging Face cache for the weights. The Image
 * studio is asked for a picture:
 *
 *   1. the job is HELD — the card appears with the module `wanted`, nothing is
 *      installing, and the run has not failed;
 *   2. Download is pressed — the install streams its lines, writes the marker;
 *   3. the SAME job continues and the picture lands in the results.
 *
 * Needs the weights cached (SKIPs honestly when the Recommended image model is
 * not in the HF cache); the uv environment resolves from uv's own cache.
 *
 *   SHOT_DIR=/tmp/module-gate node apps/desktop/tests/e2e/module-gate-probe.mjs
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const hf = path.join(homedir(), '.cache', 'huggingface', 'hub');
const { page, shot, check, finish } = await launchApp('module-gate', {
  args: ['--', '--piE2E=1'],
  env: {
    // The real HF cache: the model weights are not part of the module.
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shotOnce = false;
const until = async (fn, timeout, arg) => {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 200 });
    return true;
  } catch {
    return false;
  }
};

try {
  if (!existsSync(hf)) {
    console.log('module-gate: no Hugging Face cache on this Mac — SKIP');
  } else {
    await page.click('[data-testid="modality-image"]');
    await page.waitForSelector('[data-testid="image-studio"]', { timeout: 15_000 });
    // Fresh cache → the image module is not ready: the studio card is up before
    // anything is asked.
    const preCard = await until(
      () => document.querySelector('[data-testid="module-card-image"]') !== null,
      15_000,
    );
    check(preCard, 'a fresh install shows the image module card in the studio');
    await shot('01-studio-card-before');

    await page.fill('[data-testid="studio-prompt"]', 'a red apple on a wooden table');
    await page.click('[data-testid="studio-run"]');
    // 1. Held at the gate: wanted, not failed.
    const wanted = await until(
      () =>
        window
          .__gen_modules_store()
          .getState()
          .modules.find((m) => m.id === 'image')?.wanted === true,
      20_000,
    );
    check(wanted, 'the job is held at the gate (module wanted)');
    const failedEarly = await page.$('[data-testid="studio-error"]');
    check(failedEarly === null, 'the run did not fail while waiting');
    await shot('02-held-at-gate');

    // 2. Download.
    await page.click('[data-testid="module-install-image"]');
    const installing = await until(
      () =>
        document
          .querySelector('[data-testid="module-card-image"]')
          ?.getAttribute('data-installing') === 'true',
      10_000,
    );
    check(installing, 'the card shows the install running');
    await sleep(1500);
    await shot('03-installing');
    const ready = await until(
      () =>
        window
          .__gen_modules_store()
          .getState()
          .modules.find((m) => m.id === 'image')?.ready === true,
      10 * 60_000,
    );
    check(ready, 'the image module became ready');
    const cardGone = await until(
      () => document.querySelector('[data-testid="module-card-image"]') === null,
      5_000,
    );
    check(cardGone, 'the card leaves once the module is ready');

    // 3a. While it makes the picture: the card, 25% smaller and rounder, with
    //     the shimmering phase line at the top inside it (the user, 2026-09-14).
    const pendingUp = await until(
      () => document.querySelector('[data-testid="pending-media-card"] .pd-media-frame') !== null,
      60_000,
    );
    check(pendingUp, 'the pending card is up while the picture is made');
    const phases = new Set();
    const t0 = Date.now();
    let frame = null;
    while (Date.now() - t0 < 25_000) {
      const now = await page.evaluate(() => {
        const f = document.querySelector('[data-testid="pending-media-card"] .pd-media-frame');
        const ph = document.querySelector('[data-testid="pending-phase"]');
        if (f === null) return null;
        const r = f.getBoundingClientRect();
        const cs = getComputedStyle(f);
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          radius: cs.borderTopLeftRadius,
          phase: ph?.textContent ?? '',
          shimmer: ph?.querySelector('.pd-shimmer') !== null,
          phaseTop: ph === null ? null : Math.round(ph.getBoundingClientRect().top - r.top),
        };
      });
      if (now === null) break;
      frame = now;
      if (now.phase !== '') phases.add(now.phase);
      if (phases.size === 1 && Date.now() - t0 > 3_000 && !shotOnce) {
        shotOnce = true;
        await shot('03b-pending-phase');
      }
      await sleep(400);
    }
    console.log('pending card:', JSON.stringify(frame), 'phases:', [...phases].join(' → '));
    check(
      frame !== null && frame.w <= 362 && frame.h <= 362,
      `the card is ~25% smaller (${frame?.w}×${frame?.h})`,
    );
    check(frame?.radius === '20px', `the corners are rounder (${frame?.radius})`);
    check(frame?.shimmer === true, 'the phase line shimmers like a thought');
    check(
      frame !== null && frame.phaseTop !== null && frame.phaseTop < 30,
      `the phase line sits at the top inside the card (${frame?.phaseTop}px)`,
    );
    const order = ['Warming up…', 'Creating your image…', 'Drafting…', 'Refining…', 'Finalizing…'];
    const seen = [...phases];
    check(
      seen.length >= 2 &&
        seen.every((p, i) => i === 0 || order.indexOf(p) > order.indexOf(seen[i - 1])),
      `the phases advance in order (${seen.join(' → ')})`,
    );

    // 3. The same job continues to a picture.
    const picture = await until(
      () =>
        document.querySelector(
          '[data-testid="studio-results"] img, [data-testid="studio-results"] .pd-media-card img',
        ) !== null,
      12 * 60_000,
    );
    const err = await page.evaluate(
      () => document.querySelector('[data-testid="studio-error"]')?.textContent ?? '',
    );
    check(picture, `the held job continued to a picture (${err})`);
    // The result card mounts empty and the loader sweeps off it (PendingMediaCard);
    // wait for the sweep to finish so the shot shows the picture, not the reveal.
    await until(
      () => document.querySelector('[data-testid="studio-results"] .pd-bobble-canvas') === null,
      30_000,
    );
    await sleep(800);
    const drawn = await page.evaluate(() => {
      const img = document.querySelector('[data-testid="studio-results"] img');
      return img === null
        ? null
        : {
            w: img.naturalWidth,
            h: img.naturalHeight,
            src: (img.getAttribute('src') ?? '').slice(0, 40),
          };
    });
    console.log('picture:', JSON.stringify(drawn));
    check(drawn !== null && drawn.w > 0, 'the picture has pixels');
    await shot('04-picture');
  }
} finally {
  await finish();
}
