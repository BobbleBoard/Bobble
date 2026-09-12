/**
 * THE ACTIVITY TAB COMES BACK TO THE WORK — and LOOK.
 *
 * m03 in the canvas assessment: the page in the Activity tab became `cat
 * index.html` output and never came back. This feeds the store the same turn
 * — an edit of site/index.html, then `cat site/index.html` — with the agent
 * still streaming (the terminal shows, newest wins) and then settled (the
 * page is back, rendered), and screenshots both.
 *
 *   node tests/e2e/activity-settle-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const { page, shot, check, finish, home } = await launchApp('activity-settle-look');
const project = path.join(home, 'proj');
mkdirSync(path.join(project, 'site'), { recursive: true });
const html = `<!doctype html><html><body style="font-family:system-ui;background:#1b1b1f;color:#eee;padding:24px">
<h1>Clicks: <span id="n">0</span></h1><button onclick="n.textContent=+n.textContent+1">Click me</button>
<p>the page the user was looking at</p></body></html>`;
writeFileSync(path.join(project, 'site', 'index.html'), html);

await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 30000 });
await page.waitForTimeout(500);

const feed = (settled) =>
  page.evaluate(
    ({ proj, settled }) => {
      const store = window.__pi_store();
      const now = Date.now();
      const msgs = [
        { kind: 'user', id: 'u1', text: 'change the label, dark background', timestamp: now },
        {
          kind: 'assistant',
          id: 'a1',
          blocks: [
            { type: 'toolCall', id: 'c1', name: 'edit', arguments: { path: 'site/index.html', edits: [{ oldText: 'Count', newText: 'Clicks' }] } },
          ],
          timestamp: now + 1,
          isStreaming: false,
        },
        { kind: 'toolResult', id: 'r1', toolCallId: 'c1', assistantId: 'a1', toolName: 'edit', text: 'Successfully replaced 1 block(s)', isError: false, timestamp: now + 2 },
        {
          kind: 'assistant',
          id: 'a2',
          blocks: [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'cat site/index.html' } }],
          timestamp: now + 3,
          isStreaming: false,
        },
        { kind: 'toolResult', id: 'r2', toolCallId: 'c2', assistantId: 'a2', toolName: 'bash', text: '<!doctype html>…', isError: false, timestamp: now + 4 },
      ];
      store.setState((s) => ({
        messages: msgs,
        session: { ...(s.session ?? {}), cwd: proj },
        agent: { ...s.agent, isStreaming: !settled },
      }));
    },
    { proj: project, settled },
  );

await feed(false);
await page.waitForTimeout(1200);
const during = await page.evaluate(() => {
  const t = window.__pi_canvas().getState().tabs.find((x) => x.key === 'pi:activity');
  return t ? { kind: t.kind, subtitle: t.subtitle } : null;
});
check(during?.kind === 'terminal', `while streaming the tab should be the terminal, got ${JSON.stringify(during)}`);
await shot('1-during-turn-terminal');

await feed(true);
await page.waitForTimeout(1500);
const after = await page.evaluate(() => {
  const t = window.__pi_canvas().getState().tabs.find((x) => x.key === 'pi:activity');
  const rendered = document.querySelector('[data-testid="canvas-tabs-panel"] iframe') !== null;
  return t ? { kind: t.kind, subtitle: t.subtitle, filePath: t.filePath, rendered } : null;
});
check(after?.kind === 'file', `settled, the tab should be the edited file, got ${JSON.stringify(after)}`);
check(after?.rendered === true, 'the html file should be shown RENDERED (an iframe), not as source');
await shot('2-settled-page-back');
console.log(JSON.stringify({ during, after }));
await finish();
