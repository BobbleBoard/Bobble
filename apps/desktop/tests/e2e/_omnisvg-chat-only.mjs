/** The chat half of _omnisvg-download-flow, on a cache that already has the model, with the prompt dumped. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const CACHE = process.env.CACHE; // a cache dir that has models/omnisvg-1.1-4b
const CHAT_MODEL = process.env.MAC_CU_MODEL ?? 'minicpm5-2b';
const PROMPT =
  process.env.PROMPT ?? 'Make me an SVG icon of a red heart with smooth curved edges, centered.';
const OUT = process.argv[2] ?? '/tmp/omni-chat';
mkdirSync(OUT, { recursive: true });
const HOME = mkdtempSync(path.join(tmpdir(), 'omni-chat-home-'));
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* DEV=1 runs the repo build (harness from src — prompt edits need no ship). */
const DEV = process.env.DEV === '1';
const { createRequire } = await import('node:module');
const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const app = await electron.launch({
  executablePath: DEV
    ? createRequire(import.meta.url)('electron')
    : '/Applications/Bobble.app/Contents/MacOS/Bobble',
  args: DEV
    ? [appRoot, `--user-data-dir=${path.join(HOME, 'udd')}`]
    : [`--user-data-dir=${path.join(HOME, 'udd')}`],
  env: {
    ...process.env,
    HOME,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_ADV_DEBUG_PROMPT: path.join(OUT, 'prompt.txt'),
    PI_ADV_DEBUG_TOOLS: path.join(OUT, 'tools.txt'),
  },
});
let page;
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  const list = await page.evaluate(() => window.piDesktop.invoke('connectors:list', undefined));
  say(`installedModels=${JSON.stringify(list.installedModels)}`);
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
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type(PROMPT, { delay: 12 });
  await sleep(400);
  await page.keyboard.press('Enter');
  say('sent');
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
  const deadline = Date.now() + 5 * 60_000;
  let found = [];
  let shots = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    found = svgs();
    const s = await page.evaluate(() => {
      const st = window.__pi_store().getState();
      return { n: st.messages.length, streaming: st.agent.isStreaming };
    });
    if (s.n > 1 && shots < 2) {
      await shot(`chat-${shots}`);
      shots += 1;
    }
    if (!s.streaming && s.n > 1 && (await capacity())) {
      await sleep(2000);
      if (await capacity()) break;
    }
  }
  await shot('chat-done');
  const st = await page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.map((m) => ({
        kind: m.kind,
        text: (m.text ?? '').slice(0, 160),
        tool: m.toolName ?? m.name,
      })),
  );
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
