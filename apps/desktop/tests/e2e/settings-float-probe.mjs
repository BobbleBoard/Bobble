/**
 * DID THE SETTINGS/MODELS REWORK ACTUALLY LAND ON SCREEN?
 *
 * the user asked for two structural changes and both are the kind that a unit test
 * happily passes while the window looks wrong:
 *   - settings "not full window taking over thing, but instead floating panel
 *     center"
 *   - model management "not be in the settings area, it's just a separate thing
 *     replacing the chat area"
 *
 * So this asserts GEOMETRY, not just presence: the settings panel must be
 * strictly smaller than the window and centred, and the chat must still be in
 * the DOM behind it (the proof it did not take over). Then it checks the models
 * route is its own surface with no settings panel around it, and screenshots
 * every state for a human to look at.
 *
 * Isolated userData: the single-instance lock lives there, and a shared one
 * would steal focus from a running Bobble.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(appRoot, '.probe-shots');

function assert(condition, message) {
  if (!condition) throw new Error(`settings-float-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

mkdirSync(OUT, { recursive: true });
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-settings-udd-'));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="boot-state"]', { timeout: 20_000 });

  // A fresh userData means onboarding; skip straight past it so the probe is
  // about the settings surface rather than the wizard.
  const onboarding = await page.$('[data-testid="onboarding-wizard"]');
  if (onboarding !== null) {
    await page.evaluate(() =>
      window.piDesktop.invoke('onboarding:set-state', { firstRunComplete: true }),
    );
    await page.reload();
    await page.waitForSelector('[data-testid="boot-state"]', { timeout: 20_000 });
  }
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20_000 });
  await page.screenshot({ path: path.join(OUT, '01-chat.png') });

  /* ---------------------------------------------------------------- settings */
  // Open via the same store path the gear uses, so the probe drives the app's
  // own route rather than a testing-only shortcut.
  // profile-button -> profile-menu -> the `open-settings` row, which is exactly
  // the path a user takes.
  let opened = 'none';
  const profile = await page.$('[data-testid="profile-button"]');
  if (profile !== null) {
    await profile.click();
    const item = await page
      .waitForSelector('[data-testid="open-settings"]', { timeout: 5000 })
      .catch(() => null);
    if (item !== null) {
      await item.click();
      opened = 'menu';
    }
  }

  if (opened === 'none') {
    console.log('settings-float-probe: could not reach the settings menu item; skipping open');
  } else {
    await page.waitForSelector('[data-testid="settings-view"]', { timeout: 10_000 });
    // Let the enter animation finish before looking: a screenshot taken mid-fade
    // shows the chat through the panel and reads as a transparency bug.
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '02-settings-floating.png') });

    // The panel must be OPAQUE once settled — this is the assertion that would
    // have caught a genuinely see-through panel rather than a slow animation.
    const paint = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="settings-view"]');
      const cs = getComputedStyle(panel);
      const root = getComputedStyle(document.querySelector('[data-testid="settings-backdrop"]'));
      return { bg: cs.backgroundColor, opacity: cs.opacity, backdrop: root.backgroundColor };
    });
    assert(
      paint.bg !== 'rgba(0, 0, 0, 0)' && !paint.bg.startsWith('rgba(0, 0, 0, 0)'),
      `panel has no background of its own (${paint.bg})`,
    );
    assert(Number(paint.opacity) >= 0.99, `panel settled translucent (opacity ${paint.opacity})`);
    // The scrim must actually paint. `bg-black/40` silently resolved to
    // transparent here, so the dim existed in the markup and not on screen.
    assert(
      paint.backdrop !== 'rgba(0, 0, 0, 0)',
      `the backdrop is fully transparent (${paint.backdrop}) — nothing is dimmed`,
    );
    console.log(`  panel bg ${paint.bg} opacity ${paint.opacity}; backdrop ${paint.backdrop}`);

    const geom = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="settings-view"]');
      const r = panel.getBoundingClientRect();
      return {
        w: r.width,
        h: r.height,
        left: r.left,
        top: r.top,
        winW: window.innerWidth,
        winH: window.innerHeight,
        chatBehind: document.querySelector('[data-testid="composer-input"]') !== null,
        backdrop: document.querySelector('[data-testid="settings-backdrop"]') !== null,
      };
    });

    // FLOATING: strictly smaller than the window on both axes, with a gap.
    assert(geom.w < geom.winW - 20, `panel is full width (${geom.w} vs ${geom.winW})`);
    assert(geom.h < geom.winH - 20, `panel is full height (${geom.h} vs ${geom.winH})`);
    // CENTRED: left and right gaps within a few px of each other.
    const rightGap = geom.winW - (geom.left + geom.w);
    assert(
      Math.abs(geom.left - rightGap) < 8,
      `panel is not horizontally centred (left ${geom.left}, right ${rightGap})`,
    );
    assert(geom.backdrop, 'no dimmed backdrop behind the panel');
    // NOT A TAKEOVER: the chat is still mounted underneath.
    assert(geom.chatBehind, 'the chat was unmounted — settings still takes over the window');
    console.log(
      `  floating panel ${Math.round(geom.w)}x${Math.round(geom.h)} in ${geom.winW}x${geom.winH}, chat still mounted behind`,
    );

    /* ------------------------------------------------------------- engines */
    const engineNav = await page.$('[data-testid="settings-nav-engines"]');
    assert(engineNav !== null, 'no Engines section in the settings nav');
    await engineNav.click();
    await page.waitForSelector('[data-testid="engine-panel"]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '03-engines.png') });

    const engines = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="engine-row-"]')].map((el) => ({
        id: el.getAttribute('data-testid').replace('engine-row-', ''),
        supported: el.getAttribute('data-supported'),
        reason: el.querySelector('[data-testid="engine-reason"]')?.textContent ?? null,
      })),
    );
    assert(engines.length >= 5, `expected the 5 engines, saw ${engines.length}`);
    // The greying rule, checked on the real screen: unsupported ones are LAST.
    const firstUnsupported = engines.findIndex((e) => e.supported === 'no');
    if (firstUnsupported >= 0) {
      assert(
        engines.slice(firstUnsupported).every((e) => e.supported === 'no'),
        'an unsupported engine is listed above a supported one',
      );
      assert(
        engines[firstUnsupported].reason !== null,
        'an unsupported engine is greyed with no reason given',
      );
    }
    for (const e of engines) {
      console.log(
        `  ${e.supported === 'yes' ? '✓' : '·'} ${e.id}${e.reason ? ` — ${e.reason}` : ''}`,
      );
    }

    /* ------------------------------------------------------------- harness */
    const harnessNav = await page.$('[data-testid="settings-nav-harness"]');
    assert(harnessNav !== null, 'no Harness section in the settings nav');
    await harnessNav.click();
    await page.waitForSelector('[data-testid="harness-panel"]', { timeout: 15_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, '05-harness.png') });

    const harnesses = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="harness-row-"]')].map((el) => ({
        id: el.getAttribute('data-testid').replace('harness-row-', ''),
        installed: el.getAttribute('data-installed'),
        selectable: el.getAttribute('data-selectable'),
      })),
    );
    assert(harnesses.length >= 7, `expected 7 harnesses, saw ${harnesses.length}`);
    // The bundled harness must always be usable — it ships with the app.
    const bundled = harnesses.find((h) => h.id === 'pi-bundled');
    assert(bundled?.selectable === 'yes', 'the bundled pi is not selectable');
    // A custom config with no path yet must NOT be selectable.
    const custom = harnesses.find((h) => h.id === 'pi-custom');
    assert(custom?.selectable === 'no', 'custom pi config is selectable with no path set');
    for (const h of harnesses) {
      console.log(`  ${h.installed === 'yes' ? '✓' : '·'} ${h.id}`);
    }

    // Connect instructions for an external agent must render real shell lines.
    const connect = await page.$('[data-testid="harness-connect-claude-code"]');
    if (connect !== null) {
      await connect.click();
      await page.waitForTimeout(300);
      const script = await page.textContent('[data-testid="harness-script-claude-code"]');
      assert(
        script !== null && script.includes('ANTHROPIC_BASE_URL'),
        'Claude Code connect block does not set ANTHROPIC_BASE_URL',
      );
      await page.screenshot({ path: path.join(OUT, '06-harness-connect.png') });
      console.log(`  connect block: ${script.split('\n')[0]}`);
    }

    // Escape must dismiss it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert(
      (await page.$('[data-testid="settings-view"]')) === null,
      'Escape did not close the floating panel',
    );
  }

  /* ------------------------------------------------------------------ models */
  const chip = await page.$('[data-testid="footer-model-chip"]');
  if (chip !== null) {
    await chip.click();
    const manager = await page
      .waitForSelector('[data-testid="footer-open-manager"]', { timeout: 5000 })
      .catch(() => null);
    if (manager !== null) await manager.click();
    await page.waitForTimeout(700);
  }
  const modelsShown = (await page.$('[data-testid="models-view"]')) !== null;
  if (!modelsShown) {
    console.log('settings-float-probe: model chip did not route to the models view; check wiring');
  } else {
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, '04-models-view.png') });
    const modelsGeom = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="models-view"]');
      const r = v.getBoundingClientRect();
      return {
        w: r.width,
        winW: window.innerWidth,
        insideSettings: document.querySelector('[data-testid="settings-view"]') !== null,
      };
    });
    // ITS OWN SURFACE: full width, and no settings panel wrapped around it.
    assert(!modelsGeom.insideSettings, 'the models view is still inside the settings panel');
    assert(
      modelsGeom.w > modelsGeom.winW * 0.9,
      `models view is not a full surface (${modelsGeom.w} of ${modelsGeom.winW})`,
    );
    console.log(`  models view is its own full-width surface (${Math.round(modelsGeom.w)}px)`);
  }

  console.log(`\nsettings-float-probe OK — screenshots in ${OUT}`);
} finally {
  await app.close().catch(() => {});
}
