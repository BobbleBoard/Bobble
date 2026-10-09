/**
 * A PRESENTED WIDGET RUNS IN THE CHAT (html-widget.ts, PresentedInline).
 *
 * The user (2026-09-24): "really clean, intuitive interactive widgets
 * inline/+canvas, eg. for math explanation NN inner working visualizations".
 * A one-file interactive page the model presents arrives the way the present
 * tool delivers it — main's `present:show` event, its payload from the same
 * module main uses — and the probe checks, in the real app, headless:
 *   - it is a live card in the thread (not a file row) and the canvas stays shut;
 *   - its script ran, and a click inside it changes it (the frame is scripted);
 *   - the card fits the page's height;
 *   - "Open in canvas" moves it over;
 *   - a web page (a nav, files beside it) is NOT a widget.
 *
 *   SHOT_DIR=/tmp/widget node scripts/with-lock.mjs probe -- node apps/desktop/tests/e2e/widget-inline-look.mjs
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importTs } from '../../../../tools/visual-eval/lib/env.mjs';
import { APP_ROOT, launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/widget-inline';
mkdirSync(SHOT_DIR, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'pd-widget-'));
const widgetPath = path.join(work, 'gradient-descent.html');
copyFileSync(path.join(APP_ROOT, 'tests/e2e/fixtures/gradient-descent-widget.html'), widgetPath);
const sitePath = path.join(work, 'index.html');
writeFileSync(
  sitePath,
  '<html><body><nav><a href="about.html">About</a></nav><button>Go</button></body></html>',
);
const { htmlWidget } = await importTs('apps/desktop/electron/pi/html-widget.ts');
const html = htmlWidget(readFileSync(widgetPath, 'utf8'));

const { app, page, check, finish } = await launchApp('widget-inline', {
  waitFor: '[data-testid="composer-input"]',
  // The widget's light/dark comes from the app's native theme: no emulation.
  colorScheme: null,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Exactly what main sends when the model presents a file. */
const presentShow = (payload) =>
  app.evaluate(({ BrowserWindow }, p) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      /index\.html|localhost/.test(w.webContents.getURL()),
    );
    win?.webContents.send('pi-desktop:event', { channel: 'present:show', payload: p });
  }, payload);
const canvasOpen = () =>
  page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-panel"]')?.getAttribute('data-open') ??
      String(!!document.querySelector('.pd-canvas-tab')),
  );

try {
  check(
    html !== null && html.title === 'Gradient descent',
    `the fixture is a widget (${html?.title})`,
  );
  check(
    htmlWidget(readFileSync(sitePath, 'utf8')) === null,
    'a page with a nav and a link beside it is not',
  );
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.evaluate(() => {
    window.__pi_store().setState({
      messages: [
        {
          kind: 'user',
          id: 'u1',
          text: 'show me how gradient descent works',
          timestamp: Date.now(),
        },
        {
          kind: 'assistant',
          id: 'a1',
          timestamp: Date.now(),
          isStreaming: false,
          blocks: [
            { type: 'text', text: 'Here it is — drag the learning rate and step.' },
            {
              type: 'toolCall',
              id: 'p1',
              name: 'present',
              arguments: { path: 'gradient-descent.html' },
              argsText: '',
            },
          ],
        },
      ],
    });
  });
  const before = await canvasOpen();
  await presentShow({ path: widgetPath, html });
  await page.waitForSelector('[data-testid="presented-widget"] iframe', { timeout: 15000 });
  await sleep(2500);
  const card = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="presented-widget"]');
    const f = c?.querySelector('iframe');
    return {
      frameH: f ? Math.round(f.getBoundingClientRect().height) : 0,
      fileRow: !!document.querySelector('[data-testid="present-card"]'),
    };
  });
  check(card.frameH > 300 && card.frameH <= 560, `the card fits the page (${card.frameH}px)`);
  check(!card.fileRow, 'no file row stands in for it');
  check((await canvasOpen()) === before, 'the canvas did not open on its own');

  // The page inside: its script drew and answers a click.
  const frame = page
    .frames()
    .find((f) => f !== page.mainFrame() && f.url().startsWith('pd-preview:'));
  check(frame !== undefined, 'the widget runs in the preview frame');
  const read = () => frame.evaluate(() => document.getElementById('state')?.textContent ?? null);
  const first = await read();
  check(first === 'step 0 · x = 1.80', `its script ran (${first})`);
  await page.screenshot({ path: path.join(SHOT_DIR, '1-widget.png') });
  await frame.click('#step');
  await frame.click('#step');
  await sleep(300);
  const after = await read();
  check(after?.startsWith('step 2'), `a click inside it steps it (${after})`);
  await page.screenshot({ path: path.join(SHOT_DIR, '2-after-two-steps.png') });

  // Light and dark, chosen in Bobble's settings: the widget's own
  // prefers-color-scheme follows (Electron's theme source is the setting).
  const setTheme = (mode) =>
    page.evaluate(
      (m) =>
        window
          .__settings_store()
          .getState()
          .update({ theme: { mode: m } }),
      mode,
    );
  const widgetBg = () => frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.waitForFunction(() => typeof window.__settings_store === 'function', {
    timeout: 10000,
  });
  await setTheme('dark');
  await sleep(1200);
  const diag = {
    main: await app.evaluate(({ nativeTheme }) => ({
      source: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors,
    })),
    page: await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
    frame: await frame.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
    iframeScheme: await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('[data-testid="presented-widget"] iframe'))
          .colorScheme,
    ),
    mode: await page.evaluate(() => document.documentElement.getAttribute('data-mode')),
  };
  console.log('theme diag', JSON.stringify(diag));
  const darkBg = await widgetBg();
  check(
    darkBg === 'rgb(28, 28, 30)',
    `a dark Bobble runs the widget in its dark scheme (${darkBg})`,
  );
  await page.screenshot({ path: path.join(SHOT_DIR, '3-dark.png') });
  await setTheme('light');
  await sleep(1200);
  const lightBg = await widgetBg();
  check(lightBg === 'rgb(255, 255, 255)', `a light Bobble runs it light (${lightBg})`);
  await page.screenshot({ path: path.join(SHOT_DIR, '3b-light.png') });

  // Open in canvas.
  await page.click(
    '[data-testid="presented-widget"] [aria-label="Open in canvas"], [data-testid="presented-widget"] [title="Open in canvas"]',
  );
  await sleep(1500);
  await page.screenshot({ path: path.join(SHOT_DIR, '4-in-canvas.png') });
  check(
    !(await page.$('[data-testid="presented-widget"]')),
    'in the canvas, the card steps aside for its tab',
  );
} catch (err) {
  check(false, `threw: ${err?.stack ?? err}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'zz-error.png') }).catch(() => {});
} finally {
  await finish();
}
