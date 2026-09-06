/**
 * MP6 — the roles in a running hierarchy are listed somewhere you can click them,
 * and clicking one pins it so its work is what you are watching.
 *
 * WHERE THEY ARE LISTED MOVED, and this probe was asserting the old address. MP6
 * put them in the sidebar's nested dropdown as `corp-row-<id>`, beside the child
 * agent rows. Then subagent/chat parity collapsed the two: a role and a subagent
 * are the same thing to look at, so they became ONE list of `subagent-row`s in the
 * situation room behind the Agent activity tab, with the root listed FIRST — the user:
 * "there's no way back to the CEO, the top of the situation room shows the
 * manager." Nothing in `src` has rendered `corp-row-*` since, so this waited eight
 * seconds for an element that could not exist.
 *
 * The BEHAVIOUR under test is unchanged and is still worth a probe, so it moves to
 * the surface that has it. The store is driven directly (a real hierarchy needs a
 * real model); mock-pi clobbers a pinned session on its next event, so the pin and
 * the injection happen in ONE tick. `npm run build` first.
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

const assert = (c, m) => {
  if (!c) throw new Error(`corp-dropdown-probe failed: ${m}`);
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
      message: { role: 'user', content: 'build the app', timestamp: 1 },
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
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 8000 });
  await page.waitForFunction(() => window.__corp_store !== undefined, { timeout: 8000 });
  await page.click('text=build the app');
  await page.waitForSelector('text=Assembling a team.', { timeout: 8000 });

  // Pin the viewed chat's session + inject the corp run in ONE tick, so the pin
  // (needed for effectiveCurrentFile === s.file) isn't clobbered by a mock-pi event
  // before the corp rows render. `taskId: null` keeps corp's INLINE thread view from
  // rendering (it needs a full SituationState) — we only exercise the sidebar rows.
  await page.evaluate(async () => {
    const listed = await window.piDesktop.invoke('fs:list-sessions', undefined);
    const ps = window.__pi_store().getState();
    window.__pi_store().setState({
      session: { ...(ps.session ?? {}), sessionFile: listed[0]?.file },
    });
    const chart = {
      taskId: 't',
      nodes: [
        { id: 'ceo', role: 'ceo', name: 'CEO', state: 'working' },
        { id: 'fe', role: 'engineer', name: 'Frontend', parentId: 'ceo', state: 'working' },
        { id: 'be', role: 'engineer', name: 'Backend', parentId: 'ceo', state: 'done' },
      ],
      edges: [
        { from: 'ceo', to: 'fe' },
        { from: 'ceo', to: 'be' },
      ],
    };
    const corp = window.__corp_store;
    corp.setState({ taskId: 't', corpRunning: true });
    corp.getState().foldEvent({ type: 'org-chart', chart });
    corp.getState().trackChart(chart);

    /*
     * The room folds its OWN state from the event stream rather than reading the
     * store, so it gets the same `org-chart` event ChatApp would have handed it
     * on promotion. The stream then stays open, because a real run's does — a
     * stream that ends is a finished task and the room renders accordingly.
     */
    const events = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'org-chart', chart };
        await new Promise(() => undefined);
      },
    };
    window.__pi_canvas().upsertTab('situation:t', {
      kind: 'situation',
      title: 'Subagents',
      situationEvents: events,
      situationTaskId: 't',
      situationUserMode: 'power',
    });
  });

  // Open the canvas the way a person does, rather than reaching for its store.
  // The control only exists while the canvas is CLOSED — upserting a tab can
  // bring the rail up on its own, and then there is nothing to click.
  const opener = page.locator('[data-testid="canvas-toggle"]');
  if ((await opener.count()) > 0) await opener.click();
  await page.waitForSelector('[data-testid="situation-room"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="subagent-row"][data-node-id="fe"]', { timeout: 8000 });
  await page.waitForSelector('[data-testid="subagent-row"][data-node-id="be"]', { timeout: 8000 });

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="subagent-row"]')].map((r) => ({
      id: r.getAttribute('data-node-id'),
      text: r.textContent ?? '',
    })),
  );
  assert(
    rows[0]?.id === 'ceo',
    `the root must be listed FIRST — "there's no way back to the CEO" — got ${JSON.stringify(rows.map((r) => r.id))}`,
  );
  const fe = rows.find((r) => r.id === 'fe');
  assert(fe?.text.includes('Frontend') === true, `a role row shows its name: ${fe?.text}`);
  await page.screenshot({
    path: path.join(process.env.CORP_DROPDOWN_OUT ?? tmpdir(), '01-corp-roles-listed.png'),
  });

  // Clicking a role pins it — which is what makes the chat pane show ITS stream.
  await page.click('[data-testid="subagent-row"][data-node-id="fe"]');
  await page.waitForFunction(() => window.__corp_store.getState().pinnedNode?.id === 'fe', {
    timeout: 8000,
  });
  // And the way back the root row exists for.
  await page.click('[data-testid="subagent-row"][data-node-id="ceo"]');
  await page.waitForFunction(() => window.__corp_store.getState().pinnedNode?.id === 'ceo', {
    timeout: 8000,
  });
  await page.screenshot({
    path: path.join(process.env.CORP_DROPDOWN_OUT ?? tmpdir(), '02-corp-role-pinned.png'),
  });

  console.log(
    'corp-dropdown-probe OK — a running hierarchy lists every role in the situation room with the CEO first; clicking one pins it for viewing, and the CEO row is the way back',
  );
} finally {
  await app.close();
}
