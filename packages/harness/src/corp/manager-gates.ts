/**
 * The manager's two gates: THINK FIRST, and TOOLS ONLY WHEN YOU NEED THEM.
 *
 * The user, 2026-08-09, after reading the run-2 trace where the manager delegated
 * ten near-identical contracts and did the engineering itself:
 *
 *   "manager is asked to brainstorm contracts to text files and rigorously
 *   review and iterate and really make sure it is ready to go before it
 *   contracts the engineers, it is given a tool, called ready to delegate, the
 *   contract tools are loaded beforehand, but if called before calling ready to
 *   delegate, they return 'ensure you have mentally concrete plan before
 *   submitting, when ready to delegate, call the tool and delegate tasks'."
 *
 *   "why don't we keep manager context really clean only give it specialist/
 *   talk to engineer tools until after it wants to test, then it calls a tool
 *   where it requests tools to test the project from a list."
 *
 * WHY GATES RATHER THAN MORE PROMPT. The manager prompt already says, at
 * length, to plan before delegating and not to build the product itself. It did
 * both anyway. A rule the model must remember to follow competes with every
 * other rule in a long prompt; a tool that answers "not yet, and here is what to
 * do instead" is enforced whether or not the model was paying attention — and
 * the refusal text arrives exactly when it is relevant.
 *
 * WHY THE CONTRACT TOOLS ARE STILL ADVERTISED BEFORE THE GATE OPENS. Removing
 * them would be worse: an unadvertised tool the model wants does not stop being
 * wanted, it gets approximated by the nearest advertised one (grammar coercion —
 * llama-server pins the emitted name to the advertised list). Better that
 * `talk_to` exists, is called, and answers with the redirect.
 */

/** Opens delegation. Until this is called, the contract tools refuse. */
export const READY_TO_DELEGATE_TOOL = 'ready_to_delegate';

/** Asks for the kit needed to TEST, once the build has settled. */
export const REQUEST_TEST_TOOLS_TOOL = 'request_test_tools';

/** What a contract tool returns when called before the plan is settled. */
export const NOT_READY_TO_DELEGATE =
  'ensure you have mentally concrete plan before submitting, when ready to ' +
  'delegate, call the tool and delegate tasks';

/** What `ready_to_delegate` returns. */
export const DELEGATION_ACTIVATED = 'delegation tools activated';

/** The kits a manager may ask for, and what each is for. */
export const TEST_TOOL_KITS = {
  browser: {
    label: 'browser',
    summary: 'Open the product on a screen, read the page, click, type, capture.',
    tools: [
      'browser_navigate',
      'browser_read',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      // `browser_screenshot` was named here and registered nowhere; the
      // snapshot is the model's eyes (browser-use/tool-names).
      'browser_scroll',
    ],
  },
  shell: {
    label: 'command line / python',
    summary: 'Run the product, run scripts against it, read what it printed.',
    tools: ['bash'],
  },
  computer_use: {
    label: 'mac computer use',
    summary: 'Drive a real macOS app the way a person would, and look at it.',
    tools: ['computer_use'],
  },
  files: {
    label: 'file manipulation',
    summary:
      'Read, write and edit files — make test INPUTS, fix a fixture, inspect ' +
      'what the product produced.',
    tools: ['read', 'ls', 'grep', 'find', 'write', 'edit'],
  },
} as const;

export type TestToolKit = keyof typeof TEST_TOOL_KITS;
export const TEST_TOOL_KIT_NAMES = Object.keys(TEST_TOOL_KITS) as TestToolKit[];

/** One requested kit: which, and why it is needed. */
export interface KitRequest {
  readonly kit: string;
  readonly why?: string;
}

/**
 * Resolve requested kits to a flat, de-duplicated tool list.
 *
 * Accepts a bare name or a `{kit, why}` object. The REASON is deliberately not
 * validated and nothing is ever done with it — the user: "this is never checked by
 * the harness, nothing is ever done with it, but keeping it as an input
 * implicitly combats the model asking for everything every time for no reason."
 * Having to write a justification per kit is the whole mechanism; enforcing it
 * would only teach the model to write a better-looking one.
 */
export function toolsForKits(kits: readonly (string | KitRequest)[]): string[] {
  const out = new Set<string>();
  for (const entry of kits) {
    const name = typeof entry === 'string' ? entry : entry?.kit;
    const kit = TEST_TOOL_KITS[name as TestToolKit];
    if (kit === undefined) continue;
    for (const t of kit.tools) out.add(t);
  }
  return [...out];
}

/** The menu, rendered for the tool description so the model sees the options. */
export function testToolMenu(): string {
  return TEST_TOOL_KIT_NAMES.map(
    (k) => `  ${k} — ${TEST_TOOL_KITS[k].label}: ${TEST_TOOL_KITS[k].summary}`,
  ).join('\n');
}

/**
 * The manager's starting kit: talk to the team, commission a specialist, think
 * on paper, and open the gates. Deliberately NO bash and NO browser — those
 * arrive through {@link REQUEST_TEST_TOOLS_TOOL} when there is something to test.
 *
 * `write`/`edit` are absent for the same reason they always were: the product
 * belongs to the engineers. `write` here is scoped by the workspace fence to the
 * manager's own `.scratch/`, which is where the brainstormed contracts go.
 */
export const MANAGER_PLANNING_TOOLS = ['read', 'ls', 'write'] as const;

/** The `ready_to_delegate` tool, as advertised to the manager. */
export const READY_TO_DELEGATE_DEFINITION = {
  type: 'function' as const,
  function: {
    name: READY_TO_DELEGATE_TOOL,
    description:
      'Call this when your plan is CONCRETE and you are ready to hand work out. ' +
      'Before this, brainstorm the contracts into files in your .scratch/ — write ' +
      'them, read them back, and iterate until each one names what to build, the ' +
      'exact files it owns, what it must DO before it comes back, and the evidence ' +
      'you want with it. Rigorously review your own contracts first: a vague ' +
      'contract is the cheapest way to waste an engineer. Calling this activates ' +
      'the delegation tools; until then they will refuse and remind you.',
    parameters: {
      type: 'object',
      properties: {
        plan_summary: {
          type: 'string',
          description:
            'One line per piece of work you are about to hand out, and who gets it. ' +
            'If you cannot write this list, you are not ready.',
        },
      },
      required: ['plan_summary'],
    },
  },
};

/** The `request_test_tools` tool, as advertised to the manager. */
export const REQUEST_TEST_TOOLS_DEFINITION = {
  type: 'function' as const,
  function: {
    name: REQUEST_TEST_TOOLS_TOOL,
    description:
      'Request the tools you will use to TEST the project. This is only for ' +
      'testing purposes: call it after all engineers are finished on a given ' +
      'task, when the project is settled — not while work is still landing. ' +
      'Take all of them, a few, or one. Options:\n' +
      testToolMenu(),
    parameters: {
      type: 'object',
      properties: {
        kits: {
          type: 'array',
          description:
            'The kits you want, each with the reason you need it. Ask for what you ' +
            'will actually use.',
          items: {
            type: 'object',
            properties: {
              kit: { type: 'string', enum: TEST_TOOL_KIT_NAMES },
              why: {
                type: 'string',
                description:
                  'One short line: why THIS toolset is necessary for what you are ' +
                  'about to test.',
              },
            },
            required: ['kit', 'why'],
          },
        },
        what_you_will_test: {
          type: 'string',
          description:
            'What you are about to put through the product, as an end user would. ' +
            'Naming it here is what stops this becoming a way to get a shell early.',
        },
      },
      required: ['kits'],
    },
  },
};
