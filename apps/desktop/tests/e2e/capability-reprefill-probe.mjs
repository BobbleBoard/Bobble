/**
 * WHAT TURNING A CAPABILITY ON COSTS.
 *
 * the user, on a TWO-MESSAGE conversation: "there's a 10s prefill on a quick
 * follow up." The turn before it had activated a capability — the model said so
 * out loud: "I've activated the browser capability. The Chrome-specific tools
 * aren't available yet — they'll appear in my next reply."
 *
 * That sentence is the whole story if it is true: chat templates render the
 * tool schemas at the very START of the prompt, so a tool set that grows moves
 * everything behind it. The conversation is irrelevant — a two-message chat
 * re-prefills exactly as hard as a fifty-message one.
 *
 * So this measures the case directly: a normal turn, then a tool-set change
 * through the app's own seam, then a short follow-up.
 *
 *   node apps/desktop/tests/e2e/capability-reprefill-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT =
  process.env.OUT ?? path.resolve(here, '../../../..', '.corp-runs', 'capability-reprefill');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
mkdirSync(OUT, { recursive: true });

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'cap-reprefill-'))}`],
  env: {
    ...process.env,
    HOME: homedir(),
    PI_E2E: '1',
    PI_ADV_DEBUG_WARM: path.join(OUT, 'warm.log'),
    ...background.env,
  },
});

const rows = [];
try {
  const win = await app.firstWindow();
  background.restore();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 90_000 });
  await win
    .waitForFunction(
      () => window.__llm_store?.().getState().status.serverRunning === true,
      undefined,
      {
        timeout: 600_000,
      },
    )
    .catch(() => undefined);
  const status = await win.evaluate(() => window.__llm_store().getState().status);
  const port = Number(/:(\d+)\/v1/.exec(status.baseUrl ?? '')?.[1] ?? 0) || null;
  console.log(`model ${status.model?.id ?? '?'} on ${port}\n`);
  if (port === null) throw new Error('no llama-server port');

  const slot = async () => {
    try {
      const [s] = await (await fetch(`http://127.0.0.1:${port}/slots`)).json();
      return {
        busy: s.is_processing === true,
        total: s.n_prompt_tokens ?? 0,
        processed: s.n_prompt_tokens_processed ?? 0,
      };
    } catch {
      return null;
    }
  };
  const toolNames = () =>
    win.evaluate(() => {
      try {
        return JSON.parse(
          window.__pi_store().getState().extensionStatus['harness-prefill-tools'] ?? '[]',
        ).map((t) => t.name);
      } catch {
        return [];
      }
    });
  const chars = () =>
    win.evaluate(() => {
      const m = window.__pi_store().getState().messages;
      let n = 0;
      for (const row of m) {
        if (row.kind !== 'assistant') continue;
        for (const b of row.blocks ?? []) n += (b.text ?? b.thinking ?? '').length;
      }
      return n;
    });
  const idle = () =>
    win
      .waitForFunction(
        () => {
          const s = window.__pi_store().getState();
          return s.agent.isStreaming !== true && s.promptInFlight !== true;
        },
        undefined,
        { timeout: 240_000 },
      )
      .catch(() => undefined);

  /* Wait out the opening warm-up so turn 1 is a turn, not a queue. */
  {
    let sawBusy = false;
    let idleSince = Date.now();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const s = await slot();
      if (s !== null) {
        if (s.busy) {
          sawBusy = true;
          idleSince = Date.now();
        }
        if (!s.busy && Date.now() - idleSince > 3000) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log(`  (opening warm-up ${sawBusy ? 'settled' : 'never seen'})\n`);
  }

  const send = async (label, message, note) => {
    const before = await chars();
    await win.click('[data-testid="composer-input"]');
    await win.keyboard.type(message);
    await win.waitForTimeout(Number(process.env.SETTLE_MS ?? '1500'));
    const samples = [];
    let watching = true;
    const poll = (async () => {
      let last = '';
      while (watching) {
        const s = await slot();
        if (s !== null && s.total > 0) {
          const key = `${s.total}|${s.processed}`;
          if (key !== last) {
            last = key;
            samples.push({ at: Date.now(), ...s });
          }
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const sentAt = Date.now();
    await win.keyboard.press('Enter');
    let ttft = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if ((await chars()) > before) {
        ttft = Date.now() - sentAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    watching = false;
    await poll;
    const mine = samples.filter((s) => s.at >= sentAt);
    const turn = mine.reduce(
      (a, b) => (b.total > (a?.total ?? -1) || b.processed > (a?.processed ?? -1) ? b : a),
      null,
    );
    await idle();
    const reused = turn === null ? null : turn.total - turn.processed;
    rows.push({
      label,
      note,
      ttft,
      total: turn?.total ?? null,
      processed: turn?.processed ?? null,
      reused,
    });
    console.log(
      `  ${label.padEnd(22)} ${String(ttft ?? '?').padStart(7)}ms   read ` +
        `${String(turn?.processed ?? '?').padStart(6)} of ${String(turn?.total ?? '?').padStart(6)}` +
        `  (reused ${String(reused ?? '?').padStart(6)})${note ? `  ${note}` : ''}`,
    );
    return rows.at(-1);
  };

  const before = await toolNames();
  console.log(`  tools advertised: ${before.length}\n`);
  await send('turn-1', 'Name three colours, one word each.');
  await send('follow-up', 'And three fruits.', 'no tool change');

  /*
   * NOW CHANGE THE TOOL SET, through the app's own seam — the same thing a
   * capability activation does. `coding` adds the file tools to whatever is
   * already advertised.
   */
  console.log('\n  …turning on a capability (preset change)…');
  await win.evaluate(() =>
    window.piDesktop.invoke('pi:prompt', { message: '/harness preset coding' }),
  );
  await win.waitForTimeout(4000);
  await idle();
  const after = await toolNames();
  const added = after.filter((t) => !before.includes(t));
  console.log(
    `  tools advertised: ${after.length}${added.length > 0 ? ` (+${added.join(',')})` : ' (unchanged)'}\n`,
  );

  await send('after-capability', 'And three metals.', 'right after the tool set changed');
  await send('one-more', 'And three rivers.', 'the turn after that');

  console.log('\n──────── what a tool-set change costs ────────');
  const plain = rows.find((r) => r.label === 'follow-up');
  const after1 = rows.find((r) => r.label === 'after-capability');
  const after2 = rows.find((r) => r.label === 'one-more');
  if (plain && after1) {
    console.log(`  a plain follow-up read ${plain.processed} tokens in ${plain.ttft}ms`);
    console.log(`  the one after the change read ${after1.processed} in ${after1.ttft}ms`);
    console.log(`  and the next one read ${after2?.processed ?? '?'} in ${after2?.ttft ?? '?'}ms`);
    const hurt = (after1.processed ?? 0) > (plain.processed ?? 0) * 10;
    console.log(
      hurt
        ? '\n  TURNING A CAPABILITY ON RE-READS THE WHOLE PROMPT. Tools render at the\n' +
            '  start, so a set that grows moves everything behind it — the length of the\n' +
            '  conversation has nothing to do with it.'
        : '\n  OK: a tool-set change did not cost the prefix.',
    );
    if (hurt) process.exitCode = 1;
  }
  writeFileSync(
    path.join(OUT, 'capability.json'),
    JSON.stringify({ before, after, rows }, null, 2),
  );
} catch (err) {
  console.error(`capability-reprefill-probe: ${err.message}\n${err.stack}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
}
