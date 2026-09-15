/**
 * LOOK at the audio card — the user (2026-09-14): "shorten this card vertically so
 * it makes more sense, and then round the pause and play button icons". A real
 * spoken line through the Audio studio (module already on this Mac's uv cache;
 * weights from the real HF cache), then the card measured and photographed.
 *
 *   SHOT_DIR=/tmp/audio-card node apps/desktop/tests/e2e/audio-card-look.mjs
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('audio-card', {
  args: ['--', '--piE2E=1'],
  env: { HF_HOME: path.join(homedir(), '.cache', 'huggingface') },
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
try {
  await page.click('[data-testid="modality-audio"]');
  await page.waitForSelector('[data-testid="audio-studio"]', { timeout: 15_000 });
  // The module card, if the throwaway cache has no marker: press it.
  if (await page.$('[data-testid="module-card-audio"]')) {
    await page.click('[data-testid="module-install-audio"]');
    await until(
      () => document.querySelector('[data-testid="module-card-audio"]') === null,
      600_000,
    );
  }
  await page.fill('[data-testid="studio-prompt"]', 'A short line, to look at the card.');
  await page.click('[data-testid="studio-run"]');
  const spoken = await until(
    () =>
      document.querySelector('[data-testid="studio-results"] [data-testid="thread-audio"]') !==
      null,
    10 * 60_000,
  );
  check(spoken, 'a spoken line was made');
  await sleep(1200);
  const box = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="studio-results"] .pd-media-frame');
    const t = document.querySelector('[data-testid="studio-results"] [data-testid="thread-audio"]');
    const play = document.querySelector('[data-testid="thread-audio-play"]');
    if (card === null || t === null || play === null) return null;
    return {
      frameH: Math.round(card.getBoundingClientRect().height),
      transportH: Math.round(t.getBoundingClientRect().height),
      playH: Math.round(play.getBoundingClientRect().height),
      innerBorder: getComputedStyle(t).borderTopWidth,
      linejoin: play.querySelector('path')?.getAttribute('stroke-linejoin') ?? null,
    };
  });
  console.log('audio card:', JSON.stringify(box));
  check(box !== null && box.frameH <= 56, `the card is a strip (${box?.frameH}px tall)`);
  check(box?.innerBorder === '0px', 'no box inside the box');
  check(box?.linejoin === 'round', 'the play glyph is round-joined');
  await shot('01-audio-card');
  const dir = process.env.SHOT_DIR ?? '/tmp';
  const card = () => page.$('[data-testid="studio-results"] .pd-media-card');
  await (await card())?.screenshot({ path: `${dir}/02-card-only.png` });
  // Hover: the controls arrive BESIDE the strip, and nothing lands on Play.
  await page.hover('[data-testid="studio-results"] .pd-media-frame');
  await sleep(400);
  const hovered = await page.evaluate(() => {
    const play = document.querySelector('[data-testid="thread-audio-play"]');
    const beside = document.querySelector('[data-testid="media-beside"]');
    if (play === null || beside === null) return null;
    const r = play.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const btns = [...beside.querySelectorAll('.pd-media-btn')].map((b) => ({
      op: getComputedStyle(b).opacity,
      right: Math.round(b.getBoundingClientRect().right),
    }));
    const frame = document.querySelector('[data-testid="studio-results"] .pd-media-frame');
    return {
      playHit: play.contains(hit),
      shown: btns.every((b) => b.op === '1'),
      count: btns.length,
      besideStrip:
        Math.round(beside.getBoundingClientRect().left) >=
        Math.round(frame.getBoundingClientRect().right),
    };
  });
  console.log('hovered:', JSON.stringify(hovered));
  check(hovered?.playHit === true, 'Play is what the pointer reaches on hover');
  check(hovered?.shown === true && hovered.count >= 3, 'the controls are shown on hover');
  check(hovered?.besideStrip === true, 'the controls stand beside the strip, not on it');
  await (await card())?.screenshot({ path: `${dir}/03-card-hover.png` });
  await page.click('[data-testid="thread-audio-play"]', { timeout: 5_000 });
  await sleep(500);
  const playing = await page.evaluate(() =>
    document.querySelector('[data-testid="thread-audio-play"]')?.getAttribute('aria-label'),
  );
  check(playing === 'Pause', `Play pressed by mouse (button now says ${playing})`);
  await (await card())?.screenshot({ path: `${dir}/04-card-playing.png` });
  // Light theme, the same strip.
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'));
  await sleep(300);
  await page.hover('[data-testid="studio-results"] .pd-media-frame');
  await sleep(300);
  await (await card())?.screenshot({ path: `${dir}/05-card-light-hover.png` });
} finally {
  await finish();
}
