import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { SUBAGENT_DEPTH_ENV } from '../subagent/types.js';
import { createBashFlagger } from './flag-bash.js';
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

describe('registerPermissions — the chat folder, end to end (2026-10-01 student run)', () => {
  /*
   * Each of these put a "Run this command?" card in front of the person in the
   * Ling 3.0 Tiny run. Through the real gate and the real flagger — with a model
   * that would flag anything it was shown — none of them asks now.
   */
  const home = '/private/var/folders/4h/nq1c73q107v594j4g0lq6bw00000gn/T/pd-home-drive-KwuMtn';
  const chat = `${home}/Bobble/hi-im-a-really-visual-learner`;
  const gate = () => {
    const { pi, fire } = fakePi();
    const call = vi.fn(async () => 'DANGEROUS: touches a private system path');
    registerPermissions(pi, {
      initialMode: 'reviewer',
      flagBash: createBashFlagger(call, { folder: () => ({ cwd: chat, roots: [chat] }), home }),
    });
    return { fire, call };
  };

  it.each([
    `bash -c 'ls -la ${chat}/ 2>&1'`,
    `bash -c '\ncat > ${chat}/area_circle_visual.svg << "EOF"\n<svg viewBox="0 0 600 600">\n  <text x="300" y="45`,
    `ls -la ${chat}/circle_area_explanation.svg 2>/dev/null && echo "EXISTS" || echo "NOT FOUND"`,
  ])('no card: %s', async (command) => {
    const { fire, call } = gate();
    const ask = answers('deny');
    expect(await fire(bashEvent(command), ctxWith(ask))).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('a command the rules call scary still asks', async () => {
    const { fire } = gate();
    const ask = answers('deny');
    expect(await fire(bashEvent(`rm -rf ~/Documents`), ctxWith(ask))).toMatchObject({
      block: true,
    });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('a write outside the folder still goes to the model, and its named harm asks', async () => {
    const { fire, call } = gate();
    const ask = answers('deny');
    await fire(bashEvent('echo x >> ~/.zshrc'), ctxWith(ask));
    expect(call).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledOnce();
  });
});
