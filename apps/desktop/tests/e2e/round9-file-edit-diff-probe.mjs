/**
 * Round-9's LIVE EDIT DIFF probe, re-aimed at what an edit is now.
 *
 * WHAT THIS USED TO GUARD. A str_replace edit opened the file's canvas tab and
 * drew a LIVE DIFF into it — the deletions as `−` rows and the additions as `+`
 * rows, growing as the tool's arguments streamed.
 *
 * WHY IT DOES NOT ANY MORE. The user, round 21: "Editing a file shouldn't show the
 * diff being written in real time it should show that file and then the text as
 * the negative part of the diff is written being deleted … and then of course
 * the replace part writing animation." The diff being typed out is exactly the
 * thing that was wrong with it. An edit now plays INTO the file: the replaced
 * text forward-deletes and the replacement types in behind it
 * (edit-animation-probe.mjs is the probe for that motion, in detail).
 *
 * WHAT IS LEFT, AND WHY IT IS STILL WORTH A PROBE. The diff is the FALLBACK, for
 * an edit with nowhere to play — and this probe's own fixture is exactly that
 * case, which is why it is the natural home for it: the file on disk is already
 * the POST-edit state, so the hunk's `old_string` does not occur in it and there
 * is no position to stand a caret at. The canvas must then fall back to showing
 * the hunk as a diff rather than animating a delete of text that is not there.
 *
 * It also keeps the half that never changed: FINALIZE FROM DISK. The on-disk
 * file carries a marker that is NOT in the streamed `new_string`, so a tab that
 * ends up showing it proves the authoritative re-read really happened.
 *
 * The tab is found by its `filePath`, not by a tab key: the chat drives ONE
 * morphing "Activity" tab now, so the key is not the file's. Run `pnpm build`
 * first.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');

function assert(condition, message) {
  if (!condition) throw new Error(`round9-file-edit-diff-probe failed: ${message}`);
}

assert(
  existsSync(path.join(appRoot, 'dist/index.html')) &&
    existsSync(path.join(appRoot, 'dist-electron/main.js')),
  'app is not built — run `pnpm build` first',
);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'));
const workDir = mkdtempSync(path.join(tmpdir(), 'pi-e2e-work-'));
const editPath = path.join(workDir, 'edit-diff.ts');
// The old text (removed by the edit) + the disk-only finalize marker. The on-disk
// file is the POST-edit state (what the tool would have written); its marker is
// NOT in the streamed new_string, so a finalized tab that shows it proves the
// authoritative disk re-read — and, because `OLD_LINE` is already gone from it,
// it is also the "nothing to animate into" case the fallback exists for.
const OLD_LINE = 'export const answer = 1;';
const NEW_LINE = 'export const answer = 42;';
const DISK_MARKER = 'DISK-FINALIZED-c0ffee';
writeFileSync(editPath, `${NEW_LINE}\n// ${DISK_MARKER}\n`, 'utf8');

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});

const PANEL = '[data-testid="canvas-tabs-panel"]';

/** The tab showing this file, whatever its key is (the chat drives one tab). */
const fileTab = (page) =>
  page.evaluate((p) => {
    const t = window
      .__pi_canvas()
      .getState()
      .tabs.find((t) => t.filePath === p);
    if (!t) return null;
    return {
      streaming: t.streaming === true,
      hasDiff: Array.isArray(t.diff) && t.diff.length > 0,
      hasAnim: t.editAnim !== undefined,
      diffText: (t.diff ?? []).flatMap((f) => f.lines.map((l) => `${l.kind}:${l.text}`)).join('\n'),
      text: t.artifact?.content.text ?? '',
    };
  }, editPath);

try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 8000 });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 8000 });

  // A STREAMING edit: `arguments` is empty and the raw `argsText` grows delta by
  // delta (how a tool call actually streams). A FINALIZED edit carries parsed
  // `arguments` + a tool result.
  const editMsg = ({ argsText, args, withResult }) =>
    page.evaluate(
      ({ argsText, args, withResult }) => {
        const messages = [
          { kind: 'user', id: 'u1', text: 'set the answer', timestamp: 1 },
          {
            kind: 'assistant',
            id: 'r9-edit',
            blocks: [
              {
                type: 'toolCall',
                id: 'call_r9_edit',
                name: 'str_replace',
                arguments: args ?? {},
                ...(argsText !== undefined ? { argsText } : {}),
              },
            ],
            timestamp: Date.now(),
            isStreaming: !withResult,
          },
        ];
        if (withResult) {
          messages.push({
            kind: 'toolResult',
            id: 'tr-call_r9_edit',
            toolCallId: 'call_r9_edit',
            assistantId: 'r9-edit',
            toolName: 'str_replace',
            text: 'edited file',
            isError: false,
            timestamp: Date.now(),
          });
        }
        window.__pi_store().setState({ messages });
      },
      { argsText, args, withResult },
    );

  // ── Delta 1: the arguments are still arriving ──────────────────────────────
  // Path closed, old_string closed, new_string PARTIAL. Nothing may move yet:
  // half an `old_string` would animate a delete of the wrong text. The tab shows
  // THE FILE and no diff.
  await editMsg({
    argsText: `{"path":${JSON.stringify(editPath)},"old_string":${JSON.stringify(
      OLD_LINE,
    )},"new_string":"export const answer = 4`,
  });
  await page.waitForSelector(`${PANEL} .pd-canvas-code .cm-content`, { timeout: 8000 });
  await page.waitForFunction(
    (p) =>
      (
        window
          .__pi_canvas()
          .getState()
          .tabs.find((t) => t.filePath === p)?.artifact?.content.text ?? ''
      ).length > 0,
    editPath,
    { timeout: 8000 },
  );
  const midStream = await fileTab(page);
  assert(midStream !== null, 'the edit did not open a tab on the file');
  assert(midStream.streaming === true, 'edit tab should be streaming while its args arrive');
  assert(
    !midStream.hasDiff,
    `a diff was drawn while the arguments were still arriving:\n${midStream.diffText}`,
  );
  assert(
    midStream.text.includes(NEW_LINE),
    `the tab should be showing the file itself, got:\n${midStream.text}`,
  );

  // ── Delta 2: the arguments complete ────────────────────────────────────────
  // `old_string` does not occur in this file (it is already the post-edit state),
  // so there is nowhere to play the motion — the FALLBACK diff is drawn instead.
  await editMsg({
    args: { path: editPath, old_string: OLD_LINE, new_string: NEW_LINE },
  });
  await page.waitForFunction(
    (p) => {
      const t = window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.filePath === p);
      return t !== undefined && Array.isArray(t.diff) && t.diff.length > 0;
    },
    editPath,
    { timeout: 8000 },
  );
  await page.waitForSelector(`${PANEL} .pd-canvas-tabpanel .pd-diff .pd-diff-row--del`, {
    timeout: 8000,
  });
  await page.waitForSelector(`${PANEL} .pd-canvas-tabpanel .pd-diff .pd-diff-row--add`, {
    timeout: 8000,
  });
  const fallback = await fileTab(page);
  assert(fallback.hasDiff, 'an unplaceable hunk should fall back to the diff');
  assert(!fallback.hasAnim, 'an unplaceable hunk must not be handed a motion to play');
  assert(
    fallback.diffText.includes(`del:${OLD_LINE}`),
    `the fallback diff should show the removed line, got:\n${fallback.diffText}`,
  );
  assert(
    fallback.diffText.includes(`add:${NEW_LINE}`),
    `the fallback diff should show the added line, got:\n${fallback.diffText}`,
  );

  // ── Finalize: settle from disk ─────────────────────────────────────────────
  // The diff is dropped, the tab flips to the on-disk bytes (DISK_MARKER — which
  // was never in the streamed new_string) and stops streaming.
  await editMsg({
    args: { path: editPath, old_string: OLD_LINE, new_string: NEW_LINE },
    withResult: true,
  });
  await page.waitForFunction(
    ({ p, marker }) => {
      const t = window
        .__pi_canvas()
        .getState()
        .tabs.find((t) => t.filePath === p);
      return (
        t !== undefined &&
        t.streaming !== true &&
        (t.diff === undefined || t.diff.length === 0) &&
        (t.artifact?.content.text ?? '').includes(marker)
      );
    },
    { p: editPath, marker: DISK_MARKER },
    { timeout: 8000 },
  );

  const finalized = await fileTab(page);
  assert(!finalized.hasDiff, 'the diff should be cleared once the edit finalizes');
  assert(finalized.streaming === false, 'finalized edit tab should no longer be streaming');
  assert(
    finalized.text.includes(DISK_MARKER),
    'finalize did not read the authoritative on-disk content',
  );
  // The settled surface is the file body (code), no longer the diff.
  await page.waitForSelector(`${PANEL} .pd-canvas-tabpanel .pd-canvas-code`, { timeout: 8000 });
  const diffGone = await page.evaluate(
    () =>
      document.querySelector('[data-testid="canvas-tabs-panel"] .pd-canvas-tabpanel .pd-diff') ===
      null,
  );
  assert(diffGone, 'the DiffView should be gone after the edit settles to the file');

  console.log(
    'round9-file-edit-diff-probe OK — a streaming edit showed the FILE (no diff); an unplaceable hunk fell back to the diff instead of animating into thin air; and the tab finalized from disk (diff dropped, authoritative bytes, streaming off)',
  );
} finally {
  await app.close();
}
