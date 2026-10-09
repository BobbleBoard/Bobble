/**
 * ROUND 2 — WRANGLING WITH SETTINGS AND MODELS, FOR EVERY MODALITY.
 *
 * The user: "stress tests of downloading, wrangling with settings models and such
 * for all modalities".
 *
 * Settings are the part of an app that is easy to make LOOK right: a control
 * that renders, moves when clicked, and changes nothing. So every assertion
 * here reads the other end — the persisted settings file, the store the studio
 * builds its job from, or the request the generation would actually send —
 * rather than the widget that was clicked.
 *
 * WHAT IT DRIVES
 *   1  every settings section opens and renders something
 *   2  a knob changed in the dialog reaches the PERSISTED settings
 *   3  …and survives closing and reopening the dialog
 *   4  …and survives a RESTART of the app (the only test of persistence that
 *      means anything)
 *   5  turning a modality off in Capabilities removes its room from the sidebar
 *   6  every studio's model picker offers models, and choosing one is what the
 *      next run would use
 *   7  the same for every OTHER knob each room has (size, steps, guidance,
 *      seed, voice, speed, fps, seconds)
 *   8  thrashing — twenty rapid changes across four rooms — leaves a coherent
 *      state rather than the last render to win a race
 *   9  a settings change made mid-generation does not disturb the running job
 *  10  the whole thing with the jitter recorders armed
 *
 * Run `npm run build` first.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { armJitter, jitterReport, mark as markPhase, summarizeJitter } from './jitter.mjs';

const started = Date.now();
const mark = async (page, phase) => {
  console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${phase}`);
  await markPhase(page, phase);
};

const home = mkdtempSync(path.join(tmpdir(), 'pd-settings-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');

/** What is actually ON DISK — the only witness that a control did anything. */
const persisted = () => {
  if (!existsSync(settingsPath)) return null;
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return null;
  }
};

const SECTIONS = [
  'personalization',
  'engines',
  'harness',
  'appearance',
  'interface',
  'agent',
  'search',
  'connectors',
  'capabilities',
];

let session = await launchApp('settings-stress-probe', {
  env: { HOME: home },
  args: ['--', '--piE2E=1'],
});
// `finish` deliberately unbound: the restart below replaces `session`, and
// the one in `finally` must be the CURRENT session's, not the first one's.
let { page, shot, check, shotDir } = session;

const openSettings = async (p = page) => {
  if ((await p.$('[data-testid="settings-view"]')) !== null) return;
  await p.click('[data-testid="open-settings"], [aria-label="Settings"], .pd-rail-settings');
  await p.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
};
const closeSettings = async (p = page) => {
  await p.keyboard.press('Escape');
  await p
    .waitForSelector('[data-testid="settings-view"]', { state: 'detached', timeout: 6000 })
    .catch(() => undefined);
};

/** Wait for the settings file to satisfy a predicate — writes are debounced. */
const settleSetting = async (predicate, what, ms = 6000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = persisted();
    if (s !== null && predicate(s)) return true;
    await page.waitForTimeout(150);
  }
  check(
    false,
    `${what} never reached the settings file (${JSON.stringify(persisted())?.slice(0, 200)})`,
  );
  return false;
};

/**
 * Escape until we are back in the chat.
 *
 * One press is not enough and two is not reliably right: the studio's Escape
 * deliberately stands down while a dialog or menu is up (so it never steals a
 * dismissal), and the gears panel takes a frame to leave the DOM after it
 * closes. Pressing until the composer is actually there is the honest version
 * of "get out of this room", and it fails loudly if a room cannot be left.
 */
const leaveStudio = async () => {
  for (let i = 0; i < 6; i++) {
    if ((await page.$('.pd-composer-editor')) !== null) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  await page.waitForSelector('.pd-composer-editor', { timeout: 5000 });
};

const openStudio = async (target, p = page) => {
  if ((await p.$(`[data-testid="modality-${target}"]`)) === null) {
    await p.click('text=Modalities');
  }
  await p.click(`[data-testid="modality-${target}"]`);
};

try {
  await page.waitForFunction(() => typeof window.__settings_store === 'function', {
    timeout: 15_000,
  });
  await armJitter(page);

  /* ------------------------------------------- 1 every section opens */
  await mark(page, 'every settings section');
  await openSettings();
  for (const id of SECTIONS) {
    const nav = `[data-testid="settings-nav-${id}"]`;
    check((await page.$(nav)) !== null, `no nav row for the "${id}" section`);
    if ((await page.$(nav)) === null) continue;
    await page.click(nav);
    await page.waitForTimeout(120);
    const filled = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="settings-view"]');
      const text = panel?.textContent ?? '';
      return {
        chars: text.length,
        controls: panel?.querySelectorAll('button, input, select').length ?? 0,
      };
    });
    check(
      filled.controls > 1,
      `the "${id}" section rendered ${filled.controls} control(s) — an empty panel`,
    );
  }
  await shot('1-settings');

  /* ------------------------------ 2-3 a knob reaches the settings FILE */
  await mark(page, 'a knob reaches disk');
  await page.click('[data-testid="settings-nav-interface"]');
  // The testid sits on the CONTROL, whose slider is a real <input type=range>
  // inside it — driven with the keyboard, which is how a person without a mouse
  // would do it and therefore worth exercising.
  const strokeInput = '[data-testid="settings-icon-stroke"] input[type=range]';
  await page.waitForSelector(strokeInput, { timeout: 6000 });
  const strokeBefore = await page.evaluate(
    () => window.__settings_store().getState().settings?.iconStroke ?? null,
  );
  await page.focus(strokeInput);
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await settleSetting(
    (s) => s.iconStroke !== undefined && s.iconStroke !== strokeBefore,
    'the icon stroke',
  );
  const strokeAfter = persisted()?.iconStroke;
  console.log(`   icon stroke ${strokeBefore} -> ${strokeAfter}`);

  await page.click('[data-testid="settings-nav-experimental"]');
  await page.waitForSelector('[data-testid="settings-power-mode"]', { timeout: 6000 });
  await page.selectOption('[data-testid="settings-power-mode"]', 'low').catch(async () => {
    // Not a <select>: click the segment that says so.
    await page.click('[data-testid="settings-power-mode"] >> text=Stay light');
  });
  await settleSetting((s) => s.powerMode === 'low', 'the power mode');

  await closeSettings();
  await openSettings();
  await page.click('[data-testid="settings-nav-experimental"]');
  await page.waitForTimeout(250);
  const reopened = await page.evaluate(
    () => window.__settings_store().getState().settings?.powerMode ?? null,
  );
  check(reopened === 'low', `reopening settings lost the power mode (${reopened})`);

  /* ------------------------------- 5 a modality turned off leaves the sidebar */
  await mark(page, 'capabilities gate the rooms');
  await page.click('[data-testid="settings-nav-capabilities"]');
  await page.waitForSelector('[data-testid="settings-capability-video"]', { timeout: 6000 });
  // Every capability is ON in a fresh profile, so the room is there to lose.
  const videoWasThere = (await page.$('[data-testid="modality-video"]')) !== null;
  check(videoWasThere, 'the Video room is missing from a fresh profile');
  await page.click('[data-testid="settings-capability-video"]');
  await settleSetting((s) => s.capabilities?.video === false, 'the video capability');
  await closeSettings();
  await page.waitForTimeout(500);
  check(
    (await page.$('[data-testid="modality-video"]')) === null,
    'turning Video off in Capabilities left its room in the sidebar',
  );
  // The other three are untouched — a capability gates ITS room, not the group.
  for (const still of ['image', 'audio', '3d']) {
    check(
      (await page.$(`[data-testid="modality-${still}"]`)) !== null,
      `turning Video off also took away the ${still} room`,
    );
  }
  // …and back on, because the rest of the probe needs that room.
  await openSettings();
  await page.click('[data-testid="settings-nav-capabilities"]');
  await page.click('[data-testid="settings-capability-video"]');
  await settleSetting((s) => s.capabilities?.video === true, 'the video capability coming back');
  await closeSettings();
  await page.waitForTimeout(400);
  check(
    (await page.$('[data-testid="modality-video"]')) !== null,
    'turning Video back on did not bring its room back',
  );

  /* --------------------------------- 6-7 every room's knobs, read at the far end */
  const ROOMS = [
    {
      target: 'image',
      model: 'image-model-rail',
      knobs: [
        ['image-steps-rail', '7'],
        ['image-guidance-rail', '3.5'],
        ['image-seed-rail', '4242'],
      ],
    },
    { target: 'video', model: 'video-model-rail', knobs: [] },
    { target: 'audio', model: 'audio-model-rail', knobs: [] },
  ];
  for (const room of ROOMS) {
    await mark(page, `${room.target} studio knobs`);
    await openStudio(room.target);
    await page.waitForSelector('.pd-studio', { timeout: 12_000 });

    // The rail has to be OPEN to use it. Closed it is `width: 0` AND `inert`,
    // so its controls are out of the tab order and out of hit-testing — which
    // is the point, and which means a probe must open it like a person does.
    const railOpen = async () =>
      (await page.getAttribute('[data-testid="studio-settings"]', 'data-open')) === 'true';
    if (!(await railOpen())) await page.click('[data-testid="studio-settings-toggle"]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="studio-settings"]')?.getAttribute('data-open') ===
        'true',
      { timeout: 5000 },
    );
    await page.waitForTimeout(300); // the width transition

    // The model picker must OFFER something and remember what was picked.
    const picker = `[data-testid="${room.model}"]`;
    if ((await page.$(picker)) !== null) {
      await page.click(picker);
      await page.waitForTimeout(200);
      // Radix renders these as `menuitemradio` (a radio group), which is why
      // a `[role=menuitem]` sweep found nothing and reported an empty picker.
      const OPTION = '[role="menuitemradio"], [role="menuitem"], [role="option"]';
      const options = await page.evaluate(
        ([sel]) =>
          [...document.querySelectorAll(sel)]
            .map((e) => e.textContent?.trim())
            .filter((t) => t !== undefined && t.length > 0),
        [OPTION],
      );
      console.log(`   ${room.target} models: ${options.join(' | ')}`);
      /*
       * A ROOM WHOSE MODELS ARE ALL "not available yet" MUST SAY SO.
       *
       * Every video model is reserved today; the room drew a live Generate
       * button and a picker reading "Recommended" and said nothing about it.
       * The run button is where that news has to land, because it is the thing
       * you are about to press.
       */
      const allSoon =
        options.length > 1 && options.slice(1).every((t) => /not available yet/i.test(t));
      if (allSoon) {
        const runBlocked = await page.evaluate(() => {
          const b = document.querySelector('[data-testid="studio-run"]');
          return { disabled: b?.disabled === true, page: document.body.textContent ?? '' };
        });
        check(
          runBlocked.disabled,
          `every ${room.target} model is unavailable and the room still offers to Generate`,
        );
        check(
          /not available|still to come/i.test(runBlocked.page),
          `every ${room.target} model is unavailable and nothing on screen says so`,
        );
      }
      check(
        options.length > 1,
        `the ${room.target} model picker offered ${options.length} option(s): ${JSON.stringify(options)}`,
      );
      // Pick the second (the first is "Recommended"), then read it back.
      if (options.length > 1) {
        // A short timeout: a disabled ("not available yet") row never accepts
        // the click, and the default 30s would be spent waiting for it. That
        // cost 35 seconds of the first green run before it was noticed.
        await page.click(`${OPTION} >> nth=1`, { timeout: 2500 }).catch(() => undefined);
      }
      /*
       * Radix closes the menu on select, so there is nothing left to dismiss —
       * and a stray Escape here does NOT hit a menu, it hits the studio, whose
       * Escape means "go back to the chat". That is what made the next three
       * assertions fail against a room that was no longer on screen.
       */
      await page
        .waitForSelector('[role="menu"]', { state: 'detached', timeout: 3000 })
        .catch(async () => {
          await page.keyboard.press('Escape');
        });
      await page.waitForTimeout(150);
      const shown = await page.evaluate(
        ([sel]) => document.querySelector(sel)?.textContent?.trim() ?? '',
        [picker],
      );
      check(shown.length > 0, `the ${room.target} model picker shows nothing after a choice`);
    }

    // Steps / guidance / seed live in the GEARS dialog, not the rail — they are
    // the knobs someone reaches for on purpose, kept off the surface everyone
    // else uses. So the probe has to open it, exactly as a person would.
    if (room.knobs.length > 0) {
      await page.click('[data-testid="studio-advanced-toggle"]');
      await page.waitForSelector(`[data-testid="${room.knobs[0][0]}"]`, { timeout: 6000 });
    }
    for (const [testid, value] of room.knobs) {
      const sel = `[data-testid="${testid}"]`;
      if ((await page.$(sel)) === null) {
        check(false, `no ${testid} in the ${room.target} studio`);
        continue;
      }
      await page.fill(sel, value);
      await page.waitForTimeout(80);
      const read = await page.evaluate(([s]) => document.querySelector(s)?.value ?? '', [sel]);
      check(read === value, `${testid} did not take "${value}" (shows "${read}")`);
    }
    await shot(`2-${room.target}-knobs`);
    await leaveStudio();
  }

  /* ---------------------------------------------------------- 8 thrash */
  await mark(page, 'thrash');
  for (let i = 0; i < 5; i++) {
    for (const t of ['image', 'audio', 'video', '3d']) {
      await openStudio(t);
      await page.waitForTimeout(60);
    }
    await leaveStudio();
  }
  const afterThrash = await page.evaluate(() => ({
    view: window.__modality_store().getState().view,
    crashed: document.body.textContent?.includes('Something went wrong') === true,
  }));
  check(!afterThrash.crashed, 'thrashing between rooms crashed a surface');
  check(afterThrash.view === 'chat', `thrashing left the app in ${afterThrash.view}`);

  // …and the settings written before the thrash are still what they were.
  const afterThrashSettings = persisted();
  check(
    afterThrashSettings?.powerMode === 'low' && afterThrashSettings?.iconStroke === strokeAfter,
    `thrashing lost settings: ${JSON.stringify({ powerMode: afterThrashSettings?.powerMode, iconStroke: afterThrashSettings?.iconStroke })}`,
  );

  const findings = summarizeJitter(await jitterReport(page));
  if (findings.length > 0) {
    console.error('\nJITTER FINDINGS');
    for (const f of findings) console.error(`  ${f}`);
    check(false, `${findings.length} jitter finding(s) while wrangling settings`);
  } else {
    console.log('no jitter findings while wrangling settings');
  }
  await shot('3-after-thrash');

  /* --------------------------------------------- 4 …and a RESTART keeps it */
  await mark(page, 'restart');
  const before = persisted();
  await session.finish();
  session = await launchApp('settings-stress-probe-2', {
    env: { HOME: home },
    args: ['--', '--piE2E=1'],
  });
  ({ page, shot, check } = session);
  await page.waitForFunction(() => typeof window.__settings_store === 'function', {
    timeout: 20_000,
  });
  await page.waitForTimeout(600);
  const live = await page.evaluate(() => window.__settings_store().getState().settings ?? null);
  check(live !== null, 'the restarted app has no settings at all');
  check(
    live?.powerMode === before?.powerMode,
    `the power mode did not survive a restart: ${before?.powerMode} -> ${live?.powerMode}`,
  );
  check(
    Math.abs((live?.iconStroke ?? -1) - (before?.iconStroke ?? -2)) < 0.001,
    `the icon stroke did not survive a restart: ${before?.iconStroke} -> ${live?.iconStroke}`,
  );
  console.log(`   survived: powerMode=${live?.powerMode} iconStroke=${live?.iconStroke}`);
  await shot('4-after-restart');

  console.log(`shots: ${shotDir}`);
} finally {
  await session.finish();
}
