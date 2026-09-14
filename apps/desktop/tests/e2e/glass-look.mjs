/**
 * LOOK at the surfaces the user called translucent (2026-09-13): the ⓘ tooltip in
 * Advanced ("no translucency here"), the canvas file picker ("notably in the
 * file picker in the canvas"), and a sweep for any other floating surface that
 * lets what is under it be read through. Real app, headless, throwaway HOME.
 *
 *   SHOT_DIR=/tmp/glass node apps/desktop/tests/e2e/glass-look.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'glass');
mkdirSync(SHOT_DIR, { recursive: true });
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const home = probeHome('glass-look');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: 'qwen3.5-4b-mtp' },
  }),
);
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'glass-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'bobble'),
    PI_DESKTOP_MODELS_DIR: path.join(homedir(), 'Bobble', 'Models'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_E2E_NO_SERVER: '1',
  },
});
const shot = async (win, name) =>
  writeFileSync(path.join(SHOT_DIR, `${name}.png`), await win.screenshot());
/** Effective paint of a surface: colour alpha, whether an opaque base sits under it, blur. */
const paint = (win, selector) =>
  win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
    const parts = m ? m[1].split(',').map((s) => Number.parseFloat(s)) : [];
    const alpha = parts.length === 4 ? parts[3] : cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? 0 : 1;
    const r = el.getBoundingClientRect();
    return {
      bg: cs.backgroundColor,
      alpha,
      image: cs.backgroundImage.slice(0, 60),
      blur: cs.backdropFilter,
      box: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  }, selector);
const opaque = (p) => p !== null && (p.alpha >= 0.999 || p.image.startsWith('linear-gradient'));
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 });
  await win.waitForTimeout(1500);

  // 1. The ⓘ tooltip over the Advanced panel.
  await win.click('[data-testid="advanced-params-toggle"]');
  await win.waitForSelector('[data-testid="engine-knob-context"]', { timeout: 15000 });
  await win.waitForTimeout(500);
  await win.hover('[data-testid="engine-knob-info-context"]');
  await win.waitForTimeout(450);
  const tip = await paint(win, '.pd-tooltip');
  console.log('tooltip:', JSON.stringify(tip));
  check(opaque(tip), `the ⓘ tooltip is opaque (${tip?.bg})`);
  await shot(win, '01-info-tooltip');
  if (tip?.box) {
    const b = tip.box;
    writeFileSync(
      path.join(SHOT_DIR, '01-info-tooltip-zoom.png'),
      await win.screenshot({
        clip: {
          x: Math.max(0, b.x - 40),
          y: Math.max(0, b.y - 30),
          width: b.w + 80,
          height: b.h + 60,
        },
      }),
    );
  }
  // Control widths, while the panel is up.
  const widths = await win.evaluate(() => {
    const w = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().width) : null;
    };
    return {
      number: w('[data-testid="engine-knob-input-context"]'),
      select: w('.pd-flag-select'),
      engine: w('[data-testid="engine-settings-engine"]'),
    };
  });
  console.log('widths:', JSON.stringify(widths));
  check(
    widths.number !== null && widths.number <= 110,
    `number inputs are narrow (${widths.number}px)`,
  );
  check(
    widths.select !== null && widths.select <= 140,
    `dropdowns are narrow (${widths.select}px)`,
  );
  await win.mouse.move(5, 5);
  await shot(win, '02-advanced-widths');
  // Radix closes on an outside click: the overlay is the outside.
  await win.mouse.click(8, 8);
  await win
    .waitForSelector('.pd-dialog-overlay', { state: 'detached', timeout: 5000 })
    .catch(async () => {
      await win.keyboard.press('Escape');
      await win.waitForSelector('.pd-dialog-overlay', { state: 'detached', timeout: 5000 });
    });
  await win.waitForTimeout(300);

  // 2. The canvas file picker over a file full of text.
  await win.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 15000 });
  await win.evaluate(() => {
    const c = window.__pi_canvas();
    const lines = [];
    for (let i = 1; i <= 80; i++)
      lines.push(
        `${i}. The quick brown fox jumps over the lazy dog — line ${i} of the document behind the picker.`,
      );
    const tree = [
      {
        name: 'src',
        path: '/tmp/demo/src',
        kind: 'dir',
        children: [
          { name: 'index.ts', path: '/tmp/demo/src/index.ts', kind: 'file' },
          { name: 'app.tsx', path: '/tmp/demo/src/app.tsx', kind: 'file' },
        ],
      },
      { name: 'README.md', path: '/tmp/demo/README.md', kind: 'file' },
      { name: 'notes.md', path: '/tmp/demo/notes.md', kind: 'file' },
      { name: 'package.json', path: '/tmp/demo/package.json', kind: 'file' },
    ];
    const text = lines.join('\n');
    c.openTab({
      kind: 'file',
      title: 'notes.md',
      filePath: '/tmp/demo/notes.md',
      artifact: {
        id: 'file:/tmp/demo/notes.md',
        title: 'notes.md',
        filename: 'notes.md',
        content: { kind: 'code', language: 'markdown', text },
      },
      fileTree: tree,
      fileTreeRootLabel: 'demo',
    });
  });
  await win.waitForSelector('[aria-label="Toggle file tree"]', { timeout: 15000 });
  await win.waitForTimeout(500);
  await win.click('[aria-label="Toggle file tree"]');
  await win.waitForSelector('.pd-canvas-tree-panel', { timeout: 5000 });
  await win.waitForTimeout(400);
  const picker = await paint(win, '.pd-canvas-tree-panel');
  console.log('file picker:', JSON.stringify(picker));
  check(opaque(picker), `the canvas file picker is opaque (${picker?.bg} / ${picker?.image})`);
  await shot(win, '03-canvas-file-picker');
  if (picker?.box) {
    const b = picker.box;
    writeFileSync(
      path.join(SHOT_DIR, '03-canvas-file-picker-zoom.png'),
      await win.screenshot({
        clip: {
          x: Math.max(0, b.x - 60),
          y: Math.max(0, b.y - 40),
          width: b.w + 120,
          height: b.h + 80,
        },
      }),
    );
  }

  // 3. Sweep: floating surfaces whose colour has alpha and no opaque base.
  const sweep = await win.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (!['absolute', 'fixed'].includes(cs.position)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 24) continue;
      const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
      const parts = m ? m[1].split(',').map((s) => Number.parseFloat(s)) : [];
      const alpha =
        parts.length === 4 ? parts[3] : cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? 0 : 1;
      const hasText = (el.textContent ?? '').trim().length > 0;
      if (
        alpha > 0 &&
        alpha < 0.999 &&
        !cs.backgroundImage.startsWith('linear-gradient') &&
        cs.backdropFilter === 'none' &&
        hasText
      ) {
        out.push(
          `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} bg=${cs.backgroundColor} ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }
    return out.slice(0, 20);
  });
  console.log(
    'see-through floating surfaces with text:',
    sweep.length === 0 ? 'none' : `\n  ${sweep.join('\n  ')}`,
  );
  console.log('shots in', SHOT_DIR);
} finally {
  await app.close().catch(() => {});
}
console.log(failures.length === 0 ? 'glass-look OK' : `FAILED: ${failures.length}`);
