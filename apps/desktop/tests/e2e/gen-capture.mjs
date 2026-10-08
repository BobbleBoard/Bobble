/**
 * A STUDIO GENERATION, DRIVEN AND FILMED.
 *
 * the user: "must produce content for/from each model from the headed interface …
 * get me a video of full generation for each type from each model … when in the
 * studio, play around with settings and ensure they apply as well."
 *
 * So this is not an assertion probe. It drives the real studio the way a person
 * would — open the room, pick the model, change the settings, type the prompt,
 * press the button — and films the window for the whole run, so the deliverable
 * is the recording plus the file that lands.
 *
 * Frames are JPEG at CSS scale rather than PNG at the backing-store resolution:
 * the screenshot is the whole cost of the capture loop, and at retina PNG the
 * loop runs at ~5fps, which turns a smooth loader into a slideshow.
 *
 *   STUDIO=audio MODE=music MODEL=stable-audio-3-music \
 *   PROMPT="warm lo-fi beat" OUT=/tmp/cap-music node tests/e2e/gen-capture.mjs
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron } from '@playwright/test';

const run = promisify(execFile);

const STUDIO = process.env.STUDIO ?? 'audio'; // image | video | audio
const MODE = process.env.MODE ?? ''; // audio only: music | sfx | speech
const MODEL = process.env.MODEL ?? '';
const PROMPT = process.env.PROMPT ?? 'a test';
const OUT = process.env.OUT ?? `/tmp/cap-${STUDIO}`;
const FPS = Number(process.env.FPS ?? 10);
const DEADLINE = Number(process.env.DEADLINE_MS ?? 1_500_000);
/** Settings to exercise, so "the settings apply" is something observed. */
const STEPS = process.env.STEPS ?? '';
const SEED = process.env.SEED ?? '';

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
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'gen-cap-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    PI_E2E: '1',
    // Never take the user's screen: the window is real and headed, it just never
    // comes to the front (standing rule).
    PI_E2E_BACKGROUND: '1',
    PI_DESKTOP_GEN: '1',
  },
});

const mainLog = [];
for (const st of [app.process().stdout, app.process().stderr]) {
  st?.on('data', (d) => mainLog.push(String(d)));
}

/**
 * Set a studio control, whichever of the two shapes it is.
 *
 * The studios use `StudioPicker` (a Radix dropdown) for some settings and
 * `Segmented` (a radiogroup of buttons) for others, and they need different
 * handling: Segmented paints its sliding thumb as an absolute SIBLING over the
 * buttons, so a positional click lands on the thumb and bubbles to the group
 * with the handler never running.
 */
async function pick(win, testid, labelRe) {
  const trigger = win.locator(`[data-testid="${testid}"]`);
  if ((await trigger.count()) === 0) return null;
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  // Segmented: the control IS the group; click the labelled button inside it.
  const role = await trigger.getAttribute('role').catch(() => null);
  if (role === 'radiogroup') {
    const btn = win.locator(`[data-testid="${testid}"] button`, { hasText: labelRe }).first();
    if ((await btn.count()) === 0) {
      const all = await win.locator(`[data-testid="${testid}"] button`).allTextContents();
      console.log(`  [pick] "${labelRe}" not among: ${JSON.stringify(all)}`);
      return null;
    }
    const text = (await btn.textContent()) ?? '';
    await btn.evaluate((el) => el.click());
    await win.waitForTimeout(400);
    return text.trim();
  }
  await trigger.click({ force: true });
  await win.waitForTimeout(400);
  const item = win.locator('[role="menuitemradio"]', { hasText: labelRe }).first();
  if ((await item.count()) === 0) {
    const all = await win
      .locator('[role="menuitemradio"]')
      .allTextContents()
      .catch(() => []);
    console.log(`  [pick] "${labelRe}" not among: ${JSON.stringify(all)}`);
    await win.keyboard.press('Escape');
    return null;
  }
  const text = (await item.textContent()) ?? '';
  await item.click();
  await win.waitForTimeout(400);
  return text.trim();
}

/**
 * Steps and Seed are NUMBER FIELDS behind the gears, not pickers on the rail.
 *
 * `pick` was being used for them, and `pick` clicks its target and then looks
 * for a `menuitemradio` — so on an `<input type=number>` it found no menu and
 * reported null, which read as "no such setting" rather than "wrong kind of
 * control". Worse, the Advanced knobs live in a DIALOG that is not mounted until
 * the gears are pressed, so the locator matched nothing at all and a run went
 * out filmed as "settings exercised" with the studio on its defaults.
 *
 * This opens the dialog, types, and READS THE VALUE BACK, so the caller can
 * refuse to film when what the studio holds is not what was asked for.
 */
async function setNumber(win, testid, value) {
  const field = () => win.locator(`[data-testid="${testid}"]`);
  if ((await field().count()) === 0) {
    const gears = win.locator('[data-testid="studio-advanced-toggle"]');
    if ((await gears.count()) === 0) return null;
    await gears.click();
    await win.waitForTimeout(500);
  }
  if ((await field().count()) === 0) return null;
  await field().fill(String(value));
  await win.waitForTimeout(250);
  const back = await field().inputValue();
  // Leave the dialog closed so it is not sitting over the film.
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  return back;
}

let frames = 0;
let filming = true;
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
      break; // window gone
    }
    const left = period - (Date.now() - at);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
}

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 40000 });
  await win.waitForTimeout(2500);

  /*
   * FULL POWER, because a capture is exactly when the user wants the machine.
   *
   * The power policy holds HEAVY jobs (video) whenever memory is tight — the user
   * asked for that buffer and it is right. MEASURED here: after reading 73GB of
   * weights the file cache alone put the machine in "gentle", so a Wan run sat
   * in the queue and ComfyUI idled with an empty queue and 133MB resident. This
   * is the product's own knob, not a way round the guard.
   */
  await win.evaluate(() =>
    window.piDesktop.invoke('settings:set', { patch: { powerMode: 'full' } }),
  );
  await win.waitForTimeout(600);

  await win.evaluate((v) => window.__modality_store?.().getState().setView(v), STUDIO);
  await win.waitForTimeout(1500);

  if (MODE !== '') {
    /*
     * The mode is a `Segmented` — a radiogroup of buttons — not a button with
     * its own testid. Clicking `audio-mode-<mode>` silently did nothing, which
     * left the studio in Speech and offered only TTS models; the run then
     * "picked the default" and would have filmed Kokoro while claiming to be
     * music. Click the labelled button inside the group.
     */
    const label = { music: 'Music', sfx: 'Effects', speech: 'Speech' }[MODE] ?? MODE;
    const modeBtn = win
      .locator('[data-testid="audio-mode-rail"] button', { hasText: new RegExp(`^${label}$`) })
      .first();
    await modeBtn.scrollIntoViewIfNeeded().catch(() => {});
    /*
     * Call the button's own click(), not a synthetic mouse click at its centre.
     * `Segmented` paints its sliding thumb as an ABSOLUTE SIBLING over the
     * buttons, so a positional click lands on the thumb and bubbles to the
     * radiogroup — the handler never runs, the rail stays on Speech, and the
     * model list stays TTS. (Read back below; it reported "Speech" while the
     * run believed it had switched to Music.)
     */
    await modeBtn.evaluate((el) => el.click());
    await win.waitForTimeout(900);
    // Read the mode BACK. Saying "mode: Music" because we clicked a thing named
    // Music is the kind of claim that made the last run film Kokoro.
    const actual = await win
      .locator(
        '[data-testid="audio-mode-rail"] [aria-checked="true"], [data-testid="audio-mode-rail"] [data-state="on"]',
      )
      .first()
      .textContent()
      .catch(() => null);
    say(`mode: asked ${label}, rail says ${JSON.stringify(actual)}`);
  }

  const chosen =
    MODEL === '' ? null : await pick(win, `${STUDIO}-model`, new RegExp(MODEL_LABEL(), 'i'));
  say(`model picked: ${chosen ?? '(default)'}`);
  if (MODEL !== '' && chosen === null) {
    throw new Error(
      `could not pick "${MODEL}" in the ${STUDIO} studio — refusing to film a run and claim it ` +
        'came from a model that was never selected',
    );
  }

  /*
   * Settings, so the report can say they were exercised rather than assumed —
   * and so the job is one a capture can sit through. The Video studio defaults
   * to 4s at 24fps (96 frames) at the TRAINED size, which on this Mac is tens of
   * minutes; MEASURED, a 2s 416px clip is ~3 minutes of sampling. SIZE/SECONDS
   * drive the studio's own pickers, so what the film shows is a person choosing
   * a cheaper shot, not a probe bypassing the UI.
   */
  const applied = {};
  if (process.env.SIZE !== undefined) {
    applied.size = await pick(win, `${STUDIO}-size`, new RegExp(process.env.SIZE, 'i'));
  }
  if (process.env.SECONDS !== undefined) {
    applied.seconds = await pick(win, `${STUDIO}-seconds`, new RegExp(`^${process.env.SECONDS}`));
  }
  if (STEPS !== '') applied.steps = await setNumber(win, `${STUDIO}-steps-rail`, STEPS);
  if (SEED !== '') applied.seed = await setNumber(win, `${STUDIO}-seed-rail`, SEED);
  say(`settings: ${JSON.stringify(applied)}`);
  if ((STEPS !== '' && applied.steps !== STEPS) || (SEED !== '' && applied.seed !== SEED)) {
    throw new Error(
      `asked for steps=${STEPS} seed=${SEED} but the studio reads back ` +
        `${JSON.stringify(applied)} — refusing to film a run and call the settings applied`,
    );
  }

  await win.click('[data-testid="studio-prompt"]');
  await win.keyboard.type(PROMPT, { delay: 8 });
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(OUT, '01-before.png') });

  const filmDone = film(win);
  await win.click('[data-testid="studio-run"]');
  say('pressed Run');

  let shotLoader = false;
  let state = {};
  const deadline = Date.now() + DEADLINE;
  while (Date.now() < deadline) {
    state = await win
      .evaluate(() => {
        const job = document.querySelector('[data-testid="studio-job"]');
        return {
          running: job !== null,
          act: document.querySelector('[data-testid="bobble-loader"]')?.dataset?.variant ?? null,
          pct: document.querySelector('[data-testid="bobble-pct"]')?.textContent ?? null,
          meta: document.querySelector('[data-testid="studio-job-meta"]')?.textContent ?? null,
          results: document.querySelectorAll(
            '[data-testid="thread-audio"], .pd-studio-result, [data-testid="studio-result"]',
          ).length,
          players: document.querySelectorAll('audio, video').length,
          imgs: document.querySelectorAll('.pd-studio-results img').length,
          err: document.querySelector('[data-testid="studio-error"]')?.textContent ?? null,
        };
      })
      .catch(() => ({ gone: true }));
    if (state.gone) break;
    if (!shotLoader && state.running) {
      await win.waitForTimeout(1200);
      await win.screenshot({ path: path.join(OUT, '02-loader.png') });
      shotLoader = true;
      say(`loader up (variant=${state.act}) ${state.meta ?? ''}`);
    }
    if (!state.running && (state.results > 0 || state.players > 0 || state.imgs > 0 || state.err))
      break;
    await win.waitForTimeout(2500);
  }
  say(`RESULT ${JSON.stringify(state)}`);
  filming = false;
  await filmDone;
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(OUT, '03-done.png'), fullPage: true });
} finally {
  filming = false;
  await app.close().catch(() => {});
}

// Encode the film. Frames are dropped afterwards: an hour of JPEGs is gigabytes
// and the mp4 is the deliverable (the disk-full lesson from the demo matrix).
const dir = path.join(OUT, 'frames');
if (frames > 2) {
  const mp4 = path.join(OUT, 'generation.mp4');
  await run('ffmpeg', [
    '-y',
    '-framerate',
    String(FPS),
    '-i',
    path.join(dir, 'f%05d.jpg'),
    // The window is 1440x867 at CSS scale and h264 needs even dimensions —
    // without the pad ffmpeg refuses the whole encode ("height not divisible by
    // 2") and the run produces a 0-byte film after doing all of the work.
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

/**
 * The dropdown shows a LABEL, not a catalog id.
 *
 * The first run picked "(default)" silently because the regex was the id — and a
 * silent fallback to whatever model is recommended is the one outcome that would
 * make this whole capture a lie about which model produced the file.
 */
function MODEL_LABEL() {
  const map = {
    'stable-audio-3-music': 'Stable Audio 3 small \\(music',
    'stable-audio-3-sfx': 'Stable Audio 3 small \\(sound',
    'stable-audio-open': 'Stable Audio Open',
    'ace-step': 'ACE-Step',
    'wan2.1-t2v-1.3b': 'Wan2\\.1',
    'ltx-video-2b-distilled': 'LTX-Video',
    'z-image-turbo': 'Z-Image',
    'flux2-klein-4b': 'FLUX\\.2',
    'flux1-schnell': 'FLUX\\.1 schnell',
    'qwen-image-2512': 'Qwen-Image',
  };
  return map[MODEL] ?? MODEL;
}
