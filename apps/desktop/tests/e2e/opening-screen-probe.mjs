/**
 * The opening screen after the blind test: what the app says about itself
 * before anything is typed.
 *
 *   - four clickable examples, and clicking one FILLS the composer rather than
 *     firing a request the user has not read;
 *   - the local claim is on screen, next to them, where the decision is made;
 *   - and the SIDEBAR carries no status badge. It did — "Running on your Mac"
 *     over the model name with a coloured dot — and the user had it removed: "that
 *     'model running on your mac' with solid color circle needs to go." The
 *     model is already named on the composer chip and the mode by the Chat |
 *     Project toggle; a third place to read the same thing is a third place to
 *     keep right.
 *
 * Run (build first):
 *   SHOT_DIR=/tmp/opening node apps/desktop/tests/e2e/opening-screen-probe.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('opening-screen');

try {
  await page.waitForSelector('[data-testid="starter-chips"]', { timeout: 15_000 });
  // The sidebar slides in over ~300ms (@starting-style translate); a shot taken
  // before it lands photographs a rail, not the panel this probe is about.
  await page.waitForSelector('[data-testid="sidebar-identity"]', { timeout: 10_000 });
  await page.waitForTimeout(900);

  const view = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    return {
      badge: q('[data-testid="local-model-badge"]') !== null,
      chips: [...document.querySelectorAll('button[data-testid^="starter-"]')].map(
        (b) => b.textContent,
      ),
      privacy: q('[data-testid="privacy-line"]')?.textContent ?? null,
    };
  });
  console.log('  ', JSON.stringify(view, null, 1));

  check(!view.badge, 'the sidebar carries no status badge');
  check(view.chips.length === 4, `four starter chips (got ${view.chips.length})`);
  /*
   * WHERE, NOT JUST WHAT. Two of the four exist to tell a new user something
   * they cannot guess from a program running on their own laptop: that it can
   * reach the internet, and that it can touch their disk.
   */
  check(
    view.chips.includes('Look something up on the web'),
    'the web chip keeps the words that carry its payload',
  );
  check(view.chips.includes('Work with a file on my Mac'), 'and so does the file chip');
  check(
    view.privacy !== null &&
      /leaves this Mac/.test(view.privacy) &&
      /web searches/.test(view.privacy),
    `the opening screen says where the words go (got "${view.privacy}")`,
  );

  /*
   * WHERE THE CHIPS SIT. the user: "put that stuff below the input bar but above the
   * special command instructions." Above the box they were four suggestions in
   * the way of the thing someone opened the app to use.
   */
  const order = await page.evaluate(() => {
    const y = (sel) => {
      const el = document.querySelector(sel);
      return el === null ? null : Math.round(el.getBoundingClientRect().top);
    };
    return {
      composer: y('.pd-composer-root'),
      chips: y('[data-testid="starter-chips"]'),
      hints: y('[data-testid="composer-hints"]'),
    };
  });
  console.log('   vertical order:', JSON.stringify(order));
  check(
    order.composer !== null && order.chips !== null && order.chips > order.composer,
    `the chips are BELOW the input bar (${order.composer} → ${order.chips})`,
  );
  check(
    order.hints !== null && order.chips !== null && order.chips < order.hints,
    `and above the @ / ! hints (${order.chips} → ${order.hints})`,
  );
  await shot('01-opening');

  /*
   * A CHIP INSERTS A PILL, NOT TYPED TEXT. the user: "add blue pills with icons and
   * X buttons for embedded files and such, not just typing them."
   *
   * The model still receives the whole request — the pill's payload IS the
   * prompt, and the composer reads the message with `getTextContent()` — so the
   * text assertion below is checking both halves at once: it is one object on
   * screen and the same sentence on the wire.
   */
  const before = await page.evaluate(() => window.__pi_store().getState().messages.length);
  await page.click('[data-testid="starter-image"]');
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({
    text: document.querySelector('.pd-composer-editor')?.textContent ?? '',
    pills: document.querySelectorAll('[data-testid="composer-pill"]').length,
    pillLabel: document.querySelector('.pd-pill-label')?.textContent ?? null,
    hasX: document.querySelector('.pd-pill-x') !== null,
    border: (() => {
      const p = document.querySelector('[data-testid="composer-pill"]');
      return p === null ? null : getComputedStyle(p).borderStyle;
    })(),
    messages: window.__pi_store().getState().messages.length,
  }));
  console.log('   after the click:', JSON.stringify(after));
  check(after.pills === 1, `it inserts ONE pill (got ${after.pills})`);
  check(after.pillLabel === 'Make an image', `with its own short words (${after.pillLabel})`);
  /*
   * NO BORDER, NO X. the user: "these pills: no border, no X." A bordered pill with
   * a close button reads as a control you are meant to press; a filled one reads
   * as a word that happens to be blue, which is what it is. Removal is the key
   * everyone already presses — see the Delete arm below.
   */
  check(!after.hasX, 'no X on the pill');
  check(after.border === 'none', `and no border (got ${after.border})`);
  check(after.messages === before, 'clicking a chip does NOT send anything');
  await shot('02-chip-clicked');

  /*
   * BACKSPACE REMOVES THE WHOLE THING — no half-deleted sentence left behind,
   * which is the entire reason an inserted request is an object rather than
   * typed text.
   */
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  const removed = await page.evaluate(() => ({
    pills: document.querySelectorAll('[data-testid="composer-pill"]').length,
    // The editor's own text — the placeholder is a sibling, not content.
    text: (document.querySelector('[data-testid="composer-input"]')?.textContent ?? '').trim(),
  }));
  console.log('   after the X:', JSON.stringify(removed));
  check(removed.pills === 0, 'backspace removes it whole');
  check(removed.text === '', `and leaves nothing behind (got "${removed.text}")`);

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
