import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../effort/effort.js';
import {
  corpToolEnabled,
  PROMOTE_STATUS_KEY,
  type PromoteToolDeps,
  registerCreateHierarchyTool,
} from './promote-tool.js';
import { CREATE_PRODUCTION_HIERARCHY, HIERARCHY_CREATED_ACK } from './promotion.js';

// biome-ignore lint/suspicious/noExplicitAny: minimal structural tool capture for tests
type CapturedTool = any;

/** Register the tool at a given effort and return the captured tool spec.
 * `runCorp` defaults to null — no bridge, i.e. a headless harness. */
function register(effort: EffortLevel, runCorp: PromoteToolDeps['runCorp'] = null): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: CapturedTool) => tools.push(t) } as unknown as ExtensionAPI;
  registerCreateHierarchyTool(pi, {
    getEffort: () => effort,
    nextId: () => 'fixed-id',
    runCorp,
  });
  return tools[0];
}

/** A fake per-turn ctx that captures setStatus publishes. */
function fakeCtx(): { ctx: never; statuses: Record<string, string> } {
  const statuses: Record<string, string> = {};
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (k: string, v: string) => {
        statuses[k] = v;
      },
    },
  } as never;
  return { ctx, statuses };
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

describe('corpToolEnabled', () => {
  /*
   * WAS high/max only. Effort is decided per MESSAGE, so the manager appeared and
   * vanished between turns of one conversation — and since chat templates render
   * the tool list at the START of the prompt, every flip threw away the KV prefix.
   * The gate existed to avoid mid-run changes and was itself the mid-run change.
   * the user: "yes if the talk to tool isn't loaded, load it."
   */
  it('is true at EVERY effort — one prompt, one tool list', () => {
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      expect(corpToolEnabled(effort), effort).toBe(true);
    }
  });
});

describe('create_production_hierarchy — normal-chat tool', () => {
  it('registers under the corp tool name', () => {
    expect(register('max').name).toBe(CREATE_PRODUCTION_HIERARCHY);
  });

  it('at high/max: publishes the promote signal + returns the TERMINAL ack', async () => {
    const tool = register('high');
    const { ctx, statuses } = fakeCtx();
    const res = await tool.execute(
      'c',
      { reason: 'a large multi-part build', divisions: [{ name: 'Frontend', purpose: 'the UI' }] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).not.toBe(true);
    expect(text(res)).toBe(HIERARCHY_CREATED_ACK);
    const signal = JSON.parse(statuses[PROMOTE_STATUS_KEY] ?? '{}');
    expect(signal).toMatchObject({ id: 'fixed-id', reason: 'a large multi-part build' });
    expect(signal.divisions).toHaveLength(1);
  });

  /*
   * A tool that is ADVERTISED and then refuses on a condition the model cannot
   * see is the phantom-tool failure wearing a different hat. It is offered at
   * every effort now, so it must WORK at every effort.
   */
  it('at low effort: works exactly as it does at max — no hidden refusal', async () => {
    const tool = register('low');
    const { ctx, statuses } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'build me a thing', reason: 'x', divisions: [{ name: 'A', purpose: 'b' }] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(statuses[PROMOTE_STATUS_KEY]).toBeDefined();
  });

  it('rejects unusable args (no valid division) without publishing', async () => {
    const tool = register('max');
    const { ctx, statuses } = fakeCtx();
    const res = await tool.execute('c', { reason: 'x', divisions: [] }, undefined, undefined, ctx);
    expect(res.isError).toBe(true);
    expect(statuses[PROMOTE_STATUS_KEY]).toBeUndefined();
  });
});

describe('talk_to_manager BLOCKS until the team delivers', () => {
  /*
   * the user, watching a CEO answer "the manager has accepted the task" in eleven
   * seconds and then build the whole thing itself while the manager sat queued:
   * "the ceo calls the manager, this should stop the CEO cold, and run the
   * manager. the ceo should not get a tool result from the manager until the
   * manager has run everything and is ready to submit the whole working product.
   * as far as the ceo knows they call manager and receive the complete working
   * product."
   */
  it('does not resolve until the production delivers, and returns the PRODUCT', async () => {
    let release: (r: { ok: boolean; product: string }) => void = () => {};
    const pending = new Promise<{ ok: boolean; product: string }>((r) => {
      release = r;
    });
    const tool = register('max', () => pending);
    const { ctx } = fakeCtx();

    let settled = false;
    const call = tool
      .execute('c', { message: 'Build the game', divisions: [] }, undefined, undefined, ctx)
      .then((r: { content: Array<{ type: string; text?: string }> }) => {
        settled = true;
        return r;
      });

    // The team is still working: the CEO's tool call must still be pending.
    await Promise.resolve();
    expect(settled).toBe(false);

    release({ ok: true, product: 'The game is built and runs: 3 platforms, a coin counter.' });
    const res = await call;
    // The tool result IS the delivered product — not an ack about a delegation.
    expect(text(res)).toContain('The game is built and runs');
    expect(text(res)).not.toContain(HIERARCHY_CREATED_ACK);
  });

  it("sends the CEO's OWN words to the manager, not the user's prompt", async () => {
    // The renderer used to start the run from the last USER message, discarding
    // the brief the CEO had just written — so the mesh opened with a second CEO
    // re-deriving a vision that had already been formed.
    let seen = '';
    const tool = register('max', async (req) => {
      seen = req.message;
      return { ok: true, product: 'done' };
    });
    const { ctx } = fakeCtx();
    await tool.execute(
      'c',
      { message: 'A 2D platformer, warm and hand-drawn, three levels.', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(seen).toBe('A 2D platformer, warm and hand-drawn, three levels.');
  });

  it('reports a failed production as a failure instead of a finished product', async () => {
    const tool = register('max', async () => ({ ok: false, product: '', error: 'aborted' }));
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build the game', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('aborted');
  });

  it('without a bridge (headless) still returns the ack — there is no team to await', async () => {
    const tool = register('max');
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build the game', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(text(res)).toBe(HIERARCHY_CREATED_ACK);
  });
});

describe('a refusal is not a product', () => {
  /*
   * MEASURED. The desktop entry named a seat that had been removed, so the mesh
   * answered `(there is no "ceo" to talk to.)` and the run "completed" with that
   * as its product. The final-check scaffold then wrapped it and listed it back
   * to the CEO as claim 1 about the finished work. The CEO concluded the manager
   * was unavailable and built the whole thing itself — shipping a project.godot
   * that degenerated into hundreds of lines of repeated tokens.
   *
   * Wrapping a failure in a verification ceremony launders it.
   */
  it('treats a bare parenthetical refusal as a FAILED hand-off', async () => {
    const tool = register('max', async () => ({
      ok: true,
      product: '(there is no "ceo" to talk to.)',
    }));
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build the game', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('did not complete');
    // The giveaway that this went wrong before: the final-check scaffold.
    expect(text(res)).not.toContain('THIS IS THE FINAL CHECK');
    // And it must not invite the CEO to quietly do the job itself.
    expect(text(res)).toContain('do not quietly build it yourself');
  });

  it('treats an empty delivery as a failure too', async () => {
    const tool = register('max', async () => ({ ok: true, product: '   ' }));
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build the game', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBe(true);
  });

  it('still delivers a real product, with the final check attached', async () => {
    const tool = register('max', async () => ({
      ok: true,
      product: 'Built it: three platforms, a coin counter, and it loads clean in Godot.',
    }));
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build the game', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain('three platforms');
    expect(text(res)).toContain('THIS IS THE FINAL CHECK');
  });
});
