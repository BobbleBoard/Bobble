/**
 * Round-9 wiring tests: the repair ladder + effort knobs actually drive runtime
 * behavior.
 *
 * These drive the harness's live repair deps through the provider's REAL
 * `repairToolCallArguments` (the same seam production uses), and exercise the
 * effort-gated reviewer pass — so they prove the bridge, not just the library.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetResidentPrefix,
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
import {
  DEFAULT_LOOP_ABORT_AFTER,
  DEFAULT_LOOP_STEER_AFTER,
  DEFAULT_REPEAT_STEER_AFTER,
} from './loop/loop-detector.js';
import type { CallModel } from './model-call/call-model.js';
import type { ToolSchemaLike } from './repair/rungs.js';
import { TOOL_CLI_SOCK_ENV, TOOL_CLI_TOKEN_ENV } from './tools/tool-cli-bridge.js';

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
    /** What `getAllTools` reports — the guards and the CLI both read it. */
    allTools?: readonly string[];
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
  const registeredTools = new Map<string, ToolDefinition>();
  const steerMessages: string[] = [];

  const pi = {
    on: (event: string, h: AnyHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(h);
      handlers.set(event, list);
    },
    /* Kept, rather than dropped on the floor: a test that needs to exercise a
       tool the harness registers (update_plan, say) has nowhere else to get
       its execute from. */
    registerTool: (def: ToolDefinition) => {
      registeredTools.set(def.name, def);
    },
    registerCommand: () => {},
    getAllTools: (): ToolInfo[] =>
      (opts.allTools ?? ['read', 'bash', 'tool_search', 'web_search', 'web_fetch']).map((name) => ({
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
    /* `input` is how review-all mode asks to allow a tool. A rig without it
       throws the moment a test fires a tool_call under that mode — which only
       surfaced once the verify gate started keying off files actually written
       (it used to key off a guessed task class). Default-allow keeps these
       tests about verification rather than about permissions. */
    ui: { notify, confirm, setStatus, input: async () => 'allow' },
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
    registeredTools,
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

  /*
   * The single KV slot has background writers the renderer cannot see. Every
   * utility call announces that it moved the slot so the composer can put the
   * user's own prefix back — see the note beside `watchSlot`.
   */
  it('announces that the slot moved after a utility call finishes', async () => {
    const callModel: CallModel = vi.fn(async () => '{"path":"/fixed-by-model"}');
    const rig = makeRig({ effort: 'medium', callModel });
    await startSession(rig);
    await startTurn(rig);
    const epochsBefore = rig.setStatus.mock.calls.filter((c) => c[0] === 'harness-slot-epoch');

    const deps = rig.handle.buildRepairDeps();
    await repairToolCallArguments('{"wrong":1}', {
      toolName: 'read',
      schema: SCHEMA,
      fixer: deps.fixer,
      extraRungs: deps.extraRungs,
    });

    const epochs = rig.setStatus.mock.calls.filter((c) => c[0] === 'harness-slot-epoch');
    expect(epochs.length).toBeGreaterThan(epochsBefore.length);
    // Monotonic, so a renderer can tell "again" from "still".
    const values = epochs.map((c) => Number(c[1]));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values.at(-1)).toBeGreaterThan(0);
  });

  /*
   * The composer's "Getting ready" label is a promise about a wait. pi rewires
   * this extension for every chat, so the label is claimed again in every one —
   * and a chat whose prefix is already resident does no warm-up at all. Without
   * a release on that path the label stays up for the life of the session and
   * stops meaning anything.
   */
  it('hands back the "getting ready" label in a chat whose prefix is already resident', async () => {
    /*
     * TWO WIRINGS, because that is what a new chat is: pi re-imports this
     * extension per session, so the label — claimed on the first tick of every
     * wiring, before it is known whether a warm-up is needed — is claimed again
     * in a chat that has nothing to warm. The first rig does the warming; the
     * second is the new chat, and it must give the label back.
     */
    const warm = async (rig: ReturnType<typeof makeRig>) => {
      (rig.ctx as unknown as { getSystemPrompt: () => string }).getSystemPrompt = () =>
        'You are a helpful assistant.';
      await startSession(rig);
      for (let i = 0; i < 6; i += 1) {
        await rig.fire('model_select', { type: 'model_select', model: { id: 'm', name: 'm' } });
        await Promise.resolve();
      }
      await new Promise((r) => setTimeout(r, 0));
    };

    const first = makeRig({ effort: 'medium', callModel: vi.fn(async () => 'ok') });
    await warm(first);
    const second = makeRig({ effort: 'medium', callModel: vi.fn(async () => 'ok') });
    await warm(second);

    const labels = second.setStatus.mock.calls.filter((c) => c[0] === 'harness-prefix-warm');
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.at(-1)?.[1]).toBe('ready');
  });

  /*
   * MEASURED (Qwen 3.8 27B, 2026-10-02): the label cleared four seconds after
   * the server came up — one tick after the warm-up STARTED, because the next
   * tick found the prompt already recorded as warmed and handed the label
   * back. The 27B was still reading the prompt; a first message sent then
   * queued behind it.
   */
  it('keeps "getting ready" up while the warm-up is still reading the prompt', async () => {
    forgetResidentPrefix();
    let finish: (v: string) => void = () => undefined;
    const callModel = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const rig = makeRig({ effort: 'medium', callModel });
    (rig.ctx as unknown as { getSystemPrompt: () => string }).getSystemPrompt = () =>
      'You are a helpful assistant, still warming.';
    await startSession(rig);
    for (let i = 0; i < 6; i += 1) {
      await rig.fire('model_select', { type: 'model_select', model: { id: 'm', name: 'm' } });
      await Promise.resolve();
    }
    const label = () =>
      rig.setStatus.mock.calls.filter((c) => c[0] === 'harness-prefix-warm').at(-1)?.[1];
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(label()).toBe('warming');
    finish('ok');
    await new Promise((r) => setTimeout(r, 0));
    expect(label()).toBe('ready');
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

  /*
   * The THRESHOLDS moved to 75/100 (the user: three consecutive tool errors is a
   * model learning a CLI's argument shape, not a loop). The ESCALATION is what
   * this test is for, so it drives the full streak rather than asserting the
   * old numbers — a test that hard-codes a tuning knob fails every time the
   * knob is tuned and tells you nothing about the mechanism.
   */
  it('steers then aborts on a consecutive tool-execution-error streak', async () => {
    const rig = makeRig({ effort: 'medium' });
    await startSession(rig);
    await startTurn(rig);
    const err = () => rig.fire('tool_execution_end', TOOL_END(true));

    for (let i = 0; i < DEFAULT_LOOP_STEER_AFTER - 1; i += 1) await err();
    expect(rig.steerMessages).toHaveLength(0); // one short of the threshold
    await err(); // the threshold error → steer
    expect(rig.steerMessages).toHaveLength(1);
    expect(loopEntries(rig)).toContainEqual({
      action: 'steer',
      cause: 'error',
      reason: expect.any(String),
    });
    for (let i = DEFAULT_LOOP_STEER_AFTER; i < DEFAULT_LOOP_ABORT_AFTER; i += 1) await err();
    expect(rig.abort).toHaveBeenCalledOnce();
    expect(loopEntries(rig)).toContainEqual({
      action: 'abort',
      cause: 'error',
      reason: expect.any(String),
    });
    // The person still gets an answer (MEASURED: Ling 3.0 Tiny, "Done" over nothing).
    expect(rig.sentUserMessages.at(-1)).toMatch(
      /^You were stopped: .+Answer what the user asked now/s,
    );
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
    rig.handle.applyPreset(rig.ctx);
    // The gate keys off files the turn actually WROTE (it used to key off a
    // guessed task class, which was pinned to a constant and so never true).
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w0',
      input: { path: 'mod.py', content: 'x=1' },
    });
    // ...and EXERCISED, so the separate never-exercised steer stays quiet and
    // this test still measures only the verify loop.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'b0',
      input: { command: 'python3 mod.py' },
    });

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
    rig.handle.applyPreset(rig.ctx);
    // The gate keys off files the turn actually WROTE (it used to key off a
    // guessed task class, which was pinned to a constant and so never true).
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w0',
      input: { path: 'mod.py', content: 'x=1' },
    });
    // ...and EXERCISED, so the separate never-exercised steer stays quiet and
    // this test still measures only the verify loop.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'b0',
      input: { command: 'python3 mod.py' },
    });
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true); // fix #1
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(true); // fix #2
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false); // budget exhausted
    expect(runBash).toHaveBeenCalledTimes(3);
  });

  it('a passing check triggers no fix', async () => {
    const runBash = passingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset(rig.ctx);
    // The gate keys off files the turn actually WROTE (it used to key off a
    // guessed task class, which was pinned to a constant and so never true).
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w0',
      input: { path: 'mod.py', content: 'x=1' },
    });
    // ...and EXERCISED, so the separate never-exercised steer stays quiet and
    // this test still measures only the verify loop.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'b0',
      input: { command: 'python3 mod.py' },
    });
    // The check RUNS (the turn wrote a file) and PASSES, so nothing is steered.
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(rig.sentUserMessages).toHaveLength(0);
    expect(runBash).toHaveBeenCalledOnce();
  });

  it('does NOT run below high effort', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'medium', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset(rig.ctx);
    // The gate keys off files the turn actually WROTE (it used to key off a
    // guessed task class, which was pinned to a constant and so never true).
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w0',
      input: { path: 'mod.py', content: 'x=1' },
    });
    // ...and EXERCISED, so the separate never-exercised steer stays quiet and
    // this test still measures only the verify loop.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'b0',
      input: { command: 'python3 mod.py' },
    });
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(runBash).not.toHaveBeenCalled();
  });

  it('does NOT run when the turn wrote nothing', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => TEST_CHECK } });
    await startSession(rig);
    rig.handle.applyPreset(rig.ctx);
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
    rig.handle.applyPreset(rig.ctx);
    // The gate keys off files the turn actually WROTE (it used to key off a
    // guessed task class, which was pinned to a constant and so never true).
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w0',
      input: { path: 'mod.py', content: 'x=1' },
    });
    // ...and EXERCISED, so the separate never-exercised steer stays quiet and
    // this test still measures only the verify loop.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'b0',
      input: { command: 'python3 mod.py' },
    });
    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(runBash).not.toHaveBeenCalled();
  });

  it('falls back to a syntax check over touched files when no infra is detected', async () => {
    const runBash = failingBash();
    const rig = makeRig({ effort: 'high', verify: { runBash, detectCheck: () => null } });
    await startSession(rig);
    await startTurn(rig);
    rig.handle.applyPreset(rig.ctx);
    // The gate keys off files the turn actually WROTE (it used to key off a
    // guessed task class, which was pinned to a constant and so never true).
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w0',
      input: { path: 'mod.py', content: 'x=1' },
    });
    // ...and EXERCISED, so the separate never-exercised steer stays quiet and
    // this test still measures only the verify loop.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'b0',
      input: { command: 'python3 mod.py' },
    });
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
    rig.handle.applyPreset(rig.ctx);
    // The gate keys off files the turn actually WROTE (it used to key off a
    // guessed task class, which was pinned to a constant and so never true).
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'w0',
      input: { path: 'mod.py', content: 'x=1' },
    });
    // ...and EXERCISED, so the separate never-exercised steer stays quiet and
    // this test still measures only the verify loop.
    await rig.fire('tool_call', {
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'b0',
      input: { command: 'python3 mod.py' },
    });
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
    rig.handle.applyPreset(rig.ctx);
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
    rig.handle.applyPreset(rig.ctx);
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
    rig.handle.applyPreset(rig.ctx);
    await workedOn(rig, cwd, `python3 ${path.join(cwd, 'notes.py')} add x`);

    expect(await rig.handle.verifyTurn(rig.ctx)).toBe(false);
    expect(rig.sentUserMessages.join('\n')).not.toContain('README IS PART OF THE SPEC');
  });
});

/** The refusal from whichever `tool_call` handler produced one, or null. */
const blockOf = (results: unknown): { reason?: string } | null => {
  const list = Array.isArray(results) ? results : [results];
  const hit = list.find((r) => (r as { block?: boolean })?.block === true);
  return (hit as { reason?: string } | undefined) ?? null;
};

/**
 * c1: an unattended run cannot call a forbidden tool, whatever it tries.
 *
 * The fence is at `tool_call` on purpose, because every dispatch path is held
 * to it — an advertised call, a capability the model activates mid-turn, and
 * the two dispatchers that run a tool themselves (`use`, a bash-CLI command),
 * which apply the same per-tool rules before they execute (see the next
 * block). A test that only checked the advertised list would be testing a
 * suggestion.
 */
describe('forbidden tools', () => {
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

/**
 * THE PER-TOOL RULES HOLD HOWEVER THE CALL ARRIVES.
 *
 * pi fires `tool_call` for the call the MODEL made. In CLI mode that call is
 * `bash`, and the tool its command line runs — `file write …` is `write` — was
 * executed by the CLI host directly, so every rule keyed on the tool's own name
 * was skipped. SEEN during VQ-10: a flow diagram typed as `file write --path
 * flow.svg --content '<svg …>'` went straight to disk, while the same markup
 * through the `write` tool was refused toward `diagram`. `use` is the same
 * shape of door in schemas mode.
 */
describe('the per-tool rules hold at every door', () => {
  /* Diagram-shaped (handwritten-svg.ts): three labels, three boxes, two arrows. */
  const FLOW_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">',
    '  <rect x="20" y="20" width="120" height="40"/><text x="30" y="45">Order placed</text>',
    '  <rect x="20" y="120" width="120" height="40"/><text x="30" y="145">Payment ok?</text>',
    '  <rect x="220" y="120" width="140" height="40"/><text x="230" y="145">Email customer</text>',
    '  <line x1="80" y1="60" x2="80" y2="120" marker-end="url(#a)"/>',
    '  <line x1="140" y1="140" x2="220" y2="140" marker-end="url(#a)"/>',
    '</svg>',
  ].join('\n');
  /* A VQ-10 session: the file tools the fence registers, and `diagram`. */
  const TOOLS = ['read', 'write', 'edit', 'ls', 'bash', 'diagram'];

  /* The bridge writes its socket, its token and its shim dir into process.env,
     so everything a session touches is put back. */
  const ENV_KEYS = [
    'PI_DESKTOP_TOOL_CLI',
    'PI_DESKTOP_FS_FENCE',
    'PI_DESKTOP_WORKSPACE_ROOT',
    'PATH',
    TOOL_CLI_SOCK_ENV,
    TOOL_CLI_TOKEN_ENV,
  ];
  let saved: [string, string | undefined][] = [];
  /* The sessions' folders, and each bridge's socket and shim dir — the bridge
     removes those on process exit, which a test worker never reaches. */
  const leftovers: string[] = [];
  beforeEach(() => {
    saved = ENV_KEYS.map((k) => [k, process.env[k]]);
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const p of leftovers.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  interface Bridge {
    readonly sock: string | undefined;
    readonly token: string | undefined;
  }

  /** A session in a fresh folder, with the fenced file tools. */
  const session = async (
    mode: 'cli' | 'schemas',
    ask = 'Draw a flow diagram of our order fulfilment process',
    tools: readonly string[] = TOOLS,
  ) => {
    process.env.PI_DESKTOP_TOOL_CLI = mode === 'cli' ? '1' : '0';
    process.env.PI_DESKTOP_FS_FENCE = '1';
    delete process.env.PI_DESKTOP_WORKSPACE_ROOT;
    const cwd = mkdtempSync(path.join(tmpdir(), 'pd-doors-'));
    leftovers.push(cwd);
    const before = process.env[TOOL_CLI_SOCK_ENV];
    const rig = makeRig({ cwd, allTools: tools });
    /* Read now: the next session's bridge moves the env on. Only a bridge THIS
       session installed counts — schemas mode installs none. */
    const sock = process.env[TOOL_CLI_SOCK_ENV];
    const bridge: Bridge =
      sock !== before
        ? { sock, token: process.env[TOOL_CLI_TOKEN_ENV] }
        : { sock: undefined, token: undefined };
    if (bridge.sock !== undefined) {
      leftovers.push(bridge.sock);
      /* …and its shim dir is the one it put first on PATH. */
      const shims = process.env.PATH?.split(path.delimiter)[0] ?? '';
      if (path.basename(shims).startsWith('pi-toolcli-')) leftovers.push(shims);
    }
    await startSession(rig);
    await startTurn(rig, ask);
    return { rig, cwd, bridge };
  };

  /** One command line through a session's bridge — the request its shim sends. */
  const run = (bridge: Bridge, argv: readonly string[]) =>
    new Promise<{ text: string; isError: boolean }>((resolve, reject) => {
      if (bridge.sock === undefined) {
        reject(new Error('no CLI bridge in this session'));
        return;
      }
      const socket = net.createConnection(bridge.sock);
      let buf = '';
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ token: bridge.token, argv })}\n`),
      );
      socket.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        socket.end();
        resolve(JSON.parse(buf.slice(0, nl)) as { text: string; isError: boolean });
      });
      socket.on('error', reject);
    });

  /** The `bash` call that carries a command line — what `tool_call` sees in CLI mode. */
  const bashCall = (argv: readonly string[]) => ({
    type: 'tool_call' as const,
    toolName: 'bash',
    toolCallId: 'b1',
    input: {
      command: argv
        .map((a) => (/^[\w./=-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`))
        .join(' '),
    },
  });
  const writeCall = (file: string, content: string) => ({
    type: 'tool_call' as const,
    toolName: 'write',
    toolCallId: 'w1',
    input: { path: file, content },
  });

  it('refuses a diagram typed at the shell exactly as the write tool refuses it', async () => {
    /* The door that always had the rule. `write` is pinned in CLI mode too. */
    const direct = await session('cli');
    const refused = blockOf(await direct.rig.fire('tool_call', writeCall('flow.svg', FLOW_SVG)));
    expect(refused?.reason).toContain('diagram "Order fulfilment" --out flow.svg');

    /* The door that did not: the same markup, as a command line. */
    const shell = await session('cli');
    const argv = ['file', 'write', '--path', 'flow.svg', '--content', FLOW_SVG];
    /* `bash` reaches the hook first, and nothing about the LINE is wrong… */
    expect(blockOf(await shell.rig.fire('tool_call', bashCall(argv)))).toBeNull();
    /* …it is the write the line runs. */
    expect(await run(shell.bridge, argv)).toEqual({ text: refused?.reason, isError: true });
    expect(existsSync(path.join(shell.cwd, 'flow.svg'))).toBe(false);
  });

  /*
   * ONE RULE, ONE ESCAPE. A plotting script typed as `file write` is on the
   * command line, where the shell-text chart scan reads it too; with the write
   * rule now running as well, the same text met two refusals with two separate
   * escapes. Only `chart` is registered here — it is in every chat — so this
   * also pins that the write rule is on without any other drawing tool.
   */
  it('gives a plotting script typed at the shell one refusal and one way through', async () => {
    const PLOT = [
      'import matplotlib.pyplot as plt',
      "plt.bar(['2023', '2024'], [12, 19])",
      "plt.savefig('sales.png')",
    ].join('\n');
    const ask = 'Write me a Python script that plots our sales by year';
    const tools = ['read', 'write', 'edit', 'ls', 'bash', 'chart'];

    const direct = await session('cli', ask, tools);
    const refused = blockOf(await direct.rig.fire('tool_call', writeCall('plot.py', PLOT)));
    expect(refused?.reason).toContain('chart bar');
    /* …and the identical write again is the way through: one refusal. */
    expect(blockOf(await direct.rig.fire('tool_call', writeCall('plot.py', PLOT)))).toBeNull();

    const shell = await session('cli', ask, tools);
    const argv = ['file', 'write', '--path', 'plot.py', '--content', PLOT];
    expect(blockOf(await shell.rig.fire('tool_call', bashCall(argv)))).toBeNull();
    expect(await run(shell.bridge, argv)).toEqual({ text: refused?.reason, isError: true });
    expect(blockOf(await shell.rig.fire('tool_call', bashCall(argv)))).toBeNull();
    expect((await run(shell.bridge, argv)).isError).toBe(false);
    expect(readFileSync(path.join(shell.cwd, 'plot.py'), 'utf8')).toBe(PLOT);
  });

  /*
   * A HEREDOC IS A WRITE (bash-writes.ts). MEASURED (the maths suite, 4B, the
   * derivative): its spec typed as `cat > tangent_deriv.json << 'ENDJSON'`,
   * twice, never drawn; then a tangent line hand-drawn as SVG the same way,
   * round the refusal a `write` of it meets.
   */
  it('draws a maths spec typed into a heredoc, and refuses a maths figure typed as SVG there', async () => {
    const tools = ['read', 'write', 'edit', 'ls', 'bash', 'math'];
    const { rig, cwd } = await session('cli', 'What does a derivative mean? Show me.', tools);
    const heredoc = (file: string, body: string) => ({
      type: 'tool_call' as const,
      toolName: 'bash',
      toolCallId: 'h1',
      input: { command: `cat > ${file} << 'EOF'\n${body}\nEOF` },
    });
    const SVG =
      '<svg viewBox="0 0 400 300"><circle cx="200" cy="150" r="100"/><text x="10" y="20">(cos θ, sin θ)</text><text x="30" y="40">tangent</text></svg>';
    const svgCall = heredoc('derivative.svg', SVG);
    expect(blockOf(await rig.fire('tool_call', svgCall))?.reason).toMatch(
      /^Not written: derivative\.svg is a maths or physics figure drawn by hand[\s\S]*run the same command again UNCHANGED/,
    );
    expect(blockOf(await rig.fire('tool_call', svgCall))).toBeNull();

    const spec = JSON.stringify({
      title: 'The slope of x²',
      params: ['a = 1 in -2..2'],
      plot: { x: '-3..3', curves: [{ id: 'f', expr: 'x^2' }] },
      steps: [{ text: 'The curve {f}.', highlight: ['f'], set: { a: 1 } }],
    });
    const file = path.join(cwd, 'tangent_deriv.json');
    writeFileSync(file, spec);
    const results = await rig.fire('tool_result', {
      type: 'tool_result',
      toolName: 'bash',
      toolCallId: 'h2',
      input: heredoc(file, spec).input,
      content: [{ type: 'text', text: '' }],
      isError: false,
    });
    const said = results
      .map((r) => (r as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text)
      .find((t) => typeof t === 'string');
    expect(said).toMatch(/^Drew "The slope of x²": \S*tangent_deriv\.html/);
    expect(existsSync(path.join(cwd, 'tangent_deriv.html'))).toBe(true);
  });

  /*
   * What the move must NOT take with it: the bookkeeping that belongs to the
   * `bash` call. The result hook spots a verbatim repeat by comparing the
   * result with `lastCallInput` — the bash call, in CLI mode — so the write
   * inside the line must not have replaced it.
   */
  it('lets an ordinary command write, and records it like the write tool', async () => {
    const { rig, cwd, bridge } = await session('cli');
    const notes = path.join(cwd, 'notes.md');
    const argv = ['file', 'write', '--path', notes, '--content', 'hello'];
    let said = '';
    for (let i = 0; i < 3; i += 1) {
      expect(blockOf(await rig.fire('tool_call', bashCall(argv)))).toBeNull();
      expect((await run(bridge, argv)).isError).toBe(false);
      const results = await rig.fire('tool_result', {
        type: 'tool_result',
        toolName: 'bash',
        toolCallId: `b${i}`,
        input: bashCall(argv).input,
        content: [{ type: 'text', text: `Successfully wrote 5 bytes to ${notes}` }],
        isError: false,
      });
      said =
        results
          .map((r) => (r as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text)
          .find((t) => typeof t === 'string') ?? '';
    }
    expect(readFileSync(notes, 'utf8')).toBe('hello');
    /* Checkpointed before it ran, like a write-tool write: the changed-files
       list and `/harness restore` see it. */
    expect(rig.handle.getStatus(rig.ctx).changedFiles).toEqual([{ path: notes, created: true }]);
    expect(said).toContain('this exact `bash` call 3 times');
  });

  it('refuses the same markup through `use`, which also runs the tool itself', async () => {
    const direct = await session('schemas');
    const refused = blockOf(await direct.rig.fire('tool_call', writeCall('flow.svg', FLOW_SVG)));
    expect(refused?.reason).toContain('Call the diagram tool');

    const viaUse = await session('schemas');
    const use = viaUse.rig.registeredTools.get('use');
    expect(use, 'use was never registered').toBeDefined();
    const failed = await (use as unknown as { execute: (...a: unknown[]) => Promise<unknown> })
      .execute(
        'u1',
        { tool: 'write', args: { path: 'flow.svg', content: FLOW_SVG } },
        undefined,
        undefined,
        viaUse.rig.ctx,
      )
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    /* Thrown, so pi hands it back as an error result — what a blocked call is. */
    expect(failed?.message).toBe(refused?.reason);
    expect(existsSync(path.join(viaUse.cwd, 'flow.svg'))).toBe(false);
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

/**
 * A TURN THAT ENDS WITH THE MODEL'S OWN CHECKLIST UNFINISHED.
 *
 * the user, round 3: "long running tasks where you can't accept an 'I can't do
 * this' needs to truly run until completion." The unit tests in
 * loop/unfinished-plan.test.ts pin WHEN this should fire; these pin that the
 * harness actually sends it, from a plan the model set through the real tool.
 */
describe('unfinished-plan steer', () => {
  /** Drive the real `update_plan` tool the way the model would. */
  async function setPlan(
    rig: ReturnType<typeof makeRig>,
    items: readonly { id: string; text: string; status: string }[],
  ): Promise<void> {
    const tool = rig.registeredTools.get('update_plan');
    expect(tool, 'update_plan was never registered').toBeDefined();
    // pi's tool signature: (toolCallId, params, signal, onUpdate, ctx).
    // biome-ignore lint/suspicious/noExplicitAny: the rig's tool stub is untyped.
    await (tool as any).execute('call-1', { plan: items }, undefined, undefined, rig.ctx);
  }

  const end = (rig: ReturnType<typeof makeRig>, text = 'I have made good progress.') =>
    rig.fire('agent_end', { type: 'agent_end', messages: [{ role: 'assistant', content: text }] });

  it('pushes back when the model stops with steps left', async () => {
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    await setPlan(rig, [
      { id: '1', text: 'scaffold the project', status: 'done' },
      { id: '2', text: 'write the parser', status: 'pending' },
    ]);
    await end(rig);
    expect(rig.sentUserMessages).toHaveLength(1);
    // It quotes the model's OWN step back, which is the whole point.
    expect(rig.sentUserMessages[0]).toContain('write the parser');
  });

  it('says nothing when the plan is complete', async () => {
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    await setPlan(rig, [{ id: '1', text: 'scaffold the project', status: 'done' }]);
    await end(rig);
    expect(rig.sentUserMessages).toHaveLength(0);
  });

  it('says nothing when there is no plan at all', async () => {
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    await end(rig);
    expect(rig.sentUserMessages).toHaveLength(0);
  });

  it('fires ONCE per session, like its two neighbours', async () => {
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    await setPlan(rig, [
      { id: '1', text: 'a', status: 'done' },
      { id: '2', text: 'b', status: 'pending' },
    ]);
    await end(rig);
    await end(rig);
    expect(rig.sentUserMessages).toHaveLength(1);
  });

  it('never sends two steers in one turn — the handback wins', async () => {
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    await setPlan(rig, [
      { id: '1', text: 'a', status: 'done' },
      { id: '2', text: 'b', status: 'pending' },
    ]);
    await end(
      rig,
      [
        'Here is where things stand.',
        'A) keep going',
        'B) stop here',
        'Which would you prefer?',
      ].join('\n'),
    );
    expect(rig.sentUserMessages).toHaveLength(1);
    expect(rig.sentUserMessages[0]).toContain('Pick the option');
  });

  /* The visual suite, 4B, verbatim: the icon set ended on a promise. */
  const PROMISE =
    'The svg command seems to have generated something, but I need to check what was actually created. Let me present the SVG file to see what was generated.';

  it('pushes back when the turn ends on a next step it never took', async () => {
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    await end(rig, PROMISE);
    expect(rig.sentUserMessages).toHaveLength(1);
    expect(rig.sentUserMessages[0]).toContain('Let me present the SVG file');
    // Once per session.
    await end(rig, PROMISE);
    expect(rig.sentUserMessages).toHaveLength(1);
  });

  it('still fires after another steer went out in an EARLIER turn, never in the same one', async () => {
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    await setPlan(rig, [
      { id: '1', text: 'a', status: 'done' },
      { id: '2', text: 'b', status: 'pending' },
    ]);
    // This turn: the plan nudge AND a promise — only one steer goes out.
    await end(rig, PROMISE);
    expect(rig.sentUserMessages).toHaveLength(1);
    expect(rig.sentUserMessages[0]).toContain('b');
    // A later turn ends on a promise again: now it is this nudge's turn.
    await setPlan(rig, [
      { id: '1', text: 'a', status: 'done' },
      { id: '2', text: 'b', status: 'done' },
    ]);
    await end(rig, PROMISE);
    expect(rig.sentUserMessages).toHaveLength(2);
    expect(rig.sentUserMessages[1]).toContain('Let me present the SVG file');
  });
});

/**
 * THE CLI IS A MODE, AND ITS ADVERTISED SET NEVER MOVES.
 *
 * the user: "tool being appended mid conversation is fine, but not during cli mode,
 * because during cli mode a tool happening mid conversation is just a little
 * tidbit at the end of the message saying 'user activated <tools>, these are now
 * able to be used via bash'."
 *
 * The reason this matters is measured, not aesthetic: chat templates render
 * tools at the START of the prompt, so any change to the advertised array
 * re-reads the whole conversation. In schemas mode that is the bounded price of
 * a tool the model genuinely could not call. In CLI mode it buys NOTHING — every
 * tool is already a command on PATH (`cliVisibleTools` reads `getAllTools`, not
 * the active set) — so it is a full re-prefill for no capability at all.
 */
describe('CLI mode keeps one advertised tool', () => {
  const OLD = process.env.PI_DESKTOP_TOOL_CLI;
  afterEach(() => {
    if (OLD === undefined) delete process.env.PI_DESKTOP_TOOL_CLI;
    else process.env.PI_DESKTOP_TOOL_CLI = OLD;
  });

  const activate = async (rig: ReturnType<typeof makeRig>, name: string) => {
    const tool = rig.registeredTools.get('capability');
    expect(tool, 'capability was never registered').toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: the rig's tool stub is untyped.
    return (await (tool as any).execute('c1', { name }, undefined, undefined, rig.ctx)) as {
      content: { text: string }[];
    };
  };

  /*
   * The POINT is that the set does not grow — turning a capability on must not
   * move a single token of the prompt. What the set CONTAINS is a separate
   * decision: the user added the file tools back ("otherwise it has to write read
   * and such via bash"), so the assertion is that the set is unchanged, not
   * that it is one particular list.
   */
  it('does not grow the tool set when a capability is turned on', async () => {
    process.env.PI_DESKTOP_TOOL_CLI = '1';
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    const before = rig.activeTools();
    expect(before).toContain('bash');
    expect(before).toContain('read');
    await activate(rig, 'web-research');
    expect(rig.activeTools()).toEqual(before);
  });

  /* ...and says so honestly: nothing is pending, so do not spend a turn
   * announcing it. The schemas wording would cost exactly one reply. */
  it('tells the model the commands are usable in THIS reply', async () => {
    process.env.PI_DESKTOP_TOOL_CLI = '1';
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    const res = await activate(rig, 'web-research');
    const text = res.content.map((c) => c.text).join('');
    expect(text).toContain('available NOW');
    expect(text).not.toContain('NEXT reply');
  });

  /*
   * The other half of the contract: in SCHEMAS mode the set is the class preset,
   * not one pinned tool, and activation reaches the real path — the capability's
   * tools are advertised afterwards whether they were already there or not.
   * Append-only, so whatever came before keeps its position and the prefix up to
   * any addition is still a prefix.
   */
  it('advertises the preset, and the capability, in schemas mode', async () => {
    process.env.PI_DESKTOP_TOOL_CLI = '0';
    const rig = makeRig();
    await startSession(rig);
    await startTurn(rig);
    const before = rig.activeTools();
    expect(before).not.toEqual(['bash']);
    await activate(rig, 'web-research');
    const after = rig.activeTools();
    expect(after).toContain('web_search');
    expect(after).toContain('web_fetch');
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe('the teach skill rides beside a message that asks to learn', () => {
  const skills = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skills-'));
    mkdirSync(path.join(dir, 'teach'));
    writeFileSync(
      path.join(dir, 'teach', 'SKILL.md'),
      '---\nname: teach\n---\n\n# Teach\nSmall steps.\n',
    );
    return dir;
  };

  it('attaches it once, hidden, to a learning request — and never to anything else', async () => {
    const prev = process.env.PI_DESKTOP_SKILLS_DIR;
    process.env.PI_DESKTOP_SKILLS_DIR = skills();
    try {
      const rig = makeRig({ effort: 'medium' });
      const turn = async (prompt: string) => {
        const [res] = (await rig.fire('before_agent_start', {
          type: 'before_agent_start',
          prompt,
          systemPrompt: 'sys',
          images: [],
        })) as Array<
          { message?: { customType: string; content: string; details?: unknown } } | undefined
        >;
        // pi persists the note as a custom message; the rig keeps it the same way.
        if (res?.message !== undefined)
          rig.entries.push({ type: 'custom_message', ...res.message });
        return res?.message;
      };
      expect(await turn('make me a landing page')).toBeUndefined();
      const first = await turn('Show that the pressure of the gas is p = Nmu²/L³ — Fig. 3.1');
      expect(first?.customType).toBe('harness-skill-note');
      expect(first?.content).toContain('<skill_instructions name="teach">\n# Teach\nSmall steps.');
      expect(first?.details).toEqual({ skill: 'teach' });
      // Once per chat: the next learning request goes without it.
      expect(await turn('give me three practice problems like that')).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PI_DESKTOP_SKILLS_DIR;
      else process.env.PI_DESKTOP_SKILLS_DIR = prev;
    }
  });
});
