/** Functional TCC + surface probe through a REAL app bundle: snapshot TextEdit
 * and report how much Accessibility and Screen Recording actually returned.
 * Flags can lie about responsibility; elements and pixels cannot. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

const bundle = process.argv[2] ?? '/Applications/Bobble.app';
const app = await electron.launch({
  executablePath: path.join(bundle, 'Contents/MacOS/Bobble'),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_MAC_PRECONSENT: '1' },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-surface-'))}`],
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  const dbg = (op, params) =>
    page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
  console.log('check:', JSON.stringify((await dbg('check')).result));
  const snap = await dbg('snapshot', { app: 'TextEdit', screenshot: true });
  const r = snap.result ?? {};
  console.log(
    'app:',
    r.app,
    '| window:',
    JSON.stringify(r.window),
    '| elements:',
    (r.elements ?? []).length,
  );
  console.log(
    'windows[]:',
    JSON.stringify((r.windows ?? []).map((w) => [w.role, w.title, w.frame?.w, w.frame?.h])),
  );
  const shot = r.screenshot ?? {};
  console.log(
    'screenshot: composite=',
    shot.composite,
    'size=',
    shot.width,
    'x',
    shot.height,
    'b64=',
    (shot.base64 ?? '').length,
  );
  if (shot.base64) {
    writeFileSync(`${REPO_ROOT}/scratchpad/surface-probe.png`, Buffer.from(shot.base64, 'base64'));
    console.log('wrote scratchpad/surface-probe.png');
  }
} finally {
  await app.close();
}
