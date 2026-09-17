/**
 * Open office files in the canvas's native editors and capture them — the
 * way to LOOK at a deck, a document, a workbook or a PDF the pipeline wrote,
 * without a screen. One capture per file (a slide/page number where it
 * applies), headless, mock pi.
 *
 *   node apps/desktop/tests/e2e/office-shots.mjs <outDir> <file>[#slide-or-page] …
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(appRoot, '../..');

const outDir = path.resolve(process.argv[2] ?? '/tmp/office-shots');
const targets = process.argv.slice(3).map((arg) => {
  const [file, n] = arg.split('#');
  return { file: path.resolve(file), n: n === undefined ? 1 : Number(n) };
});
mkdirSync(outDir, { recursive: true });

const KIND_FOR_EXT = { pptx: 'slides', docx: 'docs', xlsx: 'sheets', pdf: 'pdf' };
// Thumbnail rail pitch of the slides editor (deck-shots.mjs, measured).
const THUMB = { x: 54, top: 67, pitch: 68 };

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-office-shots-'))}`],
  env: {
    ...process.env,
    HOME: mkdtempSync(path.join(tmpdir(), 'pi-office-shots-home-')),
    PI_BIN: path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs'),
    MOCK_PI_FIXTURE: path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json'),
    PI_E2E: '1',
    PI_E2E_NO_SERVER: '1',
    PI_E2E_BACKGROUND: '1',
  },
});

function png(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null;
  return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.__pi_theme?.()?.setMode?.('light'));
  const handle = page.locator('[data-testid="canvas-rail-handle"]');
  let first = true;
  for (const t of targets) {
    const ext = t.file.split('.').pop() ?? '';
    const kind = KIND_FOR_EXT[ext];
    if (kind === undefined) {
      console.log(`skip ${t.file}: not an office file`);
      continue;
    }
    const title = path.basename(t.file);
    const tabId = await page.evaluate(
      ({ filePath, title }) => window.__pi_canvas().openTab({ kind: 'office', title, filePath }),
      { filePath: t.file, title },
    );
    await page.waitForTimeout(1200);
    await page.evaluate(
      ({ tabId, filePath, kind }) => window.piDesktop.invoke('office:create', { tabId, kind, filePath }),
      { tabId, filePath: t.file, kind },
    );
    await page.waitForTimeout(first ? 7000 : 5000);
    if (first) {
      for (let i = 0; i < 3; i++) {
        const box = await handle.boundingBox();
        if (!box) break;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x - 320, box.y + box.height / 2, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(600);
      }
      await page.waitForTimeout(2000);
      first = false;
    }
    if (kind === 'slides' && t.n > 1) {
      await page.evaluate(
        ({ tabId, x, y }) => window.piDesktop.invoke('office:click', { tabId, x, y }),
        { tabId, x: THUMB.x, y: THUMB.top + (t.n - 1) * THUMB.pitch },
      );
      await page.waitForTimeout(1500);
    }
    if (kind === 'pdf' && t.n > 1) {
      // The viewer's thumbnail rail: page n's thumb is ~193 css px per page
      // down from the first (measured off a capture at 2×).
      await page.evaluate(
        ({ tabId, x, y }) => window.piDesktop.invoke('office:click', { tabId, x, y }),
        { tabId, x: 75, y: 120 + (t.n - 1) * 193 },
      );
      await page.waitForTimeout(1500);
    }
    const shot = await page.evaluate(
      ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
      { tabId },
    );
    const buf = png(shot?.dataUrl);
    const name = `${title.replace(/\.[a-z]+$/, '')}${t.n > 1 ? `-${t.n}` : ''}.png`;
    if (buf) {
      writeFileSync(path.join(outDir, name), buf);
      console.log(`${name}: ${buf.length} bytes`);
    } else {
      console.log(`${name}: NO CAPTURE (${shot?.error ?? 'unknown'})`);
    }
    await page.evaluate((tabId) => window.__pi_canvas().closeTab(tabId), tabId);
    await page.waitForTimeout(600);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
}
console.log(`shots -> ${outDir}`);
