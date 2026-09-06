/**
 * WHERE THE KEYBOARD IS AFTER A DIALOG GOES AWAY.
 *
 * the user's standing rule is that anything visual gets confirmed by looking, and
 * focus is visual — it is where the caret is and where the next keystroke lands.
 * So this does not stop at reading `document.activeElement`: it dismisses the
 * dialog, TYPES, and photographs the words arriving in the composer.
 *
 * The bug it pins: Radix returns focus to the dialog's TRIGGER, and a dialog
 * opened by the app rather than by a click has none. Worse, the one that made
 * this visible is never "closed" at all — AutoDownloadPrompt renders null the
 * moment the pending download is dismissed, so the whole Radix tree unmounts in
 * the same commit and the close path never runs. MEASURED before the fix: send
 * the first message in a fresh profile, press Escape, `activeElement` is BODY,
 * and everything typed next is dropped on the floor.
 *
 * A fresh profile has no model on disk, which is exactly what makes the prompt
 * appear — so this is the DEFAULT first-run experience, not a corner.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, REPO_ROOT } from './harness.mjs';

/*
 * A HOME OF ITS OWN, and that is the whole setup.
 *
 * The prompt appears because the router found no model on disk for the tier it
 * picked. The harness isolates the user-data dir but not HOME, so on a machine
 * with models downloaded the router is satisfied, nothing opens, and this probe
 * has nothing to test — which is exactly how it failed the first time it ran.
 * A throwaway home is a first run.
 */
const home = mkdtempSync(path.join(tmpdir(), 'pd-dialog-focus-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });

const { page, shot, check, finish } = await launchApp('dialog-focus-probe', {
  env: { HOME: home },
  // A plain streamed reply. The default tool-use fixture routes the turn
  // differently and the tier never resolves to one that needs downloading.
  fixture: path.join(REPO_ROOT, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json'),
});

const focused = () =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName ?? null, testid: a?.getAttribute?.('data-testid') ?? null };
  });

await page.click('[data-testid="composer-input"]');
await page.keyboard.type('hello there');
await page.keyboard.press('Enter');
await page.waitForSelector('text=Hello from mock-pi', { timeout: 15_000 });

/*
 * PARKING THE DOWNLOAD RATHER THAN WAITING FOR THE ROUTER TO PARK IT.
 *
 * The real trigger is the Auto router resolving to a tier that is not on disk,
 * and reaching that from here would mean pinning a classification out of the
 * mock harness — a lot of scaffolding for a precondition, and scaffolding that
 * breaks whenever the routing rules change. round4-probe already drives the
 * genuine path end to end and asserts the same handover.
 *
 * What this probe is for is the LOOK, so it puts the store in exactly the state
 * the router puts it in (`setPendingDownload`, the one call the router makes at
 * auto-router.ts:565) and photographs what happens next. Everything after this
 * line — the dialog mounting, taking focus, unmounting on Escape, and where the
 * keyboard lands — is the app's own behaviour, untouched.
 */
await page.evaluate(() => {
  window
    .__model_selection_store()
    .getState()
    .setPendingDownload({
      tier: 'balanced',
      pick: {
        modelId: 'qwen3.5-4b-mtp',
        displayName: 'Qwen3.5 4B',
        quant: 'Q8_0',
        launchMode: 'fast-text',
        vision: false,
        bytes: 4_800_000_000,
        downloaded: false,
      },
    });
});

const prompt = page.locator('[data-testid="auto-download-prompt"]');
await prompt.waitFor({ state: 'visible', timeout: 15_000 });
// Taking focus is correct — it is modal. Asserted so that the "after" below is a
// real handover rather than a dialog that never held the keyboard.
const during = await focused();
check(
  during.testid === 'auto-download-btn',
  `the modal should hold focus while it is up, got ${JSON.stringify(during)}`,
);
await shot('01-prompt-holds-focus');

await page.keyboard.press('Escape');
await prompt.waitFor({ state: 'detached', timeout: 5000 });

const after = await focused();
check(
  after.testid === 'composer-input',
  `dismissing the prompt left the keyboard at ${JSON.stringify(after)} — it belongs back in the composer`,
);

/*
 * THE PART THAT MAKES IT A VISUAL CONFIRMATION. `activeElement` being right and
 * the text actually landing are two different claims, and only the second is the
 * one a person would notice.
 */
const TYPED = 'and this is typed straight after dismissing it';
await page.keyboard.type(TYPED);
await page.waitForTimeout(250);
const inBox = await page.evaluate(
  () => document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
);
check(
  inBox.includes(TYPED),
  `the words went somewhere else — the composer holds ${JSON.stringify(inBox)}`,
);
const file = await shot('02-typing-lands-in-composer');
console.log(`[dialog-focus] the typed line is visible in the composer → ${path.basename(file)}`);

await finish();
