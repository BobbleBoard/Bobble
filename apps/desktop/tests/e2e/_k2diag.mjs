import { launchApp } from './harness.mjs';

const { app, page, finish } = await launchApp('k2-diag', { realCache: true, timeout: 60_000 });
app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
app.process().stderr?.on('data', (d) => process.stdout.write(`[err ] ${d}`));
console.log(
  'cache dir the app sees:',
  await app.evaluate(() => process.env.PI_DESKTOP_CACHE_DIR ?? '(unset)'),
);
console.log('home the app sees:', await app.evaluate(() => process.env.HOME));
const r = await page.evaluate(async () => {
  await window.piDesktop.invoke('pi:start', {});
  const t0 = Date.now();
  const res = await window.piDesktop.invoke('llm:start-server', { modelId: 'k2-horizon-0.9b' });
  return { res, ms: Date.now() - t0 };
});
console.log('start-server →', JSON.stringify(r));
console.log(
  'status:',
  JSON.stringify(await page.evaluate(() => window.__llm_store().getState().status)),
);
await finish();
