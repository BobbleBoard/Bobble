/**
 * THE STUDIOS AS A CONTENT ROUTE — the layout the user asked for, asserted.
 *
 * The user: "have them all auto close the left sidebar (with the same animation) and
 * just appear in the chat area as if they are just replacing the current chat…
 * a main input bar at the bottom, a top right sidebar opener (same place and
 * icon as canvas)… and then the two gears, same place and icon as advanced
 * settings."
 *
 * Every claim there is a measurement, and they are the kind that a passing unit
 * test cannot make: whether the sidebar actually collapsed, whether the composer
 * is at the BOTTOM of the surface rather than the top, whether the rail takes
 * width from the results instead of covering them, whether the two top-bar
 * buttons are where the canvas and gears buttons were. Each has been wrong at
 * least once in this rework.
 */
import { launchApp } from './harness.mjs';

const { page, shot, check, finish } = await launchApp('studio-layout-probe');

const rect = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, sel);

/*
 * POWER MODE FIRST, because half the comparison only exists there.
 *
 * `AdvancedParamsButton` returns null unless userMode is 'power', and a fresh
 * profile is 'user' — so on any clean run the chat's gears button was simply
 * absent and this probe compared the studio's gears against `undefined`,
 * failing three times with a message about a position. Found while checking a
 * different change: it had nothing to do with the studios and everything to do
 * with which mode the probe's own profile was in.
 */
await page.evaluate(() => window.__settings_store?.().getState?.().update?.({ userMode: 'power' }));
await page.waitForTimeout(400);

// Where the chat's own two top-bar buttons sit, so the studio's can be compared
// against them rather than against a hard-coded pixel.
const canvasBtn = await rect('[data-testid="canvas-toggle"]');
const gearsBtn = await rect('[data-testid="advanced-params-toggle"]');
check(gearsBtn !== null, 'the chat has no advanced-params button even in power mode');
const sidebarBefore = await rect('.pd-sidebar-slot');
check(sidebarBefore !== null && sidebarBefore.w > 100, 'the sidebar should start open');

for (const modality of ['image', 'video', 'audio']) {
  /*
   * The sidebar stays open now, so reaching the next studio is just a click —
   * which is the point of it staying: no gesture between two studios.
   */
  await page.click(`[data-testid="modality-${modality}"]`);
  await page.waitForSelector(`[data-testid="${modality}-studio"]`, { timeout: 10_000 });
  // Past the sidebar's own slide (--pd-duration-slow, 320ms).
  await page.waitForTimeout(700);

  // --- it replaced the chat, and LEFT THE SIDEBAR ALONE -------------------
  const sidebar = await rect('.pd-sidebar-slot');
  check(
    sidebar !== null && Math.abs(sidebar.w - (sidebarBefore?.w ?? 0)) < 2,
    `[${modality}] entering a studio moved the sidebar (${sidebarBefore?.w} → ${sidebar?.w}) — the user asked for it to stay put`,
  );
  check(
    (await rect('.pd-composer')) === null,
    `[${modality}] the chat composer should be gone — the studio replaces the chat`,
  );
  const title = await page.textContent('[data-testid="studio-title"]');
  check(title?.includes('Studio') === true, `[${modality}] no studio title in the top bar`);

  // --- the input bar is at the BOTTOM -------------------------------------
  const studio = await rect(`[data-testid="${modality}-studio"]`);
  const compose = await rect('.pd-studio-compose');
  const results = await rect('.pd-studio-canvas');
  check(
    compose !== null && studio !== null && compose.y + compose.h >= studio.y + studio.h - 2,
    `[${modality}] the input bar is not docked at the bottom`,
  );
  check(
    results !== null && compose !== null && results.y + results.h <= compose.y + 2,
    `[${modality}] the results overlap the input bar`,
  );
  check(
    results !== null && results.h > (studio?.h ?? 0) * 0.5,
    `[${modality}] the results should get most of the height, got ${results?.h}`,
  );

  // --- the two openers are where the canvas + gears buttons were -----------
  const settingsToggle = await rect('[data-testid="studio-settings-toggle"]');
  const advancedToggle = await rect('[data-testid="studio-advanced-toggle"]');
  check(
    settingsToggle !== null && canvasBtn !== null && Math.abs(settingsToggle.x - canvasBtn.x) < 2,
    `[${modality}] the settings opener is not where the canvas toggle was`,
  );
  check(
    advancedToggle !== null && gearsBtn !== null && Math.abs(advancedToggle.x - gearsBtn.x) < 2,
    `[${modality}] the gears button is not where the advanced-params button was (studio x=${advancedToggle?.x}, chat x=${gearsBtn?.x})`,
  );

  // --- the rail TAKES width, it does not cover ----------------------------
  await page.click('[data-testid="studio-settings-toggle"]');
  await page.waitForTimeout(600);
  const rail = await rect('[data-testid="studio-settings"]');
  const narrowed = await rect('.pd-studio-canvas');
  check(rail !== null && rail.w > 200, `[${modality}] the settings rail did not open`);
  check(
    narrowed !== null && results !== null && narrowed.w < results.w - 200,
    `[${modality}] the rail covered the results instead of narrowing them`,
  );
  check(
    rail !== null && narrowed !== null && rail.x >= narrowed.x + narrowed.w - 2,
    `[${modality}] the rail overlaps the results`,
  );
  /*
   * The composer RE-CENTRES rather than narrowing: it is capped at the room's
   * reading column (860px) and centred in whatever is left, so on a wide window
   * opening a 268px rail moves it left by about half that and changes its width
   * not at all. Asserting the width was asserting the cap.
   */
  const composeMoved = await rect('.pd-studio-compose');
  const centre = (r) => r.x + r.w / 2;
  check(
    composeMoved !== null && compose !== null && centre(compose) - centre(composeMoved) > 80,
    `[${modality}] the input bar did not move with the rail (centre ${compose && Math.round(centre(compose))} → ${composeMoved && Math.round(centre(composeMoved))})`,
  );
  /*
   * THE SELECTED PILL SITS EVENLY IN ITS TRACK.
   *
   * The sliding thumb is positioned from measured boxes, and `getBoundingClientRect`
   * measures the track's BORDER box while `left`/`top` resolve against its PADDING
   * box — so forgetting the border puts the thumb one pixel down and right. MEASURED
   * as 4px of rim on the top and left against 2px on the bottom, which is what the user
   * saw: "ensure the border on the left … is even all around".
   */
  const rim = await page.evaluate(() => {
    const seg = document.querySelector('.pd-seg');
    const thumb = seg?.querySelector('.pd-seg-thumb:not(.pd-seg-thumb--hover)');
    if (seg === null || thumb === null || thumb === undefined) return null;
    const s = seg.getBoundingClientRect();
    const t = thumb.getBoundingClientRect();
    const b = Number.parseFloat(getComputedStyle(seg).borderTopWidth) || 0;
    const round = (n) => Math.round(n * 100) / 100;
    return {
      left: round(t.x - (s.x + b)),
      top: round(t.y - (s.y + b)),
      bottom: round(s.bottom - b - t.bottom),
    };
  });
  if (rim !== null) {
    check(
      Math.abs(rim.top - rim.bottom) < 0.6 && Math.abs(rim.left - rim.top) < 0.6,
      `[${modality}] the selected pill's rim is uneven: ${JSON.stringify(rim)}`,
    );
  }

  await shot(`${modality}-rail`);

  // --- the gears open a panel, and it is not the rail ----------------------
  await page.click('[data-testid="studio-advanced-toggle"]');
  await page.waitForSelector('[data-testid="studio-advanced"]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.click('[data-testid="studio-settings-toggle"]');
  await page.waitForTimeout(400);
}

// --- leaving puts the chat back, sidebar still untouched --------------------
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const sidebarAfter = await rect('.pd-sidebar-slot');
check(
  sidebarAfter !== null && Math.abs(sidebarAfter.w - (sidebarBefore?.w ?? 0)) < 2,
  `leaving a studio moved the sidebar (${sidebarBefore?.w} → ${sidebarAfter?.w})`,
);
check((await rect('.pd-composer')) !== null, 'the chat composer should be back');
await shot('back-in-chat');

await finish();
