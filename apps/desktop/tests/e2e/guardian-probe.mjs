/**
 * THE GUARDIAN, SEEN WORKING — on a machine that stays fine throughout.
 *
 * The user: "needs monitoring for cpu and mem pressure to ensure extremes like this
 * absolutely never happen". Proving the shed path by actually thrashing the Mac
 * would be doing the thing it exists to prevent, so the probe raises the
 * guardian's free-memory lines from the environment (PI_GUARDIAN_SHED_FREE) and
 * watches an ordinary reading cross them: the running job is cancelled with the
 * reason attached, the studio shows it, and the banner says so.
 *
 * Three checks, one launch each:
 *   MODE=calm   the guardian is up, sampling, and a light-enough job runs
 *   MODE=shed   a heavy job in flight is stopped, and the UI explains why
 *   MODE=hold   admission is closed, the job waits, and the card says so
 *
 * Headless and backgrounded like every probe here (PI_E2E_BACKGROUND=1).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const MODE = process.env.MODE ?? 'shed';
const OUT = process.env.OUT ?? `/tmp/guardian-${MODE}`;
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

const env = { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_GEN: '1' };
if (MODE === 'shed') env.PI_GUARDIAN_SHED_FREE = '0.99';
// hold is proved on the NUMBERS, not the seam: a job of known size is admitted
// when it fits, so the reserve is raised until nothing does (see below).

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'guard-udd-'))}`],
  cwd: process.cwd(),
  env,
});
const mainLog = [];
let previousReserve;
app.process().stdout?.on('data', (d) => {
  for (const line of String(d).split('\n'))
    if (/guardian|pi-guardian|SHED/.test(line)) mainLog.push(line);
});
app.process().stderr?.on('data', (d) => {
  for (const line of String(d).split('\n'))
    if (/guardian|pi-guardian|SHED/.test(line)) mainLog.push(line);
});

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 40000,
  });
  await win.waitForTimeout(1500);
  // Audio is the lightest heavy job on this machine (Stable Audio, ~2 GB) —
  // enough to be a real generation, not enough to matter.
  if (MODE === 'hold') {
    /*
     * settings.json is ~/.pi/desktop/settings.json — SHARED with the real app,
     * not under the temp user-data dir. Whatever this changes must be put back,
     * or the probe leaves the user's Bobble holding every job for a 22 GB reserve.
     */
    previousReserve = (await win.evaluate(() => window.piDesktop.invoke('settings:get', undefined)))
      ?.settings?.powerReserveGB;
    await win.evaluate(() =>
      window.piDesktop.invoke('settings:set', { patch: { powerReserveGB: 22 } }),
    );
    say(`reserve: 22 GB — nothing fits (was ${previousReserve ?? 'default'})`);
  }
  await win.evaluate((v) => window.__modality_store?.().getState().setView(v), 'audio');
  await win.waitForTimeout(1500);

  const seen = [];
  await win.exposeFunction('__guardianSeen', (e) => seen.push(e));
  await win.evaluate(() => {
    window.piDesktop.onEvent('gen:guardian', (e) => window.__guardianSeen(e));
  });

  // MUSIC, not the studio's default speech: a 6-second Stable Audio render is
  // a real job in the queue for ~10 s on this Mac, where speech is a sub-second
  // TTS behind a one-off model install that the queue never sees.
  // `audio-mode` is a Radix picker in the bar; the rail's Segmented thumb eats
  // clicks (see gen-capture.mjs), so the dropdown is the reliable one.
  await win.locator('[data-testid="audio-mode"]').click({ force: true });
  await win.waitForTimeout(400);
  const item = win.locator('[role="menuitemradio"]', { hasText: /music/i }).first();
  if ((await item.count()) > 0) {
    say(`mode: ${(await item.textContent())?.trim()}`);
    await item.click();
    await win.waitForTimeout(500);
  } else {
    say(
      `mode: music NOT offered — ${JSON.stringify(await win.locator('[role="menuitemradio"]').allTextContents())}`,
    );
    await win.keyboard.press('Escape');
  }
  await win.click('[data-testid="studio-prompt"]');
  await win.keyboard.type('a short warm synth chord', { delay: 5 });
  await win.click('[data-testid="studio-run"]');
  say('pressed Generate');

  const deadline = Date.now() + 240_000;
  let state = {};
  while (Date.now() < deadline) {
    await win.waitForTimeout(1000);
    state = await win.evaluate(() => ({
      pending: document.querySelector('[data-testid="pending-media-card"]') !== null,
      note: document.querySelector('[data-testid="pending-pct"]')?.textContent ?? null,
      banner: document.querySelector('[data-testid="guardian-banner"]')?.textContent ?? null,
      error: document.querySelector('[data-testid="studio-error"]')?.textContent ?? null,
      done: document.querySelectorAll('[data-testid="media-card"]').length,
      stop: document.querySelector('[data-testid="studio-run"]')?.textContent ?? null,
    }));
    // The startup reading trips the seam before there is a job — wait for the
    // one that stops the job: the studio's own error line carries the reason.
    if (MODE === 'shed' && state.error !== null) break;
    if (MODE === 'hold' && state.note !== null && /Waiting/.test(state.note)) {
      await win.waitForTimeout(3000); // let the line settle before the picture
      break;
    }
    if (MODE === 'calm' && state.done > 0) break;
  }
  await win.screenshot({ path: path.join(OUT, `${MODE}.png`) });
  say(`STATE ${JSON.stringify(state)}`);
  say(`EVENTS ${JSON.stringify(seen.slice(-4))}`);
  console.log(mainLog.slice(-8).join('\n'));
} finally {
  if (MODE === 'hold') {
    try {
      const win = await app.firstWindow();
      await win.evaluate(
        (prev) =>
          window.piDesktop.invoke('settings:set', {
            // 0 normalises to "derive from the machine" — the same as absent.
            patch: { powerReserveGB: prev === undefined ? 0 : prev },
          }),
        previousReserve,
      );
      say(`reserve restored (${previousReserve ?? 'default'})`);
    } catch {
      /* the app is already gone; the note above says what to check */
    }
  }
  await app.close().catch(() => {});
}
