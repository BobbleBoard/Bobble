/**
 * Seed data for the candidate screenshots.
 *
 * Tasks are TaskDrafts (electron/scheduled/scheduled-contract.ts) and go
 * through the real `tasks:create` handler, so main normalises and persists
 * them exactly as it would for a person. Runs are TaskRun records — the same
 * shape the runner writes to ~/.pi/desktop/scheduled-runs — built relative to
 * `now`, and ON REAL SLOTS: a weekdays task's runs land on weekdays, a Friday
 * task's on Fridays, so "ran late" (trigger + slot) means what it says.
 *
 * Every task with runs is stamped `lastRunAt` (see `lastRunAtFor`). Round one
 * did not, and the REAL scheduler caught the 7:30 and 8:00 tasks up between
 * two screenshots — through the mock pi, which wrote "Done — hello.txt now
 * greets the world" into the ledger I was photographing.
 *
 * The prompts are the app's own starter templates (src/scheduled/templates.ts),
 * because a candidate should be judged on what the app can actually do.
 */

const REPO = '/Users/user/Desktop/OSS-harness';

/**
 * Where run folders live. The probe points this at the throwaway HOME's
 * `~/.pi/desktop/scheduled-runs` — a root pd-file:// will serve — and drops a
 * real PNG there, so the image a run "made" actually renders as a thumbnail.
 */
let RUNS_DIR = '/Users/user/.pi/desktop/scheduled-runs';
export function withRunsDir(dir) {
  RUNS_DIR = dir;
}

export const SEED_TASKS = [
  {
    name: 'Morning brief',
    prompt:
      'Turn on the "personal" capability, then write me a short brief for today.\n\n' +
      'Cover, in this order: what is on my calendar today (times and titles); any mail that arrived ' +
      'since yesterday evening that looks like it needs me, with who it is from and one line on why; ' +
      'and reminders due today or overdue.\n\n' +
      'Be brief and specific. No preamble, no "here is your brief". If a section has nothing in it, ' +
      'say so in one line rather than padding. If you cannot reach Calendar, Mail or Reminders, say ' +
      'which one and stop; do not guess.',
    frequency: 'weekdays',
    hour: 7,
    minute: 30,
    weekday: 1,
    enabled: true,
  },
  {
    name: 'Run the tests',
    prompt:
      'Run the test suite in my working folder. If everything passes, say so in one line. ' +
      'If anything fails, show the failing test names and the relevant output, and say what you think broke.',
    frequency: 'daily',
    hour: 7,
    minute: 30,
    weekday: 1,
    enabled: true,
    cwd: REPO,
  },
  {
    name: 'What changed today',
    prompt:
      'Look at the git history in my working folder for the last 24 hours. Summarise what changed, ' +
      'grouped by area, and call out anything that looks risky or unfinished.',
    frequency: 'weekdays',
    hour: 18,
    minute: 0,
    weekday: 1,
    enabled: true,
    cwd: REPO,
  },
  {
    name: 'Weekly review',
    prompt:
      'Summarise my week: what changed in my working folder, what I was working on across my chats, ' +
      'and what is still open. Keep it short and specific. Save it as weekly-review.md.',
    frequency: 'weekly',
    hour: 16,
    minute: 0,
    weekday: 5,
    enabled: true,
  },
  {
    name: 'Watch llama.cpp releases',
    prompt:
      'Search the web for anything new in the last day about llama.cpp releases and Metal backend changes. ' +
      'Summarise what actually changed, skip the reposts, and link the sources.',
    frequency: 'daily',
    hour: 9,
    minute: 0,
    weekday: 1,
    enabled: true,
  },
  {
    name: 'Dependency check',
    prompt:
      'Check my working folder for outdated dependencies and known advisories. ' +
      'List what is worth updating and what would be risky, with a one-line reason each. Do not change anything.',
    frequency: 'weekly',
    hour: 9,
    minute: 0,
    weekday: 1,
    enabled: false,
    cwd: REPO,
  },
  {
    name: 'Sort my Downloads',
    prompt:
      'Look at ~/Downloads. Summarise what has arrived since yesterday, group it by kind, ' +
      'and suggest a tidy-up. List the moves you would make before making any of them.',
    frequency: 'manual',
    hour: 19,
    minute: 0,
    weekday: 1,
    enabled: true,
  },
  {
    name: 'Portrait of the day',
    prompt:
      'Generate one portrait in the style of a 1970s passport photo of a different animal each day, ' +
      '1024×1024, and save it as portrait.png. One line on which animal and why.',
    frequency: 'daily',
    hour: 8,
    minute: 0,
    weekday: 1,
    enabled: true,
  },
  // Aged by the probe (see AGED_TASK_INDEX): never run, its last slot is more
  // than six hours gone, so the scheduler will not catch it up → "missed".
  {
    name: 'What did I miss',
    prompt:
      'Turn on the "personal" capability, then tell me what I missed today.\n\n' +
      'Look at mail and messages from the last day. Group them into: needs a reply, worth knowing, ' +
      'and ignorable. For anything in the first group, say who it is from and what they want in one ' +
      'line. Do not reply to anything.',
    frequency: 'weekdays',
    hour: 18,
    minute: 30,
    weekday: 1,
    enabled: true,
  },
];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Index of the task the probe AGES (createdAt set a week back through
 * `tasks:update`) so a slot that passed while nothing was running reads as
 * MISSED — the state a fresh task can never be in.
 */
export const AGED_TASK_INDEX = 8;

/**
 * The slots of a task that have already passed, newest first — the same walk
 * schedule-logic's previousRun does, so a seeded run sits where the scheduler
 * would have put it. `count` slots back; weekends skipped for weekdays tasks,
 * other days skipped for a weekly one.
 */
function pastSlots(task, now, count) {
  const out = [];
  for (let i = 0; out.length < count && i < 60; i++) {
    const d = new Date(now - i * DAY);
    d.setHours(task.hour, task.minute, 0, 0);
    if (d.getTime() > now) continue;
    const day = d.getDay();
    if (task.frequency === 'weekdays' && (day === 0 || day === 6)) continue;
    if (task.frequency === 'weekly' && day !== task.weekday) continue;
    out.push(d.getTime());
  }
  return out;
}

function run(id, startedAt, seconds, status, summary, toolCalls, extra = {}) {
  return {
    id,
    taskId: '',
    startedAt,
    trigger: extra.trigger ?? 'schedule',
    ...(status === 'running' ? {} : { finishedAt: startedAt + seconds * 1000 }),
    status,
    summary,
    toolCalls,
    cwd: extra.cwd ?? `${RUNS_DIR}/task/${id}`,
    artifacts: extra.artifacts ?? [],
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

const BLOCKED =
  'calendar_list_events was blocked: this Mac has not granted Automation (System Settings › Privacy & ' +
  'Security › Automation). Grant it once and the task will work from the next run.';

/** Runs per SEED_TASKS index, newest first, as the runner lists them. */
export const SEED_RUNS = [
  // Morning brief — a week of it, including the morning macOS said no.
  (now) => {
    const s = pastSlots(SEED_TASKS[0], now, 5);
    return [
      run(
        'run_a1',
        s[0],
        41,
        'ok',
        'Calendar: 10:00 Bobble sync (30 min), 14:30 dentist.\n' +
          'Mail that needs you: Priya (Anthropic) — asks for the connector spec by Thursday; ' +
          'Ben — invoice #2231 is due, wants a yes/no.\n' +
          'Reminders: "renew domain" is overdue by 2 days.',
        ['calendar_list_events', 'mail_recent', 'reminders_list'],
      ),
      run(
        'run_a2',
        s[1],
        38,
        'ok',
        'Calendar: nothing today.\nMail: two newsletters, nothing that needs a reply.\nReminders: none due.',
        ['calendar_list_events', 'mail_recent', 'reminders_list'],
      ),
      run('run_a3', s[2], 6, 'error', '', ['calendar_list_events'], { error: BLOCKED }),
      run(
        'run_a4',
        s[3],
        44,
        'ok',
        'Calendar: 09:30 standup, 16:00 review with the user.\nMail: Ben — invoice #2231 sent.\nReminders: none.',
        ['calendar_list_events', 'mail_recent', 'reminders_list'],
      ),
      run(
        'run_a5',
        s[4],
        40,
        'ok',
        'Calendar: all-day "offsite".\nMail: nothing that needs you.\nReminders: "book train" due today.',
        ['calendar_list_events', 'mail_recent', 'reminders_list'],
      ),
    ];
  },
  // Run the tests — one green, one that found something.
  (now) => {
    const s = pastSlots(SEED_TASKS[1], now, 3);
    return [
      run('run_b1', s[0] + 40_000, 134, 'ok', 'All 212 tests passed in 2m 06s.', ['bash'], {
        cwd: REPO,
      }),
      run(
        'run_b2',
        s[1] + 35_000,
        141,
        'ok',
        '2 of 212 failed.\n\n' +
          '• schedule-logic.test.ts › dueTasks skips a miss older than the grace window\n' +
          '  expected [] but got [task_weekly] — previousRun() walks 10 days, so a weekly task ' +
          'whose slot was 9 days ago is still "due".\n' +
          '• scheduled-runner.test.ts › records artifacts for a dedicated run dir\n' +
          '  ENOENT on the temp dir — looks like the test tears it down before scanArtifacts runs.',
        ['bash', 'read'],
        { cwd: REPO },
      ),
      run('run_b3', s[2] + 31_000, 129, 'ok', 'All 210 tests passed in 2m 01s.', ['bash'], {
        cwd: REPO,
      }),
    ];
  },
  // What changed today — the newest run is the caught-up one: the slot was
  // 6:00 PM, the Mac was asleep, and it ran 1h 42m late when the lid opened.
  // With `trigger: 'schedule'` the ledger can say so without guessing.
  (now) => {
    const s = pastSlots(SEED_TASKS[2], now, 2);
    return [
      run(
        'run_c1',
        s[0] + 102 * MIN,
        52,
        'ok',
        '3 commits, 14 files.\n\n' +
          'power: back off for the wall THIS machine is nearest — the stress run found the global ' +
          'slider was throttling a plugged-in M5 Pro as if it were on battery.\n' +
          'probes: two red-for-weeks probes deleted rather than fixed (tripo-decisions, round4).\n' +
          'chat: the jitter-aware stress run and the three things it found.\n\n' +
          'Risky: power-main.ts now reads the thermal wall from IOKit every tick with no cache; ' +
          'nothing bounds that call if IOKit stalls.',
        ['bash', 'read', 'read'],
        { cwd: REPO },
      ),
      run(
        'run_c2',
        s[1],
        47,
        'ok',
        '1 commit, 3 files. context card: the fill was an inline span, so it drew nothing. Nothing risky.',
        ['bash', 'read'],
        { cwd: REPO },
      ),
    ];
  },
  // Weekly review — leaves a file behind.
  (now) => {
    const s = pastSlots(SEED_TASKS[3], now, 1);
    return [
      run(
        'run_d1',
        s[0],
        171,
        'ok',
        'Written to weekly-review.md. Headline: the power work landed and stress-tested; the schedule ' +
          'candidates are still open; the 3D rig verification is done.',
        ['bash', 'read', 'write'],
        {
          artifacts: [
            {
              path: `${RUNS_DIR}/task/run_d1/weekly-review.md`,
              name: 'weekly-review.md',
              bytes: 4812,
              kind: 'text',
            },
          ],
        },
      ),
    ];
  },
  // Watch a topic — this morning, and the day before.
  (now) => {
    const s = pastSlots(SEED_TASKS[4], now, 2);
    return [
      run(
        'run_e1',
        s[0],
        63,
        'ok',
        'Two real changes since yesterday:\n' +
          '• b6421 — Metal: fused RMSNorm+matmul for Q4_K, ~7% faster prefill on M-series (github.com/ggml-org/llama.cpp/pull/…)\n' +
          '• b6419 — server: --slot-save-path restore fixed to reuse KV instead of re-prefilling\n' +
          'Skipped: 4 reposts of the b6421 release notes.',
        ['web_search', 'fetch', 'fetch'],
      ),
      run(
        'run_e2',
        s[1],
        58,
        'ok',
        'Nothing new. The only items were the same b6418 notes reposted three times.',
        ['web_search', 'fetch'],
      ),
    ];
  },
  // Dependency check — paused, last ran a week ago.
  (now) => {
    const s = pastSlots(SEED_TASKS[5], now, 2);
    return [
      run(
        'run_f1',
        s[1] ?? s[0],
        96,
        'ok',
        'Worth doing: vite 8.1.3 → 8.2.0 (fixes the HMR reconnect loop we hit). ' +
          'Risky: electron 43 → 44 (changes utilityProcess fork semantics; the supervisor relies on them). ' +
          'No advisories.',
        ['bash', 'read'],
        { cwd: REPO },
      ),
    ];
  },
  // Sort my Downloads — run by hand once, three evenings ago.
  (now) => [
    run(
      'run_g1',
      now - 3 * DAY - 2 * HOUR,
      33,
      'ok',
      '14 files since yesterday: 9 screenshots, 3 PDFs (two invoices, one datasheet), 2 .dmg. ' +
        'Suggested: screenshots → ~/Pictures/Screenshots, invoices → ~/Documents/Invoices/2026, ' +
        'delete both .dmg (already installed). No moves made.',
      ['bash', 'read'],
      { trigger: 'manual' },
    ),
  ],
  // Portrait of the day — running right now (started by hand), and yesterday's picture.
  (now) => {
    const s = pastSlots(SEED_TASKS[7], now, 2);
    return [
      run('run_h1', now - 24 * 1000, 0, 'running', '', ['generate_image'], { trigger: 'manual' }),
      run(
        'run_h2',
        s[1] ?? s[0],
        212,
        'ok',
        'A red panda — it has the look of someone who has been asked to remove their glasses.',
        ['generate_image', 'write'],
        {
          artifacts: [
            {
              path: `${RUNS_DIR}/task/run_h2/portrait.png`,
              name: 'portrait.png',
              bytes: 1_204_331,
              kind: 'image',
            },
          ],
        },
      ),
    ];
  },
];

/**
 * How far AHEAD a seeded task is stamped as having run. The REAL scheduler
 * ticks in main every 30s against the wall clock; a stamp at the newest seeded
 * run's start (round two) only covers slots that had already passed, so a
 * slot arriving DURING a shoot (9:00 came round between the dark and the light
 * `ledger-plus-default`) was caught up through the mock pi and rewrote the
 * ledger mid-run. A stamp two hours out covers every slot the shoot can
 * cross. Nothing on the page reads `lastRunAt` directly — the candidates take
 * "last ran" as the later of the stamp and the newest run record, and for a
 * stamped task both say "caught up".
 */
export const HOLD_MS = 2 * HOUR;

/**
 * The `lastRunAt` a task should carry so the live scheduler leaves it alone
 * for the whole shoot (see HOLD_MS). Undefined for a task with no runs — the
 * aged one MUST stay unstamped, or it stops being missed.
 */
export function holdStampFor(index, now) {
  return SEED_RUNS[index] === undefined ? undefined : now + HOLD_MS;
}
