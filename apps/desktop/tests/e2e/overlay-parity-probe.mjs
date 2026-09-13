/**
 * THE PHANTOM IS CUT OUT WHEREVER ANOTHER APP COVERS IT — proven against the
 * mask PATH the compositor fills, not the rect arithmetic that lied for a
 * release.
 *
 * the user, 2026-09-12: "can confirm visually that the bug is NOT FIXED. fake
 * cursor frequently appears on top of undesired apps." Root cause: the mask
 * was panel + one rect per covering window, filled even-odd, so a point under
 * TWO covering windows was painted; and the Dock's hollow screen-sized window
 * put every point off by one. See disjointUnion / dockStrips in Overlay.swift.
 *
 * Drives a private `pi-mac --overlay` (the same binary the app spawns) with
 * synthetic occluders, and — when Notes is running — the real window list.
 *
 *   node apps/desktop/tests/e2e/overlay-parity-probe.mjs
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const HELPER = process.env.HELPER ?? '../../packages/pi-mac/swift/.build/release/pi-mac';
const failures = [];
const check = (cond, msg) => {
  if (cond) return true;
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
  return false;
};
function client(args) {
  const p = spawn(HELPER, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: p.stdout });
  const waiters = new Map();
  let id = 0;
  rl.on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  });
  const stderr = [];
  p.stderr.on('data', (d) => stderr.push(String(d)));
  return {
    p,
    stderr,
    req: (method, params = {}) =>
      new Promise((res) => {
        const i = ++id;
        waiters.set(i, res);
        p.stdin.write(`${JSON.stringify({ id: i, method, params })}\n`);
      }),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overlay = client(['--overlay']);
try {
  await overlay.req('ping');
  await overlay.req('show');
  const at = async (rects, pt) => {
    await overlay.req('occluders', { rects });
    await overlay.req('cursor', { x: pt.x, y: pt.y, ms: 0 });
    await sleep(100);
    return (await overlay.req('info')).result;
  };
  const A = { x: 100, y: 100, w: 400, h: 300 };
  const B = { x: 300, y: 200, w: 400, h: 300 };
  const SCREEN = { x: 0, y: 0, w: 1512, h: 982 };
  const STRIP = { x: 0, y: 900, w: 1512, h: 82 };

  // 1. Synthetic parity cases — every point under any hole is masked, the rest is not.
  const cases = [
    ['one hole, tip inside', [A], { x: 150, y: 150 }, true],
    ['two overlapping holes, tip in both', [A, B], { x: 350, y: 250 }, true],
    ['two overlapping holes, tip in one', [A, B], { x: 150, y: 150 }, true],
    ['screen-sized + one, tip in both', [SCREEN, A], { x: 150, y: 150 }, true],
    ['three overlapping, tip in all', [SCREEN, A, B], { x: 350, y: 250 }, true],
    ['strip + one, tip outside both', [STRIP, A], { x: 800, y: 600 }, false],
    ['two overlapping, tip outside both', [A, B], { x: 800, y: 600 }, false],
    ['no holes', [], { x: 350, y: 250 }, false],
  ];
  for (const [label, rects, pt, masked] of cases) {
    const i = await at(rects, pt);
    console.log(
      `${label}: holes=${i.maskHoles} rects=${i.maskRects} covered(rects)=${i.cursorCovered} masked(path)=${i.cursorMasked}`,
    );
    check(
      i.cursorMasked === masked,
      `${label}: expected masked=${masked}, path says ${i.cursorMasked}`,
    );
    check(i.cursorCovered === masked, `${label}: the rect arithmetic agrees with the path`);
  }
  // The union really is disjoint: two overlapping rects reduce to more, smaller,
  // non-overlapping ones; a contained rect vanishes into its container.
  const u1 = await at([A, B], { x: 0, y: 0 });
  check(u1.maskRects >= 3, `two overlapping holes decompose into disjoint bands (${u1.maskRects})`);
  const u2 = await at([SCREEN, A], { x: 0, y: 0 });
  check(u2.maskRects === 1, `a hole inside a screen-sized hole vanishes into it (${u2.maskRects})`);

  // 2. The pill's controls window exists only while the pill is uncovered.
  await overlay.req('status', { status: 'thinking', text: 'Thinking' });
  await overlay.req('pill', { enabled: true });
  const shown = await at([], { x: 700, y: 500 });
  await sleep(400);
  const c1 = (await overlay.req('info')).result;
  check(c1.bubble?.visible === true, 'the pill is showing');
  check(
    c1.controls?.visible === true,
    `the controls window is up with an uncovered pill (${JSON.stringify(c1.controls)})`,
  );
  const pf = c1.bubble.frame;
  const overPill = { x: pf.x - 20, y: pf.y - 20, w: pf.w + 40, h: pf.h + 40 };
  const c2 = await at([overPill], { x: 700, y: 500 });
  check(c2.pillCovered === true, 'a hole over the pill is noticed');
  check(
    c2.controls?.visible === false,
    `…and the controls window is ordered out (${JSON.stringify(c2.controls)})`,
  );
  const c3 = await at([], { x: 700, y: 500 });
  await sleep(100);
  const c3b = (await overlay.req('info')).result;
  check(c3b.controls?.visible === true, 'the controls come back once the pill is clear');
  void shown;

  // 3. The real window list, when Notes is up: the Dock's screen-sized window
  //    contributes only its strip, and a tip under other apps is masked.
  const serve = client(['--serve']);
  const b = await serve.req('bounds', { app: 'Notes' });
  const bounds = b.result ?? b;
  if (typeof bounds?.pid === 'number' && typeof bounds?.x === 'number') {
    await overlay.req('target', {
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      pid: bounds.pid,
      ...(typeof bounds.windowId === 'number' ? { windowNumber: bounds.windowId } : {}),
    });
    await overlay.req('cursor', { x: bounds.x + 120, y: bounds.y + 60, ms: 0 });
    await sleep(300);
    const live = (await overlay.req('info')).result;
    const occ = live.occluders ?? [];
    console.log('live occluders:', JSON.stringify(occ));
    const screenSized = occ.filter((r) => r.w >= 1400 && r.h >= 900);
    check(
      screenSized.length === 0,
      `no screen-sized hole from the Dock's hollow window (${JSON.stringify(screenSized)})`,
    );
    check(
      live.cursorMasked === live.cursorCovered,
      `live: path and rects agree (masked=${live.cursorMasked}, covered=${live.cursorCovered})`,
    );
    console.log(
      `live: tip covered=${live.cursorCovered} masked=${live.cursorMasked} holes=${live.maskHoles} rects=${live.maskRects}`,
    );
    await overlay.req('target', {});
  } else {
    console.log('Notes not running — live window-list case skipped');
  }
  serve.p.kill();
} finally {
  await overlay.req('hide').catch(() => {});
  overlay.p.kill();
}
console.log(failures.length === 0 ? 'overlay-parity-probe OK' : `FAILED: ${failures.length}`);
