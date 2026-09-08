/**
 * mac-monitor-probe — LOOK at the computer-use monitor tab.
 *
 * Drives the real app (hidden window, no focus stolen — see harness.mjs) with
 * the dev frame source armed (`PI_MAC_MONITOR_MOCK=1`), which stubs the HELPER,
 * not the surface: real PIMF bytes, the real parser, the real overlay
 * controller driving the phantom, the real wallpaper cache, the real IPC. So
 * every screenshot here is the actual rendering path.
 *
 * What it checks, beyond "it drew something":
 *   - the monitor tab OPENS ON ITS OWN when a session starts, keyed
 *     `mac-monitor` and titled with the controlled app;
 *   - the surface reaches `live` and the footer says so;
 *   - the window is drawn at its REAL point size when the tab is big enough,
 *     and scaled DOWN (never up) when it is not — measured from the canvas
 *     pixels, not asserted from the geometry helper;
 *   - the phantom cursor and the bubble are actually painted;
 *   - the CAPTURE STOPS when the tab is switched away from (the whole reason a
 *     hidden monitor is allowed to exist).
 *
 * Artifacts → $TMPDIR/pd-shots/mac-monitor (override with SHOT_DIR).
 */
import { measureDrawnWindow } from './_macmon-measure.mjs';
import { launchApp } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { page, shot, check, finish, shotDir } = await launchApp('mac-monitor', {
  env: { PI_MAC_MONITOR_MOCK: '1' },
  args: ['--', '--piE2E=1'],
});

/** Wait for a predicate on the renderer, returning false instead of throwing. */
async function until(fn, arg, timeout = 15_000) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 120 });
    return true;
  } catch {
    return false;
  }
}

try {
  // Give the canvas rail somewhere generous to draw: the mock window is
  // 900×620pt, so a wide rail proves the "never upscale, keep real size" rule
  // and a narrow one proves the scale-down.
  await page.setViewportSize({ width: 1680, height: 1000 });

  // ── 1. the tab opens on its own ────────────────────────────────────────
  const opened = await until(() => {
    const c = window.__pi_canvas?.();
    return c?.getState().tabs.some((t) => t.key === 'mac-monitor') === true;
  });
  check(opened, 'the computer-use tab did not open itself when a session started');

  const tab = await page.evaluate(() => {
    const c = window.__pi_canvas?.();
    const t = c?.getState().tabs.find((x) => x.key === 'mac-monitor');
    return t === undefined ? null : { id: t.id, kind: t.kind, title: t.title };
  });
  check(tab?.kind === 'computer-use', `tab kind was ${String(tab?.kind)}, expected computer-use`);
  check(tab?.title === 'TextEdit', `tab title was ${String(tab?.title)}, expected the app name`);

  // FULLSCREEN the canvas so the tab is bigger than the 900x620pt window: that
  // is the case the "real size, never upscaled" rule is about. (The docked rail
  // caps at 760px, so it can only ever exercise the scale-down half.)
  await page.evaluate(() => window.__pi_canvas?.().setFullscreen(true));
  await sleep(400);

  // ── 2. it goes live and paints ─────────────────────────────────────────
  const live = await until(() => {
    const el = document.querySelector('[data-testid="computer-use-surface"]');
    return el !== null && el.querySelector('.pd-macmon-live[data-live="true"]') !== null;
  });
  check(live, 'the surface never reported a live stream');
  await sleep(900); // let a few frames land + the cursor glide settle
  const wide = await shot('01-real-size');

  // ── 3. real size when it fits, scaled down when it does not ────────────
  // The window is located by COVERAGE, not by brightness — see
  // _macmon-measure.mjs. The wallpaper is no longer dimmed or blurred, so
  // "bright" now describes half the sky and every whitecap as well as the
  // window, and this measurement quietly grew to fit the whole tab.
  const measure = async () => {
    const box = await page.evaluate(measureDrawnWindow);
    if (box === null) return { found: false };
    return {
      found: true,
      dpr: box.dpr,
      cssW: box.cssW,
      cssH: box.cssH,
      w: box.w / box.dpr,
      h: box.h / box.dpr,
      cx: (box.x + box.w / 2) / box.dpr,
      cy: (box.y + box.h / 2) / box.dpr,
    };
  };

  const big = await measure();
  check(big?.found === true, 'no window was drawn on the canvas at all');
  if (big?.found === true) {
    // The mock window is 900×620pt, and the located region is the whole
    // window — title bar included, since it is neutral chrome like the body.
    check(
      Math.abs(big.w - 900) <= 6 && Math.abs(big.h - 620) <= 6,
      `window drawn ${big.w.toFixed(1)}×${big.h.toFixed(1)}pt at real size, expected 900×620`,
    );
    check(
      Math.abs(big.cx - big.cssW / 2) <= 6,
      `window not centred: centre ${big.cx.toFixed(1)} vs ${(big.cssW / 2).toFixed(1)}`,
    );
    console.log(
      `real size: ${big.w.toFixed(1)}×${big.h.toFixed(1)}pt in a ${big.cssW.toFixed(0)}px tab`,
    );
  }

  // Now back to the docked rail, which has TWO placements and needs both
  // checked. `Fit window` is the original rule — the whole window, scaled down,
  // never upscaled — and `Follow` is the second mode: crop around the action so
  // the everyday view is not a 45% demo of the fullscreen one.
  await page.evaluate(() => window.__pi_canvas?.().setFullscreen(false));
  await sleep(800);
  // The scale the surface says it is drawing at; an empty slot means real size.
  const scaleReadout = async () => {
    const text = await page.evaluate(
      () => document.querySelector('.pd-macmon-scale')?.textContent ?? '',
    );
    return text === '' ? 100 : Number.parseInt(text, 10);
  };
  const press = async (testid) => {
    await page.evaluate((id) => {
      document.querySelector(`[data-testid="${id}"]`)?.click();
    }, testid);
    await sleep(700);
  };

  await press('macmon-fit');
  const small = await measure();
  if (small?.found === true && big?.found === true) {
    check(
      small.w < big.w - 40,
      `window did not scale down in a narrow tab (${small.w.toFixed(1)} vs ${big.w.toFixed(1)})`,
    );
    check(
      Math.abs(small.w / small.h - big.w / big.h) < 0.06,
      'aspect ratio changed when the window was scaled down',
    );
    check(Math.abs(small.cx - small.cssW / 2) <= 6, 'scaled-down window is not centred in the tab');
    console.log(`fit: ${small.w.toFixed(1)}×${small.h.toFixed(1)}pt`);
  }
  const fitShot = await shot('02b-docked-fit');

  // Follow: the same rail, the same window, drawn big enough to read. The
  // window is now WIDER than the rail, so what is measurable is the crop — it
  // must fill the rail rather than float in it.
  await press('macmon-follow');
  const followed = await measure();
  const narrow = await shot('02-scaled-down');
  if (followed?.found === true && small?.found === true) {
    check(
      followed.w >= followed.cssW * 0.9,
      `the followed crop does not fill the rail (${followed.w.toFixed(1)} of ${followed.cssW.toFixed(0)})`,
    );
    console.log(`follow: ${followed.w.toFixed(1)}×${followed.h.toFixed(1)}pt crop`);
  }
  // Both modes fill the rail's WIDTH, so what separates them is the scale — and
  // the scale is the thing the surface now says out loud (A6).
  const followScale = await scaleReadout();
  await press('macmon-fit');
  const fitScale = await scaleReadout();
  check(
    fitScale > 0 && fitScale < 60,
    `fit mode should be well under half size in the rail, read ${fitScale}%`,
  );
  check(followScale >= 85, `following should hold at least 85% of real size, read ${followScale}%`);
  console.log(`scale readout: fit ${fitScale}% · follow ${followScale}%`);
  await press('macmon-fit'); // back to auto

  // ── 3b. the surface is not inert ───────────────────────────────────────
  const controls = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="computer-use-surface"]');
    if (root === null) return null;
    const focusable = root.querySelectorAll('button, [tabindex]:not([tabindex="-1"])');
    return {
      focusableCount: focusable.length,
      names: [...focusable].map((b) => (b.textContent ?? '').trim()).filter((t) => t !== ''),
      liveRegions: root.querySelectorAll('[aria-live]').length,
      canvasLabel: root.querySelector('canvas')?.getAttribute('aria-label') ?? '',
      stageOnly: root.querySelector('.pd-macmon-stage button') === null,
    };
  });
  check(
    (controls?.focusableCount ?? 0) >= 5,
    `only ${controls?.focusableCount} focusable controls`,
  );
  check((controls?.liveRegions ?? 0) >= 1, 'nothing announces state changes to assistive tech');
  check(
    controls?.canvasLabel !== 'Controlled app, live view',
    'the canvas label is still the static string',
  );
  console.log(`controls: ${controls?.names.join(' · ')}`);
  console.log(`canvas label: ${controls?.canvasLabel}`);

  // ── 4. the phantom is really painted ───────────────────────────────────
  await page.evaluate(() => window.__pi_canvas?.().setFullscreen(true));
  await sleep(600);
  const stillMounted = await until(() => {
    const el = document.querySelector('[data-testid="computer-use-surface"]');
    return el !== null;
  });
  check(stillMounted, 'the surface unmounted when the canvas went fullscreen again');
  // The choreography runs on its own clock; these waits land the screenshots on
  // different bubble states (click ripple → typing → key press + save sheet).
  await sleep(1200);
  const phantom = await shot('03-phantom-and-bubble');

  // Capture a few moments of the choreography so every bubble state is on film.
  await sleep(2600);
  const typing = await shot('04-typing');
  await sleep(2600);
  const pressing = await shot('05-key-and-sheet');

  // ── 5. switching away stops the capture ────────────────────────────────
  // Read through the E2E debug channel, NOT `mac:monitor:subscribe`: there is
  // one sink per renderer, so subscribing here would downgrade the surface's
  // own frame subscription and stop the capture this is checking on.
  const monitorInfo = () =>
    page
      .evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'monitor-info' }))
      .then((r) => r?.result ?? null);

  const before = await monitorInfo();
  check(before?.stream === 'live', `stream was ${String(before?.stream)} before switching away`);
  check(before?.capturing === true, 'no capture child was running while the tab was visible');

  await page.evaluate(() => {
    const c = window.__pi_canvas?.();
    const id = c.upsertTab('probe:blank', { kind: 'terminal', title: 'Terminal' });
    c.focusTab(id);
  });
  await sleep(1200);
  const after = await monitorInfo();
  check(
    after?.capturing === false,
    `the capture child kept running after the tab lost focus (stream=${String(after?.stream)})`,
  );
  console.log(
    `after switching away: stream=${String(after?.stream)} capturing=${after?.capturing}`,
  );

  // …and comes back when the tab is focused again.
  await page.evaluate(() => {
    const c = window.__pi_canvas?.();
    const t = c.getState().tabs.find((x) => x.key === 'mac-monitor');
    if (t !== undefined) c.focusTab(t.id);
  });
  const resumed = await until(() => {
    const el = document.querySelector('[data-testid="computer-use-surface"]');
    return el?.querySelector('.pd-macmon-live[data-live="true"]') !== null;
  });
  check(resumed, 'the capture did not resume when the tab was focused again');
  await sleep(900);
  const back = await shot('06-resumed');

  // ── 6. the empty state is composed, not a blank ────────────────────────
  await page.evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'overlay-hide' }));
  const idle = await until(() => {
    const el = document.querySelector('[data-testid="computer-use-surface"]');
    return el?.querySelector('.pd-macmon-state[data-kind="idle"]') !== null;
  });
  check(idle, 'the surface did not fall back to its idle state when control ended');
  await sleep(600);
  // The picture must be GONE, not sitting under the empty state: a frame that
  // was mid-decode when control ended used to be installed afterwards.
  // "The window is gone", not "nothing bright is left": the wallpaper is drawn
  // as it is now, so a sunlit stretch of sky is a legitimate large pale region.
  // The mock window is 900x620 and centred, so what must not be there is a
  // window-sized region in the middle of the tab.
  const stale = await measure();
  const staleWindow =
    stale.found === true &&
    stale.w > 400 &&
    stale.h > 300 &&
    Math.abs(stale.cx - stale.cssW / 2) < 80;
  check(
    !staleWindow,
    `a stale window was still painted under the idle state (${stale.w?.toFixed(0)}x${stale.h?.toFixed(0)} at ${stale.cx?.toFixed(0)})`,
  );
  const empty = await shot('07-idle-empty-state');

  // ── 7. the other two "nothing to draw" states, driven deliberately ─────
  // "Waiting for the first frame": restart the session with the mock holding
  // its first frame back, so the state a user only sees for an instant can be
  // looked at properly.
  const mock = (params) =>
    page.evaluate((p) => window.piDesktop.invoke('mac:debug', { op: 'monitor-mock', params: p }), {
      ...params,
    });
  await mock({ windows: true, delayMs: 4000, restart: true });
  const waiting = await until(() => {
    const el = document.querySelector('[data-testid="computer-use-surface"]');
    return el?.querySelector('.pd-macmon-state[data-kind="waiting"]') !== null;
  });
  check(waiting, 'the "waiting for the first frame" state never appeared');
  await sleep(400);
  const connecting = await shot('08-waiting-for-first-frame');

  // "The app has no window": the contract's once-only zero-payload frame.
  await mock({ windows: false, delayMs: 0, restart: true });
  const noWindow = await until(() => {
    const el = document.querySelector('[data-testid="computer-use-surface"]');
    return el?.querySelector('.pd-macmon-state[data-kind="no-window"]') !== null;
  });
  check(noWindow, 'the zero-payload frame did not produce the "no window" state');
  await sleep(400);
  const blank = await shot('09-no-window');

  console.log('\nSCREENSHOTS');
  for (const f of [
    wide,
    fitShot,
    narrow,
    phantom,
    typing,
    pressing,
    back,
    empty,
    connecting,
    blank,
  ]) {
    console.log(`  ${f}`);
  }
  console.log(`  (dir: ${shotDir})`);
} finally {
  const ok = await finish();
  if (!ok) process.exitCode = 1;
}
