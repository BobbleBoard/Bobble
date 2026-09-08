/** Does the INSTALLED /Applications/Bobble.app hold the two computer-use
 * grants? Asked through the app's own helper, because TCC attributes to the
 * spawning binary and any other way of asking would answer about the wrong
 * identity. Read-only: launches, asks, exits. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const bundle = process.argv[2] ?? '/Applications/Bobble.app';
const app = await electron.launch({
  executablePath: path.join(bundle, 'Contents/MacOS/Bobble'),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_MAC_PRECONSENT: '1' },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-tcc-inst-'))}`],
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 30000 });
  const res = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('INSTALLED Bobble TCC:', JSON.stringify(res));
} finally {
  await app.close();
}
