/**
 * b6: the Connectors "Create" menu now has one row that does something.
 *
 * It listed four ("Create plugin", "Add marketplace", "Record a skill",
 * "Request a plugin"), every one wired to `onSelect={() => undefined}`, while
 * the path for adding an MCP server by hand already existed with no way in.
 *
 * Drives the real app: opens the menu, fills the dialog, submits, and asserts
 * the server reaches the registry — the actual round trip, not a rendered form.
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('add-server-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`add-server-probe FAILED: ${m}`);
  process.exitCode = 1;
};

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-mcp-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('[data-testid="nav-connectors"]', { timeout: 30_000 });
await page.click('[data-testid="nav-connectors"]');
await page.waitForTimeout(800);

/*
 * The button, not a menu. "Create ▾" listed four rows, three of which described
 * features that do not exist; once they went there was one row left behind a
 * chevron, which is a button wearing a costume. This probe used to assert the
 * menu had exactly one item — now it asserts there is no menu to open.
 */
const menus = await page.evaluate(
  () => document.querySelectorAll('[data-testid="connectors-create-menu"]').length,
);
if (menus !== 0) fail('the one-item Create menu is back');
else console.log('[mcp] OK: adding a server is a button, not a menu of one');

await page.click('[data-testid="connectors-add-server"]');
await page.waitForSelector('[data-testid="add-server-dialog"]', { timeout: 5000 });

// Disabled until it has the two required fields.
const submitDisabled = () =>
  page.evaluate(
    () => document.querySelector('[data-testid="add-server-submit"]')?.disabled ?? null,
  );
if ((await submitDisabled()) !== true) fail('the submit button is live on an empty form');
else console.log('[mcp] OK: submit is disabled until name + command');

await page.fill('[data-testid="add-server-name"]', 'Probe Weather');
await page.fill('[data-testid="add-server-command"]', 'npx');
await page.fill('[data-testid="add-server-args"]', '-y @acme/weather-mcp');
await page.fill('[data-testid="add-server-env"]', 'WEATHER_KEY=abc123');
if ((await submitDisabled()) !== false) fail('submit stayed disabled with both fields filled');

await page.click('[data-testid="add-server-submit"]');
await page.waitForTimeout(1200);

// The round trip that matters: it is in the registry main wrote.
const server = await page.evaluate(async () => {
  const { registry } = await window.piDesktop.invoke('connectors:list', {});
  return (registry?.servers ?? []).find((s) => s.id === 'probe-weather') ?? null;
});
if (server === null) fail('the server never reached the registry');
else {
  console.log(`[mcp] OK: registry has it (${JSON.stringify(server)})`);
  if (server.command !== 'npx') fail(`command wrong: ${server.command}`);
  if (JSON.stringify(server.args) !== JSON.stringify(['-y', '@acme/weather-mcp'])) {
    fail(`args wrong: ${JSON.stringify(server.args)}`);
  }
  if (server.env?.WEATHER_KEY !== 'abc123') fail(`env wrong: ${JSON.stringify(server.env)}`);
}

await app.close();
if (process.exitCode !== 1) console.log('add-server-probe OK');
