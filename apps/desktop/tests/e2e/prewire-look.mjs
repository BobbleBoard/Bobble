/**
 * THE PRE-WIRE, LOOKED AT — every surface W0-A turned into a registry,
 * photographed in both themes so a BEFORE and an AFTER build can be compared
 * pixel for pixel (deliverables/research/PLAN.md §2.3: "zero behaviour change
 * and zero pixel change").
 *
 *   SHOT_DIR=/tmp/prewire node apps/desktop/tests/e2e/prewire-look.mjs
 *
 * Run it once against a build of the base commit and once against the change,
 * then diff the two directories with `prewire-diff.mjs`. Beside every picture
 * it writes a DOM digest (`<state>.dom.json`: the test ids in document order and
 * the visible text), because a registry that renders the same pixels through a
 * different tree is still a change worth knowing about.
 *
 * What it walks (each state in light, then dark):
 *   the empty chat · the composer's + menu · a chat row's ⋯ menu · the
 *   delete-chat dialog · every Settings section and the Settings search ·
 *   Model management (On Device, Manage Storage) · Extensions · Scheduled ·
 *   the Image, Video, Audio and 3D studios · a chat thread after a reply.
 *
 * Headless through launchApp (hidden window, throwaway HOME, focus guard), no
 * model server (PI_E2E_NO_SERVER), CSS animations frozen for the capture.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'prewire-look');
mkdirSync(OUT, { recursive: true });

/*
 * A STABLE home (the same path every run, emptied first): Manage Storage
 * prints the library root, and a random home suffix is the one difference
 * two runs of the SAME build would otherwise show. Still never the real home;
 * removed at the end. The path is whatever probeHome makes of the name (a
 * worktree tag included, once the harness adds one), emptied and re-seeded.
 */
rmSync(probeHome('prewire-look', { stable: true }), { recursive: true, force: true });
const home = probeHome('prewire-look', { stable: true });
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const line = (o) => JSON.stringify(o);
/*
 * Each chat gets a FIXED age: the sidebar orders chats by the file's mtime and
 * labels them by it, and two files written in the same millisecond tie — so
 * which one is listed first changed from run to run (seen: two runs of the
 * SAME build disagreed on the order). Days old, so the labels ("2d", "3d")
 * hold for the whole run.
 */
const DAY = 86_400_000;
const mkSession = (name, text, daysOld) => {
  const file = path.join(sessionsDir, `${name}.jsonl`);
  writeFileSync(
    file,
    [
      line({
        type: 'session',
        version: 3,
        id: `sess-${name}`,
        timestamp: 't',
        cwd: path.join(home, '.pi/desktop/sandbox', `conv-${name}`),
      }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: text, timestamp: 1 },
      }),
    ].join('\n'),
  );
  const at = new Date(Date.now() - daysOld * DAY);
  utimesSync(file, at, at);
};
mkSession('alpha', 'plan a launch', 3);
mkSession('beta', 'fix the bug', 2);

const { page, check, finish } = await launchApp('prewire-look', {
  env: { HOME: home, PI_E2E_NO_SERVER: '1' },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Put the whole app in one mode, through the store when it is there. */
const setMode = async (mode) => {
  await page.evaluate((m) => {
    document.documentElement.setAttribute('data-mode', m);
  }, mode);
  await sleep(250);
};

/*
 * What the MACHINE says, not the app: the free space on the disk moves
 * whenever anything on this Mac writes. Its numbers are PINNED to one value
 * before every capture — masking alone is not enough, because the model hub's
 * hardware strip is right-aligned and a narrower "GB free" chip slides the
 * chips beside it by a fraction of a pixel, which re-rasterises their text.
 * Only text node values change (React keeps its nodes). Manage Storage's bar
 * is drawn from the same reading, so it is masked instead.
 */
const pinDiskReadings = () =>
  page.evaluate(() => {
    const pin = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const v = n.nodeValue ?? '';
        if (/\d/.test(v)) n.nodeValue = v.replace(/\d+(?:\.\d+)?/g, '400');
      }
    };
    for (const chip of document.querySelectorAll('[data-testid="hub-disk-free"]')) pin(chip);
    for (const line of document.querySelectorAll('.pd-storage-sum-line')) {
      if ((line.textContent ?? '').includes('free on this disk')) pin(line);
    }
  });
const volatile = () => [page.locator('.pd-storage-diskbar')];

/** Test ids in document order + the visible text: what a registry must not change. */
const digest = () =>
  page.evaluate(() => ({
    testids: [...document.querySelectorAll('[data-testid]')].map((e) =>
      e.getAttribute('data-testid'),
    ),
    text: (document.body.innerText ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\d+(?:\.\d+)?\s?[KMGT]?B free/g, '# free')
      .trim(),
    nodes: document.body.getElementsByTagName('*').length,
  }));

const states = [];
/** One state: its DOM digest once, then a picture per theme. */
const snap = async (label) => {
  await sleep(300);
  await pinDiskReadings();
  const dom = await digest();
  writeFileSync(path.join(OUT, `${label}.dom.json`), `${JSON.stringify(dom, null, 1)}\n`);
  for (const mode of ['light', 'dark']) {
    await setMode(mode);
    await pinDiskReadings();
    const buf = await page.screenshot({ animations: 'disabled', caret: 'hide', mask: volatile() });
    const file = path.join(OUT, `${label}-${mode}.png`);
    writeFileSync(file, buf);
    check(buf.length > 5000, `${label}-${mode} came back blank (${buf.length} bytes)`);
  }
  states.push(label);
};

const pressEscape = async () => {
  await page.keyboard.press('Escape');
  await sleep(250);
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="chat-row-plan a launch"]', { timeout: 10_000 });
  // The sidebar's curtain and the first-run tips settle after launch.
  await sleep(1200);

  // ── The chat and its composer ─────────────────────────────────────────────
  await snap('01-chat-empty');
  await page.click('[aria-label="Add to message"]');
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await snap('02-plus-menu');
  await pressEscape();

  // ── A chat row's ⋯ menu and the delete dialog ────────────────────────────
  await page.hover('[data-testid="chat-row-fix the bug"]');
  await page.click('[data-testid="chat-menu-fix the bug"]', { force: true });
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await snap('03-chat-row-menu');
  await page.click('[role="menuitem"]:has-text("Delete")');
  await page.waitForSelector('[data-testid="delete-chat-dialog"]', { timeout: 5000 });
  await snap('04-delete-dialog');
  await pressEscape();

  // ── Settings: every listed section, then the search ──────────────────────
  await page.click('[data-testid="footer-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  const nav = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="settings-nav-"]')].map((e) => ({
      id: e.getAttribute('data-testid'),
      text: e.textContent?.trim() ?? '',
    })),
  );
  writeFileSync(path.join(OUT, 'settings-nav.json'), `${JSON.stringify(nav, null, 1)}\n`);
  check(nav.length === 10, `Settings lists ten sections (got ${nav.length})`);
  for (const [i, item] of nav.entries()) {
    await page.click(`[data-testid="${item.id}"]`);
    await sleep(350);
    await snap(`05-settings-${String(i).padStart(2, '0')}-${item.id.replace('settings-nav-', '')}`);
  }
  await page.fill('[data-testid="settings-search"]', 'in');
  await snap('06-settings-search');
  await page.fill('[data-testid="settings-search"]', 'zzz');
  await snap('07-settings-search-empty');
  await pressEscape();

  // ── Workspace routes ─────────────────────────────────────────────────────
  await page.click('[data-testid="nav-model-management"]');
  await page.waitForSelector('[data-testid="models-tab-device"]', { timeout: 10_000 });
  await page.click('[data-testid="models-tab-device"]');
  await sleep(600);
  await snap('08-models-on-device');
  await page.click('[data-testid="models-tab-storage"]');
  await page.waitForSelector('[data-testid="storage-view"]', { timeout: 10_000 });
  await sleep(800);
  await snap('09-models-storage');
  await page.click('[data-testid="nav-connectors"]');
  await sleep(800);
  await snap('10-extensions');
  await page.click('[data-testid="nav-scheduled"]');
  await page.waitForSelector('[data-testid="scheduled-view"]', { timeout: 10_000 });
  await sleep(500);
  await snap('11-scheduled');

  // ── The studios ──────────────────────────────────────────────────────────
  for (const [n, modality] of [
    ['12', 'image'],
    ['13', 'video'],
    ['14', 'audio'],
  ]) {
    await page.click(`[data-testid="modality-${modality}"]`);
    await page.waitForSelector(`[data-testid="${modality}-studio"]`, { timeout: 10_000 });
    await sleep(900);
    await snap(`${n}-studio-${modality}`);
  }
  await page.click('[data-testid="modality-3d"]');
  await sleep(1500);
  await snap('15-studio-3d');

  // ── A chat thread after a (mock) reply ───────────────────────────────────
  await page.click('[data-testid="new-chat"]');
  await page.waitForSelector('.pd-composer-editor', { timeout: 10_000 });
  await sleep(600);
  await page.click('.pd-composer-editor');
  await page.keyboard.type('hello there');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      window
        .__pi_store()
        .getState()
        .messages.some((m) => m.kind === 'assistant' && m.isStreaming !== true),
    undefined,
    { timeout: 20_000 },
  );
  await sleep(1200);
  await snap('16-chat-thread');

  writeFileSync(path.join(OUT, 'states.json'), `${JSON.stringify(states, null, 1)}\n`);
  console.log(`prewire-look: ${states.length} states × 2 themes → ${OUT}`);
} catch (err) {
  check(false, `walk failed: ${err?.stack ?? err}`);
}
await finish();
/*
 * The stable home is ours to remove (launchApp only removes mkdtemp-shaped
 * ones). The app's children can still be flushing into it for a moment after
 * the window closes — MEASURED: one run's removal failed with ENOTEMPTY — so
 * retry, and never let tidying up turn a clean walk into a failed probe.
 */
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch (err) {
  console.warn(`prewire-look: could not remove ${home}: ${err?.message ?? err}`);
}
