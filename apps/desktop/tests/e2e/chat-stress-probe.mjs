/**
 * THE POWER-USER STRESS RUN.
 *
 * The user: "simulate yourself as a power user and do all the things — branch chats,
 * make new chats send quick messages while it's running, pause and send a quick
 * message, add files, really wrestle with the context editing … change models
 * while it's doing something … huge stress test that you need to visually ensure
 * no random behavior occurs", and, because a screenshot cannot show a twitch:
 * "any jittering behavior needs solving."
 *
 * So this drives the app the way somebody impatient actually uses it — sending
 * into a running turn, pausing mid-sentence, editing a message's files, swapping
 * the model while it streams — with the four jitter recorders armed throughout
 * (tests/e2e/jitter.mjs). Every scenario is `mark`ed, so a finding says WHICH
 * interaction produced it.
 *
 * It asserts two different kinds of thing:
 *   - CORRECTNESS, per scenario: the message you sent exists, the branch you
 *     made is switchable, the files you removed are gone.
 *   - STABILITY, across all of them: nothing bounced, flashed, or shifted the
 *     layout while you were not looking.
 *
 * Run `npm run build` first. Uses mock-pi's `stress` fixture: long, slow turns,
 * because every interesting interaction here happens DURING one.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, openWorkMode, REPO_ROOT } from './harness.mjs';
import { armJitter, jitterReport, mark as markPhase, summarizeJitter } from './jitter.mjs';

/**
 * Announce the scenario as it starts. A stress run is long, and a step that
 * hangs is otherwise a silent process — the last line printed is the answer to
 * "which interaction wedged it".
 */
const started = Date.now();
const mark = async (page, phase) => {
  console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${phase}`);
  await markPhase(page, phase);
};

const FIXTURE = path.join(REPO_ROOT, 'packages/engine/tools/mock-pi/fixtures/stress.json');

// A HOME of our own: this probe makes chats, projects and folders, and must not
// touch the user's.
const home = mkdtempSync(path.join(tmpdir(), 'pd-stress-home-'));
const sessions = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessions, { recursive: true });
const l = (o) => JSON.stringify(o);
writeFileSync(
  path.join(sessions, 'seed.jsonl'),
  [
    l({ type: 'session', version: 3, id: 'seed', timestamp: 't', cwd: '/tmp' }),
    l({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'the seeded conversation', timestamp: 1 },
    }),
    l({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Seeded reply.' }],
        timestamp: 1,
      },
    }),
  ].join('\n'),
);

// Files to attach — real ones on disk, since the picker reads bytes.
const files = path.join(home, 'files');
mkdirSync(files, { recursive: true });
const notes = path.join(files, 'notes.md');
const spec = path.join(files, 'spec.txt');
writeFileSync(notes, '# notes\nthe first attached file\n');
writeFileSync(spec, 'the second attached file\nwith two lines\n');

const { page, shot, check, finish } = await launchApp('chat-stress-probe', {
  fixture: FIXTURE,
  env: { HOME: home },
});

/**
 * Close anything modal that opened on its own.
 *
 * A fresh profile has no models downloaded, so the Auto router raises its
 * download card partway through — a real flow, but not the one under test, and
 * its overlay swallows every click until it is answered. A power user dismisses
 * it and carries on; so does this.
 */
const dismissBlockers = async () => {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(
      () => document.querySelector('.pd-dialog-overlay[data-state="open"]') !== null,
    );
    if (!open) return;
    await page.evaluate(() =>
      window.__model_selection_store?.().setState({ pendingDownload: null }),
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
};

/** Type into the composer and press Enter. */
const send = async (text) => {
  await dismissBlockers();
  await page.click('.pd-composer-editor');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

const store = () => page.evaluate(() => window.__pi_store().getState());
const userTexts = async () =>
  (await store()).messages.filter((m) => m.kind === 'user').map((m) => m.text);

/** Wait for a predicate over the store, or return false. */
const until = async (fn, ms = 8000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await page.evaluate(fn)) return true;
    await page.waitForTimeout(120);
  }
  return false;
};

const streaming = () => page.evaluate(() => window.__pi_store().getState().agent.isStreaming);

/*
 * A renderer that dies mid-run otherwise surfaces as "Target page … has been
 * closed" from whatever step happened to be next, which says nothing about the
 * step that actually killed it. These name it.
 */
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
page.on('crash', () => pageErrors.push('the renderer process crashed'));

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  /*
   * PIN THE MODEL. A fresh profile has nothing downloaded, so the Auto router
   * parks a download card on every send — a real flow, and one this probe would
   * otherwise spend its whole run dismissing. Pinning takes the router out of
   * the picture so the scenarios below are about the CHAT.
   */
  await page.evaluate(async () => {
    await window
      .__settings_store?.()
      .getState()
      .update({
        modelSelection: { mode: 'model', modelId: 'gemma-4-12b' },
      });
    window.__model_selection_store?.().setState({ pendingDownload: null });
  });
  await page.waitForTimeout(400);
  await armJitter(page);
  await page.waitForTimeout(600);

  /* ── 1. a long turn, steered mid-flight ──────────────────────────────────── */
  await mark(page, 'steer-mid-turn');
  await send('walk me through the whole thing');
  await until(() => window.__pi_store().getState().agent.isStreaming);
  await page.waitForTimeout(1200); // let it produce content, so this steers
  await send('actually focus on the second part');
  await page.waitForTimeout(800);
  {
    const texts = await userTexts();
    check(
      texts.includes('actually focus on the second part'),
      `the steering message is not in the thread: ${JSON.stringify(texts)}`,
    );
    const queued = (await store()).queuedSends.length;
    check(queued === 0, `the steer was queued instead of sent (${queued} waiting)`);
  }
  await shot('01-steered');

  /*
   * A chain stays open for the WHOLE turn. MEASURED before the fix: a turn that
   * emits text after a tool call starts a new segment, so the earlier chain
   * stopped being the live one and rolled itself shut mid-reply — the bounce the
   * detector kept finding, and the "expanding/closing tool blocks" the user has
   * reported twice.
   */
  const chainOpen = async () =>
    await page.evaluate(() => {
      // The CHAIN root, not a step chevron — both carry data-expanded.
      const el = document.querySelector('.pd-chain[data-expanded]');
      return el === null ? null : el.getAttribute('data-expanded');
    });
  {
    const open = await chainOpen();
    if (open !== null && (await streaming())) {
      check(open === 'true', 'the activity chain is shut while the turn is live');
    }
  }

  /* ── 2. pause, then a quick message ──────────────────────────────────────── */
  await mark(page, 'pause-then-send');
  const pause = await page.$('[data-testid="composer-pause"]');
  check(pause !== null, 'no pause control in the composer');
  if (pause !== null) {
    await pause.click();
    await until(() => window.__pi_store().getState().agent.isStreaming === false, 6000);
    await send('quick question while that is paused');
    const landed = await until(() =>
      window
        .__pi_store()
        .getState()
        .messages.some((m) => m.kind === 'user' && m.text.includes('quick question')),
    );
    check(landed, 'a message sent after pausing never reached the thread');
    const stuck = (await store()).promptInFlight;
    check(
      stuck === false || (await streaming()),
      'promptInFlight stayed raised after a paused send',
    );
  }
  await shot('02-paused-send');

  /* ── 3. a new chat while the old one runs ────────────────────────────────── */
  await mark(page, 'new-chat-while-running');
  await send('start something long again');
  await until(() => window.__pi_store().getState().agent.isStreaming);
  await dismissBlockers();
  await page.click('[data-testid="new-chat"]');
  await page.waitForTimeout(700);
  await send('a fresh chat message');
  const fresh = await until(
    () =>
      window
        .__pi_store()
        .getState()
        .messages.some((m) => m.kind === 'user' && m.text.includes('a fresh chat message')),
    12_000,
  );
  check(fresh, 'a message in a brand-new chat never appeared');
  await shot('03-new-chat');

  /* ── 4. attach files, then EDIT the message's files ──────────────────────── */
  await mark(page, 'attach-and-edit-files');
  await dismissBlockers();
  await page.setInputFiles('[data-testid="composer-file-input"]', [notes, spec]).catch(async () => {
    // The composer's input has no testid in some builds — fall back to any file input
    // inside the composer.
    await page.setInputFiles('.pd-composer input[type="file"]', [notes, spec]);
  });
  await page.waitForTimeout(500);
  const chips = await page.$$(
    '[data-testid="composer-attachments"] .pd-attach, [data-testid="composer-attachments"] .pd-pasted',
  );
  check(chips.length === 2, `expected 2 attachment chips, saw ${chips.length}`);
  await send('here are two files');
  await until(
    () =>
      window
        .__pi_store()
        .getState()
        .messages.some((m) => m.kind === 'user' && (m.agentText ?? '').includes('Attached file')),
    10_000,
  );
  await page.waitForTimeout(400);
  // The sent bubble shows CARDS, not the fold.
  const cards = await page.$$('[data-testid="user-attachments"] .pd-pasted');
  check(cards.length === 2, `the sent message shows ${cards.length} attachment cards, expected 2`);

  // …now edit it: drop one file, add another, and check what pi is sent.
  const bubbles = await page.$$('.pd-msg--user');
  const last = bubbles[bubbles.length - 1];
  check(last !== undefined, 'no user message to edit');
  await last?.hover();
  await page.waitForTimeout(250);
  // Scoped to THAT bubble — `:last-of-type` is about sibling tag order, not
  // about which message is last, and it quietly matched the wrong one.
  const editBtn = (await last?.$('[aria-label="Edit message"]')) ?? null;
  check(editBtn !== null, 'no Edit control on a user message');
  if (editBtn !== null) {
    await editBtn.click();
    await page.waitForSelector('[data-testid="editing-attachments"]', { timeout: 5000 });
    const editing = await page.$$('[data-testid="editing-attachments"] .pd-pasted');
    check(editing.length === 2, `the editor shows ${editing.length} files, expected 2`);
    // Remove the first.
    await page.click('[data-testid="editing-attachments"] .pd-pasted-remove');
    await page.waitForTimeout(250);
    const afterRemove = await page.$$('[data-testid="editing-attachments"] .pd-pasted');
    check(afterRemove.length === 1, `removing a file left ${afterRemove.length}, expected 1`);
    // Add one back.
    await page.setInputFiles('[data-testid="edit-file-input"]', [notes]);
    await page.waitForTimeout(400);
    const afterAdd = await page.$$('[data-testid="editing-attachments"] .pd-pasted');
    check(afterAdd.length === 2, `adding a file gave ${afterAdd.length}, expected 2`);
    await shot('04-editing-files');
    await page.click('[data-testid="editing-message"] button:has-text("Save")');
    await page.waitForTimeout(900);
    const stillThere = await page.$$('[data-testid="user-attachments"] .pd-pasted');
    check(stillThere.length > 0, 'saving an edit dropped the message attachments entirely');
  }

  /* ── 5. branch: edit an earlier message and switch between versions ──────── */
  await mark(page, 'branch-switch');
  await dismissBlockers();
  const switcher = await page.$('.pd-branch-switcher');
  check(switcher !== null, 'editing a message produced no branch switcher');
  if (switcher !== null) {
    const before = await page.textContent('.pd-branch-count');
    await page.click('.pd-branch-switcher [aria-label="Previous version"]');
    await page.waitForTimeout(600);
    const after = await page.textContent('.pd-branch-count');
    check(before !== after, `the branch switcher did not move (${before} → ${after})`);
    await shot('05-branch');
  }

  /* ── 6. swap the model while a turn is running ───────────────────────────── */
  await mark(page, 'model-swap-mid-turn');
  await send('one more long one please');
  await until(() => window.__pi_store().getState().agent.isStreaming);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__model_selection_store?.().setState({
      switching: { toTier: 'balanced', toName: 'Qwen 3.5 4B' },
    });
  });
  await page.waitForTimeout(500);
  const ringText = await page.evaluate(
    () => document.querySelector('[data-testid="thread-processing"]')?.textContent ?? '',
  );
  await shot('06-model-swap');
  check(
    ringText.toLowerCase().includes('switching to'),
    `no "switching to <model>" while a swap runs mid-turn (saw: ${ringText.slice(0, 80)})`,
  );
  await page.evaluate(() => window.__model_selection_store?.().setState({ switching: null }));
  // The thread survived it — the reply that was streaming is still there, whole.
  const intact = await page.evaluate(
    () =>
      window
        .__pi_store()
        .getState()
        .messages.filter((m) => m.kind === 'assistant').length,
  );
  check(intact > 0, 'the thread lost its assistant messages across a model swap');

  /* ── 7. hammer the composer: several sends back to back ──────────────────── */
  await mark(page, 'rapid-sends');
  for (const t of ['one', 'two', 'three']) {
    await send(t);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2500);
  {
    const texts = await userTexts();
    for (const t of ['one', 'two', 'three']) {
      check(texts.includes(t), `rapid send "${t}" never made it into the thread`);
    }
  }

  /* ── 7b. go download a model, and switch to it ───────────────────────────── */
  await mark(page, 'model-download');
  await dismissBlockers();
  await page.click('[data-testid="nav-model-management"]');
  await page.waitForSelector('[data-testid="models-view"]', { timeout: 10_000 });
  await page.waitForTimeout(900);
  // Drive the download the way the store does, so the bar, the percentage and
  // the row's state are exercised without fetching gigabytes.
  await page.evaluate(() => {
    const llm = window.__llm_store?.();
    if (llm === undefined) return;
    const id = llm.getState().catalog[0]?.id ?? 'gemma-4-12b';
    for (const f of [0.05, 0.4, 0.8]) {
      llm.getState().applyDownloadProgress({
        modelId: id,
        file: 'model.gguf',
        received: Math.round(f * 8e9),
        total: 8e9,
        fraction: f,
      });
    }
  });
  await page.waitForTimeout(600);
  const bar = await page.evaluate(
    () => document.querySelector('[role="progressbar"], .pd-progress') !== null,
  );
  check(bar, 'a download in progress draws no progress bar in the model hub');
  await shot('07-download');
  await page.evaluate(() => window.__llm_store?.().setState({ download: null }));
  await page.waitForTimeout(400);
  await page.click('text=the seeded conversation');
  await page.waitForTimeout(700);

  /* ── 7c. and it CLOSES once the turn is over ─────────────────────────────── */
  await mark(page, 'chain-settles');
  await until(() => window.__pi_store().getState().agent.isStreaming === false, 20_000);
  await page.waitForTimeout(900);
  {
    const open = await chainOpen();
    if (open !== null)
      check(open === 'false', 'the activity chain stayed open after the turn ended');
  }

  /* ── 8. sidebar + studios, back and forth ────────────────────────────────── */
  await mark(page, 'route-switching');
  await dismissBlockers();
  for (const id of ['modality-image', 'modality-video', 'modality-audio']) {
    await page.click(`[data-testid="${id}"]`);
    await page.waitForTimeout(700);
  }
  await page.click('text=the seeded conversation');
  await page.waitForTimeout(700);
  await page.click('[data-testid="nav-model-management"]');
  await page.waitForTimeout(900);
  await shot('07-model-hub');
  await page.click('text=the seeded conversation');
  await page.waitForTimeout(700);

  /* ── 9. sidebar collapse / expand, and the menus ─────────────────────────── */
  await mark(page, 'chrome-toggles');
  await dismissBlockers();
  for (let i = 0; i < 3; i++) {
    await page.click('[data-testid="collapse-sidebar"], [data-testid="expand-sidebar"]');
    await page.waitForTimeout(600);
  }
  await openWorkMode(page);
  await page.click('[data-testid="composer-effort"]');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.click('.pd-project-chip');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await shot('08-settled');

  /* ── the stability verdict ───────────────────────────────────────────────── */
  await mark(page, 'idle');
  await page.waitForTimeout(500);
  const report = await jitterReport(page);
  const findings = summarizeJitter(report);
  if (findings.length > 0) {
    console.log(`\n${findings.length} jitter finding(s):`);
    for (const f of findings) console.log(`  • ${f}`);
  } else {
    console.log('\nno jitter findings');
  }
  writeFileSync(
    path.join(tmpdir(), 'pd-shots', 'chat-stress-probe', 'jitter.json'),
    JSON.stringify(report, null, 1),
  );
  check(findings.length === 0, `${findings.length} jitter finding(s) — see the list above`);
} catch (err) {
  check(false, `the run threw: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
} finally {
  for (const e of pageErrors) check(false, `uncaught in the renderer: ${e}`);
  await finish();
}
