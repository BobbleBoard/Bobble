/**
 * A FILE THE CHAT NAMED OPENS — even when the path missed. The user (2026-10-08):
 * "'this file couldn't be found' (when clicking on a file that should very
 * much be there)".
 *
 * A turn seeded into the store (no model) read two files:
 *  - `/old/place/reports/summary.md`: a folder the chat no longer uses; the
 *    file is really in the chat's workspace, `reports/summary.md`. Clicking
 *    its row opens the real file (fs:locate found it by name), not a notice.
 *  - `<workspace>/later.md`: not written yet. Clicking it says so in words,
 *    then the probe writes it, and the open tab fills by itself.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/file-locate-look.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = mkdtempSync(path.join(os.tmpdir(), 'pd-locate-ws-'));
mkdirSync(path.join(ws, 'reports'), { recursive: true });
writeFileSync(
  path.join(ws, 'reports', 'summary.md'),
  '# The real summary\n\nFound where it was.\n',
);
const later = path.join(ws, 'later.md');

const read = (id, p) => ({ type: 'toolCall', id, name: 'read', arguments: { path: p } });
const result = (id, text, t) => ({
  kind: 'toolResult',
  id: `tr-${id}`,
  toolCallId: id,
  assistantId: 'a1',
  toolName: 'read',
  text,
  isError: false,
  timestamp: t,
});
const messages = [
  { kind: 'user', id: 'u1', text: 'read the summary and the later notes', timestamp: 1 },
  {
    kind: 'assistant',
    id: 'a1',
    timestamp: 2,
    blocks: [read('c1', '/old/place/reports/summary.md'), read('c2', later)],
  },
  result('c1', '# The real summary', 3),
  result('c2', '(empty)', 4),
  { kind: 'assistant', id: 'a2', timestamp: 5, blocks: [{ type: 'text', text: 'Done.' }] },
];

const { page, check, shot, finish } = await launchApp('file-locate', {
  args: ['--', '--piE2E=1'],
  env: { PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="composer-input"]',
});
const tabText = () =>
  page.evaluate(() =>
    window
      .__pi_canvas()
      .getState()
      .tabs.map((t) => ({
        key: t.key,
        text: (t.artifact?.content?.text ?? '').slice(0, 120),
        kind: t.artifact?.content?.kind ?? null,
      })),
  );
try {
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 10_000 });
  await page.evaluate(
    ({ m, ws }) => {
      window.__pi_store().setState({
        messages: m,
        extensionStatus: { harness: JSON.stringify({ workspaceRoot: ws }) },
      });
    },
    { m: messages, ws },
  );
  await sleep(800);
  await page.click('.pd-chain-summary');
  await sleep(500);
  const rows = page.locator('.pd-chain-step-open-main, .pd-chain-step-row[class*="focusable"]');
  console.log('file rows', await rows.count());

  // 1. The path that missed by a folder.
  await rows.nth(0).click();
  await sleep(1500);
  const t1 = await tabText();
  console.log('after the moved file', JSON.stringify(t1));
  check(
    t1.some(
      (t) =>
        t.key.includes(path.join('reports', 'summary.md')) && t.text.includes('The real summary'),
    ),
    'the file is opened where it really is',
  );
  check(!t1.some((t) => t.kind === 'notice'), 'no notice for a file that exists');
  const canvasOpen = await page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"]')?.getAttribute('data-open') ===
      'true',
  );
  check(canvasOpen, 'and the canvas stays open on it');
  await shot('1-found');

  // 2. A file not written yet.
  await rows.nth(1).click();
  await sleep(1200);
  const t2 = await tabText();
  const notice = t2.find((t) => t.kind === 'notice');
  console.log('before it is written', JSON.stringify(notice));
  check(
    notice !== undefined && /Not where the chat said it is/.test(notice.text),
    'it says so in words',
  );
  await shot('2-not-yet');
  writeFileSync(later, '# Later notes\n\nWritten after the click.\n');
  await sleep(3500);
  const t3 = await tabText();
  console.log('after it is written', JSON.stringify(t3));
  check(
    t3.some((t) => t.key.endsWith('later.md') && t.text.includes('Later notes')),
    'the open tab fills by itself once it lands',
  );
  await shot('3-landed');
} finally {
  await finish();
}
