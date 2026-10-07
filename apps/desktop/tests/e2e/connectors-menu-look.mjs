/**
 * "+ › CONNECTORS", LOOKED AT (the user, 2026-10-07, with Claude's own menu as the
 * reference: Browse connectors, Manage connectors, a rule, then each installed
 * connector with its real mark, its name and a switch).
 *
 * Headless, isolated HOME, a registry with Gmail on, Notion off and a custom
 * server with only an emoji. Opens the + menu, opens Connectors, photographs it
 * light and dark, and checks what a person would: the rows and their order,
 * a brand mark per catalog connector, each switch's state, that flipping one
 * keeps the menu open and lands in the registry file, and that Manage opens the
 * Connectors screen.
 *
 *   pnpm build && node tests/e2e/connectors-menu-look.mjs   (SHOT_DIR=<dir>)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'connectors-menu-look');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = probeHome('connectors-menu');
const registryFile = path.join(home, '.pi', 'desktop', 'mcp-connectors.json');
mkdirSync(path.dirname(registryFile), { recursive: true });
writeFileSync(
  registryFile,
  `${JSON.stringify(
    {
      version: 1,
      mode: 'bash-cli',
      servers: [
        { id: 'gmail', name: 'Gmail', enabled: true, command: 'true' },
        { id: 'notion', name: 'Notion', enabled: false, command: 'true' },
        { id: 'my-tools', name: 'My tools', icon: '🔧', enabled: true, command: 'true' },
      ],
    },
    null,
    2,
  )}\n`,
);

const { page, check, finish } = await launchApp('connectors-menu-look', { env: { HOME: home } });
await page.setViewportSize({ width: 1280, height: 820 });
const setMode = async (mode) => {
  await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), mode);
  await sleep(250);
};
const snap = async (label) => {
  for (const mode of ['light', 'dark']) {
    await setMode(mode);
    const buf = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    writeFileSync(path.join(OUT, `${label}-${mode}.png`), buf);
    check(buf.length > 5000, `${label}-${mode} came back blank`);
  }
  await setMode('light');
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  await page.waitForSelector('[aria-label="Add to message"]', { timeout: 15_000 });
  await sleep(1200);
  await page.click('[aria-label="Add to message"]');
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await page.hover('[data-testid="add-connectors"]');
  await page.waitForSelector('[data-testid="add-connector-gmail"]', { timeout: 5000 });
  await sleep(300);

  const rows = await page.evaluate(() => {
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const sub = menus.find((m) => m.querySelector('[data-testid="add-connector-gmail"]'));
    return [
      ...(sub?.querySelectorAll(
        '[role="menuitem"], [role="menuitemcheckbox"], [role="separator"]',
      ) ?? []),
    ].map((e) => ({
      role: e.getAttribute('role'),
      // The row's words, not its icon (an emoji mark is text too).
      text: (e.textContent ?? '').replace(/^[^\p{L}]+/u, '').trim(),
      checked: e.getAttribute('aria-checked'),
      svgMark: e.querySelector('[data-testid="connector-icon-svg"] svg') !== null,
      switchDrawn: e.querySelector('.pd-switch') !== null,
    }));
  });
  console.log(JSON.stringify(rows, null, 1));
  check(
    JSON.stringify(rows.map((r) => r.text || r.role)) ===
      JSON.stringify([
        'Browse connectors',
        'Manage connectors',
        'separator',
        'Gmail',
        'Notion',
        'My tools',
      ]),
    `rows in order: ${rows.map((r) => r.text || r.role).join(' | ')}`,
  );
  const byName = Object.fromEntries(rows.map((r) => [r.text, r]));
  check(
    byName.Gmail?.svgMark === true && byName.Notion?.svgMark === true,
    'catalog connectors wear their real marks',
  );
  check(
    byName.Gmail?.checked === 'true' && byName.Notion?.checked === 'false',
    'switch state = registry state',
  );
  check(
    rows.filter((r) => r.role === 'menuitemcheckbox').every((r) => r.switchDrawn),
    'every connector row ends in a switch',
  );
  await snap('01-connectors-submenu');

  // Flip Notion on: the menu stays open, the row says on, the registry says on.
  await page.click('[data-testid="add-connector-notion"]');
  await sleep(400);
  const after = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid="add-connector-notion"]')
        ?.getAttribute('aria-checked') ?? null,
  );
  check(after === 'true', `Notion's switch flipped on in place (aria-checked=${after})`);
  const saved = JSON.parse(readFileSync(registryFile, 'utf8')).servers.find(
    (s) => s.id === 'notion',
  );
  check(saved?.enabled === true, 'the registry file has Notion on');
  await snap('02-after-flip');

  // Manage connectors opens the Connectors screen.
  await page.click('[data-testid="add-connectors-manage"]');
  await sleep(800);
  const onScreen = await page.evaluate(() => document.body.innerText.includes('Installed'));
  check(onScreen, 'Manage connectors opened the Connectors screen');
  await snap('03-manage');
} finally {
  await finish();
}
