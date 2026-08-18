/**
 * SCHEDULED TASKS, driven end to end.
 *
 * The parts a unit test cannot see: that the nav actually opens a real view and
 * not the old stub, that typing a sentence produces a correctly-parsed draft,
 * that the switches move real state, and — the one most likely to be quietly
 * broken — that a task written to the file by the MODEL'S TOOL shows up in the
 * list without a restart.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(appRoot, '.probe-shots');
const STORE = path.join(homedir(), '.pi', 'desktop', 'scheduled-tasks.json');

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
}

mkdirSync(OUT, { recursive: true });
// Start from a known-empty schedule; restore whatever was there afterwards.
const had = existsSync(STORE);
const backup = had ? path.join(tmpdir(), `sched-backup-${Date.now()}.json`) : null;
if (had && backup !== null) writeFileSync(backup, require('node:fs').readFileSync(STORE));
rmSync(STORE, { force: true });

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'sched-'))}`],
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20_000 });
  await page.addStyleTag({ content: '[data-testid="first-run-tips"]{display:none !important}' });

  /* 1. The nav opens a real view, not the old "coming soon" stub. */
  console.log('\nthe view');
  await page.click('[data-testid="nav-scheduled"]');
  await page.waitForSelector('[data-testid="scheduled-view"]', { timeout: 10_000 });
  check((await page.$('[data-testid="stub-panel"]')) === null, 'it is a real view, not a stub');
  check((await page.$('[data-testid="tasks-empty"]')) !== null, 'an empty schedule offers templates');
  await page.screenshot({ path: path.join(OUT, 'sched-1-empty.png') });

  /* 2. Type it. The draft must be PARSED, not just dumped into the prompt. */
  console.log('\ndescribe-it-in-words');
  await page.fill('[data-testid="tasks-quick-input"]', 'every friday at 4:30pm run the full test suite');
  await page.click('[data-testid="tasks-quick-go"]');
  await page.waitForSelector('[data-testid="task-dialog"]', { timeout: 5_000 });
  const draft = await page.evaluate(() => ({
    prompt: document.querySelector('[data-testid="task-prompt"]')?.value ?? '',
    when: document.querySelector('[data-testid="task-when-preview"]')?.textContent ?? '',
  }));
  check(draft.prompt === 'run the full test suite', `the timing words are stripped ("${draft.prompt}")`);
  check(draft.when === 'Every Friday at 4:30 PM', `the schedule is read correctly ("${draft.when}")`);
  await page.screenshot({ path: path.join(OUT, 'sched-2-dialog.png') });
  await page.click('[data-testid="task-save"]');
  await page.waitForSelector('[data-testid="tasks-list"]', { timeout: 5_000 });
  check((await page.$$('[data-testid^="task-row-"]')).length === 1, 'the task is in the list');

  /* 3. The switches. */
  console.log('\nthe switches');
  const nextBefore = await page.textContent('[data-testid^="task-next-"]');
  await page.click('[data-testid^="task-toggle-"]');
  await page.waitForTimeout(400);
  const nextPaused = await page.textContent('[data-testid^="task-next-"]');
  check(nextPaused === 'paused', `pausing one task shows it paused (${nextBefore} -> ${nextPaused})`);
  await page.click('[data-testid^="task-toggle-"]');
  await page.waitForTimeout(400);

  await page.click('[data-testid="tasks-enabled"]');
  await page.waitForTimeout(400);
  check(
    (await page.$('[data-testid="tasks-off-note"]')) !== null,
    'the global switch says what it did rather than going quiet',
  );
  const persistedOff = JSON.parse(require('node:fs').readFileSync(STORE, 'utf8')).enabled;
  check(persistedOff === false, 'the global switch persisted');
  await page.click('[data-testid="tasks-enabled"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'sched-3-list.png') });

  /* 4. THE MODEL'S PATH. The tool writes the file directly; the list must pick
        it up live, or the model tells the user about a task they cannot see. */
  console.log('\nthe tool writes the file');
  const doc = JSON.parse(require('node:fs').readFileSync(STORE, 'utf8'));
  doc.tasks.push({
    id: 'task_from_tool',
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
  await page.waitForTimeout(1500);
  const rows = await page.$$('[data-testid^="task-row-"]');
  check(rows.length === 2, `a tool-created task appears without a restart (${rows.length} rows)`);

  /* 5. Delete gets rid of it. */
  await page.click('[data-testid="task-delete-task_from_tool"]');
  await page.waitForTimeout(500);
  check(
    (await page.$$('[data-testid^="task-row-"]')).length === 1,
    'delete removes the row',
  );

  console.log(
    failures.length === 0
      ? '\nscheduled-probe: all checks passed'
      : `\nscheduled-probe: ${failures.length} FAILURE(S)\n - ${failures.join('\n - ')}`,
  );
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
  rmSync(STORE, { force: true });
  if (backup !== null) writeFileSync(STORE, require('node:fs').readFileSync(backup));
}
