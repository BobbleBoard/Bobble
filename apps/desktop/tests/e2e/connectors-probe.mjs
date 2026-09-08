/**
 * Connectors E2E: lands in chat (mock pi) under an isolated HOME, opens the
 * Connectors screen from the sidebar, and asserts the whole flow against the
 * real registry file:
 *   - "Recommended for you" renders from a MOCKED /Applications scan (a fixture
 *     dir with Blender.app → a Blender chip in the recommended section),
 *   - brand marks render as self-contained inline SVG in their brand colour,
 *   - adding a plain connector (memory) via the "+" persists it enabled,
 *   - opening its card gives a detail whose switch turns it off (persisted),
 *   - a key-needing connector (slack) opens straight to a setup card, and
 *     saving the key installs it ON with the key in its env,
 *   - switching the MCP mode to Bash CLI persists to settings.json + the registry.
 * Run `pnpm build` first. Headless: the window never takes the screen.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, REPO_ROOT } from './harness.mjs';

const fixture = path.join(REPO_ROOT, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

// Mock /Applications scan: a fixture dir with only Blender.app → recommended.
const appsDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-apps-'));
mkdirSync(path.join(appsDir, 'Blender.app'));

const { page, check, finish, home } = await launchApp('connectors-probe', {
  fixture,
  waitFor: '[data-testid="composer-input"]',
  env: { PI_CONNECTORS_APPS_DIR: appsDir },
});

const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const mcpPath = path.join(home, '.pi', 'desktop', 'mcp-connectors.json');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const servers = () => (existsSync(mcpPath) ? readJson(mcpPath).servers : []);
const serverById = (id) => servers().find((s) => s.id === id);

async function waitFor(predicate, label, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return true;
    } catch {
      // file not written yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return check(false, `timed out waiting for ${label}`);
}

const search = async (q) => {
  await page.fill('[data-testid="connectors-search"]', q);
  await page.waitForTimeout(250);
};

try {
  // Open the connectors screen from the sidebar nav.
  await page.click('[data-testid="nav-connectors"]');
  await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 8000 });

  // Recommended for you: Blender as a chip in the recommended SECTION, from the mocked scan.
  await page.waitForSelector(
    '[data-testid="connectors-section-recommended"] [data-testid="connector-open-blender"]',
    { timeout: 8000 },
  );

  // Real brand marks render as self-contained inline SVG for well-known
  // connectors, in their BRAND COLOUR (figma #F24E1E, blender #E87D0D directly;
  // github #181717 via the --pd-connector-ink fallback) — never the emoji
  // fallback and never monochrome currentColor.
  for (const id of ['github', 'figma', 'blender']) {
    // Blender is the recommended chip: it shows with the search empty.
    await search(id === 'blender' ? '' : id);
    const svg = `[data-testid="connector-open-${id}"] [data-testid="connector-icon-svg"] svg`;
    await page.waitForSelector(svg, { timeout: 8000 });
    const paths = await page.locator(`${svg} path`).count();
    check(paths > 0, `expected a brand SVG path inside ${id}'s mark`);
    const fill = (await page.locator(svg).first().getAttribute('fill')) ?? '';
    check(
      fill.includes('#') && fill !== 'currentColor',
      `expected a brand-color fill inside ${id}'s mark, got "${fill}"`,
    );
  }
  await search('');

  // ...and the one-line trademark disclaimer sits under the list.
  const disclaimer = (await page.textContent('[data-testid="connectors-disclaimer"]')) ?? '';
  check(
    disclaimer.startsWith('Third-party names and marks belong to their owners'),
    'trademark disclaimer present under the list',
  );

  // Add a plain (no-key) connector via the "+" → persists enabled.
  await search('memory');
  await page.click('[data-testid="connector-add-memory"]');
  await waitFor(() => serverById('memory')?.enabled === true, 'memory installed + enabled');

  // Open its card: the detail has a switch, and OFF persists.
  await page.click('[data-testid="connector-open-memory"]');
  await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 8000 });
  await page.click('[data-testid="connector-detail"] [data-testid="connector-toggle-memory"]');
  await waitFor(() => serverById('memory')?.enabled === false, 'memory disabled persists');
  check(
    (await page.textContent('[data-testid="connector-detail-status"]'))?.trim() === 'Off',
    'the detail says Off',
  );

  // Back to the list; a key-needing connector's "+" opens its setup card,
  // and saving the key installs it ON with the key in its environment.
  await page.click('[data-testid="connectors-back"]');
  await search('slack');
  await page.waitForSelector('[data-testid="connector-setup-slack"]', { timeout: 8000 });
  await page.click('[data-testid="connector-setup-slack"]');
  await page.waitForSelector('[data-testid="connector-field-SLACK_MCP_XOXP_TOKEN"]', {
    timeout: 8000,
  });
  check(
    !(await page.$('[data-testid="connect-permission-dialog"]')),
    'no consent dialog stands between "+" and the key field',
  );
  await page.fill('[data-testid="connector-field-SLACK_MCP_XOXP_TOKEN"]', 'xoxp-probe-token');
  await page.click('[data-testid="connector-setup-save"]');
  await waitFor(
    () =>
      serverById('slack')?.enabled === true &&
      serverById('slack')?.env?.SLACK_MCP_XOXP_TOKEN === 'xoxp-probe-token',
    'slack installed ON with its key saved',
  );
  await page.click('[data-testid="connectors-back"]');
  await search('');

  // Switch the MCP mode to Bash CLI → persists to settings.json + the registry.
  await page.click('[data-testid="connectors-mcp-mode"] >> text=Bash CLI');
  await waitFor(
    () => readJson(settingsPath).mcpMode === 'bash-cli',
    'mcp mode persisted in settings',
  );
  await waitFor(() => readJson(mcpPath).mode === 'bash-cli', 'mcp registry mode rewritten');

  console.log(
    'connectors-probe: recommended chip from the mocked scan; brand SVGs for github/figma/blender; ' +
      'one-line disclaimer; install + off persisted from the detail; key-needing connector set up ' +
      'from its card and installed on; bash-cli mode persisted',
  );
} finally {
  await finish();
}
