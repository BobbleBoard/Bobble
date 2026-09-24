/**
 * A HYPERFRAMES TITLE CARD SHOWS THE TITLE, NOT THE PROMPT (VQ-11 lite).
 *
 * REAL, twice: the user asked for "10-second animated title card with the text
 * 'Launch day' in bright yellow bold letters centered on a dark gradient
 * background with subtle pulse animation", and got that whole sentence, white
 * on navy, as the title — "bright yellow" ignored, and a poster (what the
 * model sees) of frame 0: the paragraph at a third of its opacity.
 *
 * This renders the real prompt, the research brief's Tidewell card, a plain
 * title and an authored scene through the REAL renderer (this tree's source,
 * bundled at the top of the run) in an offscreen window of the hidden app, and
 * checks what a person would: the words on the card are exactly the quoted
 * ones, the asked-for colour is on them, and the poster is the frame the card
 * settles to. A contact sheet of each render (six frames + the poster) is
 * written for looking at, and the "Launch day" card is put through the real
 * generate_video tool into the chat thread and photographed there, in the
 * light and the dark theme.
 *
 *   SHOT_DIR=/tmp/hf-title node tests/e2e/hyperframes-title-look.mjs
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, launchApp, probeHome, REPO_ROOT } from './harness.mjs';

const OUT = process.env.SHOT_DIR ?? path.join(tmpdir(), 'hf-title');
mkdirSync(OUT, { recursive: true });

const esbuild = [
  path.join(APP_ROOT, 'node_modules/.bin/esbuild'),
  path.join(REPO_ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild'),
].find((p) => existsSync(p));
if (esbuild === undefined) throw new Error('esbuild not found (run pnpm install)');
const entry = path.join(OUT, 'probe-entry.mjs');
writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(path.join(APP_ROOT, 'electron/gen/hyperframes-still.ts'))};`,
    `export { defaultExtractPosterFrame } from ${JSON.stringify(path.join(APP_ROOT, 'electron/gen/video-dispatch.ts'))};`,
    `export { registerGenTools } from ${JSON.stringify(path.join(REPO_ROOT, 'packages/gen-tools/src/tools.ts'))};`,
  ].join('\n'),
);
const bundle = path.join(OUT, 'probe-bundle.mjs');
execFileSync(
  esbuild,
  [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${bundle}`,
    '--external:@mariozechner/*',
    '--external:electron',
    '--log-level=error',
  ],
  { cwd: APP_ROOT },
);
const src = await import(pathToFileURL(bundle).href);

const CASES = [
  {
    id: 'launch-day-real',
    prompt:
      "10-second animated title card with the text 'Launch day' in bright yellow bold letters centered on a dark gradient background with subtle pulse animation",
    seconds: 10,
    text: 'Launch day',
    colour: 'yellow',
  },
  {
    id: 'tidewell-brief',
    prompt:
      'Make a 6-second animated title card for our product launch: "Tidewell" with the tagline "Stop leaks before they start", in our brand teal.',
    seconds: 6,
    text: 'Tidewell\nStop leaks before they start',
    colour: 'teal',
  },
  {
    id: 'plain-title',
    prompt: 'Bobble makes motion graphics',
    seconds: 4,
    text: 'Bobble makes motion graphics',
  },
];

/**
 * Prompts with no words to show: the renderer must SAY so (the message names the
 * fix) and draw nothing — never a card of the instruction (the old behaviour).
 */
const REFUSALS = [
  { id: 'no-words', prompt: 'a bold title card that slides in and glows', says: /in quotes/ },
  {
    id: 'radar-description',
    prompt: 'an animated radar chart of my skills: speed 8, power 6, range 9',
    says: /from HTML, not from a description/,
  },
];

/** Roughly which colour family a CSS colour is (for "was the asked-for colour used"). */
function family(css) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css ?? '');
  if (m === null) return 'unknown';
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (r > 180 && g > 150 && b < 110) return 'yellow';
  if (g > 110 && b > 100 && r < 120) return 'teal';
  if (r > 200 && g > 200 && b > 200) return 'white';
  return `rgb(${r},${g},${b})`;
}

// Media the thread shows must live under the app's home (the pd-file scheme's roots).
const home = probeHome('hf-title');
const { app, page, check, finish, shotDir } = await launchApp('hf-title', {
  env: { HOME: home, PI_DESKTOP_GEN: '1' },
  args: ['--', '--piE2E=1'],
  timeout: 40_000,
});

/** hyperframes-window.ts's window, made in the running app; `dom()` reads the settled card. */
function openWindowInApp(record) {
  return async (width, height) => {
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => {
        const win = new BrowserWindow({
          width: w,
          height: h,
          show: false,
          frame: false,
          webPreferences: {
            offscreen: true,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false,
          },
        });
        win.webContents.setZoomFactor(1);
        globalThis.__hfTitleWin = win;
        globalThis.__hfTitleSize = { width: w, height: h };
      },
      [width, height],
    );
    return {
      load: async (html) => {
        record.html = html;
        await app.evaluate(async (_e, doc) => {
          await globalThis.__hfTitleWin.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(doc)}`,
          );
          await new Promise((r) => setTimeout(r, 150));
        }, html);
      },
      evaluate: async (script) => {
        const out = await app.evaluate(
          (_e, s) => globalThis.__hfTitleWin.webContents.executeJavaScript(s, true),
          script,
        );
        // After each seek: what the card says, and in what colour (the last read wins).
        record.dom = await app.evaluate(() =>
          globalThis.__hfTitleWin.webContents.executeJavaScript(
            `(() => {
              const t = document.body.innerText.trim();
              const h = document.querySelector('h1, [data-hf-title]');
              return { text: t, colour: h ? getComputedStyle(h).color : null };
            })()`,
            true,
          ),
        );
        return out;
      },
      capture: async () =>
        Buffer.from(
          await app.evaluate(async () => {
            const image = await globalThis.__hfTitleWin.webContents.capturePage();
            const { width: w, height: h } = globalThis.__hfTitleSize;
            const size = image.getSize();
            const out =
              size.width > w || size.height > h
                ? image.resize({ width: w, height: h, quality: 'best' })
                : image;
            return out.toPNG().toString('base64');
          }),
          'base64',
        ),
      dispose: () =>
        app.evaluate(() => {
          const win = globalThis.__hfTitleWin;
          if (win !== undefined && !win.isDestroyed()) win.destroy();
          globalThis.__hfTitleWin = undefined;
        }),
    };
  };
}

async function renderSheet(html, width, height) {
  // A file, not a data: URL — a sheet of inlined PNGs is past Chromium's URL limit.
  const file = path.join(OUT, 'sheet.html');
  writeFileSync(file, html);
  const b64 = await app.evaluate(
    async ({ BrowserWindow }, [doc, w, h]) => {
      const win = new BrowserWindow({
        width: w,
        height: h,
        show: false,
        frame: false,
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
      });
      try {
        win.webContents.setZoomFactor(1);
        await win.loadFile(doc);
        await new Promise((r) => setTimeout(r, 300));
        const image = await win.webContents.capturePage();
        const size = image.getSize();
        return (size.width > w ? image.resize({ width: w, height: h, quality: 'best' }) : image)
          .toPNG()
          .toString('base64');
      } finally {
        win.destroy();
      }
    },
    [file, width, height],
  );
  return Buffer.from(b64, 'base64');
}

const INSTRUCTION_WORDS =
  /\b(second|animated|animation|title card|background|gradient|letters|centered|pulse|tagline|make)\b/i;

/** The real prompt's render, kept for the thread: { prompt, outputs, poster }. */
let launchDay = null;

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', undefined, {
    timeout: 30_000,
  });
  await new Promise((r) => setTimeout(r, 1500));
  const rows = [];
  for (const c of CASES) {
    const outputDir =
      c.id === 'launch-day-real'
        ? path.join(home, 'Bobble', 'generated', 'launch-day')
        : mkdtempSync(path.join(tmpdir(), `hf-title-${c.id}-`));
    mkdirSync(outputDir, { recursive: true });
    const record = {};
    let outputs = null;
    let error = null;
    try {
      outputs = await src.createStillRenderer({
        openWindow: openWindowInApp(record),
        writeFile: (file, data) => writeFile(file, data),
      })(
        {
          prompt: c.prompt,
          modelId: 'hyperframes',
          width: 640,
          height: 360,
          seconds: c.seconds,
          fps: 12,
          seeds: [1],
        },
        outputDir,
        () => {},
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const framesDir = path.join(outputDir, 'frames');
    const frames = existsSync(framesDir)
      ? readdirSync(framesDir)
          .filter((f) => f.endsWith('.png'))
          .sort()
      : [];
    const animation = outputs?.[0]?.outputPath;
    const poster =
      animation !== undefined
        ? await src.defaultExtractPosterFrame(animation, outputDir)
        : undefined;
    const last = frames.length > 0 ? readFileSync(path.join(framesDir, frames.at(-1))) : null;
    const posterBytes = poster !== undefined ? readFileSync(poster) : null;
    if (c.id === 'launch-day-real' && outputs !== null && poster !== undefined) {
      launchDay = { prompt: c.prompt, outputs, poster };
    }
    const text = record.dom?.text ?? '';
    const colour = family(record.dom?.colour);
    console.log(
      `${c.id}: ${frames.length} frames${error ? ` ERROR ${error}` : ''}; DOM ${JSON.stringify(text)}; title colour ${colour}; poster ${poster ? path.basename(poster) : 'none'} = last frame: ${posterBytes !== null && last !== null && posterBytes.equals(last)}`,
    );
    check(error === null, `${c.id}: the render failed: ${error}`);
    check(
      text === c.text,
      `${c.id}: the card says ${JSON.stringify(text)}, not ${JSON.stringify(c.text)}`,
    );
    check(
      !INSTRUCTION_WORDS.test(text),
      `${c.id}: instruction words on the card: ${JSON.stringify(text)}`,
    );
    if (c.colour !== undefined) {
      check(colour === c.colour, `${c.id}: the title is ${colour}, not the ${c.colour} asked for`);
    }
    check(
      posterBytes !== null && last !== null && posterBytes.equals(last),
      `${c.id}: the poster is not the settled (last) frame`,
    );
    // Six frames across the render, then the poster.
    const picks = [0, 0.2, 0.4, 0.6, 0.8, 1].map(
      (f) => frames[Math.min(frames.length - 1, Math.round(f * (frames.length - 1)))],
    );
    const cells = picks
      .filter((f) => f !== undefined)
      .map(
        (f) =>
          `<figure><img src="data:image/png;base64,${readFileSync(path.join(framesDir, f)).toString('base64')}"><figcaption>${f}</figcaption></figure>`,
      )
      .concat(
        posterBytes !== null
          ? `<figure class="poster"><img src="data:image/png;base64,${posterBytes.toString('base64')}"><figcaption>poster (what the model sees)</figcaption></figure>`
          : '',
      )
      .join('');
    rows.push(
      `<section><h2>${c.id}</h2><p class="prompt">${c.prompt.replace(/</g, '&lt;')}</p><div class="strip">${cells}</div><p class="dom">DOM text: ${JSON.stringify(text).replace(/</g, '&lt;')} · title colour ${colour}</p></section>`,
    );
  }
  for (const r of REFUSALS) {
    const outputDir = mkdtempSync(path.join(tmpdir(), `hf-title-${r.id}-`));
    const record = {};
    let error = null;
    try {
      await src.createStillRenderer({
        openWindow: openWindowInApp(record),
        writeFile: (file, data) => writeFile(file, data),
      })(
        {
          prompt: r.prompt,
          modelId: 'hyperframes',
          width: 640,
          height: 360,
          seconds: 3,
          fps: 12,
          seeds: [1],
        },
        outputDir,
        () => {},
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const framesDir = path.join(outputDir, 'frames');
    const drawn = existsSync(framesDir)
      ? readdirSync(framesDir).filter((f) => f.endsWith('.png')).length
      : 0;
    console.log(`${r.id}: ${drawn} frames; refused: ${JSON.stringify(error)}`);
    check(error !== null && r.says.test(error), `${r.id}: not refused with the fix: ${error}`);
    check(drawn === 0 && record.html === undefined, `${r.id}: drew ${drawn} frames of a guess`);
    rows.push(
      `<section><h2>${r.id} (refused)</h2><p class="prompt">${r.prompt.replace(/</g, '&lt;')}</p><p class="dom">${drawn} frames · the job fails with: ${(error ?? '').replace(/</g, '&lt;')}</p></section>`,
    );
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: #202024; color: #eee; font-family: -apple-system, sans-serif; }
    body { padding: 12px; }
    section { margin-bottom: 14px; }
    h2 { font-size: 15px; margin: 0 0 4px; }
    .prompt, .dom { font-size: 11px; color: #bbb; margin: 2px 0 6px; }
    .strip { display: flex; gap: 6px; }
    figure { margin: 0; }
    figure img { width: 256px; height: 144px; display: block; border-radius: 4px; }
    figure.poster img { outline: 2px solid #F5C518; }
    figcaption { font-size: 10px; color: #999; margin-top: 2px; }
  </style></head><body>${rows.join('')}</body></html>`;
  const png = await renderSheet(html, 24 + 7 * 262, 24 + CASES.length * 232 + REFUSALS.length * 72);
  writeFileSync(path.join(shotDir, 'title-cards.png'), png);
  console.log(`sheet: ${path.join(shotDir, 'title-cards.png')}`);

  // ── the card in the chat, as the user would see it ──────────────────────────────
  check(launchDay !== null, 'the "Launch day" render is missing, so the thread cannot show it');
  if (launchDay !== null) {
    const tools = new Map();
    src.registerGenTools(
      { registerTool: (def) => tools.set(def.name, def) },
      {
        bridge: {
          request: async (method) => {
            if (method !== 'generateVideo') throw new Error(`unexpected ${method}`);
            return {
              jobId: 'probe',
              outputs: launchDay.outputs,
              posterFramePath: launchDay.poster,
            };
          },
        },
      },
    );
    const result = await tools
      .get('generate_video')
      .execute('c1', { prompt: launchDay.prompt, model: 'hyperframes' }, undefined, undefined, {});
    const toolText = result.content.find((c) => c.type === 'text')?.text ?? '';
    writeFileSync(path.join(shotDir, 'launch-day-tool-result.txt'), `${toolText}\n`);
    await page.evaluate(
      ([ask, text]) => {
        const now = Date.now();
        window.__pi_store().setState({
          messages: [
            { kind: 'user', id: 'u1', text: ask, timestamp: now },
            {
              kind: 'assistant',
              id: 'a1',
              timestamp: now,
              isStreaming: false,
              blocks: [
                {
                  type: 'toolCall',
                  id: 'c1',
                  name: 'generate_video',
                  arguments: { prompt: ask, model: 'hyperframes' },
                },
              ],
            },
            {
              kind: 'toolResult',
              id: 'tr-a1-c1',
              toolCallId: 'c1',
              assistantId: 'a1',
              toolName: 'generate_video',
              text,
              isError: false,
              timestamp: now,
            },
          ],
          runningToolCalls: [],
          streaming: false,
        });
      },
      [launchDay.prompt, toolText],
    );
    await page.waitForSelector('[data-testid="media-card"] img[data-testid="media-image"]', {
      timeout: 20_000,
    });
    // Past the entrance and into the hold, so the photograph is the settled card.
    await page.waitForTimeout(2500);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-mode', t), theme);
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(shotDir, `thread-${theme}.png`) });
      const card = page.locator('[data-testid="media-card"]').first();
      const box = await card.boundingBox();
      if (box !== null) {
        await page.screenshot({
          path: path.join(shotDir, `card-${theme}.png`),
          clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 },
        });
      }
      console.log(`thread (${theme}): ${path.join(shotDir, `thread-${theme}.png`)}`);
    }
    // The throwaway home goes at finish(): keep what the model was shown.
    copyFileSync(launchDay.poster, path.join(shotDir, 'poster-launch-day.png'));
  }
} finally {
  await finish();
}
