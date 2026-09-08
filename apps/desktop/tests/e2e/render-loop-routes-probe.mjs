/**
 * The loop detector (see render-loop-probe.mjs), pointed at the routes the main
 * sweep cannot reach from the chat: the situation-room demo, the canvas
 * pop-out, the corp HUD and the 3D workspace. Each is launched in its own app
 * instance, driven for a while, resized, and watched for a commit burst or the
 * crash card.
 *
 * Invisible (harness.mjs).
 */
import { launchApp } from './harness.mjs';

const BURST = Number.parseInt(process.env.BURST ?? '120', 10);

/** Query-route → the env that turns it on, and something to click once there. */
const ROUTES = [
  { name: 'situation-demo', env: {}, args: [], query: 'situationDemo' },
  { name: 'canvas-popout', env: {}, args: [], query: 'canvasPopout' },
  { name: 'corp-hud', env: { PI_DESKTOP_CORP: '1', PI_DESKTOP_CORP_HUD: '1' }, args: [] },
  { name: 'tripo', env: { PI_DESKTOP_TRIPO: '1' }, args: [] },
  { name: 'gen', env: { PI_DESKTOP_GEN: '1' }, args: [] },
];

const HOOK = () => {
  const w = window;
  if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== undefined) return;
  const commits = [];
  w.__pdCommits = commits;
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    inject: (r) => {
      const id = w.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size + 1;
      w.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.set(id, r);
      return id;
    },
    onCommitFiberRoot: (_id, root) => {
      let names = '';
      try {
        const seen = new Set();
        const walk = (fiber, depth) => {
          if (fiber === null || depth > 60 || seen.size > 30) return;
          const t = fiber.type;
          const n =
            typeof t === 'function' ? t.name : typeof t === 'string' ? null : t?.displayName;
          if (typeof n === 'string' && n.length > 0 && fiber.lanes !== 0) seen.add(n);
          walk(fiber.child, depth + 1);
          walk(fiber.sibling, depth);
        };
        walk(root.current, 0);
        names = [...seen].join(',');
      } catch {
        names = '';
      }
      commits.push({ t: performance.now(), names });
      if (commits.length > 8000) commits.splice(0, 4000);
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };
};

let failures = 0;
for (const route of ROUTES) {
  const { app, page, shot, check, finish } = await launchApp(`render-loop-${route.name}`, {
    env: route.env,
    waitFor: null,
    timeout: 45_000,
  });
  const loops = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Maximum update depth|error #185|getSnapshot should be cached/i.test(t)) loops.push(t);
  });
  page.on('pageerror', (e) => {
    const t = `${e.message}\n${e.stack ?? ''}`;
    if (/Maximum update depth|error #185/i.test(t)) loops.push(t);
  });

  await page.addInitScript(HOOK);
  const url = await page.url();
  const target =
    route.query === undefined
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}${route.query}=1`;
  await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForTimeout(3500);

  // Poke it: click a few things, resize, wait.
  for (const sel of ['button', '[role="tab"]', '[role="button"]']) {
    const els = await page.$$(sel);
    for (const el of els.slice(0, 6)) {
      await el.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
  for (const [w, h] of [
    [900, 700],
    [1400, 900],
    [780, 560],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(2000);

  const peak = await page.evaluate(() => {
    const live = window.__pdCommits ?? [];
    const c = live.slice();
    live.length = 0;
    let best = { count: 0, names: '' };
    let i = 0;
    for (let j = 0; j < c.length; j++) {
      while (c[j].t - c[i].t > 250) i++;
      if (j - i + 1 > best.count) best = { count: j - i + 1, names: c[j].names };
    }
    return best;
  });
  const crashed = (await page.$('[data-testid="app-crash"]')) !== null;
  console.log(`· ${route.name}: peak ${peak.count} commits/250ms ${peak.names}`);
  await shot(route.name);
  check(peak.count < BURST, `${route.name}: ${peak.count} commits in 250ms — ${peak.names}`);
  check(loops.length === 0, `${route.name}: React reported an update-depth loop`);
  check(!crashed, `${route.name}: the render-error card appeared`);
  if (loops.length > 0) console.error(loops[0]?.slice(0, 3000));
  await app.close().catch(() => undefined);
  if (!(await finish())) failures += 1;
  process.exitCode = 0;
}
if (failures > 0) {
  console.error(`render-loop-routes: ${failures} route(s) failed`);
  process.exitCode = 1;
} else {
  console.log('render-loop-routes OK');
}
