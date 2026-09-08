/**
 * activity-tab-probe.mjs — ONE "Activity" tab, in the real app.
 *
 * the user's sequence, verbatim: "for example terminal, if it runs ls -la we get
 * shown the result there then it writes a file, then it runs some other terminal
 * command we still see above this next one as it's being typed the ls -la output
 * and command from before, everything persists."
 *
 * So that is exactly what this drives — `ls -la`, a file write, a second command
 * — against the real routers, the real CanvasController and the real xterm, with
 * only the language model skipped (worker activity is folded straight into the
 * pi store, which is what the engine's own drain does).
 *
 * What it asserts, and why each one is here rather than in a unit test:
 *   1. ONE tab. The count never leaves 1 and the tab id never changes: a morph,
 *      not a new tab, which is what keeps the xterm alive across the switch.
 *   2. The SCROLLBACK survives the round trip. After the file, the second
 *      command's terminal still renders `ls -la` and its output ABOVE `git
 *      status` — read out of the actual xterm rows, not out of the tab state.
 *   3. A registered CLI tool is NOT a terminal. `mac snapshot` arrives through
 *      the same bash call and must not reach the mirror.
 *   4. It never yanks. With the user on a tab of their own, new activity keeps
 *      updating Activity in the background and the active tab does not move.
 *
 * Headless by default (harness.mjs launches hidden and fails the run if focus
 * ever moved). `PI_E2E_VISIBLE=1 node tests/e2e/activity-tab-probe.mjs` to watch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const NOTES = `# Notes

Written by the model, shown in the one Activity tab.
`;

const { page, shot, check, finish, home, shotDir } = await launchApp('activity-tab', {
  waitFor: '[data-testid="composer-input"]',
});

/** The canvas tabs, flattened to what this probe cares about. */
const tabs = () =>
  page.evaluate(() => {
    const state = window.__pi_canvas().getState();
    return state.tabs.map((t) => ({
      id: t.id,
      key: t.key,
      kind: t.kind,
      title: t.title,
      subtitle: t.subtitle,
      filePath: t.filePath ?? null,
      active: t.id === state.activeTabId,
      mirror: typeof t.data?.mirrorText === 'string' ? t.data.mirrorText : null,
    }));
  });

/** The text the xterm has actually painted (the mirror as a person sees it). */
const xtermText = () =>
  page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows')
        ?.textContent ?? '',
  );

/** Replace the thread wholesale — the store is the seam every probe drives. */
const setMessages = (messages) =>
  page.evaluate((msgs) => window.__pi_store().setState({ messages: msgs }), messages);

/**
 * Settle past the rail's slide-in before capturing. The panel animates its width
 * and a frame taken mid-transition is neither the before nor the after — the
 * first run of this probe caught the rail at ~110px and produced a screenshot
 * that showed a working feature as a squashed sliver.
 */
const settle = () => page.waitForTimeout(900);

/** The canvas rail on its own, for reading the chrome at full size. */
const railShot = async (label) => {
  const el = await page.$('[data-testid="canvas-tabs-panel"]');
  if (el === null) return null;
  const file = path.join(shotDir, `${label}.png`);
  await el.screenshot({ path: file });
  return file;
};

const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const assistant = (id, blocks) => ({
  kind: 'assistant',
  id,
  blocks,
  timestamp: Date.now(),
  isStreaming: false,
});
const result = (id, text) => ({
  kind: 'toolResult',
  id: `tr-${id}`,
  toolCallId: id,
  toolName: 'bash',
  text,
  isError: false,
  timestamp: Date.now(),
});

try {
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 20_000 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });

  // A real file for the write step — the file surface reads it off disk.
  const projDir = path.join(home, 'proj');
  mkdirSync(projDir, { recursive: true });
  const notesPath = path.join(projDir, 'notes.md');
  writeFileSync(notesPath, NOTES);

  check((await tabs()).length === 0, `the canvas starts empty (got ${(await tabs()).length} tabs)`);

  // ── 1. ls -la ────────────────────────────────────────────────────────────
  const step1 = [
    assistant('a1', [call('c1', 'bash', { command: 'ls -la' })]),
    result(
      'c1',
      'total 8\ndrwxr-xr-x  4 the user  staff   128 Sep  7 22:00 .\n-rw-r--r--  1 the user  staff  1024 Sep  7 22:00 notes.md',
    ),
  ];
  await setMessages(step1);
  await page.waitForFunction(
    () =>
      window
        .__pi_canvas()
        .getState()
        .tabs.some((t) => t.key === 'pi:activity'),
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows', {
    timeout: 10_000,
  });
  await page.waitForFunction(
    () =>
      (
        document.querySelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows')
          ?.textContent ?? ''
      ).includes('total 8'),
    undefined,
    { timeout: 10_000 },
  );

  const afterLs = await tabs();
  const activityId = afterLs[0]?.id;
  check(afterLs.length === 1, `ls -la opened exactly one tab (got ${afterLs.length})`);
  check(
    afterLs[0]?.title === 'Activity',
    `the tab is named "Activity" (got "${afterLs[0]?.title}")`,
  );
  check(
    afterLs[0]?.kind === 'terminal',
    `a bash command shows a terminal (got ${afterLs[0]?.kind})`,
  );
  check(
    afterLs[0]?.subtitle === 'ls -la',
    `the subtitle names the command (got "${afterLs[0]?.subtitle}")`,
  );
  check(afterLs[0]?.active === true, 'the first relevant tool call brings Activity forward');
  await settle();
  const shot1 = await shot('01-terminal-ls-la');
  const rail1 = await railShot('01-rail-terminal-ls-la');

  // ── 2. …then it writes a file ────────────────────────────────────────────
  const step2 = [
    ...step1,
    assistant('a2', [call('c2', 'write', { path: notesPath, content: NOTES })]),
    result('c2', `wrote ${notesPath}`),
  ];
  await setMessages(step2);
  await page.waitForFunction(
    () =>
      window
        .__pi_canvas()
        .getState()
        .tabs.some((t) => t.kind === 'file'),
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () =>
      (window.__pi_canvas().getState().tabs[0]?.artifact?.content?.text ?? '').includes(
        'Written by the model',
      ),
    undefined,
    { timeout: 10_000 },
  );

  const afterWrite = await tabs();
  check(afterWrite.length === 1, `the write did NOT open a second tab (got ${afterWrite.length})`);
  check(afterWrite[0]?.id === activityId, 'it is the SAME tab, morphed — not a replacement');
  check(afterWrite[0]?.title === 'Activity', 'the tab is still named "Activity"');
  check(
    afterWrite[0]?.subtitle === 'notes.md',
    `the subtitle names the file (got "${afterWrite[0]?.subtitle}")`,
  );
  check(afterWrite[0]?.filePath === notesPath, 'the tab points at the file that was written');
  check(afterWrite[0]?.mirror === null, 'no terminal mirror rides along on the file view');
  await settle();
  const shot2 = await shot('02-file-written');
  const rail2 = await railShot('02-rail-file-written');

  // ── 3. …then another command: the earlier one is still above it ──────────
  const step3 = [
    ...step2,
    assistant('a3', [call('c3', 'bash', { command: 'git status --short' })]),
  ];
  await setMessages(step3);
  await page.waitForFunction(
    () => window.__pi_canvas().getState().tabs[0]?.kind === 'terminal',
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () =>
      (
        document.querySelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows')
          ?.textContent ?? ''
      ).includes('git status'),
    undefined,
    { timeout: 10_000 },
  );

  const painted = await xtermText();
  const afterSecond = await tabs();
  check(
    afterSecond.length === 1,
    `still exactly one tab after three actions (got ${afterSecond.length})`,
  );
  check(afterSecond[0]?.id === activityId, 'still the same tab id — the xterm was never destroyed');
  check(painted.includes('ls -la'), 'the FIRST command is still on screen');
  check(painted.includes('total 8'), 'the first command OUTPUT is still on screen');
  check(painted.includes('git status'), 'the new command is on screen too');
  check(
    painted.indexOf('total 8') < painted.indexOf('git status'),
    'the earlier command and its output sit ABOVE the new one',
  );
  await settle();
  const shot3 = await shot('03-terminal-scrollback');
  const rail3 = await railShot('03-rail-terminal-scrollback');

  // ── 4. a registered CLI tool is not a terminal ───────────────────────────
  const step4 = [
    ...step3,
    result('c3', ' M src/app.ts'),
    assistant('a4', [call('c4', 'bash', { command: 'mac snapshot --app Notes' })]),
    result('c4', 'window: Notes'),
  ];
  await setMessages(step4);
  await page.waitForTimeout(600);
  const afterCli = await tabs();
  check(afterCli.length === 1, `a CLI-tool invocation opened no tab (got ${afterCli.length})`);
  check(
    (afterCli[0]?.mirror ?? '').includes('mac snapshot') === false,
    'a `mac …` line is the mac tool, not a shell command — it stays out of the terminal',
  );
  check(
    (afterCli[0]?.mirror ?? '').includes('git status'),
    'the real commands are all still in the mirror',
  );

  // ── 4b. an EDIT lands on the same tab, as the file ───────────────────────
  // The presentation (a played motion, or the diff when the motion cannot be
  // planned) belongs to queue item 4 and is decided by `presentEdit`, which this
  // router calls rather than re-implements. What matters HERE is that an edit
  // reaches the one tab, pointed at the file it edits.
  const step4b = [
    ...step4,
    assistant('a4b', [
      call('c6', 'edit', {
        path: notesPath,
        old_string: 'Written by the model',
        new_string: 'Edited by the model',
      }),
    ]),
  ];
  await setMessages(step4b);
  await page.waitForFunction(
    () => window.__pi_canvas().getState().tabs[0]?.kind === 'file',
    undefined,
    { timeout: 10_000 },
  );
  const afterEdit = await page.evaluate(() => {
    const t = window.__pi_canvas().getState().tabs[0];
    return {
      count: window.__pi_canvas().getState().tabs.length,
      id: t?.id,
      filePath: t?.filePath ?? null,
      subtitle: t?.subtitle,
      shown: t?.editAnim !== undefined ? 'motion' : t?.diff !== undefined ? 'diff' : 'file',
    };
  });
  check(afterEdit.count === 1, `an edit opened no tab of its own (got ${afterEdit.count})`);
  check(afterEdit.id === activityId, 'the edit morphed the SAME Activity tab');
  check(afterEdit.filePath === notesPath, 'it points at the edited file');
  check(afterEdit.subtitle === 'notes.md', 'the subtitle names the edited file');
  console.log(`      (the edit is presented as: ${afterEdit.shown})`);

  // ── 5. it never yanks the user off a tab they chose ──────────────────────
  const mineId = await page.evaluate(() =>
    window.__pi_canvas().openTab({
      kind: 'markdown',
      title: 'Mine',
      artifact: { id: 'mine', content: { kind: 'markdown', text: '# reading this' } },
    }),
  );
  await page.waitForTimeout(300);
  await setMessages([
    ...step4b,
    assistant('a5', [call('c5', 'bash', { command: 'echo still-working' })]),
  ]);
  await page.waitForFunction(
    () =>
      (
        window
          .__pi_canvas()
          .getState()
          .tabs.find((t) => t.key === 'pi:activity')?.data?.mirrorText ?? ''
      ).includes('still-working'),
    undefined,
    { timeout: 10_000 },
  );
  const active = await page.evaluate(() => window.__pi_canvas().getState().activeTabId);
  check(active === mineId, 'new activity updated in the BACKGROUND — the chosen tab kept focus');
  await settle();
  const shot4 = await shot('04-background-morph');
  const rail4 = await railShot('04-rail-background-morph');

  console.log(
    `\nscreenshots:\n  ${shot1}\n  ${rail1}\n  ${shot2}\n  ${rail2}\n  ${shot3}\n  ${rail3}\n  ${shot4}\n  ${rail4}`,
  );
} finally {
  await finish();
}
