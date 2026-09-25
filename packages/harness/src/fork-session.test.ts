/**
 * A FORK IS THE SAME CONVERSATION — the harness must treat it as one.
 *
 * pi's `fork` (editing a message; taking one back with ⌘Z) puts the chat on a
 * branch: a new session file and a NEW wiring of this extension. Two things
 * leaked across that boundary and each cost the next message its prompt cache
 * or worse — MEASURED on a real model by apps/desktop/tests/e2e/
 * unsend-prefill-probe.mjs:
 *
 *  1. the new wiring rebuilt the system prompt from what it had, and it
 *     disagreed with the frozen one about the working folder — dropping the
 *     name (first difference at char 6,685, the whole prompt re-read) or, when
 *     handed only the folder, adding one the session never had (193 tokens);
 *  2. the old wiring's post-turn naming still fired 2.5 s later, sending the
 *     conversation WITH the taken-back message onto the model slot.
 *
 * Each wiring here is a separate `wireHarness` over its own fake pi, exactly as
 * pi re-imports the extension per session; what survives between them is what
 * survives in the real process.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolInfo,
} from '@mariozechner/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type StoredEntryLike, wireHarness } from './index.js';
import type { CallModel } from './model-call/call-model.js';

/** pi's own base prompt ends with these two lines; the harness rewrites the second. */
const BASE_PROMPT =
  'You are a helpful coding agent.\n\nCurrent date: 2026-09-24\nCurrent working directory: /boot';

// biome-ignore lint/suspicious/noExplicitAny: event handler shape varies per event.
type AnyHandler = (event: any, ctx: any) => any;

function wiring(options: { callModel?: CallModel } = {}) {
  const handlers = new Map<string, AnyHandler[]>();
  const entries: StoredEntryLike[] = [];
  let command:
    | { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    | undefined;
  let activeTools: string[] = [];
  const pi = {
    on: (event: string, h: AnyHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
    registerTool: () => {},
    registerCommand: (
      _name: string,
      opts: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => {
      command = opts;
    },
    getAllTools: (): ToolInfo[] =>
      ['read', 'bash'].map((name) => ({
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
  } as unknown as ExtensionAPI;
  const setStatus = vi.fn();
  const ctx = {
    hasUI: true,
    cwd: '/boot',
    ui: { notify: vi.fn(), setStatus, confirm: vi.fn(async () => true) },
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
    getSystemPrompt: () => BASE_PROMPT,
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionContext & ExtensionCommandContext;
  const handle = wireHarness(pi, {
    ...(options.callModel !== undefined ? { callModel: options.callModel } : {}),
    postTurnDelayMs: 50,
  });
  const fire = (event: string, e: unknown) =>
    Promise.all((handlers.get(event) ?? []).map((h) => h(e, ctx)));
  type TurnResult = { systemPrompt?: string; message?: { customType?: string } };
  const turn = async (): Promise<TurnResult> => {
    const [res] = (await fire('before_agent_start', {
      type: 'before_agent_start',
      prompt: 'Name three fruits.',
      systemPrompt: BASE_PROMPT,
      systemPromptOptions: {},
    })) as Array<TurnResult | undefined>;
    return res ?? {};
  };
  const turnPrompt = async (): Promise<string> => (await turn()).systemPrompt ?? '';
  return {
    fire,
    handle,
    ctx,
    turn,
    turnPrompt,
    workspace: (dir: string) => command?.handler(`workspace ${dir}`, ctx),
    folder: () => handle.getStatus(ctx).workspaceRoot as string | null | undefined,
  };
}

describe('a fork is the same session continued', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('frozen WITH the folder: the branch sends that prompt, byte for byte', async () => {
    const before = wiring();
    await before.fire('session_start', { type: 'session_start', reason: 'startup' });
    await before.workspace('/Users/j/Bobble/name-three-fruits');
    const frozen = await before.turnPrompt();
    expect(frozen).toContain('`name-three-fruits`');

    const after = wiring();
    await after.fire('session_start', { type: 'session_start', reason: 'fork' });
    expect(after.folder()).toBe('/Users/j/Bobble/name-three-fruits');
    // MEASURED before this: the branch dropped the folder's name and the next
    // message re-read its whole prompt.
    expect(await after.turnPrompt()).toBe(frozen);
  });

  it('frozen WITHOUT it (the folder came later, as a note): the branch keeps it that way', async () => {
    const before = wiring();
    await before.fire('session_start', { type: 'session_start', reason: 'startup' });
    // The first turn froze the prompt before the chat had a folder…
    const frozen = await before.turnPrompt();
    expect(frozen).not.toContain('`name-three-fruits`');
    // …which then arrived and was announced once, beside the next message.
    await before.workspace('/Users/j/Bobble/name-three-fruits');
    expect((await before.turn()).message?.customType).toBe('harness-workspace');

    const after = wiring();
    await after.fire('session_start', { type: 'session_start', reason: 'fork' });
    const branchTurn = await after.turn();
    // MEASURED before this: handed only the folder, the branch NAMED it — the
    // same divergence the other way, 193 tokens re-read.
    expect(branchTurn.systemPrompt).toBe(frozen);
    // …and the model is not told about the folder a second time.
    expect(branchTurn.message).toBeUndefined();
    expect(after.folder()).toBe('/Users/j/Bobble/name-three-fruits');
  });

  it('any other session boundary is another chat: it starts from nothing', async () => {
    const first = wiring();
    await first.fire('session_start', { type: 'session_start', reason: 'startup' });
    await first.workspace('/Users/j/Bobble/chat-a');
    await first.turnPrompt();
    const other = wiring();
    await other.fire('session_start', { type: 'session_start', reason: 'resume' });
    expect(other.folder() ?? null).toBeNull();
    expect(await other.turnPrompt()).not.toContain('`chat-a`');
    // …and a fork of THAT chat does not resurrect the previous chat's folder.
    const branch = wiring();
    await branch.fire('session_start', { type: 'session_start', reason: 'fork' });
    expect(branch.folder() ?? null).toBeNull();
    expect(await branch.turnPrompt()).not.toContain('`chat-a`');
  });
});

describe('a fork cancels the post-turn work of the turn it rewound', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const endTurn = async (w: ReturnType<typeof wiring>) => {
    await w.fire('session_start', { type: 'session_start', reason: 'startup' });
    await w.turnPrompt();
    await w.fire('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', content: '', stopReason: 'aborted' }],
    });
  };

  it('no naming request goes out for the taken-back turn', async () => {
    const callModel = vi.fn(async () => '{"title":"Countries"}');
    const w = wiring({ callModel });
    await endTurn(w);
    await w.fire('session_shutdown', { type: 'session_shutdown', reason: 'fork' });
    await vi.advanceTimersByTimeAsync(200);
    expect(callModel).not.toHaveBeenCalled();
  });

  it('switching chats leaves it to finish, as before', async () => {
    const callModel = vi.fn(async () => '{"title":"Countries"}');
    const w = wiring({ callModel });
    await endTurn(w);
    await w.fire('session_shutdown', { type: 'session_shutdown', reason: 'resume' });
    await vi.advanceTimersByTimeAsync(200);
    expect(callModel).toHaveBeenCalled();
  });
});
