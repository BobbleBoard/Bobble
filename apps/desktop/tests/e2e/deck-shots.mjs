/**
 * Render every slide of a .pptx to PNG through Bobble's own office canvas.
 *
 * This is the "look" half of render → look → fix. It uses the integration built
 * today: open the deck as an office canvas tab, click each thumbnail in the
 * slide navigator, and capture the native view. No LibreOffice, no cloud.
 *
 *   node tests/e2e/deck-shots.mjs <deck.pptx> <outDir> [slideCount]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const deck = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3] ?? '/tmp/deck-shots');
const count = Number(process.argv[4] ?? 12);
// Which editor to open it in. Was hardcoded to slides, which meant this script
// could only ever look at a deck — useless the moment the office specialists
// started producing docx, xlsx and pdf.
const KIND = process.argv[5] ?? 'slides';

mkdirSync(outDir, { recursive: true });

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-deck-'))}`],
  env: {
    ...process.env,
    PI_BIN: path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs'),
    MOCK_PI_FIXTURE: path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json'),
    PI_E2E: '1',
    PI_E2E_NO_SERVER: '1',
  },
});

function png(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null;
  return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 20000 });
  await page.waitForTimeout(4000);
  // Light theme: a deck is a document being reviewed, not app chrome, and the
  // dark editor chrome would tint every screenshot of it.
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('light'));

  // Widen the canvas as far as the rail allows, so slides are captured big.
  const handle = page.locator('[data-testid="canvas-rail-handle"]');
  const tabId = await page.evaluate(
    // The title has to be PASSED IN: `deck` is a node-side binding and the
    // evaluate body runs in the page, where it does not exist. It was hardcoded
    // to 'deck.pptx', which is why a spreadsheet opened under a .pptx tab label
    // in the user's screenshot.
    ({ filePath, title }) => window.__pi_canvas().openTab({ kind: 'office', title, filePath }),
    { filePath: deck, title: deck.split('/').pop() },
  );
  await page.waitForTimeout(1500);
  await page.evaluate(
    ({ tabId, filePath, kind }) =>
      window.piDesktop.invoke('office:create', { tabId, kind, filePath }),
    { tabId, filePath: deck, kind: KIND },
  );
  await page.waitForTimeout(6000);

  for (let i = 0; i < 3; i++) {
    const box = await handle.boundingBox();
    if (!box) break;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 320, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(2500);

  // Thumbnail rail: each slide's thumb sits at a regular vertical pitch. Click
  // one, wait for the stage to repaint, capture.
  // Measured off a capture, then halved: office:click takes CSS pixels while
  // capturePage returns a 2x retina image, so coordinates read off a screenshot
  // are exactly double what the click wants. Getting this wrong silently clicks
  // past the end of the rail and every later slide captures the same frame.
  const THUMB_X = 54;
  const THUMB_TOP = 67;
  const THUMB_PITCH = 68;
  for (let n = 0; n < count; n++) {
    await page.evaluate(
      ({ tabId, x, y }) => window.piDesktop.invoke('office:click', { tabId, x, y }),
      { tabId, x: THUMB_X, y: THUMB_TOP + n * THUMB_PITCH },
    );
    await page.waitForTimeout(1400);
    const shot = await page.evaluate(
      ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
      { tabId },
    );
    const buf = png(shot?.dataUrl);
    if (buf) {
      writeFileSync(path.join(outDir, `slide-${String(n + 1).padStart(2, '0')}.png`), buf);
      console.log(`slide ${n + 1}: ${buf.length} bytes`);
    } else {
      console.log(`slide ${n + 1}: NO CAPTURE (${shot?.error ?? 'unknown'})`);
    }
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
}
console.log(`shots -> ${outDir}`);
