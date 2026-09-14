/**
 * THE COMPUTER-USE VIEW STAYS IN THE CHAT THAT IS DRIVING.
 *
 * the user (2026-09-12): "going to other chats, even when computer use is not
 * active in them after it previously has been in the current chat is pinning
 * a computer use tab in the canvas that reopens when closed, but when closing
 * the canvas entirely it does not reopen."
 *
 * Since 2026-09-13 the monitor is the ACTIVITY tab, and it opens on the chat's
 * own `mac …` call (activity-routing), never on the app-wide session by
 * itself — so the guarantee is structural: a chat whose thread never drove
 * the Mac can never show the monitor. This probe holds that line against the
 * real app, real pi (chat A needs a real session file) and the real helper's
 * monitor session on Notes (opened in the background, never activated; the
 * `mac:debug monitor-session` seam starts the session, a seeded `mac snapshot`
 * turn in A stands for the model's call). Then: new chat → no monitor there,
 * and none after the monitor's next state push; back to A → the Activity tab
 * is the monitor again; close it in A → it stays closed for that turn.
 *
 *   node apps/desktop/tests/e2e/mac-monitor-chat-scope-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'macmon-scope');
mkdirSync(SHOT_DIR, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const home = probeHome('macmon-scope');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    toolInterface: 'bash-cli',
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: MODEL },
  }),
);
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// Notes in the background: `-g` opens without bringing it forward.
execFileSync('open', ['-g', '-a', 'Notes']);
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'macmon-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await win.waitForTimeout(1500);
  const dbg = (op, params) =>
    win.evaluate((req) => window.piDesktop.invoke('mac:debug', req), { op, params });
  const tabs = () =>
    win.evaluate(() =>
      window.__pi_canvas
        ? window
            .__pi_canvas()
            .getState()
            .tabs.map((t) => ({ kind: t.kind, title: t.title }))
        : [],
    );
  const state = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return {
        file: s.session?.sessionFile ?? null,
        streaming: s.agent.isStreaming,
        bg: s.bgRun?.streaming === true,
      };
    });

  // Chat A: one real message so it has a session file.
  const editor = win.locator('[contenteditable="true"]').first();
  await editor.click();
  await win.keyboard.type('Reply with the single word: ready', { delay: 2 });
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => window.__pi_store().getState().agent.isStreaming, undefined, {
    timeout: 120000,
  });
  await win.waitForFunction(() => !window.__pi_store().getState().agent.isStreaming, undefined, {
    timeout: 180000,
  });
  await win.waitForTimeout(500);
  const a = await state();
  log('chat A:', JSON.stringify(a));
  check(typeof a.file === 'string' && a.file.length > 0, 'chat A has a session file');

  // Start a monitor session on Notes (no model: the debug seam does what the
  // tool's launch does).
  const b = await dbg('bounds', { app: 'Notes' });
  const pid = b.result?.pid;
  check(typeof pid === 'number', `Notes has a pid (${JSON.stringify(b).slice(0, 120)})`);
  const sess = await dbg('monitor-session', { pid, app: 'Notes' });
  check(sess.ok === true, `monitor-session started (${sess.error ?? ''})`);
  // A session with no call in the thread opens nothing — the tab is the
  // model's, not the session's.
  await win.waitForTimeout(1500);
  const tA0 = await tabs();
  check(
    !tA0.some((t) => t.kind === 'computer-use'),
    `a session alone opens no monitor tab (${JSON.stringify(tA0)})`,
  );
  // The model's own call, as the store records it.
  await win.evaluate(() => {
    const store = window.__pi_store();
    const now = Date.now();
    store.setState((s) => ({
      messages: [
        ...s.messages,
        {
          kind: 'assistant',
          id: 'a-mac-scope',
          blocks: [
            {
              type: 'toolCall',
              id: 'c-mac-scope',
              name: 'bash',
              arguments: { command: 'mac snapshot' },
            },
          ],
          timestamp: now,
          isStreaming: false,
        },
        {
          kind: 'toolResult',
          id: 'tr-mac-scope',
          toolCallId: 'c-mac-scope',
          toolName: 'bash',
          text: 'You are controlling Notes',
          isError: false,
          timestamp: now,
        },
      ],
    }));
  });
  await win.waitForFunction(
    () =>
      window
        .__pi_canvas?.()
        .getState()
        .tabs.some((t) => t.kind === 'computer-use'),
    undefined,
    { timeout: 10000 },
  );
  log('tabs in A:', JSON.stringify(await tabs()));
  writeFileSync(path.join(SHOT_DIR, '01-chat-a-tab.png'), await win.screenshot());

  // New chat → the tab must not come along, now or on the next state push.
  await win.locator('[data-testid="new-chat"]').click();
  await win.waitForTimeout(800);
  const tB1 = await tabs();
  log('tabs in B (fresh):', JSON.stringify(tB1), JSON.stringify(await state()));
  check(
    !tB1.some((t) => t.kind === 'computer-use'),
    'a new chat does not get the computer-use tab',
  );
  await dbg('overlay-cursor', { x: 500, y: 400 });
  await win.waitForTimeout(1800); // past the monitor's 1s heartbeat
  const tB2 = await tabs();
  check(
    !tB2.some((t) => t.kind === 'computer-use'),
    `…nor after the monitor's next state push (${JSON.stringify(tB2)})`,
  );
  const openB = await win.evaluate(
    () => document.querySelector('[data-testid="canvas-tab"], .pd-canvas-tab-main') !== null,
  );
  writeFileSync(path.join(SHOT_DIR, '02-chat-b-no-tab.png'), await win.screenshot());
  log('canvas tab strip visible in B:', openB);

  // Back to A → the tab is there (its own canvas).
  const rowA = win.locator('[data-testid^="chat-row-Reply with"]').first();
  check((await rowA.count()) > 0, 'chat A is in the sidebar');
  await rowA.click();
  await win.waitForTimeout(1000);
  const tA2 = await tabs();
  log('tabs back in A:', JSON.stringify(tA2), JSON.stringify(await state()));
  check(
    tA2.some((t) => t.kind === 'computer-use'),
    'returning to the driving chat shows its tab again',
  );

  // Close it in A → stays closed for this session.
  const closeBtn = win.locator('.pd-canvas-tab-close').first();
  if (await closeBtn.count()) await closeBtn.click();
  await win.waitForTimeout(300);
  await dbg('overlay-cursor', { x: 520, y: 420 });
  await win.waitForTimeout(1800);
  const tA3 = await tabs();
  check(
    !tA3.some((t) => t.kind === 'computer-use'),
    `a closed tab stays closed for the session (${JSON.stringify(tA3)})`,
  );
  writeFileSync(path.join(SHOT_DIR, '03-chat-a-closed-stays-closed.png'), await win.screenshot());

  await dbg('setDriving', { driving: false });
} finally {
  await app.close().catch(() => {});
}
console.log(
  failures.length === 0 ? 'mac-monitor-chat-scope-probe OK' : `FAILED: ${failures.length}`,
);
