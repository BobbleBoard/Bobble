/**
 * Does the office editor actually FILL its view?
 *
 * the user, from a screenshot of the running app: "blank space on the right when I
 * assume you resized, and theming has a big seam from that canvas to the rest
 * of the app". Both are claims about geometry and colour that a screenshot can
 * only suggest, so this measures them instead: the view's bounds from the main
 * process, the guest page's viewport, and the width of whatever the editor
 * actually painted — before AND after a resize.
 *
 *   node tests/e2e/office-fit-probe.mjs <file> <kind> [outDir]
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
const file = path.resolve(process.argv[2]);
const KIND = process.argv[3] ?? 'sheets';
const outDir = path.resolve(process.argv[4] ?? '/tmp/office-fit');
mkdirSync(outDir, { recursive: true });

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-fit-'))}`],
  env: {
    ...process.env,
    PI_BIN: path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs'),
    MOCK_PI_FIXTURE: path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json'),
    PI_E2E: '1',
    PI_E2E_NO_SERVER: '1',
  },
});

/**
 * Read geometry from inside the office guest page. Reached from the MAIN
 * process by URL rather than through an IPC channel, so the probe needs no
 * production code to exist for its own benefit.
 */
async function measure(label) {
  const out = await app.evaluate(async ({ webContents }) => {
    const all = webContents.getAllWebContents();
    const guest = all.find((wc) => {
      const u = wc.getURL();
      return u.includes('sheet') || u.includes('doc') || u.includes('slide') || u.includes('office');
    });
    if (!guest) return { error: 'no office webContents', urls: all.map((w) => w.getURL()) };
    const js = `(() => {
      const de = document.documentElement;
      const body = document.body;
      const bg = (el) => el ? getComputedStyle(el).backgroundColor : null;
      // The widest thing the editor actually painted. Canvas for Univer's grid,
      // otherwise the largest positioned block.
      const canvases = [...document.querySelectorAll('canvas')]
        .map((c) => ({ w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height }))
        .sort((a, b) => b.w * b.h - a.w * a.h);
      let widest = 0, widestSel = '';
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.height > 100 && r.width > widest) {
          widest = r.width;
          widestSel = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : '');
        }
      }
      return {
        viewport: { w: de.clientWidth, h: de.clientHeight },
        innerW: window.innerWidth, innerH: window.innerHeight,
        htmlBg: bg(de), bodyBg: bg(body),
        biggestCanvas: canvases[0] ?? null,
        widestBlock: { w: Math.round(widest), sel: widestSel },
        dark: de.getAttribute('data-pd-dark'),
      };
    })()`;
    const page = await guest.executeJavaScript(js, true);
    const [bw, bh] = [guest.getOwnerBrowserWindow()?.getContentSize?.() ?? []].flat();
    return { page, window: { w: bw, h: bh } };
  });
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(out, null, 2));
  return out;
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

  // What the renderer thinks the slot is, and what the main process was told.
  const slot = await page.evaluate(() => {
    const el = document.querySelector('[data-canvas-slot], [data-testid="canvas-content"]');
    const r = el?.getBoundingClientRect();
    const panel = document.querySelector('[data-testid="canvas-panel"]');
    const pr = panel?.getBoundingClientRect();
    return {
      slot: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      panel: pr ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null,
      dpr: window.devicePixelRatio,
      win: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  console.log('\n── renderer slot ──');
  console.log(JSON.stringify(slot, null, 2));

  await measure('before resize');

  // Widen the whole window: the case the user hit.
  const [w0, h0] = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentSize(),
  );
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h),
    { w: Math.min(w0 + 460, 2400), h: h0 },
  );
  await page.waitForTimeout(2500);
  await measure('after widening window');

  // And drag the canvas divider, which resizes the slot without touching the window.
  const handle = page.locator('[data-testid="canvas-rail-handle"]');
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 380, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(2200);
    await measure('after widening the canvas panel');
  }

  const shot = await page.evaluate(
    ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
    { tabId },
  );
  if (typeof shot?.dataUrl === 'string' && shot.dataUrl.startsWith('data:image/png;base64,')) {
    writeFileSync(
      path.join(outDir, 'fit.png'),
      Buffer.from(shot.dataUrl.slice('data:image/png;base64,'.length), 'base64'),
    );
    console.log(`\nview capture -> ${path.join(outDir, 'fit.png')}`);
  }
  // The seam is between the view and the app, so capture the WHOLE window too.
  await page.screenshot({ path: path.join(outDir, 'window.png') });
  console.log(`window capture -> ${path.join(outDir, 'window.png')}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close();
}
