/**
 * Screenshot probe for the CONNECTORS candidates — headless, throwaway home,
 * against the Vite dev server on :5312 (`npx vite --port 5312 --strictPort`
 * from apps/desktop; NB that command auto-launches its own Electron via
 * vite-plugin-electron, so run it with `PI_E2E=1 HOME=<throwaway>` too).
 *
 *   node src/candidates/connectors/shots.mjs current        # the shipping screen
 *   node src/candidates/connectors/shots.mjs <candidate-id> # one candidate, 6 themes + narrow
 *   node src/candidates/connectors/shots.mjs all            # every candidate
 *
 * Images land in src/candidates/connectors/shots/. The fixture home carries a
 * registry with installed / disabled / custom servers and one installed skill,
 * plus a mocked /Applications scan (Blender, Xcode, Docker, Chrome), so every
 * state a candidate has to draw is actually on screen.
 */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, probeHome } from '../../../tests/e2e/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../../..');
const SHOTS = path.join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });

const CANDIDATES = ['shelf', 'ledger', 'reach'];
const THEMES = [
  ['bobble', 'light'],
  ['bobble', 'dark'],
  ['claude', 'light'],
  ['claude', 'dark'],
  ['codex', 'light'],
  ['codex', 'dark'],
];

const mode = process.argv[2] ?? 'all';
const only = process.argv.includes('--only-bobble');

/** A home with the states a candidate must render. */
function fixtureHome(name) {
  const home = probeHome(name);
  const desktop = path.join(home, '.pi', 'desktop');
  mkdirSync(desktop, { recursive: true });
  writeFileSync(
    path.join(desktop, 'mcp-connectors.json'),
    JSON.stringify(
      {
        version: 1,
        mode: 'lite',
        servers: [
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
        ],
      },
      null,
      2,
    ),
  );
  // One installed skill, so the installed state is drawn.
  const skills = path.join(home, '.pi', 'agent', 'skills');
  mkdirSync(skills, { recursive: true });
  cpSync(
    path.join(APP_ROOT, 'resources', 'skills', 'code-review'),
    path.join(skills, 'code-review'),
    {
      recursive: true,
    },
  );
  // Mock /Applications: what "Recommended for you" is built from.
  const apps = path.join(home, 'apps-fixture');
  for (const a of ['Blender.app', 'Xcode.app', 'Docker.app', 'Google Chrome.app']) {
    mkdirSync(path.join(apps, a), { recursive: true });
  }
  return { home, apps };
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

async function launch(name, extraEnv, waitFor) {
  const { home, apps } = fixtureHome(name);
  return launchApp(name, {
    waitFor,
    timeout: 45_000,
    env: {
      HOME: home,
      VITE_DEV_SERVER_URL: 'http://localhost:5312',
      PI_CONNECTORS_APPS_DIR: apps,
      ...extraEnv,
    },
  });
}

async function shotAs(page, file) {
  await page.waitForTimeout(250);
  const buf = await page.screenshot();
  writeFileSync(path.join(SHOTS, file), buf);
  if (buf.length < 5000) throw new Error(`blank screenshot ${file}`);
  console.log(`  shot ${file}`);
}

async function currentScreen() {
  const { page, finish } = await launch('cand-connectors-current', {}, '.pd-composer-editor');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="connector-card-blender"]', { timeout: 15_000 });
  for (const [f, m] of THEMES.slice(0, 2)) {
    await setTheme(page, f, m);
    await shotAs(page, `current-plugins-${f}-${m}.png`);
  }
  await page.click('[data-testid="connector-card-github"] >> text=GitHub');
  await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 10_000 });
  await shotAs(page, 'current-detail-bobble-dark.png');
  await page.click('[data-testid="connector-detail-breadcrumb"]');
  await page.click('[data-testid="connectors-tab-skills"]');
  await page.waitForSelector('[data-testid="connectors-skills"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shotAs(page, 'current-skills-bobble-dark.png');
  await setTheme(page, 'bobble', 'light');
  await shotAs(page, 'current-skills-bobble-light.png');
  await finish();
}

async function candidate(id) {
  const { page, finish } = await launch(
    `cand-connectors-${id}`,
    { PI_DESKTOP_CANDIDATES: 'connectors', PI_DESKTOP_CANDIDATE_V: id },
    '[data-testid="candidate-shell"]',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(`[data-testid="cand-${id}"]`, { timeout: 20_000 });
  // Data arrives async; wait for a catalog item to be drawn.
  await page.waitForSelector('[data-testid^="cand-open-"]', { timeout: 20_000 });
  await page.waitForTimeout(500);
  for (const [f, m] of only ? THEMES.slice(0, 2) : THEMES) {
    await setTheme(page, f, m);
    await shotAs(page, `${id}-${f}-${m}.png`);
  }
  await setTheme(page, 'bobble', 'dark');
  // Detail: a connector that needs a key, then an installed one, then a skill.
  const details = [
    ['github', 'detail-github'],
    ['memory', 'detail-memory'],
    ['skill:code-review', 'detail-skill'],
  ];
  for (const [target, label] of details) {
    const sel = `[data-testid="cand-open-${target}"]`;
    if ((await page.$(sel)) === null) continue;
    await page.click(sel);
    await page.waitForTimeout(500);
    await shotAs(page, `${id}-${label}-bobble-dark.png`);
    if (label === 'detail-github') {
      await setTheme(page, 'bobble', 'light');
      await shotAs(page, `${id}-${label}-bobble-light.png`);
      await setTheme(page, 'bobble', 'dark');
    }
    const back = await page.$('[data-testid="cand-back"]');
    if (back !== null) await back.click();
    await page.waitForTimeout(250);
  }
  // Narrow window.
  await page.setViewportSize({ width: 900, height: 760 });
  await page.waitForTimeout(400);
  await shotAs(page, `${id}-narrow-bobble-dark.png`);
  await setTheme(page, 'bobble', 'light');
  await shotAs(page, `${id}-narrow-bobble-light.png`);
  await finish();
}

/**
 * The dev server is SHARED: another agent saving `electron/*.ts` or any file
 * Vite full-reloads on restarts the page under a probe mid-load, and the
 * launch dies waiting for the candidate shell. That is environmental, not a
 * finding, so a launch gets three tries before it counts as a failure.
 */
async function withRetry(run, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      lastError = error;
      console.error(`${label}: attempt ${attempt} failed: ${String(error).split('\n')[0]}`);
    }
  }
  throw lastError;
}

if (mode === 'current') await withRetry(currentScreen, 'current');
else if (mode === 'all') for (const id of CANDIDATES) await withRetry(() => candidate(id), id);
else await withRetry(() => candidate(mode), mode);
