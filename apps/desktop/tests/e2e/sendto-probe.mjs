/**
 * SEND TO / EXPORT ARE FUNCTIONAL — the main-side half, without taking the
 * screen: `canvas:send-bytes-to` writes the bytes under ~/Bobble/generated/3d
 * and hands them to `open -a`; an app that is not there is reported by name
 * with the path (nothing launches, nothing is focused). The save panel of
 * Export is native and is not driven here; its handler is the same write.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, check, finish, home } = await launchApp('sendto', { args: ['--', '--piE2E=1'] });
try {
  const base64 = Buffer.from('glTF-not-really').toString('base64');
  const res = await page.evaluate(
    (b64) =>
      window.piDesktop.invoke('canvas:send-bytes-to', {
        base64: b64,
        fileName: 'probe-mug-for-nosuchapp.glb',
        app: 'Bobble Probe NoSuchApp',
      }),
    base64,
  );
  console.log('send-bytes-to:', JSON.stringify(res));
  check(res.ok === false, 'an app that is not installed is refused');
  check(/not installed on this Mac/.test(res.error ?? ''), `…and named (${res.error})`);
  const expected = path.join(home, 'Bobble', 'generated', '3d', 'probe-mug-for-nosuchapp.glb');
  check(res.savedTo === expected, `the file is where the sentence says (${res.savedTo})`);
  check(
    existsSync(expected) && readFileSync(expected, 'utf8') === 'glTF-not-really',
    'the bytes landed',
  );
} finally {
  await finish();
}
