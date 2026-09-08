/** What does the SHIPPED app see for Screen Recording, and do frames arrive? */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const BUNDLE = '/Applications/Bobble.app';
const HOME = probeHome('grant-probe');
mkdirSync(path.join(HOME, '.cache'), { recursive: true });
const real = path.join(homedir(), '.cache/pi-desktop');
if (existsSync(real)) symlinkSync(real, path.join(HOME, '.cache/pi-desktop'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await electron.launch({
  executablePath: path.join(BUNDLE, 'Contents/MacOS/Bobble'),
  env: { ...process.env, HOME, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_MAC_PRECONSENT: '1' },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-grant-'))}`],
});
try {
  // The MAIN process is the only place systemPreferences lives.
  const status = await app.evaluate(async ({ systemPreferences }) => ({
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  }));
  console.log('main process sees:', JSON.stringify(status));

  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30000,
  });
  const helper = await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'check' }));
  console.log('helper sees:', JSON.stringify(helper.result ?? helper));

  /*
   * DOES CAPTURE ACTUALLY WORK? `getMediaAccessStatus('screen')` is Electron's
   * REPORT, not the answer — ask Chromium for real pixels and look at them. A
   * denied machine returns sources with empty thumbnails; a granted one returns
   * a picture.
   */
  const shot = await app.evaluate(async ({ desktopCapturer }) => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 200 },
    });
    const withPixels = sources.filter((s) => !s.thumbnail.isEmpty());
    const sample = withPixels[0];
    return {
      sources: sources.length,
      nonEmptyThumbnails: withPixels.length,
      sampleName: sample?.name ?? null,
      // A black or uniform image means "allowed to enumerate, not to see".
      sampleBytes: sample ? sample.thumbnail.toPNG().length : 0,
    };
  });
  console.log('desktopCapturer:', JSON.stringify(shot));

  // Drive a real session and see whether pixels come.
  await page.evaluate(() =>
    window.piDesktop.invoke('mac:debug', {
      op: 'launch',
      params: { app: 'Calculator', background: true },
    }),
  );
  await sleep(2500);
  const sub = await page.evaluate(() =>
    window.piDesktop.invoke('mac:monitor:subscribe', { frames: true }),
  );
  await sleep(4000);
  const st = await page.evaluate(() =>
    window.piDesktop.invoke('mac:monitor:subscribe', { frames: true }),
  );
  console.log(
    'monitor:',
    JSON.stringify({
      stream: st?.state?.stream,
      denied: st?.state?.captureDenied,
      err: st?.state?.streamError,
      source: st?.state?.source,
    }),
  );
} finally {
  await app.close().catch(() => {});
}
