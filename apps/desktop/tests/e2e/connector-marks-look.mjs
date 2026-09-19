/**
 * LOOK at the connector marks the user asked to be real (2026-09-18: "don't
 * frankenstein or recreate logos, find a catalog or official svgs"): every
 * mark that is now the brand owner's own file, plus Unity from the catalog,
 * cut out of a device-pixel screenshot of the Connectors gallery in both
 * themes and laid out on one contact sheet at 3×.
 *
 *   OUT=/tmp/marks node apps/desktop/tests/e2e/connector-marks-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { decodePng, encodePng } from './png.mjs';

const OUT = process.env.OUT ?? path.join(tmpdir(), 'marks');
mkdirSync(OUT, { recursive: true });
const IDS = [
  'blender',
  'chrome-devtools',
  'slack',
  'figma',
  'google-drive',
  'gmail',
  'google-calendar',
  'playwright',
  'unity',
  'zoom',
  'github',
  'tableau',
];
const { page, check, finish } = await launchApp('connector-marks', {
  waitFor: '[data-testid="composer-input"]',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setTheme = async (mode) => {
  await page.evaluate(
    (mode) =>
      window
        .__settings_store()
        .getState()
        .update({ theme: { flavor: 'bobble', mode } }),
    mode,
  );
  await page.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
    timeout: 5000,
  });
};

/** Nearest-neighbour blow-up of a CSS-px box out of a device-px PNG. */
function cut(png, box, scale, factor) {
  const x0 = Math.round(box.x * scale);
  const y0 = Math.round(box.y * scale);
  const w = Math.round(box.width * scale);
  const h = Math.round(box.height * scale);
  const out = { width: w * factor, height: h * factor, channels: png.channels };
  out.data = Buffer.alloc(out.width * out.height * png.channels);
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      const sx = Math.min(png.width - 1, x0 + Math.floor(x / factor));
      const sy = Math.min(png.height - 1, y0 + Math.floor(y / factor));
      const from = (sy * png.width + sx) * png.channels;
      const to = (y * out.width + x) * png.channels;
      png.data.copy(out.data, to, from, from + png.channels);
    }
  }
  return out;
}

/** Lay tiles out in a grid on a neutral ground. */
function sheet(tiles, columns, gap) {
  const tw = Math.max(...tiles.map((t) => t.width));
  const th = Math.max(...tiles.map((t) => t.height));
  const rows = Math.ceil(tiles.length / columns);
  const width = columns * tw + (columns + 1) * gap;
  const height = rows * th + (rows + 1) * gap;
  const channels = tiles[0].channels;
  const data = Buffer.alloc(width * height * channels, 0x80);
  if (channels === 4) for (let i = 3; i < data.length; i += 4) data[i] = 255;
  tiles.forEach((t, i) => {
    const cx = gap + (i % columns) * (tw + gap);
    const cy = gap + Math.floor(i / columns) * (th + gap);
    for (let y = 0; y < t.height; y += 1) {
      t.data.copy(
        data,
        ((cy + y) * width + cx) * channels,
        y * t.width * channels,
        (y + 1) * t.width * channels,
      );
    }
  });
  return encodePng({ width, height, channels, data });
}

try {
  await page.click('[data-testid="nav-connectors"]');
  await sleep(1500);
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const tiles = [];
  for (const mode of ['light', 'dark']) {
    await setTheme(mode);
    await page.mouse.move(2, 2);
    await sleep(400);
    for (const id of IDS) {
      const card = page.locator(`[data-testid="connector-card-${id}"]`).first();
      if ((await card.count()) === 0) {
        check(false, `${mode}: a card for ${id} is in the gallery`);
        continue;
      }
      await card.scrollIntoViewIfNeeded();
      await sleep(150);
      const mark = card.locator('.pdc-mark').first();
      const svg = mark.locator('svg').first();
      check((await svg.count()) === 1, `${mode}: ${id} wears an inline svg mark`);
      const box = await mark.boundingBox();
      const shot = decodePng(await page.screenshot());
      tiles.push(cut(shot, box, scale, 3));
    }
  }
  const facts = await page.evaluate(
    (ids) =>
      Object.fromEntries(
        ids.map((id) => {
          const svg = document.querySelector(`[data-testid="connector-card-${id}"] .pdc-mark svg`);
          return [
            id,
            svg
              ? {
                  viewBox: svg.getAttribute('viewBox'),
                  fills: [
                    ...new Set(
                      [...svg.querySelectorAll('[fill],[style]')].map(
                        (e) => e.getAttribute('fill') ?? e.getAttribute('style'),
                      ),
                    ),
                  ].slice(0, 8),
                  ids: [...svg.querySelectorAll('[id]')].map((e) => e.id),
                }
              : null,
          ];
        }),
      ),
    IDS,
  );
  console.log(JSON.stringify(facts, null, 1));
  // Chrome's gradients must resolve: a gradient ref that misses paints nothing
  // (transparent), so the sector that references it would be the tile's ground.
  const chrome = await page.evaluate(() => {
    const svg = document.querySelector(
      '[data-testid="connector-card-chrome-devtools"] .pdc-mark svg',
    );
    const refs = [...svg.querySelectorAll('[style*="url(#"]')].map(
      (e) => e.getAttribute('style').match(/url\(#([^)]+)\)/)[1],
    );
    return refs.map((r) => ({ ref: r, found: svg.querySelector(`#${CSS.escape(r)}`) !== null }));
  });
  check(
    chrome.length === 3 && chrome.every((r) => r.found),
    `chrome's three gradients resolve inside its own mark ${JSON.stringify(chrome)}`,
  );
  writeFileSync(path.join(OUT, 'marks-sheet.png'), sheet(tiles, IDS.length, 12));
  console.log(
    `sheet: ${path.join(OUT, 'marks-sheet.png')} (${IDS.join(', ')} — light row, dark row)`,
  );
} finally {
  await finish();
}
