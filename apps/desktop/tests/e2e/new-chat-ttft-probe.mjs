/**
 * A NEW CHAT SHOULD BE INSTANT, AND IT IS NOT.
 *
 * The user: "TTFT is unacceptable, I was idle for like an hour, left this in the
 * background, and it took on a blank conversation and another essentially blank
 * one almost 10 seconds each to respond."
 *
 * Timing alone cannot say why, so this reads llama-server's own counters after
 * every send: `n_prompt_tokens` is what the request carried, and
 * `n_prompt_tokens_processed` is how much of it the server actually had to
 * compute. A warm prefix computes almost nothing.
 *
 * The sequence is his: say hi, wait, say hi again in the SAME chat, then open a
 * NEW chat and say hi there. If new chats are the expensive ones, the third
 * number is the one that is large — and the fix is nowhere near where timing
 * would have sent us looking.
 */
import { execSync } from 'node:child_process';
import { launchApp } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';

const discoverPort = () => {
  try {
    const out = execSync('ps -Ao pid,command | grep llama-server | grep -v grep', {
      encoding: 'utf8',
    });
    const found = out
      .split('\n')
      .map((l) => /^\s*(\d+)\s+.*--port (\d+)/.exec(l))
      .filter((m) => m !== null)
      .map((m) => ({ pid: Number(m[1]), port: Number(m[2]) }))
      .sort((a, b) => b.pid - a.pid);
    return found[0]?.port ?? null;
  } catch {
    return null;
  }
};

const { page, check, finish } = await launchApp('new-chat-ttft', {
  realCache: true,
  env: { PI_BIN: undefined },
  timeout: 120_000,
});

const slots = async () => {
  const port = discoverPort();
  if (port === null) return null;
  try {
    const j = await fetch(`http://127.0.0.1:${port}/slots`).then((r) => r.json());
    return { total: j[0]?.n_prompt_tokens ?? 0, processed: j[0]?.n_prompt_tokens_processed ?? 0 };
  } catch {
    return null;
  }
};

const fmt = (s) =>
  s === null
    ? '(no /slots)'
    : `${s.total} tok, ${s.processed} computed (${Math.round((1 - s.processed / Math.max(1, s.total)) * 100)}% reused)`;

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await page.evaluate(async (m) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId: m });
  }, MODEL);
  await page.waitForFunction(
    () => window.__llm_store?.().getState().status.serverRunning === true,
    undefined,
    { timeout: 300_000 },
  );
  await page.evaluate(async (m) => {
    await window.piDesktop.invoke('pi:restart', {});
    await window.piDesktop.invoke('pi:set-model', { provider: 'llamacpp', modelId: m });
  }, MODEL);
  // Let the model-load warm-up finish, so what follows measures REUSE and not a
  // race with the thing that exists to make reuse possible.
  await page.waitForTimeout(20_000);

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
    return { ms: Date.now() - t0, slots: await slots() };
  };

  const first = await ask('hi');
  console.log(`  first message in a fresh chat   ${first.ms}ms   ${fmt(first.slots)}`);

  /*
   * WATCH THE SLOT WHILE NOBODY IS TYPING.
   *
   * The user was idle for an hour with the app in the background and then paid a
   * full prefill. With ONE slot on the server, anything the app does in the
   * background with a different prompt overwrites the conversation's KV — so the
   * question is not "does time pass" but "does something else use the slot".
   * This samples it and reports every change.
   */
  const idleMs = Number(process.env.IDLE_MS ?? 60_000);
  console.log(`\n  idling ${Math.round(idleMs / 1000)}s, watching the slot…`);
  let last = await slots();
  let changes = 0;
  const until = Date.now() + idleMs;
  while (Date.now() < until) {
    await page.waitForTimeout(2000);
    const now = await slots();
    if (
      now !== null &&
      last !== null &&
      (now.total !== last.total || now.processed !== last.processed)
    ) {
      changes += 1;
      console.log(
        `    +${Math.round((Date.now() - (until - idleMs)) / 1000)}s  slot changed → ${fmt(now)}`,
      );
      last = now;
    }
  }
  console.log(`  the slot was touched ${changes} time(s) while idle\n`);

  const second = await ask('hi again');
  console.log(`  follow-up in the SAME chat      ${second.ms}ms   ${fmt(second.slots)}`);

  // ── A NEW CHAT. The case the user hit.
  await page.click('[data-testid="new-chat"]');
  await page.waitForTimeout(2500);
  const fresh = await ask('hi');
  console.log(`  first message in a NEW chat     ${fresh.ms}ms   ${fmt(fresh.slots)}`);

  console.log('');
  check(
    second.slots !== null && second.slots.processed < 200,
    `a follow-up AFTER IDLE reuses the prefix (${fmt(second.slots)})`,
  );
  check(changes === 0, `nothing used the slot while idle (${changes} change(s))`);
  /*
   * THE ONE THAT MATTERS. A new chat's prefix is [system][tools] — byte for byte
   * what the model-load warm-up already made resident. If it is recomputing
   * thousands of tokens, something is REBUILDING the system prompt per session,
   * and every new chat pays a full cold prefill.
   */
  check(
    fresh.slots !== null && fresh.slots.processed < 500,
    `a NEW CHAT reuses the warmed prefix (${fmt(fresh.slots)})`,
  );
} finally {
  await finish();
}
