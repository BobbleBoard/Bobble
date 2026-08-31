/**
 * THE STUDIOS AS A CONTENT ROUTE — the layout the user asked for, asserted.
 *
 * the user: "have them all auto close the left sidebar (with the same animation) and
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

// Where the chat's own two top-bar buttons sit, so the studio's can be compared
// against them rather than against a hard-coded pixel.
const canvasBtn = await rect('[data-testid="canvas-toggle"]');
const gearsBtn = await rect('[data-testid="advanced-params-toggle"]');
const sidebarBefore = await rect('.pd-sidebar-slot');
check(sidebarBefore !== null && sidebarBefore.w > 100, 'the sidebar should start open');

for (const modality of ['image', 'video', 'audio']) {
  /*
   * The sidebar has to be REOPENED to reach the next studio, which is the other
   * half of what the user asked for: "the user can open the sidebar and it shows and
   * slides open on the left of the studios." If this click stops working, the
   * studios have become a room with no way back out except Escape.
   */
  if ((await rect('.pd-sidebar-slot'))?.w === 0) {
    await page.click('[data-testid="expand-sidebar"]');
    await page.waitForTimeout(600);
    const reopened = await rect('.pd-sidebar-slot');
    check(
      reopened !== null && reopened.w > 100,
      `[${modality}] the sidebar would not reopen over a studio`,
    );
    check(
      (await rect('[data-testid="studio-results"]')) !== null,
      `[${modality}] opening the sidebar closed the studio`,
    );
  }
  await page.click(`[data-testid="modality-${modality}"]`);
  await page.waitForSelector(`[data-testid="${modality}-studio"]`, { timeout: 10_000 });
  // Past the sidebar's own slide (--pd-duration-slow, 320ms).
  await page.waitForTimeout(700);

  // --- it replaced the chat, and closed the sidebar on the way in ----------
  const sidebar = await rect('.pd-sidebar-slot');
  check(sidebar?.w === 0, `[${modality}] the sidebar should auto-close, is ${sidebar?.w}px`);
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
    `[${modality}] the gears button is not where the advanced-params button was`,
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
  const composeNarrowed = await rect('.pd-studio-compose');
  check(
    composeNarrowed !== null && compose !== null && composeNarrowed.w < compose.w - 200,
    `[${modality}] the input bar did not narrow with the rail`,
  );
  await shot(`${modality}-rail`);

  // --- the gears open a panel, and it is not the rail ----------------------
  await page.click('[data-testid="studio-advanced-toggle"]');
  await page.waitForSelector('[data-testid="studio-advanced"]', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.click('[data-testid="studio-settings-toggle"]');
  await page.waitForTimeout(400);
}

// --- and the sidebar comes back when you leave ------------------------------
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const sidebarAfter = await rect('.pd-sidebar-slot');
check(
  sidebarAfter !== null && sidebarAfter.w > 100,
  `the sidebar should return on leaving a studio, is ${sidebarAfter?.w}px`,
);
check((await rect('.pd-composer')) !== null, 'the chat composer should be back');
await shot('back-in-chat');

await finish();
