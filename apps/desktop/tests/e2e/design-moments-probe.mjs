/**
 * THE BACKDROPS FOR THE DESIGN LANGUAGE'S "IN THE APP" CARDS (the user, 2026-10-07:
 * "build out some example cards and where they might appear").
 *
 * Headless, isolated HOME, the mock model. Photographs the places a first-use
 * modal, a pop-out card and a connector's demo would appear, in light and
 * dark: the empty chat, the sidebar, the Connectors screen and a connector's
 * detail, and a turn that used a tool. Prints the boxes the cards anchor to,
 * and the computed styles of the chat pieces a demo must recreate.
 *
 *   node tests/e2e/design-moments-probe.mjs   (SHOT_DIR=<dir>)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'design-moments');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = probeHome('design-moments');
const registryFile = path.join(home, '.pi', 'desktop', 'mcp-connectors.json');
mkdirSync(path.dirname(registryFile), { recursive: true });
/*
 * A stand-in calendar server, so the connector's page shows the state a person
 * sees once it works (on, its tools listed) rather than a setup error. It only
 * answers the handshake and tools/list; nothing here touches a real calendar.
 */
const fakeServer = path.join(home, 'fake-calendar-mcp.mjs');
writeFileSync(
  fakeServer,
  `import { createInterface } from 'node:readline';
const tools = [
  ['list-events', 'List events in a date range.'],
  ['search-events', 'Find events by text.'],
  ['get-freebusy', 'Free and busy times across calendars.'],
  ['create-event', 'Add an event.'],
  ['update-event', 'Change an event.'],
].map(([name, description]) => ({ name, description, inputSchema: { type: 'object', properties: {} } }));
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
        { id: 'notion', name: 'Notion', enabled: false, command: 'true' },
      ],
    },
    null,
    2,
  )}\n`,
);

const { page, check, finish } = await launchApp('design-moments', { env: { HOME: home } });
await page.setViewportSize({ width: 1280, height: 800 });
// Device pixels, so the backdrops stay sharp when a page shows them on a Retina screen.
const cdp = await page.context().newCDPSession(page);
const setMode = async (mode) => {
  await page.evaluate((m) => document.documentElement.setAttribute('data-mode', m), mode);
  await sleep(250);
};
const snap = async (label) => {
  for (const mode of ['light', 'dark']) {
    await setMode(mode);
    // Through the protocol: Playwright hands back CSS pixels for an Electron
    // window, the protocol the window's own device pixels (2x on a Retina Mac).
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
/** Boxes of everything a person can press, with its name: what a card can point at. */
const controls = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('button, [role="button"], a, [role="tab"]')]
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          name: e.getAttribute('aria-label') || (e.textContent ?? '').trim().slice(0, 40),
          testid: e.getAttribute('data-testid') ?? '',
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })
      .filter((c) => c.w > 0 && c.h > 0),
  );

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  await page.waitForSelector('[aria-label="Add to message"]', { timeout: 15_000 });
  await sleep(1500);
  await snap('01-home');
  writeFileSync(path.join(OUT, 'home-controls.json'), JSON.stringify(await controls(), null, 1));

  // A sidebar row under the pointer: where a pop-out card would come from.
  await page.hover('[data-testid="modality-3d"]');
  await sleep(500);
  await snap('05-sidebar-hover');
  await page.mouse.move(760, 600);
  await sleep(300);

  // A turn that used a tool: the mock model's fixture answers with one.
  await page.click('.pd-composer-editor');
  await page.keyboard.type("What's on my calendar on Friday?");
  await page.keyboard.press('Enter');
  await sleep(4000);
  await snap('02-turn');
  const styles = await page.evaluate(() => {
    const pick = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        sel,
        cls: e.className?.toString().slice(0, 120),
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        font: `${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily.slice(0, 40)}`,
        color: s.color,
        bg: s.backgroundColor,
        radius: s.borderRadius,
        padding: s.padding,
        shadow: s.boxShadow.slice(0, 120),
        border: s.border,
      };
    };
    // Every distinct class under the thread, so the next pass can name the right parts.
    const thread = document.querySelector('[class*="thread"], main') ?? document.body;
    const classes = new Set();
    for (const e of thread.querySelectorAll('*')) {
      for (const c of e.classList) if (c.startsWith('pd-')) classes.add(c);
    }
    return {
      classes: [...classes].sort(),
      parts: [
        '.pd-msg-bubble',
        '.pd-chain-summary',
        '.pd-chain-summary-text',
        '.pd-markdown',
        '.pd-composer',
      ].map(pick),
    };
  });
  writeFileSync(path.join(OUT, 'turn-styles.json'), JSON.stringify(styles, null, 1));

  // The chain opened: its steps are the rows a connector's demo shows.
  await page.click('.pd-chain-summary');
  await sleep(700);
  await snap('02b-turn-open');
  const steps = await page.evaluate(() =>
    [
      '.pd-chain-step-row',
      '.pd-chain-step-icon',
      '.pd-chain-step-label',
      '.pd-chain-done',
      '.pd-chain-done-icon',
      '.pd-chain-steps',
    ].map((sel) => {
      const e = document.querySelector(sel);
      if (!e) return { sel, missing: true };
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        sel,
        html: e.outerHTML.slice(0, 600),
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        font: `${s.fontWeight} ${s.fontSize}/${s.lineHeight}`,
        color: s.color,
        bg: s.backgroundColor,
        radius: s.borderRadius,
        padding: s.padding,
        gap: s.gap,
      };
    }),
  );
  writeFileSync(path.join(OUT, 'chain-styles.json'), JSON.stringify(steps, null, 1));

  // The Connectors screen, through + › Connectors › Manage as a person would.
  await page.click('[aria-label="Add to message"]');
  await page.waitForSelector('[role="menu"]', { timeout: 5000 });
  await page.hover('[data-testid="add-connectors"]');
  await page.waitForSelector('[data-testid="add-connectors-manage"]', { timeout: 5000 });
  await page.click('[data-testid="add-connectors-manage"]');
  await sleep(1200);
  await snap('03-connectors');
  writeFileSync(
    path.join(OUT, 'connectors-controls.json'),
    JSON.stringify(await controls(), null, 1),
  );

  // A connector's own page, scrolled to Try it: where its demo would play.
  await page.click('[data-testid="connector-tile-google-calendar"]');
  await sleep(2500);
  await page.evaluate(() =>
    document.querySelector('[data-testid="connector-try"]')?.scrollIntoView({ block: 'center' }),
  );
  await sleep(600);
  await snap('04-connector-detail');
  const tryBox = await page.evaluate(() => {
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    };
    return {
      section: box('[data-testid="connector-try"]'),
      bubble: box('[data-testid="connector-try-prompt"]'),
      tryBox: box('.pdc-try'),
      prompt: document.querySelector('[data-testid="connector-try-prompt"]')?.textContent,
      text: document.body.innerText.slice(0, 1500),
    };
  });
  writeFileSync(path.join(OUT, 'detail-try.json'), JSON.stringify(tryBox, null, 1));

  // The 3D Studio's first view: where its first-use modal would open.
  await page.click('[data-testid="modality-3d"]');
  await sleep(1500);
  await snap('06-studio3d');
  // "View unblurs the studio so you can look around": the studio itself, under a first-use card.
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await sleep(1200);
  await snap('07-studio3d-view');
} finally {
  await finish();
}
