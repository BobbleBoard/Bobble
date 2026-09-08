/**
 * render-loop-probe.mjs — hunt React #185 ("Maximum update depth exceeded").
 *
 * the user's whole window was replaced by the crash card with `Minified React error
 * #185` in it. That error is a setState/effect LOOP, and a minified build tells
 * you nothing about which component. So this probe:
 *
 *  1. installs a React DevTools hook stub BEFORE React mounts, which counts
 *     commits per root and remembers the busiest 250ms window — a loop shows up
 *     as hundreds of commits where a normal interaction produces a handful,
 *     LONG before React's own 50-nested-update limit throws;
 *  2. drives the paths most likely to loop — streaming a turn, canvas tabs,
 *     session switching, resize, the composer, every route in the rail;
 *  3. fails on the crash card, on React's own loop warning, and on any commit
 *     burst above {@link BURST}.
 *
 * Run it against the VITE DEV SERVER (`DEV=http://localhost:5178`) for
 * unminified React and real component names, or against the built bundle for
 * the shipping check.
 *
 * Invisible, like every probe here (see harness.mjs).
 */
import path from 'node:path';
import { launchApp, REPO_ROOT } from './harness.mjs';

const DEV = process.env.DEV ?? '';
const FIXTURE = path.join(REPO_ROOT, 'packages/engine/tools/mock-pi/fixtures/stress.json');
/** Commits in one 250ms window that mean "this is a loop, not an interaction". */
const BURST = Number.parseInt(process.env.BURST ?? '150', 10);

const { app, page, shot, check, finish } = await launchApp('render-loop', {
  fixture: FIXTURE,
  env: DEV === '' ? {} : { VITE_DEV_SERVER_URL: DEV },
  timeout: 60_000,
});

/*
 * The commit counter. React looks for `__REACT_DEVTOOLS_GLOBAL_HOOK__` at
 * module scope, so this has to be installed before the bundle evaluates — hence
 * addInitScript + a reload. The stub implements only what react-dom calls.
 */
await page.addInitScript(() => {
  const w = /** @type {any} */ (window);
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
      // Name the components this commit actually re-rendered, cheaply: walk the
      // work-in-progress tree and keep any fiber whose alternate differs.
      let names = '';
      try {
        const seen = new Set();
        const walk = (fiber, depth) => {
          if (fiber === null || depth > 60 || seen.size > 40) return;
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
});
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
await page.waitForSelector('.pd-composer-editor', { timeout: 60_000 });
const hooked = await page.evaluate(() => Array.isArray(window.__pdCommits));
check(hooked, 'the commit counter never installed — the burst detector is blind');

/** Everything React complained about, with its component stack when we have one. */
const loops = [];
const bursts = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (/Maximum update depth|error #185|getSnapshot should be cached/i.test(text)) {
    loops.push(text);
    console.error('\n>>> LOOP DETECTED <<<\n', text.slice(0, 4000), '\n');
  }
});
page.on('pageerror', (err) => {
  const text = `${err.message}\n${err.stack ?? ''}`;
  if (/Maximum update depth|error #185/i.test(text)) {
    loops.push(text);
    console.error('\n>>> LOOP DETECTED (pageerror) <<<\n', text.slice(0, 4000), '\n');
  }
});

/** Read + clear the commit log; report the busiest 250ms window in it. */
const drainBurst = async (label) => {
  const worst = await page.evaluate(() => {
    // Copy then TRUNCATE IN PLACE — the hook pushes into this exact array, so
    // reassigning `window.__pdCommits` would orphan the counter (and every
    // window after the first would read zero).
    const live = window.__pdCommits ?? [];
    const c = live.slice();
    live.length = 0;
    let best = { count: 0, names: '' };
    let i = 0;
    for (let j = 0; j < c.length; j++) {
      while (c[j].t - c[i].t > 250) i++;
      const n = j - i + 1;
      if (n > best.count) {
        const tally = new Map();
        for (let k = i; k <= j; k++)
          for (const nm of c[k].names.split(',')) if (nm) tally.set(nm, (tally.get(nm) ?? 0) + 1);
        best = {
          count: n,
          names: [...tally.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([nm, x]) => `${nm}×${x}`)
            .join(' '),
        };
      }
    }
    return best;
  });
  if (worst.count >= BURST) {
    bursts.push(`${label}: ${worst.count} commits in 250ms — ${worst.names}`);
    console.error(`\n>>> COMMIT BURST during "${label}": ${worst.count} in 250ms`);
    console.error(`    ${worst.names}\n`);
  }
  return worst;
};

const crashed = async () => (await page.$('[data-testid="app-crash"]')) !== null;
const step = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log(`  (${label}: ${String(e).slice(0, 160)})`);
  }
  await page.waitForTimeout(250);
  const worst = await drainBurst(label);
  console.log(`· ${label}  (peak ${worst.count} commits/250ms) ${worst.names}`);
  if (await crashed()) {
    console.error(`  !! crash card appeared during: ${label}`);
    await shot(`crash-${label.replace(/\W+/g, '-')}`);
    check(false, `the render-error card appeared during "${label}"`);
  }
};

const type = async (text) => {
  const ed = await page.$('.pd-composer-editor');
  if (ed === null) return;
  await ed.click();
  await page.keyboard.type(text, { delay: 3 });
};
const send = async (text) => {
  await type(text);
  await page.keyboard.press('Enter');
};

await page.waitForTimeout(1200);
await shot('01-boot');

await step('send a turn', async () => {
  await send('write me a file please');
  await page.waitForTimeout(3000);
});
await shot('02-streaming');

await step('open the canvas', async () => {
  const toggle = await page.$('[data-testid="canvas-toggle"]');
  if (toggle !== null) await toggle.click();
  else {
    const alt = page.locator('[aria-label*="canvas" i], [title*="canvas" i]').first();
    if ((await alt.count()) > 0) await alt.click();
  }
  await page.waitForTimeout(800);
});
await shot('03-canvas');

await step('open every canvas surface', async () => {
  for (const name of ['Files', 'Browser', 'Terminal', 'Subagents']) {
    const row = page.getByText(name, { exact: true }).first();
    if ((await row.count()) > 0) await row.click().catch(() => {});
    await page.waitForTimeout(900);
  }
});
await shot('04-surfaces');

for (let round = 0; round < 3; round++) {
  await step(`tab cycle ${round}`, async () => {
    const tabs = await page.$$('[role="tab"], .pd-canvas-tab');
    for (const t of tabs) {
      await t.click().catch(() => {});
      await page.waitForTimeout(200);
    }
    const closers = await page.$$('.pd-canvas-tab-close, [aria-label^="Close"]');
    if (closers.length > 1) await closers[0]?.click().catch(() => {});
  });
}

await step('resize storm', async () => {
  for (const [w, h] of [
    [900, 700],
    [1400, 900],
    [780, 560],
    [1200, 800],
    [762, 562],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(220);
  }
});
await shot('05-resized');

await step('drag the canvas divider', async () => {
  const grip = await page.$('[data-testid="canvas-resize"], .pd-canvas-grip, .pd-canvas-resizer');
  if (grip === null) return;
  const b = await grip.boundingBox();
  if (b === null) return;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (const dx of [-160, 120, -240, 300, -80]) {
    await page.mouse.move(b.x + dx, b.y + b.height / 2, { steps: 6 });
    await page.waitForTimeout(90);
  }
  await page.mouse.up();
});

await step('grow the thread', async () => {
  for (let i = 0; i < 6; i++) {
    await send(`message number ${i} in a long conversation`);
    await page.waitForTimeout(900);
  }
});
await step('hover the history pole', async () => {
  const zone = await page.$('[data-testid="history-pole-zone"]');
  if (zone === null) return;
  await zone.hover();
  await page.waitForTimeout(400);
  const dots = await page.$$('[data-testid="history-pole-dot"]');
  for (const d of dots.slice(0, 4)) {
    await d.hover().catch(() => {});
    await page.waitForTimeout(150);
  }
  if (dots[0] !== undefined) await dots[0].click().catch(() => {});
});
await shot('06-pole');

await step('scroll while streaming', async () => {
  await send('now a long slow one');
  for (let i = 0; i < 24; i++) {
    await page.mouse.wheel(0, i % 2 === 0 ? -420 : 420);
    await page.waitForTimeout(60);
  }
  const scroller = await page.$('[data-testid="chat-scroll"]');
  if (scroller !== null) await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForTimeout(1500);
});
await shot('07-scrolled');

await step('new chat mid-stream', async () => {
  await send('one more, keep going');
  await page.waitForTimeout(600);
  const nu = await page.$('[data-testid="new-chat"]');
  if (nu !== null) await nu.click();
  await page.waitForTimeout(1200);
});
await step('switch chats repeatedly', async () => {
  for (let i = 0; i < 8; i++) {
    const rows = await page.$$('[data-testid^="chat-row-"]');
    const r = rows[i % Math.max(1, rows.length)];
    if (r !== undefined) await r.click().catch(() => {});
    await page.waitForTimeout(450);
  }
});
await shot('08-switched');

for (const id of [
  'nav-model-management',
  'nav-connectors',
  'nav-scheduled',
  'modality-image',
  'modality-video',
  'modality-audio',
]) {
  await step(`route ${id}`, async () => {
    if (id.startsWith('modality')) {
      const rows = await page.$('[data-testid="modality-rows"]');
      if (rows === null) {
        const t = await page.$('[data-testid="modalities-toggle"]');
        if (t !== null) await t.click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    const el = await page.$(`[data-testid="${id}"]`);
    if (el === null) return;
    await el.click();
    await page.waitForTimeout(1600);
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);
  });
  await shot(`route-${id}`);
}

await step('back to chat', async () => {
  const back = await page.$('[data-testid="new-chat"]');
  if (back !== null) await back.click();
  await page.waitForTimeout(900);
});

await step('settings open/close', async () => {
  for (let i = 0; i < 3; i++) {
    const gear = await page.$('[data-testid="settings-button"], [aria-label*="Settings" i]');
    if (gear !== null) await gear.click().catch(() => {});
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
});

await step('composer churn', async () => {
  await type('a'.repeat(400));
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  for (let i = 0; i < 4; i++) {
    const work = await page.$('[data-testid="mode-work"]');
    if (work !== null) await work.click().catch(() => {});
    await page.waitForTimeout(320);
    const chat = await page.$('[data-testid="mode-chat"]');
    if (chat !== null) await chat.click().catch(() => {});
    await page.waitForTimeout(320);
  }
});
await shot('09-composer');

check(loops.length === 0, `React reported ${loops.length} update-depth loop(s)`);
check(bursts.length === 0, `commit bursts: ${bursts.join(' | ')}`);
check(!(await crashed()), 'the render-error card is showing at the end of the run');

if (loops.length > 0) {
  console.error('\n===== LOOPS =====');
  for (const l of loops) console.error(l.slice(0, 6000));
}
await app.close().catch(() => undefined);
await finish();
