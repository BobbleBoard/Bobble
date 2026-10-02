/**
 * FETCH CATALOG MODELS THROUGH THE APP'S OWN DOWNLOADER — headless, into the
 * real library (~/Bobble/Models), the way the Models page's Download does it.
 *
 *   MODELS=gemma-4-12b-it:Q4_K_M,qwen3.8-27b-mtp:UD-Q3_K_XL \
 *     node apps/desktop/tests/e2e/fetch-models-probe.mjs
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const WANT = (process.env.MODELS ?? '').split(',').filter(Boolean);
const home = probeHome('fetch-models');
const { page, finish } = await launchApp('fetch-models', {
  realCache: true,
  env: { HOME: home, PI_BIN: undefined, HF_HOME: path.join(homedir(), '.cache', 'huggingface') },
  timeout: 120_000,
});
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
try {
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60_000,
  });
  await page.evaluate(() => {
    window.__dl = [];
    window.piDesktop.on?.('llm:download-progress', (p) => window.__dl.push(p));
  });
  for (const w of WANT) {
    const [modelId, quant] = w.split(':');
    log(`downloading ${modelId} ${quant ?? ''}…`);
    const t0 = Date.now();
    const timer = setInterval(async () => {
      const last = await page
        .evaluate(() => window.__dl?.[window.__dl.length - 1])
        .catch(() => null);
      if (last) log('  progress', JSON.stringify(last).slice(0, 200));
    }, 30_000);
    const r = await page.evaluate(
      ({ modelId, quant }) => window.piDesktop.invoke('llm:download-model', { modelId, quant }),
      { modelId, quant },
    );
    clearInterval(timer);
    log(`${modelId}: ${JSON.stringify(r)} in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
} finally {
  await finish();
}
