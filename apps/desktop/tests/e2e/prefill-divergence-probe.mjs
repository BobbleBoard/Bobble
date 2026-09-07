/**
 * WHERE THE PRIMED PROMPT AND THE REAL TURN PART COMPANY.
 *
 * Predictive prefill only pays if the prime is a BYTE-EXACT PREFIX of the turn.
 * The exactness probe measures whether it pays; this one says why not, by
 * rendering both prompts through the server's own `/apply-template` and printing
 * the first character where they differ. Everything it needs comes from the
 * harness's published prefill context plus `harness-prefill-lastuser` — the
 * exact string pi sent when PI_ADV_DEBUG_PREFILL=1 (optional — the prefix is
 * reconstructed from the composer's own rules when it is absent).
 *
 *   node apps/desktop/tests/e2e/prefill-divergence-probe.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch } from './_focus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT =
  process.env.OUT ?? path.resolve(here, '../../../..', '.corp-runs', 'prefill-divergence');
const APP = process.env.APP ?? '/Applications/Bobble.app/Contents/MacOS/Bobble';
mkdirSync(OUT, { recursive: true });

const TYPED = 'In one short sentence, what is this about?';
/* Small on purpose — this probe is about STRINGS, not seconds. */
const BLOB = Array.from(
  { length: 90 },
  (_, i) => `Paragraph ${i}: the quantity surveyor logged an unusual reading on the west manifold.`,
).join('\n');

const background = backgroundLaunch();
const app = await electron.launch({
  executablePath: APP,
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'prefill-div-'))}`],
  env: {
    ...process.env,
    HOME: homedir(),
    PI_E2E: '1',
    PI_ADV_DEBUG_PREFILL: '1',
    /* Why a warm-up did or did not happen — the other thing that can put a
     * prompt on this slot while the composer is priming. */
    PI_ADV_DEBUG_WARM: path.join(OUT, 'warm.log'),
    ...background.env,
  },
});

const failures = [];
const check = (cond, msg) => {
  if (cond) console.log(`  OK: ${msg}`);
  else {
    failures.push(msg);
    console.error(`  FAILED: ${msg}`);
    process.exitCode = 1;
  }
  return cond;
};

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
  const root = `http://127.0.0.1:${port}`;

  const tokenize = async (content) => {
    const res = await fetch(`${root}/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, with_pieces: true }),
    });
    const j = await res.json();
    return Array.isArray(j.tokens) ? j.tokens : [];
  };
  const slot = async () => {
    try {
      const [x] = await (await fetch(`${root}/slots`)).json();
      return {
        busy: x.is_processing === true,
        total: x.n_prompt_tokens ?? 0,
        processed: x.n_prompt_tokens_processed ?? 0,
      };
    } catch {
      return null;
    }
  };
  /** Prime `text` into the slot and report how much of it the server had to read. */
  const probePrefix = async (text) => {
    const res = await fetch(`${root}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text, cache_prompt: true, stream: false, n_predict: 1 }),
    });
    const j = await res.json();
    return Number(j?.timings?.prompt_n ?? -1);
  };

  const ctxOf = () =>
    win.evaluate(() => {
      const st = window.__pi_store().getState().extensionStatus;
      return {
        system: st['harness-prefill-system'] ?? null,
        toolsJson: st['harness-prefill-tools'] ?? null,
        lastUser: st['harness-prefill-lastuser'] ?? null,
      };
    });

  /* ── 1. Attach, and let the app's own prime run to completion ───────────── */
  await win.evaluate((t) => {
    const el = document.querySelector('[data-testid="composer-input"]');
    el?.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, BLOB);
  {
    /*
     * WAIT FOR EVERY PRIME, not the first one. The app can put more than one
     * request on the slot around a paste (a warm-up finishing, the attachment
     * prime, a re-prime on focus), and stopping at the first busy→idle edge
     * reads whichever happened to be first — which is how a correct prime can
     * look wrong, or a wrong one look right.
     */
    let sawBusy = false;
    let periods = 0;
    let wasBusy = false;
    let idleSince = Date.now();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const x = await slot();
      if (x !== null) {
        if (x.busy) {
          if (!wasBusy) periods += 1;
          sawBusy = true;
          idleSince = Date.now();
        } else if (wasBusy) idleSince = Date.now();
        wasBusy = x.busy;
      }
      if (sawBusy && !wasBusy && Date.now() - idleSince > 2500) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    console.log(`  (the slot was busy ${periods} time(s) after the paste)`);
    check(sawBusy, 'the app primed the attachment in the background');
  }

  const plog = await win.evaluate(() => window.__prefill_log ?? null);
  console.log(`  what the composer's prefill did: ${JSON.stringify(plog)}`);

  const before = await ctxOf();
  check(
    typeof before.system === 'string' && before.system.length > 0,
    'the harness published a system prompt',
  );
  const tools = JSON.parse(before.toolsJson ?? '[]').map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const render = async (messages, addGen, thinking) => {
    const res = await fetch(`${root}/apply-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        add_generation_prompt: addGen,
        chat_template_kwargs: { enable_thinking: thinking },
        ...(tools.length > 0 ? { tools } : {}),
      }),
    });
    const j = await res.json();
    return typeof j.prompt === 'string' ? j.prompt : '';
  };

  /*
   * ── 2. IS THE SLOT HOLDING WHAT WE THINK IT IS? ────────────────────────
   *
   * Re-render the prime's own prompt and prime it again immediately. If the
   * app primed this exact string, the server has nothing left to read and says
   * so. Anything else means the app primed something different — which is the
   * only way a completed prime can fail to help the turn that follows.
   */
  const prefix = `Attached file \`pasted content\`:\n\`\`\`\n${BLOB}\n\`\`\``;
  const full = await render(
    [
      { role: 'system', content: before.system },
      { role: 'user', content: prefix },
    ],
    false,
    false,
  );
  const at = full.lastIndexOf(prefix);
  const primed = at >= 0 ? full.slice(0, at + prefix.length) : full;
  const primedTokens = (await tokenize(primed)).length;
  const rereadPrime = await probePrefix(primed);
  console.log(`\n  the prime's prompt is ${primedTokens} tokens`);
  console.log(`  re-priming it right after the app's own prime re-read ${rereadPrime}`);
  /*
   * Never exactly zero: llama.cpp always decodes at least the final token of a
   * prompt, and a few more can fall out of where the last cached batch ended. A
   * dozen out of eleven thousand means it was still there; hundreds means the
   * prefix was overwritten by something else between the prime and this read.
   */
  check(
    rereadPrime >= 0 && rereadPrime <= 16,
    `the app's prime is still in the slot (${rereadPrime} of ${primedTokens} tokens re-read)`,
  );

  /* ── 3. Now send, and watch what the TURN itself has to read ────────────── */
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type(TYPED);
  const samples = [];
  let watching = true;
  const poll = (async () => {
    let last = '';
    while (watching) {
      const x = await slot();
      if (x !== null && x.total > 0) {
        const key = `${x.total}|${x.processed}`;
        if (key !== last) {
          last = key;
          samples.push({ at: Date.now(), ...x });
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  const sentAt = Date.now();
  await win.keyboard.press('Enter');
  await win
    .waitForFunction(
      () => {
        const st = window.__pi_store().getState();
        if (st.messages.length < 2) return false;
        for (const row of st.messages) {
          if (row.kind !== 'assistant') continue;
          for (const b of row.blocks ?? [])
            if ((b.text ?? b.thinking ?? '').length > 0) return true;
        }
        return false;
      },
      undefined,
      { timeout: 180_000 },
    )
    .catch(() => undefined);
  const ttft = Date.now() - sentAt;
  watching = false;
  await poll;
  const turnSample = samples
    .filter((x) => x.at >= sentAt)
    .reduce(
      (a, b) => (b.total > (a?.total ?? -1) || b.processed > (a?.processed ?? -1) ? b : a),
      null,
    );
  console.log(
    `\n  the turn: ${ttft}ms to first token, processed ${turnSample?.processed ?? '?'} of ${turnSample?.total ?? '?'}`,
  );

  const after = await ctxOf();
  if (typeof after.lastUser === 'string') {
    console.log(
      `  the message pi sent: ${after.lastUser.length} chars, starts ${JSON.stringify(after.lastUser.slice(0, 90))}`,
    );
    check(after.lastUser.startsWith(prefix), 'the sent message begins with the primed attachment');
  }
  check(
    turnSample !== null && turnSample.processed <= turnSample.total - primedTokens + 4,
    `the turn reused the whole primed prefix (read ${turnSample?.processed ?? '?'} of ${turnSample?.total ?? '?'}, ` +
      `so it kept ${(turnSample?.total ?? 0) - (turnSample?.processed ?? 0)} of ${primedTokens} primed)`,
  );

  writeFileSync(
    path.join(OUT, 'divergence.json'),
    JSON.stringify({ primedTokens, rereadPrime, ttft, turn: turnSample }, null, 2),
  );
  writeFileSync(path.join(OUT, 'primed.txt'), primed);
} catch (err) {
  console.error(`prefill-divergence-probe: ${err.message}\n${err.stack}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
}

console.log(
  failures.length === 0
    ? '\nprefill-divergence-probe OK'
    : `\nprefill-divergence-probe: ${failures.length} failure(s)`,
);
