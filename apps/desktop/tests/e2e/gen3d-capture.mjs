/**
 * A 3D GENERATION, DRIVEN AND FILMED — the 3D Studio's own Generate button.
 *
 * Separate from gen-capture.mjs because the 3D room is not a studio in the
 * `StudioShell` sense: it has its own workspace, its own prompt box and its own
 * generate bar, and its wait is the one that plays the loader's 3D act (the grid
 * standing up into rotating solids) before an actual 3D object arrives.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron } from '@playwright/test';

const run = promisify(execFile);
const PROMPT = process.env.PROMPT ?? 'a weathered bronze astrolabe with engraved constellations';
const OUT = process.env.OUT ?? '/tmp/cap-3d';
const FPS = Number(process.env.FPS ?? 6);
const DEADLINE = Number(process.env.DEADLINE_MS ?? 2_400_000);

// maxRetries: a previous run's ffmpeg may still be reading the directory,
// and an ENOTEMPTY here kills the capture before it has started.
rmSync(path.join(OUT, 'frames'), {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 200,
});
mkdirSync(path.join(OUT, 'frames'), { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'cap3d-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_GEN: '1' },
});

let frames = 0;
let filming = false;
async function film(win) {
  const period = 1000 / FPS;
  while (filming) {
    const at = Date.now();
    try {
      await win.screenshot({
        path: path.join(OUT, 'frames', `f${String(frames).padStart(5, '0')}.jpg`),
        type: 'jpeg',
        quality: 72,
        scale: 'css',
      });
      frames += 1;
    } catch {
      break;
    }
    const left = period - (Date.now() - at);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
}

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 40000,
  });
  await win.waitForTimeout(2500);
  await win.evaluate(() =>
    window.piDesktop.invoke('settings:set', { patch: { powerMode: 'full' } }),
  );
  await win.evaluate(() => window.__modality_store?.().getState().setView('3d'));
  await win.waitForTimeout(3000);
  await win.screenshot({ path: path.join(OUT, '00-room.png') });

  /*
   * IMAGE IN, when one is given — the path TRELLIS is actually built for.
   *
   * MEASURED on the text path: the first stage is a text→image pass through
   * mage-flow, and under memory pressure two mflux workers ended up racing,
   * both paging, stuck at 17% for 45 minutes. Handing the room a picture skips
   * that stage entirely and starts at the geometry the model is named for.
   */
  if (process.env.IMAGE !== undefined) {
    await win.evaluate(() => window.__tripo_store?.().getState?.().set?.('inputMode', 'image'));
    await win.waitForTimeout(700);
    await win.setInputFiles('[data-testid="tp-image-input"]', process.env.IMAGE);
    await win.waitForTimeout(2500);
    say(`image in: ${path.basename(process.env.IMAGE)}`);
  } else {
    /*
     * TEXT MODE. The room opens on image input ("Choose or drop image(s)"), and
     * the prompt box only exists in the text tab — so a probe that types straight
     * away waits for an element that is not rendered.
     */
    await win.evaluate(() => window.__tripo_store?.().getState?.().set?.('inputMode', 'text'));
    await win.waitForTimeout(800);
    const box = win.locator('[data-testid="tp-prompt"]');
    if ((await box.count()) === 0) {
      // No store hook exposed — click the text tab in the segmented header.
      await win.locator('.tp-seg button, [data-active]').nth(1).click({ force: true });
      await win.waitForTimeout(800);
    }
    await box.waitFor({ timeout: 20000 });
    await box.click();
    await win.keyboard.type(PROMPT, { delay: 8 });
    await win.waitForTimeout(600);
  }
  await win.screenshot({ path: path.join(OUT, '01-before.png') });

  /*
   * SETTINGS FIRST — and 512 is the point.
   *
   * The room defaults to 1024, which is 8x the voxels of 512, and at 1024 the
   * mesh decode outran the time available on this machine. the user: it has run at
   * 512 before. RES=512 drives the room's own rail, and TEXTURE=off drops the
   * texture pass so the proof is the geometry.
   */
  if (process.env.RES !== undefined) {
    const rail = win
      .locator(`[data-testid="tp-resolution"] button`, {
        hasText: new RegExp(`^${process.env.RES}$`),
      })
      .first();
    if ((await rail.count()) > 0) {
      await rail.evaluate((el) => el.click());
      await win.waitForTimeout(500);
    }
    const chosen = await win
      .locator(
        '[data-testid="tp-resolution"] [aria-checked="true"], [data-testid="tp-resolution"] [data-state="on"]',
      )
      .first()
      .textContent()
      .catch(() => null);
    say(`resolution: asked ${process.env.RES}, rail says ${JSON.stringify(chosen)}`);
  }
  if (process.env.TEXTURE === 'off') {
    const on = await win
      .evaluate(() => window.__tripo_store?.().getState?.().genFinish)
      .catch(() => null);
    if (on === true) {
      await win
        .locator('[data-testid="tp-autotexture-toggle"]')
        .first()
        .evaluate((el) => el.click());
      await win.waitForTimeout(400);
    }
    say(`finish: ${await win.evaluate(() => window.__tripo_store?.().getState?.().genFinish)}`);
  }

  filming = true;
  const filmDone = film(win);

  const btn = win.locator('[data-testid="tp-generate-btn"]');
  const label = await btn.textContent().catch(() => '');
  say(`generate button: ${JSON.stringify((label ?? '').trim())}`);
  await btn.evaluate((el) => el.click());
  say('pressed Generate');

  let shotLoader = false;
  let state = {};
  const deadline = Date.now() + DEADLINE;
  while (Date.now() < deadline) {
    await win.waitForTimeout(3000);
    state = await win
      .evaluate(() => ({
        stage: document.querySelector('[data-testid="tp-genstage"]')?.dataset?.phase ?? null,
        title: document.querySelector('[data-testid="tp-genstage-title"]')?.textContent ?? null,
        msg: document.querySelector('[data-testid="tp-genstage-msg"]')?.textContent ?? null,
        loader: document.querySelector('[data-testid="bobble-loader"]')?.dataset?.variant ?? null,
        canvas: document.querySelectorAll('canvas').length,
      }))
      .catch(() => ({ gone: true }));
    if (state.gone) break;
    if (!shotLoader && state.loader !== null) {
      await win.screenshot({ path: path.join(OUT, '02-loader.png') });
      shotLoader = true;
      say(`3D loader up (variant=${state.loader}) ${state.title ?? ''}`);
    }
    if (state.stage === null && shotLoader) break;
  }
  say(`RESULT ${JSON.stringify(state)}`);
  filming = false;
  await filmDone;
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(OUT, '03-done.png') });
} finally {
  filming = false;
  await app.close().catch(() => {});
}

const dir = path.join(OUT, 'frames');
if (frames > 2) {
  const mp4 = path.join(OUT, 'generation.mp4');
  await run('ffmpeg', [
    '-y',
    '-framerate',
    String(FPS),
    '-i',
    path.join(dir, 'f%05d.jpg'),
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    mp4,
  ]).catch((e) => console.error('ffmpeg failed', e.message));
  if (existsSync(mp4)) {
    say(`film: ${mp4} (${(statSync(mp4).size / 1e6).toFixed(1)} MB, ${frames} frames)`);
    if (process.env.KEEP_FRAMES !== '1') rmSync(dir, { recursive: true, force: true });
  }
}
