/**
 * The loop detector (render-loop-probe.mjs) pointed at the STATUS machinery —
 * the part of the app a mock-pi fixture never exercises.
 *
 * The pill above the composer, the thread's processing ring, the re-prefill
 * warning and the attachment prime are all effects keyed on
 * `extensionStatus[…]`, `llm.status.phase` and the streaming flags. That is
 * the newest and busiest cluster of setState-in-an-effect in the app, and
 * nothing that drives pi from a fixture ever moves those keys. So this moves
 * them directly, hundreds of times, in every order — the shape React #185 is
 * made of — and watches the commit counter.
 *
 * Invisible (harness.mjs).
 */
import { launchApp } from './harness.mjs';

const BURST = Number.parseInt(process.env.BURST ?? '150', 10);

const { app, page, shot, check, finish } = await launchApp('render-loop-status');

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
      if (commits.length > 40000) commits.splice(0, 20000);
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };
});
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
await page.waitForSelector('.pd-composer-editor', { timeout: 60_000 });
await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });

const loops = [];
page.on('console', (m) => {
  const t = m.text();
  if (/Maximum update depth|error #185|getSnapshot should be cached/i.test(t)) loops.push(t);
});
page.on('pageerror', (e) => {
  const t = `${e.message}\n${e.stack ?? ''}`;
  if (/Maximum update depth|error #185/i.test(t)) loops.push(t);
});

// A real conversation underneath, so the warning/prime paths have something to
// judge (both bail out on an empty thread).
await page.evaluate(() => {
  const messages = [];
  for (let i = 0; i < 12; i += 1) {
    messages.push({ kind: 'user', id: `u${i}`, text: `question ${i}`, timestamp: i * 2 });
    messages.push({
      kind: 'assistant',
      id: `a${i}`,
      timestamp: i * 2 + 1,
      isStreaming: false,
      usage: { input: 24_000, output: 200 },
      blocks: [{ type: 'text', text: `answer ${i} ${'word '.repeat(40)}` }],
    });
  }
  window.__pi_store().setState({ messages });
});
await page.waitForTimeout(800);
await shot('01-seeded');

const drain = () =>
  page.evaluate(() => {
    const live = window.__pdCommits ?? [];
    const c = live.slice();
    live.length = 0;
    let best = 0;
    let i = 0;
    for (let j = 0; j < c.length; j++) {
      while (c[j] - c[i] > 250) i++;
      if (j - i + 1 > best) best = j - i + 1;
    }
    return { peak: best, total: c.length };
  });

const step = async (label, fn) => {
  await fn();
  await page.waitForTimeout(400);
  const { peak, total } = await drain();
  console.log(`· ${label}  (peak ${peak}/250ms, ${total} commits)`);
  if (peak >= BURST) check(false, `${label}: ${peak} commits in 250ms`);
  const crashed = (await page.$('[data-testid="app-crash"]')) !== null;
  if (crashed) {
    await shot(`crash-${label.replace(/\W+/g, '-')}`);
    check(false, `the render-error card appeared during "${label}"`);
  }
};

await step('prefill percentages', async () => {
  await page.evaluate(async () => {
    const store = window.__pi_store();
    store.setState({ promptInFlight: true });
    for (let i = 0; i <= 100; i += 4) {
      store.setState({
        extensionStatus: { ...store.getState().extensionStatus, 'harness-prefill': `${i}%` },
      });
      await new Promise((r) => setTimeout(r, 12));
    }
    store.setState({ promptInFlight: false });
  });
});

await step('the prefix keys, flapping', async () => {
  await page.evaluate(async () => {
    const store = window.__pi_store();
    for (let i = 0; i < 60; i += 1) {
      store.setState({
        extensionStatus: {
          ...store.getState().extensionStatus,
          'harness-prefill-system': i % 2 === 0 ? 'system A' : 'system B',
          'harness-prefill-tools': i % 3 === 0 ? '["a"]' : '["a","b"]',
          'harness-slot-epoch': String(i),
          'harness-prefix-warm': i % 4 === 0 ? 'warming' : 'warm',
        },
      });
      await new Promise((r) => setTimeout(r, 12));
    }
  });
});

await step('streaming on and off', async () => {
  await page.evaluate(async () => {
    const store = window.__pi_store();
    for (let i = 0; i < 40; i += 1) {
      store.setState({
        agent: { ...store.getState().agent, isStreaming: i % 2 === 0 },
        promptInFlight: i % 3 === 0,
      });
      await new Promise((r) => setTimeout(r, 15));
    }
    store.setState({
      agent: { ...store.getState().agent, isStreaming: false },
      promptInFlight: false,
    });
  });
});

await step('the model loading and becoming ready', async () => {
  await page.evaluate(async () => {
    const llm = window.__llm_store?.();
    if (llm === undefined) return;
    const base = llm.getState().status;
    for (let i = 0; i < 40; i += 1) {
      const phase = ['idle', 'starting', 'ready', 'downloading'][i % 4];
      llm.setState({ status: { ...base, phase, serverRunning: i % 2 === 0 } });
      await new Promise((r) => setTimeout(r, 20));
    }
    llm.setState({ status: base });
  });
});

await step('compaction on and off', async () => {
  await page.evaluate(async () => {
    const store = window.__pi_store();
    for (let i = 0; i < 20; i += 1) {
      store.setState({ agent: { ...store.getState().agent, isCompacting: i % 2 === 0 } });
      await new Promise((r) => setTimeout(r, 25));
    }
    store.setState({ agent: { ...store.getState().agent, isCompacting: false } });
  });
});

await step('all of it at once', async () => {
  await page.evaluate(async () => {
    const store = window.__pi_store();
    const llm = window.__llm_store?.();
    const base = llm?.getState().status;
    for (let i = 0; i < 80; i += 1) {
      store.setState({
        promptInFlight: i % 5 === 0,
        agent: { ...store.getState().agent, isStreaming: i % 2 === 0 },
        extensionStatus: {
          ...store.getState().extensionStatus,
          'harness-prefill': `${i % 100}%`,
          'harness-slot-epoch': String(i),
          'harness-prefix-warm': i % 3 === 0 ? 'warming' : 'warm',
          'harness-prefill-system': i % 7 === 0 ? 'system A' : 'system B',
        },
      });
      if (llm !== undefined && base !== undefined) {
        llm.setState({ status: { ...base, phase: i % 2 === 0 ? 'starting' : 'ready' } });
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    store.setState({
      promptInFlight: false,
      agent: { ...store.getState().agent, isStreaming: false },
    });
    if (llm !== undefined && base !== undefined) llm.setState({ status: base });
  });
});
await shot('02-after');

check(loops.length === 0, `React reported ${loops.length} update-depth loop(s)`);
if (loops.length > 0) console.error(loops[0]?.slice(0, 4000));
await app.close().catch(() => undefined);
await finish();
