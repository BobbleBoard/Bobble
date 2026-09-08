/**
 * Is the DEV Electron binary granted Accessibility + Screen Recording? Grants
 * attribute to the spawning binary, so the only truthful way to ask is through
 * the app's own helper. Prints the status and exits — never prompts, never
 * takes the screen.
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-tcc-udd-'))}`],
  env: { ...process.env, HOME: probeHome('mac-tcc-check'), PI_E2E: '1', PI_MAC_PRECONSENT: '1' },
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30000 });
  const res = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('TCC (dev Electron):', JSON.stringify(res));
} finally {
  await app.close();
}
