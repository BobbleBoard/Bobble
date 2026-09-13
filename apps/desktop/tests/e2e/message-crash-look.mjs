/**
 * ONE REPLY FAILS TO DRAW; THE THREAD STAYS.
 *
 * The other half of the renderer-crash containment: a message the thread cannot
 * render (a malformed block from a stream, a corrupted session line) costs one
 * row — a short note with the reply's text — never the window.
 *
 *   node tests/e2e/message-crash-look.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('message-crash-look');
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message ?? e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30000 });
await page.waitForTimeout(500);

const result = await page.evaluate(() => {
  const store = window.__pi_store();
  const now = Date.now();
  const push = (msg) => store.setState((s) => ({ messages: [...s.messages, msg] }));
  push({ kind: 'user', id: 'u1', text: 'Summarise the plan.', timestamp: now });
  push({
    kind: 'assistant',
    id: 'a1',
    blocks: [{ type: 'text', text: 'The plan has three parts, and this reply draws fine.' }],
    timestamp: now + 1,
    isStreaming: false,
  });
  push({ kind: 'user', id: 'u2', text: 'And the second part?', timestamp: now + 2 });
  // The malformed one: a tool call whose arguments are not an object, and a
  // text block whose text is not a string — the shapes a bad stream line takes.
  push({
    kind: 'assistant',
    id: 'a2',
    blocks: [
      { type: 'text', text: 'Here is the second part, before the broken block.' },
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: 'not an object' },
      { type: 'text', text: { nested: true } },
    ],
    timestamp: now + 3,
    isStreaming: false,
  });
  push({ kind: 'user', id: 'u3', text: 'Thanks.', timestamp: now + 4 });
  push({
    kind: 'assistant',
    id: 'a3',
    blocks: [{ type: 'text', text: 'And this reply, after it, draws fine too.' }],
    timestamp: now + 5,
    isStreaming: false,
  });
  return store.getState().messages.length;
});
await page.waitForTimeout(1200);
const state = await page.evaluate(() => ({
  appBoundary: document.body.innerText.includes('rendering error'),
  composer: document.querySelector('.pd-composer-editor') !== null,
  crashCards: document.querySelectorAll('[data-testid="message-crash"]').length,
  before: document.body.innerText.includes('draws fine.'),
  after: document.body.innerText.includes('draws fine too.'),
  fallback: document.body.innerText.includes('before the broken block'),
}));
check(result === 6, `expected 6 messages, got ${result}`);
check(!state.appBoundary, 'the APP boundary took the window');
check(state.composer, 'the composer is gone');
check(state.before && state.after, 'the healthy replies around the broken one did not draw');
if (state.crashCards === 0) {
  // The thread tolerated the malformed blocks on its own — no containment was
  // needed for THESE shapes; still no window loss, which is the contract.
  console.log('note: the thread rendered the malformed blocks without throwing');
} else {
  check(state.fallback, 'the crash card should carry the reply text');
}
await shot('thread-with-broken-reply');
console.log(
  JSON.stringify({
    ...state,
    errors: errors.length,
    messageLogs: errors.filter((e) => e.includes('Bobble message error')).length,
  }),
);
await finish();
