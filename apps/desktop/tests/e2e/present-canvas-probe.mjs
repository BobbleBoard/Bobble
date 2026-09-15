/**
 * A PRESENTED PICTURE OPENS AS A PICTURE — in the canvas, not only on the card.
 *
 * MEASURED 2026-09-15 (tool-surface probe, pass 3): `coordinate present
 * cow-on-moon.png` put the card in the thread and a tab in the canvas that
 * said "Failed to load file content" — present-store read the PNG as text and
 * gave the image surface no mediaSrc. Real pi, real model, the tool run through
 * `pi:bash` in a chat folder under ~/Bobble; the check is the <img> in the tab.
 *
 *   SHOT_DIR=/tmp/present-canvas node apps/desktop/tests/e2e/present-canvas-probe.mjs
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const home = probeHome('present-canvas');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({
    userMode: 'power',
    modelSelection: { mode: 'model', modelId: 'qwen3.5-4b-mtp' },
  }),
);
const { page, check, finish, shot } = await launchApp('present-canvas', {
  realCache: true,
  env: { HOME: home, PI_BIN: undefined },
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
  const dir = path.join(home, 'Bobble', 'image-of-a-cow');
  mkdirSync(dir, { recursive: true });
  const png = path.join(dir, 'cow-on-moon.png');
  copyFileSync(
    process.env.PNG ?? path.join(homedir(), 'Bobble/generated/a-blue-mug/cand0_seed602697309.png'),
    png,
  );
  await page.evaluate(
    (d) => window.piDesktop.invoke('pi:prompt', { message: `/harness workspace ${d}` }),
    dir,
  );
  await sleep(2000);
  const out =
    (
      await page.evaluate(
        (c) => window.piDesktop.invoke('pi:bash', { command: c }),
        'coordinate present cow-on-moon.png',
      )
    ).result?.output ?? '';
  console.log('present:', out.split('\n')[0]);
  await sleep(4000);
  const state = await page.evaluate(() => {
    const c = window.__pi_canvas?.();
    const tabs = c?.getState?.().tabs ?? [];
    return {
      tabs: tabs.map((t) => ({
        kind: t.kind,
        title: t.title,
        mediaSrc: t.mediaSrc,
        mediaType: t.mediaType,
      })),
      error: document.querySelector('.pd-media-error')?.textContent ?? null,
      img: [...document.querySelectorAll('.pd-media img')].map((i) => ({
        src: i.getAttribute('src'),
        complete: i.complete,
        w: i.naturalWidth,
      })),
      presented: document.querySelector('[data-testid="presented"]')?.textContent ?? null,
    };
  });
  console.log(JSON.stringify(state, null, 1));
  await shot('present-canvas');
  check(state.error === null, 'the presented image loads in the canvas');
} finally {
  await finish();
}
