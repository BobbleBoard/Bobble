/**
 * THE QUICK PANEL, DRIVEN THROUGH EVERY USE CASE — headless.
 *
 * The hotkey panel (electron/quick/) summoned over a fake Mac, never on screen:
 *
 *   - no global key is registered (a hotkey press arrives through the test-only
 *     `quick:debug` channel), so nobody's keystrokes are swallowed;
 *   - the panel and the selection overlays are made but never shown, and the
 *     probe asserts that at every step;
 *   - every capture is a stand-in drawn from HTML, every selection, clipboard,
 *     Finder and browser read comes from a fake the probe sets — nothing reads
 *     or writes the real pasteboard, nothing can raise a permission prompt;
 *   - the home is the harness's throwaway one, and the focus guard fails the
 *     run if anything took the screen.
 *
 * Screenshots of each case, light and dark, go to deliverables/hotkey-ui/.
 *
 * Usage (build first): node apps/desktop/tests/e2e/quick-panel-probe.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, probeHome, REPO_ROOT } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'quick-panel.json');
const OUT = process.env.QUICK_SHOTS ?? path.join(REPO_ROOT, 'deliverables', 'hotkey-ui');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * A throwaway home whose settings have vision switched off: with no model
 * server in a test run, a picture would otherwise be held for "a model that
 * can see" (correctly — see HeldSendCard) and never reach the scripted turn.
 */
const home = probeHome('quick-panel');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ modelSelection: { mode: 'tier', tier: 'balanced' }, loadVision: false }, null, 2)}\n`,
);

const { app, page, check, finish } = await launchApp('quick-panel', {
  fixture: FIXTURE,
  env: { PI_E2E_NO_SERVER: '1', HOME: home },
  waitFor: '[data-testid="composer-input"]',
});

/** Every case's result, for the summary at the end. */
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  check(ok, `${name}${detail !== '' ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
}

async function findPage(pred, label, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const w of app.windows()) {
      try {
        if (await pred(w)) return w;
      } catch {
        /* a window going away mid-look */
      }
    }
    await sleep(100);
  }
  throw new Error(`no ${label} window appeared`);
}

/*
 * A test run makes the panel only when one of its keys is pressed (see
 * registerQuickPanel), so the first press goes through the main window.
 */
await page.evaluate(() =>
  window.piDesktop.invoke('quick:debug', { op: 'press', params: { action: 'summon' } }),
);
const panel = await findPage((w) => w.url().includes('quickPanel=1'), 'quick panel');
await panel.waitForSelector('[data-testid="quick-panel"]', { timeout: 20_000 });
panel.on('pageerror', (e) => console.log('  [panel pageerror]', String(e).slice(0, 300)));
// Put it away again once it is up: the cases below start from a press of their own.
for (let i = 0; i < 100; i++) {
  const s = await panel.evaluate(() => window.piDesktop.invoke('quick:debug', { op: 'state' }));
  if (s.result.visible) break;
  await sleep(100);
}
await panel.evaluate(() => window.piDesktop.invoke('quick:dismiss', { reason: 'escape' }));

/* No microphone in a test run, whatever the module says: the permission prompt
   is exactly what a probe must never raise. */
await panel.evaluate(() => {
  if (navigator.mediaDevices !== undefined) {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('no microphone in a test run', 'NotAllowedError'));
  }
});

const debug = (op, params = {}) =>
  panel.evaluate(
    ([o, p]) => window.piDesktop.invoke('quick:debug', { op: o, params: p }),
    [op, params],
  );
const state = async () => (await debug('state')).result;

/** The invariants every step must keep: nothing on screen, no global key taken. */
async function invariants(label) {
  const s = await state();
  check(s.panelShownOnScreen === false, `${label}: the panel window was shown on screen`);
  check(s.overlayShownOnScreen === false, `${label}: an overlay was shown on screen`);
  check(s.registeredGlobally.length === 0, `${label}: a real global key was registered`);
  return s;
}

async function shoot(pg, name) {
  for (const mode of ['light', 'dark']) {
    await pg.evaluate((m) => {
      document.documentElement.setAttribute('data-flavor', 'bobble');
      document.documentElement.setAttribute('data-mode', m);
    }, mode);
    await sleep(220);
    const buf = await pg.screenshot();
    const file = path.join(OUT, `${name}-${mode}.png`);
    writeFileSync(file, buf);
    check(buf.length > 4000, `screenshot ${name}-${mode} came back blank`);
  }
}

async function press(action) {
  await debug('press', { action });
}

async function waitShown(want, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if ((await state()).visible === want) return true;
    await sleep(80);
  }
  return false;
}

const threadHas = (text, timeout = 12_000) =>
  panel
    .waitForFunction(
      (t) =>
        document.querySelector('[data-testid="quick-thread"]')?.textContent?.includes(t) ?? false,
      text,
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );

const idle = (timeout = 12_000) =>
  panel.waitForSelector('[data-testid="quick-reply-actions"]', { timeout }).then(
    () => true,
    () => false,
  );

async function ask(text) {
  await panel.fill('[data-testid="quick-input"]', text);
  await panel.press('[data-testid="quick-input"]', 'Enter');
}

async function chip(kind, timeout = 10_000) {
  return panel.waitForSelector(`[data-testid="quick-chip-${kind}"]`, { timeout }).then(
    () => true,
    () => false,
  );
}

async function fresh() {
  await panel.keyboard.press('Meta+n');
  await panel.waitForSelector('[data-testid="quick-panel"][data-face="compact"]', {
    timeout: 8000,
  });
  await sleep(150);
}

async function dismissAndSummon() {
  if ((await state()).visible) {
    await debug('blur');
    await waitShown(false);
    if ((await state()).visible) {
      await panel.keyboard.press('Escape');
      await waitShown(false);
    }
  }
  await press('summon');
  return waitShown(true);
}

/** The overlay on the MAIN display (origin 0,0), where the fake windows are drawn. */
const overlayPage = async (mode) => {
  const isOverlay = async (w) =>
    w.url().startsWith('data:text/html') && (await w.title()) === `mode:${mode}`;
  const onMain = await findPage(
    async (w) =>
      (await isOverlay(w)) &&
      (await w.evaluate(() => window.screenX === 0 && window.screenY === 0)),
    `${mode} overlay on the main display`,
    6000,
  ).catch(() => null);
  return onMain ?? findPage(isOverlay, `${mode} overlay`);
};

try {
  // ── 0. made hidden, keys planned but not registered ────────────────────────
  {
    const s = await invariants('boot');
    const summon = s.hotkeys.find((h) => h.action === 'summon');
    record(
      'hotkeys planned, none registered in a test run',
      summon?.accelerator === 'Alt+Shift+Space' &&
        summon?.state === 'test' &&
        s.registeredGlobally.length === 0,
      `${summon?.accelerator}:${summon?.state}`,
    );
  }

  // ── 1. summon, ask with no context, keep the thread going ─────────────────
  await press('summon');
  record('summon shows the panel (logically, never on screen)', await waitShown(true));
  await panel.waitForSelector('[data-testid="quick-panel"][data-face="compact"]');
  await sleep(300);
  await shoot(panel, '01-summon-compact');

  await ask('What is the capital of Portugal?');
  record('ask with no context streams an answer inline', await threadHas('Lisbon'));
  await idle();
  await shoot(panel, '02-ask-answer');

  await ask('And how many people live there?');
  record('the thread continues in the panel', await threadHas('550,000'));
  await idle();
  {
    const users = await panel.$$eval('[data-testid="quick-user"]', (els) => els.length);
    record('both questions are in one thread', users === 2, `${users} user messages`);
  }
  await shoot(panel, '03-continue-thread');

  // Esc puts it away; the hotkey toggles.
  await panel.keyboard.press('Escape');
  record('Esc dismisses the panel', await waitShown(false));
  await press('summon');
  await waitShown(true);
  await press('summon');
  record('the summon key again toggles it away', await waitShown(false));
  await press('summon');
  await waitShown(true);

  // ── 2. the window in front ────────────────────────────────────────────────
  await fresh();
  await panel.click('[data-testid="quick-act-window"]');
  record('"This window" attaches the front window', await chip('window'));
  await sleep(200);
  await shoot(panel, '04-front-window-chip');
  await ask('What is on this checklist?');
  record('asks about the front window only', await threadHas('launch checklist'));
  await idle();
  await shoot(panel, '05-front-window-answer');

  // ── 3. an area of the screen, from its own hotkey ─────────────────────────
  await fresh();
  await panel.keyboard.press('Escape');
  await waitShown(false);
  await press('region');
  const ov = await overlayPage('region');
  await ov.waitForFunction(() => window.__pdRegion !== undefined);
  await sleep(250);
  await invariants('region overlay');
  const ovShot = async (name) => {
    const buf = await ov.screenshot();
    writeFileSync(path.join(OUT, `${name}.png`), buf);
    check(buf.length > 4000, `${name} blank`);
  };
  await ovShot('06-region-overlay');
  await ov.mouse.move(528, 360);
  await ov.mouse.down();
  await ov.mouse.move(1008, 590, { steps: 8 });
  await sleep(150);
  await ovShot('07-region-selecting');
  await ov.mouse.up();
  record(
    'the area hotkey opens the panel with the crop attached',
    (await waitShown(true)) && (await chip('region')),
  );
  {
    const label = await panel.textContent('[data-testid="quick-chip-region"]');
    record(
      'the crop is the size that was dragged (points)',
      /480 × 230/.test(label ?? ''),
      label ?? '',
    );
  }
  await sleep(200);
  await shoot(panel, '08-region-chip');
  await ask('Explain this chart');
  record('asks about the dragged area', await threadHas('bar chart'));
  await idle();
  await shoot(panel, '09-region-answer');

  // ── 4. the whole screen ───────────────────────────────────────────────────
  await fresh();
  await panel.click('[data-testid="quick-act-screen"]');
  record('"Screen" attaches the whole screen', await chip('screen'));
  // Nothing typed: Return asks what the picture shows.
  await panel.press('[data-testid="quick-input"]', 'Enter');
  record('a picture with no question asks what it shows', await threadHas('three windows open'));
  await idle();
  await shoot(panel, '10-screen-answer');

  // ── 5. a window you pick: from the list, and by clicking it ───────────────
  await fresh();
  await panel.keyboard.press('Meta+2');
  await panel.waitForSelector('[data-testid="quick-window"]', { timeout: 10_000 });
  {
    const tiles = await panel.$$eval('[data-testid="quick-window"]', (els) =>
      els.map((e) => ({
        text: e.textContent,
        icon: e.querySelector('.qp-window-meta img')?.getAttribute('src')?.slice(0, 22) ?? null,
      })),
    );
    record(
      'the picker lists the windows with their apps’ real icons',
      tiles.length === 3 && tiles.every((t) => t.icon === 'data:image/png;base64,'),
      tiles.map((t) => t.text).join(' | '),
    );
  }
  await sleep(300);
  await shoot(panel, '11-window-picker');
  await panel.click('[data-testid="quick-window"]:has-text("Safari")');
  record('picking a window in the list attaches it', await chip('window'));
  await ask('Summarize this window');
  record('asks about the picked window', await threadHas('Quarterly report'));
  await idle();

  await fresh();
  await panel.keyboard.press('Meta+2');
  await panel.waitForSelector('[data-testid="quick-pick-on-screen"]');
  await panel.click('[data-testid="quick-pick-on-screen"]');
  const pick = await overlayPage('pick');
  await pick.waitForFunction(() => window.__pdRegion !== undefined);
  await pick.mouse.move(110, 700);
  await sleep(200);
  {
    const buf = await pick.screenshot();
    writeFileSync(path.join(OUT, '12-pick-overlay-hover.png'), buf);
  }
  const hovered = await pick.textContent('#hoverLabel');
  record('click-to-pick lights the window under the pointer', hovered === 'Notes', hovered ?? '');
  await pick.mouse.down();
  await pick.mouse.up();
  record('clicking a window attaches it', await chip('window'));
  await ask('Summarize this window');
  record('asks about the clicked window', await threadHas('grocery list'));
  await idle();
  await shoot(panel, '13-picked-window-answer');

  // ── 6. selected text, read before the panel opens ─────────────────────────
  await fresh();
  await debug('set-mac', {
    selection: { text: 'teh quick brwon fox jumsp over the lazy dog', editable: true },
  });
  await dismissAndSummon();
  record('the selection comes along as a chip', await chip('selection'));
  await panel.waitForSelector('[data-testid="quick-selection-actions"]');
  await sleep(200);
  await shoot(panel, '14-selection-actions');
  await panel.click('[data-testid="quick-text-fix"]');
  record(
    'Fix spelling answers with the corrected text',
    await threadHas('The quick brown fox jumps over the lazy dog.'),
  );
  await idle();
  await panel.waitForSelector('[data-testid="quick-replace-selection"]');
  await shoot(panel, '15-selection-fixed');
  await panel.click('[data-testid="quick-replace-selection"]');
  await sleep(300);
  {
    const s = await state();
    const call = s.calls.find((c) => c.op === 'replace-selection');
    record(
      'Replace selection puts the reply back through Accessibility',
      call?.detail?.text === 'The quick brown fox jumps over the lazy dog.' &&
        call?.detail?.replaced === true,
      JSON.stringify(call?.detail ?? null),
    );
    record('…and the panel goes away after', s.visible === false);
  }
  // An app that will not take text that way: the paste path, pasteboard restored.
  await debug('set-mac', { axReplace: false });
  await dismissAndSummon();
  await panel.evaluate(() =>
    window.piDesktop.invoke('quick:replace-selection', { text: 'pasted words' }),
  );
  await sleep(200);
  {
    const ops = (await state()).calls.map((c) => c.op);
    const at = (op) => ops.lastIndexOf(op);
    // (Handing the app the keyboard first is skipped in a test run — the focus
    // rule never moves anyone's focus there; focus-return's unit test covers it.)
    record(
      'the paste fallback writes, pastes, then restores the pasteboard (a fake one)',
      at('clipboard-write') >= 0 &&
        at('paste') > at('clipboard-write') &&
        at('clipboard-restore') > at('paste') &&
        !ops.includes('activate'),
      ops.slice(-4).join(' → '),
    );
  }
  await debug('set-mac', {
    axReplace: true,
    selection: { text: 'password', editable: true, secure: true },
  });
  await dismissAndSummon();
  record(
    'a password field is never read',
    (await panel.waitForSelector('[data-testid="quick-problem"][data-kind="secure"]').then(
      () => true,
      () => false,
    )) && (await panel.$('[data-testid="quick-chip-selection"]')) === null,
  );
  await shoot(panel, '16-secure-field');
  await debug('set-mac', { selection: null });

  // ── 7. computer use on the app in front ───────────────────────────────────
  await fresh();
  await page.evaluate(() =>
    window.piDesktop.invoke('settings:set', {
      patch: { computerUse: { enabled: false, apps: [] } },
    }),
  );
  await dismissAndSummon();
  await panel.click('[data-testid="quick-act-use-app"]');
  record('"Use TextEdit" turns the panel to acting in that app', await chip('app'));
  await ask('Make the title bold');
  record(
    'computer use switched off says so, with the fix',
    await panel.waitForSelector('[data-testid="quick-problem"][data-kind="computer-use-off"]').then(
      () => true,
      () => false,
    ),
  );
  await shoot(panel, '17-computer-use-off');
  await panel.click('[data-testid="quick-fix-turn-on-computer-use"]');
  await sleep(300);
  {
    const s = await page.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
    record('…and its button turns it on', s.computerUse.enabled === true);
  }
  await panel.press('[data-testid="quick-input"]', 'Enter');
  const confirm = await panel
    .waitForSelector('[data-testid="confirm-card"]', { timeout: 12_000 })
    .then(
      () => true,
      () => false,
    );
  record('an app not on the allowed list is asked about, in the panel', confirm);
  await sleep(200);
  await shoot(panel, '18-computer-use-ask');
  if (confirm) await panel.click('[data-testid="confirm-card"] button:has-text("Confirm")');
  record('computer use acts in the app and reports back', await threadHas('made it bold'));
  await idle();
  {
    const sent = await panel.evaluate(() => {
      const msgs = window.__pi_store().getState().messages;
      return msgs.filter((m) => m.kind === 'user').at(-1)?.agentText ?? '';
    });
    record(
      'the model is told the app and its pid',
      /working in TextEdit/.test(sent) && /pid 4242/.test(sent),
    );
  }
  await shoot(panel, '19-computer-use-done');
  // The never-driven apps.
  await fresh();
  await debug('set-mac', {
    front: { pid: 5151, name: 'System Settings', bundleId: 'com.apple.systempreferences' },
  });
  await dismissAndSummon();
  await panel.click('[data-testid="quick-act-use-app"]');
  await ask('Turn on dark mode');
  record(
    'System Settings is never driven, and the panel says why',
    await panel
      .waitForSelector('[data-testid="quick-problem"][data-kind="computer-use-never"]')
      .then(
        () => true,
        () => false,
      ),
  );
  await shoot(panel, '20-computer-use-never');
  await debug('set-mac', {
    front: { pid: 4242, name: 'TextEdit', bundleId: 'com.apple.TextEdit', windowId: 501 },
  });

  // ── 8. a permission that is off ───────────────────────────────────────────
  await fresh();
  await dismissAndSummon();
  await debug('set-grant', { screen: 'denied' });
  await panel.click('[data-testid="quick-act-window"]');
  record(
    'no Screen Recording: plain words and the pane that fixes it',
    await panel.waitForSelector('[data-testid="quick-problem"][data-kind="screen-recording"]').then(
      () => true,
      () => false,
    ),
  );
  await shoot(panel, '21-permission-screen-recording');
  await panel.click('[data-testid="quick-fix-system-settings"]');
  await sleep(150);
  {
    const s = await state();
    record(
      '…the button asks for the Screen Recording pane (recorded, never opened in a test)',
      s.calls.some((c) => c.op === 'open-system-settings' && c.detail === 'screen-recording'),
    );
  }
  await debug('set-grant', { screen: 'granted' });

  // ── 9. the clipboard, Finder's selection, the browser's page, a dropped file
  await fresh();
  await debug('set-mac', {
    clipboard: { text: 'Design review moved to Friday 10:00, second floor.' },
  });
  await panel.click('[data-testid="quick-act-clipboard"]');
  record('the clipboard comes in as context (from the fake pasteboard)', await chip('clipboard'));
  await ask('What does this say?');
  record('asks about the clipboard', await threadHas('meeting note'));
  await idle();
  await shoot(panel, '22-clipboard-answer');

  await fresh();
  await debug('set-mac', {
    front: { pid: 6161, name: 'Finder', bundleId: 'com.apple.finder' },
    finder: ['/Users/demo/Documents/budget-2026.numbers', '/Users/demo/Documents/offsite-plan.pdf'],
  });
  await dismissAndSummon();
  await panel.click('[data-testid="quick-act-finder"]');
  record("Finder's selected files come in as context", await chip('files'));
  await sleep(150);
  await shoot(panel, '23-finder-chip');
  await ask('What are these?');
  record("asks about Finder's selection", await threadHas('budget-2026.numbers'));
  await idle();

  await fresh();
  await debug('set-mac', {
    front: { pid: 7171, name: 'Safari', bundleId: 'com.apple.Safari' },
    browser: {
      url: 'https://example.com/quick-panel-guide',
      title: 'The quick panel guide',
      text: 'Summon Bobble from any app. Ask about a window, an area of the screen, or the text you selected.',
    },
  });
  await dismissAndSummon();
  await panel.click('[data-testid="quick-act-page"]');
  record("the browser's page comes in as context", await chip('browser'));
  await sleep(150);
  await shoot(panel, '24-browser-chip');
  await ask('Summarize this page');
  record('asks about the page', await threadHas('The quick panel guide'));
  await idle();
  await debug('set-mac', {
    front: { pid: 4242, name: 'TextEdit', bundleId: 'com.apple.TextEdit', windowId: 501 },
  });

  await fresh();
  await dismissAndSummon();
  await panel.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File(['River walk\nCooking class\nMuseum morning\n'], 'offsite-ideas.txt', {
        type: 'text/plain',
      }),
    );
    const target = document.querySelector('[data-testid="quick-panel"]');
    target?.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    target?.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  });
  record('a dropped file is attached', await chip('file'));
  await ask("What's in this note?");
  record('asks about the dropped file', await threadHas('three ideas'));
  await idle();

  // ── 10. talk: the Dictation module's card when it is not installed ────────
  {
    const status = await panel
      .evaluate(() => window.piDesktop.invoke('gen:module-status', {}))
      .catch(() => null);
    const dict = status?.modules?.find((m) => m.id === 'dictation');
    if (dict !== undefined && dict.ready === false) {
      await fresh();
      await panel.click('[data-testid="quick-mic"]');
      record(
        'talk without the Dictation module shows its Download card',
        await panel.waitForSelector('[data-testid="quick-dictation-module"]').then(
          () => true,
          () => false,
        ),
      );
      await sleep(200);
      await shoot(panel, '25-talk-needs-module');
      await panel.keyboard.press('Escape');
    } else {
      console.log('SKIP  talk: the Dictation module state could not be read safely');
    }
  }

  // ── 11. the command palette, recent threads, size, pin ────────────────────
  await fresh();
  await dismissAndSummon();
  await panel.fill('[data-testid="quick-input"]', 'a lighthouse at dusk');
  await panel.keyboard.press('Meta+k');
  await panel.waitForSelector('[data-testid="quick-palette"]');
  await sleep(250);
  await shoot(panel, '26-palette');
  await panel.fill('[data-testid="quick-palette-input"]', 'picture');
  await sleep(200);
  await shoot(panel, '27-palette-search');
  await panel.click('[data-testid="quick-palette-row-image"]');
  await sleep(300);
  {
    const s = await state();
    record(
      'a picture request goes to the Image studio with the prompt',
      s.lastMainAction?.kind === 'image-studio' &&
        s.lastMainAction?.prompt === 'a lighthouse at dusk',
      JSON.stringify(s.lastMainAction),
    );
  }
  await panel.keyboard.press('Escape');

  await dismissAndSummon();
  await panel.keyboard.press('Meta+y');
  await panel
    .waitForSelector('[data-testid="quick-history-row"]', { timeout: 8000 })
    .catch(() => undefined);
  {
    const rows = await panel.$$eval('[data-testid="quick-history-row"]', (els) => els.length);
    record('recent threads are listed', rows >= 1, `${rows} threads`);
  }
  await sleep(200);
  await shoot(panel, '28-recent-threads');
  await panel.keyboard.press('Escape');

  // Size and pin, on a thread.
  await ask('One more question');
  await idle();
  await panel.keyboard.press('Meta+e');
  await sleep(300);
  {
    const s = await state();
    record(
      '⌘E makes the panel large',
      s.size === 'large' && s.bounds?.width === 960,
      `${s.bounds?.width}×${s.bounds?.height}`,
    );
  }
  await shoot(panel, '29-large');
  await panel.keyboard.press('Meta+e');
  await panel.click('[data-testid="quick-pin"]');
  await sleep(100);
  await debug('blur');
  await sleep(150);
  record('a pinned panel stays when you click elsewhere', (await state()).visible === true);
  await shoot(panel, '30-pinned');
  await panel.click('[data-testid="quick-pin"]');
  await debug('blur');
  record('unpinned, a click elsewhere puts it away', await waitShown(false));

  // ── 12. open in the main window ───────────────────────────────────────────
  await press('summon');
  await waitShown(true);
  const fileBefore = await panel.evaluate(
    () => window.__pi_store().getState().session?.sessionFile ?? null,
  );
  await panel.keyboard.press('Meta+Enter');
  await sleep(400);
  {
    const s = await state();
    record(
      'Open in Bobble hands the thread to the main window as a chat',
      s.lastMainAction?.kind === 'open-session' &&
        s.lastMainAction?.file === fileBefore &&
        s.visible === false,
      JSON.stringify(s.lastMainAction),
    );
  }

  // ── 13. settings: hotkeys recorded and checked ────────────────────────────
  await page.evaluate(() => window.__app_nav().getState().navigate('settings:quick-panel'));
  await page.waitForSelector('[data-testid="settings-quick-panel"]', { timeout: 10_000 });
  await sleep(400);
  await shoot(page, '31-settings');
  await page.click('[data-testid="settings-quick-key-summon"] .pd-shortcut-field');
  await page.keyboard.down('Meta');
  await page.keyboard.press('Space');
  await page.keyboard.up('Meta');
  record(
    'the recorder refuses ⌘Space, naming Spotlight',
    await page
      .waitForSelector('[data-testid="settings-quick-key-summon-refused"]:has-text("Spotlight")', {
        timeout: 4000,
      })
      .then(
        () => true,
        () => false,
      ),
  );
  await shoot(page, '32-settings-shortcut-refused');
  await page.keyboard.press('Escape');
  await page.click('[data-testid="settings-quick-key-dictate"] .pd-shortcut-field');
  await page.keyboard.press('Control+Alt+Meta+KeyD');
  await sleep(300);
  {
    const s = await page.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
    const st = await panel.evaluate(() => window.piDesktop.invoke('quick:status', undefined));
    const dict = st.hotkeys.find((h) => h.action === 'dictate');
    record(
      'a recorded key is saved and planned (never registered in a test run)',
      s.quickPanel.hotkeys.dictate === 'Control+Alt+Command+D' && dict?.state === 'test',
      `${s.quickPanel.hotkeys.dictate} ${dict?.state}`,
    );
  }
  await page.click('[data-testid="settings-quick-key-summon"] .pd-shortcut-field');
  await page.keyboard.press('Alt+Space');
  await sleep(300);
  record(
    'a key a launcher shares is kept, with a note',
    await page
      .waitForSelector('[data-testid="settings-quick-key-summon-warning"]:has-text("Alfred")', {
        timeout: 4000,
      })
      .then(
        () => true,
        () => false,
      ),
  );
  await shoot(page, '33-settings-shortcut-warning');
  await page.click('button:has-text("Use the default")');
  await sleep(200);
  {
    const s = await page.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
    record(
      '"Use the default" puts the summon key back',
      s.quickPanel.hotkeys.summon === 'Alt+Shift+Space',
    );
  }

  // The permissions, as a Mac that has granted neither shows them.
  await debug('set-grant', { screen: 'denied' });
  await debug('set-mac', { accessibility: 'denied' });
  await page.evaluate(() => window.__app_nav().getState().navigate('settings:computer-use'));
  await sleep(300);
  await page.evaluate(() => window.__app_nav().getState().navigate('settings:quick-panel'));
  await page.waitForSelector('[data-testid="settings-quick-open-screen"]', { timeout: 8000 });
  await page.evaluate(() =>
    document
      .querySelector('[data-testid="settings-quick-permissions"]')
      ?.scrollIntoView({ block: 'end' }),
  );
  await sleep(300);
  record(
    'each missing permission has its own button to the right pane',
    (await page.$('[data-testid="settings-quick-open-accessibility"]')) !== null,
  );
  await shoot(page, '34-settings-permissions');
  await page.click('[data-testid="settings-quick-open-accessibility"]');
  await sleep(150);
  record(
    '…which asks for the Accessibility pane (recorded, never opened in a test)',
    (await state()).calls.some(
      (c) => c.op === 'open-system-settings' && c.detail === 'accessibility',
    ),
  );
  await debug('set-grant', { screen: 'granted' });
  await debug('set-mac', { accessibility: 'granted' });

  // ── 14. with the main window closed ───────────────────────────────────────
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      const url = w.webContents.getURL();
      if (!url.includes('quickPanel=1') && !url.startsWith('data:')) w.close();
    }
  });
  await sleep(600);
  record(
    'closing the main window leaves Bobble running',
    (await state()).mainWindowAlive === false,
  );
  await press('summon');
  record('the panel still opens with the main window closed', await waitShown(true));
  await fresh();
  await ask('Still there?');
  record('…and still answers', await idle());
  await panel.keyboard.press('Meta+Enter');
  await sleep(1200);
  {
    const s = await state();
    record(
      'Open in Bobble makes the main window again',
      s.mainWindowAlive === true,
      JSON.stringify(s.lastMainAction),
    );
  }
  await invariants('end');
} catch (err) {
  record('probe ran to the end', false, String(err?.stack ?? err).slice(0, 600));
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} quick panel checks passed`);
  console.log(`screenshots: ${OUT}`);
  await finish();
}
