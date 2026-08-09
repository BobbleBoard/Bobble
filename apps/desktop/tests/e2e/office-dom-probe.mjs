/**
 * What is ACTUALLY in the office guest page, and how wide is each layer?
 *
 * The fit probe showed a 458px canvas inside a 440px viewport with a 900px
 * block somewhere — three numbers that cannot all be right, which means the
 * layout is not what I assumed. This walks the real parent chain of the grid
 * canvas and prints every box, so the next fix is aimed at a measured element
 * rather than a guessed one.
 *
 *   node tests/e2e/office-dom-probe.mjs <file> <kind>
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const file = path.resolve(process.argv[2]);
const KIND = process.argv[3] ?? 'sheets';

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-dom-'))}`],
  env: {
    ...process.env,
    PI_BIN: path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs'),
    MOCK_PI_FIXTURE: path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json'),
    PI_E2E: '1',
    PI_E2E_NO_SERVER: '1',
  },
});

async function dump(label) {
  const out = await app.evaluate(async ({ webContents }) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => /sheet|doc|slide|office/.test(wc.getURL()));
    if (!guest) return { error: 'no guest' };
    return guest.executeJavaScript(
      `(() => {
        const desc = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            sel: el.tagName.toLowerCase() +
              (el.id ? '#' + el.id : '') +
              (typeof el.className === 'string' && el.className
                ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''),
            w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x),
            cssW: cs.width, minW: cs.minWidth, flex: cs.flex, pos: cs.position,
            overflow: cs.overflow + '/' + cs.overflowX,
            display: cs.display, cols: cs.gridTemplateColumns, basis: cs.flexBasis,
            bg: cs.backgroundColor,
          };
        };
        // The grid canvas and every ancestor up to <html>.
        const canvases = [...document.querySelectorAll('canvas')]
          .sort((a, b) => {
            const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
            return B.width * B.height - A.width * A.height;
          });
        const big = canvases[0] ?? null;
        const chain = [];
        for (let el = big; el; el = el.parentElement) chain.push(desc(el));
        // Anything wider than the viewport is what forces the horizontal overflow.
        const vw = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')]
          .map(desc).filter((d) => d && d.w > vw + 2)
          .sort((a, b) => b.w - a.w).slice(0, 8);
        return {
          viewport: vw,
          canvasCount: canvases.length,
          canvasAttrs: big ? { attrW: big.width, attrH: big.height, styleW: big.style.width } : null,
          chain,
          widerThanViewport: wide,
        };
      })()`,
      true,
    );
  });
  console.log(`\n── ${label} ──\n${JSON.stringify(out, null, 2)}`);
}

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 20000 });
  await page.waitForTimeout(3500);
  const tabId = await page.evaluate(
    ({ filePath }) =>
      window.__pi_canvas().openTab({ kind: 'office', title: filePath.split('/').pop(), filePath }),
    { filePath: file },
  );
  await page.waitForTimeout(1200);
  await page.evaluate(
    ({ tabId, filePath, kind }) =>
      window.piDesktop.invoke('office:create', { tabId, kind, filePath }),
    { tabId, filePath: file, kind: KIND },
  );
  await page.waitForTimeout(7000);
  await dump('at load');

  const handle = page.locator('[data-testid="canvas-rail-handle"]');
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 400, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(2500);
    await dump('after widening the panel');
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close();
}
