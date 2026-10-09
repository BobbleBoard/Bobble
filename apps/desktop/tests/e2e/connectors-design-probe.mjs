/**
 * The Connectors screen, driven and photographed — headless, against the BUILT
 * app, with the fixture home and MCP shims the design review used (a fixture
 * MCP server answers for `npx` / `uvx` / `node`, so the app's own
 * `connectors:tools` handler spawns the real command lines from the registry
 * and gets a deterministic, instant answer — or a deterministic failure).
 *
 *   pnpm build && node tests/e2e/connectors-design-probe.mjs
 *
 * Frames land in src/connectors/shots/ and the numbers a frame cannot carry —
 * the dialog's geometry, focus after close, the registry after each write —
 * in shots/measurements.txt. Every check is also an assertion: a state that
 * does not render the way the design says fails the probe.
 *
 * The shape is the reference's (a lifted layout): title, one line, a compact
 * search; an Installed strip of marks; sections of rows two to a line with one
 * control each; the detail in the list's place. So the probe asserts the
 * absences too — no filter pills, no side pane, no card fills — and then every
 * state the reference never had to draw: a key card, a failure in the server's
 * own words, a row menu that leads with the remedy.
 *
 * Content widths: the screen lives beside a 288px sidebar, so a 1440 window is
 * 1152 of content; 1728 / 1440 / 1188 / 928 give 1440 / 1152 / 900 / 640.
 */
import { chmodSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { APP_ROOT, launchApp, probeHome } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(APP_ROOT, 'src', 'connectors', 'shots');
const FIXTURE_SERVER = path.join(
  APP_ROOT,
  'src',
  'candidates',
  'connectors',
  'fixtures',
  'mcp-fixture.mjs',
);
mkdirSync(OUT, { recursive: true });

const GOOD_TOKEN = 'ghp_fixture_token_0000000000000000';
const SIDEBAR = 288;
const WIDTHS = { 1440: 1728, 1152: 1440, 900: 1188, 640: 928 };

// ───────────────────────────── the fixture home ─────────────────────────────

function fixtureHome(name) {
  const home = probeHome(name);
  const desktop = path.join(home, '.pi', 'desktop');
  mkdirSync(desktop, { recursive: true });
  const servers = [
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
      args: ['-y', '@modelcontextprotocol/server-filesystem', `${homedir()}/Projects`],
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
      args: [`${homedir()}/tools/weather-mcp/index.js`],
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
  const skills = path.join(home, '.pi', 'agent', 'skills');
  mkdirSync(skills, { recursive: true });
  cpSync(
    path.join(APP_ROOT, 'resources', 'skills', 'code-review'),
    path.join(skills, 'code-review'),
    {
      recursive: true,
    },
  );
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

// ───────────────────────────── the camera and the ruler ─────────────────────────────

const measurements = [];
const failures = [];
function note(key, value) {
  measurements.push({ key, value });
  console.log(`  · ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
function check(condition, message) {
  if (condition) return true;
  failures.push(message);
  console.error(`  ✗ ${message}`);
  process.exitCode = 1;
  return false;
}
async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    const first = String(error).split('\n')[0];
    check(false, `${name}: ${first}`);
  }
}

async function setTheme(page, modeName) {
  await page.evaluate((m) => {
    document.documentElement.setAttribute('data-flavor', 'bobble');
    document.documentElement.setAttribute('data-mode', m);
  }, modeName);
  await page.waitForTimeout(350);
}

async function shot(page, file, { settle = 250, park = true } = {}) {
  if (park) await page.mouse.move(2, 2);
  await page.waitForTimeout(settle);
  const buf = await page.screenshot();
  writeFileSync(path.join(OUT, file), buf);
  check(buf.length > 5000, `blank screenshot ${file}`);
  console.log(`  shot ${file}`);
}

/** Both modes of one state. */
async function shotBoth(page, base, opts) {
  await setTheme(page, 'light');
  await shot(page, `${base}-light.png`, opts);
  await setTheme(page, 'dark');
  await shot(page, `${base}-dark.png`, opts);
}

async function setContentWidth(page, content) {
  await page.setViewportSize({ width: WIDTHS[content] ?? content + SIDEBAR, height: 900 });
  await page.waitForTimeout(400);
}

const active = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return 'null';
    const id = el.getAttribute('data-testid') ?? el.getAttribute('aria-label');
    if (id !== null) return id;
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${text !== '' ? `:"${text}"` : ''}`;
  });

const box = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }, selector);

const text = (page, selector) =>
  page.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? null, selector);

const has = (page, selector) =>
  page.evaluate((sel) => document.querySelector(sel) !== null, selector);

const count = (page, selector) =>
  page.evaluate((sel) => document.querySelectorAll(sel).length, selector);

const registry = (page) =>
  page.evaluate(async () => {
    const { registry } = await window.piDesktop.invoke('connectors:list', undefined);
    return registry.servers.map((s) => ({
      id: s.id,
      enabled: s.enabled,
      cmd: [s.command, ...(s.args ?? [])].join(' '),
      env: s.env,
      disabledTools: s.disabledTools,
    }));
  });

const openRow = async (page, id) => {
  await page.click(`[data-testid="connector-open-${id}"]`);
  await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 8000 });
  await page.waitForTimeout(350);
};

const closeDetail = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(
    !(await has(page, '[data-testid="connector-detail"]')),
    'Escape closes the detail wherever the keyboard is',
  );
};

const scrollListTop = async (page) => {
  await page.evaluate(() => {
    const list = document.querySelector('[data-testid="connectors-list"]');
    if (list !== null) list.scrollTop = 0;
  });
  await page.waitForTimeout(150);
};

/** Open a row's "···" menu and wait for it. */
const openMenu = async (page, id) => {
  await page.click(`[data-testid="connector-menu-${id}"]`);
  await page.waitForSelector('[role="menu"]', { timeout: 4000 });
  await page.waitForTimeout(200);
};

// ═════════════════════════════ the drive ═════════════════════════════

const { home, apps, bin } = fixtureHome('connectors-design');
const { app, page, finish } = await launchApp('connectors-design', {
  timeout: 45_000,
  env: {
    HOME: home,
    PI_CONNECTORS_APPS_DIR: apps,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  },
});
// Taken now: after `finish()` the Playwright handle is gone.
const proc = app.process();

try {
  await setContentWidth(page, 1152);
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 15_000 });
  await page.waitForSelector('[data-testid="connector-card-blender"]', { timeout: 15_000 });
  // Let the warm list every server that is on (the fixture answers instantly).
  await page.waitForTimeout(1500);

  // ── 1. The list at rest, at the shell width: the lifted shape, and what it left out ──
  await step('list at 1152', async () => {
    await shotBoth(page, 'list-1152');
    check(!(await has(page, '[data-testid^="connectors-filter-"]')), 'no filter pills');
    check(!(await has(page, '[data-testid="connectors-pane"]')), 'no side pane');
    check(!(await has(page, '[data-testid="connectors-tab-skills"]')), 'no tabs');
    const search = await box(page, '[data-testid="connectors-search"]');
    const title = await box(page, '.pdc-title');
    note('title / search', { title, search });
    check(search !== null && search.w <= 280, `the search is compact (${search?.w}px)`);
    check(
      search !== null && title !== null && Math.abs(search.y - title.y) < 12,
      'the search sits on the title row',
    );
    const rowStyle = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="connector-card-git"]');
      if (row === null) return null;
      const cs = getComputedStyle(row);
      return { background: cs.backgroundColor, shadow: cs.boxShadow, border: cs.borderWidth };
    });
    note('row at rest', rowStyle);
    check(
      rowStyle !== null &&
        /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(rowStyle.background) &&
        rowStyle.shadow === 'none' &&
        rowStyle.border === '0px',
      'rows sit on the background: no fill, no border, no shadow',
    );
    const badges = await page.evaluate(
      () =>
        [...document.querySelectorAll('[data-testid^="connector-card-"] span')].filter((s) =>
          /^(Official|Preinstalled|Installed|Disabled)$/.test(s.textContent ?? ''),
        ).length,
    );
    check(badges === 0, `no badges on rows (found ${badges})`);
    const switches = await count(page, '[data-testid="connectors-list"] .pd-switch');
    check(switches === 0, `no switches on the list (found ${switches})`);
    const tiles = await count(page, '[data-testid^="connector-tile-"]');
    note('installed strip tiles', tiles);
    check(tiles >= 6, 'the Installed strip carries the installed marks');
    check(
      await has(page, '[data-testid="connector-tile-github"] .pdc-tile-dot'),
      'GitHub (needs a key) wears the amber dot in the strip',
    );
    check(
      (await text(page, '[data-testid="connectors-attention"]'))?.startsWith('1 needs') === true,
      'the strip heading counts what needs attention',
    );
    const sections = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="connectors-section-"]')].map((s) => ({
        id: s.getAttribute('data-testid'),
        y: Math.round(s.getBoundingClientRect().y),
        n: s.querySelectorAll('[data-testid^="connector-card-"]').length,
      })),
    );
    note('sections', sections);
    const grid = await page.evaluate(() => {
      const g = document.querySelector('[data-testid="connectors-section-dev"] .pdc-grid');
      return g === null ? null : getComputedStyle(g).gridTemplateColumns.split(' ').length;
    });
    check(grid === 2, `two columns of rows at 1152 (${grid})`);
    // Twelve skills, six shown: the rest behind one quiet row. (Developer
    // tools is exactly seven here — the recommended three sit in their own
    // section — and a group of cap+1 is shown whole.)
    const seeMore = await page.evaluate(
      () =>
        document
          .querySelector(
            '[data-testid="connectors-section-skills"] [data-testid="connectors-show-all"]',
          )
          ?.querySelector(':scope > span:last-child')?.textContent ?? null,
    );
    note('skills overflow row', seeMore);
    check(
      seeMore?.startsWith('See ') === true && seeMore.endsWith('and more'),
      'a quiet "See …, and more" row instead of everything',
    );
    check(
      (await text(page, '[data-testid="connector-card-github"]'))?.includes('Needs a key') === true,
      'a server waiting for a key says so on its row',
    );
    check(
      (await text(page, '[data-testid="connector-card-sequential-thinking"]'))?.includes(
        'Off ·',
      ) === true,
      'an off server says Off on its row',
    );
    check(
      (await text(page, '[data-testid="connectors-disclaimer"]'))?.startsWith(
        'Third-party names',
      ) === true,
      'one-line disclaimer',
    );
    check(await has(page, '[data-testid="connectors-mcp-mode"]'), 'engine mode in the foot');
    const first = await box(page, '[data-testid="connector-card-git"]');
    const heading = await box(page, '[data-testid="connectors-section-dev"] h2');
    note('first row / its heading', { first, heading });
  });

  // ── 2. "Installed ›" opens in place: the ledger, folded in ──
  await step('installed open', async () => {
    await page.click('[data-testid="connectors-installed-toggle"]');
    await page.waitForSelector('[data-testid="connectors-installed-list"]', { timeout: 4000 });
    await page.waitForTimeout(300);
    await shotBoth(page, 'list-installed-open');
    const order = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-testid="connectors-installed-list"] [data-testid^="connector-card-"]',
        ),
      ].map((r) => r.getAttribute('data-testid')?.replace('connector-card-', '')),
    );
    note('installed order', order);
    check(order[0] === 'github', 'needs attention first');
    check(order.indexOf('sequential-thinking') > order.indexOf('memory'), 'off after on');
    check(
      await has(
        page,
        '[data-testid="connectors-installed-list"] [data-testid="connectors-add-server"]',
      ),
      'Add a server at the end of the open list',
    );
    check(
      await has(
        page,
        '[data-testid="connectors-installed-list"] [data-testid="connector-card-mac-calendar"]',
      ),
      'built-ins listed under their own label',
    );
    await page.click('[data-testid="connectors-installed-toggle"]');
    await page.waitForTimeout(300);
    check(!(await has(page, '[data-testid="connectors-installed-list"]')), 'closes again');
  });

  // ── 3. A row's "···": the remedy first ──
  await step('row menu', async () => {
    await openMenu(page, 'github');
    await setTheme(page, 'light');
    await shot(page, 'row-menu-github-light.png', { park: false });
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim()),
    );
    note('github menu', items);
    check(items[0] === 'Set up…', 'a server waiting for a key leads with Set up');
    check(!items.includes('Turn on'), 'no Turn on for a server that cannot run yet');
    check(items.includes('Remove…'), 'Remove at the end');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await openMenu(page, 'memory');
    const memory = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim()),
    );
    note('memory menu', memory);
    check(memory[0] === 'Turn off', 'a running server leads with Turn off');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  });

  // ── 4. A user-added server opens, in the list's place ──
  await step('custom server detail', async () => {
    await openRow(page, 'custom:weather');
    await page.waitForSelector('[data-testid="connector-tools-list"]', { timeout: 8000 });
    await shotBoth(page, 'detail-custom-weather');
    check(
      !(await page.isVisible('[data-testid="connectors-list"]')),
      'the list is out of the way under the detail',
    );
    check(await has(page, '[data-testid="connectors-back"]'), 'a way back at the top');
    const cmd = await text(page, '[data-testid="connector-detail-command"]');
    check(
      cmd?.includes('weather-mcp/index.js') === true,
      `custom detail shows the real command (${cmd})`,
    );
    const tools = await page.locator('[data-testid^="connector-tool-"][data-on]').count();
    check(tools === 4, `custom server lists its 4 tools (got ${tools})`);
    const tryBtn = await box(page, '[data-testid="connector-try-in-chat"]');
    const name = await box(page, '[data-testid="connector-detail"] h2');
    note('try in chat / name', { tryBtn, name });
    check(tryBtn !== null, 'Try in chat on a running custom server');
    check(
      tryBtn !== null && name !== null && Math.abs(tryBtn.y - name.y) < 40,
      'Try in chat is on the title row, as the reference has it',
    );
    note('custom try prompt', await text(page, '[data-testid="connector-try-prompt"]'));
    note('custom tool cost', await text(page, '[data-testid="connector-tool-cost"]'));
  });

  // ── 5. Per-tool switch → registry ──
  await step('per-tool switch', async () => {
    await page.click('[data-testid="connector-tool-toggle-get_alerts"]');
    await page.waitForTimeout(500);
    const reg = await registry(page);
    const weather = reg.find((s) => s.id === 'weather');
    check(
      JSON.stringify(weather?.disabledTools) === JSON.stringify(['get_alerts']),
      `disabledTools persisted (${JSON.stringify(weather?.disabledTools)})`,
    );
    await setTheme(page, 'light');
    await shot(page, 'detail-custom-tool-off-light.png');
    note('cost with one tool off', await text(page, '[data-testid="connector-tool-cost"]'));
    await page.click('[data-testid="connector-tool-toggle-get_alerts"]');
    await page.waitForTimeout(400);
  });

  // ── 6. Escape closes and the keyboard returns to the row ──
  await step('escape', async () => {
    await closeDetail(page);
    check(!(await has(page, '[data-testid="connector-detail"]')), 'Escape closes the detail');
    note('focus after Escape', await active(page));
    check((await active(page)) === 'connector-open-custom:weather', 'focus returns to the row');
    // Opened from the keyboard, the way back is reachable at once.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    note('focus after keyboard open', await active(page));
    check(
      (await active(page)) === 'connectors-back',
      'Enter on a row moves focus to the back link',
    );
    await closeDetail(page);
    // The screen stays inside the window: nothing is clipped.
    const geometry = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="connectors-screen"]');
      return {
        innerHeight: window.innerHeight,
        rootBottom: Math.round(root?.getBoundingClientRect().bottom ?? -1),
        documentScrolls: document.documentElement.scrollHeight > window.innerHeight,
      };
    });
    note('screen geometry', geometry);
    check(geometry.rootBottom <= geometry.innerHeight, 'the screen fits its container');
    check(!geometry.documentScrolls, 'the document itself does not scroll');
  });

  // ── 7. Key entry: GitHub needs a token ──
  await step('github setup card', async () => {
    await openRow(page, 'github');
    await page.waitForSelector('[data-testid="connector-setup"]', { timeout: 8000 });
    await shotBoth(page, 'detail-github-setup');
    check(
      await has(page, '[data-testid="connector-field-GITHUB_PERSONAL_ACCESS_TOKEN"]'),
      'a field for the key',
    );
    check(await has(page, '[data-testid="connector-setup-help"]'), 'where to get the key');
    check(
      !(await has(page, '[data-testid="connector-try-in-chat"]')),
      'no Try in chat before it can run',
    );
    check(
      !(await has(page, '[data-testid="connector-toggle-github"]')),
      'no switch on a server waiting for a key',
    );
    note('setup help', await text(page, '[data-testid="connector-setup-help"]'));
  });

  await step('bad key → could not start, in the server’s words', async () => {
    await page.fill('[data-testid="connector-field-GITHUB_PERSONAL_ACCESS_TOKEN"]', 'bad-token');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="connector-failure"]', { timeout: 15_000 });
    await page.waitForTimeout(400);
    await shotBoth(page, 'detail-github-bad-key');
    const reason = await text(page, '[data-testid="connector-failure-reason"]');
    note('failure reason', reason);
    check(
      reason?.includes('401 Bad credentials') === true,
      'the reason is the server’s stderr line',
    );
    note('status line', await text(page, '[data-testid="connector-detail-status"]'));
    check(
      !(await has(page, '[data-testid="connector-detail-add-github"]')),
      'no Add on an installed server',
    );
    const reg = await registry(page);
    check(reg.find((s) => s.id === 'github')?.enabled === true, 'saved on');
    // Back on the list: the row, the tile and the heading all say so.
    await closeDetail(page);
    await scrollListTop(page);
    await setTheme(page, 'light');
    await shot(page, 'list-github-failed-light.png');
    note('row line', await text(page, '[data-testid="connector-card-github"]'));
    check(
      (await text(page, '[data-testid="connector-card-github"]'))?.includes('Could not start') ===
        true,
      'the row says it could not start',
    );
    check(
      await has(page, '[data-testid="connector-tile-github"] .pdc-tile-dot'),
      'the tile keeps its amber dot',
    );
    check(
      (await text(page, '[data-testid="connectors-attention"]'))?.startsWith('1 needs') === true,
      'the Installed heading counts it',
    );
    await openMenu(page, 'github');
    check(
      (await text(page, '[data-testid="connector-setup-github"]')) === 'Change the key…',
      'the row menu leads with the key',
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  });

  await step('good key → tools with switches and a cost', async () => {
    await openRow(page, 'github');
    // A detail opened on a server in this state opens with the key card
    // already there; the failure card's own button is the other way in.
    if (await has(page, '[data-testid="connector-failure-change-key"]')) {
      await page.click('[data-testid="connector-failure-change-key"]');
    }
    await page.waitForSelector('[data-testid="connector-field-GITHUB_PERSONAL_ACCESS_TOKEN"]', {
      timeout: 5000,
    });
    await setTheme(page, 'light');
    await shot(page, 'detail-github-change-key-light.png');
    await page.fill('[data-testid="connector-field-GITHUB_PERSONAL_ACCESS_TOKEN"]', GOOD_TOKEN);
    await page.click('[data-testid="connector-setup-save"]');
    await page.waitForSelector('[data-testid="connector-tools-list"]', { timeout: 15_000 });
    await page.waitForTimeout(500);
    await shotBoth(page, 'detail-github-tools');
    check(!(await has(page, '[data-testid="connector-failure"]')), 'the failure card is gone');
    const status = await text(page, '[data-testid="connector-detail-status"]');
    check(status === 'On', `status reads On (${status})`);
    note('tools aside', await text(page, '[data-testid="connector-tools"] h3'));
    note('tool cost', await text(page, '[data-testid="connector-tool-cost"]'));
    check(
      (await text(page, '[data-testid="connector-tool-cost"]'))?.includes('tokens per turn') ===
        true,
      'a cost line',
    );
    const switches = await page.locator('[data-testid^="connector-tool-toggle-"]').count();
    check(switches > 0, `per-tool switches (${switches})`);
    check(await has(page, '[data-testid="connector-try-in-chat"]'), 'Try in chat once it is on');
    check(
      await has(page, '[data-testid="connector-toggle-github"]'),
      'the switch is in the header',
    );
    note('github try prompt', await text(page, '[data-testid="connector-try-prompt"]'));
    // The end of the detail, too.
    await page.evaluate(() => {
      const d = document.querySelector('[data-testid="connector-detail"]');
      if (d !== null) d.scrollTop = d.scrollHeight;
    });
    await page.waitForTimeout(300);
    await shot(page, 'detail-github-tools-end-light.png');
    await closeDetail(page);
  });

  // ── 8. A server that cannot start at all (Time: the fixture has no such package) ──
  await step('add Time → could not start', async () => {
    await page.fill('[data-testid="connectors-search"]', 'time');
    await page.waitForTimeout(300);
    await setTheme(page, 'light');
    await shot(page, 'search-time-light.png');
    check(
      !(await has(page, '[data-testid="connectors-installed"]')),
      'the Installed strip steps aside while searching',
    );
    await page.click('[data-testid="connector-add-time"]');
    await page.waitForTimeout(2500);
    await page.fill('[data-testid="connectors-search"]', '');
    await page.waitForTimeout(300);
    await scrollListTop(page);
    await shot(page, 'list-failed-row-light.png');
    check(
      (await text(page, '[data-testid="connector-card-time"]'))?.includes('Could not start') ===
        true,
      'Time’s row says Could not start',
    );
    await openMenu(page, 'time');
    check(
      (await text(page, '[data-testid="connector-retry-time"]')) === 'Try again',
      'Time’s menu leads with Try again',
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await openRow(page, 'time');
    await page.waitForSelector('[data-testid="connector-failure"]', { timeout: 8000 });
    await shotBoth(page, 'detail-time-failed');
    note('time failure title', await text(page, '[data-testid="connector-failure"] h3'));
    note('time failure reason', await text(page, '[data-testid="connector-failure-reason"]'));
    check(
      (await text(page, '[data-testid="connector-failure"] h3'))?.startsWith('Could not start') ===
        true,
      'a spawn/exit failure is "Could not start", not "Not responding"',
    );
    check(
      !(await has(page, '[data-testid="connector-failure-change-key"]')),
      'no key remedy on a keyless server',
    );
  });

  // ── 9. Remove with an inline confirm ──
  await step('remove confirm', async () => {
    await page.click('[data-testid="connector-remove"]');
    await page.waitForTimeout(250);
    await setTheme(page, 'light');
    await shot(page, 'detail-remove-confirm-light.png');
    check(
      await has(page, '[data-testid="connector-remove-confirm"]'),
      'confirm in place of the button',
    );
    await page.click('[data-testid="connector-remove-confirm"]');
    await page.waitForTimeout(600);
    const reg = await registry(page);
    check(!reg.some((s) => s.id === 'time'), 'Time removed after confirm');
    check(!(await has(page, '[data-testid="connector-detail"]')), 'detail closed after remove');
  });

  // ── 10. Remove from a row's menu arms the confirm, never deletes ──
  await step('remove from the row menu', async () => {
    await scrollListTop(page);
    await openMenu(page, 'memory');
    await page.click('[data-testid="connector-menu-remove-memory"]');
    await page.waitForSelector('[data-testid="connector-remove-confirm"]', { timeout: 5000 });
    check(
      (await registry(page)).some((s) => s.id === 'memory'),
      'Remove… from the menu only arms the confirm',
    );
    await page.click('[data-testid="connector-remove-row"] button:has-text("Keep")');
    await page.waitForTimeout(200);
    await closeDetail(page);
  });

  // ── 11. The dialog ──
  await step('dialog: geometry, empty submit, paste, test, enter, focus', async () => {
    await scrollListTop(page);
    await page.click('[data-testid="connectors-add-server"]');
    await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
    await page.waitForTimeout(400);
    await shotBoth(page, 'dialog-empty');
    const dialog = await box(page, '[data-testid="add-server-dialog"]');
    const title = await box(page, '[data-testid="add-server-dialog"] h2');
    const name = await box(page, '[data-testid="add-server-name"]');
    note('dialog / title / name field', { dialog, title, name });
    check(dialog !== null && dialog.w >= 460, `dialog is 480 wide (${dialog?.w})`);
    check(
      name !== null && title !== null && Math.abs(name.x - title.x) <= 1,
      'fields align with the title',
    );
    note('focus on open', await active(page));
    check((await active(page)) === 'add-server-name', 'focus lands in the Name field');
    const submitDisabled = await page.evaluate(
      () => document.querySelector('[data-testid="add-server-submit"]')?.disabled ?? null,
    );
    check(submitDisabled === false, 'the primary is not disabled as a substitute for an error');

    // Submitting empty says what is missing, in place.
    await page.click('[data-testid="add-server-submit"]');
    await page.waitForTimeout(250);
    await setTheme(page, 'light');
    await shot(page, 'dialog-errors-light.png');
    check(await has(page, '[data-testid="add-server-name-error"]'), 'inline error under Name');
    check(
      await has(page, '[data-testid="add-server-command-error"]'),
      'inline error under Command',
    );

    // Paste a README block into the Name field: the form fills itself.
    const blob = JSON.stringify({
      mcpServers: {
        'weather-two': {
          command: 'node',
          args: [`${homedir()}/tools/weather-two/index.js`],
          env: { WEATHER_KEY: 'abc123' },
        },
      },
    });
    await page.evaluate((json) => {
      const el = document.querySelector('[data-testid="add-server-name"]');
      const dt = new DataTransfer();
      dt.setData('text', json);
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, blob);
    await page.waitForTimeout(300);
    await shot(page, 'dialog-pasted-light.png');
    const nameValue = await page.inputValue('[data-testid="add-server-name"]');
    const cmdValue = await page.inputValue('[data-testid="add-server-command"]');
    note('after paste', { nameValue, cmdValue });
    check(nameValue === 'Weather Two', `name derived from the paste (${nameValue})`);
    check(
      cmdValue === `node ${homedir()}/tools/weather-two/index.js`,
      `command line filled (${cmdValue})`,
    );

    // Test starts it and lists its tools, writing nothing.
    await page.click('[data-testid="add-server-test"]');
    await page.waitForSelector('[data-testid="add-server-test-ok"]', { timeout: 15_000 });
    await page.waitForTimeout(300);
    await shotBoth(page, 'dialog-tested');
    check(!(await registry(page)).some((s) => s.id === 'weather-two'), 'Test wrote nothing');

    // Enter submits from a single-line field; the detail opens on the new server.
    await page.focus('[data-testid="add-server-name"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    check(!(await has(page, '[data-testid="add-server-dialog"]')), 'Enter submitted');
    const reg = await registry(page);
    const added = reg.find((s) => s.id === 'weather-two');
    check(
      added !== undefined && added.env?.WEATHER_KEY === 'abc123',
      `weather-two in the registry (${JSON.stringify(added)})`,
    );
    await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 8000 });
    await page.waitForTimeout(400);
    await shotBoth(page, 'added-detail');
    check(
      (await text(page, '[data-testid="connector-detail"] h2'))?.startsWith('Weather Two') === true,
      'the detail opened on the new server',
    );
    check(
      await has(page, '[data-testid="connector-tools-list"]'),
      'its tools are there from the Test, no second start',
    );
    await closeDetail(page);
    await scrollListTop(page);
    await setTheme(page, 'light');
    await shot(page, 'list-added-by-you-light.png');
    check(
      await has(
        page,
        '[data-testid="connectors-section-custom"] [data-testid="connector-card-custom:weather-two"]',
      ),
      'the new server has a row under Added by you',
    );
    check(
      await has(page, '[data-testid="connector-tile-custom:weather-two"]'),
      'and a mark in the Installed strip',
    );
  });

  await step('dialog: cancel and escape return the keyboard', async () => {
    await page.click('[data-testid="connectors-add-server"]');
    await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
    await page.click('[data-testid="add-server-cancel"]');
    await page.waitForTimeout(400);
    note('focus after cancel', await active(page));
    check((await active(page)) === 'connectors-add-server', 'Cancel returns focus to the Add tile');
    await page.click('[data-testid="connectors-add-server"]');
    await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    note('focus after escape', await active(page));
    check((await active(page)) === 'connectors-add-server', 'Escape returns focus to the Add tile');
  });

  // ── 12. A name collision asks, never overwrites ──
  await step('name collision', async () => {
    await page.click('[data-testid="connectors-add-server"]');
    await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
    await page.fill('[data-testid="add-server-name"]', 'weather');
    await page.fill('[data-testid="add-server-command"]', 'python3 server.py');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="add-server-collision"]', { timeout: 5000 });
    await setTheme(page, 'light');
    await shot(page, 'dialog-collision-light.png');
    const before = (await registry(page)).find((s) => s.id === 'weather');
    check(
      before?.cmd.startsWith('node') === true,
      'the existing Weather is untouched while asking',
    );
    await page.click('[data-testid="add-server-keep-both"]');
    await page.waitForTimeout(800);
    const reg = await registry(page);
    check(
      reg.some((s) => s.id === 'weather-2'),
      'Keep both made weather-2',
    );
    check(
      reg.find((s) => s.id === 'weather')?.cmd.startsWith('node') === true,
      'and Weather still runs node',
    );
    await closeDetail(page);
  });

  // ── 13. Edit — from the row menu, and from the detail ──
  await step('edit a custom server', async () => {
    await scrollListTop(page);
    await openMenu(page, 'custom:weather');
    await page.click('[data-testid="connector-menu-edit-custom:weather"]');
    await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });
    await page.waitForTimeout(300);
    await setTheme(page, 'light');
    await shot(page, 'dialog-edit-light.png');
    check(
      (await page.inputValue('[data-testid="add-server-name"]')) === 'Weather',
      'edit pre-fills the name',
    );
    check(
      (await page.inputValue('[data-testid="add-server-command"]')).includes(
        'weather-mcp/index.js',
      ),
      'edit pre-fills the command line',
    );
    await page.fill('[data-testid="add-server-name"]', 'Weather Station');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const w = (await registry(page)).find((s) => s.id === 'weather');
    check(w?.cmd.startsWith('node') === true, 'edit kept the id and command');
    check(
      (await text(page, '[data-testid="connector-detail"] h2'))?.startsWith('Weather Station') ===
        true,
      'the detail shows the new name',
    );
    check(await has(page, '[data-testid="connector-custom-edit"]'), 'Edit is on the detail too');
    await closeDetail(page);
  });

  // ── 14. Skills are rows in the one list: "+" turns one on ──
  await step('skills', async () => {
    await page.evaluate(() => {
      document
        .querySelector('[data-testid="connectors-section-skills"]')
        ?.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(300);
    await shotBoth(page, 'list-skills');
    check(await has(page, '[data-testid="connector-card-skill:code-review"]'), 'a skill row');
    check(
      await has(page, '[data-testid="connector-menu-skill:code-review"]'),
      'an installed skill has the menu',
    );
    check(
      await has(
        page,
        '[data-testid="connectors-section-skills"] [data-testid^="connector-add-skill:"]',
      ),
      'a skill that is off has the "+"',
    );
    await openRow(page, 'skill:code-review');
    await page.waitForSelector('[data-testid="skill-detail-body"]', { timeout: 8000 });
    await shotBoth(page, 'detail-skill');
    check(
      await has(page, '[data-testid="connector-toggle-skill:code-review"]'),
      'a skill keeps its switch in the detail',
    );
    await closeDetail(page);
  });

  // ── 15. Search empty state ──
  await step('search empty', async () => {
    await page.fill('[data-testid="connectors-search"]', 'zzznothing');
    await page.waitForTimeout(300);
    await setTheme(page, 'light');
    await shot(page, 'search-empty-light.png');
    check(await has(page, '[data-testid="connectors-empty"]'), 'empty state');
    await page.click('[data-testid="connectors-clear"]');
    await page.waitForTimeout(250);
  });

  // ── 16. Widths ──
  await step('widths', async () => {
    await scrollListTop(page);
    await setContentWidth(page, 1440);
    await shotBoth(page, 'list-1440');
    await openRow(page, 'github');
    await shotBoth(page, 'detail-1440');
    await closeDetail(page);

    await setContentWidth(page, 900);
    await scrollListTop(page);
    await shotBoth(page, 'list-900');
    const grid900 = await page.evaluate(() => {
      const g = document.querySelector('[data-testid="connectors-section-dev"] .pdc-grid');
      return g === null ? null : getComputedStyle(g).gridTemplateColumns.split(' ').length;
    });
    check(grid900 === 2, `two columns at 900 (${grid900})`);
    await openRow(page, 'github');
    await shotBoth(page, 'detail-900');
    await closeDetail(page);

    await setContentWidth(page, 640);
    await scrollListTop(page);
    await shotBoth(page, 'list-640');
    const grid640 = await page.evaluate(() => {
      const g = document.querySelector('[data-testid="connectors-section-dev"] .pdc-grid');
      return g === null ? null : getComputedStyle(g).gridTemplateColumns.split(' ').length;
    });
    check(grid640 === 1, `one column at 640 (${grid640})`);
    const overflow = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="connectors-list"]');
      return list === null ? null : list.scrollWidth - list.clientWidth;
    });
    check(overflow !== null && overflow <= 0, `nothing overflows sideways at 640 (${overflow})`);
    await openRow(page, 'github');
    await shotBoth(page, 'detail-640');
    await page.click('[data-testid="connectors-back"]');
    await page.waitForTimeout(250);
    await setContentWidth(page, 1152);
  });

  // ── 17. Try in chat ──
  await step('try in chat', async () => {
    await scrollListTop(page);
    await openRow(page, 'memory');
    const prompt = await text(page, '[data-testid="connector-try-prompt"]');
    await page.click('[data-testid="connector-try-in-chat"]');
    await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
    await page.waitForTimeout(900);
    await setTheme(page, 'light');
    await shot(page, 'try-in-chat-light.png');
    const composer = await page.evaluate(
      () => document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
    );
    note('composer after Try in chat', composer);
    check(
      prompt !== null && composer.includes(prompt.slice(0, 20)),
      'the prompt is in the composer',
    );
  });

  writeFileSync(
    path.join(OUT, 'measurements.txt'),
    `${measurements
      .map((m) => `${m.key}: ${typeof m.value === 'string' ? m.value : JSON.stringify(m.value)}`)
      .join('\n')}\n`,
  );
  if (failures.length > 0) {
    console.error(`connectors-design-probe: ${failures.length} failure(s)`);
    for (const f of failures) console.error(`  - ${f}`);
  }
} finally {
  const ok = await finish();
  if (!ok) process.exitCode = 1;
  // The app spawns fixture servers; make sure none outlive the run.
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
}
