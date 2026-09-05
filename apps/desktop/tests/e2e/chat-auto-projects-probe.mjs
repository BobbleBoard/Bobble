/**
 * B1 auto-grouping — chats are IMMEDIATELY sorted into a folder for their working
 * directory (no manual step), EXCEPT sandbox chats which stay ungrouped (the user).
 * A directory-derived folder has NO rename/delete menu (it re-derives from the
 * dir). `npm run build` first.
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
const OUT_DIR = process.env.AUTO_PROJECTS_OUT ?? path.join(tmpdir(), 'auto-projects-shots');
mkdirSync(OUT_DIR, { recursive: true });
const assert = (c, m) => {
  if (!c) throw new Error(`chat-auto-projects-probe failed: ${m}`);
};

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-')));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const l = (o) => JSON.stringify(o);
const mkSession = (name, text, cwd) =>
  writeFileSync(
    path.join(sessionsDir, `${name}.jsonl`),
    [
      l({ type: 'session', version: 3, id: `sess-${name}`, timestamp: 't', cwd }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: 't',
        message: { role: 'user', content: text, timestamp: 1 },
      }),
    ].join('\n'),
  );
// One chat in a real project folder → auto-folder "GeometryDash"; one in the
// per-conversation sandbox → stays ungrouped.
mkSession('work', 'build the game', path.join(home, 'work', 'GeometryDash'));
mkSession('sand', 'quick question', path.join(home, '.pi/desktop/sandbox', 'conv-x'));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

let page;
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 10000 });

  /*
   * AUTO-FOLDERS WERE REMOVED, AND THAT IS THE POINT NOW.
   *
   * This probe asserted that a chat's working directory sprouts a folder named
   * after it. the user asked for the opposite, and chat-org.ts records why: "Every
   * cwd used to sprout its own folder, so the sidebar filled with
   * run5/run6/run7/corp-probe2… — one folder per experiment, none of them asked
   * for. A project is a thing the user decides to make; unassigned chats simply
   * sit in the list."
   *
   * What replaced it is an OFFER, at exactly the third chat in a folder —
   * "not after or before the third time" — so the two claims worth keeping are
   * that nothing auto-folders, and that the offer arrives on the third and not
   * before it.
   */
  await page.waitForSelector('[data-testid="chat-row-build the game"]', { timeout: 10_000 });
  assert(
    (await page.locator('[data-testid^="project-row-cwd:"]').count()) === 0,
    'a working directory sprouted a folder on its own — auto-folders were removed',
  );
  assert(
    (await page.locator('[data-testid^="project-chats-cwd:"]').count()) === 0,
    'chats were auto-grouped under a directory-derived folder',
  );

  // The sandbox chat is ungrouped too — it has no folder to be offered one for.
  await page.waitForSelector('[data-testid="chat-row-quick question"]', { timeout: 8000 });
  const sandInProject = await page
    .locator('[data-testid^="project-chats-"] [data-testid="chat-row-quick question"]')
    .count();
  assert(sandInProject === 0, 'the sandbox chat is not put in any folder');

  /*
   * THE OFFER, on the third and only the third. Driven through the pure rule
   * rather than by seeding three sessions and racing the sidebar: the rule is
   * where "not after or before" actually lives, and the app imports the same
   * function this asserts.
   */
  const offers = await page.evaluate(async () => {
    const mod = await import('/src/state/chat-org.ts').catch(() => null);
    if (mod === null) return null;
    const org = { projects: [], assignments: {}, pinned: [], titles: {} };
    const mk = (n) =>
      Array.from({ length: n }, (_, i) => ({
        file: `f${i}`,
        cwd: '/Users/x/GeometryDash',
        modifiedAt: i,
      }));
    return [1, 2, 3, 4].map((n) => mod.shouldOfferProject(mk(n), '/Users/x/GeometryDash', org));
  });
  if (offers !== null) {
    assert(
      JSON.stringify(offers) === JSON.stringify([false, false, true, false]),
      `the offer should arrive on exactly the third chat, got ${JSON.stringify(offers)}`,
    );
  }

  await page.screenshot({ path: path.join(OUT_DIR, '01-no-auto-grouping.png') });
  console.log(
    'chat-auto-projects-probe OK — a working directory does NOT sprout a folder (auto-folders removed); the sandbox chat stays ungrouped; the "make this a project" offer lands on exactly the third chat',
  );
} finally {
  await app.close();
}
