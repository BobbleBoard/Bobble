/**
 * edge-lines-probe.mjs — find every hairline that runs along a SCROLL EDGE.
 *
 * the user: "always and this goes for all borders generally where it would be
 * applicable, eg. chat scroll and this tab scroll, probably not terminal
 * commands: border must have fade out".
 *
 * I could not find the chat one by reading CSS — the only hairlines in the
 * thread source are the rings around message cards, and fading an enclosing ring
 * would look broken. So: enumerate what is actually PAINTED. Anything ~1px tall
 * and wide, or any horizontal border/inset-shadow on a container that has (or
 * sits against) a scroller, is a candidate — reported with its width, so a rule
 * that spans the pane is distinguishable from a 40px divider inside a card.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(appRoot, '.corp-runs', 'edge-lines');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'pd-edges-'));

const app = await electron.launch({
  args: [appRoot, `--user-data-dir=${udd}`],
  executablePath: electronBinary,
  env: { ...process.env, PI_E2E: '1', PI_E2E_NO_SERVER: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3000);

/* An EMPTY chat has no scroller and therefore no scroll edges — the first run of
 * this probe found zero candidates for exactly that reason. Load a real
 * conversation from the sidebar so the thread actually overflows. */
const chat = win.locator('[data-testid^="chat-row-"]').first();
if ((await chat.count()) > 0) {
  await chat.click().catch(() => {});
  await win.waitForTimeout(3000);
  // Scroll the thread so any edge-of-scroll treatment is actually engaged.
  await win.mouse.move(900, 500);
  await win.mouse.wheel(0, 600);
  await win.waitForTimeout(800);
} else {
  console.log('WARNING: no chat rows found — measuring an empty thread');
}
await win.screenshot({ path: path.join(OUT, '01-app.png') });

const found = await win.evaluate(() => {
  const out = [];
  const seen = new Set();
  const push = (el, why, detail) => {
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height > 80) return; // pane-spanning edges only
    const key = `${el.className}|${why}|${Math.round(r.top)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      why,
      detail,
      sel: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')}`,
      rect: `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`,
      scrolls: el.scrollHeight > el.clientHeight + 2,
    });
  };
  for (const el of document.querySelectorAll('*')) {
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    // A 1px-tall element IS a rule.
    if (r.height > 0 && r.height <= 2 && r.width >= 120) push(el, 'thin-element', `h=${r.height}`);
    // A horizontal border on a wide container.
    for (const side of ['Top', 'Bottom']) {
      const w = c[`border${side}Width`];
      const style = c[`border${side}Style`];
      if (style !== 'none' && Number.parseFloat(w) > 0) {
        push(el, `border-${side.toLowerCase()}`, `${w} ${c[`border${side}Color`]}`);
      }
    }
    // An inset box-shadow used as a seam.
    if (c.boxShadow !== 'none' && c.boxShadow.includes('inset')) {
      push(el, 'inset-shadow', c.boxShadow.slice(0, 54));
    }
  }
  return out;
});

for (const f of found) {
  console.log(
    `${f.why.padEnd(14)} ${f.sel.padEnd(42)} ${f.rect.padEnd(22)} scrolls=${f.scrolls}  ${f.detail}`,
  );
}
console.log(`\n${found.length} pane-width edge candidates`);
writeFileSync(path.join(OUT, 'edges.json'), JSON.stringify(found, null, 2));
await app.close();
