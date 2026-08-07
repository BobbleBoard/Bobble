import { describe, expect, it } from 'vitest';
import { emptyOrgChart, isOrgChart } from './org-chart.js';
import {
  applyCreateHierarchy,
  CREATE_PRODUCTION_HIERARCHY,
  CREATE_PRODUCTION_HIERARCHY_TOOL,
  type CreateHierarchyArgs,
  createPromotionGuard,
  DEFAULT_PROMOTION_PROJECT_ID,
  HIERARCHY_ALREADY_CREATED_ACK,
  HIERARCHY_CREATED_ACK,
  parseCreateHierarchyArgs,
} from './promotion.js';

describe("the talk_to_manager tool description — the user's wording", () => {
  /*
   * There is no promotion system prompt any more. the user: "max effort just adds
   * this talk to manager tool", and what he wrote is the tool DESCRIPTION —
   * which is the only place it needs to be, because a description is how a
   * model learns when and how to use a tool. Pinned here because the wording is
   * his and a well-meaning rewrite would quietly change the behaviour.
   */
  const DESC = CREATE_PRODUCTION_HIERARCHY_TOOL.function.description;

  it('keeps the per-turn question that decides it', () => {
    expect(DESC).toContain('genuinely quick or should I call in the manager?');
  });

  it('leaves quick work with the model rather than forcing a hand-off', () => {
    expect(DESC).toContain('*genuinely* quick you are still free to do without this tool');
  });

  it('says what you send and what comes back', () => {
    expect(DESC).toContain('you just tell the manager what you want');
    expect(DESC).toContain('a fully made product');
  });

  it('says the job afterwards is testing and iterating, not signing off', () => {
    expect(DESC).toContain('focus on testing this product and iterating with the manager');
  });

  it('frames it as a coordinator with a team, for anything large', () => {
    expect(DESC).toContain('powerful coordinator that has a team of workers');
    expect(DESC).toContain('this should be for anything large');
  });

  it('no longer role-plays a CEO', () => {
    // The identity framing is what made delegating feel compulsory.
    expect(DESC).not.toContain('You are the CEO');
    expect(DESC).not.toContain('Hand this build to your MANAGER');
  });
});

describe('CREATE_PRODUCTION_HIERARCHY_TOOL', () => {
  it('is a well-formed OpenAI function tool taking a MESSAGE', () => {
    const t = CREATE_PRODUCTION_HIERARCHY_TOOL;
    expect(t.type).toBe('function');
    expect(t.function.name).toBe(CREATE_PRODUCTION_HIERARCHY);
    // The surface is a message, not an org-design form — divisions were REQUIRED
    // and that entry fee is what stopped the tool being used at all.
    expect(t.function.parameters).toMatchObject({ required: ['message'] });
    expect(t.function.description.toLowerCase()).toContain('manager');
    expect(t.function.description.toLowerCase()).toContain('manager');
    // …and names the CEO↔manager channel it promises.
    expect(t.function.description).toContain('you just tell the manager what you want');

    const params = t.function.parameters as {
      type: string;
      required: string[];
      properties: Record<string, { type: string; items?: { required?: string[] } }>;
    };
    expect(params.type).toBe('object');
    expect(params.required).toEqual(['message']);
    expect(params.properties.reason?.type).toBe('string');
    expect(params.properties.divisions?.type).toBe('array');
    expect(params.properties.divisions?.items?.required).toEqual(
      expect.arrayContaining(['name', 'purpose']),
    );
  });
});

describe('parseCreateHierarchyArgs', () => {
  it('accepts a well-formed call and trims whitespace', () => {
    const got = parseCreateHierarchyArgs({
      reason: '  too big  ',
      divisions: [{ name: '  Frontend ', purpose: ' the UI ' }],
    });
    expect(got).toMatchObject({
      reason: 'too big',
      divisions: [{ name: 'Frontend', purpose: 'the UI' }],
    });
  });

  it('drops division entries missing a name or purpose but keeps the good ones', () => {
    const got = parseCreateHierarchyArgs({
      reason: 'x',
      divisions: [
        { name: 'Backend', purpose: 'the API' },
        { name: '', purpose: 'no name' },
        { name: 'No purpose' },
        'garbage',
      ],
    });
    expect(got?.divisions).toEqual([{ name: 'Backend', purpose: 'the API' }]);
  });

  it('returns undefined when there is no usable division or the shape is wrong', () => {
    expect(parseCreateHierarchyArgs({ reason: 'x', divisions: [] })).toBeUndefined();
    expect(parseCreateHierarchyArgs({ reason: 'x', divisions: [{ name: '' }] })).toBeUndefined();
    expect(parseCreateHierarchyArgs({ reason: 'x' })).toBeUndefined();
    expect(parseCreateHierarchyArgs(null)).toBeUndefined();
    expect(parseCreateHierarchyArgs('nope')).toBeUndefined();
  });

  it('tolerates a missing reason (defaults to empty) when divisions are valid', () => {
    const got = parseCreateHierarchyArgs({ divisions: [{ name: 'A', purpose: 'p' }] });
    expect(got).toMatchObject({ reason: '', divisions: [{ name: 'A', purpose: 'p' }] });
  });
});

describe('applyCreateHierarchy', () => {
  const args: CreateHierarchyArgs = {
    reason: 'multi-part game',
    divisions: [
      { name: 'Frontend', purpose: 'the UI' },
      { name: '3D Assets', purpose: 'models and textures' },
    ],
  };

  it('builds a valid running chart: CEO + manager block + one node per division', () => {
    const chart = applyCreateHierarchy(null, args);
    expect(isOrgChart(chart)).toBe(true);
    expect(chart.status).toBe('running');
    expect(chart.projectId).toBe(DEFAULT_PROMOTION_PROJECT_ID);

    const ceo = chart.nodes.find((n) => n.role === 'ceo');
    const manager = chart.nodes.find((n) => n.role === 'manager');
    const divisions = chart.nodes.filter((n) => n.role === 'division');
    expect(ceo).toMatchObject({ id: 'ceo', promptId: 'ceo' });
    expect(manager).toMatchObject({ id: 'manager', parentId: 'ceo', promptId: 'manager' });
    expect(divisions).toHaveLength(2);
    // Manager block owns the divisions; purpose is carried as a light extension.
    for (const d of divisions) expect(d.parentId).toBe('manager');
    expect(divisions[0]).toMatchObject({ name: 'Frontend', promptExtension: 'the UI' });
    // Names slugify into readable, collision-free ids.
    expect(divisions[1]?.id).toBe('division-3d-assets');
  });

  it('marks every node idle', () => {
    const chart = applyCreateHierarchy(null, args);
    for (const node of chart.nodes) expect(chart.nodeStatus[node.id]).toBe('idle');
  });

  it('generates collision-free ids for duplicate/blank division names', () => {
    const chart = applyCreateHierarchy(null, {
      reason: 'r',
      divisions: [
        { name: 'Core', purpose: 'a' },
        { name: 'Core', purpose: 'b' },
        { name: '!!!', purpose: 'c' },
      ],
    });
    const ids = chart.nodes.filter((n) => n.role === 'division').map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids).toContain('division-core');
    expect(ids).toContain('division-core-2');
  });

  it('keeps the base project id and never mutates the base chart', () => {
    const base = emptyOrgChart('proj-99');
    const snapshot = structuredClone(base);
    const chart = applyCreateHierarchy(base, args);
    expect(chart.projectId).toBe('proj-99');
    expect(base).toEqual(snapshot); // base untouched (fresh chart built)
    expect(base.nodes).toHaveLength(0);
  });

  it('honors an explicit project id override', () => {
    const chart = applyCreateHierarchy(null, args, 'explicit-id');
    expect(chart.projectId).toBe('explicit-id');
  });
});

describe('createPromotionGuard — idempotent-terminal (J5)', () => {
  const args: CreateHierarchyArgs = { reason: 'r', divisions: [{ name: 'A', purpose: 'a' }] };

  it('the FIRST valid call records the hierarchy and hands it to the manager', () => {
    const guard = createPromotionGuard();
    const first = guard.handle(args);
    expect(first.created).toBe(true);
    expect(first.done).toBe(true);
    expect(first.args).toMatchObject({ reason: 'r', divisions: [{ name: 'A', purpose: 'a' }] });
    expect(first.ack).toBe(HIERARCHY_CREATED_ACK);
    expect(guard.recorded).toEqual(first.args);
  });

  it('a SECOND+ call is an idempotent dead-end: no new hierarchy, no control pass-back', () => {
    const guard = createPromotionGuard();
    guard.handle(args);
    const recorded = guard.recorded;
    const second = guard.handle({ reason: 'other', divisions: [{ name: 'B', purpose: 'b' }] });
    expect(second.created).toBe(false);
    expect(second.done).toBe(true);
    expect(second.args).toBeUndefined();
    expect(second.ack).toBe(HIERARCHY_ALREADY_CREATED_ACK);
    // The recorded hierarchy is UNCHANGED — the second call created nothing.
    expect(guard.recorded).toBe(recorded);
    expect(guard.recorded?.divisions).toEqual([{ name: 'A', purpose: 'a' }]);
  });

  it('an invalid FIRST call records nothing and is not yet terminal (a later valid call still works)', () => {
    const guard = createPromotionGuard();
    const res = guard.handle({ reason: 'x', divisions: [] });
    expect(res.created).toBe(false);
    expect(res.done).toBe(false);
    expect(guard.recorded).toBeUndefined();
    const ok = guard.handle(args);
    expect(ok.created).toBe(true);
    expect(guard.recorded).toBeDefined();
  });

  it('the acks say the manager owns it, without closing the conversation', () => {
    expect(HIERARCHY_CREATED_ACK).toContain('Your manager has it');
    expect(HIERARCHY_CREATED_ACK.toLowerCase()).toContain('do not start building it yourself');
    expect(HIERARCHY_ALREADY_CREATED_ACK.toLowerCase()).toContain('already has this build');
    expect(HIERARCHY_ALREADY_CREATED_ACK.toLowerCase()).toContain('wait for what they deliver');
  });
});

describe('PROMOTION one-shot messaging (J5)', () => {
  it('the description tells it to iterate with the manager afterwards', () => {
    // Replaces the old "conversation, not a form" assertion: same intent — the
    // hand-off is not the end — in the user's wording.
    expect(CREATE_PRODUCTION_HIERARCHY_TOOL.function.description).toContain(
      'iterating with the manager',
    );
  });
});
