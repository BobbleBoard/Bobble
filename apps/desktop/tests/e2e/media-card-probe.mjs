/**
 * THE MEDIA CARD — the one the studios and the chat thread both draw.
 *
 * the user: "reasonably large inline cards… clear buttons for example top left
 * fullscreen that isn't exactly fullscreen but large and centered and blurs
 * background like settings panel… all should have an export in the bottom
 * right, these buttons can be appear on hover on the card however still have
 * hover animations", and then, looking at the first build: "no to this thing at
 * the bottom and no to the top bar staying here aswell."
 *
 * Every one of those is a measurement, and none of them is visible to a unit
 * test: whether the controls are actually hidden until hover, whether the
 * expanded view is centred and NOT fullscreen, whether the backdrop really
 * blurs, and whether the app's chrome gets out of the way.
 *
 * The fixture is generated rather than committed — a PNG drawn in the page and
 * written into the app's own output folder, which is where a real generation
 * would put it and inside the `pd-file://` fence that serves it.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const DIR = path.join(homedir(), 'Bobble', 'generated', '_media-card-probe');
mkdirSync(DIR, { recursive: true });

const { page, shot, check, finish } = await launchApp('media-card-probe', {
  env: { PI_DESKTOP_GEN: '1' },
});

// A real PNG, drawn in the page and written where the protocol will serve it.
const png = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 480;
  const g = c.getContext('2d');
  g.fillStyle = '#2b6cb0';
  g.fillRect(0, 0, 640, 480);
  g.fillStyle = '#f6ad55';
  g.beginPath();
  g.arc(320, 240, 120, 0, Math.PI * 2);
  g.fill();
  return c.toDataURL('image/png').split(',')[1];
});
const file = path.join(DIR, 'probe.png');
writeFileSync(file, Buffer.from(png, 'base64'));

const rect = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, sel);

try {
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('[data-testid="image-studio"]');
  await page.waitForTimeout(400);
  await page.evaluate((f) => {
    window
      .__studio_runs()
      .getState()
      .add('image', {
        prompt: 'media card probe',
        at: Date.now(),
        items: [{ path: f, kind: 'image', name: 'probe.png' }],
      });
  }, file);
  await page.waitForSelector('[data-testid="media-card"]');
  await page.waitForTimeout(900);

  // --- the picture actually rendered, at a reasonable size -----------------
  const shown = await page.evaluate(() => {
    const img = document.querySelector('[data-testid="media-image"]');
    return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0 };
  });
  check(shown.w === 640 && shown.h === 480, `the image did not load: ${JSON.stringify(shown)}`);
  const frame = await rect('.pd-media-frame');
  check(frame !== null && frame.h >= 180, `the card is not "reasonably large": ${frame?.h}px tall`);

  // --- the controls are off until you go near them -------------------------
  const opacity = (sel) =>
    page.evaluate((s) => Number(getComputedStyle(document.querySelector(s)).opacity), sel);
  check((await opacity('[data-testid="media-expand"]')) === 0, 'the expand button starts visible');
  check((await opacity('[data-testid="media-export"]')) === 0, 'the export button starts visible');

  await page.locator('[data-testid="media-card"]').first().hover();
  await page.waitForTimeout(400);
  check((await opacity('[data-testid="media-expand"]')) === 1, 'hover did not reveal expand');
  check((await opacity('[data-testid="media-export"]')) === 1, 'hover did not reveal export');

  // Top-LEFT and bottom-RIGHT, as asked.
  const expand = await rect('[data-testid="media-expand"]');
  const exp = await rect('[data-testid="media-export"]');
  check(
    expand.x < frame.x + frame.w / 2 && expand.y < frame.y + frame.h / 2,
    'expand is not in the top-left of the card',
  );
  check(
    exp.x > frame.x + frame.w / 2 && exp.y > frame.y + frame.h / 2,
    'export is not in the bottom-right of the card',
  );
  await shot('hover');

  // --- expanded: large, centred, blurred, and the chrome stands down -------
  await page.locator('[data-testid="media-expand"]').first().click();
  await page.waitForSelector('[data-testid="media-expanded"]');
  await page.waitForTimeout(500);
  const stage = await page.evaluate(() => {
    const s = document.querySelector('.pd-media-stage').getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector('.pd-media-scrim'));
    const hidden = (sel) => {
      const el = document.querySelector(sel);
      return el === null ? true : Number(getComputedStyle(el).opacity) === 0;
    };
    return {
      blur: cs.backdropFilter || cs.webkitBackdropFilter,
      cx: s.x + s.width / 2,
      cy: s.y + s.height / 2,
      w: s.width,
      h: s.height,
      vw: innerWidth,
      vh: innerHeight,
      topBarHidden: hidden('.pd-topbar'),
      composerHidden: hidden('.pd-studio-compose'),
      toggleHidden: hidden('[data-testid="sidebar-toggle-zone"]'),
    };
  });
  check(/blur\(\d/.test(stage.blur), `the backdrop does not blur: ${stage.blur}`);
  check(Math.abs(stage.cx - stage.vw / 2) < 3, 'the expanded view is not horizontally centred');
  check(Math.abs(stage.cy - stage.vh / 2) < 3, 'the expanded view is not vertically centred');
  check(
    stage.w < stage.vw && stage.h < stage.vh,
    'the expanded view is fullscreen — the user asked for large and centred, not fullscreen',
  );
  check(stage.w > stage.vw * 0.35, `the expanded view is too small: ${Math.round(stage.w)}px`);
  check(stage.topBarHidden, 'the top bar is still showing behind the expanded view');
  check(stage.composerHidden, 'the input bar is still showing behind the expanded view');
  check(stage.toggleHidden, 'the sidebar toggle is still showing behind the expanded view');
  await shot('expanded');

  // --- Escape closes the view and NOTHING ELSE -----------------------------
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check(
    (await rect('[data-testid="media-expanded"]')) === null,
    'Escape did not close the expanded view',
  );
  check(
    (await rect('[data-testid="image-studio"]')) !== null,
    'Escape closed the view AND left the studio — the scrim needs role="dialog"',
  );
  check((await opacity('.pd-topbar')) === 1, 'the top bar did not come back');
} finally {
  rmSync(DIR, { recursive: true, force: true });
}

await finish();
