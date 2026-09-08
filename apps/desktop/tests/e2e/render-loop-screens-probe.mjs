/**
 * render-loop-screens-probe.mjs — the same loop detector as render-loop-probe,
 * pointed at the two screens that were rewritten hours before the user's crash:
 * Connectors and Scheduled. Drives them the way a person does — open a detail,
 * toggle a switch, search, open the add dialog, make and edit a task — with the
 * commit counter watching for the runaway that React eventually turns into
 * "Maximum update depth exceeded" (#185).
 *
 * Invisible (harness.mjs).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const BURST = Number.parseInt(process.env.BURST ?? '120', 10);

// A home with a couple of scheduled tasks already in it, so the list page has
// rows to open and a ledger to expand.
const home = probeHome('render-loop-screens');
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify(
    {
      modelSelection: { mode: 'tier', tier: 'balanced' },
      scheduledTasks: [
        {
          id: 't1',
          name: 'Morning digest',
          prompt: 'summarise my inbox',
          frequency: 'daily',
          hour: 9,
          minute: 0,
          enabled: true,
        },
        {
          id: 't2',
          name: 'Weekly clean',
          prompt: 'tidy the downloads folder',
          frequency: 'weekly',
          weekday: 1,
          hour: 18,
          minute: 30,
          enabled: false,
        },
      ],
    },
    null,
    2,
  )}\n`,
);

const { app, page, shot, check, finish } = await launchApp('render-loop-screens', {
  env: { HOME: home },
  timeout: 60_000,
});

await page.addInitScript(() => {
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
    onCommitFiberRoot: () => {
      commits.push(performance.now());
      if (commits.length > 20000) commits.splice(0, 10000);
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };
});
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
await page.waitForSelector('.pd-composer-editor', { timeout: 60_000 });

const loops = [];
const bursts = [];
page.on('console', (m) => {
  const t = m.text();
  if (/Maximum update depth|error #185|getSnapshot should be cached/i.test(t)) {
    loops.push(t);
    console.error(`\n>>> LOOP: ${t.slice(0, 2000)}\n`);
  }
});
page.on('pageerror', (e) => {
  const t = `${e.message}\n${e.stack ?? ''}`;
  if (/Maximum update depth|error #185/i.test(t)) {
    loops.push(t);
    console.error(`\n>>> LOOP: ${t.slice(0, 2000)}\n`);
  }
});

const drain = async () =>
  await page.evaluate(() => {
    const live = window.__pdCommits ?? [];
    const c = live.slice();
    live.length = 0;
    let best = 0;
    let i = 0;
    for (let j = 0; j < c.length; j++) {
      while (c[j] - c[i] > 250) i++;
      if (j - i + 1 > best) best = j - i + 1;
    }
    return best;
  });

const crashed = async () => (await page.$('[data-testid="app-crash"]')) !== null;
const step = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log(`  (${label}: ${String(e).slice(0, 140)})`);
  }
  await page.waitForTimeout(250);
  const peak = await drain();
  console.log(`· ${label}  (peak ${peak} commits/250ms)`);
  if (peak >= BURST) {
    bursts.push(`${label}: ${peak}`);
    console.error(`>>> COMMIT BURST during "${label}": ${peak} in 250ms`);
  }
  if (await crashed()) {
    const text = await page.textContent('[data-testid="app-crash"]').catch(() => '');
    console.error(`  !! crash card during "${label}": ${String(text).slice(0, 400)}`);
    await shot(`crash-${label.replace(/\W+/g, '-')}`);
    check(false, `render-error card during "${label}"`);
  }
};

const click = async (sel) => {
  const el = await page.$(sel);
  if (el === null) return false;
  await el.click({ timeout: 4000 }).catch(() => {});
  return true;
};

// ───────────────────────── CONNECTORS ─────────────────────────
await step('open connectors', async () => {
  await click('[data-testid="nav-connectors"]');
  await page.waitForTimeout(1600);
});
await shot('01-connectors');

await step('search the catalogue', async () => {
  const box = await page.$('[data-testid="connectors-search"], input[type="search"]');
  if (box === null) return;
  for (const q of ['git', 'mem', 'brow', 'zzz']) {
    await box.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type(q, { delay: 12 });
    await page.waitForTimeout(500);
  }
  // Leave the list SHOWING — everything after this needs rows to click.
  await box.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(600);
});

await step('open every connector detail', async () => {
  const opens = await page.$$('[data-testid^="connector-open-"]');
  for (const o of opens.slice(0, 8)) {
    await o.click().catch(() => {});
    await page.waitForTimeout(900);
    await click('[data-testid="connectors-back"]');
    await page.waitForTimeout(500);
  }
});
await shot('02-details');

await step('toggle a connector on and off', async () => {
  for (let i = 0; i < 4; i++) {
    const sw = await page.$$('[role="switch"]');
    if (sw[0] === undefined) return;
    await sw[0].click().catch(() => {});
    await page.waitForTimeout(900);
  }
});
await shot('03-toggled');

await step('add-server dialog', async () => {
  await click('[data-testid="connectors-add-server"]');
  await page.waitForTimeout(900);
  const cmd = await page.$('[data-testid="add-server-command"]');
  if (cmd !== null) {
    await cmd.click();
    await page.keyboard.type('npx -y some-server --flag', { delay: 8 });
    await page.waitForTimeout(700);
  }
  await click('[data-testid="add-server-more"]');
  await page.waitForTimeout(500);
  await click('[data-testid="add-server-cancel"]');
  await page.waitForTimeout(600);
});
await shot('04-add-dialog');

await step('resize connectors', async () => {
  for (const [w, h] of [
    [820, 620],
    [1400, 900],
    [770, 600],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(350);
  }
});

// ───────────────────────── SCHEDULED ─────────────────────────
await step('open scheduled', async () => {
  await click('[data-testid="new-chat"]');
  await page.waitForTimeout(500);
  await click('[data-testid="nav-scheduled"]');
  await page.waitForTimeout(1600);
});
await shot('05-scheduled');

await step('open a task page', async () => {
  const rows = await page.$$('[data-testid^="sd-task-"], .sd-row, [data-testid="sd-title"]');
  if (rows[0] !== undefined) await rows[0].click().catch(() => {});
  await page.waitForTimeout(1200);
});
await shot('06-task');

await step('the run ledger', async () => {
  await click('[data-testid="sd-ledger-more"]');
  await page.waitForTimeout(600);
  await click('[data-testid="sd-run-now"]');
  await page.waitForTimeout(1500);
  await click('[data-testid="sd-stop"]');
  await page.waitForTimeout(800);
});

await step('the task editor', async () => {
  await click('[data-testid="sd-edit"]');
  await page.waitForTimeout(900);
  const prompt = await page.$('[data-testid="sd-editor-prompt"]');
  if (prompt !== null) {
    await prompt.click();
    for (const s of [
      ' every friday at 6pm',
      ' every day at 9am',
      ' every monday',
      ' at 22:15',
      ' weekly',
    ]) {
      await page.keyboard.type(s, { delay: 10 });
      await page.waitForTimeout(700);
    }
  }
  await page.waitForTimeout(900);
  await click('[data-testid="sd-editor-cancel"]');
  await page.waitForTimeout(700);
});
await shot('07-editor');

await step('new task from a sentence', async () => {
  await click('[data-testid="sd-back"]');
  await page.waitForTimeout(500);
  await click('[data-testid="sd-new"]');
  await page.waitForTimeout(900);
  const prompt = await page.$('[data-testid="sd-editor-prompt"]');
  if (prompt !== null) {
    await prompt.click();
    await page.keyboard.type('every weekday at 7:45 check the build', { delay: 14 });
    await page.waitForTimeout(1200);
    // Nudge each When control so the sentence-vs-touched branch flips both ways.
    for (const id of ['sd-editor-frequency', 'sd-editor-hour', 'sd-editor-minute']) {
      const el = await page.$(`[data-testid="${id}"]`);
      if (el === null) continue;
      await el.click().catch(() => {});
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
    }
    await prompt.click();
    await page.keyboard.type(' and every monday at 8am too', { delay: 12 });
    await page.waitForTimeout(1200);
  }
  await click('[data-testid="sd-editor-cancel"]');
  await page.waitForTimeout(700);
});
await shot('08-new-task');

await step('scheduling switch + resize', async () => {
  for (let i = 0; i < 4; i++) {
    await click('[data-testid="sd-scheduling-switch"]');
    await page.waitForTimeout(500);
  }
  for (const [w, h] of [
    [820, 620],
    [1400, 900],
    [770, 600],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(350);
  }
});
await shot('09-final');

check(loops.length === 0, `React reported ${loops.length} update-depth loop(s)`);
check(bursts.length === 0, `commit bursts: ${bursts.join(' | ')}`);
check(!(await crashed()), 'the render-error card is showing at the end of the run');
await app.close().catch(() => undefined);
await finish();
