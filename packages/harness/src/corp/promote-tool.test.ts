import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../effort/effort.js';
import type { PlanItem } from '../state.js';
import {
  corpToolEnabled,
  openQuestionsFor,
  PROMOTE_STATUS_KEY,
  type PromoteToolDeps,
  registerCreateHierarchyTool,
  STANDING_START_REFUSAL,
} from './promote-tool.js';
import { CREATE_PRODUCTION_HIERARCHY, HIERARCHY_CREATED_ACK } from './promotion.js';

// biome-ignore lint/suspicious/noExplicitAny: minimal structural tool capture for tests
type CapturedTool = any;

/** Register the tool at a given effort and return the captured tool spec.
 * `runCorp` defaults to null — no bridge, i.e. a headless harness. */
function register(
  effort: EffortLevel,
  runCorp: PromoteToolDeps['runCorp'] = null,
  extra: Partial<PromoteToolDeps> = {},
): CapturedTool {
  const tools: CapturedTool[] = [];
  const pi = { registerTool: (t: CapturedTool) => tools.push(t) } as unknown as ExtensionAPI;
  registerCreateHierarchyTool(pi, {
    getEffort: () => effort,
    nextId: () => 'fixed-id',
    runCorp,
    /* Default: plenty done already, so existing cases are not vetoed. The
       standing-start block overrides it to 0 deliberately. */
    otherToolCalls: () => 5,
    ...extra,
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
    expect(text(res)).toContain('THIS CHECK DECIDES WHETHER YOU CAN ANSWER THE USER');
  });
});

/*
 * A FAILED HAND-OFF IS NOT AN EMPTY WORKSPACE.
 *
 * MEASURED, run 2: the manager exhausted its step budget mid-coordination and
 * never replied, so this tool told the CEO "Nothing was delivered" — over 18
 * source files, 2,452 lines and a clean TypeScript build on disk. The claim was
 * derived from the team's REPLY being empty, which says only that the manager
 * never spoke. The false-completion failure, running backwards; and a false
 * negative costs the same, because it invites the CEO to discard real work.
 */
describe('a failed production reports what is actually on disk', () => {
  const failed = (workspace?: string) => ({
    ok: true,
    product: '(manager ran out of steps after 117 tool calls without ever replying.)',
    ...(workspace !== undefined ? { workspace } : {}),
  });

  /** Run the tool against a corp that comes back with no usable product. */
  const runPromoted = async (result: ReturnType<typeof failed>): Promise<string> => {
    const tool = register('max', async () => result);
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build it', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    return String(res.content?.[0]?.text ?? '');
  };

  it('still says nothing was delivered when the workspace really is empty', async () => {
    const text = await runPromoted(failed());
    expect(text).toContain('Nothing was delivered');
    expect(text).toContain('the hand-off failed');
  });

  it('never says "Nothing was delivered" when there are files', async () => {
    const text = await runPromoted(failed('src/main.ts\nsrc/converters/image-converter.ts'));
    expect(text).not.toContain('Nothing was delivered');
  });

  it('shows the tree and says to carry on from it rather than restart', async () => {
    const text = await runPromoted(failed('src/main.ts\nsrc/converters/image-converter.ts'));
    expect(text).toContain('THE WORK IS STILL THERE');
    expect(text).toContain('src/converters/image-converter.ts');
    expect(text).toMatch(/Do NOT start again/);
    /* Was "ask the manager for a short summary" — which is reading ABOUT the
       product again. A partial hand-off has something on disk to open, so the
       CEO finds out what works by USING it, and the end-user test rides along. */
    expect(text).toMatch(/Open it and use it yourself/);
  });

  /*
   * the user: "the most pragmatic thing to do is after the manager returns any talk
   * to tool call, we put a lot of testing instructions." This branch carried
   * none — it was the one path back to the CEO with no testing pressure at all.
   */
  it('carries the end-user test, like every other return with work on disk', async () => {
    const text = await runPromoted(failed('src/main.ts'));
    expect(text).toMatch(/are not testing/);
    expect(text).toMatch(/visually where it applies/);
    /* Numbered, so the CEO knows whether it reports before or after asking
       again — and told to STOP if the second ask also comes back empty, since
       this branch is reached because the manager already failed once. */
    expect(text).toMatch(/1\. Open it and use it yourself/);
    expect(text).toMatch(/2\. If something is missing or broken/);
    expect(text).toMatch(/stop asking and go to 3/);
    expect(text).toMatch(/3\. Tell the user what you saw with your own eyes/);
    /* RETURN B used to lack the brief entirely — "do the thing they asked" with
       no statement of what that was. */
    expect(text).toContain('WHAT YOU BRIEFED THE TEAM WITH');
  });

  /* Nothing on disk means nothing to open — do not send it hunting. */
  it('omits the end-user test when the workspace is empty', async () => {
    const text = await runPromoted(failed(''));
    expect(text).not.toMatch(/Open it and use it yourself/);
  });

  /* It must still not read as success — that is the other way to get this wrong. */
  it('does not describe the product as finished', async () => {
    const text = await runPromoted(failed('src/main.ts'));
    expect(text).toContain('did not complete');
    expect(text).not.toMatch(/\bfinished\b(?!,)/);
  });
});

describe('the harness counts the hand-backs, because the CEO cannot', () => {
  /*
   * The first-round lean only means anything if something knows which round it
   * is. The CEO's own history may have been compacted by then, and a model
   * asked to remember how many rounds it has had will guess — so the harness
   * counts its own calls.
   */
  const deliver = async (tool: ReturnType<typeof register>): Promise<string> => {
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build it', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    return String(res.content?.[0]?.text ?? '');
  };

  it('leans toward feedback on the first delivery', async () => {
    const tool = register('max', async () => ({
      ok: true,
      product: 'Built it: it converts files.',
    }));
    expect(await deliver(tool)).toMatch(/THIS IS THE FIRST ROUND/);
  });

  it('drops the lean on the second, without the CEO having to remember', async () => {
    const tool = register('max', async () => ({
      ok: true,
      product: 'Built it: it converts files.',
    }));
    await deliver(tool);
    const second = await deliver(tool);
    expect(second).not.toMatch(/THIS IS THE FIRST ROUND/);
    expect(second).toMatch(/Choose 2 only when your list is empty/);
  });
});

describe('a delegation from a standing start is refused, once', () => {
  /*
   * MEASURED across runs 10, 11 and 12. The CEO made exactly ONE tool call —
   * talk_to_manager — off one thought about the task being large, and briefed
   * the manager entirely from its own priors about the product.
   *
   * The instruction to close its unknowns first was in the description the
   * whole time. Moving it to the very top (run 11) changed nothing. Giving the
   * turn real web tools, which it had lacked entirely (run 12), changed nothing
   * either. A model that has decided at the top of a description does not read
   * the rest of it, whatever it says.
   *
   * the user: "veto the first talk to tool call outright… maybe only do that if 0
   * tools have been called prior to the talk to." The `0 tools` clause is what
   * keeps it general: it fires on a fact about the RUN, never on the task.
   */
  const run = async (otherToolCalls: number, calls: { n: number }) => {
    const tool = register(
      'max',
      async () => {
        calls.n += 1;
        return { ok: true, product: 'Built it.' };
      },
      { otherToolCalls: () => otherToolCalls },
    );
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build it', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    return String(res.content?.[0]?.text ?? '');
  };

  it('refuses when nothing at all has been done', async () => {
    const calls = { n: 0 };
    const text = await run(0, calls);
    expect(text).toContain('you have not looked at anything');
    expect(calls.n).toBe(0);
  });

  it('hands back the workflow, not a scolding', async () => {
    const text = await run(0, { n: 0 });
    expect(text).toMatch(/one item per QUESTION you cannot answer/);
    expect(text).toMatch(/Answer them one at a time/);
    expect(text).toMatch(/`files`/);
  });

  /* Anyone who has already looked at something is not stopped. */
  it('lets a CEO through that has actually done something', async () => {
    const calls = { n: 0 };
    const text = await run(3, calls);
    expect(text).not.toContain('you have not looked at anything');
    expect(calls.n).toBe(1);
  });

  /* One refusal, not a wall: the second call runs even from a standing start. */
  it('never refuses twice', async () => {
    const calls = { n: 0 };
    const tool = register(
      'max',
      async () => {
        calls.n += 1;
        return { ok: true, product: 'Built it.' };
      },
      { otherToolCalls: () => 0 },
    );
    const { ctx } = fakeCtx();
    const call = () =>
      tool.execute('c', { message: 'Build it', divisions: [] }, undefined, undefined, ctx);
    await call();
    await call();
    expect(calls.n).toBe(1);
  });
});

describe('the refusal has a stop condition, not just a start', () => {
  /*
   * MEASURED, run 14 (aborted at 4m06s; 58 tool calls, 0 files, 0 delegations).
   * The veto fired and the research DID happen — 3 searches, a fetch of
   * cloudconvert.com, an environment sweep that narrowed properly and found
   * `7zz`. Then it slid: `which ls find` answered at call 28, re-asked at 47;
   * `ls /opt/homebrew/bin/ls` and `ls /opt/homebrew/bin/unzip` each run twice
   * byte-identical. It never wrote down what it was trying to learn, so no
   * answer ever finished anything.
   */
  it('names the checklist, the tool that carries it, and a ceiling on it', () => {
    expect(STANDING_START_REFUSAL).toMatch(/update_plan/);
    expect(STANDING_START_REFUSAL).toMatch(/THREE TO SIX/);
    expect(STANDING_START_REFUSAL).toMatch(/Questions, not build steps/);
  });

  it('closes an answered question so it cannot be re-opened', () => {
    expect(STANDING_START_REFUSAL).toMatch(/A done item is CLOSED/);
    expect(STANDING_START_REFUSAL).toMatch(/Do not check it again/);
  });

  it('says an empty list means come back, and the team finds out the rest', () => {
    expect(STANDING_START_REFUSAL).toMatch(/come\s+straight back here/);
    expect(STANDING_START_REFUSAL).toMatch(/the team finds out the/);
  });
});

describe('unknowns the CEO left open travel with the brief', () => {
  const plan = (rows: readonly [string, PlanItem['status']][]): PlanItem[] =>
    rows.map(([text, status], i) => ({ id: `s${i}`, text, status }));

  it('reports only what is still open, in the CEO’s own words', () => {
    expect(
      openQuestionsFor(
        plan([
          ['What formats does it accept?', 'done'],
          ['How does the queue page look?', 'pending'],
          ['What happens on a failed convert?', 'in_progress'],
        ]),
      ),
    ).toEqual(['How does the queue page look?', 'What happens on a failed convert?']);
  });

  it('is empty when there is no plan at all, so a CEO that kept none is not punished', () => {
    expect(openQuestionsFor(null)).toEqual([]);
    expect(openQuestionsFor(undefined)).toEqual([]);
    expect(openQuestionsFor(plan([['Closed it', 'done']]))).toEqual([]);
  });

  it('puts them in the brief the manager receives, marked as assumption', async () => {
    let seen = '';
    const tool = register(
      'max',
      async (req) => {
        seen = req.message;
        return { ok: true, product: 'Built it.' };
      },
      {
        otherToolCalls: () => 3,
        getPlan: () =>
          plan([
            ['What formats does it accept?', 'done'],
            ['How does the queue page look?', 'pending'],
          ]),
      },
    );
    const { ctx } = fakeCtx();
    await tool.execute(
      'c',
      { message: 'Build LocalConvert', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(seen).toContain('Build LocalConvert');
    expect(seen).toContain('How does the queue page look?');
    expect(seen).toContain('treat the brief as an assumption');
    // The closed one is not repeated back as an open question.
    expect(seen).not.toContain('What formats does it accept?');
  });

  it('leaves the brief untouched when every question was closed', async () => {
    let seen = '';
    const tool = register(
      'max',
      async (req) => {
        seen = req.message;
        return { ok: true, product: 'Built it.' };
      },
      { otherToolCalls: () => 3, getPlan: () => plan([['Closed it', 'done']]) },
    );
    const { ctx } = fakeCtx();
    await tool.execute('c', { message: 'Build it', divisions: [] }, undefined, undefined, ctx);
    expect(seen).toBe('Build it');
  });
});

describe('the CEO is told WHERE the work is', () => {
  /*
   * MEASURED, run 15. The manager exhausted its step budget without replying,
   * so the hand-back said "Nothing was delivered" — over 53 files written by
   * four engineers across 77 minutes. The CEO then went looking in ~/Bobble and
   * /Applications, found nothing, and told the user no code had been produced.
   *
   * Two separate failures: the workspace was not reported at all (the host read
   * module state that was null), and even when it IS reported it is a list of
   * RELATIVE filenames — which is not an address.
   */
  it('names the directory on a partial hand-off, not just the filenames', async () => {
    const tool = register('max', async () => ({
      ok: false,
      product: '',
      error: 'manager ran out of steps after 43 tool calls without ever replying',
      workspace: '/Users/user/bobble-testbed/run15\n  src/core/format_registry.py\n  src/main.js',
    }));
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build LocalConvert', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    const text = String(res.content?.[0]?.text ?? '');
    expect(text).toContain('/Users/user/bobble-testbed/run15');
    expect(text).toMatch(/look HERE and nowhere else/);
    expect(text).toMatch(/THE WORK IS STILL THERE/);
    // And it must NOT tell the CEO nothing was delivered.
    expect(text).not.toMatch(/Nothing was delivered/);
  });

  it('still says nothing was delivered when the workspace really is empty', async () => {
    const tool = register('max', async () => ({
      ok: false,
      product: '',
      error: 'the production ended without delivering',
    }));
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build it', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(String(res.content?.[0]?.text ?? '')).toMatch(/Nothing was delivered/);
  });

  it('gives the address on a SUCCESSFUL hand-off too — verification needs somewhere to look', async () => {
    const tool = register('max', async () => ({
      ok: true,
      product: 'Built LocalConvert. All tests pass.',
      workspace: '/Users/user/bobble-testbed/run16\n  src/main.js',
    }));
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build it', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    const text = String(res.content?.[0]?.text ?? '');
    expect(text).toContain('Built LocalConvert');
    expect(text).toContain('/Users/user/bobble-testbed/run16');
    expect(text).toMatch(/Open it here, not anywhere you think it might be/);
  });

  it('omits the address block entirely when the host could not report one', async () => {
    const tool = register('max', async () => ({ ok: true, product: 'Done.' }));
    const { ctx } = fakeCtx();
    const res = await tool.execute(
      'c',
      { message: 'Build it', divisions: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(String(res.content?.[0]?.text ?? '')).not.toMatch(/THE WORK IS HERE/);
  });
});
