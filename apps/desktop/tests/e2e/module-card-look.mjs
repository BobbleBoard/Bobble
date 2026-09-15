/**
 * LOOK at the "Download module" card (media/ModuleCard) — the user (2026-09-13):
 * "we need a popup/prominent button that has something like 'download
 * module' for image/audio/3d/video". Real app, headless, the store put into
 * each state through its E2E seam (no multi-gigabyte download behind it):
 *
 *   1. the Image studio on a Mac without the image module — the card above
 *      the composer, with the button;
 *   2. the same card mid-install: uv's line and the bar;
 *   3. the chat: a generation waiting at the gate → the card above the input.
 *
 *   SHOT_DIR=/tmp/module-card node apps/desktop/tests/e2e/module-card-look.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('module-card', {
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = (patch) =>
  page.evaluate((p) => {
    const base = (id, label, blurb, approxGB) => ({
      id,
      label,
      blurb,
      approxGB,
      ready: true,
      installing: false,
      wanted: false,
    });
    const modules = [
      base(
        'image',
        'Image module',
        'The picture engine (mflux on MLX). Models download on first use.',
        2,
      ),
      base(
        'audio',
        'Audio module',
        'Speech and voices (mlx-audio). Voices download on first use.',
        1.5,
      ),
      base(
        'comfy',
        'Video module',
        'ComfyUI — video, music and sound effects. Model packs download on first use.',
        6,
      ),
      base('3d', '3D module', 'The 3D engine. Stages download as you use them.', 3),
    ].map((m) => ({ ...m, ...(p[m.id] ?? {}) }));
    window.__gen_modules_store().setState({ modules, loaded: true });
  }, patch);

try {
  await page.waitForFunction(() => typeof window.__gen_modules_store === 'function', {
    timeout: 20_000,
  });

  // 1. The Image studio, module missing.
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('[data-testid="image-studio"]', { timeout: 15_000 });
  await state({ image: { ready: false } });
  await sleep(300);
  const card = await page.$('[data-testid="module-card-image"]');
  check(card !== null, 'the Image studio shows the image module card when the module is missing');
  const cardText = card === null ? '' : await card.textContent();
  check(/Download image module/.test(cardText ?? ''), `the card has the button (${cardText})`);
  const geometry = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="module-card-image"]');
    const composer = document.querySelector('[data-testid="studio-input"], .pd-studio-composer');
    if (c === null || composer === null) return null;
    return {
      cardBottom: Math.round(c.getBoundingClientRect().bottom),
      composerTop: Math.round(composer.getBoundingClientRect().top),
      width: Math.round(c.getBoundingClientRect().width),
      bg: getComputedStyle(c).backgroundColor,
    };
  });
  console.log('studio card:', JSON.stringify(geometry));
  check(
    geometry !== null && geometry.cardBottom <= geometry.composerTop + 1,
    'the card sits above the composer',
  );
  await shot('01-image-studio-missing');

  // 2. Mid-install: uv's line and the bar.
  await state({
    image: {
      ready: false,
      installing: true,
      detail: 'Downloading torch (215.3MiB)',
      percent: 0.42,
    },
  });
  await sleep(300);
  const installing = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="module-card-image"]');
    return {
      text: c?.textContent ?? '',
      bar: c?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? null,
      button: c?.querySelector('[data-testid="module-install-image"]') !== null,
    };
  });
  check(/Downloading torch/.test(installing.text), 'the install detail is on the card');
  check(installing.bar === '42', `the bar shows the fraction (${installing.bar})`);
  check(!installing.button, 'no second Download button while installing');
  await shot('02-image-studio-installing');

  // 3. The chat: a job is waiting at the gate for the video module.
  await state({ image: { ready: true } });
  await page.click('[data-testid="new-chat"]');
  await page.waitForSelector('.pd-composer-editor', { timeout: 15_000 });
  await state({ comfy: { ready: false, wanted: true } });
  await sleep(300);
  const notice = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="module-notice"]');
    const c = document.querySelector('[data-testid="module-card-comfy"]');
    const composer = document.querySelector('.pd-composer');
    return {
      present: n !== null && c !== null,
      text: c?.textContent ?? '',
      notNow: c?.querySelector('[data-testid="module-dismiss-comfy"]') !== null,
      above:
        c !== null && composer !== null
          ? c.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 1
          : false,
    };
  });
  console.log('chat notice:', JSON.stringify(notice));
  check(notice.present, 'a waiting generation puts the module card in the chat');
  check(/waiting to use it/.test(notice.text), 'the card says the model is waiting on it');
  check(notice.notNow, 'the chat card can be closed (Not now)');
  check(notice.above, 'the chat card sits above the composer');
  await shot('03-chat-wanted');

  // A closed card ends its own wait: the store marks it closed.
  await page.click('[data-testid="module-dismiss-comfy"]').catch(() => undefined);
  await sleep(200);
} finally {
  await finish();
}
