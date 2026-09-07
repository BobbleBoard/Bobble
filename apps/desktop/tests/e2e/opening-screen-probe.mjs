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

  await shot('01-opening');

  // Clicking fills the box; it must NOT send.
  const before = await page.evaluate(() => window.__pi_store().getState().messages.length);
  await page.click('[data-testid="starter-image"]');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    text: document.querySelector('.pd-composer-editor')?.textContent ?? '',
    messages: window.__pi_store().getState().messages.length,
  }));
  console.log(`   composer now: "${after.text.slice(0, 60)}"`);
  check(after.text.length > 20, 'clicking a chip fills the composer with a whole request');
  check(after.messages === before, 'clicking a chip does NOT send anything');
  await shot('02-chip-clicked');

  console.log(`\nshots → ${shotDir}`);
} finally {
  await finish();
}
