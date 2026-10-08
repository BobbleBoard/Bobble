/**
 * THE ICONS, LOOKED AT (the user, 2026-10-08: "I like the 1px stroke 13px text, I
 * still like the hugeicons better than drawn").
 *
 * Headless, isolated HOME, the mock model, a stand-in calendar connector.
 * Photographs, at the window's own device pixels, the surfaces that carry the
 * most icons: the sidebar and composer, the + menu with Connectors open, a turn
 * whose activity chain is open with its message actions showing, the Extensions
 * screen, Model management and Settings. Run it before and after an icon change
 * and compare the shots side by side.
 *
 *   node tests/e2e/icons-look.mjs   (SHOT_DIR=<dir>)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'icons-look');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = probeHome('icons-look');
const registryFile = path.join(home, '.pi', 'desktop', 'mcp-connectors.json');
mkdirSync(path.dirname(registryFile), { recursive: true });
// A stand-in server: answers the handshake and tools/list, touches nothing.
const fakeServer = path.join(home, 'fake-calendar-mcp.mjs');
writeFileSync(
  fakeServer,
  `import { createInterface } from 'node:readline';
const tools = [['list-events', 'List events in a date range.'], ['create-event', 'Add an event.']]
  .map(([name, description]) => ({ name, description, inputSchema: { type: 'object', properties: {} } }));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'calendar', version: '1' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not here' } });
});
`,
);
writeFileSync(
  registryFile,
  `${JSON.stringify(
    {
      version: 1,
      mode: 'bash-cli',
      servers: [
        {
          id: 'google-calendar',
          name: 'Google Calendar',
          enabled: true,
          command: process.execPath,
          args: [fakeServer],
          env: { GOOGLE_OAUTH_CREDENTIALS: path.join(home, 'oauth-placeholder.json') },
        },
        { id: 'gmail', name: 'Gmail', enabled: true, command: 'true' },
        { id: 'my-tools', name: 'My tools', enabled: false, command: 'true' },
      ],
    },
    null,
    2,
  )}\n`,
);

const { page, check, finish } = await launchApp('icons-look', { env: { HOME: home } });
await page.setViewportSize({ width: 1280, height: 800 });
const cdp = await page.context().newCDPSession(page);
const setMode = async (mode) => {
  await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), mode);
  await sleep(250);
};
// Device pixels: Playwright hands back CSS pixels for an Electron window.
const snap = async (label) => {
  for (const mode of ['light', 'dark']) {
    await setMode(mode);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 },
    });
    const buf = Buffer.from(data, 'base64');
    writeFileSync(path.join(OUT, `${label}-${mode}.png`), buf);
    check(buf.length > 5000, `${label}-${mode} came back blank`);
  }
  await setMode('light');
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  await page.waitForSelector('[aria-label="Add to message"]', { timeout: 15_000 });
  await sleep(1500);
  await snap('01-home');

  await page.click('[aria-label="Add to message"]');
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await page.hover('[data-testid="add-connectors"]');
  await page.waitForSelector('[data-testid="add-connectors-manage"]', { timeout: 5000 });
  await sleep(400);
  await snap('02-plus-menu');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await sleep(300);

  await page.click('.pd-composer-editor');
  await page.keyboard.type('Tidy up the demo folder');
  await page.keyboard.press('Enter');
  await sleep(4000);
  await page.click('.pd-chain-summary');
  await sleep(600);
  // The message actions show on hover: put the pointer on the reply.
  await page.hover('.pd-msg--assistant');
  await sleep(500);
  await snap('03-turn');

  await page.click('[data-testid="nav-connectors"]');
  await sleep(1500);
  await snap('04-extensions');

  await page.click('[data-testid="nav-model-management"]');
  await sleep(1500);
  await snap('05-models');

  await page
    .getByRole('button', { name: /settings/i })
    .last()
    .click();
  await sleep(1200);
  await snap('06-settings');
} finally {
  await finish();
}
