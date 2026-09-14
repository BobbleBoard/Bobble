/**
 * mac-monitor-ax-probe — LOOK at the monitor drawing the app from ACCESSIBILITY.
 *
 * Screen Recording is a grant a Mac does not have by default. Accessibility is
 * the grant computer-use cannot work without at all. So when the capture stream
 * is refused, the monitor draws the controlled window from the AX tree instead
 * of showing an error — and this is the probe that proves it, twice over, in
 * two separate app launches so neither lane can borrow the other's fixtures:
 *
 *   LANE A (deterministic, needs no grant). The dev frame source is armed and
 *   told to report `screen-recording-denied`, exactly as the helper does. The
 *   surface must switch source, say so on its face, and draw the synthetic
 *   window and its save sheet — with the pixel path measured first, in the same
 *   run, so "switching source moved nothing" is a measurement.
 *
 *   LANE B (the real thing, skipped without the Accessibility grant). NO MOCK
 *   AT ALL: a real TextEdit driven in the background, the real `pi-mac --stream`
 *   spawned against it and genuinely refused the capture, and the real AX tree
 *   polled through the app's own helper — including the save sheet, which is
 *   the case that matters most.
 *
 * Also asserted here because they apply to BOTH sources:
 *   - the wallpaper is NOT blurred (the user: "don't blur the wallpaper please") —
 *     measured as local contrast in the corners of the stage, not eyeballed;
 *   - the phantom cursor is on screen even when nothing is happening;
 *   - the 4Hz AX poll stops the moment the tab is not being watched.
 *
 * TextEdit is left with nothing unsaved. Nothing ever takes the screen.
 *
 * Artifacts → $TMPDIR/pd-shots/mac-monitor-ax (override with SHOT_DIR).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  countCursorPixels,
  countWindowInk,
  measureDrawnWindow,
  measureWallpaperDetail,
} from './_macmon-measure.mjs';
import { driveMacThroughActivity, waitForMonitorTab } from './_macmon-open.mjs';
import { launchApp } from './harness.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (script) => run('osascript', ['-e', script]).catch(() => undefined);

/** A clean TextEdit. A save sheet BLOCKS AppleScript quit, so a run that left
 * one up would poison every run after it — escape first, then quit. */
async function tidyTextEdit() {
  await osa('tell application "TextEdit" to close every document without saving');
  await sleep(400);
  await osa('tell application "TextEdit" to quit saving no');
  await sleep(1200);
}

const shots = [];
let failed = 0;

/** The per-lane toolkit: everything both lanes read off a running app. */
function tools({ page, shot, check }) {
  const snap = async (label) => {
    const file = await shot(label);
    shots.push(file);
    return file;
  };
  const until = async (fn, arg, timeout = 15_000) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 120 });
      return true;
    } catch {
      return false;
    }
  };
  const dbg = async (op, params) => {
    const res = await page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
    if (res?.ok !== true) throw new Error(`${op}: ${res?.error ?? 'failed'}`);
    return res.result;
  };
  /** What the surface is drawing from, and what it says about it. */
  const readSurface = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="computer-use-surface"]');
      if (el === null) return null;
      const note = el.querySelector('[data-testid="macmon-source-note"]');
      return {
        source: el.getAttribute('data-source'),
        note: note === null ? null : note.textContent,
        hasAction: note?.querySelector('.pd-macmon-source-action') !== null,
        footer: el.querySelector('.pd-macmon-live')?.textContent ?? '',
        state: el.querySelector('.pd-macmon-state')?.getAttribute('data-kind') ?? null,
      };
    });
  /**
   * Measure the drawn stage. The window is located by connectivity rather than
   * by brightness (see _macmon-measure.mjs), `ink` says whether anything was
   * drawn INSIDE it, and `cornerDetail` is what a blurred wallpaper destroys.
   */
  const measure = async () => {
    const box = await page.evaluate(measureDrawnWindow);
    const cornerDetail = await page.evaluate(measureWallpaperDetail);
    if (box === null) return { found: false, cornerDetail };
    const ink = await page.evaluate(countWindowInk, box);
    return {
      found: true,
      cornerDetail,
      ink,
      dpr: box.dpr,
      cssW: box.cssW,
      cssH: box.cssH,
      w: box.w / box.dpr,
      h: box.h / box.dpr,
      cx: (box.x + box.w / 2) / box.dpr,
    };
  };
  /** Is the phantom painted ON THE DRAWN WINDOW? Scoped to the window because a
   * wallpaper of blue water reads as lavender everywhere else. */
  const cursorPainted = async () => {
    const box = await page.evaluate(measureDrawnWindow);
    if (box === null) return 0;
    return page.evaluate(countCursorPixels, box);
  };
  /** Open the monitor tab full-width so the window is drawn at real size. */
  const openMonitor = async () => {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await driveMacThroughActivity(page);
    const opened = await waitForMonitorTab(page);
    check(opened, 'the Activity tab never became the monitor');
    await page.evaluate(() => window.__pi_canvas?.().setFullscreen(true));
    await sleep(500);
    return opened;
  };
  return { snap, until, dbg, readSurface, measure, cursorPainted, openMonitor };
}

// ── LANE A: the deterministic one ──────────────────────────────────────────

async function laneA() {
  const app = await launchApp('mac-monitor-ax', {
    env: { PI_MAC_MONITOR_MOCK: '1' },
    args: ['--', '--piE2E=1'],
  });
  const { page, check, finish } = app;
  const { snap, until, dbg, readSurface, measure, cursorPainted, openMonitor } = tools(app);
  const info = () => dbg('monitor-info');
  try {
    await openMonitor();

    // The pixel path first, so the two are comparable in one run.
    const live = await until(() => {
      const el = document.querySelector('[data-testid="computer-use-surface"]');
      return el?.querySelector('.pd-macmon-live[data-live="true"]') !== null;
    });
    check(live, 'the surface never reached a live pixel stream to compare against');
    await sleep(900);
    const pixels = await measure();
    await snap('01-pixels-for-comparison');

    // The wallpaper is NOT blurred. Measured, not asserted from the code: a 4px
    // gaussian over a desktop picture flattens local contrast to a couple of
    // levels per pixel pair, and this is the number that used to be that low.
    check(
      pixels !== null && pixels.cornerDetail > 3.5,
      `the wallpaper looks blurred: corner detail ${pixels?.cornerDetail?.toFixed(2)} (want > 3.5)`,
    );
    console.log(`wallpaper corner detail: ${pixels?.cornerDetail?.toFixed(2)}`);

    // Refuse the capture, exactly as the helper does.
    await dbg('monitor-mock', { deny: true, restart: true });
    const switched = await until(() => {
      const el = document.querySelector('[data-testid="computer-use-surface"]');
      return el?.getAttribute('data-source') === 'accessibility';
    });
    check(switched, 'the surface did not fall back to drawing from Accessibility');

    const denied = await info();
    check(
      denied?.stream === 'unavailable',
      `stream was ${String(denied?.stream)}, expected unavailable`,
    );
    check(denied?.captureDenied === true, 'the denial was not read as the Screen Recording grant');
    check(denied?.polling === true, 'the Accessibility poll did not start');
    check((denied?.ax?.windows?.length ?? 0) > 0, 'no Accessibility scene was published');

    const face = await readSurface();
    check(face?.state === null, `an error panel is up over the drawing (${String(face?.state)})`);
    check(
      typeof face?.note === 'string' && /Drawn from Accessibility/.test(face.note),
      `the surface does not say what it is drawing from: ${JSON.stringify(face?.note)}`,
    );
    check(
      typeof face?.note === 'string' && /Screen Recording is off/.test(face.note),
      `the surface does not say WHY: ${JSON.stringify(face?.note)}`,
    );
    check(face?.hasAction === true, 'there is no way to turn Screen Recording on');
    console.log(
      `source note: ${JSON.stringify(face?.note)} | footer: ${JSON.stringify(face?.footer)}`,
    );

    await sleep(700);
    const drawn = await measure();
    await snap('02-drawn-from-ax');
    check(drawn?.found === true, 'nothing was drawn from the Accessibility scene');
    check((drawn?.ink ?? 0) > 400, `the drawn window is empty (${String(drawn?.ink)} ink samples)`);

    // THE GEOMETRY MUST NOT MOVE between sources: same union rect, same fit.
    if (pixels?.found === true && drawn?.found === true) {
      check(
        Math.abs(drawn.w - pixels.w) <= 8 && Math.abs(drawn.h - pixels.h) <= 8,
        `switching source moved the window: pixels ${pixels.w.toFixed(0)}×${pixels.h.toFixed(0)} vs drawn ${drawn.w.toFixed(0)}×${drawn.h.toFixed(0)}`,
      );
      check(
        Math.abs(drawn.cx - drawn.cssW / 2) <= 8,
        `the drawn window is not centred (${drawn.cx.toFixed(0)} vs ${(drawn.cssW / 2).toFixed(0)})`,
      );
      console.log(
        `geometry: pixels ${pixels.w.toFixed(0)}×${pixels.h.toFixed(0)}pt → drawn ${drawn.w.toFixed(0)}×${drawn.h.toFixed(0)}pt`,
      );
    }

    // The synthetic app raises a save sheet for 4s out of every 14; catch one.
    let sheetShot = null;
    for (let i = 0; i < 30 && sheetShot === null; i += 1) {
      const scene = (await info())?.ax;
      if ((scene?.windows ?? []).some((w) => w.sheet === true)) {
        await sleep(250);
        sheetShot = await snap('03-drawn-sheet-on-top');
      } else {
        await sleep(500);
      }
    }
    check(sheetShot !== null, 'the drawn view never showed the save sheet the app put up');

    // The phantom, with nothing happening at all.
    const idle = await cursorPainted();
    check(idle > 60, `the resting phantom cursor is not painted (${idle} samples)`);
    console.log(`resting cursor: ${idle} bright-lavender samples`);

    // The poll stops when nobody is looking — the same gate as the capture.
    await page.evaluate(() => {
      const c = window.__pi_canvas?.();
      const id = c.upsertTab('probe:blank', { kind: 'terminal', title: 'Terminal' });
      c.focusTab(id);
    });
    await sleep(1000);
    check((await info())?.polling === false, 'the 4Hz poll kept running with the tab hidden');
    await page.evaluate(() => {
      const c = window.__pi_canvas?.();
      const t = c.getState().tabs.find((x) => x.kind === 'computer-use');
      if (t !== undefined) c.focusTab(t.id);
    });
    const resumed = await until(() => {
      const el = document.querySelector('[data-testid="computer-use-surface"]');
      return el?.getAttribute('data-source') === 'accessibility';
    });
    check(resumed, 'the drawing did not come back when the tab was watched again');
  } finally {
    if (!(await finish())) failed += 1;
  }
}

// ── LANE B: a REAL app, the real stream, the real tree ─────────────────────

async function laneB() {
  await tidyTextEdit();
  const app = await launchApp('mac-monitor-ax-real', {
    env: { PI_MAC_PRECONSENT: '1' },
    args: ['--', '--piE2E=1'],
  });
  const { check, finish } = app;
  const { snap, until, dbg, readSurface, measure, cursorPainted, openMonitor } = tools(app);
  const info = () => dbg('monitor-info');
  try {
    const tcc = await dbg('check');
    console.log('TCC:', JSON.stringify(tcc));
    if (tcc?.accessibility !== true) {
      console.log('SKIP lane B: Accessibility is not granted to this binary');
      return;
    }

    const launch = await dbg('launch', { app: 'TextEdit', background: true });
    const pid = launch?.pid;
    check(typeof pid === 'number', `TextEdit did not launch: ${JSON.stringify(launch)}`);
    if (typeof pid !== 'number') return;

    // Close again AFTER the launch: macOS Resume brings every unsaved window
    // back when the app reopens, so a tidy-up before the launch tidies nothing.
    // The monitor draws the union of every window the app owns (the pixel path
    // does the same), so a stack of thirteen restored Untitleds is a truthful
    // picture of a mess rather than a picture of this feature.
    await osa('tell application "TextEdit" to close every document without saving');
    await sleep(900);

    // TextEdit with no document opens its Open panel; ⌘N gives one to type in.
    await dbg('key', { pid, combo: 'cmd+n' });
    await sleep(1300);
    const doc = await dbg('snapshot', { pid });
    const area = (doc?.elements ?? []).find((e) => e.role === 'AXTextArea');
    check(area !== undefined, 'the new document has no indexed text area to type into');
    if (area !== undefined) {
      await dbg('type', {
        pid,
        index: area.index,
        text:
          'Bobble is driving this window in the background.\n\n' +
          'Screen Recording is off, so the monitor is drawing this window from ' +
          'the Accessibility tree — the same tree the model itself is reading ' +
          'and acting on. Everything here is something Accessibility reported: ' +
          'the frame, the title, the controls, and this text.\n',
        append: true,
      });
    }
    await sleep(700);

    // Point the monitor at the real app. The real `pi-mac --stream` starts, is
    // refused the capture on a machine without the grant, and the fallback
    // takes over — nothing in this lane is stubbed.
    await dbg('monitor-session', { pid, app: 'TextEdit' });
    await openMonitor();
    const drew = await until(
      () => {
        const el = document.querySelector('[data-testid="computer-use-surface"]');
        return el?.getAttribute('data-source') === 'accessibility';
      },
      undefined,
      30_000,
    );
    check(drew, 'the monitor never drew the REAL TextEdit from Accessibility');

    const real = await info();
    console.log(
      `real: stream=${String(real?.stream)} denied=${String(real?.captureDenied)} reason=${JSON.stringify(real?.streamError)} windows=${String(real?.ax?.windows?.length)} elements=${String(real?.ax?.elements?.length)}`,
    );
    check(
      real?.captureDenied === true,
      `the real stream did not report the capture grant as the reason (${JSON.stringify(real?.streamError)})`,
    );
    check(
      (real?.ax?.elements?.length ?? 0) > 3,
      `the real AX scene is too thin to be a window (${String(real?.ax?.elements?.length)} elements)`,
    );
    const face = await readSurface();
    check(face?.state === null, `an error panel is up over the real drawing (${face?.state})`);
    await sleep(900);
    const shotOf = await measure();
    await snap('04-real-textedit-from-ax');
    check(shotOf?.found === true, 'the real TextEdit was not drawn on the canvas');
    check(
      (shotOf?.ink ?? 0) > 200,
      `the real drawn window has no content in it (${String(shotOf?.ink)} ink samples)`,
    );

    // …and now the case that matters most: its save sheet.
    const saved = await dbg('menuClick', { pid, path: 'File > Save', activate: true });
    console.log('save:', JSON.stringify({ ok: saved?.ok, restored: saved?.focusRestored }));
    let sheetSeen = false;
    for (let i = 0; i < 24 && !sheetSeen; i += 1) {
      const scene = (await info())?.ax;
      sheetSeen = (scene?.windows ?? []).some((w) => w.sheet === true || w.modal === true);
      if (!sheetSeen) await sleep(400);
    }
    check(sheetSeen, 'the real save sheet never appeared in the drawn scene');
    await sleep(900);
    await snap('05-real-save-sheet-from-ax');
    const withSheet = await info();
    const sheetWin = (withSheet?.ax?.windows ?? []).find((w) => w.sheet === true);
    const inSheet = (withSheet?.ax?.elements ?? []).filter((e) => e.win === sheetWin?.windowId);
    check(
      inSheet.length > 2,
      `the drawn sheet has no controls of its own (${JSON.stringify(inSheet.map((e) => [e.role, e.name]))})`,
    );
    console.log(
      `real sheet controls: ${JSON.stringify(inSheet.map((e) => `${e.role}:${e.name}`).slice(0, 8))}`,
    );

    // Leave nothing unsaved behind.
    const full = await dbg('snapshot', { pid });
    const cancel = (full?.elements ?? []).find((e) => /^cancel$/i.test(String(e.name)));
    if (cancel !== undefined) await dbg('click', { pid, index: cancel.index });

    // ── the phantom at rest ────────────────────────────────────────────
    // the user: "always show the fake cursor around there even if just idling."
    // The overlay hides its bubble after 15s of silence; the cursor must NOT
    // go with it. This is the only place that can be proven — the mock's
    // choreography re-arms the idle timer every couple of seconds.
    console.log('waiting out the overlay idle fade (16s)…');
    await sleep(16_500);
    const quiet = await info();
    check(quiet?.bubbleVisible === false, 'the bubble never faded, so this is not the idle case');
    const resting = await cursorPainted();
    check(
      resting > 60,
      `the phantom vanished once the app went idle (${resting} bright-lavender samples)`,
    );
    console.log(`idle: bubble=${String(quiet?.bubbleVisible)} cursor=${resting} samples`);
    await snap('06-real-idle-cursor-at-rest');
  } finally {
    if (!(await finish())) failed += 1;
    await tidyTextEdit();
  }
}

await laneA();
await laneB();

console.log('\nSCREENSHOTS');
for (const f of shots) console.log(`  ${f}`);
console.log(
  failed === 0 ? '\nmac-monitor-ax-probe: OK' : `\nmac-monitor-ax-probe: ${failed} lane(s) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
