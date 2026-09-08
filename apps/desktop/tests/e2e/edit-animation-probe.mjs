/**
 * AN EDIT ANIMATES AS AN EDIT, NOT AS A DIFF BEING WRITTEN.
 *
 * the user: "Editing a file shouldn't show the diff being written in real time it
 * should show that file and then the text as the negative part of the diff is
 * written being deleted (forward delete I suppose, but still deleting live just
 * like there's a live writing animation) and then of course the replace part
 * writing animation same as when it's writing just in the file wherever it is.
 * this should ideally be a smooth line deleting and then typing occuring again
 * starting right where the delete ended."
 *
 * This drives the REAL app and looks:
 *
 *   BEFORE  the old shape, reproduced by pushing exactly what the old routing
 *           pushed at the canvas — a growing `diff` on the tab. Two frames: the
 *           deletions arriving, then the additions arriving under them. That is
 *           the diff being written in real time, which is the complaint.
 *
 *   AFTER   the real pi stream: an `edit` tool call whose arguments stream and
 *           then complete, against a file that exists on disk. Frames are
 *           captured at the moment the surface reports it is DELETING and again
 *           while it is TYPING, plus a full in-page trace of the buffer so the
 *           motion can be read as one continuous line rather than believed.
 *
 * It also checks the cases that are easy to get wrong: an edit far off screen
 * (brought into view), a huge replacement (capped, still lands), and
 * `prefers-reduced-motion` (straight to the final state, no motion at all).
 *
 * Invisible (harness.mjs), which also fails the run if anything takes the
 * screen. Run `pnpm build` first.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const PANEL = '[data-testid="canvas-tabs-panel"]';
const TAG = 'editanim';

/** A believable source file, and a believable edit to the middle of it. */
const OLD_BLOCK = [
  '  /** Resolve the effort level for a request. */',
  '  resolveEffort(request: Request): Effort {',
  '    if (request.hint !== undefined) return request.hint;',
  '    if (request.tokens > 8000) return "high";',
  '    if (request.tokens > 2000) return "medium";',
  '    return "low";',
  '  }',
].join('\n');

const NEW_BLOCK = [
  '  /**',
  '   * Resolve the effort level for a request.',
  '   *',
  "   * The caller's hint wins outright; otherwise the size of the prompt",
  '   * decides, on the measured thresholds rather than the guessed ones.',
  '   */',
  '  resolveEffort(request: Request): Effort {',
  '    if (request.hint !== undefined) return request.hint;',
  '    if (request.tokens > MAX_MEDIUM_TOKENS) return "high";',
  '    if (request.tokens > MAX_LOW_TOKENS) return "medium";',
  '    if (request.attachments.length > 0) return "medium";',
  '    return "low";',
  '  }',
].join('\n');

const FILE_BEFORE = [
  'import type { Effort, Request } from "./types";',
  '',
  'const MAX_LOW_TOKENS = 2000;',
  'const MAX_MEDIUM_TOKENS = 8000;',
  '',
  'export class EffortRouter {',
  OLD_BLOCK,
  '',
  '  describe(): string {',
  '    return "effort router";',
  '  }',
  '}',
  '',
].join('\n');

const FILE_AFTER = FILE_BEFORE.replace(OLD_BLOCK, NEW_BLOCK);

/**
 * A long file whose edit sits far OFF SCREEN. Near the top on purpose: a
 * streaming file parks at its end, so an edit twenty lines in is hundreds of
 * lines above the fold and the surface has to travel backwards to it.
 */
const LONG_LINES = Array.from({ length: 260 }, (_, i) => `const value${i} = ${i};`);
const DEEP_OLD = 'const value20 = 20;';
const DEEP_NEW = 'const value20 = 20_000; // brought into view';
const LONG_BEFORE = `${LONG_LINES.join('\n')}\n`;
const LONG_AFTER = LONG_BEFORE.replace(DEEP_OLD, DEEP_NEW);

const shotDir =
  process.env.SHOT_DIR ??
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../scratchpad/edit-anim');
mkdirSync(shotDir, { recursive: true });
process.env.SHOT_DIR = shotDir;

const { page, shot, check, finish, home } = await launchApp(TAG);

await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 20_000 });
await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });

const agentDir = path.join(home, '.pi', 'agent');
mkdirSync(agentDir, { recursive: true });
const filePath = path.join(agentDir, 'effort-router.ts');
const longPath = path.join(agentDir, 'long-file.ts');
// A separate file for the reduced-motion pass: the router opens a path ONCE and
// never nags a closed tab back open, so re-using a path would open nothing.
const reducedPath = path.join(agentDir, 'reduced-motion.ts');
writeFileSync(filePath, FILE_BEFORE, 'utf8');
writeFileSync(longPath, LONG_BEFORE, 'utf8');
writeFileSync(reducedPath, FILE_BEFORE, 'utf8');

/** The code buffer as the user sees it (CodeMirror lines, flattened). */
const bufferText = () =>
  page.evaluate((panel) => {
    const root = document.querySelector(panel) ?? document;
    return [...root.querySelectorAll('.cm-line')].map((l) => l.textContent ?? '').join('\n');
  }, PANEL);

/** Close only the tab this probe opened by hand (the BEFORE reproduction). The
 * chat's own tab is the single morphing "Activity" one — it is never closed,
 * it is repointed, which is the behaviour under test. */
const closeTabByKey = (key) =>
  page.evaluate((k) => {
    const c = window.__pi_canvas();
    const tab = c.getState().tabs.find((t) => t.key === k);
    if (tab) c.closeTab(tab.id);
  }, key);

// ───────────────────────────────────────────────────────────────────────────
// BEFORE — the diff being written, which is what the old routing pushed.
// ───────────────────────────────────────────────────────────────────────────
await page.evaluate(
  ([p, oldBlock]) => {
    const c = window.__pi_canvas();
    const lines = oldBlock.split('\n').map((text) => ({ kind: 'del', text }));
    c.upsertTab(`file:${p}`, {
      kind: 'file',
      key: `file:${p}`,
      title: 'effort-router.ts',
      filePath: p,
      streaming: true,
      diff: [{ path: 'effort-router.ts', lines }],
    });
  },
  [filePath, OLD_BLOCK],
);
await page.waitForSelector(`${PANEL} .pd-canvas-diff`, { timeout: 8000 });
await page.waitForTimeout(300);
await shot(`${TAG}-before-01-deletions-arriving`);

await page.evaluate(
  ([p, oldBlock, newBlock]) => {
    const c = window.__pi_canvas();
    const lines = [
      ...oldBlock.split('\n').map((text) => ({ kind: 'del', text })),
      ...newBlock
        .split('\n')
        .slice(0, 6)
        .map((text) => ({ kind: 'add', text })),
    ];
    const tab = c.getState().tabs.find((t) => t.key === `file:${p}`);
    if (tab) c.updateTab(tab.id, { diff: [{ path: 'effort-router.ts', lines }] });
  },
  [filePath, OLD_BLOCK, NEW_BLOCK],
);
await page.waitForTimeout(300);
await shot(`${TAG}-before-02-additions-arriving`);

const beforeDiffRows = await page.evaluate(
  (panel) => document.querySelector(panel)?.querySelectorAll('.pd-diff-row').length ?? 0,
  PANEL,
);
check(beforeDiffRows > 0, `BEFORE did not reproduce: no diff rows on screen (${beforeDiffRows})`);

await closeTabByKey(`file:${filePath}`);
await page.waitForTimeout(200);

// ───────────────────────────────────────────────────────────────────────────
// AFTER — the real stream, through the real routing.
// ───────────────────────────────────────────────────────────────────────────

/** Push the assistant turn carrying an `edit` call at `stage`. */
const stream = (p, oldText, newText, stage, callId = 'call_edit_1') =>
  page.evaluate(
    ([p, oldText, newText, stage, callId]) => {
      // A half-arrived argument buffer: the path closed, `old_string` still open.
      const head = JSON.stringify(oldText.slice(0, 30));
      const partial = `{"path":${JSON.stringify(p)},"old_string":${head.slice(0, -1)}`;
      const block =
        stage === 'args'
          ? { type: 'toolCall', id: callId, name: 'edit', arguments: {}, argsText: partial }
          : {
              type: 'toolCall',
              id: callId,
              name: 'edit',
              arguments: { path: p, old_string: oldText, new_string: newText },
            };
      const messages = [
        { kind: 'user', id: 'u1', text: 'tidy up resolveEffort', timestamp: 1 },
        {
          kind: 'assistant',
          id: `a-${callId}`,
          timestamp: 2,
          isStreaming: stage !== 'done',
          blocks: [block],
        },
      ];
      if (stage === 'done') {
        messages.push({
          kind: 'toolResult',
          id: `tr-${callId}`,
          assistantId: `a-${callId}`,
          toolCallId: callId,
          toolName: 'edit',
          text: 'Edited the file',
          isError: false,
          timestamp: 3,
        });
      }
      window.__pi_store().setState({ messages });
    },
    [p, oldText, newText, stage, callId],
  );

/** Sample the buffer inside the page, so the motion is a trace, not a guess. */
const startTrace = () =>
  page.evaluate((panel) => {
    window.__editTrace = [];
    clearInterval(window.__editTraceTimer);
    const t0 = performance.now();
    window.__editTraceTimer = setInterval(() => {
      const root = document.querySelector(panel) ?? document;
      const file = root.querySelector('.pd-file');
      const text = [...root.querySelectorAll('.cm-line')]
        .map((l) => l.textContent ?? '')
        .join('\n');
      window.__editTrace.push({
        t: Math.round(performance.now() - t0),
        phase: file?.getAttribute('data-edit-phase') ?? null,
        len: text.length,
        diffRows: root.querySelectorAll('.pd-diff-row').length,
      });
    }, 30);
  }, PANEL);

const stopTrace = () =>
  page.evaluate(() => {
    clearInterval(window.__editTraceTimer);
    return window.__editTrace ?? [];
  });

// 1. The arguments are still arriving: the tab must show THE FILE.
await stream(filePath, OLD_BLOCK, NEW_BLOCK, 'args');
await page.waitForSelector(`${PANEL} .pd-canvas-code .cm-content`, { timeout: 8000 });
await page.waitForFunction(
  ([panel, needle]) => (document.querySelector(panel)?.textContent ?? '').includes(needle),
  [PANEL, 'export class EffortRouter'],
  { timeout: 8000 },
);
const argsStageDiff = await page.evaluate(
  (panel) => document.querySelector(panel)?.querySelectorAll('.pd-diff-row').length ?? 0,
  PANEL,
);
check(
  argsStageDiff === 0,
  `while the edit's arguments streamed the canvas drew ${argsStageDiff} diff rows — it should be showing the FILE`,
);
await shot(`${TAG}-after-01-the-file`);

// 2. The arguments complete → the motion plays.
await startTrace();
await stream(filePath, OLD_BLOCK, NEW_BLOCK, 'complete');

// Catch the delete PART WAY THROUGH: the head of the replaced block already
// eaten, its tail still standing. That asymmetry is forward-delete, and it is
// the whole frame worth photographing.
await page
  .waitForFunction(
    ([panel, head, tail]) => {
      const root = document.querySelector(panel);
      if (root?.querySelector('.pd-file')?.getAttribute('data-edit-phase') !== 'delete') {
        return false;
      }
      const text = [...root.querySelectorAll('.cm-line')]
        .map((l) => l.textContent ?? '')
        .join('\n');
      return !text.includes(head) && text.includes(tail);
    },
    [PANEL, 'Resolve the effort level for a request. */', 'return "low";'],
    { timeout: 8000, polling: 16 },
  )
  .catch(() => check(false, 'never saw the delete part-way through (head gone, tail still there)'));
const midDeleteShot = await shot(`${TAG}-after-02-mid-delete`);
const midDeleteText = await bufferText();

// And the typing PART WAY THROUGH: the opening of the replacement in place,
// its last line not written yet.
await page
  .waitForFunction(
    ([panel, early, late]) => {
      const root = document.querySelector(panel);
      if (root?.querySelector('.pd-file')?.getAttribute('data-edit-phase') !== 'type') return false;
      const text = [...root.querySelectorAll('.cm-line')]
        .map((l) => l.textContent ?? '')
        .join('\n');
      return text.includes(early) && !text.includes(late);
    },
    [PANEL, 'Resolve the effort level for a request.', 'attachments.length'],
    { timeout: 8000, polling: 16 },
  )
  .catch(() => check(false, 'never saw the replacement part-way typed'));
const midTypeShot = await shot(`${TAG}-after-03-mid-type`);
const midTypeText = await bufferText();

// 3. The tool result lands and the tab settles on the file from disk.
writeFileSync(filePath, FILE_AFTER, 'utf8');
await stream(filePath, OLD_BLOCK, NEW_BLOCK, 'done');
await page.waitForFunction(
  (panel) =>
    document.querySelector(panel)?.querySelector('.pd-file')?.getAttribute('data-edit-phase') ===
    'done',
  PANEL,
  { timeout: 12_000 },
);
await page.waitForTimeout(250);
const trace = await stopTrace();
await shot(`${TAG}-after-04-settled`);
const settledText = await bufferText();

// ── What the frames have to say ────────────────────────────────────────────
check(
  !midDeleteText.includes('Resolve the effort level for a request. */'),
  'mid-delete frame still shows the head of the replaced block — nothing was deleted',
);
check(
  midDeleteText.includes('return "low";'),
  'mid-delete frame has already lost the TAIL of the replaced block — that is not a forward delete',
);
check(
  midDeleteText.includes('export class EffortRouter') && midDeleteText.includes('describe()'),
  'mid-delete frame lost the rest of the file — this is a diff, not an edit in the file',
);
check(
  !midDeleteText.includes('MAX_MEDIUM_TOKENS) return "high"'),
  'the replacement was already typing during the DELETE phase — the two beats ran together',
);
check(
  midTypeText.includes('The caller') || midTypeText.includes('Resolve the effort level'),
  'mid-type frame shows none of the replacement being typed in',
);
check(
  midTypeText !== settledText,
  'the mid-type frame is identical to the settled one — nothing was captured mid-motion',
);
check(
  settledText.includes('MAX_MEDIUM_TOKENS) return "high"') &&
    settledText.includes('attachments.length'),
  'the edit did not land: the settled buffer is missing the replacement',
);

const phases = [...new Set(trace.map((s) => s.phase).filter(Boolean))];
check(
  phases.includes('delete') && phases.includes('type'),
  `the trace never saw both beats: ${JSON.stringify(phases)}`,
);
check(
  trace.every((s) => s.diffRows === 0),
  'a diff was drawn at some point during the edit — the whole point is that it is not',
);

// One continuous line: the buffer shrinks through the delete and grows through
// the type, and no single sample jumps the whole hunk at once.
const deleteSamples = trace.filter((s) => s.phase === 'delete').map((s) => s.len);
const typeSamples = trace.filter((s) => s.phase === 'type').map((s) => s.len);
check(
  deleteSamples.length >= 3,
  `too few DELETE samples to call it an animation (${deleteSamples.length})`,
);
check(
  typeSamples.length >= 3,
  `too few TYPE samples to call it an animation (${typeSamples.length})`,
);
check(
  deleteSamples[deleteSamples.length - 1] < deleteSamples[0],
  `the buffer did not shrink while deleting (${deleteSamples[0]} → ${deleteSamples[deleteSamples.length - 1]})`,
);
check(
  typeSamples[typeSamples.length - 1] > typeSamples[0],
  `the buffer did not grow while typing (${typeSamples[0]} → ${typeSamples[typeSamples.length - 1]})`,
);
const biggestStep = trace
  .slice(1)
  .reduce((n, s, i) => Math.max(n, Math.abs(s.len - trace[i].len)), 0);
check(
  biggestStep < OLD_BLOCK.length,
  `a single frame moved ${biggestStep} characters — that is a cut, not a motion`,
);

console.log(
  `${TAG}: trace ${trace.length} samples · delete ${deleteSamples.length} · type ${typeSamples.length} · largest single-frame step ${biggestStep} chars`,
);

// ───────────────────────────────────────────────────────────────────────────
// An edit far off screen is brought into view before anything moves.
// ───────────────────────────────────────────────────────────────────────────
await stream(longPath, DEEP_OLD, DEEP_NEW, 'args', 'call_deep');
await page.waitForSelector(`${PANEL} .pd-canvas-code .cm-content`, { timeout: 8000 });
await page.waitForTimeout(400);
const scrollBefore = await page.evaluate(
  (panel) => document.querySelector(panel)?.querySelector('.cm-scroller')?.scrollTop ?? -1,
  PANEL,
);
await shot(`${TAG}-after-05-offscreen-before`);
await stream(longPath, DEEP_OLD, DEEP_NEW, 'complete', 'call_deep');
await page.waitForTimeout(1200);
const scrollAfter = await page.evaluate(
  (panel) => document.querySelector(panel)?.querySelector('.cm-scroller')?.scrollTop ?? -1,
  PANEL,
);
await shot(`${TAG}-after-06-offscreen-brought-into-view`);
check(
  scrollAfter < scrollBefore - 200,
  `an edit far above the fold was not brought into view (scrollTop ${scrollBefore} → ${scrollAfter})`,
);
const deepVisible = await page.evaluate(
  (panel) => (document.querySelector(panel)?.textContent ?? '').includes('value20 ='),
  PANEL,
);
check(deepVisible, 'the edit site is still not on screen after the scroll');
writeFileSync(longPath, LONG_AFTER, 'utf8');
await stream(longPath, DEEP_OLD, DEEP_NEW, 'done', 'call_deep');
await page.waitForTimeout(800);

// ───────────────────────────────────────────────────────────────────────────
// prefers-reduced-motion goes straight to the final state.
// ───────────────────────────────────────────────────────────────────────────
let reducedMotionAvailable = true;
try {
  await page.emulateMedia({ reducedMotion: 'reduce' });
} catch {
  reducedMotionAvailable = false;
}
await startTrace();
await stream(reducedPath, OLD_BLOCK, NEW_BLOCK, 'complete', 'call_reduced');
await page.waitForSelector(`${PANEL} .pd-canvas-code .cm-content`, { timeout: 8000 });
await page.waitForTimeout(900);
const reducedTrace = await stopTrace();
await shot(`${TAG}-after-07-reduced-motion`);
const reducedText = await bufferText();
if (reducedMotionAvailable) {
  check(
    reducedText.includes('MAX_MEDIUM_TOKENS) return "high"'),
    'under prefers-reduced-motion the edit did not land on the final state',
  );
  check(
    !reducedTrace.some((s) => s.phase === 'delete' || s.phase === 'type'),
    `prefers-reduced-motion still animated: ${JSON.stringify([
      ...new Set(reducedTrace.map((s) => s.phase)),
    ])}`,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
} else {
  console.log(`${TAG}: reduced-motion emulation unavailable in this host — skipped`);
}

console.log(`${TAG}: frames in ${shotDir}`);
console.log(`${TAG}: mid-delete  ${midDeleteShot}`);
console.log(`${TAG}: mid-type    ${midTypeShot}`);
if (!(await finish())) process.exitCode = 1;
