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
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('dialog-focus-probe');

const focused = () =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName ?? null, testid: a?.getAttribute?.('data-testid') ?? null };
  });

await page.click('[data-testid="composer-input"]');
await page.keyboard.type('what can you do?');
await page.keyboard.press('Enter');

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
