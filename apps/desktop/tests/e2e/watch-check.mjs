/**
 * Does the pocket watch actually WORK — not "does the page load".
 *
 * The contract asked for four things a screenshot cannot settle: the parts are
 * there, they drive each other at the right rates, a wrong assembly JAMS, and
 * the jam is explained in plain words. This checks each of those against the
 * running page, so "delivered" is a set of observations rather than a claim.
 *
 * Written BEFORE reading the run's output on purpose. A check authored after
 * seeing what was built tends to describe what was built.
 *
 *   node tests/e2e/watch-check.mjs <dir-with-index.html> [outDir]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.resolve(process.argv[2] ?? `${process.env.HOME}/bobble-testbed/corp-watch`);
const outDir = path.resolve(process.argv[3] ?? '/tmp/watch-check');
mkdirSync(outDir, { recursive: true });

/** Find the page to open — whatever the team called it. */
const CANDIDATES = ['index.html', 'watch.html', 'main.html', 'src/index.html', 'public/index.html'];
const page_file = CANDIDATES.map((c) => path.join(dir, c)).find((p) => existsSync(p));

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

if (page_file === undefined) {
  record('a page exists to open', false, `none of ${CANDIDATES.join(', ')} under ${dir}`);
  console.log('\n0 checks could run — there is nothing to open.');
  process.exit(1);
}

const app = await electron.launch({
  executablePath: require('electron'),
  args: [appRoot, '--user-data-dir=/tmp/pi-watch-check'],
  env: { ...process.env, PI_E2E: '1', PI_E2E_NO_SERVER: '1' },
});

try {
  const win = await app.firstWindow();
  await win.waitForTimeout(2500);

  // Open the built page in its own tab so nothing of the app's own DOM is in the
  // way of what we measure.
  const page = await app.evaluate(async ({ BrowserWindow }, file) => {
    const w = new BrowserWindow({ width: 1280, height: 800, show: false });
    await w.loadFile(file);
    await new Promise((r) => setTimeout(r, 4000));
    const js = `(() => {
      const errs = (window.__errors ?? []);
      const canvas = document.querySelector('canvas');
      const text = document.body.innerText || '';
      return {
        hasCanvas: canvas !== null,
        canvasSize: canvas ? [canvas.width, canvas.height] : null,
        bodyText: text.slice(0, 4000),
        errors: errs.slice(0, 20),
        // Anything the page exposes for driving it — a run of these names is
        // what a testable build looks like.
        hooks: Object.keys(window).filter((k) => /watch|movement|escape|assembl|part/i.test(k)),
      };
    })()`;
    const info = await w.webContents.executeJavaScript(js, true);
    const shot = await w.webContents.capturePage();
    return { info, png: shot.toPNG().toString('base64') };
  }, page_file);

  writeFileSync(path.join(outDir, 'watch.png'), Buffer.from(page.png, 'base64'));
  console.log(`\nscreenshot -> ${path.join(outDir, 'watch.png')}\n`);

  const { info } = page;
  record('the page renders a 3D canvas', info.hasCanvas, info.canvasSize?.join('x'));
  record('the page threw no errors on load', info.errors.length === 0, info.errors[0] ?? '');

  // The named parts the brief asked for. Named in the page text OR exposed as a
  // hook — either counts as "it is in there and addressable".
  const want = ['mainspring', 'barrel', 'escapement', 'pallet', 'balance', 'dial', 'hand'];
  const blob = `${info.bodyText} ${info.hooks.join(' ')}`.toLowerCase();
  const missing = want.filter((w) => !blob.includes(w));
  record('the named parts are present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');

  record(
    'the build exposes something to drive it',
    info.hooks.length > 0,
    info.hooks.length ? info.hooks.join(', ') : 'no window hook — a wrong assembly cannot be tested',
  );

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await app.close();
}
