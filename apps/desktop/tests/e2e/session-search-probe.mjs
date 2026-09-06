/**
 * b7: find a chat by something SAID in it.
 *
 * Sidebar search compared against the title — the first user message cut to 80
 * characters — so a phrase from message 40 of a long chat was unfindable, and
 * the chat you remember by its content was the one you could not get back to.
 *
 * Writes a real session JSONL whose title says nothing about the phrase, then
 * drives the sidebar's search box and asserts the row appears with an excerpt.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('session-search-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/tool-use.json');

const fail = (m) => {
  console.error(`session-search-probe FAILED: ${m}`);
  process.exitCode = 1;
};

/* A session whose TITLE is unrelated to the phrase, which is the whole point. */
const PHRASE = 'xylophone calibration ritual';
const dir = path.join(PROBE_HOME, '.pi/agent/sessions', '-tmp-search-probe-');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `search-probe-${Date.now()}.jsonl`);
const lines = [
  JSON.stringify({
    type: 'session',
    id: 'search-probe',
    cwd: '/tmp',
    timestamp: new Date(0).toISOString(),
  }),
  JSON.stringify({
    type: 'message',
    message: { role: 'user', content: 'set up the build please' },
  }),
];
for (let i = 0; i < 40; i++) {
  lines.push(
    JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: `step ${i} of the work` },
    }),
  );
}
lines.push(
  JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: `Finally I ran the ${PHRASE} and it passed.` },
  }),
);
writeFileSync(file, `${lines.join('\n')}\n`);

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pd-search-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.pd-composer-editor', { timeout: 30_000 });

  // Main's own answer first — the contract, before any UI question.
  const found = await page.evaluate(async (q) => {
    const list = await window.piDesktop.invoke('fs:list-sessions', { query: q });
    return (list ?? []).filter((s) => s.match !== undefined).map((s) => s.match.excerpt);
  }, PHRASE);
  if (found.length === 0) fail('main found no session containing the phrase');
  else if (!found[0].includes(PHRASE)) fail(`the excerpt does not contain the phrase: ${found[0]}`);
  else console.log(`[search] OK: main matched with excerpt "${found[0]}"`);

  // A phrase in no session must match nothing — otherwise the filter is inert.
  const none = await page.evaluate(async () => {
    const list = await window.piDesktop.invoke('fs:list-sessions', {
      query: 'zzz-not-in-any-session-zzz',
    });
    return (list ?? []).filter((s) => s.match !== undefined).length;
  });
  if (none !== 0) fail(`a nonsense query matched ${none} sessions`);
  else console.log('[search] OK: a nonsense query matches nothing');

  // And through the UI the user actually uses.
  const search = page.locator('input[placeholder="Search chats"]').first();
  if ((await search.count()) === 0) {
    // Collapsed search — click the magnifier first.
    await page.click('[data-testid="sidebar-search"]').catch(() => {});
  }
  await search.fill(PHRASE).catch(() => fail('could not type into the search box'));
  await page.waitForTimeout(900);
  const excerpts = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-chat-excerpt')].map((n) => n.textContent ?? ''),
  );
  if (excerpts.length === 0) fail('the sidebar showed no excerpt for a content match');
  else console.log(`[search] OK: the sidebar explains the match (${JSON.stringify(excerpts[0])})`);
} finally {
  await app.close();
  rmSync(file, { force: true });
}
if (process.exitCode !== 1) console.log('session-search-probe OK');
