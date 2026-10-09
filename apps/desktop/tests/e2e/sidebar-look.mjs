/**
 * LOOK at the sidebar's hierarchy and the new-chat lead, light and dark.
 *
 * The user (2026-09-24): "now the left sidebar, do you see the lack of hierarchy, and then
 * the bobble text on a new chat". A hierarchy complaint is a claim about sizes, weights,
 * inks and gaps, so this prints one row per piece of text in the sidebar, top to bottom:
 * its size/weight, its ink's contrast against the rail, its row height and the gap above
 * it — the numbers behind "everything reads as one list" — next to 2x shots of the rail
 * and of the empty chat's lead.
 *
 * Throwaway HOME with a real project folder (two chats) and three loose chats, hidden,
 * focus-guarded (launchApp). Run once per build with different SHOT_DIRs; names pair up.
 *
 *   SHOT_DIR=<dir> node apps/desktop/tests/e2e/sidebar-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const home = probeHome('sidebar-look');
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'look');
mkdirSync(sessionsDir, { recursive: true });
const projectDir = path.join(home, 'Projects', 'LocalConvert');
mkdirSync(projectDir, { recursive: true });
let stamp = Date.now() - 30 * 3600_000;
const mkSession = (name, text, cwd, stepMs) => {
  stamp += stepMs;
  const l = (o) => JSON.stringify(o);
  writeFileSync(
    path.join(sessionsDir, `${name}.jsonl`),
    [
      l({
        type: 'session',
        version: 3,
        id: `sess-${name}`,
        timestamp: new Date(stamp).toISOString(),
        cwd,
      }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: new Date(stamp).toISOString(),
        message: { role: 'user', content: text, timestamp: stamp },
      }),
      l({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: new Date(stamp + 5000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Here is a first pass on "${text}".` }],
          timestamp: stamp + 5000,
        },
      }),
    ].join('\n'),
  );
};
const sandbox = (n) => path.join(home, '.pi/desktop/sandbox', `conv-${n}`);
// Spread over a day and a half, so the rows carry different ages, as a real rail does.
mkSession('p1', 'Add a drag-and-drop zone to the converter', projectDir, 2 * 3600_000);
mkSession('p2', 'Why does the HEIC path fail on Sonoma?', projectDir, 5 * 3600_000);
mkSession('s1', 'Plan a launch checklist for the beta', sandbox(1), 9 * 3600_000);
mkSession('s2', 'Summarise the quarterly numbers', sandbox(2), 7 * 3600_000);
mkSession('s3', 'Draft a reply to the landlord', sandbox(3), 5 * 3600_000);

const { page, check, finish, shotDir } = await launchApp('sidebar-look', {
  env: { HOME: home, PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="composer-input"]',
  timeout: 45_000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const setTheme = (mode) =>
  page.evaluate((mode) => {
    const t = window.__pi_theme?.();
    t?.setFlavor?.('bobble');
    t?.setMode?.(mode);
  }, mode);

/** Every element in the rail that owns visible text, with the numbers hierarchy is made of. */
const inventory = () =>
  page.evaluate(() => {
    const rail = document.querySelector('.pd-sidebar');
    if (rail === null) return { error: 'no .pd-sidebar' };
    const lum = (rgb) => {
      const m = rgb.match(/[\d.]+/g).map(Number);
      const [r, g, b] = m.slice(0, 3).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const railBg = (() => {
      let e = rail;
      while (e && getComputedStyle(e).backgroundColor.replace(/\s/g, '').endsWith(',0)'))
        e = e.parentElement;
      return e ? getComputedStyle(e).backgroundColor : 'rgb(255,255,255)';
    })();
    // Blend a translucent ink over the rail for an honest contrast figure.
    const over = (fg, bg) => {
      const f = fg.match(/[\d.]+/g).map(Number);
      const b = bg.match(/[\d.]+/g).map(Number);
      const a = f.length > 3 ? f[3] : 1;
      return `rgb(${[0, 1, 2].map((i) => Math.round(f[i] * a + b[i] * (1 - a))).join(',')})`;
    };
    const contrast = (fg) => {
      const L1 = lum(over(fg, railBg));
      const L2 = lum(railBg);
      return ((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(1);
    };
    const out = [];
    const walker = document.createTreeWalker(rail, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.textContent.trim()) continue;
      const el = t.parentElement;
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const row =
        el.closest('button, a, [role="button"], [role="treeitem"], li, .pd-sidebar-row') ?? el;
      const rr = row.getBoundingClientRect();
      out.push({
        text: el.textContent.trim().slice(0, 34),
        cls: String(el.className).split(' ')[0].slice(0, 30),
        size: cs.fontSize,
        weight: cs.fontWeight,
        tt: cs.textTransform === 'uppercase' ? 'CAPS' : '',
        ink: contrast(cs.color),
        x: Math.round(r.left),
        y: Math.round(r.top),
        rowH: Math.round(rr.height),
        rowBg: getComputedStyle(row).backgroundColor,
      });
    }
    out.sort((a, b) => a.y - b.y || a.x - b.x);
    return { railBg, rows: out };
  });

try {
  await page.waitForSelector('.pd-sidebar', { timeout: 15_000 });
  await sleep(1200);
  const report = {};
  for (const mode of ['light', 'dark']) {
    await setTheme(mode);
    await sleep(700);
    const rail = await page.locator('.pd-sidebar').first().boundingBox();
    check(rail !== null, 'the rail is on the page');
    await page.screenshot({
      path: path.join(shotDir, `rail-${mode}.png`),
      clip: { x: 0, y: 0, width: Math.ceil(rail.x + rail.width), height: 900 },
    });
    await page.screenshot({ path: path.join(shotDir, `home-${mode}.png`) });
    const lead = page.locator('[data-testid="home-lead"]').first();
    if ((await lead.count()) > 0) {
      const b = await lead.boundingBox();
      await page.screenshot({
        path: path.join(shotDir, `lead-${mode}.png`),
        clip: {
          x: Math.max(0, b.x - 260),
          y: Math.max(0, b.y - 80),
          width: b.width + 520,
          height: b.height + 260,
        },
      });
    }
    report[mode] = await inventory();
  }
  writeFileSync(path.join(shotDir, 'inventory.json'), JSON.stringify(report, null, 1));

  // The states the populated rail does not show on its own, light only.
  await setTheme('light');
  await sleep(500);
  const railShot = async (name) => {
    const rail = await page.locator('.pd-sidebar').first().boundingBox();
    await page.screenshot({
      path: path.join(shotDir, `${name}.png`),
      clip: { x: 0, y: 0, width: Math.ceil(rail.x + rail.width), height: 900 },
    });
  };
  // Modalities folded, then open again.
  await page.click('[data-testid="modalities-toggle"]');
  await sleep(400);
  check(
    (await page.locator('[data-testid="modality-rows"]').count()) === 0,
    'Modalities folds from its header',
  );
  await railShot('rail-modalities-folded');
  await page.click('[data-testid="modalities-toggle"]');
  await sleep(400);
  check((await page.locator('[data-testid="modality-rows"]').count()) === 1, 'and opens again');
  // A project, made the way a person makes one: the section's "+".
  await page.hover('.pd-sidebar-section:has([data-testid="new-project"])');
  await page.click('[data-testid="new-project"]');
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(700);
  await railShot('rail-project');
  // The other two flavors: the Modalities header is structure, so it reaches them too.
  for (const flavor of ['claude', 'codex']) {
    await page.evaluate((f) => window.__pi_theme?.()?.setFlavor?.(f), flavor);
    await sleep(600);
    await railShot(`rail-${flavor}`);
  }
  await page.evaluate(() => window.__pi_theme?.()?.setFlavor?.('bobble'));
  const inv = report.light;
  console.log(`rail bg ${inv.railBg}`);
  let prevY = null;
  for (const r of inv.rows) {
    const gap = prevY === null ? '' : `+${r.y - prevY}`;
    prevY = r.y;
    console.log(
      `${String(r.y).padStart(4)} ${gap.padStart(5)}  x${String(r.x).padEnd(4)} ${r.size.padEnd(5)} ${String(r.weight).padEnd(4)} ${r.tt.padEnd(5)} ink ${r.ink.padStart(4)}:1  row ${String(r.rowH).padStart(3)}  ${r.text}`,
    );
  }
} finally {
  await finish();
}
