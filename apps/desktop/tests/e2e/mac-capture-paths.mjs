/** Which capture path actually has the Screen Recording grant?
 *
 * The helper is a separately-signed binary, so macOS treats it as its own TCC
 * client — granting the APP does not grant it. Electron's own desktopCapturer
 * runs in the app's process and uses the app's identity. This asks all of them
 * and prints who can see pixels. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const bundle = process.argv[2] ?? '/Applications/Bobble.app';
const app = await electron.launch({
  executablePath: path.join(bundle, 'Contents/MacOS/Bobble'),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_MAC_PRECONSENT: '1' },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-cap-'))}`],
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', { timeout: 30000 });
  const helper = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('helper --check       :', JSON.stringify(helper.result ?? helper));

  const media = await app.evaluate(async ({ systemPreferences }) => ({
    screen: systemPreferences.getMediaAccessStatus('screen'),
  }));
  console.log('app media access     :', JSON.stringify(media));

  const sources = await app.evaluate(async ({ desktopCapturer }) => {
    try {
    const list = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
    return list.slice(0, 40).map((s) => ({
      id: s.id,
      name: s.name,
      empty: s.thumbnail.isEmpty(),
      size: s.thumbnail.getSize(),
    }));
    } catch (err) {
      return [{ id: 'error', name: String(err), empty: true, size: null }];
    }
  });
  const named = sources.filter((s) => s.name && s.name !== '');
  console.log('desktopCapturer      :', sources.length, 'windows,', named.length, 'with real names');
  console.log('  sample             :', JSON.stringify(sources.slice(0, 6)));

  const shot = await app.evaluate(async ({ desktopCapturer }) => {
    try {
    const list = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1200, height: 800 },
    });
    const target = list.find((s) => /textedit/i.test(s.name)) ?? list[0];
    if (target === undefined) return null;
    return { name: target.name, png: target.thumbnail.toPNG().toString('base64') };
    } catch (err) {
      return { name: `error: ${String(err)}`, png: '' };
    }
  });
  if (shot !== null && shot.png.length > 2000) {
    writeFileSync('/Users/user/Desktop/OSS-harness/scratchpad/capture-path-probe.png', Buffer.from(shot.png, 'base64'));
    console.log('wrote scratchpad/capture-path-probe.png from', JSON.stringify(shot.name), `(${shot.png.length} b64 chars)`);
  } else {
    console.log('desktopCapturer produced no usable image');
  }
} finally {
  await app.close().catch(() => {});
}
