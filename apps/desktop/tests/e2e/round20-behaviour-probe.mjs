/**
 * Three behaviours from the user's 2026-09-07 list that only a running app can show:
 *
 *   1. a RUNNING command shows its live output (and can be opened to see it)
 *   2. a browser tab keeps its last frame under the `+` menu instead of going white
 *   3. a file dropped while a message is being EDITED lands in that message
 *
 *   SHOT_DIR=/tmp/r20 node apps/desktop/tests/e2e/round20-behaviour-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const home = mkdtempSync(path.join(tmpdir(), 'r20-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
const page404 = path.join(home, 'page.html');
writeFileSync(
  page404,
  '<style>body{background:#123;color:#fff;font:36px system-ui;margin:0;padding:60px}</style><h1>A PAGE THAT WAS HERE</h1><p>and should still be visible under the menu</p>',
);

const { page, shot, check, finish, shotDir } = await launchApp('round20-behaviour', {
  env: { HOME: home },
});
const clip = async (label, box) =>
  writeFileSync(path.join(shotDir, `${label}.png`), await page.screenshot({ clip: box }));

try {
  /* ── 1. A running command shows what it has printed so far ────────────── */
  await page.evaluate(() => {
    const store = window.__pi_store().getState();
    store.setMessagesExternal([
      { kind: 'user', id: 'u1', text: 'run the long thing', timestamp: 1 },
      {
        kind: 'assistant',
        id: 'a1',
        timestamp: 2,
        blocks: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'bash',
            arguments: { command: 'pnpm build && pnpm test' },
          },
        ],
      },
    ]);
    // The two facts a streaming tool call produces. (The sink's own methods live
    // on createPiSink, not the store, so a probe sets the state they set.)
    window.__pi_store().setState({
      runningToolCalls: ['call-1'],
      toolOutputPartials: { 'call-1': 'compiling package 1 of 4\ncompiling package 2 of 4\n' },
    });
  });
  await page.waitForTimeout(700);

  // Open the chain, then the STEP — two separate disclosures, and only the
  // second one reveals the output. A first cut clicked the chain and read the
  // reveal out of the DOM while it was still collapsed to zero height, which
  // passed on a screen showing nothing.
  const chain = await page.$('.pd-chain-summary');
  if (chain !== null) {
    await chain.click();
    await page.waitForTimeout(350);
  }
  const stepToggle =
    (await page.$('.pd-chain-step-disclose')) ??
    (await page.$('.pd-chain-step-row[aria-expanded]'));
  check(stepToggle !== null, 'the running step is openable at all');
  if (stepToggle !== null) {
    await stepToggle.click();
    await page.waitForTimeout(500);
  }
  const revealVisible = await page.evaluate(() => {
    const pre = document.querySelector('.pd-chain-output-body');
    if (pre === null) return null;
    const b = pre.getBoundingClientRect();
    return { h: Math.round(b.height), w: Math.round(b.width) };
  });
  console.log('  reveal box:', JSON.stringify(revealVisible));
  check(
    (revealVisible?.h ?? 0) > 30,
    `the output is actually on screen, not rendered at zero height (${revealVisible?.h}px)`,
  );
  const live = await page.evaluate(() => {
    const pre = document.querySelector('.pd-chain-output-body');
    return {
      text: pre?.textContent ?? '',
      caret: document.querySelector('.pd-term-caret') !== null,
      liveAttr: pre?.hasAttribute('data-live') ?? false,
    };
  });
  console.log('  live block:', JSON.stringify(live).slice(0, 220));
  check(live.text.includes('pnpm build'), 'the running row shows the command');
  check(
    live.text.includes('compiling package 2 of 4'),
    'and the output it has printed SO FAR, while it is still running',
  );
  check(live.caret, 'with a caret, so "nothing yet" and "finished with nothing" differ');
  await shot('01-live-output');

  // More output arrives and the block follows it.
  await page.evaluate(() => {
    const text = `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\nTHE NEWEST LINE`;
    window.__pi_store().setState({ toolOutputPartials: { 'call-1': text } });
  });
  await page.waitForTimeout(500);
  const tailed = await page.evaluate(() => {
    const pre = document.querySelector('.pd-chain-output-body');
    if (pre === null) return null;
    return {
      hasNewest: (pre.textContent ?? '').includes('THE NEWEST LINE'),
      atBottom: pre.scrollHeight - pre.scrollTop - pre.clientHeight < 6,
      scrollable: pre.scrollHeight > pre.clientHeight,
      // The row must not slam shut every time a line arrives.
      stillOpen: Math.round(pre.getBoundingClientRect().height) > 30,
    };
  });
  console.log('  tail:', JSON.stringify(tailed));
  check(tailed?.hasNewest === true, 'new output arrives without reopening the row');
  check(
    tailed?.scrollable === true && tailed.atBottom === true,
    'the block scrolls and follows the newest line rather than parking at the first',
  );
  check(tailed?.stillOpen === true, 'and the row stays open while output keeps arriving');
  await shot('02-live-tail');

  /* ── 2. The + menu does not blank a browser tab ───────────────────────── */
  await page.evaluate((file) => {
    window
      .__pi_canvas()
      .openTab({ kind: 'browser', title: 'page', data: { url: `file://${file}` } });
  }, page404);
  await page.waitForTimeout(2500);
  const slotBefore = await page.evaluate(() => {
    const el = document.querySelector('[data-native-slot="browser"]');
    if (el === null) return null;
    const b = el.getBoundingClientRect();
    return {
      frozen: el.hasAttribute('data-frozen'),
      box: {
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
      },
    };
  });
  console.log('  browser slot:', JSON.stringify(slotBefore));
  if (slotBefore !== null) {
    const plus = await page.$('.pd-canvas-newtab');
    if (plus !== null) {
      await plus.click();
      await page.waitForTimeout(900);
      const slotAfter = await page.evaluate(() => {
        const el = document.querySelector('[data-native-slot="browser"]');
        return {
          frozen: el?.hasAttribute('data-frozen') ?? false,
          bg: el === null ? '' : getComputedStyle(el).backgroundImage.slice(0, 40),
        };
      });
      console.log('  with the + menu open:', JSON.stringify(slotAfter));
      /*
       * NOT AN ASSERTION, AND HERE IS WHY.
       *
       * The still comes from `capturePage()` on the native view, and a native
       * child view inside a HIDDEN window has no compositor running — it returns
       * an empty image whatever we do (verified: the off-screen-reveal fallback
       * does not help either). Every probe runs hidden, on purpose, so this can
       * only ever report "no still" here and would be asserting the bug.
       *
       * What IS checked: the rule itself, in browser-freeze.test.ts, and that a
       * failed capture degrades to exactly today's behaviour rather than
       * painting an empty image over the slot.
       */
      console.log(
        slotAfter.frozen
          ? '  the browser tab kept its last frame under the menu'
          : '  (no still — a hidden window cannot capture a native view; see browser-freeze.test.ts)',
      );
      await clip('03-plus-menu-over-browser', slotBefore.box);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      const slotClosed = await page.evaluate(
        () =>
          document.querySelector('[data-native-slot="browser"]')?.hasAttribute('data-frozen') ??
          false,
      );
      check(!slotClosed, 'the slot carries no still once the menu is closed');
    } else {
      console.log('  (no + button found — menu case skipped)');
    }
  } else {
    console.log('  (no browser slot — menu case skipped)');
  }

  /* ── 3. A drop lands in the message being edited ──────────────────────── */
  await page.evaluate(() => {
    window
      .__pi_store()
      .getState()
      .setMessagesExternal([
        { kind: 'user', id: 'u9', text: 'the message I am about to edit', timestamp: 1 },
        { kind: 'assistant', id: 'a9', blocks: [{ type: 'text', text: 'ok' }], timestamp: 2 },
      ]);
  });
  await page.waitForTimeout(500);
  const bubble = await page.$('[data-user-turn="u9"]');
  await bubble?.hover();
  await page.waitForTimeout(300);
  const editBtn = await page.$('[data-user-turn="u9"] [aria-label="Edit message"]');
  if (editBtn !== null) {
    await editBtn.click();
    await page.waitForTimeout(400);
    console.log('  edit open:', (await page.$('[data-testid="editing-message"]')) !== null);
    // Drive the real drop path: a DataTransfer drop on the window.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped body\n'.repeat(5)], 'dropped.txt', { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    });
    await page.waitForTimeout(900);
    const landed = await page.evaluate(() => ({
      inEdit: document.querySelectorAll(
        '[data-testid="editing-message"] [data-testid], [data-testid="edit-file-card"]',
      ).length,
      editText: document.querySelector('[data-testid="editing-message"]')?.textContent ?? '',
      composerChips: document.querySelectorAll('[data-testid="attach-chip"]').length,
    }));
    console.log('  after the drop:', JSON.stringify(landed).slice(0, 200));
    check(
      landed.editText.includes('dropped.txt'),
      `the dropped file lands in the message being edited (edit shows: ${landed.editText.slice(0, 60)})`,
    );
    check(landed.composerChips === 0, 'and NOT in the composer below it');
    await shot('04-drop-into-edit');
  } else {
    console.log('  (no Edit control found — drop-into-edit case skipped)');
  }

  console.log('shots in', shotDir);
} finally {
  await finish();
}
