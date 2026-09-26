/**
 * THE MATH COMMAND, IN THE APP — end to end, with only the model scripted.
 *
 * A model asked about simple harmonic motion writes the spec (`write
 * shm.math.json`), runs `math shm.math.json` through bash, and answers. The
 * real pi, harness, CLI shims, present bridge and canvas do the rest. The
 * probe checks what reached the model (the checks line, and the capture when
 * it can see one), what landed in the chat's folder (the spec and the page
 * beside it), and what the user gets: the page open in the canvas with its
 * script alive — Next moves to the next step and sets its sliders, Play runs
 * one — captured as pictures to LOOK at.
 *
 *   OUT=/tmp/math-visual node tests/e2e/math-visual-probe.mjs
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SHM } from '../../../../packages/mathviz/src/fixtures.ts';
import { startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
import { launchApp, probeHome } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'mock-4b';
const ASK = 'Explain simple harmonic motion with a mass on a spring next to its graph.';

const mock = await startMockOpenAI({
  model: MODEL,
  rules: [
    {
      name: 'answer',
      match: { afterTool: 'Drew "' },
      reply: {
        content:
          'The page shows the mass on its spring beside its x–t graph. Press play on t to set it moving.',
      },
    },
    {
      name: 'run-math',
      match: { afterTool: 'shm.math.json' },
      reply: { toolCalls: [{ name: 'bash', arguments: { command: 'math shm.math.json' } }] },
      times: 1,
    },
    {
      name: 'write-spec',
      match: { lastUser: 'simple harmonic motion' },
      reply: {
        toolCalls: [
          {
            name: 'write',
            arguments: { path: 'shm.math.json', content: JSON.stringify(SHM, null, 2) },
          },
        ],
      },
      times: 1,
    },
  ],
});

const home = probeHome('math-visual');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ modelSelection: { mode: 'tier', tier: 'balanced' }, loadVision: false }, null, 2)}\n`,
);
writeModelsJson(home, {
  provider: 'mock',
  api: 'llamacpp-stream',
  baseUrl: mock.baseUrl,
  model: MODEL,
  name: 'Mock 4B',
  input: ['text', 'image'],
});

const { app, page, check, finish, shotDir } = await launchApp('math-visual', {
  env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1' },
  timeout: 60_000,
});
const OUT = process.env.OUT ?? shotDir;
mkdirSync(OUT, { recursive: true });

try {
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(ASK);
  await page.keyboard.press('Enter');
  const ended = await page
    .waitForFunction(
      () => {
        const st = window.__pi_store().getState();
        const replied = st.messages.some(
          (m) =>
            m.kind === 'assistant' &&
            (m.blocks ?? []).some((b) => (b.text ?? '').includes('Press play')),
        );
        return replied && !st.messages.some((m) => m.isStreaming) && st.promptInFlight !== true;
      },
      undefined,
      { timeout: 120_000, polling: 500 },
    )
    .then(() => true)
    .catch(() => false);
  check(ended, 'the turn ran to its answer');
  await sleep(2500);

  // What the model was told.
  const results = await page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.filter((m) => m.kind === 'toolResult')
      .map((m) => ({
        text: String(m.text ?? ''),
        error: m.isError === true,
        images: Array.isArray(m.images) ? m.images.length : 0,
      })),
  );
  const drew = results.find((r) => r.text.includes('Drew "'));
  console.log('math result:\n', drew?.text ?? JSON.stringify(results).slice(0, 1500));
  check(
    drew !== undefined && /Checks — (clear|nothing overlaps)/.test(drew.text),
    'math answered with its checks',
  );

  // What landed in the chat's folder.
  const bobble = path.join(home, 'Bobble');
  const folder = existsSync(bobble)
    ? readdirSync(bobble)
        .map((d) => path.join(bobble, d))
        .find((d) => existsSync(path.join(d, 'shm.math.json')))
    : undefined;
  check(
    folder !== undefined && existsSync(path.join(folder, 'shm.html')),
    `the spec and the page sit side by side: ${folder ?? 'no folder with shm.math.json'}`,
  );

  // What the user sees: the page in the canvas (a frame inside the window), alive.
  const inPage = (code) =>
    app.evaluate(async ({ webContents }, js) => {
      for (const wc of webContents.getAllWebContents()) {
        for (const f of wc.mainFrame.framesInSubtree) {
          if (!/pd-preview:\/\/canvas/.test(f.url)) continue;
          try {
            return await f.executeJavaScript(js, true);
          } catch (e) {
            return { error: String(e) };
          }
        }
      }
      return null;
    }, code);
  const frames = await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().map((wc) => ({
      wc: wc.getURL().slice(0, 90),
      frames: wc.mainFrame.framesInSubtree.map((f) => f.url.slice(0, 120)),
    })),
  );
  console.log('frames:', JSON.stringify(frames, null, 1));
  let view = null;
  for (let i = 0; i < 20 && view === null; i += 1) {
    view = await inPage(
      '({ url: location.href, mount: typeof mvMount, panels: document.querySelectorAll("[data-mv-panel] svg").length, step: document.querySelector("[data-mv-count]")?.textContent ?? null })',
    );
    if (view === null) await sleep(500);
  }
  console.log('canvas page:', JSON.stringify(view));
  check(view !== null, 'the page is open in the canvas');
  check(
    view?.mount === 'function' && view?.panels === 2,
    `its script runs and drew both panels: ${JSON.stringify(view)}`,
  );
  await page.screenshot({ path: path.join(OUT, 'app-step1.png') });
  if (view !== null) {
    await inPage(
      'document.querySelector("[data-mv-next]").click(); document.querySelector("[data-mv-next]").click();',
    );
    // A move takes 1.1 s and step 3's nudge 3.2 s more; a background window's frames come slower.
    await sleep(6000);
    const s3 = await inPage(
      '({ step: document.querySelector("[data-mv-count]").textContent, A: document.querySelector(\'[data-mv-value="A"]\').textContent })',
    );
    console.log('after Next ×2:', JSON.stringify(s3));
    check(
      s3?.step === '3 / 3' && s3?.A === '2',
      `Next reached step 3 and moved A to its value: ${JSON.stringify(s3)}`,
    );
    await inPage(
      'document.querySelector("[data-mv-steps], .mv-steps")?.scrollIntoView({ block: "center" })',
    );
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, 'app-step3.png') });
    await inPage('window.scrollTo(0, 0); document.querySelector(\'[data-mv-play="t"]\').click();');
    await sleep(1500);
    const playing = await inPage(
      '({ t: document.querySelector(\'[data-mv-value="t"]\').textContent, pressed: document.querySelector(\'[data-mv-play="t"]\').getAttribute("aria-pressed") })',
    );
    console.log('playing:', JSON.stringify(playing));
    check(
      playing?.pressed === 'true' && Number(playing?.t) > 0.3,
      `Play runs t: ${JSON.stringify(playing)}`,
    );
    await page.screenshot({ path: path.join(OUT, 'app-playing.png') });
  }
} finally {
  await finish();
  await mock.close?.();
}
