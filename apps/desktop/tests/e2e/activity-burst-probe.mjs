/**
 * THE ACTIVITY TAB UNDER A BURST — the renderer-crash reproduction.
 *
 * SEEN twice in the canvas assessment (deliverables/canvas-assessment.md): a
 * small model looping through ~12 bash calls in a few seconds, the Activity
 * terminal tab taking each result, then four
 *   TypeError: Cannot read properties of undefined (reading 'dimensions')
 * and "Minified React error #185" — the whole renderer gone behind the error
 * boundary.
 *
 * Driving the canvas controller alone with the same growth and morphs did not
 * reproduce it (120 updates, three kind changes, zero errors). The real path is
 * the pi MESSAGE STREAM: every tool call and result lands in the pi store, the
 * activity-routing effect derives the tab from it, and the thread renders the
 * same chain beside it. So this feeds that store the way the harness does —
 * an assistant message per call, a tool result per call, at burst speed — with
 * the same shapes the crash turns had: heredoc python loops, a `read` of a
 * .docx that comes back as zip bytes.
 *
 *   node tests/e2e/activity-burst-probe.mjs            # prints PASS / CRASH
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const CALLS = Number(process.env.CALLS ?? 40);
const GAP_MS = Number(process.env.GAP_MS ?? 60);
const home = probeHome('activity-burst');
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'activity-burst-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, HOME: home, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const errors = [];
let verdict = 'PASS';
try {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(`[pageerror] ${String(e.stack ?? e).slice(0, 1200)}`));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 1200)}`);
  });
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 30000 });
  await win.waitForTimeout(1000);

  const result = await win.evaluate(
    async ({ calls, gap }) => {
      const store = window.__pi_store();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const now = () => Date.now();
      let n = 0;
      const push = (msg) => store.setState((s) => ({ messages: [...s.messages, msg] }));
      const upsertAssistant = (id, blocks, streaming) =>
        store.setState((s) => {
          const i = s.messages.findIndex((m) => m.id === id);
          const msg = { kind: 'assistant', id, blocks, timestamp: now(), isStreaming: streaming };
          if (i === -1) return { messages: [...s.messages, msg] };
          const next = s.messages.slice();
          next[i] = msg;
          return { messages: next };
        });

      push({
        kind: 'user',
        id: `u${++n}`,
        text: 'Open ./docs/pitch.pptx and add a third slide.',
        timestamp: now(),
      });
      await sleep(gap);

      // Zip bytes, as `read` returns them for a .docx: the PK header, then
      // control characters and high bytes.
      const bytes = [];
      for (let i = 0; i < 3000; i++)
        bytes.push(String.fromCharCode(i % 7 === 0 ? 80 : i % 5 === 0 ? 3 : 128 + (i % 120)));
      const zipBytes = bytes.join('');

      for (let i = 0; i < calls; i++) {
        const aid = `a${++n}`;
        const callId = `call_${i}`;
        const isRead = i % 9 === 4;
        const call = isRead
          ? {
              type: 'toolCall',
              id: callId,
              name: 'read',
              arguments: { path: './docs/kitchen-sink.docx' },
            }
          : {
              type: 'toolCall',
              id: callId,
              name: 'bash',
              arguments: {
                command:
                  "python3 << 'EOF'\nfrom pptx import Presentation\nprs = Presentation('./docs/pitch.pptx')\nprint(len(prs.slides))\nEOF",
              },
            };
        upsertAssistant(aid, [{ type: 'thinking', thinking: `Let me try again (${i}).` }], true);
        await sleep(gap / 3);
        upsertAssistant(
          aid,
          [{ type: 'thinking', thinking: `Let me try again (${i}).` }, call],
          true,
        );
        await sleep(gap / 3);
        push({
          kind: 'toolResult',
          id: `tr-${aid}-${callId}`,
          toolCallId: callId,
          assistantId: aid,
          toolName: isRead ? 'read' : 'bash',
          text: isRead
            ? `/tmp/canvas-assess/project/docs/kitchen-sink.docx\n${zipBytes}`
            : 'Traceback (most recent call last):\n  File "<stdin>", line 1, in <module>\nModuleNotFoundError: No module named \'pptx\'\n\n\nCommand exited with code 1',
          isError: !isRead,
          timestamp: now(),
        });
        upsertAssistant(
          aid,
          [{ type: 'thinking', thinking: `Let me try again (${i}).` }, call],
          false,
        );
        await sleep(gap / 3);
      }
      await sleep(400);
      /*
       * PHASE 2 — dispose under load. A chat switch or a new chat resets the
       * whole canvas (`controller.reset()`), which disposes the Activity tab's
       * xterm; done while xterm still has frames queued, its own rAF callbacks
       * run against a disposed renderer. That is the exact shape of the
       * "reading 'dimensions'" page errors that preceded both crashes.
       */
      const ctl = window.__pi_canvas();
      for (let k = 0; k < 6; k++) {
        const id = ctl.upsertTab('pi:activity', {
          kind: 'terminal',
          key: 'pi:activity',
          title: 'Activity',
          data: { mirror: true, mirrorText: '' },
        });
        let t = '';
        for (let i = 0; i < 30; i++) {
          t += `$ cmd ${k}-${i}\n` + 'x'.repeat(200) + '\n';
          ctl.updateTab(id, { data: { mirror: true, mirrorText: t } });
        }
        // No await: reset in the same tick the writes were queued.
        ctl.reset();
        await sleep(60);
      }
      await sleep(400);
      const c = window.__pi_canvas().getState();
      return { messages: store.getState().messages.length, tabs: c.tabs.map((t) => t.kind) };
    },
    { calls: CALLS, gap: GAP_MS },
  );
  await win.waitForTimeout(2000);
  const boundary = await win
    .evaluate(() => document.body.innerText.includes('rendering error'))
    .catch(() => true);
  if (boundary || errors.some((e) => /#185|Maximum update depth|dimensions/.test(e)))
    verdict = 'CRASH';
  console.log(JSON.stringify({ ...result, boundary, errors: errors.length }));
  if (verdict === 'CRASH')
    await win.screenshot({ path: '/tmp/activity-burst-crash.png' }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}
for (const e of errors.slice(0, 5)) console.log(e);
console.log(verdict);
process.exit(verdict === 'PASS' ? 0 : 1);
