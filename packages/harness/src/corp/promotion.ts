/**
 * Promotion — the solo→corporation seam (spec §2 "Scope" dial, §4 roles, §12
 * open question 1).
 *
 * A single worker runs solo until a task is too large for one focused pass. The
 * ONLY way it grows a corporation is by calling {@link CREATE_PRODUCTION_HIERARCHY}
 * — the model itself decides scope, the harness never guesses. This module ships
 * the three pure pieces that seam needs:
 *
 *  - the tool DESCRIPTION, which is where the model learns when to use it (there
 *    solo worker when to just do the work vs. when to promote.
 *  - {@link CREATE_PRODUCTION_HIERARCHY_TOOL} — the OpenAI-compatible function
 *    schema the worker calls to promote, naming the divisions it would set up.
 *  - {@link applyCreateHierarchy} — the pure handler that turns that tool call
 *    into a fresh {@link OrgChart} (CEO + manager block + the proposed divisions).
 *
 * Slice-1 scope: promotion + the org-chart it produces only. Dispatch,
 * scheduling, execution, review, and merge are later slices — nothing here runs
 * a worker or mutates a live chart beyond building the initial structure.
 */

import { emptyOrgChart, type OrgChart, type OrgNode } from './org-chart.js';

/**
 * The minimal solo-worker system prompt (spec §2, §12.1). Deliberately tiny: it
 * establishes exactly one judgment — do it, or promote — and nothing about how
 * the corporation works (the worker doesn't need to know). NOT wired into the
 * live chat path in slice 1; used by the test driver and future dispatch.
 */
/*
 * THE CEO TALKS TO THE MANAGER. It does not design a corporation first.
 *
 * the user, watching a max-effort run build a whole game solo with this tool sitting
 * unused in its list: "I thought we renamed the create hierarchy to just be the
 * talk to tool that the original model (which IS the CEO) just talks to the
 * manager with."
 *
 * The old surface was `create_production_hierarchy(reason, divisions[])` — an
 * ORG-DESIGN EXERCISE as the entry fee. Before any work could start the CEO had
 * to invent named divisions with stated purposes, commit one-shot, and then go
 * silent ("output nothing, call no tool after"). Faced with that versus just
 * doing the task, it did the task: measured, a full 2D-platformer request at max
 * effort with this tool advertised produced eight solo turns and zero delegation.
 *
 * And the entry fee was redundant work. The MANAGER's first instruction is
 * literally "YOUR FIRST ACTION IS TO SPLIT THE WORK AND HAND IT OUT" — splitting
 * is its job, done with the whole vision in hand. Charging the CEO for it up
 * front bought nothing and cost the delegation.
 *
 * So the tool is now a message: say what you want built. Divisions stay
 * available for a CEO that genuinely has a shape in mind, and are derived from
 * the message when it does not.
 */
export const TALK_TO_MANAGER = 'talk_to_manager';

/** Back-compat alias — the host, the corp run and the effort gate key off this. */
export const CREATE_PRODUCTION_HIERARCHY = TALK_TO_MANAGER;

/**
 * REMOVED: there is no promotion system prompt any more.
 *
 * the user: "what's 'promotion system prompt' supposed to be... let's remove that,
 * max effort just adds this talk to manager tool" — and the wording he wrote
 * lives on the TOOL DESCRIPTION, which is where a model actually reads when and
 * how to use a tool. A second prompt telling it to be a CEO only made
 * delegating an identity instead of a choice.
 *
 * Max effort now means exactly one thing: the tool is in the list.
 */

/**
 * The system prompt for the SOLO EXECUTION turn — the two lower effort levels, where
 * the corporation is NOT on offer (the create_production_hierarchy tool is withheld).
 * There is no ceremony and no delegation: a single capable agent does the task
 * directly with its tools, the regular-chat behavior. Paired with a full tool
 * allowlist (read/write/bash/web) instead of the hierarchy tool.
 */
export const SOLO_EXECUTION_PROMPT = `You are a highly capable assistant working directly for the user. Do exactly what they asked — completely — using your tools (read, write, bash, and web research) as needed, and produce the finished result in the current workspace.

If it is a build, create the real, working files and make sure they actually run. If it is a question or a piece of research, answer it directly and well. Do the work yourself in this one pass: do not delegate, do not form a formal "vision" document, and do not ask permission to proceed — just do the task and finish.`;

/** The tool name the worker calls to promote itself into a corporation. */

/** A minimal OpenAI-compatible function-tool schema shape (no `any`). */
export interface OpenAiFunctionTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the arguments object. */
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * The `create_production_hierarchy` tool (spec §2 Scope, §4). Passed to the solo
 * worker's turn with `tool_choice: 'auto'`; calling it IS the promotion signal.
 * The description makes the trigger explicit so the model calls it when — and
 * only when — scope demands (spec §12.1).
 */
export const CREATE_PRODUCTION_HIERARCHY_TOOL: OpenAiFunctionTool = {
  type: 'function',
  function: {
    name: CREATE_PRODUCTION_HIERARCHY,
    /*
     * the user's wording, verbatim — he wrote it and asked for it unedited.
     *
     * This is the TOOL DESCRIPTION, which is the only place it needs to live:
     * the tool is simply added to the list at high/max effort, so the
     * description IS how the model learns when and how to use it. There is no
     * separate prompt telling it who to be.
     */
    description:
      "now that you're in max effort mode you are now connected to a manager, the manager is a " +
      'powerful coordinator that has a team of workers at their disposal to help you achieve ' +
      'large projects/goals, if you have something large, that could benefit from handing off ' +
      'and allow you to handle the user requests at a higher level of abstraction, please ' +
      "utilize this tool, this should be for anything large, it's really simple to use, you " +
      'just tell the manager what you want, a spec maybe, or simply the vision you want ' +
      "fufilled, and you'll get back a fully made product, you should then focus on testing " +
      "this product and iterating with the manager until you have fufilled the user's large " +
      'request. anything *genuinely* quick you are still free to do without this tool though. ' +
      "start by asking yourself at each turn, 'genuinely quick or should I call in the " +
      "manager?'. " +
      // the user, 2026-08-09 — what the manager actually takes, in his words. The
      // run-2 manager received a one-line brief ("a Godot game") and spent 36
      // minutes inventing the requirement itself; the vision is the CEO's job.
      'WHAT THE MANAGER TAKES: a planned, fully thought out vision that you lay out ' +
      'conceptually and designed, but with no need for technical instruction. You provide in ' +
      'detail exactly the deliverable you want, and the manager will have it built, so long as ' +
      'you articulate exactly what you want. Be specific about all details. No technical or ' +
      'implementation details are needed however — simply describe what you want done. Decide ' +
      'what the thing IS, what it contains, how it should look and feel, and what would make ' +
      'it good; leave how to build it to the team. ' +
      /*
       * the user's wording, VERBATIM. He wrote it after watching a CEO brief a
       * manager from adjectives alone; the phrasing is his because the point is
       * his — an unknown you did not close is a decision handed to a 4B engineer
       * with less context than you have.
       */
      'From the user prompt, think of all the unknowns you have, and don\'t guess, get ' +
      'concrete. The user asks for something to look a certain way, function a certain way, ' +
      'maybe even feel a certain way, or maybe like something else. Do you know what they ' +
      'mean? Do you have a visual? They ask for something to perform or function like ' +
      'something else — do you know what they\'re referencing? All the unknowns: they say a ' +
      'name you don\'t recognize, something you don\'t quite understand — don\'t ask the user, ' +
      'research it, commission specialists, get informed, and then brief the manager so they ' +
      'can focus on building exactly what you asked for, concretely. Attach any relevant ' +
      'files to the brief that will be useful: assets, references, pieces, rough drafts, ' +
      'block-outs, concepts. The more comprehensive and better you make your brief, the ' +
      'better the result you get will be.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            'What you want built, in your own words — the full vision, in as much detail as you ' +
            'have. This is the brief the manager works from.',
        },
        reason: {
          type: 'string',
          description: 'Optional: why this needs a team rather than a single pass.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Paths to files or folders that belong WITH this brief — references, assets, ' +
            'drafts, concepts, anything you gathered while getting informed. The team can ' +
            'open these; a real file is worth more to them than a description of one.',
        },
        divisions: {
          type: 'array',
          description:
            'OPTIONAL. Only if you already have a shape in mind — one entry per distinct area. ' +
            'Leave it out and the manager splits the work itself, which is its job.',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Short division name, e.g. "Frontend", "Storyline", "3D Assets".',
              },
              purpose: {
                type: 'string',
                description: 'What this division is responsible for producing.',
              },
            },
            required: ['name', 'purpose'],
          },
        },
      },
      required: ['message'],
    },
  },
};

/** One proposed division from a {@link CREATE_PRODUCTION_HIERARCHY} call. */
export interface HierarchyDivisionSpec {
  readonly name: string;
  readonly purpose: string;
}

/** The validated arguments of a {@link CREATE_PRODUCTION_HIERARCHY} call. */
export interface CreateHierarchyArgs {
  readonly reason: string;
  /** What the CEO actually asked the manager to build — the brief. Optional so
   * existing constructors (and a divisions-only call) stay valid. */
  readonly message?: string;
  readonly divisions: readonly HierarchyDivisionSpec[];
}

/**
 * Validate raw (JSON-decoded) tool-call arguments into {@link CreateHierarchyArgs},
 * or `undefined` if unusable. Tolerant of the small-model quirks that matter:
 * trims strings, drops division entries missing a name/purpose, and requires at
 * least one usable division (a promotion with no divisions is meaningless).
 */
export function parseCreateHierarchyArgs(raw: unknown): CreateHierarchyArgs | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const message = typeof obj.message === 'string' ? obj.message.trim() : '';
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  const divisions: HierarchyDivisionSpec[] = [];
  if (Array.isArray(obj.divisions)) {
    for (const d of obj.divisions) {
      if (d === null || typeof d !== 'object') continue;
      const entry = d as Record<string, unknown>;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const purpose = typeof entry.purpose === 'string' ? entry.purpose.trim() : '';
      if (name === '' || purpose === '') continue;
      divisions.push({ name, purpose });
    }
  }
  /*
   * A MESSAGE IS ENOUGH. This used to require a non-empty `divisions[]` and
   * reject anything else, which made handing work over an org-design exercise —
   * see the note on TALK_TO_MANAGER. Splitting the work is the MANAGER's first
   * instruction, so when the CEO has not named divisions we create the one team
   * that covers the brief and let the manager divide it with the whole vision in
   * hand.
   *
   * A call with neither a message nor divisions is still rejected: that is a
   * genuinely empty hand-off and the manager would have nothing to work from.
   */
  if (message === '' && divisions.length === 0) return undefined;
  if (divisions.length === 0) {
    divisions.push({ name: 'Production', purpose: message });
  }
  return { reason: reason !== '' ? reason : message, message, divisions };
}

// --- Idempotent-terminal promotion guard (J5) --------------------------------
//
// LIVE DEFECT this fixes: the CEO/worker called `create_production_hierarchy`
// TWICE ("created multiple production hierarchies"), then thrashed ("I already
// called it twice, this seems wrong"). The cure mirrors the F1 `submit_contract`
// fix: the FIRST valid call RECORDS the hierarchy and is TERMINAL (the ack tells
// the model it is DONE — output nothing, call no tool after); every later call is
// an IDEMPOTENT DEAD-END that creates no second hierarchy/divisions and never
// passes control back. Two layers enforce this:
//   1. Prompt/description (above) + the `terminal` flag on the promotion custom
//      tool (run.ts) — the seam ends the turn after the first call.
//   2. This guard — the harness only ever acts on the FIRST valid call, so even a
//      model that emits the tool twice in one reply yields exactly ONE hierarchy.

/** The TERMINAL ack for the FIRST `create_production_hierarchy` call — the model
 * is done the instant the hierarchy exists (mirrors the F1 submit_contract ack). */
export const HIERARCHY_CREATED_ACK =
  'Your manager has it. They are splitting the work across their engineers now and will ' +
  'deliver the finished product back to you for review. Nothing more is needed from you on ' +
  'this call — do not start building it yourself in parallel.';

/** The IDEMPOTENT DEAD-END ack for a SECOND+ `create_production_hierarchy` call:
 * it created nothing (the hierarchy already exists) and does not pass control back. */
/*
 * Says only what is TRUE. This told the model "you are DONE: output nothing and
 * call no further tool", which reads as the channel being closed — and the CEO
 * still has a job after delegating (it reviews what comes back against what the
 * user asked for). It no longer implies the conversation is over, and it does
 * not promise a second message will reach the manager either, because on this
 * path it does not.
 */
export const HIERARCHY_ALREADY_CREATED_ACK =
  'Your manager already has this build — the repeat call changed nothing and created no second ' +
  'team. They are still working; wait for what they deliver rather than re-sending or starting ' +
  'it yourself.';

/** The outcome of feeding ONE `create_production_hierarchy` call to a guard. */
export interface PromotionCallResult {
  /** True ONLY for the first valid call — it recorded the hierarchy. */
  readonly created: boolean;
  /** The validated args of the recorded (first valid) call; undefined otherwise. */
  readonly args?: CreateHierarchyArgs;
  /** The terminal/dead-end ack to return to the model for THIS call. */
  readonly ack: string;
  /** True once a hierarchy has been recorded — any call from here on is a dead-end. */
  readonly done: boolean;
}

/** A stateful, idempotent-terminal guard around {@link CREATE_PRODUCTION_HIERARCHY}. */
export interface PromotionGuard {
  /**
   * Handle one call's raw (JSON-decoded) arguments. The FIRST call whose args
   * validate records the hierarchy and returns {@link HIERARCHY_CREATED_ACK}
   * (`created: true`). Every call after that — valid or not — is an idempotent
   * dead-end returning {@link HIERARCHY_ALREADY_CREATED_ACK} (`created: false`,
   * `done: true`), creating NO second hierarchy. A call BEFORE any hierarchy is
   * recorded whose args do not validate is a no-op (`created: false, done: false`).
   */
  handle(raw: unknown): PromotionCallResult;
  /** The recorded hierarchy args (from the first valid call), or undefined. */
  readonly recorded: CreateHierarchyArgs | undefined;
}

/** Create a fresh {@link PromotionGuard}. One guard per worker/CEO promotion turn. */
export function createPromotionGuard(): PromotionGuard {
  let recorded: CreateHierarchyArgs | undefined;
  return {
    get recorded(): CreateHierarchyArgs | undefined {
      return recorded;
    },
    handle(raw: unknown): PromotionCallResult {
      // Already recorded → an idempotent terminal dead-end (no second hierarchy,
      // control never passes back).
      if (recorded !== undefined) {
        return { created: false, ack: HIERARCHY_ALREADY_CREATED_ACK, done: true };
      }
      const args = parseCreateHierarchyArgs(raw);
      if (args === undefined) {
        // Not a usable promotion yet — nothing recorded, not terminal.
        return { created: false, ack: HIERARCHY_ALREADY_CREATED_ACK, done: false };
      }
      recorded = args;
      return { created: true, args, ack: HIERARCHY_CREATED_ACK, done: true };
    },
  };
}

/** Fallback project id when {@link applyCreateHierarchy} is given no base chart
 * and no explicit id (e.g. the standalone test driver). */
export const DEFAULT_PROMOTION_PROJECT_ID = 'project';

/** Fixed node ids for the two permanent roles (spec §4). */
const CEO_NODE_ID = 'ceo';
const MANAGER_NODE_ID = 'manager';

/** Slugify a division name into an id fragment (`"3D Assets"` → `"3d-assets"`). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build a fresh {@link OrgChart} from a {@link CREATE_PRODUCTION_HIERARCHY} call:
 * a CEO node, the permanent manager block below it, and one `division` node per
 * proposed division (parented to the manager, its `purpose` carried as a light
 * prompt extension — the contract, not the prompt, will govern the work). All
 * nodes start `idle`; the chart's run status becomes `running` because a
 * corporation now exists (there is no distinct "promoted-but-idle" state, and
 * dispatch is a later slice).
 *
 * Pure: reuses the corp types + {@link emptyOrgChart}, builds a brand-new chart,
 * and never mutates `base`. When `base` is provided its `projectId` is kept
 * (re-promotion of an existing project); otherwise `projectId` (or
 * {@link DEFAULT_PROMOTION_PROJECT_ID}) is used.
 */
export function applyCreateHierarchy(
  base: OrgChart | null,
  args: CreateHierarchyArgs,
  projectId: string = base?.projectId ?? DEFAULT_PROMOTION_PROJECT_ID,
): OrgChart {
  const chart = emptyOrgChart(projectId);

  const nodes: OrgNode[] = [
    { id: CEO_NODE_ID, role: 'ceo', name: 'CEO', promptId: 'ceo' },
    {
      id: MANAGER_NODE_ID,
      role: 'manager',
      name: 'Manager block',
      parentId: CEO_NODE_ID,
      promptId: 'manager',
    },
  ];

  const usedIds = new Set<string>([CEO_NODE_ID, MANAGER_NODE_ID]);
  args.divisions.forEach((division, index) => {
    const slug = slugify(division.name);
    // Deterministic, collision-free ids even for blank/duplicate names.
    let id = `division-${slug === '' ? index + 1 : slug}`;
    let bump = 2;
    while (usedIds.has(id)) {
      id = `division-${slug === '' ? index + 1 : slug}-${bump}`;
      bump += 1;
    }
    usedIds.add(id);
    nodes.push({
      id,
      role: 'division',
      name: division.name,
      parentId: MANAGER_NODE_ID,
      // No archetype resolution in slice 1: carry the model's purpose as a light
      // extension over the generic base. The manager's contracts govern regardless.
      promptExtension: division.purpose,
    });
  });

  const nodeStatus: Record<string, 'idle'> = {};
  for (const node of nodes) nodeStatus[node.id] = 'idle';

  return {
    ...chart,
    nodes,
    status: 'running',
    nodeStatus,
  };
}
