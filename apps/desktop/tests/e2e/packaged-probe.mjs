/**
 * Smoke probe for the PACKAGED app (electron-builder output or the copy in
 * /Applications): launches the real binary, verifies the renderer boots,
 * theming attributes apply, and the pre-mount boot event arrives.
 *
 * Usage: node packaged-probe.mjs [path-to-.app]   (defaults to /Applications)
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const appBundle = process.argv[2] ?? '/Applications/Bobble.app';
const executable = path.join(appBundle, 'Contents/MacOS/Bobble');

function assert(condition, message) {
  if (!condition) throw new Error(`packaged-probe failed: ${message}`);
}

assert(existsSync(executable), `no executable at ${executable}`);

// The vendored office editors ride along as resources (electron-builder.yml
// extraResources → <Resources>/genoffice). A ship without them is silent: main
// logs "office seam not built" and every docx/xlsx/pptx/pdf opens as a generic
// file — which is exactly how the gap went unnoticed for weeks. Fail here.
const resources = path.join(appBundle, 'Contents/Resources');
for (const rel of [
  'genoffice/embed/out/index.cjs',
  'genoffice/embed/out/assets/harfbuzz.wasm',
  'genoffice/apps/docs/out/renderer/index.html',
  'genoffice/apps/sheets/out/renderer/index.html',
  'genoffice/apps/slides/out/renderer/index.html',
  'genoffice/apps/pdf/out/renderer/index.html',
  'genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar',
]) {
  assert(existsSync(path.join(resources, rel)), `office editors not bundled: missing ${rel}`);
}

// Isolated user-data-dir: never touch the real single-instance lock, so this
// probe can't be blocked by (or evict) a copy the user has open, and leaves no
// zombie holding the lock.
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-packaged-probe-'));
const app = await electron.launch({
  executablePath: executable,
  // PI_E2E=1 treats onboarding as complete so a fresh profile lands in chat
  // (the theme-chip lives in ChatApp), not the first-run wizard.
  env: { ...process.env, PI_E2E: '1' },
  args: [`--user-data-dir=${userDataDir}`],
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="theme-chip"]', { timeout: 15_000 });

  const flavor = await page.evaluate(() => document.documentElement.dataset.flavor);
  const mode = await page.evaluate(() => document.documentElement.dataset.mode);
  assert(
    flavor === 'claude' || flavor === 'codex' || flavor === 'bobble',
    `unexpected flavor ${flavor}`,
  );
  assert(mode === 'light' || mode === 'dark', `unexpected mode ${mode}`);

  await page.waitForFunction(
    () => document.querySelector('[data-testid="boot-state"]')?.textContent?.includes('received'),
    undefined,
    { timeout: 10_000 },
  );

  // …and the seam actually LOADS from there (a bundle that is present but
  // fails to require would degrade the same silent way).
  const office = await page.evaluate(() => window.piDesktop.invoke('office:available', {}));
  assert(
    office?.available === true,
    `office seam did not load from the bundle: ${JSON.stringify(office)}`,
  );

  console.log(
    `packaged-probe OK — ${appBundle} boots (${flavor}/${mode}, boot event received, office editors bundled)`,
  );
} finally {
  await app.close();
}
