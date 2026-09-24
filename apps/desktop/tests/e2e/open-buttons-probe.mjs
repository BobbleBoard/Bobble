/**
 * THE OPEN BUTTONS OPEN — clicked for real, observed at the OS boundary.
 *
 * the user (2026-09-23): "open buttons in the canvas / file presentation cards
 * don't work, even with selection of specific applications to open with."
 *
 * No probe had ever seen one fail, because none had ever made one run: the
 * canvas bar's clicks were RECORDED instead of invoked under E2E, and the app
 * list its ▾ shows was never fetched. What this drives instead is the whole
 * chain, click to process:
 *
 *   a fake `open` FIRST ON PATH (it writes its argv to a log and launches
 *   nothing) + `PI_E2E_FAKE_OPEN=1`, which is main's one permission to run it
 *   (electron/canvas/os-open.ts openPolicy). Every assertion below is on the
 *   argv that fake received — the exact command the real `open` would have got.
 *
 * What was broken, each checked here:
 *   1. a presented text file opened into a canvas tab with its TEXT and no
 *      PATH — the bar's Open, every ▾ app and "Open in folder" did nothing;
 *   2. the card at the foot of the thread opened its ▾ DOWNWARD, under the
 *      composer — rows past the scroller's edge could not be clicked;
 *   3. the card's blue Open focused a tab behind a CLOSED canvas;
 *   4. every refusal was silent (`void invoke`) — now it is a toast saying why.
 *
 *   SHOT_DIR=/tmp/open-buttons node apps/desktop/tests/e2e/open-buttons-probe.mjs
 */
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

// ── the fake `open` ─────────────────────────────────────────────────────────
const fakeDir = mkdtempSync(path.join(tmpdir(), 'pd-fake-open-'));
const fakeOpen = path.join(fakeDir, 'open');
const fakeLog = path.join(fakeDir, 'argv.log');
writeFileSync(fakeLog, '');
/*
 * One CALL line, then one ARG line per argument. A target named `no-app-for*`
 * fails the way macOS does for a type no app claims (-10814), so the refusal
 * path is exercised end to end without guessing at a real Mac's defaults.
 */
writeFileSync(
  fakeOpen,
  `#!/bin/sh
log='${fakeLog}'
printf 'CALL\\n' >> "$log"
for a in "$@"; do printf 'ARG %s\\n' "$a" >> "$log"; done
case "$*" in
  *no-app-for*)
    last=""
    for a in "$@"; do last="$a"; done
    echo "No application knows how to open URL file://$last (Error Domain=NSOSStatusErrorDomain Code=-10814 \\"kLSApplicationNotFoundErr: E.g. no application claims the file\\" UserInfo={_LSLine=1557, _LSFunction=runEvaluator})." >&2
    exit 1 ;;
esac
exit 0
`,
);
chmodSync(fakeOpen, 0o755);
// If the fake were not executable, PATH lookup would skip it and find the REAL
// `open` — which would launch apps over someone's work. Refuse to go on.
accessSync(fakeOpen, constants.X_OK);

/** Every call the fake received, as argv arrays. */
const calls = () => {
  const out = [];
  for (const line of readFileSync(fakeLog, 'utf8').split('\n')) {
    if (line === 'CALL') out.push([]);
    else if (line.startsWith('ARG ')) out[out.length - 1]?.push(line.slice(4));
  }
  return out;
};

// ── fixtures, in the throwaway home ─────────────────────────────────────────
const home = probeHome('open-buttons');
const dir = path.join(home, 'Bobble', 'open-probe');
mkdirSync(dir, { recursive: true });
const notes = path.join(dir, 'notes.md');
writeFileSync(notes, '# Notes\n\nThe presented text file.\n');
const unclaimed = path.join(dir, 'no-app-for.zzq');
writeFileSync(unclaimed, 'nothing on this Mac claims .zzq\n');
const gone = path.join(dir, 'gone.md');
writeFileSync(gone, '# about to be deleted\n');

const { app, page, shot, check, finish } = await launchApp('open-buttons', {
  env: {
    HOME: home,
    PATH: `${fakeDir}:${process.env.PATH}`,
    PI_E2E_FAKE_OPEN: '1',
    PI_E2E_NO_SERVER: '1',
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait until the fake has received `n` calls; returns the newest. */
const nthCall = async (n, label) => {
  for (let i = 0; i < 50; i += 1) {
    const c = calls();
    if (c.length >= n) return c[n - 1];
    await sleep(100);
  }
  check(
    false,
    `${label}: the fake \`open\` was never called (${calls().length} calls, wanted ${n})`,
  );
  return null;
};
const sameArgv = (got, want) => JSON.stringify(got) === JSON.stringify(want);
/** The present:show main raises, exactly as present-bridge.ts sends it. */
const present = (p, note) =>
  app.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0].webContents.send('pi-desktop:event', {
        channel: 'present:show',
        payload,
      });
    },
    { path: p, note },
  );
/**
 * The toast carrying `needle`, once its entrance has settled — and whether it
 * is really ON TOP where it sits (hit-tested at its text), not painted under
 * the composer or the canvas.
 */
const toastText = async (needle) => {
  for (let i = 0; i < 40; i += 1) {
    const texts = await page.locator('.pd-toast').allInnerTexts();
    const hit = texts.find((t) => t.includes(needle));
    if (hit !== undefined) {
      await sleep(800);
      const onTop = await page.evaluate((n) => {
        const toast = [...document.querySelectorAll('.pd-toast')].find((t) =>
          t.textContent?.includes(n),
        );
        const text = toast?.querySelector('.pd-toast-description') ?? toast;
        if (!text) return false;
        const r = text.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at !== null && toast.contains(at);
      }, needle);
      check(onTop, `the "${needle}" toast is on top where it sits`);
      return hit;
    }
    await sleep(100);
  }
  return null;
};

try {
  // Main really is looking at the fake first — or nothing below may run.
  const mainPath = await app.evaluate(() => process.env.PATH ?? '');
  const fakeFirst = mainPath.split(':')[0] === fakeDir;
  check(fakeFirst, `main's PATH starts with the fake open's dir (got ${mainPath.split(':')[0]})`);
  if (!fakeFirst) throw new Error('refusing to click Open without the fake first on PATH');

  await page.waitForFunction(() => typeof window.__pi_store === 'function', undefined, {
    timeout: 30_000,
  });
  // A thread long enough that the card sits where it always does: at the foot,
  // right above the composer.
  await page.evaluate(() => {
    const pi = window.__pi_store();
    for (let i = 0; i < 5; i += 1) {
      pi.getState().appendUser(`question ${i}`);
      pi.getState().appendAssistantText(`answer ${i}\n\n${'Some prose. '.repeat(60)}`);
    }
  });
  await sleep(400);
  await present(notes, 'the notes');
  await page.waitForSelector('.pd-present-card', { timeout: 10_000 });

  // ── 1. the canvas bar, on the presented text file ─────────────────────────
  await page.waitForFunction(
    (p) =>
      window
        .__pi_canvas?.()
        .getState()
        .tabs.some((t) => t.filePath === p),
    notes,
    { timeout: 10_000 },
  );
  // The app list is the REAL one for .md on this Mac (no longer skipped under E2E).
  await page.waitForFunction(
    (p) =>
      (
        window
          .__pi_canvas()
          .getState()
          .tabs.find((t) => t.filePath === p)?.openApps ?? []
      ).length > 0,
    notes,
    { timeout: 15_000 },
  );
  const tab = await page.evaluate(
    (p) =>
      window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.filePath === p),
    notes,
  );
  console.log(`canvas tab: kind=${tab.kind} key=${tab.key} filePath=${tab.filePath}`);
  console.log(`  apps: ${(tab.openApps ?? []).map((a) => `${a.name} (${a.id})`).join(', ')}`);
  check(tab.kind === 'file', 'the presented .md opens as a FILE tab');
  check(tab.filePath === notes, 'the tab carries the file’s absolute path');

  const bar = page.locator('.pd-canvas-opbar');
  await bar.locator('.pd-split-main').click({ timeout: 5000 });
  const primary = await nthCall(1, 'canvas Open');
  console.log('canvas Open        → open', JSON.stringify(primary));
  check(
    sameArgv(primary, [notes]),
    `canvas Open hands the file to the OS default (${JSON.stringify(primary)})`,
  );
  check(existsSync(primary?.[0] ?? ''), 'the path it was given exists');

  await bar.locator('.pd-split-caret').click({ timeout: 5000 });
  await page.waitForSelector('.pd-canvas-opbar .pd-split-menu', { timeout: 5000 });
  await sleep(250);
  await shot('01-canvas-open-with-menu');
  const barRows = bar.locator('.pd-split-menu [role="menuitem"]');
  const barNames = await barRows.allInnerTexts();
  console.log('canvas ▾ rows:', JSON.stringify(barNames));
  check(barNames.includes('Open in folder'), 'the ▾ still ends with "Open in folder"');
  const barApps = (tab.openApps ?? []).filter((a) => a.id !== tab.defaultApp?.id);
  check(barApps.length > 0, 'the ▾ lists at least one real app');
  const barPick = barApps[0];
  await barRows.filter({ hasText: barPick.name }).first().click({ timeout: 5000 });
  const withApp = await nthCall(2, 'canvas Open with');
  console.log(`canvas ▾ ${barPick.name} → open`, JSON.stringify(withApp));
  check(
    sameArgv(withApp, ['-b', barPick.id, notes]) || sameArgv(withApp, ['-a', barPick.id, notes]),
    `canvas ▾ ${barPick.name} opens the file in THAT app (${JSON.stringify(withApp)})`,
  );

  await bar.locator('.pd-split-caret').click({ timeout: 5000 });
  await bar.locator('.pd-split-menu [role="menuitem"]', { hasText: 'Open in folder' }).click({
    timeout: 5000,
  });
  const reveal = await nthCall(3, 'Open in folder');
  console.log('canvas Open in folder → open', JSON.stringify(reveal));
  check(
    sameArgv(reveal, ['-R', notes]),
    `"Open in folder" reveals it in Finder (${JSON.stringify(reveal)})`,
  );

  // ── 2 + 3. the card at the foot of the thread, with the canvas CLOSED ─────
  await page.locator('button[aria-label="Close canvas panel"]').first().click({ timeout: 5000 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"]')?.getAttribute('data-open') !==
      'true',
    undefined,
    { timeout: 5000 },
  );
  await sleep(500);
  await page.evaluate(() => {
    const card = document.querySelector('.pd-present-card');
    let el = card?.parentElement ?? null;
    while (el !== null && !/(auto|scroll)/.test(getComputedStyle(el).overflowY))
      el = el.parentElement;
    if (el !== null) el.scrollTop = el.scrollHeight;
  });
  await sleep(400);
  const card = page.locator('.pd-present-card').last();
  await card.locator('.pd-split-caret').click({ timeout: 5000 });
  await page.waitForSelector('.pd-present-card .pd-split-menu', { timeout: 5000 });
  await sleep(250);
  await shot('02-card-open-with-menu');
  const geometry = await page.evaluate(() => {
    const menu = document.querySelector('.pd-present-card .pd-split-menu');
    const control = document
      .querySelector('.pd-present-card .pd-split-root')
      ?.getBoundingClientRect();
    let scroller = menu?.parentElement ?? null;
    while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    const clip = scroller?.getBoundingClientRect();
    const rows = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((row) => {
      const r = row.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        name: row.textContent,
        reachable: hit !== null && row.contains(hit),
        hit: hit === null ? null : `${hit.tagName}.${String(hit.className).slice(0, 40)}`,
      };
    });
    return {
      side: menu?.getAttribute('data-side') ?? null,
      control: control ? [Math.round(control.top), Math.round(control.bottom)] : null,
      clip: clip ? [Math.round(clip.top), Math.round(clip.bottom)] : null,
      rows,
    };
  });
  console.log('card ▾:', JSON.stringify(geometry));
  check(
    geometry.side === 'top',
    `the card's ▾ opens UPWARD at the foot of the thread (side=${geometry.side})`,
  );
  for (const row of geometry.rows) {
    check(row.reachable, `card ▾ row "${row.name}" can be clicked (hit ${row.hit})`);
  }
  const record = await page.evaluate(
    (p) =>
      Object.values(window.__present_store().getState().byChat)
        .flat()
        .find((r) => r.path === p),
    notes,
  );
  const cardApps = [record?.defaultApp, ...(record?.openApps ?? [])].filter(Boolean);
  /*
   * THE SAME APP WEARS THE SAME ICON IN BOTH MENUS. Each app's icon used to go
   * through one of two shared temp files, and the card's list and the tab's
   * list are built at the same moment — so they swapped icons between apps.
   */
  const iconOf = (list, id) => list.find((a) => a.id === id)?.iconDataUrl ?? null;
  for (const a of tab.openApps ?? []) {
    check(
      iconOf(cardApps, a.id) === (a.iconDataUrl ?? null),
      `${a.name} has the same icon on the card as in the canvas menu`,
    );
  }
  const icons = (tab.openApps ?? []).filter((a) => a.iconDataUrl).map((a) => a.iconDataUrl);
  check(new Set(icons).size === icons.length, 'no two apps share one icon');
  // The LAST row — the one that used to sit under the composer.
  const cardPick = cardApps[cardApps.length - 1];
  await card
    .locator('.pd-split-menu [role="menuitem"]')
    .filter({ hasText: cardPick.name })
    .first()
    .click({ timeout: 5000 });
  const cardCall = await nthCall(4, 'card Open with');
  console.log(`card ▾ ${cardPick.name} → open`, JSON.stringify(cardCall));
  check(
    sameArgv(cardCall, ['-b', cardPick.id, notes]) ||
      sameArgv(cardCall, ['-a', cardPick.id, notes]),
    `card ▾ ${cardPick.name} opens the file in THAT app (${JSON.stringify(cardCall)})`,
  );

  const openBefore = await page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"]')?.getAttribute('data-open') ??
      'absent',
  );
  await card.locator('.pd-split-main').click({ timeout: 5000 });
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="canvas-tabs-panel"]')?.getAttribute('data-open') ===
        'true',
      undefined,
      { timeout: 5000 },
    )
    .catch(() => undefined);
  const openAfter = await page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"]')?.getAttribute('data-open') ??
      'absent',
  );
  console.log(`card Open: canvas ${openBefore} → ${openAfter}`);
  check(
    openBefore !== 'true' && openAfter === 'true',
    'the card’s Open brings the closed canvas back',
  );
  check(calls().length === 4, 'the card’s blue Open opens the canvas, not an app');
  await sleep(500);
  await shot('03-card-open-shows-canvas');

  // ── 4a. a refusal says WHY — no app claims the type ───────────────────────
  await present(unclaimed, 'a file nothing opens');
  await page.waitForFunction(
    (p) =>
      window.__pi_canvas().getState().activeTabId ===
      window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.filePath === p)?.id,
    unclaimed,
    { timeout: 10_000 },
  );
  await sleep(300);
  await page.locator('.pd-canvas-opbar .pd-split-main').click({ timeout: 5000 });
  const refused = await nthCall(5, 'canvas Open on an unclaimed type');
  check(
    sameArgv(refused, [unclaimed]),
    `the unclaimed file was handed over (${JSON.stringify(refused)})`,
  );
  const why = await toastText('no-app-for.zzq');
  console.log('toast:', JSON.stringify(why));
  check(
    why?.includes('No app on this Mac is set to open .zzq files') === true,
    `the refusal is on screen, with the reason (${why})`,
  );
  await shot('04-refusal-toast');

  // ── 4b. …and a file that is gone never reaches `open` at all ──────────────
  await present(gone, 'deleted next');
  await page.waitForFunction(
    (p) =>
      Object.values(window.__present_store().getState().byChat)
        .flat()
        .some((r) => r.path === p && (r.openApps ?? []).length > 0),
    gone,
    { timeout: 15_000 },
  );
  rmSync(gone);
  await page.locator('button[aria-label="Close canvas panel"]').first().click({ timeout: 5000 });
  await sleep(500);
  const goneCard = page.locator('.pd-present-card').last();
  await goneCard.locator('.pd-split-caret').click({ timeout: 5000 });
  await goneCard.locator('.pd-split-menu [role="menuitem"]').first().click({ timeout: 5000 });
  const goneWhy = await toastText('gone.md');
  console.log('toast:', JSON.stringify(goneWhy));
  check(goneWhy?.includes('not there any more') === true, `a deleted file says so (${goneWhy})`);
  check(calls().length === 5, 'a missing file is refused BEFORE anything is launched');
  await shot('05-gone-toast');

  // Main's own ledger agrees with the fake's.
  const ledger = await app.evaluate(() => globalThis.__pdOsOpens ?? []);
  console.log(
    'main ledger:',
    ledger
      .map((e) => `${e.channel} ran=${e.ran} ok=${e.outcome?.ok} ${JSON.stringify(e.argv)}`)
      .join('\n  '),
  );
  check(
    ledger.filter((e) => e.ran).length === 5,
    `main ran \`open\` five times (${ledger.filter((e) => e.ran).length})`,
  );
} finally {
  await finish();
  rmSync(fakeDir, { recursive: true, force: true });
}
