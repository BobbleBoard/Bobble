/**
 * OPENING AN OLD CHAT SHOULD LOAD IT WHILE YOU TYPE.
 *
 * the user: "when I go to an existing chat and take some time, while I'm writing my
 * prompt or waiting or whatever, it's getting loaded … so no time after pressing
 * send is wasted on that stuff."
 *
 * The A/B is the only honest way to show it: open a long chat, send IMMEDIATELY
 * (nothing had time to prime), then open it again, WAIT the way a person typing
 * a sentence waits, and send the same message. If the conversation is being
 * primed on open, the second number is much smaller — and if it is not, the two
 * are the same and this probe says so.
 *
 * Real pi, real model: a prefix cache is the thing being measured, so a mock
 * says nothing at all here.
 *
 *   MODEL=<id>    default qwen3.5-4b-mtp
 *   TURNS=<n>     exchanges in the seeded chat (default 30 — big enough that a
 *                 cold prefill of it is seconds, small enough to stay quick)
 *   THINK_MS=<n>  how long the "user" spends typing before pressing enter
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const TURNS = Number(process.env.TURNS ?? 30);
const THINK_MS = Number(process.env.THINK_MS ?? 12_000);

const home = probeHome('open-chat-prefill');
const dir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(dir, { recursive: true });
const l = (o) => JSON.stringify(o);

/** A chat with real bulk in it — a paragraph per turn, not "hi". */
const seed = (id, title) => {
  const rows = [l({ type: 'session', version: 3, id, timestamp: 't', cwd: '/tmp' })];
  let parent = null;
  const para =
    'We agreed the roastery can hit four hundred bags a month if the second grinder lands ' +
    'before the launch window, and that the packaging photography should be booked for the ' +
    'week after the labels are signed off, so the announcement email has real pictures in it.';
  for (let i = 0; i < TURNS; i++) {
    const u = `${id}-u${i}`;
    const a = `${id}-a${i}`;
    rows.push(
      l({
        type: 'message',
        id: u,
        parentId: parent,
        timestamp: 't',
        message: {
          role: 'user',
          content: i === 0 ? title : `${para} (question ${i})`,
          timestamp: i,
        },
      }),
      l({
        type: 'message',
        id: a,
        parentId: u,
        timestamp: 't',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${para} (answer ${i})` }],
          timestamp: i,
        },
      }),
    );
    parent = a;
  }
  writeFileSync(path.join(dir, `${id}.jsonl`), rows.join('\n'));
};

seed('alpha', 'the coffee launch');
seed('beta', 'the packaging brief');

const { page, check, finish } = await launchApp('open-chat-prefill', {
  env: { HOME: home, PI_BIN: undefined },
  realCache: true,
  timeout: 120_000,
});

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
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
  await page.waitForTimeout(10_000); // let the model-load warm-up settle

  const openChat = async (title) => {
    await page.click(`[data-testid="chat-row-${title}"]`);
    await page.waitForFunction(
      (want) =>
        (window.__pi_store?.().getState().messages ?? []).some(
          (m) => m.kind === 'user' && m.text === want,
        ),
      title,
      { timeout: 30_000 },
    );
  };

  /** Type a short question and time from Enter to the first token. */
  const ask = async (text) => {
    const before = await page.evaluate(() => window.__pi_store().getState().messages.length);
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type(text);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (n) => {
        const m = window.__pi_store().getState().messages;
        if (m.length <= n) return false;
        const last = m[m.length - 1];
        return (
          last?.kind === 'assistant' &&
          (last.blocks ?? []).some((b) => (b.text ?? b.thinking ?? '').length > 0)
        );
      },
      before,
      { timeout: 300_000 },
    );
    return Date.now() - t0;
  };

  // A: open and send at once — nothing had time to prime.
  await openChat('the coffee launch');
  const cold = await ask('In one sentence: how many bags?');
  console.log(`  sent IMMEDIATELY on open:      ${cold}ms`);

  /*
   * B: SAME CHAT, JUST WAIT. Isolates "does thinking time cost anything?" from
   * "does leaving and coming back cost anything?" — the first cut of this probe
   * conflated the two and I read the answer backwards because of it.
   */
  console.log(`  (waiting ${THINK_MS}ms in the same chat, as if typing)`);
  await page.waitForTimeout(THINK_MS);
  const waited = await ask('In one sentence: when is the shoot?');
  console.log(`  waited in the SAME chat:       ${waited}ms`);

  // C: go away, come back, wait the same amount, send.
  await openChat('the packaging brief');
  await page.waitForTimeout(2000);
  await openChat('the coffee launch');
  await page.waitForTimeout(THINK_MS);
  const returned = await ask('In one sentence: who signs off the labels?');
  console.log(`  left and came back:            ${returned}ms`);

  console.log(`\n  immediate ${cold}ms · waited ${waited}ms · returned ${returned}ms`);
  /*
   * WHAT IS ACTUALLY BEING ASSERTED. Thinking time must never COST anything — a
   * prefix that was resident when you opened the chat should still be resident
   * when you finish your sentence. And coming back to a chat should not be far
   * worse than never having left, or the app is throwing away the conversation
   * you just walked away from.
   */
  check(waited < cold * 1.6, `thinking time does not cost anything (${cold}ms -> ${waited}ms)`);
  /*
   * RETURNING IS STILL THE EXPENSIVE ONE, and this bound records that rather
   * than pretending otherwise. MEASURED, repeatedly: immediate ~285ms, waited
   * ~157ms, returned ~825ms.
   *
   * It is NOT the prefill: instrumented inside the hook, opening a chat primes
   * the conversation (9,578 tokens on a 40-turn chat, where it primed zero
   * before). Something else about re-entering a session pays again, and the
   * target is parity with `waited`. The bound is set where it will catch a
   * regression without claiming the gap is closed.
   */
  check(
    returned < Math.max(cold, waited) * 4,
    `returning to a chat is not catastrophically worse (${returned}ms vs ${cold}ms immediate; target is ${waited}ms)`,
  );
} finally {
  await finish();
}
