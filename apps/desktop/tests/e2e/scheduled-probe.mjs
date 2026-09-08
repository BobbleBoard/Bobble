/**
 * SCHEDULED TASKS, driven end to end — the parts a unit test cannot see.
 *
 *   - the nav opens the real page: a plain title and the suggestions as rows
 *     on an empty schedule, no list, no search
 *   - New task is a dialog; a sentence typed as the instruction is PARSED
 *     honestly (nothing shown for "eve", the When controls follow a whole
 *     sentence), Schedule it saves the instruction WITHOUT its timing words
 *     and lands the row AND the keyboard
 *   - a task's page: the per-task switch pauses (the row says so, and sorts
 *     last); the kill switch speaks through the lede without moving the list
 *     or reordering rows
 *   - a task the MODEL'S TOOL wrote to the file appears without a restart,
 *     with its run history read off disk into the ledger: status, summary,
 *     the artifact, the trail in words, the model
 *   - a REAL run through the mock pi: the page says Running, the row counts
 *     seconds and sorts first, Stop is there — and Stop works: the record is
 *     finalised as stopped, on disk, and Run now comes back
 *   - Edit is the same dialog, prefilled, with no parse note on an existing
 *     instruction; Escape in the search clears the filter, not only the field
 *   - Delete asks once, then removes the task and its history and goes back
 *     to the list
 *
 * Hidden window, throwaway home, focus never moved (harness.mjs).
 */
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLOW_FIXTURE = path.join(HERE, 'fixtures', 'scheduled-slow.json');

const { page, shot, check, finish, home } = await launchApp('scheduled-probe', {
  fixture: SLOW_FIXTURE,
});
const STORE = path.join(home, '.pi', 'desktop', 'scheduled-tasks.json');
const RUNS = path.join(home, '.pi', 'desktop', 'scheduled-runs');

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror ${String(e).slice(0, 200)}`));

const focused = () =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a === null || a === document.body
      ? 'BODY'
      : (a.getAttribute('data-testid') ?? a.getAttribute('aria-label') ?? a.tagName);
  });
const boxOf = (sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r === undefined ? null : { x: Math.round(r.x), y: Math.round(r.y) };
  }, sel);
const rowIds = () =>
  page.$$eval('.sd-list [data-testid^="sd-row-"]:not([data-testid^="sd-row-word-"])', (els) =>
    els.map((e) => e.getAttribute('data-testid')),
  );
const rowNames = () =>
  page.$$eval('.sd-list .sd-row-name', (els) => els.map((e) => (e.textContent ?? '').trim()));
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const openTask = async (id) => {
  await page.click(`[data-testid="sd-row-${id}"]`);
  await page.waitForSelector('[data-testid="sd-detail"]', { timeout: 5_000 });
  await page.waitForTimeout(300);
};
const backToList = async () => {
  await page.click('[data-testid="sd-back"]');
  await page.waitForSelector('.sd-list', { timeout: 5_000 });
  await page.waitForTimeout(300);
};

try {
  await page.addStyleTag({ content: '[data-testid="first-run-tips"]{display:none !important}' });

  /* 1. The nav opens the real page. */
  console.log('\nthe page');
  await page.click('[data-testid="nav-scheduled"]');
  await page.waitForSelector('[data-testid="scheduled-view"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="sd-templates"]', { timeout: 5_000 });
  check(
    (await page.$$('[data-testid^="sd-template-"]')).length === 9,
    'an empty schedule offers the nine suggestions',
  );
  check((await page.$('.sd-list')) === null, 'no list when empty');
  check(
    (await page.$('[data-testid="sd-search"]')) === null,
    'no search when there is nothing to search',
  );
  check(
    (await text('[data-testid="sd-title"]')) === 'Scheduled' &&
      (await page.$eval('[data-testid="sd-title"]', (e) => e.getBoundingClientRect().height)) > 10,
    'the page has a plain title',
  );
  check(
    (await page.$('.sd-composer')) === null && (await page.$('.sd-header .pdc-pill')) === null,
    'no sentence box and no filter pills at rest',
  );
  await shot('1-empty');

  /* 2. New task is a dialog; the sentence is read honestly. */
  console.log('\nthe dialog');
  await page.click('[data-testid="sd-new"]');
  await page.waitForSelector('[data-testid="sd-editor"]', { timeout: 5_000 });
  await page.waitForTimeout(300);
  check(
    (await focused()) === 'sd-editor-prompt',
    `the caret is in the instruction (${await focused()})`,
  );
  await page.keyboard.type('eve');
  await page.waitForTimeout(150);
  check((await page.$('[data-testid="sd-parse"]')) === null, '"eve" shows no reading');
  await page.fill('[data-testid="sd-editor-prompt"]', '');
  await page.keyboard.type('every friday at 4:30pm run the full test suite');
  await page.waitForTimeout(200);
  const full = await page.evaluate(() => ({
    read: document.querySelector('[data-testid="sd-parse"]')?.getAttribute('data-read'),
    chip: document.querySelector('[data-testid="sd-parse-schedule"]')?.textContent ?? null,
    hint: document.querySelector('[data-testid="sd-parse-hint"]')?.textContent ?? '',
    frequency: document.querySelector('[data-testid="sd-editor-frequency"]')?.textContent ?? '',
    weekday: document.querySelector('[data-testid="sd-editor-weekday"]')?.textContent ?? '',
    hour: document.querySelector('[data-testid="sd-editor-hour"]')?.textContent ?? '',
    minute: document.querySelector('[data-testid="sd-editor-minute"]')?.textContent ?? '',
    preview: document.querySelector('[data-testid="sd-editor-preview"]')?.textContent ?? '',
  }));
  check(
    full.read === 'all' && full.chip === 'Every Friday at 4:30 PM',
    `a whole sentence reads back as a schedule (${JSON.stringify(full)})`,
  );
  check(
    full.hint.includes('“run the full test suite”'),
    `the note says what the instruction becomes (${full.hint})`,
  );
  check(
    /Every week/.test(full.frequency) &&
      /Friday/.test(full.weekday) &&
      /4 PM/.test(full.hour) &&
      /:30/.test(full.minute),
    `the When controls follow the sentence (${full.frequency} / ${full.weekday} / ${full.hour} / ${full.minute})`,
  );
  check(
    full.preview.includes('Every Friday at 4:30 PM') && /first run/.test(full.preview),
    `the dialog says what will happen ("${full.preview.slice(0, 80)}")`,
  );
  await shot('2-dialog');
  await page.click('[data-testid="sd-editor-save"]');
  await page.waitForSelector('.sd-list [data-testid^="sd-row-"]', { timeout: 5_000 });
  await page.waitForTimeout(500);
  check((await page.$('[data-testid="sd-editor"]')) === null, 'the dialog closes on save');
  const ids = await rowIds();
  check(ids.length === 1, `the task is in the list (${ids.length} rows)`);
  const firstId = (ids[0] ?? '').replace('sd-row-', '');
  const saved = JSON.parse(readFileSync(STORE, 'utf8')).tasks.find((t) => t.id === firstId);
  check(
    saved?.prompt === 'run the full test suite',
    `the timing words are left out of the instruction ("${saved?.prompt}")`,
  );
  check(
    saved?.frequency === 'weekly' &&
      saved?.weekday === 5 &&
      saved?.hour === 16 &&
      saved?.minute === 30,
    `the schedule was saved as read (${JSON.stringify({ f: saved?.frequency, d: saved?.weekday, h: saved?.hour, m: saved?.minute })})`,
  );
  check(
    (await focused()) === ids[0],
    `after Schedule it the keyboard is on the new row (${await focused()})`,
  );
  check(
    (await page.$('[data-testid="sd-more-templates"]')) !== null,
    'the suggestions stay one click away under the list',
  );
  await shot('3-one-task');

  /* 3. The switches. */
  console.log('\nthe switches');
  await openTask(firstId);
  await page.click('[data-testid="sd-task-switch"]');
  await page.waitForTimeout(400);
  check(
    (await page.getAttribute('[data-testid="sd-task-switch"]', 'data-state')) === 'unchecked',
    'the per-task switch pauses',
  );
  await backToList();
  check((await text(`[data-testid="sd-row-word-${firstId}"]`)) === 'paused', 'the row says paused');
  await openTask(firstId);
  await page.click('[data-testid="sd-task-switch"]');
  await page.waitForTimeout(400);
  await backToList();

  const listBefore = await boxOf('.sd-list');
  const orderBefore = await rowNames();
  await page.click('[data-testid="sd-scheduling-switch"]');
  await page.waitForTimeout(500);
  const off = await page.evaluate(() => ({
    off: document.querySelector('[data-testid="sd-lede"]')?.getAttribute('data-off'),
    lede: document.querySelector('[data-testid="sd-lede"]')?.textContent ?? '',
    word: document.querySelector('[data-testid^="sd-row-word-"]')?.textContent ?? '',
  }));
  check(
    off.off === 'true' && /off/.test(off.lede),
    'the kill switch says what it did, in the lede',
  );
  check(off.word === 'off', `the row says off (${off.word})`);
  const listAfter = await boxOf('.sd-list');
  check(
    listBefore !== null && listAfter !== null && listBefore.y === listAfter.y,
    `the kill switch does not move the list (${listBefore?.y} → ${listAfter?.y})`,
  );
  check(JSON.parse(readFileSync(STORE, 'utf8')).enabled === false, 'the global switch persisted');
  await shot('4-off');
  await page.click('[data-testid="sd-scheduling-switch"]');
  await page.waitForTimeout(500);
  check(
    JSON.stringify(await rowNames()) === JSON.stringify(orderBefore),
    'flipping the switch back and forth keeps the order',
  );

  /* 4. THE MODEL'S PATH. The tool writes the file directly; the list must pick
        it up live, and its history — written where main writes it — must be
        read into the ledger. The run record goes on disk FIRST, so the task's
        history is there when the row arrives. */
  console.log('\nthe tool writes the file');
  const toolTaskId = 'task_from_tool';
  const runDir = path.join(RUNS, toolTaskId, 'run_seed');
  mkdirSync(runDir, { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(path.join(runDir, 'face.png'), png);
  const runRecord = path.join(RUNS, toolTaskId, 'run_seed.json');
  writeFileSync(
    runRecord,
    JSON.stringify(
      {
        id: 'run_seed',
        taskId: toolTaskId,
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now() - 30_000,
        trigger: 'manual',
        status: 'ok',
        model: { id: 'gemma-4-12b', displayName: 'Gemma 4 12B' },
        summary: 'Summarised the day and rendered a face.',
        toolCalls: ['web_search', 'generate_image'],
        cwd: runDir,
        artifacts: [
          {
            path: path.join(runDir, 'face.png'),
            name: 'face.png',
            bytes: png.length,
            kind: 'image',
          },
        ],
      },
      null,
      2,
    ),
  );
  const doc = JSON.parse(readFileSync(STORE, 'utf8'));
  doc.tasks.push({
    id: toolTaskId,
    name: 'Made by the model',
    prompt: 'summarise the day',
    frequency: 'daily',
    hour: 18,
    minute: 0,
    weekday: 1,
    enabled: true,
    createdAt: Date.now(),
  });
  writeFileSync(STORE, JSON.stringify(doc, null, 2));
  await page.waitForSelector(`[data-testid="sd-row-${toolTaskId}"]`, { timeout: 5_000 });
  check((await rowIds()).length === 2, 'a tool-created task appears without a restart');

  await openTask(toolTaskId);
  await page.waitForSelector('[data-testid="sd-run-run_seed"]', { timeout: 5_000 });
  const ledger = await page.evaluate(() => {
    const run = document.querySelector('[data-testid="sd-run-run_seed"]');
    const t = run?.textContent ?? '';
    return {
      status: run?.getAttribute('data-status') ?? '',
      hasSummary: t.includes('rendered a face'),
      artifacts: run?.querySelectorAll('[data-testid="sd-artifact"]').length ?? 0,
      trail: run?.querySelector('.sd-run-trail')?.textContent ?? '',
      model: t.includes('Gemma 4 12B'),
      runsOn: document.querySelector('[data-testid="sd-runs-on"]')?.textContent ?? '',
      reaches: document.querySelector('[data-testid="sd-reach-block"] dd')?.textContent ?? '',
    };
  });
  check(ledger.status === 'ok', `the run shows its status (${ledger.status})`);
  check(ledger.hasSummary, 'the run shows its final report');
  check(ledger.artifacts === 1, `the run renders its artifact (${ledger.artifacts})`);
  check(ledger.trail === 'used Web · Images', `the trail is in words (${ledger.trail})`);
  check(ledger.model, 'the run says what ran it');
  check(/Gemma 4 12B/.test(ledger.runsOn), `Runs on names the last model (${ledger.runsOn})`);
  check(ledger.reaches === 'Web · Images', `Reaches is derived from the trail (${ledger.reaches})`);
  await shot('5-ledger');

  /* the run must NOT be a sidebar chat */
  check(
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="session-row-"]')].every(
        (r) => !(r.textContent ?? '').includes('Made by the model'),
      ),
    ),
    'a scheduled run never appears as a chat in the sidebar',
  );

  /* Edit: the same dialog, prefilled, with no parse note on an existing instruction. */
  console.log('\nedit');
  await page.click('[data-testid="sd-edit"]');
  await page.waitForSelector('[data-testid="sd-editor"]', { timeout: 5_000 });
  await page.waitForTimeout(300);
  check(
    (await page.inputValue('[data-testid="sd-editor-prompt"]')) === 'summarise the day' &&
      (await page.$('[data-testid="sd-parse"]')) === null,
    'Edit opens the instruction as it is, without reading it as a sentence',
  );
  await page.fill('[data-testid="sd-editor-name"]', 'Made by the model, renamed');
  await page.click('[data-testid="sd-editor-save"]');
  await page.waitForTimeout(500);
  check(
    (await text('[data-testid="sd-detail-title"]')) === 'Made by the model, renamed',
    'Save updates the task in place',
  );
  await page.click('[data-testid="sd-edit"]');
  await page.waitForSelector('[data-testid="sd-editor"]', { timeout: 5_000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check((await page.$('[data-testid="sd-editor"]')) === null, 'Escape closes the dialog');
  await backToList();

  /* 5. A REAL RUN, and a real Stop. */
  console.log('\nrun now, then stop');
  await openTask(firstId);
  await page.click('[data-testid="sd-run-now"]');
  await page.waitForSelector('[data-testid="sd-stop"]', { timeout: 10_000 });
  await page.waitForTimeout(2200);
  const running = await page.evaluate(() => ({
    state: document.querySelector('[data-testid="sd-state"]')?.textContent ?? '',
    runNow: document.querySelector('[data-testid="sd-run-now"]') !== null,
    runStatus:
      document.querySelector('[data-testid="sd-ledger"] .sd-run')?.getAttribute('data-status') ??
      '',
  }));
  check(/^Running · \d+s$/.test(running.state), `the page says Running (${running.state})`);
  check(!running.runNow, 'Run now is replaced by Stop while running');
  check(running.runStatus === 'running', `the ledger has the live run (${running.runStatus})`);
  await shot('6-running');
  await backToList();
  const rowWord = await text(`[data-testid="sd-row-word-${firstId}"]`);
  check(/^\d+s$/.test(rowWord ?? ''), `the running row counts seconds (${rowWord})`);
  check((await rowIds())[0] === `sd-row-${firstId}`, 'the running task sorts first');
  await openTask(firstId);

  await page.click('[data-testid="sd-stop"]');
  await page.waitForSelector('[data-testid="sd-ledger"] .sd-run[data-status="stopped"]', {
    timeout: 10_000,
  });
  await page.waitForTimeout(400);
  const stopped = await page.evaluate(() => ({
    runNow: document.querySelector('[data-testid="sd-run-now"]') !== null,
    headline: document.querySelector('[data-testid="sd-ledger"] .sd-run-body')?.textContent ?? '',
    aside: document.querySelector('.sd-section-aside')?.textContent ?? '',
  }));
  check(stopped.runNow, 'Run now returns once the run is stopped');
  check(
    /Stopped by hand/.test(stopped.headline),
    `the record says it was stopped (${stopped.headline.slice(0, 60)})`,
  );
  check(
    /1 stopped/.test(stopped.aside),
    `the tally counts it as stopped, not failed (${stopped.aside})`,
  );
  const onDisk = readFileSync(
    path.join(
      RUNS,
      firstId,
      `${await page.$eval('[data-testid="sd-ledger"] .sd-run', (e) => (e.getAttribute('data-testid') ?? '').replace('sd-run-', ''))}.json`,
    ),
    'utf8',
  );
  check(JSON.parse(onDisk).status === 'stopped', 'the stopped record is on disk');
  await shot('7-stopped');
  await backToList();

  /* 6. Escape in the search clears the filter. */
  console.log('\nsearch');
  await page.click('[data-testid="sd-search"] button');
  await page.keyboard.type('made by');
  await page.waitForTimeout(200);
  check((await rowIds()).length === 1, 'search filters the list (name or prompt)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check((await rowIds()).length === 2, 'Escape clears the filter, not only the field');

  /* 7. Delete asks once, then takes the task and its history, and goes back. */
  console.log('\ndelete');
  await openTask(toolTaskId);
  await page.click('[data-testid="sd-delete"]');
  await page.waitForSelector('[data-testid="sd-delete-armed"]');
  check(
    JSON.parse(readFileSync(STORE, 'utf8')).tasks.length === 2,
    'arming Delete removes nothing',
  );
  await page.click('[data-testid="sd-delete-confirm"]');
  await page.waitForSelector('.sd-list', { timeout: 5_000 });
  await page.waitForTimeout(400);
  check((await rowIds()).length === 1, 'delete removes the row and returns to the list');
  check(!existsSync(runRecord), 'deleting a task removes its run history too');

  check(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);
} finally {
  await finish();
}
