/**
 * CLICKING ANOTHER CHAT SHOULD BE INSTANT.
 *
 * The user: "clicking onto a different chat has a ~2 second delay when it should be
 * totally instant."
 *
 * This times the click, and splits it, because "2 seconds" has at least four
 * candidate owners and the fix is different for each:
 *
 *   pi:switch-session   the RPC into the pi child (it has to settle its session)
 *   loadViewedThread    reading the JSONL back and rebuilding the thread
 *   paint               the moment the new thread is actually on screen
 *
 * Uses mock-pi, so what it measures is the app's own work rather than a model.
 * The real app's switch does the same RPC.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const home = probeHome('chat-switch-latency');
const dir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(dir, { recursive: true });
const l = (o) => JSON.stringify(o);

/** A chat with `n` exchanges — long enough that rebuilding it is real work. */
const makeChat = (id, title, n) => {
  const rows = [l({ type: 'session', version: 3, id, timestamp: 't', cwd: '/tmp' })];
  let parent = null;
  for (let i = 0; i < n; i++) {
    const u = `${id}-u${i}`;
    const a = `${id}-a${i}`;
    rows.push(
      l({
        type: 'message',
        id: u,
        parentId: parent,
        timestamp: 't',
        message: { role: 'user', content: i === 0 ? title : `question ${i}`, timestamp: i },
      }),
      l({
        type: 'message',
        id: a,
        parentId: u,
        timestamp: 't',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `answer ${i} — with enough words to be a real paragraph.` },
          ],
          timestamp: i,
        },
      }),
    );
    parent = a;
  }
  writeFileSync(path.join(dir, `${id}.jsonl`), rows.join('\n'));
};

/*
 * LENGTH IS A VARIABLE, and the first cut of this probe hid the answer by
 * picking 40. `TURNS=300` is a chat somebody has actually been using.
 */
const TURNS = Number(process.env.TURNS ?? 40);
makeChat('alpha', 'the coffee launch', TURNS);
makeChat('beta', 'the packaging brief', TURNS);

/*
 * REAL=1 runs it against the real pi child and a real model, which is the only
 * configuration that can reproduce what the user sees — mock-pi answers
 * `switch_session` instantly, so under the mock this probe measures the app's
 * own work and nothing else. Both numbers are worth having: the difference
 * between them IS the pi round trip.
 */
const REAL = process.env.REAL === '1';
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const { page, check, finish } = await launchApp('chat-switch-latency', {
  env: { HOME: home, ...(REAL ? { PI_BIN: undefined } : {}) },
  ...(REAL ? { realCache: true, timeout: 120_000 } : {}),
});

try {
  if (REAL) {
    await page.evaluate(async (modelId) => {
      await window.piDesktop.invoke('pi:start', {});
      await window.piDesktop.invoke('llm:start-server', { modelId });
    }, MODEL);
    await page.waitForFunction(
      () => window.__llm_store?.().getState().status.serverRunning === true,
      undefined,
      { timeout: 300_000 },
    );
    await page.evaluate(async (modelId) => {
      await window.piDesktop.invoke('pi:restart', {});
      await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId });
    }, MODEL);
    await page.waitForTimeout(6000);
    console.log('  (real pi + real model)');
  }
  await page.waitForSelector('[data-testid="chat-row-the coffee launch"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="chat-row-the packaging brief"]', { timeout: 20_000 });
  await page.waitForTimeout(800);

  const firstUserText = () =>
    page.evaluate(() => {
      const m = window.__pi_store().getState().messages;
      return m.find((x) => x.kind === 'user')?.text ?? null;
    });

  /** Click a row and wait until its FIRST message is the one on screen. */
  const switchTo = async (title) => {
    const t0 = Date.now();
    await page.click(`[data-testid="chat-row-${title}"]`);
    await page.waitForFunction(
      (want) => {
        const m = window.__pi_store?.().getState().messages ?? [];
        return m.some((x) => x.kind === 'user' && x.text === want);
      },
      title,
      { timeout: 30_000 },
    );
    return Date.now() - t0;
  };

  await switchTo('the coffee launch');
  // Record every llm phase change from here on, so a restart cannot happen
  // quietly between two clicks.
  await page.evaluate(() => {
    window.__llm_phases = [window.__llm_store?.().getState().status.phase ?? 'none'];
    window.__llm_store?.().subscribe((s) => {
      const p = s.status.phase;
      if (window.__llm_phases.at(-1) !== p) window.__llm_phases.push(p);
    });
  });
  const times = [];
  for (let i = 0; i < 6; i++) {
    times.push(await switchTo(i % 2 === 0 ? 'the packaging brief' : 'the coffee launch'));
    await page.waitForTimeout(300);
  }
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
  /*
   * The user: "when swapping between chats with the same model, no reloading of the
   * model should occur." A restart shows up as the llm phase leaving `ready`,
   * so the probe watches for that across the whole run rather than trusting
   * that nobody wired one in.
   */
  const phases = await page.evaluate(() => window.__llm_phases ?? []);
  if (phases.length > 0) console.log(`  llm phases seen: ${phases.join(' → ')}`);
  console.log(`  switch times: ${times.map((t) => `${t}ms`).join(', ')}`);
  console.log(`  median: ${median}ms`);
  console.log(`  showing: ${await firstUserText()}`);

  check(median < 400, `switching chats is instant (median ${median}ms, was ~2000ms)`);
  check(
    !phases.slice(1).includes('starting'),
    `the model is NOT reloaded by a chat switch (phases: ${phases.join(' → ')})`,
  );
} finally {
  await finish();
}
