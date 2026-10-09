/**
 * A ROUTE THAT CANNOT LOAD MUST NOT TAKE THE WINDOW WITH IT.
 *
 * The user, on the full-window crash card: "rendering error self explanatory, that
 * simply can't happen anymore, it's totally unacceptable."
 *
 * The React-#185 path was hardened separately. This is the OTHER way to get
 * that card, and it is not exotic at all — it happens every time the app is
 * rebuilt while a window is open. The running window's `index-*.js` names its
 * lazy routes by content hash (`ImageStudio-BwnLp1LD.js`); a rebuild writes a
 * DIFFERENT hash and deletes the old file, so the next `import()` for a studio
 * 404s, rejects, and — with nothing between the lazy component and the app-wide
 * boundary — replaces the entire app with "Bobble hit a rendering error".
 *
 * ## How this reproduces it
 *
 * Not with a mock: it PARKS the real chunk file out of `dist/assets` while the
 * app is running, which is byte-for-byte the situation a rebuild leaves behind,
 * and then routes into the Image studio. Before the fix that is the crash card
 * over everything. After it, it is a panel inside the studio's own frame with
 * the sidebar, the top bar and the chat still there — and putting the chunk
 * back and pressing "Try again" loads the studio for real.
 *
 * ## And the retry that never succeeds
 *
 * The second half uses the `?piE2E=1` seam (`window.__pi_fail_chunk`) to make
 * the import reject every single time, and presses the button until the panel
 * gives up — checking that it STOPS offering a retry rather than looping, and
 * that the rest of the app is untouched throughout.
 *
 * Needs a current renderer build (`npm run build`). Invisible (harness.mjs).
 */
import { existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT, launchApp } from './harness.mjs';

const ASSETS = path.join(APP_ROOT, 'dist', 'assets');
const chunkFile = readdirSync(ASSETS).find((f) => /^ImageStudio-.*\.js$/.test(f));
if (chunkFile === undefined) {
  console.error(`route-chunk FAILED: no ImageStudio-*.js in ${ASSETS} — run \`npm run build\``);
  process.exit(1);
}
const live = path.join(ASSETS, chunkFile);
const parked = `${live}.parked`;

/** Put the build back however this run ends — a probe must not leave dist broken. */
const restore = () => {
  if (existsSync(parked)) renameSync(parked, live);
};
process.on('exit', restore);

const { page, shot, check, finish } = await launchApp('route-chunk');
await page.waitForFunction(() => typeof window.__modality_store === 'function', {
  timeout: 20_000,
});

/** Route straight into a studio — the sidebar click is another probe's job. */
const openStudio = (view) =>
  page.evaluate((v) => window.__modality_store().getState().setView(v), view);

const state = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-testid="route-error"]');
    return {
      // The whole window replaced — the thing that must never happen again.
      appCrashed: document.querySelector('[data-testid="app-crash"]') !== null,
      // The route's own panel, and which route it belongs to.
      route: panel?.getAttribute('data-route') ?? null,
      panelText: panel?.textContent ?? '',
      canRetry: document.querySelector('[data-testid="route-error-retry"]') !== null,
      canReload: document.querySelector('[data-testid="route-error-reload"]') !== null,
      // The app AROUND the failed route: the sidebar's New chat button and the
      // studio's own title in the top bar. Both gone = the app went with it.
      shellAlive: document.querySelector('[data-testid="new-chat"]') !== null,
      studioTitle: document.querySelector('[data-testid="studio-title"]')?.textContent ?? null,
      // The real studio, once it loads: its own prompt field, from the chunk.
      studioLoaded: document.querySelector('[data-testid="studio-prompt"]') !== null,
    };
  });

// ── 1. The real thing: the chunk this window points at is deleted ──────────
renameSync(live, parked);
console.log(`parked ${chunkFile} — the running window still points at it`);

await openStudio('image');
await page.waitForTimeout(2500);
const missing = await state();
console.log('chunk missing:', JSON.stringify(missing));
await shot('01-chunk-missing');
check(!missing.appCrashed, 'a failed route chunk replaced the WHOLE app with the crash card');
check(missing.route === 'Image studio', `no route panel for the failed chunk (${missing.route})`);
check(missing.shellAlive, 'the sidebar went down with the route');
check(
  missing.studioTitle === 'Image Studio',
  `the top bar lost the studio (${missing.studioTitle})`,
);
check(missing.canRetry, 'the route panel offers no way to retry the import');

// ── 2. Put the build back; the retry fetches the new chunk ────────────────
renameSync(parked, live);
console.log(`restored ${chunkFile} — as a finished rebuild would`);
const retry = await page.$('[data-testid="route-error-retry"]');
check(retry !== null, 'no retry button to press');
if (retry !== null) await retry.click();
await page.waitForTimeout(2500);
const recovered = await state();
console.log('after retry:', JSON.stringify(recovered));
await shot('02-after-retry');
check(recovered.route === null, 'the route panel is still up after a retry that should succeed');
check(recovered.studioLoaded, 'the studio did not load on the retry');
check(!recovered.appCrashed, 'the retry crashed the app');

/*
 * ── 3. A retry that keeps failing must stop, not loop ─────────────────────
 *
 * On the VIDEO studio, which this run has not loaded yet — the image one is now
 * resident, and re-entering a loaded route does not re-import (correctly), so
 * there would be nothing for the seam to fail. It also proves the panel is not
 * one route's special case.
 */
await openStudio('chat');
await page.waitForTimeout(400);
await page.evaluate(() => window.__pi_fail_chunk('Video studio', 99));
await openStudio('video');
await page.waitForTimeout(1500);
let seen = await state();
check(seen.route === 'Video studio', `the seam did not reach the boundary (${seen.route})`);
check(!seen.appCrashed, 'the seam took down the whole app');
await shot('03-seam-failed');

const presses = [];
for (let i = 0; i < 6; i += 1) {
  const button = await page.$('[data-testid="route-error-retry"]');
  if (button === null) break;
  await button.click();
  await page.waitForTimeout(900);
  seen = await state();
  presses.push({ press: i + 1, canRetry: seen.canRetry, appCrashed: seen.appCrashed });
  if (seen.appCrashed) break;
}
console.log('retries:', JSON.stringify(presses));
const final = await state();
console.log('gave up at:', JSON.stringify(final));
await shot('04-gave-up');
check(!final.appCrashed, 'a run of failed retries ended in the app-wide crash card');
check(final.route === 'Video studio', 'the route panel disappeared instead of giving up');
check(!final.canRetry, 'the panel still offers "Try again" after every attempt failed — it loops');
check(final.canReload, 'the exhausted panel offers no way out at all');
check(final.shellAlive, 'the app around the route died during the retries');
check(
  presses.length > 0 && presses.length <= 4,
  `retry count is not bounded sensibly (${presses.length} presses accepted)`,
);

/*
 * ── 4. The pieces that are NOT screens ───────────────────────────────────
 *
 * The 3D studio's Send To / Export pair is lazy too, out of the same chunk as
 * the workspace, and it lives in the top bar. A full card there would be a worse
 * failure than the one it is reporting, so that boundary draws a chip instead —
 * and the workspace beside it must still come up.
 */
await openStudio('chat');
await page.waitForTimeout(400);
await page.evaluate(() => window.__pi_fail_chunk('3D controls', 99));
await openStudio('3d');
await page.waitForTimeout(4000);
const inline = await page.evaluate(() => {
  const el = document.querySelector('[data-route="3D controls"]');
  return {
    found: el !== null,
    inline: el?.classList.contains('pd-route-inline') ?? false,
    height: el === null ? 0 : Math.round(el.getBoundingClientRect().height),
    workspace: document.querySelector('[data-testid="tp-viewport"]') !== null,
    appCrashed: document.querySelector('[data-testid="app-crash"]') !== null,
  };
});
console.log('inline variant:', JSON.stringify(inline));
await shot('05-inline-variant');
check(inline.found, 'the lazy top-bar controls have no boundary of their own');
check(inline.inline, 'a top-bar control failure drew the full-size panel');
check(inline.height > 0 && inline.height < 60, `the chip is not chip-sized (${inline.height}px)`);
check(inline.workspace, 'the 3D workspace went down with its two buttons');
check(!inline.appCrashed, 'the top-bar controls took the app with them');

// ── 5. …and the rest of the app still works afterwards ───────────────────
await openStudio('chat');
await page.waitForTimeout(800);
const back = await page.evaluate(() => ({
  composer: document.querySelector('.pd-composer-editor') !== null,
  appCrashed: document.querySelector('[data-testid="app-crash"]') !== null,
}));
console.log('back in chat:', JSON.stringify(back));
await shot('06-back-in-chat');
check(back.composer, 'the chat did not come back after the route failed');
check(!back.appCrashed, 'the app ended on the crash card');

restore();
await finish();
