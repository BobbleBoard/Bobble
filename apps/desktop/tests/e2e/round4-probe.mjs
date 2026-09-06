/**
 * Round-4 app-integration E2E (mock pi, isolated HOME + udd). Verifies the
 * settings-menu relocation + the adversarial-review fixes:
 *   1. the settings menu opens from the BOTTOM-LEFT profile row (open-settings)
 *      and lands on Custom instructions
 *   2. a custom instruction PERSISTS to ~/.pi/desktop/settings.json
 *   3. the Interface icon-stroke slider drives `--pd-icon-stroke` on <html> +
 *      persists `iconStroke`
 *   4. the top bar no longer carries the raw text toggles (img32)
 *   5. the composer KEEPS focus after the first send (remount-focus bug)
 *   6. a tiny window auto-collapses the sidebar
 * Run `pnpm build` first.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round4-probe failed: ${message}`);
}

assert(existsSync(path.join(appRoot, 'dist/index.html')), 'app is not built — run `pnpm build`');

const home = mkdtempSync(path.join(tmpdir(), 'pi-e2e-home-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8'));

async function waitFor(predicate, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (predicate()) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`round4-probe failed: timed out waiting for ${label}`);
}

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, HOME: home, PI_BIN: mockPi, MOCK_PI_FIXTURE: fixture, PI_E2E: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 12000 });

  // ── 4. Top bar cleanup: the raw text toggles are gone (mode + settings moved
  //       into the bottom-left profile dropup, round-12 #4). ────────────────────
  assert(
    (await page.locator('[data-testid="toggle-flavor"]').count()) === 0,
    'top bar still has the "claude"/flavor text toggle (img32)',
  );

  // ── 1. The bottom-left is ONE profile button opening a dropup that holds the
  //       mode quick-toggle and the Settings entry. ────────────────────────────
  const profileBtn = page.locator('[data-testid="profile-button"]');
  assert((await profileBtn.count()) === 1, 'no bottom-left profile button');
  await profileBtn.click();
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  assert(
    (await page.locator('[data-testid="toggle-mode"]').count()) === 1,
    'expected the clean icon mode quick-toggle in the profile dropup',
  );
  const entry = page.locator('[data-testid="open-settings"]');
  assert((await entry.count()) === 1, 'no Settings entry in the profile dropup');
  await entry.click();
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  // It lands on Custom instructions.
  await page.waitForSelector('[data-testid="settings-custom-instructions"]', { timeout: 8000 });

  // ── 2. Custom instructions persist ────────────────────────────────────────────
  const instruction = 'Always answer in haiku.';
  await page.fill('[data-testid="settings-custom-instructions"]', instruction);
  // Navigating away blurs the textarea → the panel saves on blur.
  await page.click('[data-testid="settings-nav-interface"]');
  await waitFor(
    () => readSettings().customInstructions === instruction,
    'customInstructions persisted to settings.json',
  );

  // ── 3. Interface: the icon-stroke slider drives --pd-icon-stroke + persists ───
  await page.waitForSelector('[data-testid="settings-icon-stroke"]', { timeout: 8000 });
  const initialStroke = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--pd-icon-stroke').trim(),
  );
  assert(initialStroke === '1.25', `default icon stroke should be 1.25, got "${initialStroke}"`);
  const slider = page.locator('[data-testid="settings-icon-stroke"] input[type="range"]');
  await slider.focus();
  await slider.press('End'); // range max = 2.5
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--pd-icon-stroke').trim() ===
      '2.5',
    { timeout: 5000 },
  );
  await waitFor(() => readSettings().iconStroke === 2.5, 'iconStroke persisted to settings.json');

  // ── back to chat ──────────────────────────────────────────────────────────────
  await page.click('[data-testid="settings-back"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // ── 5. Composer keeps focus after the first send ──────────────────────────────
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('hello there');
  await page.keyboard.press('Enter');
  // The empty→thread transition remounts the surface; the composer must stay put.
  await page.waitForSelector('text=Hello from mock-pi — streaming works.', { timeout: 10000 });
  /*
   * AND THE PROMPT THAT LANDS ON TOP OF IT MUST HAND THE KEYBOARD BACK.
   *
   * A fresh profile has no model on disk, so the first send parks a pending
   * download and the auto-download Dialog opens over the thread. Taking focus is
   * correct — it's modal. GIVING IT BACK was not happening: Radix returns focus
   * to the trigger, this dialog has none, so dismissing it left `activeElement`
   * on <body> and the next keystroke went nowhere. So the assertion is not "the
   * composer never loses focus", which a modal legitimately breaks; it is "after
   * the send and after whatever interrupted it, you can keep typing".
   */
  const prompt = page.locator('[data-testid="auto-download-prompt"]');
  if ((await prompt.count()) > 0) {
    await page.keyboard.press('Escape');
    await prompt.waitFor({ state: 'detached', timeout: 5000 });
  }
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-testid') === 'composer-input',
    null,
    { timeout: 5000 },
  );

  // ── 6. A narrow window doesn't overflow, and a tiny one collapses the sidebar ──
  const win = await app.browserWindow(page);

  /*
   * FIRST, THE SIZE A USER CAN ACTUALLY REACH.
   *
   * This step used to ask for 520px and assert the sidebar collapsed. It stopped
   * meaning anything the day minWidth went 640 → 760 for the 3D studio's rail +
   * panel + viewport + assets (746px of hard minimums): Electron clamps the
   * request, so the window was 760 wide, the renderer's 720px breakpoint never
   * engaged, and a probe that read "tiny window collapses the sidebar" was
   * measuring a window that was neither tiny nor collapsed. MEASURED at the
   * clamp: 760px window, 272px sidebar, 456px composer, ZERO overflow — the
   * squeeze the auto-collapse was written for cannot happen by dragging any
   * more, so that is what gets asserted here first.
   */
  await win.evaluate((w) => w.setBounds({ width: 760, height: 820 }));
  await page.waitForTimeout(600);
  const atMin = await page.evaluate(() => ({
    open: document.querySelector('.pd-sidebar-slot')?.getAttribute('data-open'),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  assert(atMin.open === 'true', 'the sidebar should still be open at the minimum window width');
  assert(
    atMin.overflow <= 1,
    `the narrowest allowed window should not overflow, got ${atMin.overflow}px`,
  );

  /*
   * THEN THE BREAKPOINT ITSELF, which is not dead code — a display narrower than
   * the minimum still gets a clamped-down window, and that is the case the
   * auto-collapse exists for. Relaxing the minimum is how you stand in for that
   * display without one; it is put back immediately after.
   */
  await win.evaluate((w) => w.setMinimumSize(400, 400));
  await win.evaluate((w) => w.setBounds({ width: 520, height: 820 }));
  await page.waitForFunction(
    () => document.querySelector('.pd-sidebar-slot')?.getAttribute('data-open') === 'false',
    null,
    { timeout: 5000 },
  );
  // Let the collapse transition settle before measuring overflow.
  await page.waitForTimeout(450);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  await win.evaluate((w) => w.setMinimumSize(760, 560));
  assert(overflow <= 1, `tiny window should not overflow horizontally, got ${overflow}px`);

  console.log(
    'round4-probe OK — settings menu from bottom-left, custom instructions + icon-stroke persist, top bar cleaned, composer keeps focus after a modal interrupts it, narrowest window does not overflow and a tiny one collapses the sidebar',
  );
} finally {
  await app.close();
}
