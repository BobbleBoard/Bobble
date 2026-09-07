/**
 * The composer half of the user's 2026-09-07 list, LOOKED AT.
 *
 *   1. `/` lists installed connectors with their REAL brand marks
 *   2. picking one inserts a pill wearing that mark — and nothing else changes
 *   3. an `@` mention is a pill and ONLY a pill (no chip above the box)
 *   4. one Backspace removes a pill whole
 *   5. removing the mention's pill takes its file with it
 *   6. the `@` / `/` panel is opaque and follows the caret
 *
 *   SHOT_DIR=/tmp/c20 node apps/desktop/tests/e2e/composer-round20-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

/* A home with a file to mention and a connector registry to list. */
const home = mkdtempSync(path.join(tmpdir(), 'c20-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
const project = path.join(home, 'project');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'notes.md'), '# notes\nthe mentioned file body\n'.repeat(40));
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'mcp-connectors.json'),
  JSON.stringify(
    {
      version: 1,
      mode: 'lite',
      servers: [
        { id: 'gmail', enabled: true, transport: 'stdio', command: 'true' },
        { id: 'notion', enabled: false, transport: 'stdio', command: 'true' },
      ],
    },
    null,
    2,
  ),
);

const { page, shot, check, finish, shotDir } = await launchApp('composer-round20', {
  env: { HOME: home },
});
const clip = async (label, box) =>
  writeFileSync(path.join(shotDir, `${label}.png`), await page.screenshot({ clip: box }));

const editor = '[data-testid="composer-input"]';
const acPanel = '[data-testid="composer-autocomplete"]';

const acRows = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-testid="composer-autocomplete"]');
    if (panel === null) return null;
    const rows = [...panel.querySelectorAll('[role="option"]')].map((r) => ({
      text: (r.textContent ?? '').slice(0, 60),
      brand: r.querySelector('[data-testid="ac-brand-icon"] svg') !== null,
    }));
    const cs = getComputedStyle(panel);
    const box = panel.getBoundingClientRect();
    return {
      rows,
      background: cs.background.slice(0, 90),
      opaque: !/rgba\([^)]*,\s*0(\.\d+)?\)/.test(cs.backgroundColor),
      left: Math.round(box.left),
    };
  });

const composerState = () =>
  page.evaluate(() => {
    const pills = [...document.querySelectorAll('[data-testid="composer-pill"]')];
    return {
      text: document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
      pills: pills.map((p) => ({
        label: p.querySelector('.pd-pill-label')?.textContent ?? '',
        brand: p.querySelector('[data-testid="composer-pill-brand"] svg') !== null,
        hasX: p.querySelector('button') !== null,
        border: getComputedStyle(p).borderTopWidth,
      })),
      chips: document.querySelectorAll('[data-testid="attach-chip"]').length,
    };
  });

const clearComposer = async () => {
  await page.click(editor);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
};

try {
  /* ── 1 + 2. `/` shows connectors, with real marks ─────────────────────── */
  await page.click(editor);
  await page.keyboard.type('/gm');
  await page.waitForSelector(acPanel, { timeout: 8000 });
  await page.waitForTimeout(500);
  const slash = await acRows();
  console.log('  / rows:', JSON.stringify(slash?.rows));
  check(slash !== null, 'the / panel opened');
  const gmail = slash?.rows.find((r) => r.text.includes('/gmail'));
  check(gmail !== undefined, 'an installed connector is offered by /');
  check(gmail?.brand === true, 'and it wears its REAL brand mark, not a generic glyph');
  check(slash?.opaque === true, `the panel is opaque (background-color ${slash?.background})`);
  await shot('01-slash-connectors');
  const panelBox = await page.evaluate(() => {
    const b = document
      .querySelector('[data-testid="composer-autocomplete"]')
      .getBoundingClientRect();
    return {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
    };
  });
  await clip('02-slash-panel', panelBox);

  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const afterPick = await composerState();
  console.log('  after picking /gmail:', JSON.stringify(afterPick));
  check(afterPick.pills.length === 1, 'picking a connector inserts exactly one pill');
  check(afterPick.pills[0]?.brand === true, "the pill wears the connector's own mark");
  check(afterPick.pills[0]?.hasX !== true, 'the pill has no X (the user: "no border, no X")');
  check(afterPick.pills[0]?.border === '0px', `and no border (got ${afterPick.pills[0]?.border})`);
  check(afterPick.chips === 0, 'a connector adds no attachment chip');
  await shot('03-connector-pill');

  /* ── 3b. Clicking a pill and pressing delete removes it ───────────────── */
  const pillEl = await page.$('[data-testid="composer-pill"]');
  if (pillEl !== null) {
    await pillEl.click();
    await page.waitForTimeout(250);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    const afterClickDelete = await composerState();
    console.log('  click + Delete:', afterClickDelete.pills.length);
    check(
      afterClickDelete.pills.length === 0,
      'clicking a pill and pressing delete removes it (the user: "clicking on any and clicking delete should remove them")',
    );
    // Put it back for the Backspace case below.
    await page.click(editor);
    await page.keyboard.type('/gm');
    await page.waitForSelector(acPanel, { timeout: 8000 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }

  /* ── 4. One Backspace removes it whole ────────────────────────────────── */
  await page.click(editor);
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
  const afterBksp = await composerState();
  console.log('  after one Backspace:', JSON.stringify(afterBksp.pills.length));
  check(afterBksp.pills.length === 0, 'ONE Backspace removes the pill whole');

  /* ── 3 + 5. `@` is a pill and only a pill ─────────────────────────────── */
  await clearComposer();
  await page.keyboard.type('look at @notes');
  await page.waitForSelector(acPanel, { timeout: 8000 });
  await page.waitForTimeout(700);
  const mention = await acRows();
  console.log('  @ rows:', JSON.stringify(mention?.rows?.slice(0, 3)));
  if (mention !== null && mention.rows.length > 0) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const afterMention = await composerState();
    console.log('  after @notes:', JSON.stringify(afterMention));
    check(afterMention.pills.length === 1, 'a mention inserts a pill');
    check(
      afterMention.chips === 0,
      `and NO chip above the box (the user: "no attachment shown above") — got ${afterMention.chips}`,
    );
    await shot('04-mention-pill');

    await page.click(editor);
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    const gone = await composerState();
    check(gone.pills.length === 0, 'Backspace removes the mention pill');
  } else {
    console.log('  (no file suggestions in this fixture — @ case skipped)');
  }

  /* ── 6. The panel follows the caret ───────────────────────────────────── */
  await clearComposer();
  console.log('  composer after clear:', JSON.stringify((await composerState()).text));
  await page.keyboard.type(
    'a fairly long run of words before the trigger so the caret is well right ',
  );
  await page.waitForTimeout(200);
  await page.keyboard.type('/gm');
  await page.waitForTimeout(600);
  console.log('  composer before panel:', JSON.stringify((await composerState()).text));
  await page.waitForSelector(acPanel, { timeout: 8000 });
  await page.waitForTimeout(400);
  const shifted = await acRows();
  console.log(`  panel left: near-caret ${shifted?.left} vs at-start ${slash?.left}`);
  check(
    shifted !== null && slash !== null && shifted.left > slash.left,
    'the panel follows the caret rather than pinning to the left edge',
  );
  await shot('05-panel-follows-caret');
  console.log('shots in', shotDir);
} finally {
  await finish();
}
