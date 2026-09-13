/**
 * Deterministic Mac cursor-overlay probe — drives the overlay DIRECTLY (no real
 * app control, no model, no TCC needed) through the PI_E2E-only `mac:debug`
 * channel and verifies, structurally and visually:
 *
 *   - the overlay is NOT an Electron window any more. It is a native NSPanel in
 *     a `pi-mac --overlay` child process, sized to the union of every SCREEN and
 *     never moved — which is what makes it impossible to clip and what lets it
 *     carry NSWindowCollectionBehavior.transient (the flag that keeps it out of
 *     Mission Control, and the whole reason for going native);
 *   - it is click-through, cannot become key or main, and never activates its
 *     app — a phantom, never a perceivable window;
 *   - cursor moves land EXACTLY where they were sent, in screen points, including
 *     well past the controlled window's right edge (the reported cut-off) and
 *     past the screen edge itself;
 *   - the pill reflects each state (Thinking pulse, click press, typing with a
 *     live preview, key-combo label) and flips near a screen corner instead of
 *     being sheared off;
 *   - the phantom rides a controlled-window move by the window's own delta, so it
 *     stays glued to what it is pointing at;
 *   - occlusion both CONCEALS the whole overlay (heavy coverage) and punches
 *     per-window holes in it (the mask), so the cursor never paints on a window
 *     stacked above the app;
 *   - screenshots of every state are saved for human review — rendered by the
 *     panel itself from its own layer tree, which needs no Screen Recording
 *     grant and captures exactly what it draws.
 *
 * SCREEN HYGIENE: every screenshot is taken with the panel HIDDEN (CoreAnimation
 * still runs, so the renders are honest) because the probe backdrop is a
 * full-desktop opaque layer. The panel is only ordered on screen for the short
 * window-server/visibility assertions, where it shows nothing but a small
 * transparent cursor and pill and never takes focus.
 *
 * Run `npm run build` first. Shots default to $TMPDIR/mac-overlay-shots
 * (override with MAC_OVERLAY_OUT).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

/* A throwaway $HOME. The app keeps settings, conversations and generated
   media under it, and `--user-data-dir` isolates none of that (harness.mjs). */
const PROBE_HOME = probeHome('mac-overlay-probe');

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const swiftDir = path.join(repoRoot, 'packages/pi-mac/swift');
const helperBin = path.join(swiftDir, '.build/release/pi-mac');
const OUT_DIR = process.env.MAC_OVERLAY_OUT ?? path.join(tmpdir(), 'mac-overlay-shots');

const fail = (m) => {
  throw new Error(`mac-overlay-probe failed: ${m}`);
};

if (process.platform !== 'darwin') {
  console.log('mac-overlay-probe: SKIP — macOS only');
  process.exit(0);
}
if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  console.error('mac-overlay-probe: app not built — run `npm run build` first');
  process.exit(1);
}
// The overlay IS the Swift helper now, so the probe needs it on disk. Building
// takes ~50s from cold; skipping the build and failing on a missing binary would
// just move that cost onto whoever runs it next.
if (!existsSync(helperBin)) {
  console.log('mac-overlay-probe: building pi-mac (swift build -c release)…');
  execFileSync('swift', ['build', '-c', 'release'], { cwd: swiftDir, stdio: 'inherit' });
}
mkdirSync(OUT_DIR, { recursive: true });

const RECT = { x: 120, y: 120, w: 900, h: 620 };

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  env: { ...process.env, HOME: PROBE_HOME, PI_E2E: '1', PI_BIN: mockPi },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 20000,
  });

  const dbg = (op, params) =>
    page.evaluate((req) => window.piDesktop.invoke('mac:debug', req), { op, params });
  /** The native panel's own account of itself — this replaced reading the old
   * overlay window's DOM, because there is no DOM any more. */
  const native = async () => {
    const res = await dbg('overlay-native-info');
    if (res.ok !== true || res.result == null) fail(`overlay-native-info: ${res.error}`);
    return res.result;
  };
  const shot = async (name, crop) => {
    const res = await dbg('overlay-render', { path: path.join(OUT_DIR, name), ...(crop ?? {}) });
    if (res.ok !== true) fail(`render ${name} failed`);
    return path.join(OUT_DIR, name);
  };
  /** A crop framed around an action point, with the cursor up-left so the pill
   * (which hangs down-right of it) lands inside the frame. */
  const shotAt = (name, x, y, w = 540, h = 250) =>
    shot(name, { x: x - Math.round(w * 0.28), y: y - Math.round(h * 0.32), w, h, scale: 2 });
  /** Pixels in a rendered shot that are NOT the flat probe backdrop — i.e. how
   * much of the phantom actually got painted. Read through nativeImage in main
   * (the same trick mac-live-fixes-probe uses for its pixel diffs). */
  const paintedPixels = (file, hex) =>
    app.evaluate(
      ({ nativeImage }, [p, rgb]) => {
        const b = nativeImage.createFromPath(p).toBitmap(); // BGRA
        let n = 0;
        for (let i = 0; i < b.length; i += 4) {
          if (
            Math.abs(b[i] - rgb[2]) > 6 ||
            Math.abs(b[i + 1] - rgb[1]) > 6 ||
            Math.abs(b[i + 2] - rgb[0]) > 6
          ) {
            n++;
          }
        }
        return n;
      },
      [
        file,
        [
          Number.parseInt(hex.slice(0, 2), 16),
          Number.parseInt(hex.slice(2, 4), 16),
          Number.parseInt(hex.slice(4, 6), 16),
        ],
      ],
    );
  /** Hide first: the backdrop is a full-desktop opaque layer and must never be
   * ordered on screen. Rendering works fine on a hidden panel. */
  /* `over` pins the flat ground to the rect about to be measured. Without it
     the backdrop tracks the phantom, so a region measured anywhere else counts
     bare desktop as painted phantom — which is exactly what made the occluder
     check report 22,400 surviving pixels while the phantom was fully erased. */
  const withBackdrop = async (color, over) => {
    await dbg('overlay-hide-panel');
    await dbg('overlay-backdrop', { color, ...(over ?? {}) });
  };

  // ── bring the overlay up over a fixed rect ────────────────────────────────
  const shown = await dbg('overlay-show', RECT);
  if (shown.ok !== true) fail(`overlay-show: ${shown.error}`);

  // ── the mechanism actually changed ────────────────────────────────────────
  // The old overlay was a BrowserWindow loading overlay.html; Mission Control
  // laid it out as its own tile beside the app it was painted on. If one is
  // still here, nothing below is testing what it claims to test.
  const stray = app.windows().find((w) => w.url().includes('overlay.html'));
  if (stray !== undefined) fail('an overlay.html BrowserWindow is still being created');
  const anyOverlayWindow = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes('overlay')),
  );
  if (anyOverlayWindow) fail('main still owns an overlay BrowserWindow');

  // ── structural panel checks (native truth) ────────────────────────────────
  const info = await native();
  console.log('panel:', JSON.stringify(info));

  // Sized to the SCREENS, not to the tracked window. This is the fix for
  // "the window is sized directly to the app window size and thus causing cut
  // off if the mouse cursor goes even a little bit off the screen to the right".
  const screens = info.screens ?? [];
  if (screens.length === 0) fail('panel reports no screens');
  const union = screens.reduce(
    (u, s) => ({
      x: Math.min(u.x, s.x),
      y: Math.min(u.y, s.y),
      r: Math.max(u.r, s.x + s.w),
      b: Math.max(u.b, s.y + s.h),
    }),
    { x: Infinity, y: Infinity, r: -Infinity, b: -Infinity },
  );
  const f = info.frame;
  if (
    !near(f.x, union.x) ||
    !near(f.y, union.y) ||
    !near(f.w, union.r - union.x) ||
    !near(f.h, union.b - union.y)
  ) {
    fail(`panel frame ${JSON.stringify(f)} is not the union of screens ${JSON.stringify(union)}`);
  }
  if (f.w <= RECT.w || f.h <= RECT.h) {
    fail(`panel ${JSON.stringify(f)} is not bigger than the tracked rect — it can still clip`);
  }

  // Never a perceivable window, never a focus thief.
  if (info.clickThrough !== true) fail('panel is not click-through');
  if (info.canBecomeKey !== false) fail('panel can become key — it must never');
  if (info.canBecomeMain !== false) fail('panel can become main — it must never');
  if (info.isKeyWindow !== false) fail('panel IS the key window');
  if (info.appActive !== false) fail('the overlay process activated itself — focus was stolen');
  if (info.activationPolicy === 'regular') {
    fail(`overlay activation policy is ${info.activationPolicy} — it would take a Dock tile`);
  }
  if (info.frontmostPid === info.pid) fail('the overlay process became frontmost');
  if (info.opaque !== false || info.hasShadow !== false) {
    fail(`panel is not a transparent shadowless surface: ${JSON.stringify(info)}`);
  }
  // NSPanel defaults hidesOnDeactivate to true, and we are never active — left
  // alone it would hide the overlay permanently.
  if (info.hidesOnDeactivate !== false) fail('panel hides on deactivate (it would never show)');
  // One above the pop-up-menu level (101): the cursor must paint over the
  // controlled app's own menus and pop-ups; everything of anyone else's above
  // the app is cut out by the mask instead (see refreshOcclusion).
  if (info.level !== 102) {
    fail(`panel level ${info.level} != popUpMenu + 1 (102)`);
  }
  // THE Mission Control fix. `.transient` is what excludes a window from
  // Mission Control/Exposé, and it is the flag Electron never exposed.
  if (info.behavior?.transient !== true) fail('panel is not .transient — Mission Control shows it');
  if (info.behavior?.managed === true) fail('panel is still a MANAGED window');
  for (const flag of ['canJoinAllSpaces', 'ignoresCycle', 'fullScreenAuxiliary']) {
    if (info.behavior?.[flag] !== true) fail(`panel collection behavior missing .${flag}`);
  }
  // The window server genuinely has it on screen — `isVisible` alone is our own
  // bookkeeping and would still be true under an activation policy that refuses
  // to display windows at all.
  if (info.visible !== true) fail('panel not visible after overlay-show');
  if (info.onScreenPerWindowServer !== true) {
    fail('the window server does not have the panel on screen (activation policy refused it?)');
  }
  console.log('panel checks OK: screen-sized, transient, click-through, non-activating');

  const mainInfo = await dbg('overlay-info');
  if (mainInfo.result?.visible !== true) fail('overlay-info says not visible');
  const ib = mainInfo.result?.bounds;
  if (!ib || ib.x !== RECT.x || ib.y !== RECT.y || ib.w !== RECT.w || ib.h !== RECT.h) {
    fail(`overlay-info bounds ${JSON.stringify(ib)} != tracked rect ${JSON.stringify(RECT)}`);
  }
  // Taking an app SEEDS the phantom on that window's centre. On a screen-sized
  // canvas "nowhere yet" would otherwise draw the first Thinking pill in the
  // desktop's bottom-left corner, nowhere near the app.
  if (!near(info.cursor?.x, RECT.x + RECT.w / 2) || !near(info.cursor?.y, RECT.y + RECT.h / 2)) {
    fail(`taking an app did not seed the phantom on its centre: ${JSON.stringify(info.cursor)}`);
  }

  const screen = screens[0];
  const LIGHT = 'eceef2';

  // ── state: thinking (resting) ─────────────────────────────────────────────
  await withBackdrop(LIGHT);
  await dbg('overlay-cursor', { x: RECT.x + 320, y: RECT.y + 200 });
  await dbg('overlay-status', { status: 'thinking' });
  await sleep(650); // let travel + fade-in settle
  await shotAt('01-thinking-light.png', RECT.x + 320, RECT.y + 200);

  const thinking = await native();
  // Screen points in, screen points out — there is no window-local mapping left
  // to get wrong.
  if (!near(thinking.cursor?.x, RECT.x + 320) || !near(thinking.cursor?.y, RECT.y + 200)) {
    fail(`cursor at ${JSON.stringify(thinking.cursor)} != the point it was sent to`);
  }
  if (thinking.cursorVisible !== true) fail('cursor not fully visible while resting');
  if (thinking.bubble?.visible !== true || thinking.bubble?.text !== 'Thinking') {
    fail(`thinking pill wrong: ${JSON.stringify(thinking.bubble)}`);
  }
  if (thinking.bubble?.dots !== true) fail('thinking dots not animating');
  // The resting pill breathes — the only sign a turn is still in flight while
  // nothing is moving. (Skipped when the user has asked for Reduce Motion.)
  if (thinking.reduceMotion !== true && thinking.bubble?.pulse !== true) {
    fail('the thinking pill is not breathing');
  }

  // ── state: mid-travel (never teleports) ───────────────────────────────────
  const moveP = dbg('overlay-cursor', { x: RECT.x + 700, y: RECT.y + 460 });
  await sleep(120); // capture mid-flight (travel is 300ms)
  await shot('02-moving-midflight.png', {
    x: RECT.x + 240,
    y: RECT.y + 130,
    w: 560,
    h: 400,
    scale: 2,
  });
  const midFlight = await native();
  await moveP;
  // The rendered glyph is somewhere BETWEEN the two points — proof it glides.
  const gx = midFlight.cursorGlyph?.x ?? 0;
  if (!(gx > RECT.x + 300 && gx < RECT.x + 700)) {
    fail(`cursor teleported instead of gliding (glyph x=${gx})`);
  }

  // ── state: clicking (a quick press of the glyph itself) ───────────────────
  /* the user asked for the expanding rings to go and the cursor to do the whole
     gesture, so the thing to assert on is the press, not a ripple count. The
     press is 150ms, so this has to look sooner than the old 430ms did. */
  const clickP = dbg('overlay-click', { x: RECT.x + 450, y: RECT.y + 300 });
  await sleep(340); // 300ms travel inside the op, then catch the 150ms press
  const clicking = await native();
  await shotAt('03-clicking-press.png', RECT.x + 450, RECT.y + 300);
  await clickP;
  if (!(clicking.press >= 1)) fail('no click press animation rendered');
  if (clicking.ripples !== undefined) fail('the ripple ring is back');
  if (clicking.bubble?.text !== 'Clicking') fail(`click pill text: ${clicking.bubble?.text}`);

  // ── state: typing (dots + live preview) ───────────────────────────────────
  await dbg('overlay-typing', { text: 'Hello from Pi — background typing' });
  await sleep(280);
  const typing = await native();
  await shotAt('04-typing.png', RECT.x + 450, RECT.y + 300, 620);
  if (typing.bubble?.text !== 'Typing' || !typing.bubble?.sub?.includes('Hello from Pi')) {
    fail(`typing pill: ${JSON.stringify(typing.bubble)}`);
  }
  if (typing.bubble?.dots !== true) fail('typing dots not shown');

  // ── state: key combo label ────────────────────────────────────────────────
  await dbg('overlay-key', { combo: 'cmd+shift+s' });
  await sleep(220);
  const keyed = await native();
  await shotAt('05-key-combo.png', RECT.x + 450, RECT.y + 300);
  if (keyed.bubble?.text !== 'Pressing ⌘⇧S') fail(`key pill label: ${keyed.bubble?.text}`);

  // ── dark backdrop variant (the glyph must read on dark too) ───────────────
  await withBackdrop('1e2030');
  await dbg('overlay-status', { status: 'thinking' });
  await dbg('overlay-cursor', { x: RECT.x + 520, y: RECT.y + 260 });
  await sleep(500);
  await shotAt('06-thinking-dark.png', RECT.x + 520, RECT.y + 260);
  // Close-ups of the redesigned pointer alone, on both grounds — this is what a
  // human actually judges "smaller, rounder, smoother, no fins" from.
  await shot('10-cursor-zoom-dark.png', {
    x: RECT.x + 514,
    y: RECT.y + 254,
    w: 40,
    h: 40,
    scale: 8,
  });

  // ── PAST the app's own right edge: nothing clips ──────────────────────────
  // The reported failure: "the window is sized directly to the app window size
  // and thus causing cut off if the mouse cursor goes even a little bit off the
  // screen to the right especially". 200pt beyond the tracked window's right
  // edge is far outside the old window+buffer canvas; the glyph must still be
  // whole and exactly where it was sent.
  await withBackdrop(LIGHT);
  await dbg('overlay-status', { status: 'thinking' });
  const farX = RECT.x + RECT.w + 200;
  const farY = RECT.y + RECT.h;
  await dbg('overlay-cursor', { x: farX, y: farY });
  await sleep(450);
  await shotAt('07-cursor-past-app-edge.png', farX, farY, 360, 200);
  await shot('10-cursor-zoom-light.png', { x: farX - 6, y: farY - 6, w: 40, h: 40, scale: 8 });
  const far = await native();
  if (!near(far.cursor?.x, farX) || !near(far.cursor?.y, farY)) {
    fail(`cursor past the app edge landed at ${JSON.stringify(far.cursor)}, not (${farX},${farY})`);
  }
  const g = far.cursorGlyph;
  if (g.x < f.x || g.y < f.y || g.x + g.w > f.x + f.w || g.y + g.h > f.y + f.h) {
    fail(`glyph ${JSON.stringify(g)} clipped by the panel ${JSON.stringify(f)}`);
  }
  console.log('no-clip OK: cursor 200pt past the app edge is placed exactly and drawn whole');

  // A point beyond the SCREEN edge is clamped onto the canvas rather than lost:
  // the phantom parks at the border, it does not disappear. `cursor` still
  // reports the point that was ASKED for; `cursorDrawn` is where the tip
  // actually ended up.
  const wayOut = { x: screen.x + screen.w + 400, y: screen.y + 200 };
  await dbg('overlay-cursor', wayOut);
  await sleep(400);
  const offscreen = await native();
  if (!near(offscreen.cursor?.x, wayOut.x)) fail('the requested point was not recorded verbatim');
  const drawn = offscreen.cursorDrawn;
  if (!near(drawn.x, f.x + f.w, 1) || !near(drawn.y, wayOut.y, 1)) {
    fail(`off-screen cursor was not clamped to the panel edge: ${JSON.stringify(drawn)}`);
  }

  // ── pill flips near the screen corner (never sheared off) ─────────────────
  // The cursor near the right+bottom SCREEN edge would push the pill (default:
  // right of and below the cursor) out of view; it must flip and stay inside.
  await dbg('overlay-cursor', { x: screen.x + screen.w - 40, y: screen.y + screen.h - 30 });
  await dbg('overlay-typing', { text: 'Reticulating the edge-anchored pill preview text' });
  await sleep(400);
  const pill = await native();
  await shot('08-pill-flipped-edge.png', {
    x: screen.x + screen.w - 420,
    y: screen.y + screen.h - 180,
    w: 420,
    h: 180,
    scale: 2,
  });
  if (pill.bubble?.flipX !== true && pill.bubble?.flipY !== true) {
    fail(`pill did not flip near the corner: ${JSON.stringify(pill.bubble)}`);
  }
  const pb = pill.bubble.frame;
  if (
    pb.x < screen.x - 1 ||
    pb.y < screen.y - 1 ||
    pb.x + pb.w > screen.x + screen.w + 1 ||
    pb.y + pb.h > screen.y + screen.h + 1
  ) {
    fail(`pill not clamped inside the screen: ${JSON.stringify(pb)}`);
  }

  // ── live tracking: the phantom rides a window move ────────────────────────
  // The old overlay got this from moving its window; a screen-coordinate canvas
  // shifts the cursor by the window's own delta instead. Drive the REAL tracking
  // loop off a synthetic bounds source (no TCC / real app).
  const A = { x: 300, y: 260, w: 760, h: 520 };
  await dbg('overlay-fake-control', A);
  await dbg('overlay-cursor', { x: A.x + 200, y: A.y + 150 });
  await sleep(420);
  const beforeMove = (await native()).cursor;

  const B = { x: 520, y: 420, w: 760, h: 520 };
  await dbg('overlay-fake-move', B);
  let followed = false;
  let after = null;
  for (let i = 0; i < 60 && !followed; i++) {
    await sleep(25);
    after = (await native()).cursor;
    followed =
      near(after?.x, beforeMove.x + (B.x - A.x), 2) &&
      near(after?.y, beforeMove.y + (B.y - A.y), 2);
  }
  if (!followed) {
    fail(
      `phantom did not ride the window move: ${JSON.stringify(after)} != ` +
        `${JSON.stringify({ x: beforeMove.x + (B.x - A.x), y: beforeMove.y + (B.y - A.y) })}`,
    );
  }
  console.log('live tracking OK: the phantom stayed glued to the moved window');

  // The prompt-retarget path (what the tracker calls on a bounds change) does
  // the same thing synchronously.
  const C = { x: 140, y: 180, w: 900, h: 600 };
  const beforeRetarget = (await native()).cursor;
  await dbg('overlay-retarget', C);
  await sleep(80);
  const retargeted = (await native()).cursor;
  if (
    !near(retargeted.x, beforeRetarget.x + (C.x - B.x), 2) ||
    !near(retargeted.y, beforeRetarget.y + (C.y - B.y), 2)
  ) {
    fail(`retarget did not carry the phantom: ${JSON.stringify(retargeted)}`);
  }
  console.log('prompt retarget OK');

  // ── occluder MASK: per-window holes, not all-or-nothing ───────────────────
  // The helper reports every window stacked above the controlled one; the panel
  // masks those rects out, so the phantom stops painting on a window the user
  // dragged over the app long before coverage trips the whole-overlay hide.
  //
  // This is the NODE-DRIVEN path — the fallback the panel takes when it has no
  // pid or window number to anchor on (a fake app has no z-order). With a pid
  // the panel cuts the mask itself from the live window list; that path is
  // proven against real windows in overlay-parity-probe.mjs.
  await dbg('overlay-fake-control', { ...C, pid: 0 });
  await sleep(200);
  const holes = [
    { x: C.x + 400, y: C.y + 40, w: 220, h: 160 },
    { x: C.x + 40, y: C.y + 380, w: 180, h: 120 },
  ];
  await dbg('overlay-fake-move', { ...C, occluders: holes });
  let masked = false;
  for (let i = 0; i < 40 && !masked; i++) {
    await sleep(25);
    masked = (await native()).maskHoles === holes.length;
  }
  if (!masked) fail('the occluder mask was never applied');
  await dbg('overlay-fake-move', { ...C, occluders: [] });
  let cleared = false;
  for (let i = 0; i < 40 && !cleared; i++) {
    await sleep(25);
    cleared = (await native()).maskHoles === 0;
  }
  if (!cleared) fail('the occluder mask was never cleared');
  console.log('occluder mask OK: per-window holes applied and cleared by the tracker');

  // ── z-order truth: occluded ⇒ hidden, clear ⇒ shown (even while driving) ──
  await dbg('overlay-fake-move', { ...C, occluded: true });
  let concealed = false;
  for (let i = 0; i < 40 && !concealed; i++) {
    await sleep(25);
    const inf = await dbg('overlay-info');
    concealed = inf.result?.occluded === true && (await native()).visible === false;
  }
  if (!concealed) fail('overlay still visible while the fake source reports occluded');

  // Clear again — and explicitly NOT frontmost: occlusion truth must win over
  // the driving/frontmost proxy (the cursor lives on the app whenever it is clear).
  await dbg('overlay-fake-move', { ...C, occluded: false, frontmost: false });
  let revealed = false;
  for (let i = 0; i < 40 && !revealed; i++) {
    await sleep(25);
    revealed = (await native()).visible === true;
  }
  if (!revealed) fail('overlay did not re-show after the occluder cleared');
  console.log('occlusion conceal/reveal OK (z-order truth beats the frontmost proxy)');

  // Still never took focus, after all of that.
  const end = await native();
  if (end.appActive !== false || end.isKeyWindow !== false || end.frontmostPid === end.pid) {
    fail(`overlay ended up with focus: ${JSON.stringify(end)}`);
  }

  // ── the mask actually ERASES the phantom (pixels, not a counter) ──────────
  // Re-target with no pid, which stops the tracking loop (nothing left to poll)
  // so the bounds source can't race the mask back to empty mid-measurement,
  // then push the holes straight at the panel.
  await dbg('overlay-show', C);
  await withBackdrop(LIGHT);
  const hole = holes[0];
  // Straddling the hole's left edge: part of the glyph is over the "window
  // above us" and must be cut away, the rest still drawn. This is the shot that
  // shows what the mask does.
  const straddle = { x: hole.x - 6, y: hole.y + 60 };
  const measure = { x: hole.x - 90, y: hole.y + 20, w: 220, h: 130, scale: 2 };

  /* Pin the ground over the whole area these three shots measure, so what is
     counted is the phantom and never the desktop behind it. */
  await withBackdrop(LIGHT, { x: measure.x - 20, y: measure.y - 20, w: 320, h: 260 });
  await dbg('overlay-occluders', { rects: [] });
  await dbg('overlay-cursor', { x: straddle.x, y: straddle.y, ms: 0 });
  await dbg('overlay-status', { status: 'thinking' });
  await sleep(450);
  const unmaskedShot = await shot('09a-no-mask.png', measure);
  const unmaskedPx = await paintedPixels(unmaskedShot, LIGHT);

  await dbg('overlay-occluders', { rects: holes });
  await sleep(200);
  const maskedShot = await shot('09-occluder-mask.png', measure);
  const maskedPx = await paintedPixels(maskedShot, LIGHT);

  // Fully inside the hole, nothing of the phantom may survive.
  await dbg('overlay-cursor', { x: hole.x + 70, y: hole.y + 70, ms: 0 });
  await sleep(300);
  const buriedShot = await shot('09b-inside-occluder.png', {
    x: hole.x + 20,
    y: hole.y + 20,
    w: 160,
    h: 110,
    scale: 2,
  });
  const buriedPx = await paintedPixels(buriedShot, LIGHT);

  if (unmaskedPx === 0) fail('nothing was painted even without a mask — measurement is broken');
  if (!(maskedPx < unmaskedPx * 0.8)) {
    fail(`the mask did not cut the phantom: ${maskedPx} painted px vs ${unmaskedPx} unmasked`);
  }
  if (buriedPx !== 0) {
    fail(`${buriedPx} px of phantom still painted INSIDE an occluder — it must be erased`);
  }
  console.log(
    `occluder mask erases: ${unmaskedPx}px unmasked → ${maskedPx}px straddling → ${buriedPx}px inside`,
  );
  if ((await native()).maskHoles !== holes.length) fail('mask holes vanished mid-measurement');

  // ── hide puts the phantom away ────────────────────────────────────────────
  await dbg('overlay-hide');
  const hidden = await dbg('overlay-info');
  if (hidden.result?.visible !== false) fail('overlay still visible after overlay-hide');
  if ((await native()).visible !== false) fail('native panel still on screen after overlay-hide');

  console.log(`mac-overlay-probe OK — shots in ${OUT_DIR}`);
} finally {
  await app.close();
}
