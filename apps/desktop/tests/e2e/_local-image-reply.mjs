/**
 * A reply that says `![Red Heart](/abs/path/01.svg)` must SHOW the heart, not a
 * broken-image glyph. Injected through the real store (appendAssistantText) so
 * the check is deterministic; the picture is served by pd-file:// from a folder
 * the app owns (~/Bobble/generated).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const DEV = process.env.DEV === '1';
const OUT = process.argv[2] ?? '/tmp/local-image';
mkdirSync(OUT, { recursive: true });
const HOME = mkdtempSync(path.join(tmpdir(), 'local-image-home-'));
const gen = path.join(HOME, 'Bobble', 'generated', 'a-red-heart');
mkdirSync(gen, { recursive: true });
const svgPath = path.join(gen, '01.svg');
writeFileSync(
  svgPath,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#dd3344" d="M100 170 C 40 120, 20 80, 45 55 C 65 35, 95 45, 100 70 C 105 45, 135 35, 155 55 C 180 80, 160 120, 100 170 Z"/></svg>',
);
const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const app = await electron.launch({
  executablePath: DEV ? createRequire(import.meta.url)('electron') : '/Applications/Bobble.app/Contents/MacOS/Bobble',
  args: DEV ? [appRoot, `--user-data-dir=${path.join(HOME, 'udd')}`] : [`--user-data-dir=${path.join(HOME, 'udd')}`],
  env: { ...process.env, HOME, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate((p) => {
    const st = window.__pi_store().getState();
    st.appendUser('Make me an SVG icon of a red heart.');
    st.appendAssistantText(`Here is your heart:\n\n![Red Heart](${p})\n\nSaved to \`${p}\`.`);
  }, svgPath);
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const img = document.querySelector('.pd-prose img.pd-md-image');
    const btn = img?.closest('button');
    return {
      found: img !== null,
      src: img?.getAttribute('src'),
      complete: img?.complete,
      naturalWidth: img?.naturalWidth,
      rendered: img ? img.getBoundingClientRect().width : 0,
      inButton: btn !== null,
    };
  });
  console.log(JSON.stringify(info));
  const codeStyle = await page.evaluate(() => {
    const code = [...document.querySelectorAll('.pd-prose code')].pop();
    if (!code) return null;
    const cs = getComputedStyle(code);
    const p = code.parentElement;
    const pcs = p ? getComputedStyle(p) : null;
    return {
      whiteSpace: cs.whiteSpace, overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak, display: cs.display,
      codeWidth: code.getBoundingClientRect().width, parentWidth: p?.getBoundingClientRect().width,
      parentWhiteSpace: pcs?.whiteSpace, parentTag: p?.tagName, parentClass: p?.className,
      proseWidth: code.closest('.pd-prose')?.getBoundingClientRect().width,
    };
  });
  console.log('code:', JSON.stringify(codeStyle));
  await page.screenshot({ path: path.join(OUT, 'reply.png') });
  // Click opens it on the canvas.
  await page.locator('.pd-md-image-open').first().click();
  await page.waitForTimeout(1500);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[role="tab"], .pd-canvas-tab')].map((t) => t.textContent?.trim()).filter(Boolean));
  console.log('canvas tabs:', JSON.stringify(tabs));
  await page.screenshot({ path: path.join(OUT, 'opened.png') });
} finally {
  await app.close().catch(() => {});
}
