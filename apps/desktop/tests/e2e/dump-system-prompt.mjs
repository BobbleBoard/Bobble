/**
 * The EXACT system prompt a CLI-mode turn runs on, written out verbatim.
 *
 * the user: "why on earth would the system prompt be 24k characters or anything near
 * that??? (in cli mode which we should be running) show me that verbatim in a md
 * file". The harness publishes the frozen prompt on `harness-prefill-system`, so
 * this reads the real thing rather than rebuilding it and hoping they match.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { probeHome } from './harness.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9371;
const OUT = process.argv[2] ?? '/Users/user/Desktop/OSS-harness/scratchpad/system-prompt-cli.md';

const HOME = probeHome('prompt-dump');
mkdirSync(path.join(HOME, '.cache'), { recursive: true });
const real = path.join(homedir(), '.cache/pi-desktop');
if (existsSync(real) && !existsSync(path.join(HOME, '.cache/pi-desktop'))) {
  symlinkSync(real, path.join(HOME, '.cache/pi-desktop'));
}

await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
await sleep(2500);
await run('open', [
  '-g', '--env', `HOME=${HOME}`, '--env', 'PI_E2E=1', '--env', 'PI_E2E_BACKGROUND=1',
  '-a', '/Applications/Bobble.app', '--args', `--remote-debugging-port=${PORT}`,
]);
await sleep(7000);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
try {
  const page = (browser.contexts()[0]?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 30000 });
  await page.evaluate(() =>
    window.piDesktop.invoke('settings:set', { patch: { toolInterface: 'bash-cli' } }),
  );
  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  await sleep(6000);
  // Nudge a turn so the prompt is built and published.
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    const got = await page.evaluate(
      () => window.__pi_store().getState().extensionStatus['harness-prefill-system'],
    );
    if (typeof got === 'string' && got.length > 0) {
      const tools = await page.evaluate(
        () => window.__pi_store().getState().extensionStatus['harness-prefill-tools'],
      );
      const names = (() => {
        try {
          return JSON.parse(tools ?? '[]').map((t) => t.name);
        } catch {
          return [];
        }
      })();
      const body = [
        '# Bobble system prompt — bash-CLI mode, verbatim',
        '',
        `Captured from the live \`harness-prefill-system\` status channel on ${new Date().toISOString()}.`,
        `**${got.length.toLocaleString()} characters** (~${Math.round(got.length / 4).toLocaleString()} tokens).`,
        '',
        `Advertised tools (${names.length}): ${names.join(', ')}`,
        '',
        '---',
        '',
        '```text',
        got,
        '```',
      ].join('\n');
      writeFileSync(OUT, body);
      console.log(`${got.length} chars → ${OUT}`);
      break;
    }
  }
} finally {
  await browser.close().catch(() => {});
  await run('osascript', ['-e', 'tell application "Bobble" to quit']).catch(() => {});
}
