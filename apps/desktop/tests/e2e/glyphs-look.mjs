/**
 * THE GLYPHS, LOOKED AT — every surface the user's 2026-09-20 icon set touches,
 * photographed in the real app (mock pi, throwaway home, headless):
 *
 *   the sidebar (new chat, Model management, Extensions, Scheduled, the four
 *   studios, a project's folder closed → open with the morph's mid-frames),
 *   both themes; Settings' nav and its Experimental flasks; Model management's
 *   Manage Storage tab; the Extensions page; an inline code widget's
 *   to-canvas arrow and the canvas bar's back-to-chat arrow; file cards with
 *   their extensions written on the page; the engine button.
 *
 *   SHOT_DIR=/tmp/glyphs node apps/desktop/tests/e2e/glyphs-look.mjs
 *
 * Asserts what a screenshot cannot: the label says Extensions, every glyph on
 * the rail draws its stroke at the token's pixel width whatever its grid, and
 * the folder morphs (mid-frames differ from both ends). Then LOOK.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const home = probeHome('glyphs-look');
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
const mkSession = (name, text) =>
  writeFileSync(
    path.join(sessionsDir, `${name}.jsonl`),
    [
      l({
        type: 'session',
        version: 3,
        id: `sess-${name}`,
        timestamp: 't',
        cwd: path.join(home, '.pi/desktop/sandbox', `conv-${name}`),
      }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: text, timestamp: 1 },
      }),
    ].join('\n'),
  );
mkSession('alpha', 'plan a launch');
mkSession('beta', 'fix the bug');

const { page, shot, check, finish } = await launchApp('glyphs-look', {
  env: { HOME: home },
  args: ['--', '--piE2E=1'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shotDir = process.env.SHOT_DIR ?? '/tmp/glyphs';
mkdirSync(shotDir, { recursive: true });
const clip = async (label, sel, pad = 8) => {
  const box = await page.locator(sel).first().boundingBox();
  if (box === null) {
    check(false, `${label}: ${sel} not on screen`);
    return;
  }
  const buf = await page.screenshot({
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  writeFileSync(path.join(shotDir, `${label}.png`), buf);
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="chat-row-plan a launch"]', { timeout: 10_000 });
  // The theme follows the Mac's appearance in a fresh home; pin it so the
  // pictures compare run to run (dark first, light later).
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'dark'));
  await sleep(300);

  // ── The rail: labels and glyphs ────────────────────────────────────────────
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="nav-"]')].map((el) => ({
      id: el.getAttribute('data-testid'),
      text: el.textContent?.trim() ?? '',
      glyph: el.querySelector('[data-glyph]')?.getAttribute('data-glyph') ?? null,
    })),
  );
  console.log('rail:', JSON.stringify(labels));
  check(
    labels.some((r) => r.id === 'nav-connectors' && r.text === 'Extensions'),
    'the connectors row is called Extensions',
  );
  check(
    labels.find((r) => r.id === 'nav-connectors')?.glyph === 'extensions',
    'and wears the puzzle',
  );
  check(
    labels.find((r) => r.id === 'nav-model-management')?.glyph === 'models',
    'Model management: the circuit board',
  );
  check(
    labels.find((r) => r.id === 'nav-scheduled')?.glyph === 'scheduled',
    'Scheduled: the calendar',
  );
  const newChatGlyph = await page.getAttribute(
    '[data-testid="new-chat"] [data-glyph]',
    'data-glyph',
  );
  check(newChatGlyph === 'newChat', `New chat: the circled plus (${newChatGlyph})`);

  // Every stroked icon on the rail draws at the SAME pixel width, whatever its
  // grid: the token is a pixel width now (vector-effect: non-scaling-stroke).
  const strokes = await page.evaluate(() => {
    const out = [];
    for (const svg of document.querySelectorAll(
      '.pd-sidebar .pd-icon, [data-testid="sidebar"] .pd-icon',
    )) {
      const path = svg.querySelector('path, circle, rect');
      if (path === null) continue;
      const cs = getComputedStyle(path);
      out.push({
        glyph: svg.getAttribute('data-glyph') ?? svg.getAttribute('class'),
        viewBox: svg.getAttribute('viewBox'),
        strokeWidth: getComputedStyle(svg).strokeWidth,
        vectorEffect: cs.vectorEffect,
        size: svg.getBoundingClientRect().width,
      });
    }
    return out;
  });
  const grids = new Set(strokes.map((s) => s.viewBox));
  const widths = new Set(strokes.map((s) => s.strokeWidth));
  console.log(
    'rail strokes:',
    JSON.stringify({
      grids: [...grids],
      widths: [...widths],
      sizes: [...new Set(strokes.map((s) => s.size))],
    }),
  );
  check(grids.size >= 2, 'the rail mixes the 16-grid icons and the 24-grid glyphs');
  check(widths.size === 1, `…and they all resolve to ONE stroke width (${[...widths].join(', ')})`);
  check(
    strokes.every((s) => s.vectorEffect === 'non-scaling-stroke'),
    'every stroked shape is non-scaling, so that width is pixels',
  );

  // The sidebar's curtain is still sliding in for a moment after launch.
  await sleep(900);
  await shot('01-sidebar');
  await clip('01b-rail', '[data-testid="modalities"]', 24);

  // ── A project's folder: closed, opening (mid-frames), open ────────────────
  await page.click('[data-testid="new-project"]');
  const projInput = page.locator('[data-testid^="project-rename-input-"]');
  await projInput.waitFor({ timeout: 8000 });
  await projInput.fill('Research');
  await projInput.press('Enter');
  const projectRow = page.locator('[data-testid^="project-row-"]').first();
  await projectRow.waitFor({ timeout: 8000 });
  await page.click('[data-testid="chat-menu-plan a launch"]', { force: true });
  await page.click('text=Add to project');
  await page.click('.pd-menu >> text=Research');
  await sleep(600);
  const rowSel = '[data-testid^="project-row-"]';
  const folderState = async () =>
    page.evaluate(
      (sel) => ({
        glyph: document.querySelector(`${sel} [data-glyph]`)?.getAttribute('data-glyph'),
        morphing: document.querySelector(`${sel} [data-glyph]`)?.getAttribute('data-morphing'),
        d: document.querySelector(`${sel} [data-glyph] path`)?.getAttribute('d')?.slice(0, 40),
      }),
      rowSel,
    );
  const before = await folderState();
  console.log('folder before click:', JSON.stringify(before));
  await clip('02-folder-a', rowSel, 6);
  // Click and catch the morph mid-flight.
  await page.click(rowSel);
  await sleep(70);
  const mid = await folderState();
  await clip('02-folder-b-mid', rowSel, 6);
  await sleep(70);
  await clip('02-folder-c-mid', rowSel, 6);
  await sleep(300);
  const after = await folderState();
  await clip('02-folder-d', rowSel, 6);
  console.log('folder mid:', JSON.stringify(mid), 'after:', JSON.stringify(after));
  check(
    before.glyph !== after.glyph,
    `the folder changed state (${before.glyph} → ${after.glyph})`,
  );
  check(mid.morphing === 'true', 'and it morphed between them (a mid-frame was a polyline)');
  check(mid.d !== before.d && mid.d !== after.d, 'the mid-frame is neither end');

  // ── The knobs: stroke sweep and size extremes on the rail ─────────────────
  // The stroke token is pixels; the slider stops at 1.75 — LOOK at why.
  for (const mode of ['dark', 'light']) {
    await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), mode);
    await sleep(200);
    for (const w of [1, 1.25, 1.5, 1.75, 2, 2.5]) {
      await page.evaluate(
        (v) => document.documentElement.style.setProperty('--pd-icon-stroke', String(v)),
        w,
      );
      await sleep(120);
      await clip(`04-stroke-${mode}-${w.toFixed(2)}`, '[data-testid="modalities"]', 24);
    }
  }
  await page.evaluate(() => document.documentElement.style.removeProperty('--pd-icon-stroke'));
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'dark'));
  await sleep(200);
  for (const k of [0.85, 1, 1.25]) {
    await page.evaluate(
      (v) => document.documentElement.style.setProperty('--pd-icon-scale', String(v)),
      k,
    );
    await sleep(120);
    await clip(`05-scale-${k.toFixed(2)}`, '[data-testid="modalities"]', 24);
  }
  const scaled = await page.evaluate(() => {
    const w = (sel) => document.querySelector(sel)?.getBoundingClientRect().width ?? 0;
    return {
      rail: w('[data-testid="nav-scheduled"] .pd-icon'),
      row: w('[data-testid="modality-image"] .pd-icon'),
      engine: w('[data-testid="engine-menu-button"] .pd-icon'),
    };
  });
  console.log('icon widths at 1.25×:', JSON.stringify(scaled));
  check(
    Math.abs(scaled.rail - 20) < 0.6 && Math.abs(scaled.row - 20) < 0.6,
    `a 16px icon is 20px at 1.25× (${scaled.rail}, ${scaled.row})`,
  );
  check(Math.abs(scaled.engine - 20) < 0.6, `…the top bar's too (${scaled.engine})`);
  await page.evaluate(() => document.documentElement.style.removeProperty('--pd-icon-scale'));
  // The chrome's icons are pure white on the dark theme (the user).
  const iconColor = await page.evaluate(() => ({
    mode: document.documentElement.getAttribute('data-mode'),
    color: getComputedStyle(
      document.querySelector('[data-testid="nav-scheduled"] .pd-sidebar-row-icon'),
    ).color,
  }));
  check(
    iconColor.mode !== 'dark' || iconColor.color === 'rgb(255, 255, 255)',
    `the rail's icons are pure white on dark (${JSON.stringify(iconColor)})`,
  );

  // ── The light theme (the app opens dark in a fresh home) ──────────────────
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'));
  await sleep(500);
  await shot('03-sidebar-light');
  await clip('03b-rail-light', '[data-testid="modalities"]', 24);
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'dark'));
  await sleep(300);

  // ── Settings: the nav, the flasks, the Extensions section ─────────────────
  await page.click('[data-testid="profile-button"]');
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-nav-experimental"]', { timeout: 8000 });
  await sleep(400);
  await shot('04-settings-nav');
  await page.click('[data-testid="settings-nav-interface"]');
  await sleep(400);
  const sizeSlider = await page.evaluate(
    () => document.querySelector('[data-testid="settings-icon-scale"]') !== null,
  );
  check(sizeSlider, 'Interface has the icon size slider');
  const noGenToggle = await page.evaluate(
    () => document.querySelector('[data-testid="settings-experimental-generation"]') === null,
  );
  check(noGenToggle, 'the on-device generation toggle is gone');
  await shot('04b-settings-interface');
  await page.click('[data-testid="settings-nav-experimental"]');
  await sleep(500);
  const flasks = await page.evaluate(
    () =>
      document.querySelectorAll('[data-testid="experimental-panel"] [data-glyph="experimental"]')
        .length,
  );
  check(flasks >= 2, `the Experimental page's sections wear the flask (${flasks})`);
  await shot('05-settings-experimental');
  await page.click('[data-testid="settings-nav-connectors"]');
  await sleep(400);
  const extTitle = await page.evaluate(() =>
    [...document.querySelectorAll('h1, h2')].map((h) => h.textContent?.trim()).filter(Boolean),
  );
  console.log('settings headings:', JSON.stringify(extTitle));
  check(extTitle.includes('Extensions'), 'Settings says Extensions');
  await shot('06-settings-extensions');
  await page.keyboard.press('Escape');
  await sleep(300);

  // ── Model management → Manage Storage ─────────────────────────────────────
  await page.click('[data-testid="nav-model-management"]');
  await page.waitForSelector('[data-testid="models-tab-storage"]', { timeout: 8000 });
  await page.click('[data-testid="models-tab-storage"]');
  await sleep(800);
  const tabGlyphs = await page.evaluate(() =>
    ['discover', 'device', 'storage'].map(
      (t) =>
        document
          .querySelector(`[data-testid="models-tab-${t}"] [data-glyph]`)
          ?.getAttribute('data-glyph') ?? null,
    ),
  );
  check(
    JSON.stringify(tabGlyphs) === JSON.stringify(['discover', 'onDevice', 'storage']),
    `the three tabs wear the compass, the laptop, the drive (${tabGlyphs.join(', ')})`,
  );
  await shot('07-storage');
  await clip('07b-tabs', '[data-testid="models-tab-storage"]', 60);

  // ── The Extensions page ───────────────────────────────────────────────────
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 8000 });
  await sleep(500);
  const pageTitle = await page.textContent('.pdc-title');
  check(pageTitle?.trim() === 'Extensions', `the page is titled Extensions (${pageTitle})`);
  await shot('08-extensions-page');

  // ── Back to a chat: an inline widget (a presented SVG) and its arrow into
  //    the canvas ────────────────────────────────────────────────────────────
  await page.click('[data-testid="chat-row-fix the bug"]');
  await sleep(600);
  const svgText =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect x="10" y="10" width="40" height="40" fill="#6aa" /><circle cx="90" cy="30" r="18" fill="#a86" /></svg>';
  const svgPath = path.join(home, 'shapes.svg');
  writeFileSync(svgPath, svgText);
  await page.evaluate(
    ({ file, text }) => {
      const pi = window.__pi_store?.();
      pi?.getState().appendUser('Draw two shapes.');
      pi?.getState().appendAssistantText('Here they are.');
      const chat = pi?.getState().session?.sessionFile ?? '';
      const store = window.__present_store?.();
      store
        ?.getState()
        .add({ path: file, chat, svg: { width: 120, height: 60, bytes: text.length, text } });
    },
    { file: svgPath, text: svgText },
  );
  await sleep(1500);
  const arrow = await page.evaluate(
    () =>
      document.querySelector('.pd-inline-widget-move [data-glyph]')?.getAttribute('data-glyph') ??
      null,
  );
  check(arrow === 'toCanvas', `the code widget's corner arrow points into the canvas (${arrow})`);
  await clip('09-inline-widget', '[data-testid="inline-widget"]', 10);
  await page.click('.pd-inline-widget-move');
  await sleep(1200);
  const back = await page.evaluate(
    () =>
      document.querySelector('.pd-canvas-show-inline [data-glyph]')?.getAttribute('data-glyph') ??
      null,
  );
  check(back === 'toInline', `the canvas bar's Show in chat arrow points back (${back})`);
  await shot('10-canvas-show-in-chat');
  await clip('10b-opbar', '.pd-canvas-show-inline', 40);

  // ── File cards: the extension written on the page ─────────────────────────
  const files = [
    'brief.pptx',
    'voice.wav',
    'config.xml',
    'notes.md',
    'demo.mp4',
    'data.json',
    'chart.py',
    'tuple.tiff',
  ];
  const mk = path.join(home, 'files');
  mkdirSync(mk, { recursive: true });
  for (const f of files) writeFileSync(path.join(mk, f), 'x');
  await page.evaluate(
    (list) => {
      const chat = window.__pi_store?.().getState().session?.sessionFile ?? '';
      const store = window.__present_store?.();
      for (const f of list) store?.getState().add({ path: f, chat, note: 'from the probe' });
    },
    files.map((f) => path.join(mk, f)),
  );
  await sleep(1500);
  const labelsOnCards = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-present-thumb .pd-file-glyph')].map((el) =>
      el.getAttribute('data-ext'),
    ),
  );
  console.log('file glyph labels:', JSON.stringify(labelsOnCards));
  check(
    labelsOnCards.includes('wav') && labelsOnCards.includes('pptx'),
    'the cards carry WAV and PPTX on their pages',
  );
  await shot('11-file-cards');
  await clip('11b-file-cards', '.pd-present-card, [data-testid="present-list"]', 12);

  // ── The engine button ─────────────────────────────────────────────────────
  const engine = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid="engine-menu-button"] [data-glyph]')
        ?.getAttribute('data-glyph') ?? null,
  );
  check(engine === 'engine', `the engine button is the graphics card (${engine})`);
  await clip('12-engine-button', '[data-testid="engine-menu-button"]', 30);
} finally {
  await finish();
}
