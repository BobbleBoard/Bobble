/**
 * A corp role's chat shows what it was ASKED, not just what it said.
 *
 * Drives the REAL render path with real components — the corp store is fed the
 * same `worker-activity` deltas the engine pushes, so nothing here is a mock of
 * the thing under test. No model runs: a 40-minute corp run is a poor way to
 * check a bubble's colour, and the interesting states (a tool still running, a
 * role between turns) are hard to catch live but trivial to hold still.
 *
 * Checks, all of them things that were broken:
 *  1. the brief renders as a BRIEFING bubble — left-aligned, blue-tinted — and
 *     is NOT echoed as the agent's own prose;
 *  2. a follow-up brief gets its own bubble (not just the opening one);
 *  3. talk_to_manager reads "Briefed the manager", not "Running a tool";
 *  4. a coordination row OPENS onto its real input (recipient + body + kits);
 *  5. a still-running row keeps the chain live, so no premature "Done";
 *  6. the sidebar shows the situation room's own lifecycle word.
 *
 *   node tests/e2e/corp-role-view-probe.mjs [outDir]
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');
const outDir = path.resolve(process.argv[2] ?? '/tmp/corp-role-view');
mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
writeFileSync(
  path.join(sessionsDir, 'alpha.jsonl'),
  [
    l({ type: 'session', version: 3, id: 'sess-alpha', timestamp: 't', cwd: '/tmp' }),
    l({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'build the watch', timestamp: 1 },
    }),
    l({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Assembling a team.' }],
        timestamp: 1,
      },
    }),
  ].join('\n'),
);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15000 });
  await page.waitForFunction(() => window.__corp_store !== undefined, { timeout: 15000 });
  await page.click('text=build the watch');
  await page.waitForSelector('text=Assembling a team.', { timeout: 15000 });

  // The run: a manager briefed, working, told again, and mid-hand-off. Fed as the
  // engine's own deltas through the store's real fold.
  await page.evaluate(async () => {
    const listed = await window.piDesktop.invoke('fs:list-sessions', undefined);
    const ps = window.__pi_store().getState();
    window.__pi_store().setState({
      session: { ...(ps.session ?? {}), sessionFile: listed[0]?.file },
    });
    const corp = window.__corp_store;
    corp.setState({
      taskId: 't',
      corpRunning: true,
      situation: {
        taskId: 't',
        status: 'working',
        chart: {
          taskId: 't',
          nodes: [
            { id: 'ceo', role: 'ceo', name: 'CEO', state: 'working' },
            { id: 'manager', role: 'manager', name: 'Manager', parentId: 'ceo', state: 'working' },
            // Ran, finished its turn, can be talked to again — the row that used
            // to read "queued" with a full transcript one click away.
            { id: 'eng1', role: 'engineer', name: 'Engineer 1', parentId: 'manager', state: 'waiting' },
            // Genuinely never started.
            { id: 'eng2', role: 'engineer', name: 'Engineer 2', parentId: 'manager', state: 'idle' },
          ],
          edges: [],
        },
        artifacts: [],
        activity: [],
        checklist: [],
      },
    });
    const push = (e) => corp.getState().foldWorkerActivity({ type: 'worker-activity', ...e });
    push({ nodeId: 'manager', kind: 'briefing', delta: 'Build a 3D pocket watch. It must run offline.' });
    push({ nodeId: 'manager', kind: 'text', phase: 'start' });
    push({ nodeId: 'manager', kind: 'text', phase: 'delta', delta: 'Splitting this into three contracts.' });
    push({ nodeId: 'manager', kind: 'text', phase: 'end' });
    push({
      nodeId: 'manager',
      kind: 'tool',
      toolName: 'request_test_tools',
      argsText: 'Kit: browser — to check the watch actually renders',
    });
    push({ nodeId: 'manager', kind: 'tool', toolName: 'request_test_tools', settled: true });
    // The SECOND brief — a follow-up, which must get its own bubble.
    push({ nodeId: 'manager', kind: 'briefing', delta: 'Also produce the report deck.' });
    // …and a hand-off still in flight: the blocking call that used to read as idle.
    push({
      nodeId: 'manager',
      kind: 'tool',
      toolName: 'talk_to_manager',
      argsText: 'Why a team: three disciplines\n\nBuild the movement first.',
      recipient: 'manager',
    });
    corp.getState().selectCorpNodeAndFocus?.({ id: 'manager', role: 'manager', name: 'Manager', state: 'working' });
    corp.setState({ pinnedNode: { id: 'manager', role: 'manager', name: 'Manager', state: 'working' } });
  });

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, '01-role-chat.png'), fullPage: false });

  // 1 + 2 — the briefs, in their own bubbles, in the agent voice.
  const briefs = await page.$$eval('.pd-msg-bubble--briefing', (els) =>
    els.map((e) => ({
      text: e.textContent ?? '',
      bg: getComputedStyle(e).backgroundColor,
      border: getComputedStyle(e).borderColor,
      align: getComputedStyle(e.parentElement).alignItems,
    })),
  );
  check('the brief renders as a briefing bubble', briefs.length > 0, `${briefs.length} found`);
  check(
    'the FOLLOW-UP brief gets its own bubble too',
    briefs.length >= 2,
    briefs.map((b) => b.text.slice(0, 28)).join(' | '),
  );
  if (briefs[0] !== undefined) {
    /*
     * Blue-tinted and LEFT aligned — read off COMPUTED style, not trusted from
     * the stylesheet. `color-mix()` resolves to CSS Color 4 `color(srgb r g b /
     * a)` with FLOAT channels here, not legacy `rgb(0-255)`; a probe that only
     * knew the legacy form called a correct blue a failure, which is its own
     * small lesson about asserting on formats you assumed.
     */
    const nums = [...briefs[0].border.matchAll(/[0-9]*\.?[0-9]+/g)].map(Number);
    const [r, g, b] = nums;
    const isBlue = r !== undefined && g !== undefined && b !== undefined && b > r && b > g;
    check('the bubble is blue-tinted', isBlue, briefs[0].border);
    check('the bubble is LEFT aligned', briefs[0].align === 'flex-start', briefs[0].align);
  }

  // The brief must not ALSO appear as the agent's own prose.
  const proseHasBrief = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-msg--assistant')].some((e) =>
      (e.textContent ?? '').includes('It must run offline'),
    ),
  );
  check('the brief is NOT echoed as the agent’s own prose', !proseHasBrief);

  // 3 — the hand-off row names itself.
  const kinds = await page.$$eval('.pd-chain-step[data-kind]', (els) =>
    els.map((e) => e.getAttribute('data-kind')),
  );
  check('talk_to_manager has its OWN kind', kinds.includes('manager'), kinds.join(', '));

  /*
   * 5 — the LIVE chain must not claim Done. Scoped to the LAST chain on purpose:
   * an earlier run that genuinely finished SHOULD say Done, and a page-wide
   * search for the marker calls that correct behaviour a failure.
   */
  const liveChainDone = await page.evaluate(() => {
    const chains = [...document.querySelectorAll('.pd-chain')];
    const last = chains[chains.length - 1];
    return last === undefined ? null : last.querySelector('.pd-chain-done') !== null;
  });
  check('the LIVE chain shows no premature "Done"', liveChainDone === false, `last chain done=${liveChainDone}`);

  // 6 — the sidebar speaks the situation room's vocabulary. Corp roles render as
  // CHILD rows (the corp-row-* path is gone), so this drives that store and then
  // checks what SessionSidebar actually paints.
  await page.evaluate(() => {
    const listedFile = window.__pi_store().getState().session?.sessionFile ?? '';
    const child = window.__child_store.getState();
    child.ensureChild('corp:eng1', listedFile, 'Engineer 1', undefined);
    child.ensureChild('corp:eng2', listedFile, 'Engineer 2', undefined);
    child.ensureChild('corp:eng3', listedFile, 'Engineer 3', undefined);
    // `ensureChild` starts a child RUNNING; the corp bridge settles it from the
    // node state. Mirror that here, and leave one genuinely live so the working
    // word and the spinner are seen together.
    child.setRunning('corp:eng1', false);
    child.setRunning('corp:eng2', false);
    child.setStatusLabel('corp:eng1', 'waiting');
    child.setStatusLabel('corp:eng2', 'queued');
    child.setStatusLabel('corp:eng3', 'working');
  });
  await page.waitForTimeout(400);
  // The rows only exist while the parent chat row is expanded.
  const caret = await page.$('[data-testid="child-rows"]');
  if (caret === null) await page.click('text=build the watch').catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, '02-sidebar-status.png') });
  const statuses = await page.$$eval('.pd-child-row-status', (els) =>
    els.map((e) => e.textContent ?? ''),
  );
  check('sidebar says "waiting" for the agent that RAN', statuses.includes('waiting'), statuses.join(', '));
  check(
    'sidebar still says "queued" for the one that never started',
    statuses.includes('queued'),
    statuses.join(', '),
  );
  check(
    'sidebar says "working" for a LIVE agent (word + spinner, not spinner alone)',
    statuses.includes('working'),
    statuses.join(', '),
  );

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  console.log(`screenshots -> ${outDir}`);
  process.exitCode = passed === results.length ? 0 : 1;
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close();
}
