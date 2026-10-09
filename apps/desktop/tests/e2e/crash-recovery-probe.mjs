/**
 * THE WAY OUT OF THE CRASH CARD, AND ⌘R.
 *
 * The user, on the "Bobble hit a rendering error" screen: the two buttons "do not
 * work", the user has to press ⌘R, and ⌘R "clears really everything".
 *
 * Both were true. `window.location.reload()` and `window.location.search = ''`
 * are renderer-initiated navigations, which main refuses on purpose
 * (`will-navigate` → preventDefault), so the buttons were inert; and ⌘R was
 * Electron's stock `reload` role, which throws the document away — thread,
 * canvas tabs, scroll position and all.
 *
 * This drives the whole recovery for real:
 *
 *   1. build a conversation with a canvas tab open and the thread scrolled
 *      somewhere in the middle;
 *   2. ⌘R (the menu accelerator, through main) — assert the chat, the tab and
 *      the scroll position all survive;
 *   3. force the boundary (`window.__pi_crash()`, the test seam) and assert the
 *      crash card appears;
 *   4. click "Reload" — assert the app comes back WITH the conversation and the
 *      canvas tab still there;
 *   5. crash again and click "Reload with a fresh window" — assert the document
 *      really does reload.
 *
 * Invisible (harness.mjs).
 */
import { launchApp } from './harness.mjs';

const { app, page, shot, check, finish } = await launchApp('crash-recovery');

await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });

/** A conversation long enough to have a scroll position worth keeping. */
await page.evaluate(() => {
  const messages = [];
  for (let i = 0; i < 40; i += 1) {
    messages.push({ kind: 'user', id: `u${i}`, text: `question number ${i}`, timestamp: i * 2 });
    messages.push({
      kind: 'assistant',
      id: `a${i}`,
      timestamp: i * 2 + 1,
      isStreaming: false,
      blocks: [{ type: 'text', text: `answer number ${i} — ${'lorem ipsum '.repeat(12)}` }],
    });
  }
  window.__pi_store().setState({ messages });
});
await page.waitForTimeout(900);

// A canvas tab, so there is view-owned state that a document reload would lose.
await page.evaluate(() => {
  window.__pi_canvas?.().openTab({
    kind: 'code',
    key: 'recovery-fixture',
    title: 'keep-me.ts',
    artifact: { id: 'keep-me', content: { kind: 'code', text: 'const kept = true;\n' } },
  });
});
await page.waitForTimeout(700);

// Park the thread in the middle.
await page.evaluate(() => {
  const el = document.querySelector('[data-testid="chat-scroll"]');
  if (el !== null) el.scrollTop = Math.round(el.scrollHeight / 2);
});
await page.waitForTimeout(400);

const snapshot = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    return {
      messages: window.__pi_store().getState().messages.length,
      tabs: (window.__pi_canvas?.().getState().tabs ?? []).map((t) => t.title),
      scrollTop: Math.round(el?.scrollTop ?? 0),
      crashed: document.querySelector('[data-testid="app-crash"]') !== null,
      generation: window.__pi_reload_gen?.() ?? -1,
    };
  });

const before = await snapshot();
console.log('before:', JSON.stringify(before));
await shot('01-before');
check(before.messages === 80, `the fixture did not load (${before.messages} messages)`);
check(before.tabs.includes('keep-me.ts'), 'the canvas tab did not open');
check(before.scrollTop > 100, `the thread did not scroll (${before.scrollTop})`);

/*
 * ── ⌘R: the safe reload ───────────────────────────────────────────────────
 *
 * Invoked through the MENU ITEM rather than by typing the chord: a synthetic
 * key event from Playwright never reaches macOS's native menu bar, so pressing
 * Meta+R here proves nothing (it silently did nothing, and every assertion
 * below passed on an app that had not reloaded). Clicking the item is the same
 * code path the accelerator runs.
 */
const menu = await app.evaluate(async ({ Menu }) => {
  const item = Menu.getApplicationMenu()?.getMenuItemById('safe-reload');
  if (item === undefined || item === null) return null;
  item.click();
  return { label: item.label, accelerator: item.accelerator };
});
console.log('menu item:', JSON.stringify(menu));
check(menu !== null, 'the View menu has no Reload item');
check(menu?.accelerator === 'CmdOrCtrl+R', `Reload is not on ⌘R (${menu?.accelerator})`);
await page.waitForTimeout(1600);
const afterCmdR = await snapshot();
console.log('after ⌘R:', JSON.stringify(afterCmdR));
await shot('02-after-cmd-r');
// The accelerator has to have DONE something — otherwise every assertion below
// passes because nothing happened at all.
check(
  afterCmdR.generation > before.generation,
  `⌘R did not re-mount the app (generation ${before.generation} → ${afterCmdR.generation})`,
);
check(afterCmdR.messages === before.messages, `⌘R lost the chat (${afterCmdR.messages} messages)`);
check(afterCmdR.tabs.includes('keep-me.ts'), '⌘R lost the canvas tab');
check(
  Math.abs(afterCmdR.scrollTop - before.scrollTop) < 80,
  `⌘R lost the scroll position (${before.scrollTop} → ${afterCmdR.scrollTop})`,
);

// ── The crash card, and its Reload button ─────────────────────────────────
const crash = async () => {
  await page.evaluate(() => window.__pi_crash?.());
  await page.waitForSelector('[data-testid="app-crash"]', { timeout: 8000 });
};
await crash();
await shot('03-crash-card');
check((await snapshot()).crashed, 'the test seam did not reach the boundary');

const reloadBtn = await page.$('[data-testid="app-crash-reload"]');
check(reloadBtn !== null, 'the crash card has no Reload button');
if (reloadBtn !== null) await reloadBtn.click();
await page.waitForTimeout(1800);
const afterReload = await snapshot();
console.log('after Reload:', JSON.stringify(afterReload));
await shot('04-after-reload');
check(!afterReload.crashed, 'the Reload button did not clear the crash card');
check(
  afterReload.messages === before.messages,
  `Reload lost the chat (${afterReload.messages} messages)`,
);
check(afterReload.tabs.includes('keep-me.ts'), 'Reload lost the canvas tab');

// ── …and the second button really does reload the document ───────────────
await page.evaluate(() => {
  window.__pd_same_document = true;
});
await crash();
const freshBtn = await page.$('[data-testid="app-crash-fresh"]');
check(freshBtn !== null, 'the crash card has no fresh-window button');
if (freshBtn !== null) await freshBtn.click();
await page.waitForSelector('.pd-composer-editor', { timeout: 20_000 });
await page.waitForTimeout(1200);
const afterFresh = await page.evaluate(() => ({
  sameDocument: window.__pd_same_document === true,
  crashed: document.querySelector('[data-testid="app-crash"]') !== null,
}));
console.log('after fresh window:', JSON.stringify(afterFresh));
await shot('05-after-fresh');
check(!afterFresh.sameDocument, 'the fresh-window button did not reload the document');
check(!afterFresh.crashed, 'the fresh window came up on the crash card');

await app.close().catch(() => undefined);
await finish();
