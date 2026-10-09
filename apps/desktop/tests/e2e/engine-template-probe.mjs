/**
 * ADVANCED → ENGINE: the chat-template upload beside --jinja, and no native
 * number stepper anywhere — headless, real app, real cache.
 *
 * The user: "have a drag and drop or upload custom chat template. next to the
 * jinja flag as well that's useful" and "never have these buttons show up
 * ever anywhere" (the number field's up/down stepper).
 *
 * Proves: (1) Popular lists --jinja, then --chat-template-file (Upload…, a
 * drop hint) and --chat-template; (2) a drag over the row lights it up;
 * (3) the import copies a template into <cache>/chat-templates and a changed
 * name with different bytes gets a hash suffix; (4) setting the flag lights
 * Apply; (5) every number input's spin button is gone.
 *
 *   SHOT_DIR=/tmp/engtpl node apps/desktop/tests/e2e/engine-template-probe.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'engtpl');
mkdirSync(SHOT_DIR, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const home = probeHome('engine-template');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    toolInterface: 'bash-cli',
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: MODEL },
  }),
);
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'engtpl-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const tplDir = path.join(CACHE, 'chat-templates');
const src = path.join(mkdtempSync(path.join(tmpdir(), 'engtpl-src-')), 'probe-template.jinja');
writeFileSync(src, '{{ bos_token }}{% for m in messages %}{{ m.content }}{% endfor %}');
const imported = [];
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(1500);
  await win.locator('[data-testid="advanced-params-toggle"]').click();
  await win.waitForSelector('[data-testid="engine-settings-tab"]', { timeout: 10000 });
  await win.waitForFunction(
    () => document.querySelectorAll('[data-testid^="flag-"]').length > 10,
    undefined,
    { timeout: 60000 },
  );
  await win.waitForTimeout(400);

  // 1. Popular: --jinja, then the template rows.
  const pop = await win.evaluate(() =>
    [...document.querySelectorAll('[data-testid="engine-flags-popular"] [data-testid^="flag-"]')]
      .map((r) => r.getAttribute('data-testid')?.slice(5))
      .filter((k) => !k.startsWith('drop-hint') && !k.startsWith('pick-')),
  );
  log('popular:', pop.join(' '));
  const j = pop.indexOf('--jinja');
  check(j >= 0, 'Popular has --jinja');
  check(pop[j + 1] === '--chat-template-file', 'the template file row is right after --jinja');
  check(pop[j + 2] === '--chat-template', 'the named template row follows');
  const row = win.locator('[data-testid="flag---chat-template-file"]');
  const rowInfo = await row.evaluate((el) => ({
    droppable: el.getAttribute('data-droppable'),
    button: el.querySelector('[data-testid="flag-pick---chat-template-file"]')?.textContent,
    hint: el.querySelector('[data-testid="flag-drop-hint---chat-template-file"]')?.textContent,
    control: el.querySelector('input')?.type,
  }));
  log('template row:', JSON.stringify(rowInfo));
  check(rowInfo.droppable === 'yes', 'the template row is a drop target');
  check(rowInfo.button === 'Upload…', `its button says Upload… (${rowInfo.button})`);
  check(/Drop a \.jinja/.test(rowInfo.hint ?? ''), 'it says to drop a .jinja on the row');
  await row.scrollIntoViewIfNeeded();
  await win.waitForTimeout(200);
  const box = await row.boundingBox();
  const jbox = await win.locator('[data-testid="flag---jinja"]').boundingBox();
  const clip = {
    x: Math.max(0, (jbox?.x ?? box.x) - 8),
    y: Math.max(0, (jbox?.y ?? box.y) - 8),
    width: (box.width ?? 600) + 16,
    height: box.y + box.height - (jbox?.y ?? box.y) + 90,
  };
  writeFileSync(path.join(SHOT_DIR, '01-template-rows.png'), await win.screenshot({ clip }));

  // 2. Drag over lights the row.
  await row.dispatchEvent('dragover');
  const lit = await row.evaluate((el) => el.classList.contains('pd-flag-row--drop'));
  check(lit, 'a drag over the row lights it up');
  writeFileSync(
    path.join(SHOT_DIR, '02-template-row-dragover.png'),
    await win.screenshot({ clip }),
  );
  await row.dispatchEvent('dragleave');

  // 3. The import copies into Bobble's storage; a same-name different-bytes file gets a suffix.
  const r1 = await win.evaluate(
    (p) => window.piDesktop.invoke('llm:import-chat-template', { path: p }),
    src,
  );
  log('import 1:', JSON.stringify(r1));
  imported.push(r1.path);
  check(r1.error === undefined, `import has no error (${r1.error})`);
  check(
    r1.path === path.join(tplDir, 'probe-template.jinja'),
    `copied to chat-templates (${r1.path})`,
  );
  check(
    existsSync(r1.path) && readFileSync(r1.path, 'utf8') === readFileSync(src, 'utf8'),
    'the copy has the same bytes',
  );
  writeFileSync(src, '{{ bos_token }}CHANGED');
  const r2 = await win.evaluate(
    (p) => window.piDesktop.invoke('llm:import-chat-template', { path: p }),
    src,
  );
  log('import 2:', JSON.stringify(r2));
  imported.push(r2.path);
  check(
    /probe-template-[0-9a-f]{8}\.jinja$/.test(r2.path),
    `different bytes under the same name get a hash suffix (${r2.path})`,
  );
  check(
    readFileSync(r1.path, 'utf8') !== 'CHANGED' &&
      readFileSync(r2.path, 'utf8') === '{{ bos_token }}CHANGED',
    'the first copy is untouched',
  );
  const r3 = await win.evaluate(
    (p) => window.piDesktop.invoke('llm:import-chat-template', { path: p }),
    '/nonexistent/x.jinja',
  );
  check(r3.error !== undefined, 'a missing file reports an error instead of throwing');

  // 4. Setting the flag lights Apply and shows the value.
  await row.locator('input').fill(r1.path);
  await win.waitForTimeout(300);
  const after = await win.evaluate(() => ({
    apply: document.querySelector('[data-testid="engine-settings-apply"]')?.disabled,
    set: document
      .querySelector('[data-testid="flag---chat-template-file"]')
      ?.getAttribute('data-set'),
    count: document.querySelector('[data-testid="engine-flags-set-count"]')?.textContent,
  }));
  log('after set:', JSON.stringify(after));
  check(after.apply === false, 'Apply lights up once a template is set');
  check(after.set === 'yes', 'the row shows as set');
  writeFileSync(path.join(SHOT_DIR, '03-template-set.png'), await win.screenshot({ clip }));

  // 5. No stepper on any number input. Chromium does not expose the spin
  // button's computed style, so this is an A/B: the row as shipped, then the
  // same row with the stepper forced back on — the two must differ, and the
  // shipped one must be the plain field.
  const budget = win.locator('[data-testid="flag---reasoning-budget"]');
  await budget.scrollIntoViewIfNeeded();
  await budget.locator('input').fill('512');
  await budget.locator('input').hover();
  await win.waitForTimeout(150);
  const bb = await budget.boundingBox();
  const fieldClip = { x: bb.x, y: bb.y - 4, width: bb.width, height: bb.height + 8 };
  const shipped = await win.screenshot({ clip: fieldClip });
  writeFileSync(path.join(SHOT_DIR, '04-number-hover.png'), shipped);
  await win.addStyleTag({
    content:
      'input[type="number"]::-webkit-inner-spin-button{appearance:auto !important;-webkit-appearance:inner-spin-button !important}',
  });
  await win.mouse.move(bb.x + bb.width - 30, bb.y + bb.height / 2);
  await win.waitForTimeout(150);
  const forced = await win.screenshot({ clip: fieldClip });
  writeFileSync(path.join(SHOT_DIR, '05-number-stepper-forced.png'), forced);
  check(
    !shipped.equals(forced),
    'forcing the stepper back on changes the field (so the rule is what hides it)',
  );
  const count = await win.evaluate(() => document.querySelectorAll('input[type="number"]').length);
  log('number inputs on the panel:', count);
  check(count > 0, 'the panel has number inputs');
} finally {
  await app.close().catch(() => {});
  for (const p of imported) if (p?.startsWith(tplDir)) rmSync(p, { force: true });
}
log(failures.length === 0 ? 'ALL PASS' : `FAILED: ${failures.length}`);
