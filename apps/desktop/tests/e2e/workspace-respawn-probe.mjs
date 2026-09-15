/**
 * THE WORKING FOLDER REACHES EVERY EXTENSION, AND SURVIVES A RESPAWN.
 *
 * MEASURED 2026-09-15 (tool-surface probe, pass 3): the guardian shed a picture
 * under memory pressure, the app relaunched the chat model gently and respawned
 * pi, and the model's next `--save_to=cow-moon.png` landed in ~/Bobble while the
 * prompt still named ~/Bobble/image-of-a-cow as the working folder — a fresh pi
 * knew only its spawn cwd. Two seams, both checked here through the real app:
 * `/harness workspace <dir>` publishes the folder on the pi process env (what
 * gen-tools reads for a relative save_to and `svg --out`), and a deliberate
 * restartPi applies the chat's folder again.
 *
 *   SHOT_DIR=/tmp/ws node apps/desktop/tests/e2e/workspace-respawn-probe.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const home = probeHome('ws-env');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: 'qwen3.5-4b-mtp' },
  }),
);
const { page, check, finish } = await launchApp('ws-env', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_DESKTOP_GEN: '1',
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
  timeout: 120_000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await page.waitForFunction(
    () => (window.__pi_store().getState().agent.model?.id ?? '').startsWith('qwen3.5-4b-mtp'),
    undefined,
    { timeout: 300_000 },
  );
  await sleep(5000);
  const bash = async (c) =>
    (await page.evaluate((c) => window.piDesktop.invoke('pi:bash', { command: c }), c)).result
      ?.output ?? '(none)';
  const ws = path.join(home, 'Bobble', 'wsprobe');
  mkdirSync(ws, { recursive: true });
  // As the app does at the first message: resolve + apply through the renderer's own path.
  await page.evaluate(
    (d) => window.piDesktop.invoke('pi:prompt', { message: `/harness workspace ${d}` }),
    ws,
  );
  await sleep(3000);
  const after = await bash('echo "root=$PI_DESKTOP_WORKSPACE_ROOT"');
  console.log('after workspace:', after.trim());
  check(after.includes(`root=${ws}`), 'the pi process env carries the working folder');
  const svg = await bash('svg --prompt="a dot" --out=dot.svg');
  check(
    svg.includes(path.join(ws, 'dot.svg')),
    `svg --out lands in the working folder (${svg.split('\n')[1]})`,
  );
  // The renderer remembers the folder only through its own first-message path:
  // send one, so `currentWorkspace` is what the app decided.
  const n = await page.evaluate(() => window.__pi_store().getState().messages.length);
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('reply with the single word: ready');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (k) => {
      const s = window.__pi_store().getState();
      return (
        s.messages
          .slice(k)
          .some(
            (x) =>
              x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
          ) && s.promptInFlight !== true
      );
    },
    n,
    { timeout: 180_000 },
  );
  await sleep(2000);
  const decided = await bash('echo "root=$PI_DESKTOP_WORKSPACE_ROOT"');
  console.log('after first message:', decided.trim());
  const folder = /root=(\S+)/.exec(decided)?.[1] ?? '';
  check(
    folder.includes('/Bobble/') && !folder.endsWith('/Bobble') && !folder.endsWith('wsprobe'),
    `the first message decided a chat folder (${folder})`,
  );
  const restarted = await page.evaluate(() => window.__pi_restart?.({}) ?? null);
  console.log('restart:', JSON.stringify(restarted));
  await page.waitForFunction(
    () => (window.__pi_store().getState().agent.model?.id ?? '').startsWith('qwen3.5-4b-mtp'),
    undefined,
    { timeout: 120_000 },
  );
  await sleep(4000);
  const again = await bash('echo "root=$PI_DESKTOP_WORKSPACE_ROOT"');
  console.log('after restart:', again.trim());
  check(
    again.includes(`root=${folder}`),
    `after a respawn the same folder is applied again (${again.trim()})`,
  );
} finally {
  await finish();
}
