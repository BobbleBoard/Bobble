/**
 * THE REAL-USER FLOW FOR THE OMNISVG CONNECTOR, against the installed app:
 * Connectors → OmniSVG → Download → (progress) → on → new chat → "make me a
 * red heart" → an .svg lands in Generated.
 *
 * The bytes come from a loopback mirror serving the real GGUFs (HF_ENDPOINT),
 * and the download lands in a scratch cache (PI_DESKTOP_CACHE_DIR) that links
 * the chat models in — so the user's own cache stays "Not downloaded" for HIS run.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MIRROR = process.env.HF_ENDPOINT;
if (!MIRROR) throw new Error('HF_ENDPOINT (the mirror) is required');
const CHAT_MODEL = process.env.MAC_CU_MODEL ?? 'minicpm5-2b';
const OUT = process.argv[2] ?? '/tmp/omni-flow';
mkdirSync(OUT, { recursive: true });

const HOME = mkdtempSync(path.join(tmpdir(), 'omni-flow-home-'));
const CACHE = path.join(HOME, 'cache');
const real = path.join(homedir(), '.cache/pi-desktop');
mkdirSync(path.join(CACHE, 'models'), { recursive: true });
for (const e of readdirSync(real)) {
  if (e === 'models') continue;
  symlinkSync(path.join(real, e), path.join(CACHE, e));
}
for (const e of readdirSync(path.join(real, 'models'))) {
  if (e.startsWith('.') || e.includes('omnisvg')) continue;
  symlinkSync(path.join(real, 'models', e), path.join(CACHE, 'models', e));
}

const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: '/Applications/Bobble.app/Contents/MacOS/Bobble',
  args: [`--user-data-dir=${path.join(HOME, 'udd')}`],
  env: {
    ...process.env,
    HOME,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    HF_ENDPOINT: MIRROR,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
let page;
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  const list = () => page.evaluate(() => window.piDesktop.invoke('connectors:list', undefined));

  // 1. Connectors → OmniSVG.
  await page.getByText('Connectors', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.getByPlaceholder('Search connectors').fill('OmniSVG');
  await page.waitForTimeout(600);
  const before = await list();
  say(`before: installedModels=${JSON.stringify(before.installedModels)}`);
  await shot('01-card-available');

  // 2. Download (the card's button — what a user clicks).
  const dl = page.locator('[data-testid="connector-download-omnisvg"]');
  if ((await dl.count()) !== 1) throw new Error(`download button count: ${await dl.count()}`);
  await dl.click();
  say('clicked Download');
  // Catch the progress mark while the bytes are moving.
  let shotsTaken = 0;
  let on = false;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await sleep(2500);
    const now = await list();
    on = (now.installedModels ?? []).includes('omnisvg');
    const mark = await page
      .locator('[data-testid="connector-card-omnisvg"], [data-testid="connector-download-omnisvg"]')
      .first()
      .textContent()
      .catch(() => '');
    if (shotsTaken < 3) {
      await shot(`02-downloading-${shotsTaken}`);
      shotsTaken += 1;
      say(`downloading… card text=${JSON.stringify(mark?.trim().slice(0, 80))}`);
    }
    if (on) break;
  }
  if (!on) throw new Error('the model never became installed');
  say(`installed: ${JSON.stringify((await list()).installedModels)}`);
  await page.waitForTimeout(800);
  await shot('03-card-on');
  await page.getByText('OmniSVG', { exact: true }).first().click();
  await page.waitForTimeout(900);
  say(
    `detail status: ${await page
      .locator('[data-testid="connector-detail-status"]')
      .textContent()
      .catch(() => '?')}`,
  );
  await shot('04-detail-on');
  const dir = path.join(CACHE, 'models', 'omnisvg-1.1-4b');
  for (const f of readdirSync(dir)) say(`file: ${f} ${statSync(path.join(dir, f)).size}`);

  // 3. A new chat with a chat model, and the ask.
  const up = await page.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    CHAT_MODEL,
  );
  if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  await page.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  await page.evaluate(
    (id) =>
      window
        .__settings_store?.()
        .getState?.()
        .update?.({ modelSelection: { mode: 'model', modelId: id } }),
    CHAT_MODEL,
  );
  await page.getByText('New chat', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const capacity = () =>
    page.evaluate(() => {
      const s = window.__pi_store().getState();
      return (
        !s.agent.isStreaming && !s.promptInFlight && s.bgRun?.streaming !== true && !s.resuming
      );
    });
  for (let i = 0; i < 40 && !(await capacity()); i += 1) await sleep(500);
  const PROMPT = 'Make me an SVG icon of a red heart with smooth curved edges, centered.';
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type(PROMPT, { delay: 12 });
  await sleep(400);
  await page.keyboard.press('Enter');
  say('sent the prompt');
  const gen = path.join(HOME, 'Bobble', 'generated');
  const svgs = () => {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 5 || !existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith('.svg')) out.push(p);
      }
    };
    walk(gen, 0);
    return out;
  };
  const chatDeadline = Date.now() + 6 * 60_000;
  let found = [];
  let mid = false;
  while (Date.now() < chatDeadline) {
    await sleep(3000);
    found = svgs();
    if (!mid && Date.now() - t0 > 0) {
      const s = await page.evaluate(() => window.__pi_store().getState());
      const last = s.messages[s.messages.length - 1];
      if (last?.kind === 'tool' || s.messages.some((m) => m.kind === 'tool')) {
        await shot('05-chat-generating');
        mid = true;
      }
    }
    if (found.length > 0) {
      const settled = await capacity();
      if (settled) break;
    }
  }
  await sleep(1500);
  await shot('06-chat-done');
  const st = await page.evaluate(() => {
    const s = window.__pi_store().getState();
    return s.messages.map((m) => ({
      kind: m.kind,
      text: (m.text ?? '').slice(0, 200),
      tool: m.toolName ?? m.name,
    }));
  });
  console.log(JSON.stringify(st, null, 1));
  say(`svg files: ${JSON.stringify(found)}`);
  for (const f of found) {
    const text = readFileSync(f, 'utf8');
    say(
      `${path.basename(f)}: ${(text.match(/<path\b/g) ?? []).length} paths, fills=${JSON.stringify([...text.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1]))}`,
    );
  }
  console.log(`HOME=${HOME}`);
} finally {
  await app.close().catch(() => {});
}
