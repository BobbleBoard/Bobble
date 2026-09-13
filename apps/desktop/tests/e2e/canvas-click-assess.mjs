/**
 * THE CANVAS BY CLICKING — every file type through the file tree, looked at.
 *
 * The model-driven half of the assessment (canvas-assess.mjs) showed that a
 * small chat model almost never reaches the canvas's media surfaces on its own:
 * it `open`s, `cat`s, or asks for Chrome. A person, though, clicks a file in
 * the tree. This probe does that for every fixture and screenshots what the
 * surface shows, so each kind — image, gif, webp, video, flac, mp3, 3D mesh,
 * docx, xlsx, pptx, pdf, markdown, json, csv, txt, svg, html, py — gets judged
 * by its own picture. Assessment only; nothing here asserts.
 *
 * Also the panel's own chrome: the "+" menu, tab switching, closing, popout,
 * collapse/reopen, and the resize handle.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const PROJECT = process.env.PROJECT ?? '/tmp/canvas-assess/project';
const OUT = process.env.OUT ?? '/tmp/canvas-assess/click';
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

/** Folder → files, in the order a person would wander through them. */
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const FILES_ALL = [
  [
    'media',
    [
      'mug.png',
      'mug.jpg',
      'mug.gif',
      'mug.webp',
      'clip.mp4',
      'beat.flac',
      'beat.mp3',
      'sfx.flac',
      'mug.glb',
    ],
  ],
  [
    'docs',
    ['README.md', 'letter.docx', 'kitchen-sink.docx', 'budget.xlsx', 'pitch.pptx', 'sample.pdf'],
  ],
  ['data', ['users.json', 'big.json', 'data.csv', 'notes.txt']],
  ['site', ['index.html']],
  ['analysis', ['stats.py']],
  ['.', ['boat.svg']],
];

const FILES =
  ONLY === null
    ? FILES_ALL
    : FILES_ALL.map(([d, fs]) => [d, fs.filter((f) => ONLY.has(f))]).filter(
        ([, fs]) => fs.length > 0,
      );
const home = probeHome('canvas-click');
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'canvas-click-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'bobble'),
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const findings = [];
const consoleLines = [];

try {
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      consoleLines.push(`[${m.type()}] ${m.text().slice(0, 240)}`);
  });
  win.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 240)}`));
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.evaluate((p) => window.piDesktop.invoke('project:set', { path: p }), PROJECT);
  await win.reload();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(2500);
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 30000 });

  const state = () =>
    win.evaluate(() => {
      const s = window.__pi_canvas().getState();
      const active = s.tabs.find((t) => t.id === s.activeTabId);
      return {
        count: s.tabs.length,
        active: active
          ? { kind: active.kind, title: active.title ?? '', key: active.key ?? '' }
          : null,
        kinds: s.tabs.map((t) => t.kind),
      };
    });
  const panelText = () =>
    win
      .evaluate(() => {
        const panel = document.querySelector('[data-testid="canvas-tabs-panel"]');
        if (!panel) return { open: false };
        const t = panel.innerText ?? '';
        const media = [...panel.querySelectorAll('img, video, audio, canvas, iframe, webview')].map(
          (el) => {
            const r = el.getBoundingClientRect();
            return `${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)}`;
          },
        );
        return {
          open: true,
          hints: [
            ...new Set(
              [
                'No surface',
                'Could not',
                'Failed',
                'failed',
                'Error',
                'error',
                'Unavailable',
                'not available',
                'Loading',
              ].filter((n) => t.includes(n)),
            ),
          ],
          media,
          excerpt: t.replace(/\s+/g, ' ').slice(0, 160),
        };
      })
      .catch(() => ({ open: false, error: 'panel unreadable' }));

  // The file tree, the way a person opens it: the canvas's own "+ › Files"
  // (⌘P). The panel may be collapsed at first; the toggle brings it up.
  const toggle0 = win.locator('[data-testid="canvas-toggle"]');
  if (
    (await win.locator('[data-testid="canvas-tabs-panel"]').count()) === 0 &&
    (await toggle0.count()) > 0
  ) {
    await toggle0
      .first()
      .click()
      .catch(() => {});
    await win.waitForTimeout(700);
  }
  let opened = 'no + button';
  const plus0 = win.locator('[aria-label="New tab"]').first();
  if ((await plus0.count()) > 0) {
    await plus0.click();
    await win.waitForTimeout(400);
    const files = win.locator('[role="menuitem"]', { hasText: /^Files/ }).first();
    if ((await files.count()) > 0) {
      await files.click();
      opened = 'via + › Files';
    } else {
      // The empty state lists the same rows without a menu.
      const row = win
        .locator('[data-testid="canvas-tabs-panel"] button', { hasText: /^Files/ })
        .first();
      if ((await row.count()) > 0) {
        await row.click();
        opened = 'via the empty-state row';
      }
    }
  } else {
    const row = win
      .locator('[data-testid="canvas-tabs-panel"] button', { hasText: /^Files/ })
      .first();
    if ((await row.count()) > 0) {
      await row.click();
      opened = 'via the empty-state row';
    }
  }
  say(`file tree tab: ${opened}`);
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(OUT, '00-filetree.png') });
  const treeState = await state();
  findings.push({ step: 'filetree', state: treeState, panel: await panelText() });

  const panel = win.locator('[data-testid="canvas-tabs-panel"]');
  let n = 0;
  for (const [folder, files] of FILES) {
    // Folders open expanded (SEEN); clicking one collapses it. Only open a
    // folder whose files are not visible.
    if (folder !== '.') {
      const firstFile = panel.getByText(files[0], { exact: true }).first();
      if ((await firstFile.count()) === 0) {
        const dir = panel.getByText(folder, { exact: true }).first();
        if ((await dir.count()) > 0) {
          await dir.click().catch(() => {});
          await win.waitForTimeout(400);
        }
      }
    }
    for (const name of files) {
      n += 1;
      const tag = `${String(n).padStart(2, '0')}-${name.replace(/[^a-z0-9.]/gi, '_')}`;
      // Back to the tree tab first — a click lands on the tree, not on whatever
      // surface the last file opened.
      await win.evaluate(() => {
        const c = window.__pi_canvas();
        const t = c.getState().tabs.find((x) => x.kind === 'filetree');
        if (t) c.focusTab(t.id);
      });
      await win.waitForTimeout(300);
      const row = panel.getByText(name, { exact: true }).first();
      const present = (await row.count()) > 0;
      if (!present) {
        findings.push({ step: name, missing: true });
        say(`${tag}: not in the tree`);
        continue;
      }
      await row.click().catch(() => {});
      // Let a surface load: a 26 MB mesh and a docx editor both take a moment.
      await win.waitForTimeout(
        name.endsWith('.glb') || /\.(docx|xlsx|pptx|pdf)$/.test(name) ? 6000 : 2200,
      );
      await win.screenshot({ path: path.join(OUT, `${tag}.png`) });
      const st = await state();
      const pt = await panelText();
      /*
       * A native office editor is a WebContentsView OVER the page — invisible to
       * a page screenshot (SEEN: five blank panels). `office:capture` is the
       * app's own way to photograph one, built for its acceptance checks.
       */
      if (st.active?.kind === 'office') {
        const shot = await win
          .evaluate(async () => {
            const s = window.__pi_canvas().getState();
            const r = await window.piDesktop.invoke('office:capture', { tabId: s.activeTabId });
            return r;
          })
          .catch((e) => ({ dataUrl: null, error: String(e) }));
        if (shot?.dataUrl) {
          writeFileSync(
            path.join(OUT, `${tag}-office.png`),
            Buffer.from(shot.dataUrl.split(',')[1], 'base64'),
          );
          pt.office = 'captured';
        } else {
          pt.office = `capture failed: ${shot?.error ?? 'no image'}`;
        }
      }
      findings.push({ step: name, state: st, panel: pt });
      say(
        `${tag}: ${st.active?.kind ?? '?'} · media=${JSON.stringify(pt.media)} · hints=${JSON.stringify(pt.hints)}${pt.office ? ` · office=${pt.office}` : ''}`,
      );
    }
  }

  // The panel's own chrome.
  const chrome = {};
  const plus = win.locator('[aria-label="New tab"]').first();
  if ((await plus.count()) > 0) {
    await plus.click().catch(() => {});
    await win.waitForTimeout(500);
    await win.screenshot({ path: path.join(OUT, '90-plus-menu.png') });
    chrome.plusMenu = await win
      .evaluate(() =>
        [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map((e) =>
          e.textContent?.trim(),
        ),
      )
      .catch(() => []);
    await win.keyboard.press('Escape');
  }
  const tabs = panel.locator('[role="tab"]');
  chrome.tabCount = await tabs.count();
  const st = await state();
  chrome.kinds = st.kinds;
  // switch through a few tabs
  for (let i = 0; i < Math.min(4, chrome.tabCount); i++) {
    await tabs
      .nth(i)
      .click()
      .catch(() => {});
    await win.waitForTimeout(400);
  }
  await win.screenshot({ path: path.join(OUT, '91-tabs.png') });
  const pop = win.locator('[data-testid="canvas-popout"]');
  if ((await pop.count()) > 0) {
    await pop
      .first()
      .click()
      .catch(() => {});
    await win.waitForTimeout(1500);
    chrome.popout = `windows: ${app.windows().length}`;
    for (const w of app.windows()) {
      if (w !== win) {
        await w.screenshot({ path: path.join(OUT, '92-popout-window.png') }).catch(() => {});
        await w.close().catch(() => {});
      }
    }
    await win.waitForTimeout(800);
    await win.screenshot({ path: path.join(OUT, '93-after-popout.png') });
    chrome.afterPopout = await state();
  }
  const handle = win.locator('[data-testid="canvas-rail-handle"]');
  if ((await handle.count()) > 0) {
    const box = await handle.boundingBox();
    if (box) {
      await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await win.mouse.down();
      await win.mouse.move(box.x - 300, box.y + box.height / 2, { steps: 12 });
      await win.mouse.up();
      await win.waitForTimeout(500);
      await win.screenshot({ path: path.join(OUT, '94-resized.png') });
      chrome.resized = 'dragged the rail 300px left';
    }
  }
  const toggle = win.locator('[data-testid="canvas-toggle"]');
  if ((await toggle.count()) > 0) {
    await toggle
      .first()
      .click()
      .catch(() => {});
    await win.waitForTimeout(700);
    await win.screenshot({ path: path.join(OUT, '95-collapsed.png') });
    await toggle
      .first()
      .click()
      .catch(() => {});
    await win.waitForTimeout(700);
    chrome.toggle = 'collapsed and reopened';
  }
  // close all tabs one by one
  let closed = 0;
  for (let i = 0; i < 30; i++) {
    const close = panel
      .locator('[role="tab"] [aria-label*="Close" i], [role="tab"] button')
      .first();
    if ((await close.count()) === 0) break;
    await close.click().catch(() => {});
    await win.waitForTimeout(150);
    closed += 1;
  }
  chrome.closed = closed;
  chrome.afterClose = await state().catch(() => null);
  await win.screenshot({ path: path.join(OUT, '96-all-closed.png') });
  findings.push({ step: 'chrome', chrome });
  say(`chrome: ${JSON.stringify(chrome)}`);
} finally {
  writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(findings, null, 1));
  writeFileSync(path.join(OUT, 'console.txt'), consoleLines.join('\n'));
  await app.close().catch(() => {});
}
say('click assessment complete');
