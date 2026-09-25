/**
 * ⌘Z ON A CHAT'S FIRST MESSAGE LEAVES NO CHAT BEHIND.
 *
 * pi writes the branch of a first message as a new session with no link back
 * to the old one, so the sidebar's one-row-per-chain rule cannot fold them:
 * SEEN before the fix — after the unsend the sidebar listed "New chat" AND a
 * chat holding only the taken-back message, and that second chat outlived the
 * next message too. The unsend now retires the old file through the app's own
 * delete path, when the message was the chat's only one.
 *
 * Real pi and a real model (the branch and the files are pi's), throwaway HOME,
 * real library + cache, hidden window, focus guard — so the HEAVY lock:
 *
 *   MODEL=qwen3.5-4b-mtp OUT=/tmp/unsend-first \
 *     node scripts/with-lock.mjs heavy -- node apps/desktop/tests/e2e/unsend-first-message-probe.mjs
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import { focusComplaint, frontmostApp, probeHome } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'unsend-first');
mkdirSync(OUT, { recursive: true });
const home = probeHome('unsend-first');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }),
);
const userData = mkdtempSync(path.join(tmpdir(), 'unsend-first-udd-'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const failures = [];
const check = (ok, msg) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

/** Every session file under the throwaway home, with the user messages in it. */
const onDisk = () => {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.jsonl')) {
        const users = readFileSync(p, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l))
          .filter((e) => e.type === 'message' && e.message?.role === 'user')
          .map((e) => JSON.stringify(e.message.content));
        out.push({ file: name, users });
      }
    }
  };
  try {
    walk(path.join(home, '.pi', 'agent', 'sessions'));
  } catch {
    /* no sessions yet */
  }
  return out;
};

const before = frontmostApp();
const app = await _electron.launch({
  args: [APP_ROOT, `--user-data-dir=${userData}`],
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR:
      process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble'),
    PI_DESKTOP_MODELS_DIR:
      process.env.PI_DESKTOP_MODELS_DIR ?? path.join(homedir(), 'Bobble', 'Models'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60_000 });
  await win.evaluate(async (m) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId: m });
  }, MODEL);
  await win.waitForFunction(
    (m) => {
      const s = window.__llm_store?.().getState().status;
      return s?.model?.id === m && s.phase === 'ready' && s.serverRunning === true;
    },
    MODEL,
    { timeout: 600_000 },
  );
  await win.waitForTimeout(6000);
  const rows = () =>
    win.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="chat-row-"]')].map((r) =>
        (r.getAttribute('data-testid') ?? '').replace(/^chat-row-/, ''),
      ),
    );

  const FIRST = 'Name three countries, one word each.';
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(FIRST);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
  await win.keyboard.press('Meta+z');
  await win.waitForTimeout(6000);
  const afterZ = {
    rows: await rows(),
    disk: onDisk(),
    composer: await win.evaluate(
      () => document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
    ),
  };
  log('after ⌘Z on the first message:', JSON.stringify(afterZ));
  await win.screenshot({ path: path.join(OUT, 'a-first-message-unsent.png') });
  check(afterZ.composer === FIRST, 'the message is back in the box');
  check(
    !afterZ.rows.some((r) => r.startsWith('Name three countries')),
    'no chat row for the taken-back message',
  );
  check(
    afterZ.disk.every((s) => !s.users.some((u) => u.includes('three countries'))),
    'no session file on disk still holds it',
  );

  await win.click('[data-testid="composer-input"]');
  await win.keyboard.press('Meta+a');
  await win.keyboard.press('Backspace');
  await win.keyboard.type('Name three rivers, one word each.');
  await win.keyboard.press('Enter');
  await win.waitForFunction(
    () => {
      const s = window.__pi_store().getState();
      return !s.agent.isStreaming && !s.promptInFlight;
    },
    undefined,
    { timeout: 180_000 },
  );
  await win.waitForTimeout(6000);
  const afterNext = { rows: await rows(), disk: onDisk() };
  log('after the next message:', JSON.stringify(afterNext));
  await win.screenshot({ path: path.join(OUT, 'b-next-message.png') });
  check(afterNext.rows.length === 1, `ONE chat in the sidebar (${JSON.stringify(afterNext.rows)})`);
  check(afterNext.disk.length === 1, `one session file on disk (${afterNext.disk.length})`);
} finally {
  const during = frontmostApp();
  await app.close().catch(() => undefined);
  const complaint = focusComplaint(before, during);
  if (complaint !== null) check(false, complaint);
  if (process.env.PI_E2E_KEEP_HOME !== '1') {
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`unsend-first-message: ${failures.length} failure(s)`);
    process.exitCode = 1;
  } else console.log('unsend-first-message OK');
}
