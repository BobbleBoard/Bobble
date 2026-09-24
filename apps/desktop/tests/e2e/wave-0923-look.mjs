/**
 * LOOK at the user's 2026-09-23 list, the parts a unit test cannot see:
 *
 *   A. the computer-use icon — a window with traffic lights and the agent's
 *      cursor at its lower right (Settings nav, and the canvas tab);
 *   B. a project's chats SLIDE when it opens and closes, instead of snapping;
 *   C. deleting a chat is instant: the row is gone within a frame of the
 *      click, the file is gone from disk, and it does not come back;
 *   D. the computer-use preview keeps a margin: the driven window never
 *      touches the edges of the canvas.
 *
 * Headless and invisible like every probe (harness.mjs). The monitor runs on
 * the dev frame source (PI_MAC_MONITOR_MOCK=1), which stubs the helper only.
 *
 *   SHOT_DIR=/tmp/wave-0923 node apps/desktop/tests/e2e/wave-0923-look.mjs
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { measureDrawnWindow } from './_macmon-measure.mjs';
import { driveMacThroughActivity, waitForMonitorTab } from './_macmon-open.mjs';
import { launchApp, probeHome } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Four chats: three in a project, one outside it (the row whose movement
   shows whether the project slid or snapped). */
const home = probeHome('wave-0923');
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
const l = (o) => JSON.stringify(o);
const file = (name) => path.join(sessionsDir, `${name}.jsonl`);
const mkSession = (name, text, minute) =>
  writeFileSync(
    file(name),
    [
      l({
        type: 'session',
        version: 3,
        id: `sess-${name}`,
        timestamp: `2026-09-23T10:${String(minute).padStart(2, '0')}:00.000Z`,
        cwd: path.join(home, '.pi/desktop/sandbox', `conv-${name}`),
      }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: `2026-09-23T10:${String(minute).padStart(2, '0')}:01.000Z`,
        message: { role: 'user', content: text, timestamp: 1 },
      }),
    ].join('\n'),
  );
mkSession('p1', 'research the market', 1);
mkSession('p2', 'draft the outline', 2);
mkSession('p3', 'collect the sources', 3);
mkSession('out', 'plan the launch', 4);
mkSession('gone', 'delete me please', 5);

const { page, shot, check, finish, shotDir } = await launchApp('wave-0923', {
  env: { HOME: home, PI_MAC_MONITOR_MOCK: '1' },
  args: ['--', '--piE2E=1'],
  waitFor: '[data-testid="composer-input"]',
});
const clip = async (label, selector, pad = 16) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) return shot(label);
  return page.screenshot({
    path: path.join(shotDir, `${label}.png`),
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForSelector('[data-testid="chat-row-plan the launch"]', { timeout: 15000 });

  /* ── B. the project slide ─────────────────────────────────────────────── */
  const project = { id: 'proj-research', name: 'Research' };
  await page.evaluate(
    ({ project, files }) =>
      window
        .__settings_store()
        .getState()
        .update({
          chatOrg: {
            projects: [project],
            assignments: Object.fromEntries(files.map((f) => [f, project.id])),
            pinned: [],
            titles: {},
          },
        }),
    { project, files: [file('p1'), file('p2'), file('p3')] },
  );
  await page.waitForSelector(`[data-testid="project-row-${project.id}"]`, { timeout: 8000 });
  await sleep(700);
  await clip('b0-project-open', '.pd-sidebar, [data-testid="session-sidebar"]', 0);

  /** Click the project row, then sample where the row BELOW the project sits,
      every frame for 420 ms. A slide moves it through the heights between;
      a snap moves it in one frame. */
  const toggleAndSample = () =>
    page.evaluate(
      ({ id }) =>
        new Promise((resolve) => {
          const below = () =>
            document
              .querySelector('[data-testid="chat-row-plan the launch"]')
              ?.getBoundingClientRect().top ?? null;
          const samples = [below()];
          document.querySelector(`[data-testid="project-row-${id}"]`)?.click();
          const t0 = performance.now();
          const tick = () => {
            samples.push(below());
            if (performance.now() - t0 < 420) requestAnimationFrame(tick);
            else resolve(samples);
          };
          requestAnimationFrame(tick);
        }),
      { id: project.id },
    );
  const between = (samples) => {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const lo = Math.min(first, last) + 4;
    const hi = Math.max(first, last) - 4;
    return {
      travel: Math.round(Math.abs(last - first)),
      frames: samples.length,
      inBetween: samples.filter((y) => y > lo && y < hi).length,
    };
  };

  const closing = between(await toggleAndSample());
  await sleep(200);
  await clip('b1-project-closed', '.pd-sidebar, [data-testid="session-sidebar"]', 0);
  check(closing.travel > 40, `closing the project moves the rows below it (${closing.travel}px)`);
  check(
    closing.inBetween >= 4,
    `…and it SLIDES: ${closing.inBetween} of ${closing.frames} frames in between (a snap has 0)`,
  );
  // Mid-slide frame for the report.
  await page.evaluate(
    ({ id }) => document.querySelector(`[data-testid="project-row-${id}"]`)?.click(),
    { id: project.id },
  );
  await sleep(110);
  await clip('b2-project-opening-midway', '.pd-sidebar, [data-testid="session-sidebar"]', 0);
  await sleep(500);
  const opening = between(await toggleAndSample());
  check(
    opening.inBetween >= 4,
    `closing again slides too: ${opening.inBetween} of ${opening.frames} frames in between`,
  );
  /* A still of the slide itself: the same motion at a tenth of the speed, so
     one screenshot lands in the middle of it (a snap has no middle). */
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.id = 'probe-slow';
    st.textContent =
      '.pd-project-chats-slide, .pd-project-chats-slide * { transition-duration: 2400ms !important; }';
    document.head.append(st);
  });
  await page.evaluate(
    ({ id }) => document.querySelector(`[data-testid="project-row-${id}"]`)?.click(),
    { id: project.id },
  );
  await sleep(1150);
  await clip('b3-project-opening-slowed-midway', '.pd-sidebar, [data-testid="session-sidebar"]', 0);
  await sleep(1700);
  await page.evaluate(() => document.getElementById('probe-slow')?.remove());
  await sleep(300);

  /* ── C. delete is instant, and final ──────────────────────────────────── */
  const title = 'delete me please';
  await page.locator(`[data-testid="chat-row-${title}"]`).hover();
  await page.click(`[data-testid="chat-menu-${title}"]`);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.waitForSelector('[data-testid="delete-chat-confirm"]', { timeout: 5000 });
  await clip('c0-delete-confirm', '[data-testid="delete-chat-dialog"]');
  const gone = await page.evaluate(
    ({ title }) =>
      new Promise((resolve) => {
        const row = () => document.querySelector(`[data-testid="chat-row-${title}"]`);
        const t0 = performance.now();
        document.querySelector('[data-testid="delete-chat-confirm"]')?.click();
        const tick = () => {
          if (row() === null) resolve(Math.round(performance.now() - t0));
          else if (performance.now() - t0 > 3000) resolve(null);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    { title },
  );
  await sleep(150);
  await clip('c1-after-delete', '.pd-sidebar, [data-testid="session-sidebar"]', 0);
  check(gone !== null && gone <= 50, `the row is gone within a frame of Delete (${gone} ms)`);
  await sleep(2500);
  check(!existsSync(file('gone')), 'the chat file is gone from disk');
  // A fresh listing (a new chat triggers one) must not bring it back.
  await page.evaluate(() => window.__pi_store().setState({ session: { sessionId: 'relist' } }));
  await sleep(900);
  const back = await page.$(`[data-testid="chat-row-${title}"]`);
  check(back === null, 'and it does not come back on the next listing');

  /* ── A. the computer-use icon ─────────────────────────────────────────── */
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-nav-computer-use"]', { timeout: 8000 });
  await sleep(400);
  await clip('a0-settings-nav-icon', '[data-testid="settings-nav-computer-use"]', 10);
  // The same glyph at 96px, to see its drawing.
  await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="settings-nav-computer-use"] svg');
    if (svg instanceof SVGElement) {
      svg.style.width = '96px';
      svg.style.height = '96px';
      svg.setAttribute('data-probe-zoom', 'true');
    }
  });
  await sleep(200);
  await clip('a1-icon-96px', '[data-probe-zoom="true"]', 12);
  const glyph = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="settings-nav-computer-use"] svg');
    return {
      circles: svg?.querySelectorAll('circle').length ?? 0,
      paths: [...(svg?.querySelectorAll('path') ?? [])].map((p) => p.getAttribute('d') ?? ''),
    };
  });
  /* The glyph set is paths only: each light is a tiny closed arc. */
  const lights = glyph.paths.filter((d) => /A0\.7 0\.7 0 1 0/.test(d)).length;
  check(lights === 3, `the window has three traffic lights (${lights})`);
  check(
    glyph.paths.some((d) => d.startsWith('M12.702 14.276')),
    'the agent cursor sits at the lower right of the window',
  );
  await page.keyboard.press('Escape');
  await sleep(500);

  /* ── D. the preview's margin ──────────────────────────────────────────── */
  await driveMacThroughActivity(page);
  check(await waitForMonitorTab(page), 'the Activity tab became the monitor');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="computer-use-surface"]')
        ?.querySelector('.pd-macmon-live[data-live="true"]') !== null,
    undefined,
    { timeout: 15000 },
  );
  const mode = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-testid="computer-use-surface"]')?.getAttribute('data-mode') ??
        '',
    );
  if ((await mode()) !== 'fit') {
    await page.evaluate(() => document.querySelector('[data-testid="macmon-fit"]')?.click());
    await sleep(700);
  }
  await sleep(900);
  const box = await page.evaluate(measureDrawnWindow);
  await clip('d0-monitor-fit', '[data-testid="computer-use-surface"]', 0);
  await clip('d1-canvas-tab-icon', '[role="tablist"], .pd-canvas-tabs', 6);
  if (box === null) check(false, 'no window was drawn in the monitor');
  else {
    const m = {
      left: box.x / box.dpr,
      right: box.cssW - (box.x + box.w) / box.dpr,
      top: box.y / box.dpr,
      bottom: box.cssH - (box.y + box.h) / box.dpr,
    };
    const fmt = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)]));
    check(
      Math.min(m.left, m.right) >= 14,
      `the window keeps a margin from the canvas's sides: ${JSON.stringify(fmt)}`,
    );
    check(Math.min(m.top, m.bottom) >= 14, `…and from its top and bottom: ${JSON.stringify(fmt)}`);
  }
} finally {
  await finish();
}
