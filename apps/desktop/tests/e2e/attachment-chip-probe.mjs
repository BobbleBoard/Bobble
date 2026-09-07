/**
 * ATTACHMENT CHIPS: a box that opens, a selection you can copy, and an undo.
 *
 * the user's brief, in his order:
 *   "no name shown, just a box as shown, a bit bigger, and then slide to the
 *    right open when it's hovered over … show name a bit smaller and higher,
 *    truncate name if too long, show centered dot, file extension, then below
 *    it, size eg. 10.1 MB <centered dot> N tokens replace n with a loading
 *    spinner if prefilling still while hovered."
 *   "cmd/ctrl Z needs to be able to undo accidental file removals, clicking a
 *    file needs to highlight it blue and blue border and then allow for user to
 *    press ctrl c/x/v or shift click other files to do so."
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/chips node apps/desktop/tests/e2e/attachment-chip-probe.mjs
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('attachment-chip');

/** Three files: two text (one with a very long name), one image. */
const files = [];
const mk = (name, contents) => {
  const p = path.join(tmpdir(), `chip-${Date.now()}-${name}`);
  writeFileSync(p, contents);
  files.push(p);
  return p;
};

const chips = () =>
  page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    return [...document.querySelectorAll('[data-testid="attach-chip"]')].map((el) => ({
      selected: el.hasAttribute('data-selected'),
      size: box(el),
      // The detail is present in the DOM but has no width until hovered.
      detailW: Math.round(
        el.querySelector('.pd-attach-detail-inner')?.getBoundingClientRect().width ?? 0,
      ),
      text: (el.querySelector('.pd-attach-detail')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      border: getComputedStyle(el).borderColor,
    }));
  });

try {
  await page.waitForSelector('.pd-composer-editor', { timeout: 15_000 });

  const longName = 'a-really-quite-long-filename-that-should-be-truncated.md';
  mk('notes.md', 'word '.repeat(2000));
  mk(longName, 'x'.repeat(5000));
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const png = path.join(tmpdir(), `chip-${Date.now()}-shot.png`);
  writeFileSync(png, Buffer.from(PNG, 'base64'));
  files.push(png);

  await page.setInputFiles('[data-testid="composer-file-input"]', files);
  await page.waitForSelector('[data-testid="attach-chip"]', { timeout: 10_000 });
  await page.waitForTimeout(900);

  /* ── 1. At rest: boxes, no words ──────────────────────────────────────── */
  const rest = await chips();
  console.log(
    '   at rest:',
    JSON.stringify(rest.map((c) => ({ ...c, text: c.text.slice(0, 30) }))),
  );
  check(rest.length === 3, `three chips (got ${rest.length})`);
  check(
    rest.every((c) => c.detailW === 0),
    `no words at rest — the detail has zero width (${rest.map((c) => c.detailW).join(',')})`,
  );
  check(
    rest.every((c) => c.size.w <= 60 && c.size.h >= 40),
    `each is a box, a bit bigger than before (${JSON.stringify(rest[0]?.size)})`,
  );
  await shot('01-at-rest');

  /* ── 2. CLICKED: it slides open to the right ──────────────────────────── */
  /*
   * the user: "not on hover but on click expand them." Hover-to-expand meant that
   * dragging the pointer across a row of files opened and shut each one in turn,
   * so the row moved while you were trying to point at something in it.
   */
  await page.hover('[data-testid="attach-chip"]:first-of-type');
  await page.waitForTimeout(500);
  const merelyHovered = await chips();
  check(
    merelyHovered.every((c) => c.detailW === 0),
    `hovering alone does NOT open it (${merelyHovered[0]?.detailW}px)`,
  );

  await page.click('[data-testid="attach-chip"]:first-of-type');
  await page.waitForTimeout(600);
  const hovered = await chips();
  console.log('   clicked:', JSON.stringify(hovered[0]));
  check(hovered[0] !== undefined && hovered[0].detailW > 60, `it opens (${hovered[0]?.detailW}px)`);
  check(
    hovered.slice(1).every((c) => c.detailW === 0),
    'and only the one clicked opens',
  );
  const t = hovered[0]?.text ?? '';
  check(/notes\.md/.test(t), `the name (got "${t}")`);
  check(/MD/.test(t), 'the extension');
  check(/·/.test(t), 'a centered dot');
  check(/\d+(\.\d+)?\s?(B|KB|MB)/.test(t), `a size (got "${t}")`);
  check(/tokens|·/.test(t), 'and a token count');
  await shot('02-hovered');

  /* ── 3. Click to select, shift-click to extend ────────────────────────── */
  const all = await page.$$('[data-testid="attach-chip"]');
  await page.waitForTimeout(250);
  let sel = await chips();
  check(sel.filter((c) => c.selected).length === 1, 'a click selects one');
  check(
    sel[0]?.border !== rest[0]?.border,
    `and it turns blue (${rest[0]?.border} → ${sel[0]?.border})`,
  );
  await page.keyboard.down('Shift');
  await all[2]?.click();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(250);
  sel = await chips();
  console.log('   selected after shift-click:', sel.filter((c) => c.selected).length);
  check(sel.filter((c) => c.selected).length === 3, 'shift-click extends the range');
  await shot('03-selected');

  /* ── 4. Cut, then paste it back ───────────────────────────────────────── */
  await page.keyboard.press('Meta+x');
  await page.waitForTimeout(400);
  check((await chips()).length === 0, 'cut removes the selection');
  await page.keyboard.press('Meta+v');
  await page.waitForTimeout(400);
  const pasted = (await chips()).length;
  console.log(`   after paste: ${pasted}`);
  check(pasted === 3, `paste brings them back (got ${pasted})`);

  /* ── 5. Undo an accidental removal ────────────────────────────────────── */
  /*
   * The real flow now: click the chip to open it, then the X at the top right of
   * the preview. the user: "put the X just at the top right of the preview shown on
   * hover only."
   */
  const first = (await page.$$('[data-testid="attach-chip"]'))[0];
  await first?.click();
  await page.waitForTimeout(400);
  const x = await first?.$('.pd-attach-remove');
  await x?.click();
  await page.waitForTimeout(400);
  const afterRemove = (await chips()).length;
  check(afterRemove === 2, `removing one takes it away (got ${afterRemove})`);
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(400);
  const undone = await chips();
  check(undone.length === 3, `cmd-z brings back exactly the one removed (${undone.length})`);
  await shot('04-undone');

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
