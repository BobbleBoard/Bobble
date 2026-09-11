/**
 * A GENERATION ASKED FOR IN CHAT, AND FILMED INLINE.
 *
 * the user: "one for each modality should be from the chat interface inline."
 *
 * The studio path and this one are genuinely different code: the studio calls
 * `gen:generate` directly, while here a chat model has to reach for a tool, the
 * thread has to mount a placeholder for the right modality, and the finished
 * media has to land in the conversation rather than in a results rail. Filming
 * it is the only way to show the loader that belongs to that placeholder.
 *
 *   MODEL=minicpm5-2b KIND=image PROMPT="..." OUT=/tmp/chat-image \
 *     node tests/e2e/gen-chat-capture.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron } from '@playwright/test';

const run = promisify(execFile);

const CHAT_MODEL = process.env.MODEL ?? 'minicpm5-2b';
const PROMPT = process.env.PROMPT ?? 'Make me a picture of a red paper boat.';
const OUT = process.env.OUT ?? '/tmp/chat-gen';
const FPS = Number(process.env.FPS ?? 10);
const DEADLINE = Number(process.env.DEADLINE_MS ?? 1_500_000);

// maxRetries: a previous run's ffmpeg may still be reading the directory,
// and an ENOTEMPTY here kills the capture before it has started.
rmSync(path.join(OUT, 'frames'), {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 200,
});
mkdirSync(path.join(OUT, 'frames'), { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'chat-cap-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_GEN: '1' },
});

let frames = 0;
let filming = false;
async function film(win) {
  const period = 1000 / FPS;
  while (filming) {
    const at = Date.now();
    try {
      await win.screenshot({
        path: path.join(OUT, 'frames', `f${String(frames).padStart(5, '0')}.jpg`),
        type: 'jpeg',
        quality: 72,
        scale: 'css',
      });
      frames += 1;
    } catch {
      break;
    }
    const left = period - (Date.now() - at);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
}

async function main() {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 40000,
  });
  await win.waitForTimeout(2000);

  const up = await win.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    CHAT_MODEL,
  );
  if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
  await win.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  const models = await win.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  await win.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  await win.evaluate(
    (id) =>
      window
        .__settings_store?.()
        .getState?.()
        .update?.({
          modelSelection: { mode: 'model', modelId: id },
        }),
    CHAT_MODEL,
  );
  /*
   * TOOL_INTERFACE=schemas puts `generate_image` in the advertised list.
   *
   * MEASURED in bash-CLI mode (the default): asked for a picture, MiniCPM5 2B
   * could not connect "media — Create images…" to "a command you run with
   * bash" and reasoned in circles about its function list; qwen3.5-4b got the
   * intent right ("I should use the media tool") and then wrote the request
   * into image-gen.txt — the coerced-write pattern, where the grammar pins an
   * unadvertised want to the nearest advertised name. Both are real findings
   * about the CLI interface and small models, and neither is a reason the
   * INLINE GENERATION path should go unfilmed.
   */
  if (process.env.TOOL_INTERFACE === 'schemas') {
    await win.evaluate(() =>
      window.piDesktop.invoke('settings:set', { patch: { toolInterface: 'schemas' } }),
    );
    await win.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
    await win.waitForTimeout(4000);
    say('tool interface: schemas');
  }
  /*
   * Power mode FULL, for the same reason the studio capture sets it — and here
   * it is not a nicety. Video is a HEAVY job, and the queue holds a heavy job
   * for as long as the power policy says the machine is under pressure; with a
   * chat model resident that can be indefinitely. MEASURED: the inline loader
   * came up and sat at "Loading" for twelve minutes having never posted a graph
   * to ComfyUI. This is the product's own knob, not a way round the policy.
   */
  await win.evaluate(() =>
    window.piDesktop.invoke('settings:set', { patch: { powerMode: 'full' } }),
  );
  await win.waitForTimeout(600);

  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForTimeout(2500);
  say(`chat model up: ${CHAT_MODEL}`);

  const ready = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return (
        !s.agent.isStreaming && !s.promptInFlight && s.bgRun?.streaming !== true && !s.resuming
      );
    });
  for (let i = 0; i < 40 && !(await ready()); i += 1) await win.waitForTimeout(500);

  filming = true;
  const filmDone = film(win);

  const editor = win.locator('[contenteditable="true"]').first();
  await editor.click();
  await win.keyboard.type(PROMPT, { delay: 8 });
  await win.waitForTimeout(400);
  await win.keyboard.press('Enter');
  say(`sent: ${PROMPT}`);

  let shotLoader = false;
  let lastMsgs = -1;
  let state = {};
  const deadline = Date.now() + DEADLINE;
  while (Date.now() < deadline) {
    // Every poll can find the window gone — the app quit, or something rebuilt
    // `dist-electron` underneath it and a lazy import failed. That is worth
    // saying plainly and keeping the film for, not throwing out of the loop and
    // losing both the frames and the reason.
    try {
      await win.waitForTimeout(2000);
    } catch {
      state = { gone: true };
      break;
    }
    state = await win
      .evaluate(() => {
        const loader = document.querySelector('[data-testid="bobble-loader"]');
        return {
          loader: loader?.dataset?.variant ?? null,
          pct: document.querySelector('[data-testid="bobble-pct"]')?.textContent ?? null,
          media: document.querySelectorAll(
            '.pd-thread-media img, .pd-thread-media video, [data-testid="thread-audio"], .pd-prose img',
          ).length,
          cards: document.querySelectorAll('[data-testid="thread-file-card"]').length,
          streaming: window.__pi_store().getState().agent.isStreaming === true,
          msgs: window.__pi_store().getState().messages.length,
        };
      })
      .catch(() => ({ gone: true }));
    if (state.gone) break;
    // Say what the model is DOING while it does it. A run that produces no
    // loader is either a model that never reached for the tool or a job held
    // before it was posted, and those need completely different fixes — which
    // was unknowable from a log that only printed at the end.
    if (state.msgs !== lastMsgs) {
      lastMsgs = state.msgs;
      const tail = await win
        .evaluate(() => {
          const ms = window.__pi_store().getState().messages;
          const m = ms[ms.length - 1];
          return m === undefined
            ? null
            : { kind: m.kind, tool: m.toolName ?? m.name, text: (m.text ?? '').slice(0, 90) };
        })
        .catch(() => null);
      say(`msg ${state.msgs}: ${JSON.stringify(tail)}`);
    }
    if (!shotLoader && state.loader !== null) {
      await win.screenshot({ path: path.join(OUT, '02-loader.png') });
      shotLoader = true;
      say(`inline loader up (variant=${state.loader}, ${state.pct})`);
    }
    if (!state.streaming && (state.media > 0 || state.cards > 0) && state.msgs > 1) {
      const settled = await ready();
      if (settled) break;
    }
  }
  say(`RESULT ${JSON.stringify(state)}`);
  filming = false;
  await filmDone;
  // The window may be gone — a heavy chat model beside a video engine is enough
  // for macOS to pick one of them. The frames are still worth keeping, and the
  // reason is worth printing, so nothing past here may throw out of the run.
  if (state.gone === true) {
    say('window closed before the run finished — filming what there was');
    return;
  }
  await win.waitForTimeout(800);
  await win.screenshot({ path: path.join(OUT, '03-done.png'), fullPage: true });
  const msgs = await win.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.map((m) => ({
        kind: m.kind,
        tool: m.toolName ?? m.name,
        text: (m.text ?? '').slice(0, 140),
      })),
  );
  console.log(JSON.stringify(msgs, null, 1));
}

try {
  await main();
} finally {
  filming = false;
  await app.close().catch(() => {});
}

const dir = path.join(OUT, 'frames');
if (frames > 2) {
  const mp4 = path.join(OUT, 'generation.mp4');
  await run('ffmpeg', [
    '-y',
    '-framerate',
    String(FPS),
    '-i',
    path.join(dir, 'f%05d.jpg'),
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    mp4,
  ]).catch((e) => console.error('ffmpeg failed', e.message));
  if (existsSync(mp4)) {
    say(`film: ${mp4} (${(statSync(mp4).size / 1e6).toFixed(1)} MB, ${frames} frames)`);
    if (process.env.KEEP_FRAMES !== '1') rmSync(dir, { recursive: true, force: true });
  }
}
