import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
for (const s of [app.process().stdout, app.process().stderr]) {
  s?.on('data', (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) console.log(`[m] ${l.slice(0, 180)}`);
  });
}
const win = await app.firstWindow();
await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 25000 });
await win.waitForSelector('[data-testid="composer-input"]', { timeout: 25000 });

const send = async (text, label) => {
  const n = await win.evaluate(() => window.__pi_store?.().getState?.().messages?.length ?? 0);
  const t0 = Date.now();
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(text);
  await win.keyboard.press('Enter');
  const landed = await win
    .waitForFunction(
      (k) =>
        (window.__pi_store?.().getState?.().messages ?? []).slice(k).some((m) => m.kind === 'user'),
      n,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  const replied = await win
    .waitForFunction(
      (k) =>
        (window.__pi_store?.().getState?.().messages ?? [])
          .slice(k)
          .some(
            (m) =>
              m.kind === 'assistant' && (m.blocks ?? []).some((b) => (b.text ?? '').length > 0),
          ),
      n,
      { timeout: 150000 },
    )
    .then(() => true)
    .catch(() => false);
  console.log(
    `>>> ${label}: landed=${landed} replied=${replied} in ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  const st = await win.evaluate(() => {
    const s = window.__pi_store?.().getState?.();
    return {
      queued: (s?.queuedSends ?? []).length,
      streaming: (s?.messages ?? []).some((m) => m.isStreaming),
      n: (s?.messages ?? []).length,
    };
  });
  console.log(`>>> ${label} state:`, JSON.stringify(st));
  return replied;
};

await send('Reply with exactly: one', 'FIRST');
await win.waitForTimeout(4000);
console.log('>>> clicking New chat');
await win.click('[data-testid="new-chat"]');
await win
  .waitForFunction(
    () => (window.__pi_store?.().getState?.().messages ?? []).length === 0,
    undefined,
    { timeout: 30000 },
  )
  .catch(() => console.log('>>> messages never hit 0'));
await win.waitForTimeout(2000);
await send('Reply with exactly: two', 'SECOND (after new chat)');
await app.close().catch(() => undefined);
