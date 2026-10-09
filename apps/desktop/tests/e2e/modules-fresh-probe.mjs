/**
 * ONE CLICK, FROM NOTHING — the audio and video modules on a Mac that has
 * none of this, then a generation on each.
 *
 * The user (2026-09-14): "give me reasonable confidence that this app can out of
 * the box do all this with a one click download of any of these modules …
 * on an m1-m6 mac." Throwaway home, throwaway APP cache (no module markers,
 * no ComfyUI, no uv env), the real Hugging Face cache for weights (weights
 * are the model library's business, not the module's). For each room:
 *
 *   1. the card is up (the module is missing);
 *   2. Download — the install streams and lands (uv env for audio; the
 *      ComfyUI tarball + venv + requirements for video: no git, no Xcode);
 *   3. a generation: a spoken line on the audio module; a HyperFrames clip on
 *      the video room (the local motion path, no weights).
 *
 * The uv cache is the machine's (uv's own, ~/.cache/uv): the fresh-cache
 * warms are measured separately (scratchpad/fresh); here the point is the
 * app's flow.
 *
 *   SHOT_DIR=/tmp/modules-fresh node apps/desktop/tests/e2e/modules-fresh-probe.mjs
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const ONLY = process.env.ONLY ?? 'audio,video';
const { page, shot, check, finish } = await launchApp('modules-fresh', {
  args: ['--', '--piE2E=1'],
  env: { HF_HOME: path.join(homedir(), '.cache', 'huggingface') },
  timeout: 60_000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout, arg) => {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 250 });
    return true;
  } catch {
    return false;
  }
};
const moduleState = (id) =>
  page.evaluate(
    (mid) =>
      window
        .__gen_modules_store()
        .getState()
        .modules.find((m) => m.id === mid) ?? null,
    id,
  );
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s  ${m}`);

async function installModule(id, label) {
  const card = await until(
    (mid) => document.querySelector(`[data-testid="module-card-${mid}"]`) !== null,
    20_000,
    id,
  );
  check(card, `${label}: the module card is up on a fresh cache`);
  await shot(`${id}-01-card`);
  await page.click(`[data-testid="module-install-${id}"]`);
  const started = Date.now();
  const details = new Set();
  let ready = false;
  while (Date.now() - started < 25 * 60_000) {
    const s = await moduleState(id);
    if (s?.detail) details.add(s.detail);
    if (s?.ready) {
      ready = true;
      break;
    }
    if (s?.error) {
      check(false, `${label}: install failed — ${s.error}`);
      break;
    }
    if (details.size === 2) await shot(`${id}-02-installing`).catch(() => undefined);
    await sleep(1500);
  }
  say(
    `${label}: ready=${ready} in ${((Date.now() - started) / 1000).toFixed(0)}s · ${details.size} detail lines · e.g. ${[...details].slice(0, 4).join(' | ')}`,
  );
  check(ready, `${label}: the module became ready`);
  return ready;
}

try {
  // ── AUDIO ────────────────────────────────────────────────────────────────
  if (ONLY.includes('audio')) {
    await page.click('[data-testid="modality-audio"]');
    await page.waitForSelector('[data-testid="audio-studio"]', { timeout: 15_000 });
    if (await installModule('audio', 'audio')) {
      await page.fill(
        '[data-testid="studio-prompt"]',
        'Hello from Bobble. This voice was made on this Mac.',
      );
      await page.click('[data-testid="studio-run"]');
      const spoken = await until(
        () =>
          document.querySelector(
            '[data-testid="studio-results"] audio, [data-testid="studio-results"] .pd-audio',
          ) !== null,
        10 * 60_000,
      );
      const err = await page.evaluate(
        () => document.querySelector('[data-testid="studio-error"]')?.textContent ?? '',
      );
      check(spoken, `audio: a spoken line was made (${err})`);
      say(`audio: spoken=${spoken} ${err}`);
      await sleep(800);
      await shot('audio-03-result');
    }
  }

  // ── VIDEO ────────────────────────────────────────────────────────────────
  if (ONLY.includes('video')) {
    await page.click('[data-testid="modality-video"]');
    await page.waitForSelector('[data-testid="video-studio"]', { timeout: 15_000 });
    if (await installModule('comfy', 'video (ComfyUI)')) {
      // HyperFrames: the local motion path, no weights — the one video that a
      // fresh Mac can make before any model is downloaded.
      await page.click('[data-testid="video-model"]');
      await sleep(300);
      const hf = page.locator('[role="menuitemradio"]', { hasText: /HyperFrames/i }).first();
      if ((await hf.count()) > 0) await hf.click();
      else await page.keyboard.press('Escape');
      await page.fill(
        '[data-testid="studio-prompt"]',
        // The words in quotes: a HyperFrames title card prints exactly those
        // (VQ-11 lite) and refuses a card with none, rather than printing the
        // instruction as its title.
        'a bold title card "Bobble" that slides in and glows',
      );
      await page.click('[data-testid="studio-run"]');
      const clip = await until(
        () =>
          document.querySelector(
            '[data-testid="studio-results"] video, [data-testid="studio-results"] img',
          ) !== null,
        10 * 60_000,
      );
      const err = await page.evaluate(
        () => document.querySelector('[data-testid="studio-error"]')?.textContent ?? '',
      );
      check(clip, `video: a HyperFrames clip was made (${err})`);
      say(`video: clip=${clip} ${err}`);
      await sleep(800);
      await shot('video-03-result');
    }
  }
} finally {
  await finish();
}
