/** Ask macOS to surface the computer-use permission prompts for the INSTALLED
 * app and register it in System Settings, so granting is one toggle rather
 * than a hunt for the right binary. Grants nothing itself — only macOS and the
 * user can do that. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const bundle = process.argv[2] ?? '/Applications/Bobble.app';
const app = await electron.launch({
  executablePath: path.join(bundle, 'Contents/MacOS/Bobble'),
  env: { ...process.env, PI_E2E: '1', PI_MAC_PRECONSENT: '1' },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-grants-'))}`],
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  const before = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('before:', JSON.stringify(before.result ?? before));
  const prompted = await page.evaluate(() =>
    window.piDesktop.invoke('mac:debug', { op: 'promptGrants' }),
  );
  console.log('prompted:', JSON.stringify(prompted.result ?? prompted));
  const after = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('after:', JSON.stringify(after.result ?? after));
} finally {
  await app.close();
}
