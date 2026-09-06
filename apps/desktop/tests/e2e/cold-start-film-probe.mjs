/**
 * WHAT A COLD START ACTUALLY LOOKS LIKE, frame by frame.
 *
 * the user: "visually check things out by opening the app and then immediately
 * taking a screenshot after you send a message, maybe every .5 seconds then
 * until the generation completes… from cold load, immediately after opening app
 * simulating user clicking on app and immediately firing in a question."
 *
 * This is not an assertion probe. It is a camera. Every other probe in this
 * suite starts the model server itself and waits for it to be ready before it
 * does anything — which means the whole of the app's first thirty seconds, the
 * part every user sees every time, has never been looked at. The interesting
 * failures there are not errors: they are a spinner that says the wrong thing, a
 * layout that jumps, a control that is enabled before it works, a message that
 * appears to have gone nowhere.
 *
 * SO IT TYPES BEFORE THE APP IS READY, on purpose. No `llm:start-server`, no
 * waiting for `serverRunning` — the app is left to do what it does when someone
 * double-clicks it and starts typing, which is exactly when its preload
 * (ChatApp: "the FASTEST downloaded model… a no-op unless Auto") is still
 * running. Auto is left on for the same reason: pinning a model would skip the
 * preload path and test something no user is in.
 *
 *   MODE=simple|multistep   which question (default simple)
 *   OUT=<dir>               where the film goes
 *   CAP_MS=<ms>             give up after this long
 *
 * Writes `frames/NNN-<ms>.png` plus `film.json` and a printed timeline, so the
 * frames worth opening can be picked out of the state rather than by scrubbing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const MODE = process.env.MODE ?? 'simple';
const OUT = process.env.OUT ?? path.join(tmpdir(), `cold-start-${MODE}`);
const CAP_MS = Number(process.env.CAP_MS ?? (MODE === 'simple' ? 240_000 : 600_000));
const FRAMES = path.join(OUT, 'frames');
mkdirSync(FRAMES, { recursive: true });

const QUESTION =
  MODE === 'simple'
    ? 'In one sentence, what is the capital of France?'
    : 'Make a folder called demo. Put hello.txt in it containing the word hi, and notes.md containing a one-line summary. Then list what you made.';

const { page, check, finish } = await launchApp('cold-start-film-probe', {
  // The real engine and the real harness: mock-pi has no model to load, so it
  // has no cold start to film.
  env: { PI_BIN: undefined },
  realCache: true,
  timeout: 120_000,
});

/** Everything worth knowing about one frame, cheap enough to read every 500ms. */
const snapshot = () =>
  page.evaluate(() => {
    const pi = window.__pi_store().getState();
    const llm = window.__llm_store?.().getState?.();
    const text = (el) => (el === null ? null : (el.textContent ?? '').trim().slice(0, 80));
    const last = pi.messages[pi.messages.length - 1];
    const assistantChars =
      last?.kind === 'assistant'
        ? (last.blocks ?? []).reduce((n, b) => n + ((b.text ?? b.thinking ?? '') || '').length, 0)
        : 0;
    const composer = document.querySelector('[data-testid="composer-input"]');
    const send = document.querySelector('[data-testid="composer-send"]');
    return {
      phase: llm?.status?.phase ?? null,
      serverRunning: llm?.status?.serverRunning ?? null,
      loadedModel: llm?.status?.model?.id ?? null,
      engineBuild: llm?.status?.engineBuild?.note ?? null,
      streaming: pi.agent?.isStreaming === true,
      messages: pi.messages.length,
      assistantChars,
      // What a person would actually see and read.
      loadingLabel: text(document.querySelector('[data-testid="composer-model-loading"]')),
      statusLine: text(document.querySelector('.pd-working-label')),
      thinkingRow: text(document.querySelector('[data-testid="chat-activity"], .pd-chain-step')),
      toast: text(document.querySelector('.pd-toast')),
      dialog: document.querySelector('[role="dialog"]')?.getAttribute('data-testid') ?? null,
      composerEnabled: composer !== null && composer.getAttribute('contenteditable') !== 'false',
      sendDisabled: send === null ? null : send.hasAttribute('disabled'),
      composerText: text(composer),
      // Layout stability: the thread's top edge and the composer's, so a jump
      // between frames is visible in the numbers as well as in the pictures.
      threadTop: Math.round(
        document.querySelector('[data-testid="chat-scroll"]')?.getBoundingClientRect().top ?? -1,
      ),
      composerTop: Math.round(
        document.querySelector('.pd-composer')?.getBoundingClientRect().top ?? -1,
      ),
    };
  });

/*
 * THE CLICK-AND-TYPE. Deliberately the first thing that happens after the
 * composer exists — no settling, no waiting for a model, because the whole point
 * is what the app does when it is not ready yet.
 */
const appeared = Date.now();
await page.click('[data-testid="composer-input"]');
await page.keyboard.type(QUESTION);
const sentAt = Date.now();
await page.keyboard.press('Enter');
console.log(
  `[film] ${MODE}: composer was ready ${sentAt - appeared}ms after launch; question sent`,
);

const film = [];
let frame = 0;
let sawStreaming = false;
let finishedAt = null;
for (;;) {
  const at = Date.now() - sentAt;
  const state = await snapshot();
  const file = path.join(
    FRAMES,
    `${String(frame).padStart(3, '0')}-${String(at).padStart(6, '0')}ms.png`,
  );
  await page.screenshot({ path: file });
  film.push({ frame, at, ...state });
  if (state.streaming) sawStreaming = true;
  // "Generation completes" = it started, then stopped, and something was said.
  if (sawStreaming && !state.streaming && state.assistantChars > 0) {
    finishedAt = at;
    break;
  }
  if (at > CAP_MS) break;
  frame += 1;
  await page.waitForTimeout(500);
}

writeFileSync(path.join(OUT, 'film.json'), `${JSON.stringify(film, null, 2)}\n`);

/*
 * The timeline, printed only where something CHANGED. A frame-by-frame dump of
 * 200 identical rows hides the three that matter.
 */
const key = (f) =>
  JSON.stringify([
    f.phase,
    f.serverRunning,
    f.loadedModel,
    f.streaming,
    f.messages,
    f.loadingLabel,
    f.statusLine,
    f.thinkingRow,
    f.toast,
    f.dialog,
    f.composerEnabled,
    f.sendDisabled,
    f.threadTop,
    f.composerTop,
    f.assistantChars > 0,
  ]);
console.log(`\n[film] ${film.length} frames over ${film[film.length - 1]?.at}ms — changes only:`);
let prev = null;
for (const f of film) {
  const k = key(f);
  if (k === prev) continue;
  prev = k;
  console.log(
    `  ${String(f.at).padStart(6)}ms  phase=${f.phase} server=${f.serverRunning} model=${f.loadedModel ?? '-'} streaming=${f.streaming} msgs=${f.messages} chars=${f.assistantChars}` +
      `${f.loadingLabel ? ` loading="${f.loadingLabel}"` : ''}` +
      `${f.statusLine ? ` status="${f.statusLine}"` : ''}` +
      `${f.thinkingRow ? ` activity="${f.thinkingRow}"` : ''}` +
      `${f.toast ? ` TOAST="${f.toast}"` : ''}` +
      `${f.dialog ? ` DIALOG=${f.dialog}` : ''}` +
      ` composer=${f.composerEnabled ? 'on' : 'OFF'} send=${f.sendDisabled === null ? '-' : f.sendDisabled ? 'disabled' : 'on'}` +
      ` threadTop=${f.threadTop} composerTop=${f.composerTop}`,
  );
}

// A few things worth calling out rather than leaving in the numbers.
const firstChars = film.find((f) => f.assistantChars > 0);
const serverUp = film.find((f) => f.serverRunning === true);
console.log(
  `\n[film] server ready at ${serverUp ? `${serverUp.at}ms` : 'never'} · first visible token at ${firstChars ? `${firstChars.at}ms` : 'never'} · finished at ${finishedAt ?? 'not within cap'}ms`,
);
const tops = new Set(film.map((f) => f.composerTop));
console.log(`[film] composer sat at ${[...tops].join(', ')} (a set of one = no layout jump)`);
console.log(`[film] frames: ${FRAMES}`);

check(finishedAt !== null, `generation did not complete within ${CAP_MS}ms`);
await finish();
