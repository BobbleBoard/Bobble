/**
 * DOES A MID-RUN MESSAGE ACTUALLY REACH THE MODEL?
 *
 * the user sent a steering prompt in the middle of a run and it "completely breaks
 * showing a different processing spinner that never clears and leaving it in the
 * conversation in the ui someplace where it was never actually put in context."
 *
 * Both halves are checked here, and BOTH are outcomes, not mechanism — reading
 * the IPC payload would have "proved" the old follow-up path worked too, because
 * it dispatched fine and was simply never drained:
 *
 *   1. CONTEXT   — a word that exists ONLY in the mid-run message comes back in
 *                  the model's own output. Nothing else in the conversation can
 *                  produce it, so this cannot pass by accident.
 *   2. SPINNER   — `promptInFlight` is false again a second after the send. It is
 *                  the flag that draws the endless "processing · 287.0s" ring, and
 *                  a steer joins a run that already started, so no `agent_start`
 *                  is ever coming to lower it.
 *
 * The first prompt is deliberately made of several slow bash calls: a steer is
 * delivered at a TURN BOUNDARY, so the probe needs boundaries to exist and needs
 * time to type between them.
 *
 *   node tests/e2e/steer-probe.mjs
 *   APP=/Applications/Bobble.app node …     # the shipped bundle
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.OUT ?? '/tmp/steer-probe';
/* A word with no other reason to appear anywhere in this conversation. */
const MAGIC = process.env.MAGIC ?? 'BOBBLEFISH';

const packaged = process.env.APP;
/* PI_E2E exposes `window.__pi_store` so promptInFlight can be READ. Audited
 * elsewhere: it only affects window bounds, that store opt-in, onboarding seeding
 * and a mac debug channel — nothing on the send path. */
const env = { ...process.env, PI_E2E: '1' };
const app = await electron.launch(
  packaged !== undefined
    ? { executablePath: `${packaged}/Contents/MacOS/Bobble`, env }
    : { executablePath: require('electron'), args: [appRoot], env },
);

const assistantText = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.pd-msg--assistant')].map((r) => r.textContent ?? '').join('\n'),
  );
const userTexts = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.pd-msg--user')].map((r) => (r.textContent ?? '').trim()),
  );
const inFlight = (win) =>
  win.evaluate(() => window.__pi_store?.().getState?.().promptInFlight ?? 'unreadable');
const streaming = (win) =>
  win.evaluate(() => window.__pi_store?.().getState?.().agent?.isStreaming ?? false);

const fail = [];

try {
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });

  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('llm:start-server', { modelId });
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
  }, MODEL);
  await win
    .waitForFunction(
      () => document.querySelector('[data-testid="composer-model-loading"]') === null,
      undefined,
      { timeout: 300_000 },
    )
    .catch(() => {});
  console.log('model warm');

  // A turn with SEVERAL tool boundaries, each slow enough to type through.
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(
    'Run these as three separate bash calls, one at a time, waiting for each: ' +
      '`sleep 4 && echo one`, then `sleep 4 && echo two`, then `sleep 4 && echo three`. ' +
      'Then tell me what they printed.',
  );
  await win.keyboard.press('Enter');

  /*
   * WAIT FOR REAL CONTENT before typing the steer. The composer deliberately
   * QUEUES a second message during the pre-first-token window (queueing there is
   * correct — a steer that early reorders the echoes), so sending too soon would
   * exercise the queue, not the steer, and the probe would prove nothing.
   */
  const contentBy = Date.now() + 180_000;
  let hasContent = false;
  while (Date.now() < contentBy) {
    if ((await assistantText(win)).trim().length > 20) {
      hasContent = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`assistant produced content: ${hasContent}`);
  if (!hasContent) fail.push('the first turn never produced anything to steer INTO');
  if (!(await streaming(win))) fail.push('the turn was already over — nothing was steered');
  await win.screenshot({ path: `${OUT}-01-midrun.png` }).catch(() => {});

  /*
   * WHICH QUEUE DID IT LAND IN? A run that finishes normally delivers a FOLLOW-UP
   * too, so "the word came back" alone cannot tell the fix from the bug — it only
   * fails once a run is aborted, which is the case that bit the user. pi's own
   * `queue_update` carries the two queues separately, so record it: that is pi
   * saying where the message went, not us saying where we sent it.
   */
  await win.evaluate(() => {
    window.__queueUpdates = [];
    window.piDesktop.onEvent('pi:event', (e) => {
      if (e?.type === 'queue_update') {
        window.__queueUpdates.push({ steering: e.steering ?? [], followUp: e.followUp ?? [] });
      }
    });
  });

  const steerText = `Actually, one more thing: include the word ${MAGIC} in your final answer.`;
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(steerText);
  await win.keyboard.press('Enter');
  const sentAt = Date.now();

  // THE SPINNER. Nothing lowers it for a steer except the dispatch itself, so
  // poll rather than sampling once — a single read cannot tell "never cleared"
  // from "had not dispatched yet", and those need different fixes.
  let flight = 'unreadable';
  let clearedAt = null;
  const flightBy = Date.now() + 20_000;
  while (Date.now() < flightBy) {
    flight = await inFlight(win);
    if (flight === false) {
      clearedAt = Date.now() - sentAt;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(
    `promptInFlight cleared after: ${clearedAt === null ? `NEVER (still ${flight})` : `${clearedAt}ms`}`,
  );
  if (clearedAt === null) fail.push(`promptInFlight is ${flight} — the endless spinner is back`);
  else if (clearedAt > 5000) fail.push(`the spinner ran for ${clearedAt}ms before clearing`);

  const users = await userTexts(win);
  console.log(`user rows: ${users.length}`);
  if (!users.some((t) => t.includes(MAGIC))) {
    fail.push('the steer is not on screen as a user message');
  }

  // THE CONTEXT. Let the run finish and look for the word in the model's output.
  const doneBy = Date.now() + 240_000;
  while (Date.now() < doneBy) {
    if (!(await streaming(win))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const out = await assistantText(win);
  const landed = out.includes(MAGIC);
  console.log(`run ended after ${((Date.now() - sentAt) / 1000).toFixed(1)}s`);
  console.log(`"${MAGIC}" in the model's output: ${landed}`);
  if (!landed) fail.push(`"${MAGIC}" never came back — the steer never entered context`);

  const queues = await win.evaluate(() => window.__queueUpdates ?? []);
  const inSteering = queues.some((q) => q.steering.some((m) => String(m).includes(MAGIC)));
  const inFollowUp = queues.some((q) => q.followUp.some((m) => String(m).includes(MAGIC)));
  console.log(
    `queue_update events: ${queues.length} · steering=${inSteering} followUp=${inFollowUp}`,
  );
  if (inFollowUp) fail.push('pi put it in the FOLLOW-UP queue — an aborted run drops that unread');
  if (!inSteering && queues.length > 0) fail.push('pi never reported it in the steering queue');
  await win.screenshot({ path: `${OUT}-02-final.png`, fullPage: true }).catch(() => {});

  console.log(`\nscreenshots -> ${OUT}-0{1,2}.png`);
  if (fail.length === 0) console.log('PASS — the mid-run message reached the model');
  else for (const f of fail) console.log(`FAIL — ${f}`);
  process.exitCode = fail.length === 0 ? 0 : 1;
} finally {
  await app.close();
}
