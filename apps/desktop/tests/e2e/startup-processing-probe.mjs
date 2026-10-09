/**
 * startup-processing-probe.mjs — the user's "processing · 287.0s forever" bug.
 *
 * Verbatim: "no matter what on the startup of the application I click anywhere
 * and it shows me as if I sent a blank message, or not even a message. stays
 * there indefinitely."
 *
 * `showProcessing` already refuses to show the ring without a user message
 * (87eb79c), and that fix IS in the running build — so the interesting question
 * is which of its inputs is true on a thread nobody has touched. This launches
 * the real app cold, clicks around the way a person would, and dumps the exact
 * store state behind the ring at each step.
 *
 *   REAL=1   drive the real local model (default: mock-pi fixture)
 *   OUT      output dir
 *
 * Prints one STATE line per step; the bug is present when `processing` is true
 * while `users` is 0, or stays true for a thread with no in-flight turn.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(appRoot, '.corp-runs', 'startup-processing');
const REAL = process.env.REAL === '1';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

/*
 * A COPY of the real profile, not a fresh one.
 *
 * The first version of this probe used an empty `--user-data-dir` and could
 * never reproduce: users=0 at every step, ring never shown. The user's app has 80+
 * restored chats, and the ring appears there — so the trigger is in RESTORE, and
 * a cold profile is the one condition guaranteed to hide it. `UDD=<path>` points
 * at a copied profile; the original is never opened.
 */
const udd = process.env.UDD ?? mkdtempSync(path.join(tmpdir(), 'pd-startup-'));
const env = { ...process.env, PI_E2E_BACKGROUND: '1' };
if (!REAL) {
  env.PI_E2E = '1';
  env.PI_E2E_NO_SERVER = '1';
}

/** The exact inputs showProcessing() consumes, read straight from the store. */
const readState = `(() => {
  const s = window.__pi_store?.().getState?.() ?? {};
  const msgs = s.messages ?? [];
  const ring = document.body.innerText.match(/processing[^\\n]*/);
  return {
    users: msgs.filter((m) => m.kind === 'user').length,
    emptyUsers: msgs.filter((m) => m.kind === 'user' && !(m.text ?? '').trim()).length,
    total: msgs.length,
    promptInFlight: s.promptInFlight === true,
    isStreaming: s.isStreaming === true,
    runningTools: (s.runningToolCalls ?? []).length,
    ringText: ring ? ring[0] : null,
  };
})()`;

const app = await electron.launch({
  args: [appRoot, `--user-data-dir=${udd}`],
  executablePath: electronBinary,
  env,
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

const steps = [];
const snap = async (label) => {
  const state = await win.evaluate(readState);
  steps.push({ label, ...state });
  console.log(
    `STATE ${label.padEnd(22)} users=${state.users} empty=${state.emptyUsers} total=${state.total} ` +
      `inFlight=${state.promptInFlight} streaming=${state.isStreaming} tools=${state.runningTools} ` +
      `ring=${JSON.stringify(state.ringText)}`,
  );
  await win.screenshot({ path: path.join(OUT, `${label}.png`) });
};

await win.waitForTimeout(4000);
await snap('01-cold-open');

// "I click anywhere" — the thread body, the empty area, the composer blank.
await win.mouse.click(900, 400);
await win.waitForTimeout(1500);
await snap('02-click-thread');

await win.mouse.click(600, 300);
await win.waitForTimeout(1500);
await snap('03-click-again');

const composer = win.locator('[contenteditable="true"]').first();
if ((await composer.count()) > 0) {
  await composer.click();
  await win.waitForTimeout(1000);
  await snap('04-click-composer');
  // Enter on an EMPTY composer — the most literal reading of "blank message".
  await win.keyboard.press('Enter');
  await win.waitForTimeout(2000);
  await snap('05-empty-enter');
}

// Does it clear on its own, or stay forever as the user reports?
await win.waitForTimeout(20000);
await snap('06-after-20s');

writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify(steps, null, 2));
const stuck = steps.filter((s) => s.ringText !== null && s.users === 0);
console.log(
  stuck.length > 0
    ? `\nBUG REPRODUCED — ring shown with zero user messages at: ${stuck.map((s) => s.label).join(', ')}`
    : '\nring never appeared without a user message',
);
await app.close();
