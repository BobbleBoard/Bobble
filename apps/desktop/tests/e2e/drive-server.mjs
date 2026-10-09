/**
 * DRIVE BOBBLE BY HAND, HEADLESS — one real model, a person's view only.
 *
 * The user (2026-10-01): "drive bobble visually as a user … typing into the
 * search box reading output only by screenshotting the full app window, and
 * clicking buttons, no reading output directly, get the full UX through the
 * UI." This launches the app hidden (the e2e harness: throwaway home, the
 * real model library) on one model and serves a tiny command line on
 * 127.0.0.1 so a person — or Claude, playing one — can drive it step by step:
 *
 *   curl -s localhost:4799/shot?label=start           a full-window screenshot
 *   curl -s 'localhost:4799/click?x=700&y=820'        a click where a person would
 *   curl -s --data-binary @msg.txt localhost:4799/type   typing, as keystrokes
 *   curl -s 'localhost:4799/key?k=Enter'
 *   curl -s 'localhost:4799/scroll?x=500&y=400&dy=600'
 *   curl -s 'localhost:4799/wait?ms=600000'           until the turn ends
 *   curl -s 'localhost:4799/film?s=30&every=2000&label=watch'   watching it move
 *   curl -s localhost:4799/quit
 *
 * The output is read from the screenshots and nowhere else. The one thing
 * read from the page is whether a turn is still running (the composer's Stop
 * button is there) — the cue a person reads off the button.
 *
 *   MODEL=qwen3.5-4b-mtp SHOT_DIR=<dir> node apps/desktop/tests/e2e/drive-server.mjs
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const PORT = Number(process.env.PORT ?? 4799);
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/drive';
mkdirSync(SHOT_DIR, { recursive: true });
const LOG = path.join(SHOT_DIR, 'app.log');

const home = probeHome('drive');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
// A person's own setup (the user's, read once): power mode, medium effort, llama.cpp.
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify(
    {
      userMode: 'power',
      effort: 'medium',
      enginePreference: process.env.ENGINE ?? 'llamacpp',
      toolInterface: 'bash-cli',
      loadVision: true,
      modelSelection: { mode: 'model', modelId: MODEL },
    },
    null,
    2,
  )}\n`,
);

const { app, page, finish } = await launchApp('drive', {
  realCache: true,
  /* A window that is never shown still runs its timers — but the canvas's
     cross-origin frame in it had them throttled so hard that a page's telling
     sat on step 1 for a minute. A person's window is on a screen; these keep
     the hidden one ticking like it. */
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
  ],
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_DESKTOP_GEN: '1',
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
  timeout: 120_000,
});
for (const s of [app.process().stderr, app.process().stdout])
  s?.on('data', (c) => appendFileSync(LOG, c));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
log(`waiting for ${MODEL}…`);
await page.waitForFunction(
  (m) =>
    window.__llm_store?.().getState().status.model?.id === m &&
    window.__llm_store().getState().status.phase === 'ready',
  MODEL,
  { timeout: 900_000 },
);
const profile = await page.evaluate(() => window.__llm_store().getState().status.profile);
log(`model up: ${MODEL} on ${JSON.stringify(profile)}`);

let n = 0;
const shot = async (label) => {
  n += 1;
  const file = path.join(SHOT_DIR, `${String(n).padStart(3, '0')}-${label}.png`);
  writeFileSync(file, await page.screenshot());
  return file;
};
const busy = () =>
  page
    .locator('[data-testid="composer-stop"]')
    .count()
    .then((c) => c > 0);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const q = Object.fromEntries(url.searchParams);
  const body = await new Promise((r) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => r(b));
  });
  const reply = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify(o)}\n`);
  };
  try {
    switch (url.pathname) {
      case '/shot':
        return reply({ file: await shot(q.label ?? 'shot') });
      case '/click':
        await page.mouse.click(Number(q.x), Number(q.y));
        await sleep(400);
        return reply({ ok: true });
      case '/type':
        await page.keyboard.type(body, { delay: Number(q.delay ?? 12) });
        return reply({ ok: true, chars: body.length });
      case '/key':
        await page.keyboard.press(q.k ?? 'Enter');
        await sleep(300);
        return reply({ ok: true });
      case '/scroll':
        await page.mouse.move(Number(q.x ?? 500), Number(q.y ?? 400));
        await page.mouse.wheel(0, Number(q.dy ?? 600));
        await sleep(500);
        return reply({ ok: true });
      case '/wait': {
        // Until the composer's Stop has been gone for 4 s (a turn's tool calls keep it up).
        const t0 = Date.now();
        const limit = Number(q.ms ?? 600_000);
        await sleep(Number(q.after ?? 3000));
        let quiet = 0;
        while (Date.now() - t0 < limit) {
          if (await busy()) quiet = 0;
          else quiet += 1000;
          if (quiet >= 4000) break;
          await sleep(1000);
        }
        return reply({ ended: quiet >= 4000, secs: Math.round((Date.now() - t0) / 1000) });
      }
      case '/film': {
        const files = [];
        const every = Number(q.every ?? 2000);
        const until = Date.now() + Number(q.s ?? 20) * 1000;
        while (Date.now() < until) {
          files.push(await shot(q.label ?? 'film'));
          await sleep(every);
        }
        return reply({ files });
      }
      case '/frames': {
        // The rig, not the reply: is each frame's clock ticking? (timer callbacks in 2 s)
        const out = [];
        for (const f of page.frames()) {
          const ticks = await f
            .evaluate(
              () =>
                new Promise((r) => {
                  let n = 0;
                  const id = setInterval(() => {
                    n += 1;
                  }, 100);
                  setTimeout(() => {
                    clearInterval(id);
                    r(n);
                  }, 2000);
                }),
            )
            .catch((e) => `error ${String(e).slice(0, 80)}`);
          out.push({ url: f.url().slice(0, 60), ticks });
        }
        return reply({ frames: out });
      }
      case '/quit':
        reply({ ok: true });
        server.close();
        // The model server first, then the app: a llama-server's parent never goes from under it.
        await page
          .evaluate(() => window.piDesktop.invoke('llm:stop-server'))
          .catch(() => undefined);
        await sleep(3000);
        await finish();
        process.exit(0);
        return;
      default:
        return reply({ error: `no such command ${url.pathname}` });
    }
  } catch (e) {
    return reply({ error: String(e) });
  }
});
server.listen(PORT, '127.0.0.1', () => log(`driving on 127.0.0.1:${PORT}`));
