/**
 * "FLAGGED TO THE USER TO MY FACE."
 *
 * the user: "flagged to the user to my face right there whenever anything threatens
 * to cause a full re prefill (including model switches) at over 16k context."
 *
 * Almost everything this app does about first-token latency is about NOT
 * throwing away the KV prefix. A few things throw it away unavoidably, and the
 * worst thing the app can do at that moment is stay quiet — the user then
 * experiences it as the app randomly being slow again. This drives each of the
 * three ways a prefix can change and photographs what the app says.
 *
 *   SHOT_DIR=/tmp/rpw node apps/desktop/tests/e2e/reprefill-warning-probe.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, shotDir } = await launchApp('reprefill-warning');
const clip = async (label, box) =>
  writeFileSync(path.join(shotDir, `${label}.png`), await page.screenshot({ clip: box }));

/**
 * Put a conversation of `inputTokens` on screen, answered by `modelId`.
 *
 * Clears the thread FIRST: an empty chat is what re-establishes the baseline
 * (there is nothing to re-read), so without it each sub-case inherits the
 * previous one's idea of what the prefix used to be — which is how the first
 * run of this probe reported the instructions warning three times.
 */
const seed = async (inputTokens, modelId) => {
  // Clear first. `setMessagesExternal` drops every `harness*` status key (so a
  // stale checklist cannot leak into a new chat), which includes the published
  // prefix — so the prefix has to be set AFTER the messages, never before, or
  // the baseline is captured from an empty one and nothing is ever a change.
  await page.evaluate(() => window.__pi_store().getState().setMessagesExternal([]));
  await page.waitForTimeout(200);
  await page.evaluate(
    ([tokens, id]) => {
      window.__llm_store().setState((s) => ({
        status: {
          ...s.status,
          serverRunning: true,
          phase: 'ready',
          model: { id, displayName: id },
        },
      }));
      window
        .__pi_store()
        .getState()
        .setMessagesExternal([
          { kind: 'user', id: 'u1', text: 'a long conversation', timestamp: 1 },
          {
            kind: 'assistant',
            id: 'a1',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'a long answer' }],
            usage: { input: tokens, output: 100, totalTokens: tokens + 100 },
          },
        ]);
      window.__pi_store().setState((s) => ({
        extensionStatus: {
          ...s.extensionStatus,
          'harness-prefill-system': 'You are a helpful assistant.',
          'harness-prefill-tools': JSON.stringify([{ name: 'bash' }, { name: 'read' }]),
        },
      }));
    },
    [inputTokens, modelId],
  );
  // One beat for the baseline to settle on THIS prefix before anything moves.
  await page.waitForTimeout(500);
};

const pill = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="composer-pill"]');
    return el === null
      ? null
      : {
          text: el.querySelector('[data-testid="composer-pill-text"]')?.textContent ?? '',
          tone: el.getAttribute('data-tone'),
          kind: el.getAttribute('data-kind'),
          box: (() => {
            const b = el.getBoundingClientRect();
            return {
              x: Math.round(b.x) - 40,
              y: Math.round(b.y) - 20,
              width: Math.round(b.width) + 80,
              height: Math.round(b.height) + 60,
            };
          })(),
        };
  });

const setPrefix = (patch) =>
  page.evaluate((p) => {
    if (p.modelId !== undefined) {
      window.__llm_store().setState((s) => ({
        status: { ...s.status, model: { id: p.modelId, displayName: p.modelId } },
      }));
    }
    if (p.system !== undefined || p.toolsJson !== undefined) {
      window.__pi_store().setState((s) => ({
        extensionStatus: {
          ...s.extensionStatus,
          ...(p.system !== undefined ? { 'harness-prefill-system': p.system } : {}),
          ...(p.toolsJson !== undefined ? { 'harness-prefill-tools': p.toolsJson } : {}),
        },
      }));
    }
  }, patch);

try {
  /* ── A SHORT conversation says nothing ────────────────────────────────── */
  await seed(4_000, 'qwen3.5-4b');
  await page.waitForTimeout(600);
  await setPrefix({ modelId: 'gemma-4-e2b' });
  await page.waitForTimeout(700);
  const quiet = await pill();
  console.log('  4k conversation, model switched:', JSON.stringify(quiet));
  check(
    quiet === null || !/[Rr]e-reading/.test(quiet.text),
    'below the threshold the app keeps quiet — a short re-read reads as thinking',
  );

  /* ── A MODEL SWITCH over the threshold speaks up ───────────────────────── */
  await seed(24_000, 'qwen3.5-4b');
  await page.waitForTimeout(600);
  await setPrefix({ modelId: 'gemma-4-e2b' });
  await page.waitForTimeout(800);
  const warned = await pill();
  console.log('  24k conversation, model switched:', JSON.stringify(warned?.text));
  check(warned !== null, 'a model switch over 16k puts something in the pill');
  check(warned?.tone === 'warn', `and it reads as a warning (tone ${warned?.tone})`);
  check(
    (warned?.text ?? '').includes('24k tokens'),
    'it says how much has to be read again, in tokens',
  );
  check((warned?.text ?? '').includes('different model'), 'and why — the cause, not just the cost');
  await shot('01-model-switch-warning');
  if (warned !== null) await clip('02-pill', warned.box);

  /* ── AN INSTRUCTION CHANGE is the same class of event ──────────────────── */
  await seed(24_000, 'qwen3.5-4b');
  await page.waitForTimeout(600);
  await setPrefix({ system: 'You are terse. Answer in one line.' });
  await page.waitForTimeout(800);
  const instr = await pill();
  console.log('  instructions changed:', JSON.stringify(instr?.text));
  check(
    (instr?.text ?? '').includes('instructions'),
    'changing the instructions warns too, and says so',
  );

  /* ── TOOLS: appended is quiet, removed is not ──────────────────────────── */
  await seed(24_000, 'qwen3.5-4b');
  await page.waitForTimeout(600);
  await setPrefix({
    toolsJson: JSON.stringify([{ name: 'bash' }, { name: 'read' }, { name: 'web_search' }]),
  });
  await page.waitForTimeout(800);
  const appended = await pill();
  console.log('  a tool appended:', JSON.stringify(appended?.text));
  check(
    appended === null || !/[Rr]e-reading/.test(appended.text),
    'an APPENDED tool is not worth interrupting for — the prompt before it is unchanged',
  );

  await seed(24_000, 'qwen3.5-4b');
  await page.waitForTimeout(600);
  await setPrefix({ toolsJson: JSON.stringify([{ name: 'read' }]) });
  await page.waitForTimeout(800);
  const removed = await pill();
  const store = await page.evaluate(() => ({
    pills: window
      .__pill()
      .getState()
      .pills.map((p) => ({ id: p.id, text: p.text.slice(0, 40) })),
    decision: window.__reprefill,
  }));
  console.log('  a tool removed:', JSON.stringify(removed?.text), JSON.stringify(store));
  check(
    (removed?.text ?? '').includes('available tools'),
    'a REMOVED tool moves everything after it, and that does warn',
  );
  await shot('03-tools-warning');
  console.log('shots in', shotDir);
} finally {
  await finish();
}
