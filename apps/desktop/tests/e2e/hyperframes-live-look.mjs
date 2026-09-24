/**
 * A HYPERFRAMES RENDER IS SEEN BEING DRAWN, in the chat's own card.
 *
 * The renderer names every frame on its progress event; the gen manager's
 * video handler used to drop the path, so the card under a running
 * `generate_video` showed the loader and a percentage for the whole render and
 * then jumped to the result. Now the frames go through the same live-preview
 * path a picture's denoise steps take.
 *
 * Real render (the app's own offscreen Chromium, a plain title-card prompt, no
 * model), headless. The running tool call is put in the thread by hand; the
 * job itself goes through `gen:generate`, the same handler the bridge reaches.
 *
 *   SHOT_DIR=/tmp/hf-live node apps/desktop/tests/e2e/hyperframes-live-look.mjs
 */
import path from 'node:path';
import { launchApp } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { page, check, finish, shotDir } = await launchApp('hf-live', {
  env: { PI_DESKTOP_GEN: '1' },
  args: ['--', '--piE2E=1'],
  waitFor: '[data-testid="composer-input"]',
});

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1200);
  const user = { kind: 'user', id: 'u1', text: 'animate a title card', timestamp: 1 };
  await page.evaluate(
    (user) =>
      window.__pi_store().setState({
        session: { cwd: '/w' },
        agent: { isStreaming: true },
        messages: [
          user,
          {
            kind: 'assistant',
            id: 'a1',
            blocks: [
              {
                type: 'toolCall',
                id: 'g1',
                name: 'generate_video',
                arguments: { prompt: 'Bobble makes motion graphics', model: 'hyperframes' },
              },
            ],
            timestamp: 2,
            isStreaming: true,
          },
        ],
        runningToolCalls: ['g1'],
      }),
    user,
  );
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });

  /* Start the render and watch the card while it runs: every distinct frame
     the card shows is one the user saw arrive. */
  const watch = page.evaluate(
    () =>
      new Promise((resolve) => {
        const seen = new Set();
        let loaderFrames = 0;
        const t0 = performance.now();
        const tick = () => {
          const img = document.querySelector(
            '[data-testid="pending-media-card"] [data-testid="pending-preview"]',
          );
          if (img instanceof HTMLImageElement && img.src !== '') seen.add(img.src);
          else loaderFrames += 1;
          if (performance.now() - t0 < 12_000 && !window.__hfLiveDone) requestAnimationFrame(tick);
          else resolve({ distinct: seen.size, loaderFrames });
        };
        requestAnimationFrame(tick);
      }),
  );
  const run = page.evaluate(async () => {
    const res = await window.piDesktop.invoke('gen:generate', {
      kind: 'video',
      model: 'hyperframes',
      prompt: 'Bobble makes motion graphics',
      seconds: 4,
      fps: 12,
      size: '640x352',
    });
    window.__hfLiveDone = true;
    return res;
  });
  // A frame from the middle of the render, for the report.
  await sleep(1400);
  const box = await page.locator('[data-testid="pending-media-card"]').first().boundingBox();
  if (box !== null) {
    await page.screenshot({
      path: path.join(shotDir, 'mid-render.png'),
      clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 },
    });
  }
  const [seen, res] = await Promise.all([watch, run]);
  console.log('render:', JSON.stringify({ outputs: res.outputs?.length, error: res.error }));
  console.log('card:', JSON.stringify(seen));
  check(
    res.error === undefined && (res.outputs?.length ?? 0) === 1,
    'the render produced one animation',
  );
  check(
    seen.distinct >= 5,
    `the card showed the frames as they were drawn (${seen.distinct} distinct frames)`,
  );
} finally {
  await finish();
}
