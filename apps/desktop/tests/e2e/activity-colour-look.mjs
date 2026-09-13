/**
 * LOOK at the Activity tab's colour: a prompt with user + folder, a passing
 * command, a failing one (red), a quiet one (dim), and output that brought
 * its own colour. the user (2026-09-12): "need color coded text in the terminal
 * in the canvas."
 *
 *   SHOT_DIR=/tmp/activity-colour node apps/desktop/tests/e2e/activity-colour-look.mjs
 */
import { launchApp } from './harness.mjs';

const { page, finish } = await launchApp('activity-colour', {
  waitFor: '[data-testid="composer-input"]',
});
const call = (id, cmd) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: cmd } });
const assistant = (id, blocks) => ({
  kind: 'assistant',
  id,
  blocks,
  timestamp: Date.now(),
  isStreaming: false,
});
const result = (id, text, isError = false) => ({
  kind: 'toolResult',
  id: `tr-${id}`,
  toolCallId: id,
  toolName: 'bash',
  text,
  isError,
  timestamp: Date.now(),
});
try {
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 20000 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.evaluate(
    (msgs) => {
      const s = window.__pi_store();
      s.setState({
        session: { ...(s.getState().session ?? {}), cwd: '/Users/user/bobble-testbed/buggyapp' },
      });
      s.setState({ messages: msgs });
    },
    [
      { kind: 'user', id: 'u1', text: 'check the repo', timestamp: Date.now() },
      assistant('a1', [call('c1', 'ls -la')]),
      result(
        'c1',
        'total 8\ndrwxr-xr-x  4 the user staff  128 Sep  7 22:00 .\n-rw-r--r--  1 the user staff 1024 Sep  7 22:00 notes.md',
      ),
      assistant('a2', [call('c2', 'npm test')]),
      result(
        'c2',
        'FAIL src/app.test.ts\n  ● renders › expected 2, got 3\nTests: 1 failed, 4 passed',
        true,
      ),
      assistant('a3', [call('c3', 'mkdir -p out')]),
      result('c3', ''),
      assistant('a4', [call('c4', 'git -c color.ui=always status --short')]),
      result('c4', '\x1b[32mA\x1b[0m  src/new.ts\n \x1b[31mM\x1b[0m src/app.ts'),
      assistant('a5', [call('c5', 'npm run build')]),
    ],
  );
  await page.waitForTimeout(1500);
  const text = await page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows')
        ?.textContent ?? '',
  );
  console.log('xterm text:', JSON.stringify(text.slice(0, 200)));
  const rail = page.locator('[data-testid="canvas-tabs-panel"]');
  await rail.screenshot({ path: `${process.env.SHOT_DIR ?? '/tmp'}/activity-colour.png` });
  console.log('activity-colour-look OK');
} finally {
  await finish();
}
