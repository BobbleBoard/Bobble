/**
 * LOOK at the Activity terminal pressing Enter. the user (2026-09-17): "when the
 * model's command finishes streaming in the terminal move the cursor down a
 * line and stream in the response if it's slow at all as it would appear in a
 * terminal, this immediate moving down a line as if the user pressed enter is
 * purely aesthetic."
 *
 * Plays the states a real turn produces, straight into the store, and reads
 * the xterm back after each: the command still typing (cursor at the end of
 * the prompt line), the command complete and executing (cursor at the start
 * of the NEXT line, nothing printed yet), output arriving in chunks (right
 * under the prompt, no blank line), the result.
 *
 *   SHOT_DIR=/tmp/terminal-enter node apps/desktop/tests/e2e/terminal-enter-look.mjs
 */
import { mkdirSync } from 'node:fs';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/terminal-enter';
mkdirSync(SHOT_DIR, { recursive: true });
const { page, check, finish } = await launchApp('terminal-enter', {
  waitFor: '[data-testid="composer-input"]',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const user = { kind: 'user', id: 'u1', text: 'run the tests', timestamp: Date.now() };
const assistant = (blocks, isStreaming) => ({
  kind: 'assistant',
  id: 'a1',
  blocks,
  timestamp: Date.now(),
  isStreaming,
});
const typing = (argsText) => ({ type: 'toolCall', id: 'c1', name: 'bash', arguments: {}, argsText });
const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm test' } };
const result = (text) => ({
  kind: 'toolResult',
  id: 'tr-c1',
  toolCallId: 'c1',
  toolName: 'bash',
  text,
  isError: false,
  timestamp: Date.now(),
});

/** The xterm as the eye sees it: its rows, and where the cursor sits. */
const read = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-testid="canvas-tabs-panel"] .pd-terminal');
    const rows = [...(root?.querySelectorAll('.xterm-rows > div') ?? [])]
      .map((r) => r.textContent ?? '')
      .map((t) => t.replace(/\s+$/, ''));
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    const cursor = root?.querySelector('.xterm-cursor');
    const row = cursor?.parentElement;
    const cursorRow = row ? [...row.parentElement.children].indexOf(row) : -1;
    const cursorCol = cursor ? [...row.children].indexOf(cursor) : -1;
    return { rows, cursorRow, cursorCol };
  });

const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const shot = async (label) => {
  const rail = page.locator('[data-testid="canvas-tabs-panel"]');
  await rail.screenshot({ path: `${SHOT_DIR}/${label}.png` });
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(2000);
  await set({ session: { cwd: '/Users/user/bobble-testbed/buggyapp' } });

  // 1. The command is still being typed (its arguments stream in).
  await set({
    messages: [user, assistant([typing('{"command": "npm te')], true)],
    runningToolCalls: [],
    toolOutputPartials: {},
    agent: { isStreaming: true },
  });
  await sleep(1200);
  await set({ messages: [user, assistant([typing('{"command": "npm test')], true)] });
  await sleep(600);
  const typingState = await read();
  await shot('1-typing');
  const promptRow = typingState.rows.findIndex((r) => /\$ npm test$/.test(r));
  check(promptRow >= 0, `the prompt line is on screen: ${JSON.stringify(typingState.rows)}`);
  check(
    typingState.cursorRow === promptRow,
    `while typing the cursor sits on the prompt line (row ${typingState.cursorRow} vs ${promptRow})`,
  );

  // 2. The arguments are complete and the tool is executing: Enter.
  await set({ messages: [user, assistant([call], true)], runningToolCalls: ['c1'] });
  await sleep(600);
  const entered = await read();
  await shot('2-entered');
  check(
    entered.cursorRow === promptRow + 1 && entered.cursorCol === 0,
    `executing: the cursor moved to the start of the next line (row ${entered.cursorRow}, col ${entered.cursorCol}; prompt row ${promptRow})`,
  );
  check(
    (entered.rows[promptRow + 1] ?? '') === '',
    `…with nothing printed under the prompt yet: ${JSON.stringify(entered.rows[promptRow + 1])}`,
  );

  // 3. Output arrives in chunks — right under the prompt line.
  await set({ toolOutputPartials: { c1: '> buggyapp@1.0.0 test\n> vitest run\n' } });
  await sleep(500);
  await set({
    toolOutputPartials: { c1: '> buggyapp@1.0.0 test\n> vitest run\n\n ✓ src/app.test.ts (3 tests) 12ms\n' },
  });
  await sleep(600);
  const streaming = await read();
  await shot('3-streaming');
  check(
    /buggyapp@1\.0\.0 test/.test(streaming.rows[promptRow + 1] ?? ''),
    `the first output line is directly under the prompt (no blank line): ${JSON.stringify(streaming.rows.slice(promptRow, promptRow + 3))}`,
  );
  check(
    streaming.cursorRow > promptRow + 1,
    `the cursor follows the output (row ${streaming.cursorRow})`,
  );

  // 4. The result lands: the same lines, settled.
  await set({
    messages: [
      user,
      assistant([call], false),
      result('> buggyapp@1.0.0 test\n> vitest run\n\n ✓ src/app.test.ts (3 tests) 12ms\n\nTests  3 passed (3)'),
    ],
    runningToolCalls: [],
    toolOutputPartials: {},
    agent: { isStreaming: false },
  });
  await sleep(800);
  const done = await read();
  await shot('4-done');
  check(
    /Tests\s+3 passed/.test(done.rows.join('\n')),
    `the result is on screen: ${JSON.stringify(done.rows.slice(-3))}`,
  );
  check(
    done.rows[promptRow + 1]?.startsWith('> buggyapp@1.0.0 test') === true,
    'the settled transcript kept the output right under the prompt',
  );
  console.log(JSON.stringify({ typing: typingState, entered, streaming, done }, null, 1));
} finally {
  await finish();
}
