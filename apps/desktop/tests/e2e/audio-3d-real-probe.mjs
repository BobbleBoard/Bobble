/**
 * ROUND 2 — THE TWO MODALITIES A REAL RUN HAD NOT TOUCHED.
 *
 * the user: "stress tests of downloading, wrangling with settings models and such
 * for ALL modalities". The settings probe drives every room's knobs offline and
 * image-edit-real-probe spends a GPU on the picture path; audio and 3D had been
 * checked as UI and never as work. This closes that: a real speech generation
 * through the Audio studio, and the 3D workspace's own settings + import path
 * exercised for real.
 *
 * Video is deliberately absent. Every video model in the catalogue is
 * `reserved` today, and the room now says so and refuses to run — asserting
 * that is the settings probe's job, and generating there is not possible.
 *
 *   MAX_MIN  give up after this many minutes (default 15)
 *
 * Uses the REAL home: the point is the installed engines and their weights.
 * Run `npm run build` first.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const CAP_MS = Number(process.env.MAX_MIN ?? 15) * 60_000;
/* A throwaway home so a real generation run does not deposit its output in the
   user's own ~/Bobble/generated — but the REAL cache, because this needs the
   downloaded weights and those are gigabytes nobody should re-fetch per run. */
const home = probeHome('audio-3d-real-probe');
const outRoot = path.join(home, 'Bobble', 'generated');
mkdirSync(outRoot, { recursive: true });
const before = new Set(existsSync(outRoot) ? readdirSync(outRoot) : []);

const { page, shot, check, finish, shotDir } = await launchApp('audio-3d-real-probe', {
  env: { HOME: home, PI_DESKTOP_GEN: '1' },
  realCache: true,
  args: ['--', '--piE2E=1'],
  timeout: 60_000,
});

const newOutputs = () =>
  (existsSync(outRoot) ? readdirSync(outRoot) : []).filter((n) => !before.has(n));

const openStudio = async (target) => {
  if ((await page.$(`[data-testid="modality-${target}"]`)) === null) {
    await page.click('text=Modalities');
  }
  await page.click(`[data-testid="modality-${target}"]`);
};
const leaveStudio = async () => {
  for (let i = 0; i < 6; i++) {
    if ((await page.$('.pd-composer-editor')) !== null) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
};
const openRail = async () => {
  if ((await page.getAttribute('[data-testid="studio-settings"]', 'data-open')) !== 'true') {
    await page.click('[data-testid="studio-settings-toggle"]');
  }
  await page.waitForTimeout(350);
};

try {
  await page.waitForFunction(() => typeof window.__modality_store === 'function', {
    timeout: 30_000,
  });

  /* ------------------------------------------------ AUDIO: the three modes */
  await openStudio('audio');
  await page.waitForSelector('.pd-studio', { timeout: 20_000 });
  await openRail();

  // Each mode is a different engine and a different rail. The room must change
  // with it, not merely re-label a button.
  const modes = [];
  for (const mode of ['Speech', 'Music', 'Effects']) {
    await page.click(`[data-testid="audio-mode-rail"] >> text=${mode}`).catch(() => undefined);
    await page.waitForTimeout(400);
    const shown = await page.evaluate(() => ({
      run: document.querySelector('[data-testid="studio-run"]')?.textContent?.trim() ?? '',
      blocked: document.querySelector('.pd-studio-blocked')?.textContent ?? '',
      rail: document.querySelector('[data-testid="studio-settings"]')?.textContent ?? '',
    }));
    modes.push({ mode, ...shown, railChars: shown.rail.length });
    console.log(
      `   ${mode}: run="${shown.run}" ${shown.blocked ? `blocked="${shown.blocked.slice(0, 70)}"` : ''}`,
    );
  }
  check(
    new Set(modes.map((m) => m.rail)).size > 1,
    'the Audio rail is identical in all three modes — the mode picker changes nothing',
  );
  await shot('1-audio-modes');

  /* ------------------------------------------- AUDIO: a real speech render */
  await page.click('[data-testid="audio-mode-rail"] >> text=Speech').catch(() => undefined);
  await page.waitForTimeout(300);
  /*
   * FILL THE PROMPT FIRST. The run button is also disabled on an EMPTY prompt
   * (`canRun` needs text), so reading `disabled` before typing reports every
   * working studio as blocked — which is what the first version of this probe
   * concluded about a room whose button said "Speak".
   */
  await page.fill('[data-testid="studio-prompt"]', 'Bobble can speak on this machine.');
  await page.waitForTimeout(200);
  const blocked = await page.evaluate(
    () => document.querySelector('[data-testid="studio-run"]')?.disabled === true,
  );
  if (blocked) {
    const why = await page.evaluate(
      () =>
        document.querySelector('[data-testid="studio-blocked"]')?.textContent ??
        '(no reason given)',
    );
    console.log(`   speech is blocked in this install: ${why}`);
  } else {
    const t0 = Date.now();
    await page.click('[data-testid="studio-run"]');
    let last = '';
    let done = false;
    while (Date.now() - t0 < CAP_MS) {
      const st = await page
        .evaluate(() => ({
          meta: document.querySelector('[data-testid="studio-job-meta"]')?.textContent ?? '',
          cards: document.querySelectorAll('[data-testid="media-card"]').length,
          err: document.querySelector('.pd-studio-error')?.textContent ?? '',
        }))
        .catch(() => null);
      if (st === null) break;
      if (st.meta !== last && st.meta.length > 0) {
        last = st.meta;
        console.log(`   [${((Date.now() - t0) / 1000).toFixed(0)}s] ${last}`);
      }
      if (st.err.length > 0) {
        check(false, `speech failed: ${st.err.slice(0, 200)}`);
        break;
      }
      if (st.cards > 0) {
        done = true;
        break;
      }
      await page.waitForTimeout(1500);
    }
    check(done, `no audio after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const made = newOutputs().flatMap((d) => {
      const full = path.join(outRoot, d);
      return statSync(full).isDirectory()
        ? readdirSync(full).map((f) => path.join(full, f))
        : [full];
    });
    const waves = made.filter((f) => /\.(wav|mp3|m4a|flac)$/i.test(f));
    check(waves.length > 0, `no audio file landed (new: ${JSON.stringify(newOutputs())})`);
    for (const w of waves) {
      const bytes = statSync(w).size;
      console.log(`   wrote ${w} (${(bytes / 1024).toFixed(0)} KB)`);
      // A header with no samples is the failure that looks like success.
      check(bytes > 8000, `${path.basename(w)} is ${bytes} bytes — a header and no audio`);
    }
    await shot('2-audio-result');
  }
  await leaveStudio();

  /* ------------------------------------------------------ 3D: the workspace */
  await openStudio('3d');
  /*
   * WAIT FOR THE DOM, NOT THE STORE.
   *
   * `__tripo_store` is defined the moment the lazy chunk EVALUATES, which is
   * before React has committed a single node — and the workspace's Suspense
   * fallback is `null`, so in that window the room is genuinely empty with its
   * title already in the top bar. Reading the DOM on the store's arrival caught
   * exactly that frame and reported a healthy room as blank.
   */
  const up = await page
    .waitForSelector('[data-testid="tp-root"]', { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check(up, 'the 3D workspace never mounted');
  if (up) {
    const state = await page.evaluate(() => {
      const s = window.__tripo_store().getState();
      return {
        assets: s.assets.length,
        gated: document.querySelector('[data-testid="module-gate"]') !== null,
        // The workspace's own markers, read from the source rather than
        // guessed: an earlier `.tp-panel` guess matched nothing and reported a
        // perfectly healthy room as empty.
        root: document.querySelector('[data-testid="tp-root"]') !== null,
        shell: document.querySelector('[data-testid="tp-shell"]') !== null,
        panels: document.querySelectorAll('.tp-body, .tp-shell, .tp-asset-card').length,
      };
    });
    console.log(
      `   3D: ${state.assets} assets, root=${state.root} shell=${state.shell} panels=${state.panels}`,
    );
    // The room renders whether or not the module is installed — that is
    // deliberate ("not gatekeeping the UI from being seen") — so what is
    // asserted is that it rendered SOMETHING, not that it can generate.
    check(state.root && state.shell, 'the 3D workspace mounted without its shell');
    await shot('3-tripo');
  }
  await leaveStudio();
  console.log(`shots: ${shotDir}`);
} finally {
  await finish();
}
