/**
 * Render the design language's previews headless, light and dark, so they can
 * be LOOKED at before they are published.
 *
 *   node design/language/tools/render.mjs [Comp ...]   (OUT=<dir>, FRAMES=1 for strips)
 *
 * tokens.css is compiled from tokens.json the way the Design System page
 * compiles it (format.md "tokens.css as compiled"), so a preview sees here what
 * it will see there. Nothing here is published.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'project');
// A local tool's knobs, read once: OUT (where renders go), FRAMES=1 (a strip per loop),
// TIMES (the strip's milliseconds), CHROMIUM (a browser other than the cached shell).
const { OUT: OUT_DIR, FRAMES, TIMES, CHROMIUM, HOME } = process.env;
const OUT = OUT_DIR ?? '/tmp/bobble-language';
mkdirSync(OUT, { recursive: true });

export function compileTokens(tokens) {
  const themes = tokens.color.themes.map((t) => t.id);
  const valueIn = (t, theme) => {
    const v = typeof t.value === 'string' ? t.value : (t.value[theme] ?? t.value[themes[0]]);
    const alias = /^\{(.+)\}$/.exec(v);
    return alias ? `var(--${alias[1]})` : v;
  };
  const block = (theme) => {
    const lines = tokens.color.tokens.map((t) => `  --${t.name}: ${valueIn(t, theme)};`);
    for (const s of tokens.shadow?.tokens ?? []) lines.push(`  --${s.name}: ${valueIn(s, theme)};`);
    return lines.join('\n');
  };
  let css = `/* Bobble — generated from tokens.json */\n`;
  css += `:root, [data-theme="${themes[0]}"] {\n${block(themes[0])}\n}\n`;
  for (const th of themes.slice(1)) css += `[data-theme="${th}"] {\n${block(th)}\n}\n`;
  const flat = [];
  for (const [key, fam] of Object.entries(tokens)) {
    if (['name', 'version', 'meta', 'color', 'type', 'shadow'].includes(key)) continue;
    for (const t of fam.tokens ?? []) flat.push(`  --${t.name}: ${t.value};`);
  }
  for (const [k, stack] of Object.entries(tokens.type.families))
    flat.push(`  --font-${k}: ${stack};`);
  css += `:root {\n${flat.join('\n')}\n}\n`;
  for (const g of tokens.type.groups) {
    for (const s of g.styles) {
      css += `.${s.name} { font-family: var(--font-${s.family ?? g.family}); font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight};${s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : ''}${s.opticalSize ? ` font-variation-settings: 'opsz' ${s.opticalSize};` : ''} }\n`;
    }
  }
  for (const f of tokens.type.fonts) {
    css += `@font-face { font-family: '${f.family}'; src: url('file://${path.join(ROOT, f.file)}') format('woff2'); font-weight: ${f.weight}; font-style: ${f.style ?? 'normal'}; font-display: block; }\n`;
  }
  return css;
}

const tokens = JSON.parse(readFileSync(path.join(ROOT, 'tokens.json'), 'utf8'));
const tokensCss = compileTokens(tokens);
writeFileSync(path.join(OUT, 'tokens.css'), tokensCss);
const bundleCss = readFileSync(path.join(ROOT, 'components', 'bundle.css'), 'utf8');

const only = process.argv.slice(2);
const comps = readdirSync(path.join(ROOT, 'components')).filter(
  (d) =>
    existsSync(path.join(ROOT, 'components', d, 'preview.html')) &&
    (only.length === 0 || only.includes(d)),
);
const launch = () =>
  chromium.launch({
    executablePath:
      CHROMIUM ??
      `${HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  });
let browser = await launch();
for (const comp of comps) {
  try {
    await renderComp(comp);
  } catch (err) {
    // the headless shell's GPU process occasionally drops a frame and closes; once more, fresh
    console.warn('retrying', comp, String(err).split('\n')[0]);
    await browser.close().catch(() => {});
    browser = await launch();
    await renderComp(comp);
  }
}
await browser.close();

async function renderComp(comp) {
  const raw = readFileSync(path.join(ROOT, 'components', comp, 'preview.html'), 'utf8');
  const marker = /<!--\s*@dsCard([^>]*)-->/.exec(raw)?.[1] ?? '';
  const height = Number(/height=(\d+)/.exec(marker)?.[1] ?? 240);
  const width = Number(/width=(\d+)/.exec(marker)?.[1] ?? (comp === 'Cover' ? 960 : 760));
  for (const theme of ['light', 'dark']) {
    const html = raw
      .replace(/<html([^>]*)>/, `<html$1 data-theme="${theme}">`)
      .replace(
        '<head>',
        `<head><base href="file://${path.join(ROOT, 'components', comp)}/"><style>${tokensCss}\n${bundleCss}\nbody{background:var(--ground);color:var(--ink);margin:0}</style>`,
      );
    const file = path.join(OUT, `${comp}-${theme}.html`);
    writeFileSync(file, html);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.goto(`file://${file}`);
    await page.evaluate(() => document.fonts.ready);
    const frames =
      FRAMES === '1' && /@keyframes|animation|requestAnimationFrame|bb-mark--slide/.test(raw);
    if (!frames) {
      // a still is the Reduce Motion frame: what a viewer who asked for no motion sees
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${comp}-${theme}.png`), fullPage: true });
    } else {
      // seek every animation to t rather than sleeping: a screenshot takes long
      // enough that slept frames drift by a second or more within one loop
      await page.waitForTimeout(100);
      for (const t of (TIMES ?? '300,1200,2100,3000,3900,4600').split(',').map(Number)) {
        await page.evaluate((ms) => {
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = ms;
          }
        }, t);
        await page.screenshot({
          path: path.join(OUT, `${comp}-${theme}-t${t}.png`),
          fullPage: true,
        });
      }
    }
    await page.close();
  }
  console.log('rendered', comp);
}
