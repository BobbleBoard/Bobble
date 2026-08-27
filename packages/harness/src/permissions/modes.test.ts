import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { SUBAGENT_DEPTH_ENV } from '../subagent/types.js';
import { evaluateToolCall, registerPermissions } from './modes.js';

describe('evaluateToolCall — pure policy', () => {
  it('bypass allows everything', () => {
    expect(evaluateToolCall({ mode: 'bypass', toolName: 'bash', bashCommand: 'rm -rf /' })).toEqual(
      {
        action: 'allow',
      },
    );
  });

  it('review-all confirms every tool', () => {
    expect(evaluateToolCall({ mode: 'review-all', toolName: 'read' }).action).toBe('confirm');
    expect(
      evaluateToolCall({ mode: 'review-all', toolName: 'bash', bashCommand: 'ls' }).action,
    ).toBe('confirm');
  });

  it('reviewer allows non-bash tools', () => {
    expect(evaluateToolCall({ mode: 'reviewer', toolName: 'read' }).action).toBe('allow');
  });

  it('reviewer allows safe bash', () => {
    expect(
      evaluateToolCall({ mode: 'reviewer', toolName: 'bash', bashCommand: 'ls -la' }).action,
    ).toBe('allow');
  });

  it('reviewer confirms scary bash (via rules)', () => {
    const d = evaluateToolCall({ mode: 'reviewer', toolName: 'bash', bashCommand: 'rm -rf /' });
    expect(d.action).toBe('confirm');
  });

  it('reviewer honours an injected scaryReason override', () => {
    // Rules would allow this, but the model hook flagged it.
    const d = evaluateToolCall({
      mode: 'reviewer',
      toolName: 'bash',
      bashCommand: 'ls -la',
      scaryReason: 'model flagged: exfiltration attempt',
    });
    expect(d.action).toBe('confirm');
    // And an explicit null override forces allow.
    expect(
      evaluateToolCall({
        mode: 'reviewer',
        toolName: 'bash',
        bashCommand: 'rm -rf /',
        scaryReason: null,
      }).action,
    ).toBe('allow');
  });
});

// --- Event-wiring harness ---------------------------------------------------

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined;

function fakePi() {
  let handler: ToolCallHandler | undefined;
  let onSessionStart: (() => void) | undefined;
  const pi = {
    on: (event: string, h: ToolCallHandler) => {
      if (event === 'tool_call') handler = h;
      // The gate clears its per-chat grants here; pi fires it on a new session
      // AND on a switch, which is what makes "this chat" mean this chat.
      if (event === 'session_start') onSessionStart = h as unknown as () => void;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    fire: (e: ToolCallEvent, ctx: ExtensionContext) => handler?.(e, ctx),
    fireSessionStart: () => onSessionStart?.(),
  };
}

function bashEvent(command: string): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 't1',
    toolName: 'bash',
    input: { command },
  } as ToolCallEvent;
}
function readEvent(): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 't2',
    toolName: 'read',
    input: { path: '/x' },
  } as ToolCallEvent;
}
/**
 * A context whose prompt answers with one of the THREE permission answers.
 *
 * The gate moved off `ctx.ui.confirm` (a boolean — two outcomes for a decision
 * with three) onto `ctx.ui.input` behind a sentinel, so the stub is an `input`
 * returning 'once' | 'session' | 'deny'.
 */
function ctxWith(
  input: (title: string, placeholder: string) => Promise<string>,
  hasUI = true,
): ExtensionContext {
  return { hasUI, ui: { input } } as unknown as ExtensionContext;
}
const answers = (a: 'once' | 'session' | 'deny') => vi.fn(async () => a);

describe('registerPermissions — the session grant', () => {
  it('stops asking about the same call once allowed for the chat', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'reviewer' });
    const ask = answers('session');
    await fire(bashEvent('rm -rf /'), ctxWith(ask));
    const again = await fire(bashEvent('rm -rf /'), ctxWith(ask));
    expect(ask).toHaveBeenCalledOnce();
    expect(again).toBeUndefined();
  });

  it('still asks about a DIFFERENT command', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'reviewer' });
    const ask = answers('session');
    await fire(bashEvent('rm -rf ~'), ctxWith(ask));
    await fire(bashEvent('rm -rf /'), ctxWith(ask));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('"once" grants nothing beyond that call', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'reviewer' });
    const ask = answers('once');
    await fire(bashEvent('rm -rf /'), ctxWith(ask));
    await fire(bashEvent('rm -rf /'), ctxWith(ask));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('a new chat does not inherit the grant', async () => {
    /*
     * THE HAZARD THIS EXISTS FOR. The set lives in the closure of a pi CHILD,
     * and the child outlives a chat — neither a new chat nor a switch respawns
     * it. Without clearing on session_start, allowing a destructive command in
     * a scratch project would leave it allowed in the user's real one.
     */
    const { pi, fire, fireSessionStart } = fakePi();
    registerPermissions(pi, { initialMode: 'reviewer' });
    const ask = answers('session');
    await fire(bashEvent('rm -rf /'), ctxWith(ask));
    fireSessionStart();
    await fire(bashEvent('rm -rf /'), ctxWith(ask));
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

describe('registerPermissions — event gating', () => {
  it('bypass never blocks', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'bypass' });
    const confirm = answers('deny');
    const res = await fire(bashEvent('rm -rf /'), ctxWith(confirm));
    expect(res).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reviewer blocks scary bash when the user declines', async () => {
    const { pi, fire } = fakePi();
    const onBlock = vi.fn();
    registerPermissions(pi, { initialMode: 'reviewer', onBlock });
    const confirm = answers('deny');
    const res = await fire(bashEvent('rm -rf /'), ctxWith(confirm));
    expect(confirm).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ block: true });
    expect(onBlock).toHaveBeenCalled();
  });

  it('reviewer allows scary bash when the user approves', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'reviewer' });
    const res = await fire(bashEvent('rm -rf /'), ctxWith(answers('once')));
    expect(res).toBeUndefined();
  });

  it('reviewer allows safe bash without confirming', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'reviewer' });
    const confirm = answers('once');
    const res = await fire(bashEvent('ls -la'), ctxWith(confirm));
    expect(confirm).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it('reviewer consults the injected model flagger for otherwise-safe bash', async () => {
    const { pi, fire } = fakePi();
    const flagBash = vi.fn(async () => 'model flagged: suspicious');
    registerPermissions(pi, { initialMode: 'reviewer', flagBash });
    const confirm = answers('deny');
    const res = await fire(bashEvent('curl https://example.com'), ctxWith(confirm));
    expect(flagBash).toHaveBeenCalled();
    expect(res).toMatchObject({ block: true });
  });

  it('review-all confirms even read', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'review-all' });
    const confirm = answers('once');
    await fire(readEvent(), ctxWith(confirm));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('setMode switches behaviour at runtime', async () => {
    const { pi, fire } = fakePi();
    const ctrl = registerPermissions(pi, { initialMode: 'bypass' });
    const confirm = answers('deny');
    expect(await fire(bashEvent('rm -rf /'), ctxWith(confirm))).toBeUndefined();
    ctrl.setMode('reviewer');
    expect(await fire(bashEvent('rm -rf /'), ctxWith(confirm))).toMatchObject({ block: true });
    expect(ctrl.getMode()).toBe('reviewer');
  });

  it('fails safe (blocks) when a confirm is required but no UI is available', async () => {
    const { pi, fire } = fakePi();
    registerPermissions(pi, { initialMode: 'review-all' });
    const res = await fire(readEvent(), ctxWith(answers('once'), false));
    expect(res).toMatchObject({ block: true });
  });

  // SB-3: a spawned child pi reports hasUI === true but has no human to answer,
  // so a confirm-required call must block (not await ctx.ui.confirm and hang).
  it('fails safe (blocks) in a subagent even though hasUI is true', async () => {
    const prev = process.env[SUBAGENT_DEPTH_ENV];
    process.env[SUBAGENT_DEPTH_ENV] = '1';
    try {
      const { pi, fire } = fakePi();
      registerPermissions(pi, { initialMode: 'review-all' });
      const confirm = answers('once');
      const res = await fire(readEvent(), ctxWith(confirm, true));
      expect(res).toMatchObject({ block: true });
      // The human-less subagent was never prompted.
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env[SUBAGENT_DEPTH_ENV];
      else process.env[SUBAGENT_DEPTH_ENV] = prev;
    }
  });
});
