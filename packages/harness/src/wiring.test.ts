/**
 * Round-9 wiring tests: the repair ladder + effort knobs actually drive runtime
 * behavior.
 *
 * These drive the harness's live repair deps through the provider's REAL
 * `repairToolCallArguments` (the same seam production uses), and exercise the
 * effort-gated reviewer pass — so they prove the bridge, not just the library.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
  ToolInfo,
} from '@mariozechner/pi-coding-agent';
import { repairToolCallArguments } from '@pi-desktop/provider-llamacpp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HARNESS_CONFIG_ENTRY,
  HARNESS_LOOP_ENTRY,
  HARNESS_REVIEW_ENTRY,
  HARNESS_VERIFY_ENTRY,
  type HarnessStage,
  type ProjectCheck,
  type StoredEntryLike,
  SUBAGENT_DEPTH_ENV,
  type VerifyBashRunner,
  wireHarness,
} from './index.js';
import { DEFAULT_REPEAT_STEER_AFTER } from './loop/loop-detector.js';
import type { CallModel } from './model-call/call-model.js';
import type { ToolSchemaLike } from './repair/rungs.js';

const SCHEMA: ToolSchemaLike = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};

// biome-ignore lint/suspicious/noExplicitAny: event handler shape varies per event.
type AnyHandler = (event: any, ctx: any) => any;

function makeRig(
  opts: {
    effort?: string;
    mode?: string;
    preset?: string;
    callModel?: CallModel;
    verify?: {
      runBash?: VerifyBashRunner;
      detectCheck?: (cwd: string) => ProjectCheck | null;
    };
    cwd?: string;
  } = {},
) {
  const handlers = new Map<string, AnyHandler[]>();
  const entries: StoredEntryLike[] = [];
  if (opts.effort !== undefined || opts.mode !== undefined || opts.preset !== undefined) {
    entries.push({
      type: 'custom',
      customType: HARNESS_CONFIG_ENTRY,
      data: {
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        ...(opts.preset !== undefined ? { preset: opts.preset } : {}),
      },
    });
  }
  let activeTools: string[] = [];
  const sentUserMessages: string[] = [];
  const steerMessages: string[] = [];

  const pi = {
    on: (event: string, h: AnyHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(h);
      handlers.set(event, list);
    },
    registerTool: (_def: ToolDefinition) => {},
    registerCommand: () => {},
    getAllTools: (): ToolInfo[] =>
      ['read', 'bash', 'tool_search', 'web_search', 'web_fetch'].map((name) => ({
        name,
        description: `${name} tool`,
        // biome-ignore lint/suspicious/noExplicitAny: stub schema.
        parameters: {} as any,
        sourceInfo: {
          path: `<t:${name}>`,
          source: 'builtin',
          scope: 'temporary',
          origin: 'top-level',
        },
      })),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: 'custom', customType, data });
    },
    sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      sentUserMessages.push(text);
      if (options?.deliverAs === 'steer') steerMessages.push(text);
    },
  } as unknown as ExtensionAPI;

  const abort = vi.fn();
  const notify = vi.fn();
  const confirm = vi.fn(async () => true);
  const setStatus = vi.fn();
  const ctx = {
    hasUI: true,
    cwd: opts.cwd ?? '/workdir',
    ui: { notify, confirm, setStatus },
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
    sessionManager: { getEntries: () => entries },
    abort,
  } as unknown as ExtensionContext & ExtensionCommandContext;

  /** Every `stage` value published on the 'harness' status channel, in order. */
  const publishedStages = (): HarnessStage[] => {
    const out: HarnessStage[] = [];
    for (const call of setStatus.mock.calls) {
      if (call[0] !== 'harness' || typeof call[1] !== 'string') continue;
      try {
        const s = (JSON.parse(call[1]) as { stage?: HarnessStage }).stage;
        if (s !== undefined) out.push(s);
      } catch {
        /* ignore */
      }
    }
    return out;
  };

  const handle = wireHarness(pi, {
    ...(opts.callModel !== undefined ? { callModel: opts.callModel } : {}),
    ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
  });
  const fire = (event: string, e: unknown) =>
    Promise.all((handlers.get(event) ?? []).map((h) => h(e, ctx)));
  return {
    pi,
    entries,
    ctx,
    handle,
    fire,
    activeTools: () => activeTools,
    sentUserMessages,
    steerMessages,
    publishedStages,
    setStatus,
    abort,
    notify,
    confirm,
  };
}

/** Fire a full classify turn so the loop detector + activeClass are initialized. */
async function startTurn(rig: ReturnType<typeof makeRig>, prompt = 'do a thing') {
  await rig.fire('before_agent_start', {
    type: 'before_agent_start',
    prompt,
    systemPrompt: 'sys',
    images: [],
  });
}

async function startSession(rig: ReturnType<typeof makeRig>) {
  await rig.fire('session_start', { type: 'session_start', reason: 'startup' });
}

describe('repair ladder — live wiring through the provider', () => {
  it('rung 2 fixer runs (via callModel) on a schema-valid-but-wrong tool call', async () => {
    const callModel: CallModel = vi.fn(async () => '{"path":"/fixed-by-model"}');
    const rig = makeRig({ effort: 'medium', callModel });
    await startSession(rig);

    const deps = rig.handle.buildRepairDeps();
    const result = await repairToolCallArguments('{"wrong":1}', {
      toolName: 'read',
      schema: SCHEMA,
      fixer: deps.fixer,
      extraRungs: deps.extraRungs,
    });

    // Parseable but schema-invalid → entered the ladder → rung 2 fixer fixed it.
    expect(callModel).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.rung).toBe(2);
    expect(result.value).toEqual({ path: '/fixed-by-model' });
  });

  it('rung 5 aborts at the effort abortThreshold and onRepair populates repairFailures', async () => {
    // effort low → abortThreshold 2. No callModel → no fixer → ladder falls to 3–5.
    const rig = makeRig({ effort: 'low' });
    await startSession(rig);
    const deps = rig.handle.buildRepairDeps();

    const run = () =>
      repairToolCallArguments('total garbage {{{', {
        toolName: 'bash',
        schema: SCHEMA,
        extraRungs: deps.extraRungs,
      }).then((r) => deps.onRepair?.({ toolName: 'bash', rung: r.rung, ok: r.ok }));

    await run(); // failure count → 1 (< 2): no abort
    expect(rig.abort).not.toHaveBeenCalled();
    await run(); // failure count → 2 (== threshold): abort fires
    expect(rig.abort).toHaveBeenCalledOnce();

    // onRepair appended ok:false entries → repairFailures is populated.
    const status = rig.handle.getStatus(rig.ctx);
    expect(status.repairFailures.bash).toBe(2);
  });

  it('higher effort raises the abort threshold (does not abort where low would)', async () => {
    const rig = makeRig({ effort: 'high' }); // abortThreshold 4
    await startSession(rig);
    const deps = rig.handle.buildRepairDeps();
    for (let i = 0; i < 2; i++) {
      await repairToolCallArguments('garbage {{{', {
        toolName: 'bash',
        schema: SCHEMA,
        extraRungs: deps.extraRungs,
      });
    }
    expect(rig.abort).not.toHaveBeenCalled(); // 2 < 4
  });
});

describe('effort-gated reviewer pass', () => {
  const badReview: CallModel = vi.fn(async () => '{"ok":false,"issues":["missing edge case"]}');

  it('effort=low does NOT review (no model call, no revision)', async () => {
    const callModel = vi.fn(badReview);
    const rig = makeRig({ effort: 'low', callModel });
    await startSession(rig);
    const triggered = await rig.handle.reviewTurn('some result', rig.ctx);
    expect(triggered).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
    expect(rig.sentUserMessages).toHaveLength(0);
  });

  it('a REQUESTED review catches the bad result and triggers a revision', async () => {
    const callModel = vi.fn(badReview);
    const rig = makeRig({ effort: 'high', callModel });
    await startSession(rig);
    // Explicitly requested — no effort level forces a review any more, but the
    // machinery must still work when someone asks for it.
    const triggered = await rig.handle.reviewTurn('some result', rig.ctx, undefined, {
      passes: 2,
      adversarial: true,
    });
    expect(triggered).toBe(true);
    expect(callModel).toHaveBeenCalled();
    expect(rig.sentUserMessages).toHaveLength(1);
    const steer = (rig.sentUserMessages[0] ?? '').toLowerCase();
    // The steer carries the concrete issue to fix…
    expect(steer).toContain('missing edge case');
    // …and tells the model to keep it private (item 5)…
    expect(steer).toContain('internal');
    // …with NONE of the harness-internal vocabulary the model was parroting.
    expect(steer).not.toContain('reviewer');
    expect(steer).not.toContain('harness');
    const review = rig.entries.find((e) => e.customType === HARNESS_REVIEW_ENTRY);
    expect(review?.data).toMatchObject({ flagged: true });
  });

  it('does not review the revision turn it triggered (no infinite loop)', async () => {
    const callModel = vi.fn(badReview);
    const rig = makeRig({ effort: 'high', callModel });
    await startSession(rig);
    await rig.handle.reviewTurn('first result', rig.ctx); // triggers revision + suppresses next
    callModel.mockClear();
    const again = await rig.handle.reviewTurn('revision result', rig.ctx);
    expect(again).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });
});

describe('reviewPasses knob is real (round-9): passes scale with effort', () => {
  // A reviewer that always approves → the loop never breaks early, so the number
  // of reviewOutput calls equals reviewPasses (+ one adversarialCheck when on).
  const okModel = () => vi.fn(async () => '{"ok":true,"issues":[]}');

  it('NO effort level forces a reviewer pass — not even max', async () => {
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      const model = okModel();
      const rig = makeRig({ effort, callModel: model });
      await startSession(rig);
      await rig.handle.reviewTurn('result', rig.ctx);
      expect(model.mock.calls.length, `${effort} must not review`).toBe(0);
    }
  });

  it('an explicit request still runs exactly the passes it asked for', async () => {
    const model = okModel();
    const rig = makeRig({ effort: 'low', callModel: model });
    await startSession(rig);
    await rig.handle.reviewTurn('result', rig.ctx, undefined, { passes: 3 });
    expect(model.mock.calls.length).toBe(3);
  });
});

describe('SB-3 — a headless subagent context resolves deterministically (never blocks on a dialog)', () => {
  afterEach(() => {
    delete process.env[SUBAGENT_DEPTH_ENV];
  });

  it('confirmRelax auto-resolves inside a subagent instead of awaiting ctx.ui.confirm', async () => {
    // A spawned child pi speaks the same rpc protocol → ctx.hasUI === true even
    // with no human. Depth > 0 must short-circuit the relax gate so it can't hang.
    process.env[SUBAGENT_DEPTH_ENV] = '1';
    const rig = makeRig({ effort: 'medium' }); // no callModel → no rung-2 fixer
    await startSession(rig);
    const deps = rig.handle.buildRepairDeps();

    // Parseable-but-schema-invalid args reach rung 4 with usable `current`.
    const result = await repairToolCallArguments('{"wrong":1}', {
      toolName: 'read',
      schema: SCHEMA,
      extraRungs: deps.extraRungs,
    });

    // The (human-less) subagent was NOT prompted, and the relax resolved.
    expect(rig.confirm).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.rung).toBe(4);
  });
});

// --- Fix #3: loop / no-progress breaking -----------------------------------

const TOOL_CALL = (input: unknown) => ({
  type: 'tool_call' as const,
  toolName: 'bash',
  toolCallId: 'tc',
  input,
});
const TOOL_END = (isError: boolean) => ({
  type: 'tool_execution_end' as const,
  toolCallId: 'tc',
  toolName: 'bash',
  result: {},
  isError,
});

describe('loop detector — live wiring through tool_call / tool_execution_end', () => {
  const loopEntries = (rig: ReturnType<typeof makeRig>) =>
    rig.entries
      .filter((e) => e.customType === HARNESS_LOOP_ENTRY)
      .map((e) => e.data as { action?: string; cause?: string });

  it('steers only at the 75th identical call, and a FAST burst never aborts (wall-clock gated)', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    // A CONCRETE action (not `ls`), so the wander guard can't fire first and spend
    // the turn's single steer — this test is about the identical-call guard alone.
    const call = () => rig.fire('tool_call', TOOL_CALL({ command: 'npm run build' }));

    // the user raised the repeat guard from 5 to 75: a handful of identical calls is
    // a retry, and the yellow "nudging" bar firing on it was noise.
    for (let i = 1; i < DEFAULT_REPEAT_STEER_AFTER; i++) await call();
    expect(rig.steerMessages).toHaveLength(0);
    await call(); // the 75th → the one nudge
    expect(rig.steerMessages).toHaveLength(1);
    expect(loopEntries(rig)).toContainEqual({
      action: 'steer',
      cause: 'identical',
      reason: expect.any(String),
    });
    expect(rig.abort).not.toHaveBeenCalled();

    // the user: the identical-call abort is now WALL-CLOCK (3 min), not a count — so a
    // fast burst of many more identical calls within seconds must NOT abort.
    for (let i = 0; i < 10; i++) await call();
    expect(rig.abort).not.toHaveBeenCalled();
    expect(rig.steerMessages).toHaveLength(1); // still just the one nudge
  });

  it('steers then aborts on a consecutive tool-execution-error streak', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    const err = () => rig.fire('tool_execution_end', TOOL_END(true));

    await err();
    await err();
    await err(); // 3rd error → steer
    expect(rig.steerMessages).toHaveLength(1);
    expect(loopEntries(rig)).toContainEqual({
      action: 'steer',
      cause: 'error',
      reason: expect.any(String),
    });
    await err();
    await err(); // 5th error → abort
    expect(rig.abort).toHaveBeenCalledOnce();
    expect(loopEntries(rig)).toContainEqual({
      action: 'abort',
      cause: 'error',
      reason: expect.any(String),
    });
  });

  it('resets per turn — a fresh before_agent_start re-arms the detector', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    const call = () => rig.fire('tool_call', TOOL_CALL({ command: 'npm run build' }));
    const repeatUntilNudge = async () => {
      for (let i = 0; i < DEFAULT_REPEAT_STEER_AFTER; i++) await call();
    };
    await repeatUntilNudge(); // steer #1
    expect(rig.steerMessages).toHaveLength(1);

    await startTurn(rig); // new turn → detector rebuilt, streak + steer cleared
    await repeatUntilNudge(); // steer #2 (proves the reset)
    expect(rig.steerMessages).toHaveLength(2);
    expect(rig.abort).not.toHaveBeenCalled();
  });

  it('steers ONCE on unproductive wandering but NEVER aborts — different reads are not a loop (the user)', async () => {
    const rig = makeRig({ effort: 'medium' }); // wander steer 6
    await startSession(rig);
    await startTurn(rig);
    // Read a DIFFERENT file each call: distinct signatures, so the identical
    // streak stays inert. Wandering gets one nudge but must never terminate.
    const read = (n: number) =>
      rig.fire('tool_call', {
        type: 'tool_call' as const,
        toolName: 'read',
        toolCallId: `tc${n}`,
        input: { path: `/f${n}.txt` },
      });

    for (let i = 1; i <= 5; i++) await read(i);
    expect(rig.steerMessages).toHaveLength(0);
    await read(6); // 6th exploration call → the single steer
    expect(rig.steerMessages).toHaveLength(1);
    expect(loopEntries(rig)).toContainEqual({
      action: 'steer',
      cause: 'wander',
      reason: expect.any(String),
    });
    expect(rig.abort).not.toHaveBeenCalled();

    // Read 20 MORE different files — never aborts (productive exploration).
    for (let i = 7; i <= 26; i++) await read(i);
    expect(rig.abort).not.toHaveBeenCalled();
  });
});

// --- Fix #4: effort-gated REAL verify + bounded fix loop -------------------

const TEST_CHECK: ProjectCheck = { command: 'npm run test', kind: 'test', label: 'npm run test' };
const failingBash = (): VerifyBashRunner =>
  vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'FAIL: 2 tests' }));
const passingBash = (): VerifyBashRunner =>
  vi.fn(async () => ({ exitCode: 0, stdout: 'all good', stderr: '' }));

describe('effort-gated REAL verify (bounded fix loop)', () => {
  it('high effort + coding: steers ONE fix on a failing check, then stops (budget 1)', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);

    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true); // fix #1
    expect(rig.sentUserMessages.some((m) => m.includes('npm run test'))).toBe(true);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false); // budget exhausted → give up
    expect(runBash).toHaveBeenCalledTimes(2);

    const verifyData = rig.entries
      .filter((e) => e.customType === HARNESS_VERIFY_ENTRY)
      .map((e) => e.data as Record<string, unknown>);
    expect(verifyData.some((d) => d.fix === true)).toBe(true);
    expect(verifyData.some((d) => d.gaveUp === true)).toBe(true);
  });

  it('max effort raises the fix budget to 2', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'max', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('file-ops', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true); // fix #1
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true); // fix #2
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false); // budget exhausted
    expect(runBash).toHaveBeenCalledTimes(3);
  });

  it('a passing check triggers no fix', async () => {
    const runBash = passingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(rig.sentUserMessages).toHaveLength(0);
    expect(runBash).toHaveBeenCalledOnce();
  });

  it('does NOT run below high effort', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'medium', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(runBash).not.toHaveBeenCalled();
  });

  it('does NOT run for non-coding/file-ops classes', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset('simple-QA', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(runBash).not.toHaveBeenCalled();
  });

  it('is permission-mode aware — skipped in review-all', async () => {
    const runBash = failingBash();
    const rig = makeRig({
      effort: 'high',
      mode: 'review-all',
      verify: { runBash, detectCheck: () => TEST_CHECK },
    });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(runBash).not.toHaveBeenCalled();
  });

  it('falls back to a syntax check over touched files when no infra is detected', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => null } });
    await startSession(rig);
    await startTurn(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    // A write tool call records the touched file the syntax fallback checks.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w1',
      input: { path: 'mod.py', content: 'x=1' },
    });
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true);
    expect(runBash).toHaveBeenCalledWith(expect.stringContaining('py_compile'), expect.anything());
  });
});

// --- Fix #5: HarnessStatus.stage transitions -------------------------------

describe('HarnessStatus.stage transitions publish at the seams', () => {
  it('idle → working → done across a plain turn (no classifying stage)', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('idle');

    // Classification removed → the turn goes straight to working (no classify
    // stage/latency before the model starts).
    await rig.fire('agent_start', { type: 'agent_start' });
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('working');

    await rig.fire('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', content: 'here you go' }],
    });
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('done');

    expect(rig.publishedStages()).toEqual(expect.arrayContaining(['idle', 'working', 'done']));
  });

  it('reviewer flag → reviewing then revising are both published', async () => {
    const bad = vi.fn(async () => '{"ok":false,"issues":["x"]}');
    const rig = makeRig({ effort: 'high', callModel: bad });
    await startSession(rig);
    await startTurn(rig);
    // Requested, since no effort forces a review any more.
    expect(await rig.handle.reviewTurn('result', rig.ctx, undefined, { passes: 1 })).toBe(true);
    const stages = rig.publishedStages();
    expect(stages).toContain('reviewing');
    expect(stages).toContain('revising');
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('revising');
  });

  it("the real verify publishes 'verifying'", async () => {
    const rig = makeRig({
      effort: 'high',
      verify: { runBash: passingBash(), detectCheck: () => TEST_CHECK },
    });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    await rig.handle.verifyTurn(rig.ctx);
    expect(rig.publishedStages()).toContain('verifying');
  });

  it("a repair rung publishes 'repairing', cleared to 'working' on the next tool result", async () => {
    const rig = makeRig({ effort: 'low' }); // no callModel → ladder falls to rungs 3–5
    await startSession(rig);
    await startTurn(rig);
    const deps = rig.handle.buildRepairDeps();
    await repairToolCallArguments('garbage {{{', {
      toolName: 'bash',
      schema: SCHEMA,
      extraRungs: deps.extraRungs,
    });
    expect(rig.publishedStages()).toContain('repairing');
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('repairing');

    await rig.fire('tool_execution_end', TOOL_END(false));
    expect(rig.handle.getStatus(rig.ctx).stage).toBe('working');
  });
});

describe("the README's promises reach the model (reachability, not logic)", () => {
  /*
   * THIS CHECK HAS SHIPPED AND NEVER ONCE RUN.
   *
   * `undemonstrated` has unit tests and they pass. What was never proven is that
   * anything CALLS it — and it lives at the very end of the turn, in the verify
   * pass, so the only way I had been testing it was full benchmark runs. Two of
   * those in a row died before reaching a turn end (one on a stalled edit loop,
   * one starved of memory), so after shipping it the measured evidence was
   * exactly zero.
   *
   * "Registered is not reachable" is the dominant bug of this whole session, and
   * a check that only fires at turn end cannot be validated by runs that never
   * finish. So it is driven directly here: a real workspace with a real README,
   * a turn that touched a file and ran a command, and an assertion that the
   * steer actually arrives.
   */
  const withWorkspace = (readme: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pd-readme-'));
    writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');
    writeFileSync(path.join(dir, 'notes.py'), 'print("hi")\n', 'utf8');
    return dir;
  };

  const README = [
    '# notes',
    '',
    'A tiny command-line note keeper.',
    '',
    '    notes add "buy milk"',
    '    notes search milk',
    '',
    'Searching is case-insensitive.',
    '',
  ].join('\n');

  /** A turn that edited a file and ran it — the shape the check is meant for. */
  const workedOn = async (rig: ReturnType<typeof makeRig>, cwd: string, command: string) => {
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'edit',
      input: { path: path.join(cwd, 'notes.py') },
    });
    await rig.fire('tool_call', { type: 'tool_call', toolName: 'bash', input: { command } });
  };

  it('steers on a README promise the turn never demonstrated', async () => {
    const cwd = withWorkspace(README);
    const rig = makeRig({
      effort: 'max',
      cwd,
      // No project check in this workspace → the pass-branch, where the
      // unexercised/undemonstrated chain lives.
      verify: { runBash: passingBash(), detectCheck: () => null },
    });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    await workedOn(rig, cwd, `python3 ${path.join(cwd, 'notes.py')} add "buy milk"`);

    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true);
    const steer = rig.sentUserMessages.join('\n');
    expect(steer).toContain('README IS PART OF THE SPEC');
    expect(steer).toMatch(/case-insensitive/i);
    /* The specific mistake run H made: testing with input that passes either way. */
    expect(steer).toMatch(/would fail if the promise were broken/);
  });

  it('names a documented command the turn never ran', async () => {
    const cwd = withWorkspace(README);
    const rig = makeRig({
      effort: 'max',
      cwd,
      verify: { runBash: passingBash(), detectCheck: () => null },
    });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    await workedOn(rig, cwd, `python3 ${path.join(cwd, 'notes.py')} add "buy milk"`);

    await rig.handle.verifyTurn(rig.ctx);
    expect(rig.sentUserMessages.join('\n')).toContain('notes search milk');
  });

  /* Silence is the common case and has to stay free. */
  it('says nothing when the README promises nothing checkable', async () => {
    const cwd = withWorkspace('# notes\n\nA tiny tool.\n\n    notes add x\n');
    const rig = makeRig({
      effort: 'max',
      cwd,
      verify: { runBash: passingBash(), detectCheck: () => null },
    });
    await startSession(rig);
    rig.handle.applyPreset('coding', rig.ctx);
    await workedOn(rig, cwd, `python3 ${path.join(cwd, 'notes.py')} add x`);

    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(rig.sentUserMessages.join('\n')).not.toContain('README IS PART OF THE SPEC');
  });
});

/**
 * c1: an unattended run cannot call a forbidden tool, whatever it tries.
 *
 * The fence is at `tool_call` on purpose, because that is the ONE place every
 * dispatch path passes through — an advertised call, the `use` dispatcher, a
 * bash-CLI command, or a capability the model activates mid-turn. A test that
 * only checked the advertised list would be testing a suggestion.
 */
describe('forbidden tools', () => {
  /** The refusal from whichever handler produced one, or null. */
  const blockOf = (results: unknown): { reason?: string } | null => {
    const list = Array.isArray(results) ? results : [results];
    const hit = list.find((r) => (r as { block?: boolean })?.block === true);
    return (hit as { reason?: string } | undefined) ?? null;
  };

  const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.PI_DESKTOP_FORBID_TOOLS;
    if (value === undefined) delete process.env.PI_DESKTOP_FORBID_TOOLS;
    else process.env.PI_DESKTOP_FORBID_TOOLS = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.PI_DESKTOP_FORBID_TOOLS;
      else process.env.PI_DESKTOP_FORBID_TOOLS = prev;
    }
  };

  const sendCall = {
    type: 'tool_call' as const,
    toolName: 'messages_send',
    toolCallId: 'tc-send',
    input: { to: 'someone', body: 'hi' },
  };

  it('blocks the call, and says what to do instead', async () => {
    await withEnv('messages_send', async () => {
      const rig = makeRig({});
      await startSession(rig);
      await startTurn(rig);
      // `fire` returns one result per registered handler; the question is
      // whether ANY of them refused.
      const blocked = blockOf(await rig.fire('tool_call', sendCall));
      expect(blocked).not.toBeNull();
      // A model told only "no" tries the same thing another way.
      expect(String(blocked?.reason)).toMatch(/draft/i);
    });
  });

  it('leaves every other tool alone', async () => {
    await withEnv('messages_send', async () => {
      const rig = makeRig({});
      await startSession(rig);
      await startTurn(rig);
      const blocked = blockOf(
        await rig.fire('tool_call', {
          type: 'tool_call' as const,
          toolName: 'mail_recent',
          toolCallId: 'tc-read',
          input: {},
        }),
      );
      expect(blocked).toBeNull();
    });
  });

  it('forbids nothing when the env is unset — this is per-run, not global', async () => {
    await withEnv(undefined, async () => {
      const rig = makeRig({});
      await startSession(rig);
      await startTurn(rig);
      expect(blockOf(await rig.fire('tool_call', sendCall))).toBeNull();
    });
  });
});

describe('no internet, no web tools (the user)', () => {
  /*
   * the user: "model still has search and web tools even when there's no internet,
   * and gets confused looping in them." Asking it to stop cannot work —
   * llama-server pins the emitted tool name to the ADVERTISED list, so the fix
   * has to be that the tool is not there to call.
   */
  const webCall = (rig: ReturnType<typeof makeRig>, text: string, isError = true) =>
    rig.fire('tool_result', {
      type: 'tool_result',
      toolName: 'web_search',
      toolCallId: 'w1',
      input: { query: 'anything' },
      content: [{ type: 'text', text }],
      isError,
    });

  it('withdraws them after a network failure, and says why exactly once', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    expect(rig.activeTools()).toContain('web_search');

    const first = await webCall(rig, 'TypeError: fetch failed');
    expect(JSON.stringify(first)).toContain('no internet connection');
    // A second failure inside the window does not repeat the note. (`fire`
    // returns one entry per handler, so an untouched result is [undefined].)
    const second = await webCall(rig, 'getaddrinfo ENOTFOUND duckduckgo.com');
    expect(second).toEqual([undefined]);

    // The next turn is advertised WITHOUT them.
    await startTurn(rig);
    expect(rig.activeTools()).not.toContain('web_search');
    expect(rig.activeTools()).not.toContain('web_fetch');
  });

  it('leaves them alone when the failure is the SITE, not the network', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    await webCall(rig, 'HTTP 404 Not Found');
    await startTurn(rig);
    expect(rig.activeTools()).toContain('web_search');
  });

  it('gives them straight back when a web call succeeds again', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    await webCall(rig, 'TypeError: fetch failed');
    await webCall(rig, 'three results', false);
    await startTurn(rig);
    expect(rig.activeTools()).toContain('web_search');
  });
});
