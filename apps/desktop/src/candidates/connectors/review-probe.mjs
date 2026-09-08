/**
 * The design judge's own drive of BOTH Connectors surfaces — the shipping
 * screen (`src/connectors/`) and the Shelf+ candidate — headless, against the
 * renderer-only dev server on :5312, with the fixture home and MCP shims
 * shots.mjs uses (copied, not imported: shots.mjs runs on import).
 *
 *   npx vite --config src/candidates/connectors/vite.candidates.config.mjs   # from apps/desktop
 *   node src/candidates/connectors/review-probe.mjs shipping
 *   node src/candidates/connectors/review-probe.mjs candidate
 *   node src/candidates/connectors/review-probe.mjs fresh
 *
 * Frames land in shots/review/ (`ship-*`, `cand-*`), and every number a
 * frame cannot carry — time to a tool list, focus order, a hover's measured
 * lift, a layout shift, computed type sizes — lands in
 * shots/review/measurements-<mode>.json. DESIGN-REVIEW.md cites both.
 *
 * Nothing here is asserted; it is a camera and a ruler. A step that throws is
 * logged and the run goes on, because a review needs the other frames more
 * than it needs a clean exit.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, probeHome } from '../../../tests/e2e/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(HERE, 'shots', 'review');
const FIXTURE_SERVER = path.join(HERE, 'fixtures', 'mcp-fixture.mjs');
mkdirSync(OUT, { recursive: true });

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5312';
const GOOD_TOKEN = 'ghp_fixture_token_0000000000000000';
const mode = process.argv[2] ?? 'shipping';

// ───────────────────────────── fixture home (as shots.mjs) ─────────────────────────────

function fixtureHome(name, { fresh = false } = {}) {
  const home = probeHome(name);
  const desktop = path.join(home, '.pi', 'desktop');
  mkdirSync(desktop, { recursive: true });
  const servers = fresh
    ? []
    : [
        {
          id: 'memory',
          name: 'Memory',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          enabled: true,
        },
        {
          id: 'filesystem',
          name: 'Filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/user/Projects'],
          enabled: true,
        },
        {
          id: 'github',
          name: 'GitHub',
          command: 'npx',
          args: ['-y', '@github/github-mcp-server'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
          enabled: false,
        },
        { id: 'blender', name: 'Blender', command: 'uvx', args: ['blender-mcp'], enabled: true },
        {
          id: 'weather',
          name: 'Weather',
          command: 'node',
          args: ['/Users/user/tools/weather-mcp/index.js'],
          enabled: true,
        },
        {
          id: 'sequential-thinking',
          name: 'Sequential Thinking',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
          enabled: false,
        },
      ];
  writeFileSync(
    path.join(desktop, 'mcp-connectors.json'),
    JSON.stringify({ version: 1, mode: 'lite', servers }, null, 2),
  );
  if (!fresh) {
    const skills = path.join(home, '.pi', 'agent', 'skills');
    mkdirSync(skills, { recursive: true });
    cpSync(
      path.join(APP_ROOT, 'resources', 'skills', 'code-review'),
      path.join(skills, 'code-review'),
      { recursive: true },
    );
  }
  const apps = path.join(home, 'apps-fixture');
  for (const a of ['Blender.app', 'Xcode.app', 'Docker.app', 'Google Chrome.app']) {
    mkdirSync(path.join(apps, a), { recursive: true });
  }
  return { home, apps, bin: writeShims(home) };
}

function writeShims(home) {
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const node = process.execPath;
  const firstPackage = `pkg=""
for a in "$@"; do
  case "$a" in
    -*) ;;
    *) pkg="$a"; break ;;
  esac
done
exec "${node}" "${FIXTURE_SERVER}" "$pkg"
`;
  writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\n${firstPackage}`);
  writeFileSync(path.join(bin, 'uvx'), `#!/bin/sh\n${firstPackage}`);
  writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/sh
case "$1" in
  */weather-mcp/index.js) exec "${node}" "${FIXTURE_SERVER}" weather ;;
  */weather-two/index.js) exec "${node}" "${FIXTURE_SERVER}" weather ;;
  *) exec "${node}" "$@" ;;
esac
`,
  );
  for (const f of ['npx', 'uvx', 'node']) chmodSync(path.join(bin, f), 0o755);
  return bin;
}

let activeHome = null;
function fixtureControl(obj) {
  if (activeHome === null) throw new Error('fixtureControl outside withApp');
  const file = path.join(activeHome, 'mcp-fixture-control.json');
  if (obj === null) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify(obj));
}

function childPids() {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

async function reapChildren(name) {
  const alive = childPids();
  if (alive.length === 0) return;
  console.error(`${name}: ${alive.length} child process(es) outlived close; terminating`);
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 3000));
  for (const pid of childPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

async function withApp(name, extraEnv, waitFor, body, fixtureOpts = {}) {
  const { home, apps, bin } = fixtureHome(name, fixtureOpts);
  activeHome = home;
  const { app, page, finish } = await launchApp(name, {
    waitFor,
    timeout: 45_000,
    env: {
      HOME: home,
      VITE_DEV_SERVER_URL: DEV_URL,
      PI_CONNECTORS_APPS_DIR: apps,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
  const proc = app.process();
  try {
    await body(page);
  } finally {
    const closed = await Promise.race([
      finish().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    if (!closed) console.error(`${name}: close did not return within 20s`);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 3000));
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
    await reapChildren(name);
    activeHome = null;
  }
}

// ───────────────────────────── the camera and the ruler ─────────────────────────────

const measurements = [];
function note(key, value) {
  measurements.push({ key, value });
  console.log(`  · ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
function saveMeasurements(which) {
  writeFileSync(
    path.join(OUT, `measurements-${which}.json`),
    JSON.stringify(measurements, null, 2),
  );
}

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    const first = String(error).split('\n')[0];
    console.error(`  ✗ ${name}: ${first}`);
    measurements.push({ key: `skipped:${name}`, value: first });
  }
}

async function setTheme(page, flavor, modeName) {
  await page.evaluate(
    ([f, m]) => {
      document.documentElement.setAttribute('data-flavor', f);
      document.documentElement.setAttribute('data-mode', m);
    },
    [flavor, modeName],
  );
  await page.waitForTimeout(450);
}

async function parkMouse(page) {
  await page.mouse.move(2, 2);
}

async function shot(page, file, { keepMouse = false, settle = 250 } = {}) {
  if (!keepMouse) await parkMouse(page);
  await page.waitForTimeout(settle);
  const buf = await page.screenshot();
  writeFileSync(path.join(OUT, file), buf);
  if (buf.length < 5000) throw new Error(`blank screenshot ${file}`);
  console.log(`  shot ${file}`);
}

/** Pause every clock-driven animation at `t` ms, shoot, repeat, release. */
async function shotFrames(page, prefix, times) {
  for (const t of times) {
    await page.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        if (a.timeline !== null && !(a.timeline instanceof DocumentTimeline)) continue;
        a.pause();
        a.currentTime = ms;
      }
    }, t);
    await page.waitForTimeout(60);
    await shot(page, `${prefix}-${String(t).padStart(3, '0')}ms.png`, { settle: 40 });
  }
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.timeline !== null && !(a.timeline instanceof DocumentTimeline)) continue;
      a.play();
    }
  });
  await page.waitForTimeout(500);
}

async function scrollBy(page, selector, px) {
  return page.evaluate(
    ([sel, dy]) => {
      const root = document.querySelector(sel);
      if (root === null) return false;
      const all = [root, ...root.querySelectorAll('*')];
      for (const el of all) {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = getComputedStyle(el);
          if (/auto|scroll/.test(style.overflowY)) {
            el.scrollTop += dy;
            return true;
          }
        }
      }
      return false;
    },
    [selector, px],
  );
}

/** The tallest scroller under `selector`: how much page there is. */
async function scrollExtent(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (root === null) return null;
    let best = null;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const style = getComputedStyle(el);
      if (!/auto|scroll/.test(style.overflowY)) continue;
      if (best === null || el.scrollHeight > best.scrollHeight) {
        best = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }
    }
    return best;
  }, selector);
}

const activeDescriptor = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return 'null';
    const id = el.getAttribute('data-testid') ?? el.getAttribute('aria-label');
    if (id !== null) return id;
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${text !== '' ? `:"${text}"` : ''}`;
  });

async function tabWalk(page, count, shootWhen = {}, prefix = '') {
  const order = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(50);
    const id = await activeDescriptor(page);
    order.push(id);
    for (const [match, label] of Object.entries(shootWhen)) {
      if (id.includes(match) && shootWhen[match] !== null) {
        await shot(page, `${prefix}focus-${label}.png`, { settle: 100 });
        shootWhen[match] = null;
      }
    }
  }
  return order;
}

/** Computed metrics for a selector: box + the styles a judge reads. */
async function metrics(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      fontWeight: s.fontWeight,
      color: s.color,
      background: s.backgroundColor,
      outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`,
      boxShadow: s.boxShadow.slice(0, 80),
    };
  }, selector);
}

const registry = (page) =>
  page.evaluate(async () => {
    const { registry } = await window.piDesktop.invoke('connectors:list', {});
    return (registry?.servers ?? []).map((s) => ({ id: s.id, enabled: s.enabled, cmd: s.command }));
  });

// ═════════════════════════════ THE SHIPPING SCREEN ═════════════════════════════

function shipping() {
  return withApp('review-shipping', {}, '.pd-composer-editor', async (page) => {
    const P = 'ship-';
    await page.setViewportSize({ width: 1440, height: 900 });
    note(
      'theme on a fresh home',
      await page.evaluate(() => ({
        flavor: document.documentElement.getAttribute('data-flavor'),
        mode: document.documentElement.getAttribute('data-mode'),
      })),
    );

    // The screen's own entrance, from the sidebar.
    await step('entrance frames', async () => {
      await page.click('[data-testid="nav-connectors"]');
      await shotFrames(page, `${P}enter`, [0, 80, 160]);
    });
    await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="connector-card-blender"]', { timeout: 15_000 });
    await page.waitForTimeout(600);

    await step('list at rest', async () => {
      await setTheme(page, 'bobble', 'light');
      await shot(page, `${P}list-light.png`);
      await setTheme(page, 'bobble', 'dark');
      await shot(page, `${P}list-dark.png`);
      note(
        'list extent (content 1152)',
        await scrollExtent(page, '[data-testid="connectors-screen"]'),
      );
      note(
        'cards / preinstalled / official badges / add buttons',
        await page.evaluate(() => ({
          cards: document.querySelectorAll('[data-testid^="connector-card-"]').length,
          preinstalled: document.querySelectorAll('[data-testid^="connector-preinstalled-"]')
            .length,
          official: [...document.querySelectorAll('[data-testid^="connector-card-"] span')].filter(
            (s) => s.textContent === 'Official',
          ).length,
          firstAddY: Math.round(
            document.querySelector('[data-testid^="connector-add-"]')?.getBoundingClientRect().y ??
              -1,
          ),
          sections: [...document.querySelectorAll('[data-testid^="connectors-section-"]')].map(
            (s) => ({
              id: s.getAttribute('data-testid'),
              y: Math.round(s.getBoundingClientRect().y),
              n: s.querySelectorAll('[data-testid^="connector-card-"]').length,
            }),
          ),
        })),
      );
      note('title', await metrics(page, '[data-testid="connectors-screen"] h1'));
      note('section heading', await metrics(page, '[data-testid^="connectors-section-"] h2'));
      note('card name', await metrics(page, '[data-testid="connector-card-github"] .truncate'));
      note(
        'card description',
        await metrics(page, '[data-testid="connector-card-github"] .line-clamp-2'),
      );
      note(
        'card icon tile',
        await metrics(page, '[data-testid="connector-card-github"] .bg-bg-inset'),
      );
      note('card', await metrics(page, '[data-testid="connector-card-github"]'));
      note('mode hint', await metrics(page, '[data-testid="connectors-mode-hint"]'));
      note('search', await metrics(page, '[data-testid="connectors-search"]'));
    });

    await step('list scrolled', async () => {
      await scrollBy(page, '[data-testid="connectors-screen"]', 700);
      await page.waitForTimeout(300);
      await shot(page, `${P}list-scrolled-dark.png`);
      await scrollBy(page, '[data-testid="connectors-screen"]', 100000);
      await page.waitForTimeout(300);
      await shot(page, `${P}list-end-dark.png`);
      await scrollBy(page, '[data-testid="connectors-screen"]', -100000);
      await page.waitForTimeout(300);
    });

    await step('hover', async () => {
      const before = await metrics(page, '[data-testid="connector-card-git"]');
      await page.hover('[data-testid="connector-card-git"]');
      await page.waitForTimeout(300);
      const after = await metrics(page, '[data-testid="connector-card-git"]');
      note('card hover bg (dark)', { before: before.background, after: after.background });
      await shot(page, `${P}hover-card-dark.png`, { keepMouse: true });
      await page.hover('[data-testid="connector-add-git"]');
      await page.waitForTimeout(300);
      await shot(page, `${P}hover-plus-dark.png`, { keepMouse: true });
      await parkMouse(page);
      await setTheme(page, 'bobble', 'light');
      const lb = await metrics(page, '[data-testid="connector-card-git"]');
      await page.hover('[data-testid="connector-card-git"]');
      await page.waitForTimeout(300);
      const la = await metrics(page, '[data-testid="connector-card-git"]');
      note('card hover bg (light)', { before: lb.background, after: la.background });
      await shot(page, `${P}hover-card-light.png`, { keepMouse: true });
      await parkMouse(page);
      await setTheme(page, 'bobble', 'dark');
    });

    await step('tab order', async () => {
      await page.click('[data-testid="connectors-search"]');
      const order = await tabWalk(
        page,
        16,
        { 'connector-overflow-': 'overflow', 'connector-add-': 'plus', button: 'card-body' },
        P,
      );
      note('tab order from the search field', order);
      await page.keyboard.press('Escape');
      await page.mouse.click(700, 30);
      await parkMouse(page);
    });

    await step('overflow menu', async () => {
      await page.click('[data-testid="connector-overflow-github"]');
      await page.waitForTimeout(350);
      await shot(page, `${P}overflow-menu-dark.png`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    });

    await step('search', async () => {
      await page.fill('[data-testid="connectors-search"]', 'git');
      await page.waitForTimeout(300);
      await shot(page, `${P}search-git-dark.png`);
      await page.fill('[data-testid="connectors-search"]', 'zzzz');
      await page.waitForTimeout(300);
      await shot(page, `${P}search-empty-dark.png`);
      await page.fill('[data-testid="connectors-search"]', '');
      await page.waitForTimeout(300);
    });

    await step('mode switch layout shift', async () => {
      const firstSection = '[data-testid^="connectors-section-"]';
      const before = await metrics(page, firstSection);
      await page.click('[data-testid="connectors-mcp-mode"] >> text=Native');
      await page.waitForTimeout(400);
      const after = await metrics(page, firstSection);
      note('first section y before/after Native', { before: before.y, after: after.y });
      await shot(page, `${P}mode-native-dark.png`);
      await page.click('[data-testid="connectors-mcp-mode"] >> text=Bash CLI');
      await page.waitForTimeout(400);
      const after2 = await metrics(page, firstSection);
      note('first section y on Bash CLI', after2.y);
      await page.click('[data-testid="connectors-mcp-mode"] >> text=Lite');
      await page.waitForTimeout(400);
    });

    const openDetail = async (id, name) => {
      await page.click(`[data-testid="connector-card-${id}"] >> text=${name}`);
      await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 10_000 });
    };
    const back = async () => {
      await page.click('[data-testid="connector-detail-breadcrumb"]');
      await page.waitForSelector(
        '[data-testid="connectors-screen"] [data-testid="connectors-search"]',
        {
          timeout: 10_000,
        },
      );
      await page.waitForTimeout(300);
    };
    const toolsText = () =>
      page.evaluate(() => {
        const d = document.querySelector('[data-testid="connector-detail"]');
        const h = [...(d?.querySelectorAll('h2') ?? [])].find((x) =>
          x.textContent?.startsWith('Tools'),
        );
        const sec = h?.parentElement;
        return (sec?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200);
      });

    await step('detail: github (installed, off, no key)', async () => {
      await openDetail('github', 'GitHub');
      await page.waitForTimeout(400);
      await shot(page, `${P}detail-github-dark.png`);
      await setTheme(page, 'bobble', 'light');
      await shot(page, `${P}detail-github-light.png`);
      await setTheme(page, 'bobble', 'dark');
      note('github detail: Tools text while off', await toolsText());
      note(
        'github detail: command block',
        await metrics(page, '[data-testid="connector-detail-command"]'),
      );
      // Turn it on: the fixture exits 1 on an empty token.
      await page.click('[data-testid="connector-detail-mcp-toggle"]');
      await page.waitForTimeout(2500);
      note('github detail: Tools text after turning on with no key', await toolsText());
      await shot(page, `${P}detail-github-on-failed-dark.png`);
      await page.click('[data-testid="connector-detail-mcp-toggle"]');
      await page.waitForTimeout(500);
      await back();
    });

    await step('detail: memory (on) — time to list, twice', async () => {
      let t0 = Date.now();
      await page.click('[data-testid="connector-card-memory"] >> text=Memory');
      await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 10_000 });
      await shot(page, `${P}detail-memory-loading-dark.png`, { settle: 0 });
      await page.waitForSelector('[data-testid="connector-detail-tools"]', { timeout: 20_000 });
      note('memory: ms from click to tool list (first open)', Date.now() - t0);
      await page.waitForTimeout(300);
      await shot(page, `${P}detail-memory-tools-dark.png`);
      await setTheme(page, 'bobble', 'light');
      await shot(page, `${P}detail-memory-tools-light.png`);
      await setTheme(page, 'bobble', 'dark');
      note(
        'memory tool row name',
        await metrics(page, '[data-testid="connector-detail-tools"] code'),
      );
      note('memory tool row desc', await metrics(page, '[data-testid="connector-detail-tools"] p'));
      await back();
      t0 = Date.now();
      await page.click('[data-testid="connector-card-memory"] >> text=Memory');
      await page.waitForSelector('[data-testid="connector-detail-tools"]', { timeout: 20_000 });
      note('memory: ms from click to tool list (second open)', Date.now() - t0);
      await back();
    });

    await step('detail: custom / builtin / available', async () => {
      await openDetail('weather', 'Weather');
      await page.waitForTimeout(1500);
      await shot(page, `${P}detail-custom-dark.png`);
      await back();
      await openDetail('video-editing', 'Video editing');
      await page.waitForTimeout(400);
      await shot(page, `${P}detail-builtin-dark.png`);
      await back();
      await openDetail('time', 'Time');
      await page.waitForTimeout(400);
      await shot(page, `${P}detail-available-dark.png`);
      await page.click('[data-testid="connector-detail-connect"]');
      await page.waitForTimeout(2500);
      await shot(page, `${P}detail-time-connected-dark.png`);
      note('time detail: Tools text after Connect', await toolsText());
      // Remove: is there a confirm?
      await page.click('[data-testid="connector-detail-remove"]');
      await page.waitForTimeout(600);
      note(
        'after Remove: dialog present? detail present?',
        await page.evaluate(() => ({
          dialog: document.querySelector('[role="alertdialog"], .pd-dialog') !== null,
          detail: document.querySelector('[data-testid="connector-detail"]') !== null,
        })),
      );
      await shot(page, `${P}after-remove-dark.png`);
      note('registry after remove', await registry(page));
    });

    await step('connect a key-needing connector: permission dialog', async () => {
      await page.click('[data-testid="connector-add-slack"]');
      await page.waitForSelector('[data-testid="connect-permission-dialog"]', { timeout: 8000 });
      await page.waitForTimeout(400);
      note('permission dialog: focused element', await activeDescriptor(page));
      await shot(page, `${P}permission-dialog-dark.png`);
      await setTheme(page, 'bobble', 'light');
      await shot(page, `${P}permission-dialog-light.png`);
      await setTheme(page, 'bobble', 'dark');
      await page.click('[data-testid="connect-continue"]');
      await page.waitForTimeout(1500);
      await shot(page, `${P}after-connect-slack-dark.png`);
      note('registry after slack', await registry(page));
      await openDetail('slack', 'Slack');
      await page.waitForTimeout(400);
      await shot(page, `${P}detail-slack-needs-key-dark.png`);
      await back();
    });

    await step('add-server dialog', async () => {
      await page.click('[data-testid="connectors-add-server"]');
      await shotFrames(page, `${P}add-dialog-enter`, [0, 80, 160, 250]);
      await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
      note('add dialog: focused on open', await activeDescriptor(page));
      note('add dialog box', await metrics(page, '[data-testid="add-server-dialog"]'));
      note('add dialog title', await metrics(page, '[data-testid="add-server-dialog"] h2'));
      note('add dialog label', await metrics(page, 'label[for="add-server-name"]'));
      note('add dialog input', await metrics(page, '[data-testid="add-server-name"]'));
      note(
        'add dialog hint',
        await metrics(page, '[data-testid="add-server-dialog"] .text-footnote'),
      );
      note('add dialog submit', await metrics(page, '[data-testid="add-server-submit"]'));
      await setTheme(page, 'bobble', 'light');
      await shot(page, `${P}add-dialog-empty-light.png`);
      await setTheme(page, 'bobble', 'dark');
      await shot(page, `${P}add-dialog-empty-dark.png`);
      // Enter on the empty form; click the disabled button.
      await page.focus('[data-testid="add-server-name"]');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      note(
        'add dialog: still open after Enter on empty form / submit disabled',
        await page.evaluate(() => ({
          open: document.querySelector('[data-testid="add-server-dialog"]') !== null,
          disabled: document.querySelector('[data-testid="add-server-submit"]')?.disabled,
          errorText: document
            .querySelector('[data-testid="add-server-dialog"]')
            ?.textContent?.includes('required'),
        })),
      );
      await page.click('[data-testid="add-server-submit"]', { force: true }).catch(() => undefined);
      await page.waitForTimeout(200);
      await shot(page, `${P}add-dialog-submit-empty-dark.png`);
      // Tab order inside the dialog.
      await page.focus('[data-testid="add-server-name"]');
      const order = await tabWalk(page, 9, {}, P);
      note('add dialog: tab order from Name', order);
      await page.focus('[data-testid="add-server-name"]');
      await shot(page, `${P}add-dialog-focus-name-dark.png`, { settle: 100 });
      // A README's JSON blob pasted where the eye lands.
      await page.fill(
        '[data-testid="add-server-name"]',
        '{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}}',
      );
      await page.waitForTimeout(200);
      await shot(page, `${P}add-dialog-pasted-json-dark.png`);
      // The honest fill.
      await page.fill('[data-testid="add-server-name"]', 'Weather Two');
      await page.fill('[data-testid="add-server-command"]', 'node');
      await page.fill('[data-testid="add-server-args"]', '/Users/user/tools/weather-two/index.js');
      await page.fill('[data-testid="add-server-env"]', 'WEATHER_KEY=abc123');
      await page.waitForTimeout(200);
      await shot(page, `${P}add-dialog-filled-dark.png`);
      await setTheme(page, 'bobble', 'light');
      await shot(page, `${P}add-dialog-filled-light.png`);
      await setTheme(page, 'bobble', 'dark');
      // Enter in a field: does it submit?
      await page.focus('[data-testid="add-server-args"]');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const stillOpen = await page.evaluate(
        () => document.querySelector('[data-testid="add-server-dialog"]') !== null,
      );
      note('add dialog: Enter in a filled field submits?', !stillOpen);
      if (stillOpen) await page.click('[data-testid="add-server-submit"]');
      await page.waitForTimeout(300);
      note('add dialog: focused after close', await activeDescriptor(page));
      await page.waitForTimeout(1200);
      await shot(page, `${P}added-row-dark.png`);
      note(
        'added card position',
        await page.evaluate(() => {
          const c = document.querySelector('[data-testid="connector-card-weather-two"]');
          return c === null
            ? null
            : {
                y: Math.round(c.getBoundingClientRect().y),
                section: c
                  .closest('[data-testid^="connectors-section-"]')
                  ?.getAttribute('data-testid'),
                badge: c.textContent?.includes('Installed'),
              };
        }),
      );
      note('registry after add', await registry(page));
      // Its detail: does it list tools?
      await page.click('[data-testid="connector-card-weather-two"] >> text=Weather Two');
      await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 10_000 });
      await page.waitForTimeout(2500);
      await shot(page, `${P}detail-added-dark.png`);
      note('added detail: Tools text', await toolsText());
      await back();
      // A duplicate name: overwrite or refuse?
      await page.click('[data-testid="connectors-add-server"]');
      await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
      await page.fill('[data-testid="add-server-name"]', 'weather');
      await page.fill('[data-testid="add-server-command"]', 'python3');
      await page.click('[data-testid="add-server-submit"]');
      await page.waitForTimeout(1200);
      note('registry after adding a duplicate id "weather"', await registry(page));
      await shot(page, `${P}after-duplicate-dark.png`);
      // Escape closes?
      await page.click('[data-testid="connectors-add-server"]');
      await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      note(
        'add dialog: Escape closes',
        await page.evaluate(
          () => document.querySelector('[data-testid="add-server-dialog"]') === null,
        ),
      );
      note('add dialog: focused after Escape', await activeDescriptor(page));
    });

    await step('skills', async () => {
      await page.click('[data-testid="connectors-tab-skills"]');
      await page.waitForSelector('[data-testid="connectors-skills"]', { timeout: 10_000 });
      await page.waitForTimeout(500);
      await setTheme(page, 'bobble', 'light');
      await shot(page, `${P}skills-light.png`);
      await setTheme(page, 'bobble', 'dark');
      await shot(page, `${P}skills-dark.png`);
      note('skill row', await metrics(page, '[data-testid="skill-card-code-review"]'));
      await page.click('[data-testid="skill-card-code-review"] >> text=Code review');
      await page.waitForSelector('[data-testid="skill-detail"]', { timeout: 10_000 });
      await page.waitForTimeout(600);
      await shot(page, `${P}skill-detail-dark.png`);
      await scrollBy(page, '[data-testid="connectors-screen"]', 600);
      await page.waitForTimeout(300);
      await shot(page, `${P}skill-detail-scrolled-dark.png`);
      await page.click('[data-testid="skill-detail-back"]');
      await page.waitForTimeout(400);
      await page.click('[data-testid="connectors-tab-plugins"]');
      await page.waitForTimeout(400);
    });

    await step('widths', async () => {
      const grid = () =>
        page.evaluate(() => {
          const g = document.querySelector('[data-testid^="connectors-section-"] .grid');
          const card = document.querySelector('[data-testid^="connector-card-"]');
          return {
            columns: g === null ? null : getComputedStyle(g).gridTemplateColumns.split(' ').length,
            cardW: card === null ? null : Math.round(card.getBoundingClientRect().width),
            content: Math.round(
              document.querySelector('[data-testid="connectors-screen"]')?.getBoundingClientRect()
                .width ?? 0,
            ),
          };
        });
      await page.setViewportSize({ width: 1188, height: 760 });
      await page.waitForTimeout(500);
      note('at a 1188 window (900 content)', await grid());
      await shot(page, `${P}w1188-dark.png`);
      await page.setViewportSize({ width: 928, height: 760 });
      await page.waitForTimeout(500);
      note('at a 928 window (640 content)', await grid());
      await shot(page, `${P}w928-dark.png`);
      await page.setViewportSize({ width: 800, height: 700 });
      await page.waitForTimeout(500);
      note('at an 800 window (512 content)', await grid());
      await shot(page, `${P}w800-dark.png`);
      await page.click('[data-testid="connectors-add-server"]');
      await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
      await page.waitForTimeout(400);
      await shot(page, `${P}w800-dialog-dark.png`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(500);
    });

    await step('a server that stops answering', async () => {
      fixtureControl({ fail: ['@modelcontextprotocol/server-memory'] });
      await page.click('[data-testid="connector-card-memory"] >> text=Memory');
      await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 10_000 });
      await page.waitForTimeout(3000);
      note('memory detail while the server exits before the handshake', await toolsText());
      await shot(page, `${P}detail-memory-failing-dark.png`);
      await setTheme(page, 'bobble', 'light');
      await shot(page, `${P}detail-memory-failing-light.png`);
      await setTheme(page, 'bobble', 'dark');
      fixtureControl(null);
      await back();
      await shot(page, `${P}list-with-failing-dark.png`);
    });

    saveMeasurements('shipping');
  });
}

// ═════════════════════════════ THE CANDIDATE (Shelf+) ═════════════════════════════

function candidate() {
  return withApp(
    'review-candidate',
    { PI_DESKTOP_CANDIDATES: 'connectors', PI_DESKTOP_CANDIDATE_V: 'shelf-plus' },
    '[data-testid="candidate-shell"]',
    async (page) => {
      const P = 'cand-';
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForSelector('[data-testid="cand-shelf-plus"]', { timeout: 20_000 });
      await page.waitForSelector('[data-testid^="cand-open-"]', { timeout: 20_000 });
      await page.waitForTimeout(2000); // the warm
      const listTop = () => scrollBy(page, '[data-testid="cand-list"]', -100000);

      await step('list at rest', async () => {
        await setTheme(page, 'bobble', 'light');
        await shot(page, `${P}list-1440-light.png`);
        await page.setViewportSize({ width: 1152, height: 900 });
        await page.waitForTimeout(500);
        await shot(page, `${P}list-1152-light.png`);
        await setTheme(page, 'bobble', 'dark');
        await shot(page, `${P}list-1152-dark.png`);
        note('list extent (1152)', await scrollExtent(page, '[data-testid="cand-list"]'));
        note(
          'pane mode at 1152',
          await page.getAttribute('[data-testid="cand-shelf-plus"]', 'data-pane-mode'),
        );
        note('title', await metrics(page, '[data-testid="cand-shelf-plus"] h1'));
        note('subtitle', await metrics(page, '[data-testid="cand-shelf-plus"] h1 + p'));
        note('section heading', await metrics(page, '[data-testid="cand-section-tools"] h2'));
        note('card name', await metrics(page, '[data-testid="cand-card-github"] .truncate'));
        note(
          'card description',
          await metrics(page, '[data-testid="cand-card-github"] .line-clamp-2'),
        );
        note('card', await metrics(page, '[data-testid="cand-card-github"]'));
        note('pane heading', await metrics(page, '[data-testid="cand-pane"] h2'));
        note('pane summary', await metrics(page, '[data-testid="cand-summary"]'));
        note(
          'pane row name',
          await metrics(page, '[data-testid="cand-pane-open-filesystem"] .truncate'),
        );
        note('search', await metrics(page, '[data-testid="cand-search"]'));
        note('pill (pressed)', await metrics(page, '[data-testid="cand-filter-all"]'));
        note(
          'switch (checked) colour',
          await metrics(page, '[data-testid="cand-toggle-filesystem"]'),
        );
        note(
          'setup pill',
          await metrics(page, '[data-testid="cand-card-github"] [data-testid="cand-setup-github"]'),
        );
        note('warning dot', await metrics(page, '.cand-dot[data-state="needs-setup"]'));
        note(
          'list scrollbar',
          await page.evaluate(() => {
            const list = document.querySelector('[data-testid="cand-list"]');
            const v = [...(list?.querySelectorAll('*') ?? [])].find((el) =>
              /auto|scroll/.test(getComputedStyle(el).overflowY),
            );
            if (!v) return null;
            const s = getComputedStyle(v);
            return {
              scrollbarGutter: s.scrollbarGutter,
              scrollbarWidth: s.scrollbarWidth,
              className: v.className.slice(0, 60),
            };
          }),
        );
      });

      await step('hover', async () => {
        await setTheme(page, 'bobble', 'light');
        const b = await metrics(page, '[data-testid="cand-card-git"]');
        await page.hover('[data-testid="cand-card-git"]');
        await page.waitForTimeout(300);
        const a = await metrics(page, '[data-testid="cand-card-git"]');
        note('card hover (light) bg/shadow', {
          before: [b.background, b.boxShadow],
          after: [a.background, a.boxShadow],
        });
        await shot(page, `${P}hover-card-light.png`, { keepMouse: true });
        await page.hover('[data-testid="cand-pane-open-filesystem"]');
        await page.waitForTimeout(300);
        await shot(page, `${P}hover-row-light.png`, { keepMouse: true });
        await page.hover('[data-testid="cand-open-chrome-devtools"]');
        await page.waitForTimeout(300);
        await shot(page, `${P}hover-chip-light.png`, { keepMouse: true });
        await parkMouse(page);
      });

      await step('tab order + keyboard', async () => {
        await listTop();
        await page.click('[data-testid="cand-search"]');
        const order = await tabWalk(
          page,
          18,
          { 'cand-open-github': 'card', 'cand-setup-github': 'setup', 'cand-toggle-': 'switch' },
          P,
        );
        note('tab order from the search field', order);
        // Enter on a focused card opens; Escape?
        await page.click('[data-testid="cand-search"]');
        for (let i = 0; i < 30; i += 1) {
          await page.keyboard.press('Tab');
          if ((await activeDescriptor(page)) === 'cand-open-github') break;
        }
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        note(
          'Enter on a focused card opens its detail',
          await page.evaluate(() => document.querySelector('[data-testid="cand-status"]') !== null),
        );
        note('focused after Enter', await activeDescriptor(page));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        note(
          'Escape closes the detail (pinned)',
          await page.evaluate(() => document.querySelector('[data-testid="cand-status"]') === null),
        );
        // A second click on the open card closes it (open() toggles).
        await page.click('[data-testid="cand-open-memory"]');
        await page.waitForTimeout(400);
        await page.click('[data-testid="cand-open-memory"]');
        await page.waitForTimeout(400);
        note(
          'clicking an open card again closes its detail',
          await page.evaluate(() => document.querySelector('[data-testid="cand-status"]') === null),
        );
        await page.mouse.click(700, 30);
        await parkMouse(page);
        await listTop();
      });

      await step('setup flow: bad key, ledger, change key, list', async () => {
        await page.click('[data-testid="cand-open-github"]');
        await page.waitForSelector('[data-testid="cand-setup"]', { timeout: 15_000 });
        await page.waitForTimeout(400);
        await shot(page, `${P}detail-github-setup-light.png`);
        await page.fill('[data-testid="cand-field-GITHUB_PERSONAL_ACCESS_TOKEN"]', 'bad-token');
        await page.waitForTimeout(200);
        await shot(page, `${P}setup-filled-light.png`);
        let t0 = Date.now();
        await page.click('[data-testid="cand-setup-save"]');
        await page.waitForSelector('[data-testid="cand-tools-error"]', { timeout: 15_000 });
        note('bad key: ms from Save to the error', Date.now() - t0);
        await page.waitForTimeout(300);
        await shot(page, `${P}setup-bad-key-light.png`);
        await setTheme(page, 'bobble', 'dark');
        await shot(page, `${P}setup-bad-key-dark.png`);
        await setTheme(page, 'bobble', 'light');
        note('bad key: error text', await page.textContent('[data-testid="cand-tools-error"]'));
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(400);
        await shot(page, `${P}ledger-bad-key-light.png`);
        await page.click('[data-testid="cand-pane"] [data-testid="cand-setup-github"]');
        await page.waitForSelector('[data-testid="cand-setup-cancel"]', { timeout: 15_000 });
        await shot(page, `${P}setup-change-key-light.png`);
        await page.fill('[data-testid="cand-field-GITHUB_PERSONAL_ACCESS_TOKEN"]', GOOD_TOKEN);
        t0 = Date.now();
        await page.click('[data-testid="cand-setup-save"]');
        await page.waitForSelector('[data-testid="cand-tools-list"]', { timeout: 15_000 });
        note('good key: ms from Save to the tool list', Date.now() - t0);
        await page.waitForTimeout(400);
        await shot(page, `${P}detail-github-tools-light.png`);
        await setTheme(page, 'bobble', 'dark');
        await shot(page, `${P}detail-github-tools-dark.png`);
        await setTheme(page, 'bobble', 'light');
        note(
          'tool row name',
          await metrics(page, '[data-testid="cand-tools-list"] .cand-tool span'),
        );
        note('tool row id', await metrics(page, '[data-testid="cand-tools-list"] .cand-tool code'));
        note('tool row desc', await metrics(page, '[data-testid="cand-tools-list"] .cand-tool p'));
        await scrollBy(page, '[data-testid="cand-pane"]', 100000);
        await page.waitForTimeout(350);
        await shot(page, `${P}detail-github-end-light.png`);
        await scrollBy(page, '[data-testid="cand-pane"]', -100000);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(300);
      });

      await step('detail: memory (cached) timing + swap frames', async () => {
        const t0 = Date.now();
        await page.click('[data-testid="cand-open-memory"]');
        await page.waitForSelector('[data-testid="cand-tools-list"]', { timeout: 15_000 });
        note('memory: ms from click to tool list', Date.now() - t0);
        await page.waitForTimeout(400);
        await shot(page, `${P}detail-memory-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(400);
        await page.click('[data-testid="cand-open-memory"]');
        await shotFrames(page, `${P}swap`, [0, 60, 120, 200]);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(400);
      });

      await step('detail: custom / builtin / skill / available', async () => {
        await page.click('[data-testid="cand-open-custom:weather"]');
        await page.waitForTimeout(600);
        await shot(page, `${P}detail-custom-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(300);
        await page.click('[data-testid="cand-open-video-editing"]');
        await page.waitForTimeout(600);
        await shot(page, `${P}detail-builtin-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(300);
        await page.click('[data-testid="cand-open-skill:code-review"]');
        await page.waitForSelector('[data-testid="cand-skill-body"]', { timeout: 15_000 });
        await page.waitForTimeout(400);
        await shot(page, `${P}detail-skill-light.png`);
        await scrollBy(page, '[data-testid="cand-pane"]', 400);
        await page.waitForTimeout(350);
        await shot(page, `${P}detail-skill-scrolled-light.png`);
        await scrollBy(page, '[data-testid="cand-pane"]', -100000);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(300);
        await page.click('[data-testid="cand-open-time"]');
        await page.waitForTimeout(500);
        await shot(page, `${P}detail-available-light.png`);
        const t0 = Date.now();
        await page.click('[data-testid="cand-pane"] [data-testid="cand-add-time"]');
        await page
          .waitForSelector('[data-testid="cand-tools-list"]', { timeout: 15_000 })
          .catch(() => undefined);
        note('time: ms from Add to Bobble to a tool list (or timeout)', Date.now() - t0);
        await page.waitForTimeout(500);
        await shot(page, `${P}detail-time-added-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(300);
        await listTop();
      });

      await step('the add-server dialog in the candidate', async () => {
        await page.click('[data-testid="cand-add-server"]');
        await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
        await page.waitForTimeout(400);
        note('candidate add dialog: focused on open', await activeDescriptor(page));
        await shot(page, `${P}add-dialog-light.png`);
        await setTheme(page, 'bobble', 'dark');
        await shot(page, `${P}add-dialog-dark.png`);
        await setTheme(page, 'bobble', 'light');
        await page.fill('[data-testid="add-server-name"]', 'Weather Two');
        await page.fill('[data-testid="add-server-command"]', 'node');
        await page.fill(
          '[data-testid="add-server-args"]',
          '/Users/user/tools/weather-two/index.js',
        );
        const t0 = Date.now();
        await page.click('[data-testid="add-server-submit"]');
        await page.waitForTimeout(300);
        note('candidate add dialog: focused after close', await activeDescriptor(page));
        await page.waitForSelector('[data-testid="cand-card-custom:weather-two"]', {
          timeout: 10_000,
        });
        note('added: ms until its card exists', Date.now() - t0);
        await page.waitForTimeout(1500);
        await shot(page, `${P}added-light.png`);
        note(
          'added card position / selected / in ledger',
          await page.evaluate(() => {
            const c = document.querySelector('[data-testid="cand-card-custom:weather-two"]');
            const row = document.querySelector('[data-testid="cand-pane-open-custom:weather-two"]');
            return {
              y: c === null ? null : Math.round(c.getBoundingClientRect().y),
              selected: c?.getAttribute('data-selected'),
              inLedger: row !== null,
              ledgerLine: row?.textContent?.replace(/\s+/g, ' ').slice(0, 80),
            };
          }),
        );
        await page.click('[data-testid="cand-open-custom:weather-two"]');
        await page.waitForTimeout(800);
        await shot(page, `${P}detail-added-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(300);
      });

      await step('not responding', async () => {
        fixtureControl({ fail: ['blender-mcp'] });
        await page.click('[data-testid="cand-open-blender"]');
        await page.waitForSelector('[data-testid="cand-tools-refresh"]', { timeout: 15_000 });
        await page.click('[data-testid="cand-tools-refresh"]');
        await page.waitForSelector('[data-testid="cand-tools-error"]', { timeout: 15_000 });
        await page.waitForTimeout(300);
        await shot(page, `${P}not-responding-detail-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(400);
        await shot(page, `${P}not-responding-ledger-light.png`);
        await setTheme(page, 'bobble', 'dark');
        await shot(page, `${P}not-responding-ledger-dark.png`);
        await setTheme(page, 'bobble', 'light');
        fixtureControl(null);
        await page.click('[data-testid="cand-pane"] [data-testid="cand-retry-blender"]');
        await page.waitForFunction(
          () => document.querySelector('[data-testid="cand-tools-error"]') === null,
          { timeout: 15_000 },
        );
        await page.waitForTimeout(400);
        await shot(page, `${P}not-responding-recovered-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(300);
      });

      await step('off from the card; the ledger re-sorts', async () => {
        await page.click('[data-testid="cand-card-memory"] [data-testid="cand-toggle-memory"]');
        await shotFrames(page, `${P}row-moves`, [0, 100]);
        await page.waitForTimeout(500);
        await shot(page, `${P}ledger-off-light.png`);
        await page.click('[data-testid="cand-open-memory"]');
        await page.waitForTimeout(500);
        await shot(page, `${P}detail-memory-off-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(300);
        await page.click('[data-testid="cand-card-memory"] [data-testid="cand-toggle-memory"]');
        await page.waitForTimeout(700);
      });

      await step('filters, search, show all', async () => {
        await page.click('[data-testid="cand-filter-setup"]');
        await page.waitForTimeout(350);
        await shot(page, `${P}filter-setup-light.png`);
        await page.click('[data-testid="cand-filter-on"]');
        await page.waitForTimeout(350);
        await shot(page, `${P}filter-on-light.png`);
        await page.click('[data-testid="cand-filter-all"]');
        await page.fill('[data-testid="cand-search"]', 'zzzz');
        await page.waitForTimeout(300);
        await shot(page, `${P}empty-light.png`);
        await page.fill('[data-testid="cand-search"]', 'Developer tools');
        await page.waitForTimeout(300);
        await shot(page, `${P}search-category-light.png`);
        await page.fill('[data-testid="cand-search"]', '');
        await page.waitForTimeout(300);
        await listTop();
        await page.click('[data-testid="cand-show-all"]');
        await page.waitForTimeout(350);
        await shot(page, `${P}expanded-light.png`);
        await page.click('[data-testid="cand-show-fewer"]');
        await page.waitForTimeout(250);
        await listTop();
      });

      await step('engine mode in the pane footer', async () => {
        const before = await metrics(page, '[data-testid="cand-pane"] [data-testid="cand-mode"]');
        await page.click('[data-testid="cand-pane"] [data-testid="cand-mode"] >> text=Native');
        await page.waitForTimeout(400);
        const after = await metrics(page, '[data-testid="cand-pane"] [data-testid="cand-mode"]');
        note('pane mode control y before/after Native', { before: before?.y, after: after?.y });
        await shot(page, `${P}mode-native-light.png`);
        await page.click('[data-testid="cand-pane"] [data-testid="cand-mode"] >> text=Lite');
        await page.waitForTimeout(400);
      });

      await step('builtins group', async () => {
        await page.click('[data-testid="cand-builtins-toggle"]');
        await shotFrames(page, `${P}builtins`, [0, 120, 250]);
        await scrollBy(page, '[data-testid="cand-pane"]', 100000);
        await page.waitForTimeout(350);
        await shot(page, `${P}builtins-open-light.png`);
        await scrollBy(page, '[data-testid="cand-pane"]', -100000);
        await page.click('[data-testid="cand-builtins-toggle"]');
        await page.waitForTimeout(400);
      });

      await step('widths with a detail open', async () => {
        await page.click('[data-testid="cand-open-github"]');
        await page.waitForTimeout(500);
        await page.setViewportSize({ width: 1105, height: 860 });
        await page.waitForTimeout(500);
        await shot(page, `${P}w1105-detail-light.png`);
        await page.setViewportSize({ width: 1103, height: 860 });
        await page.waitForTimeout(500);
        await shot(page, `${P}w1103-detail-light.png`);
        note(
          'pane mode at 1103',
          await page.getAttribute('[data-testid="cand-shelf-plus"]', 'data-pane-mode'),
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        note(
          'Escape closes the overlay sheet',
          await page.evaluate(() => document.querySelector('[data-testid="cand-status"]') === null),
        );
        await page.click('[data-testid="cand-back"]').catch(() => undefined);
        await page.waitForTimeout(400);
        await page.setViewportSize({ width: 900, height: 760 });
        await page.waitForTimeout(500);
        await listTop();
        await shot(page, `${P}w900-light.png`);
        await page.click('[data-testid="cand-open-github"]');
        await shotFrames(page, `${P}sheet-w900`, [0, 80, 160, 250]);
        await shot(page, `${P}w900-detail-light.png`);
        await setTheme(page, 'bobble', 'dark');
        await shot(page, `${P}w900-detail-dark.png`);
        await setTheme(page, 'bobble', 'light');
        // The scrim closes it?
        await page.mouse.click(120, 500);
        await page.waitForTimeout(400);
        note(
          'clicking the scrim closes the sheet',
          await page.evaluate(() => document.querySelector('[data-testid="cand-status"]') === null),
        );
        await page.click('[data-testid="cand-back"]').catch(() => undefined);
        await page.setViewportSize({ width: 640, height: 760 });
        await page.waitForTimeout(500);
        await listTop();
        await shot(page, `${P}w640-light.png`);
        await page.click('[data-testid="cand-open-github"]');
        await page.waitForTimeout(500);
        await shot(page, `${P}w640-detail-light.png`);
        await page.click('[data-testid="cand-back"]');
        await page.waitForTimeout(400);
        await page.setViewportSize({ width: 1152, height: 900 });
        await page.waitForTimeout(500);
      });

      saveMeasurements('candidate');
    },
  );
}

function fresh() {
  return withApp(
    'review-fresh',
    { PI_DESKTOP_CANDIDATES: 'connectors', PI_DESKTOP_CANDIDATE_V: 'shelf-plus' },
    '[data-testid="candidate-shell"]',
    async (page) => {
      await page.setViewportSize({ width: 1152, height: 900 });
      await page.waitForSelector('[data-testid="cand-pane-empty"]', { timeout: 20_000 });
      await page.waitForTimeout(800);
      await setTheme(page, 'bobble', 'light');
      await shot(page, 'cand-fresh-1152-light.png');
      await setTheme(page, 'bobble', 'dark');
      await shot(page, 'cand-fresh-1152-dark.png');
      await setTheme(page, 'bobble', 'light');
      await page.setViewportSize({ width: 900, height: 760 });
      await page.waitForTimeout(500);
      await shot(page, 'cand-fresh-w900-light.png');
      saveMeasurements('fresh');
    },
    { fresh: true },
  );
}

function shippingFresh() {
  return withApp(
    'review-shipping-fresh',
    {},
    '.pd-composer-editor',
    async (page) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.click('[data-testid="nav-connectors"]');
      await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 15_000 });
      await page.waitForSelector('[data-testid="connector-card-blender"]', { timeout: 15_000 });
      await page.waitForTimeout(600);
      await setTheme(page, 'bobble', 'light');
      await shot(page, 'ship-fresh-light.png');
      await setTheme(page, 'bobble', 'dark');
      await shot(page, 'ship-fresh-dark.png');
      saveMeasurements('shipping-fresh');
    },
    { fresh: true },
  );
}

/**
 * The steps the first shipping drive lost to a timeout — which was itself a
 * finding: a click on a hand-added server's card never opens a detail.
 */
function shipping2() {
  return withApp('review-shipping2', {}, '.pd-composer-editor', async (page) => {
    const P = 'ship-';
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('[data-testid="nav-connectors"]');
    await page.waitForSelector('[data-testid="connector-card-blender"]', { timeout: 15_000 });
    await page.waitForTimeout(600);
    await setTheme(page, 'bobble', 'dark');
    const detailOpen = () =>
      page.evaluate(() => document.querySelector('[data-testid="connector-detail"]') !== null);
    const back = async () => {
      await page.click('[data-testid="connector-detail-breadcrumb"]');
      await page.waitForTimeout(400);
    };

    await step('a hand-added card is a dead click', async () => {
      await page.click('[data-testid="connector-card-weather"] >> text=Weather');
      await page.waitForTimeout(1200);
      note('custom card: detail opened after clicking its body', await detailOpen());
      await shot(page, `${P}click-custom-card-dark.png`);
      await page.click('[data-testid="connector-overflow-weather"]');
      await page.waitForTimeout(300);
      await page.click('text=View details');
      await page.waitForTimeout(1200);
      note('custom card: detail opened after "View details"', await detailOpen());
      // A catalog card, for contrast.
      await page.click('[data-testid="connector-card-memory"] >> text=Memory');
      await page.waitForTimeout(800);
      note('catalog card: detail opened after clicking its body', await detailOpen());
      await back();
    });

    await step('detail: builtin / available / connect / remove', async () => {
      await page.click('[data-testid="connector-card-video-editing"] >> text=Video editing');
      await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 10_000 });
      await page.waitForTimeout(400);
      await shot(page, `${P}detail-builtin-dark.png`);
      await back();
      await page.click('[data-testid="connector-card-time"] >> text=Time');
      await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 10_000 });
      await page.waitForTimeout(400);
      await shot(page, `${P}detail-available-dark.png`);
      await page.click('[data-testid="connector-detail-connect"]');
      await page.waitForTimeout(3000);
      await shot(page, `${P}detail-time-connected-dark.png`);
      note(
        'time detail after Connect: text',
        (await page.textContent('[data-testid="connector-detail"]'))
          ?.replace(/\s+/g, ' ')
          .slice(0, 260),
      );
      await page.click('[data-testid="connector-detail-remove"]');
      await page.waitForTimeout(700);
      note(
        'after Remove: confirm dialog? detail still open?',
        await page.evaluate(() => ({
          dialog: document.querySelector('[role="alertdialog"], .pd-dialog') !== null,
          detail: document.querySelector('[data-testid="connector-detail"]') !== null,
        })),
      );
      await shot(page, `${P}after-remove-dark.png`);
      note('registry after remove', await registry(page));
    });

    await step('keyboard on the list', async () => {
      await page.click('[data-testid="connectors-search"]');
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press('Tab');
        const d = await activeDescriptor(page);
        if (
          d.startsWith('button:"') &&
          !d.includes('Lite') &&
          !d.includes('Native') &&
          !d.includes('Bash')
        )
          break;
      }
      note('focused before Enter', await activeDescriptor(page));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      note('Enter on a focused card body opens its detail', await detailOpen());
      if (await detailOpen()) {
        note('focused after the detail opened', await activeDescriptor(page));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        note('Escape closes the detail', !(await detailOpen()));
        if (await detailOpen()) await back();
      }
    });

    await step('add dialog: duplicate id, Escape, Cancel, long name', async () => {
      await page.click('[data-testid="connectors-add-server"]');
      await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
      await page.fill('[data-testid="add-server-name"]', 'weather');
      await page.fill('[data-testid="add-server-command"]', 'python3');
      await page.click('[data-testid="add-server-submit"]');
      await page.waitForTimeout(1200);
      note(
        'registry after adding a duplicate id "weather" with a different command',
        await registry(page),
      );
      await shot(page, `${P}after-duplicate-dark.png`);
      await page.click('[data-testid="connectors-add-server"]');
      await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      note(
        'Escape closes the add dialog',
        await page.evaluate(
          () => document.querySelector('[data-testid="add-server-dialog"]') === null,
        ),
      );
      note('focused after Escape', await activeDescriptor(page));
      await page.click('[data-testid="connectors-add-server"]');
      await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
      await page.click('[data-testid="add-server-dialog"] >> text=Cancel');
      await page.waitForTimeout(500);
      note('focused after Cancel', await activeDescriptor(page));
      await page.click('[data-testid="connectors-add-server"]');
      await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
      await page.fill(
        '[data-testid="add-server-name"]',
        'A locally built weather server with a very long name that goes on',
      );
      await page.fill('[data-testid="add-server-command"]', 'node');
      await page.click('[data-testid="add-server-submit"]');
      await page.waitForTimeout(1200);
      await shot(page, `${P}added-long-name-dark.png`);
    });

    saveMeasurements('shipping2');
  });
}

if (mode === 'shipping') await shipping();
else if (mode === 'shipping2') await shipping2();
else if (mode === 'candidate') await candidate();
else if (mode === 'fresh') {
  await fresh();
  await shippingFresh();
} else throw new Error(`unknown mode ${mode}`);
