/**
 * terminal-look-probe.mjs — the user's terminal complaints, measured not guessed.
 *
 * "the terminal styling there's that akward border and the cursor should be a
 * single blinking | instead of the thick terminal like thing. should be blue in
 * this style but claude orange codex probably still blue" — plus, earlier,
 * "would be appreciated if you can show in the terminal something like the user
 * being 'bobble' and the directory".
 *
 * Opens a real terminal tab in the built app and dumps the computed background /
 * border / radius of every element from the xterm screen up to the tab body, so
 * the element actually drawing the frame is identified rather than inferred.
 * (Inferring is what cost three attempts on the dropdown.)
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
const OUT = process.env.OUT ?? path.join(appRoot, '.corp-runs', 'terminal-look');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const udd = mkdtempSync(path.join(tmpdir(), 'pd-term-'));

const app = await electron.launch({
  args: [appRoot, `--user-data-dir=${udd}`],
  executablePath: electronBinary,
  env: { ...process.env, PI_E2E: '1', PI_E2E_NO_SERVER: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3500);

// Open the canvas, then a terminal tab via the new-tab + menu.
const openCanvas = win.locator('[aria-label*="canvas" i], [title*="canvas" i]').first();
if ((await openCanvas.count()) > 0) await openCanvas.click().catch(() => {});
await win.waitForTimeout(800);
/* The EMPTY canvas offers Files/Browser/Terminal/Subagents directly; the `+`
 * only exists once a tab is open. Try the empty-state entry first. */
const emptyTerminal = win.getByText('Terminal', { exact: true }).first();
if ((await emptyTerminal.count()) > 0) {
  await emptyTerminal.click();
} else {
  const plus = win.locator('.pd-canvas-newtab').first();
  if ((await plus.count()) > 0) {
    await plus.click();
    await win.waitForTimeout(500);
    await win.screenshot({ path: path.join(OUT, '01-newtab-menu.png') });
    const termRow = win.locator('[role="menuitem"]', { hasText: /terminal/i }).first();
    if ((await termRow.count()) > 0) await termRow.click();
  }
}
await win.waitForTimeout(4000);
await win.screenshot({ path: path.join(OUT, '02-terminal.png') });

/*
 * BOTH CURSOR STATES. the user, after I reported the caret fixed having looked only
 * at the focused pane: "there's a bordered non filled blue rectangel you can see
 * as the cursor that still remains when we click off, even though the flickering
 * | is correct when we click onto it." xterm's default `cursorInactiveStyle` is
 * 'outline' — a hollow block — and a canvas-rendered cursor has no DOM element to
 * inspect, so the only way to know is to look at both.
 */
const term = win.locator('.xterm-screen').first();
if ((await term.count()) > 0) {
  await term.click();
  await win.waitForTimeout(900);
  await win.screenshot({ path: path.join(OUT, '03-cursor-FOCUSED.png'), clip: await (async () => {
    const b = await term.boundingBox();
    return { x: b.x, y: b.y, width: Math.min(320, b.width), height: 60 };
  })() });
  const focusOwner = () =>
    win.evaluate(() => {
      const a = document.activeElement;
      return a === null ? 'none' : `${a.tagName.toLowerCase()}.${(a.className || '').toString().split(' ')[0]}`;
    });
  console.log('FOCUS while clicked into terminal:', await focusOwner());
  // Click away — the composer — so the terminal blurs.
  const composer = win.locator('[contenteditable="true"]').first();
  if ((await composer.count()) > 0) await composer.click();
  await win.waitForTimeout(900);
  /* PROVE the blur happened. A click that silently missed would leave the pane
   * focused and I would read the focused caret as the unfocused one — the same
   * "passed for the wrong reason" trap that has already bitten twice today. */
  const after = await focusOwner();
  console.log('FOCUS after clicking away:', after);
  console.log(
    after.includes('xterm') ? 'BLUR FAILED — screenshot below is still the FOCUSED state' : 'blur confirmed',
  );
  await win.screenshot({ path: path.join(OUT, '04-cursor-BLURRED.png'), clip: await (async () => {
    const b = await term.boundingBox();
    return { x: b.x, y: b.y, width: Math.min(320, b.width), height: 60 };
  })() });
}

const report = await win.evaluate(() => {
  const pick = (el) => {
    const c = getComputedStyle(el);
    return {
      sel: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).slice(0, 3).join('.')}`,
      background: c.backgroundColor,
      border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
      radius: c.borderRadius,
      padding: c.padding,
      outline: `${c.outlineWidth} ${c.outlineStyle} ${c.outlineColor}`,
      boxShadow: c.boxShadow === 'none' ? 'none' : c.boxShadow.slice(0, 60),
      rect: (() => {
        const r = el.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`;
      })(),
    };
  };
  const chain = [];
  let el = document.querySelector('.xterm-screen') ?? document.querySelector('.xterm');
  if (el === null) return { error: 'no xterm mounted', chain };
  for (let i = 0; i < 8 && el !== null && el !== document.body; i++) {
    chain.push(pick(el));
    el = el.parentElement;
  }
  const term = document.querySelector('.xterm');
  return {
    chain,
    cursorLayerHTML: (document.querySelector('.xterm-cursor-layer')?.outerHTML ?? '').slice(0, 120),
    textareaCaret: term ? getComputedStyle(term).caretColor : null,
    screenText: (document.querySelector('.xterm-rows')?.innerText ?? '').split('\n')[0] ?? '',
  };
});

console.log(JSON.stringify(report, null, 2));
writeFileSync(path.join(OUT, 'styles.json'), JSON.stringify(report, null, 2));
await app.close();
