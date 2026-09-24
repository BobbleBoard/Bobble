/**
 * CAPABILITIES — named groups of tools, and the one tool that turns one on.
 *
 * This replaces `tool_search`. the user: "remove tool search entirely, and instead
 * replace with a 'capability' tool that returns right there as the tool result …
 * the tools can be computer use, mail, calendar, browser etc." And separately:
 * "the tool search isn't great and is a source of much looping right now."
 *
 * WHY SEARCH WAS THE WRONG SHAPE. It took a free-text query and activated
 * whatever scored well, so the same request could yield different tools depending
 * on wording, one tool at a time, repeatedly — and every activation rewrote the
 * prompt's tool block. That is both the looping the user saw and the prefill cost:
 * measured, a manager spent 13 of its turns inside tool_search and handed out
 * nothing.
 *
 * A capability is the opposite: a FIXED, named set, turned on once, in one call.
 * "computer use" always means the same tools. There is nothing to search, nothing
 * to score, and a second call for the same capability is a no-op.
 *
 * ON THE COST. Tool schemas are rendered at the START of the prompt, so changing
 * the active set moves everything after it and the KV cache cannot be reused —
 * one re-prefill per activation. Bounded and rare (a handful per conversation at
 * most) rather than the per-message churn the preload caused, but not free.
 *
 * IT CAN BE MADE FREE, and the user is right that it should be. Two facts, both
 * measured against the live server:
 *   · a tool described only in a RESULT cannot be called — llama-server's
 *     tool-call grammar pins the function name to the advertised list;
 *   · a stable advertised DISPATCHER can carry it: told about `mac_snapshot` in
 *     prose, the model correctly emitted `use({tool:"mac_snapshot",args:{…}})`.
 * So the advertised set never has to change. The one missing piece is execution:
 * pi hands out tool definitions WITHOUT their `execute`, and a tool_call handler
 * may block but not rewrite a name — so `use` currently has nothing to dispatch
 * through. The fix is ours to make: the harness loads before web-tools,
 * browser-use and the mac extensions, so wrapping `pi.registerTool` captures
 * every definition (execute included) as it is registered, and `use` dispatches
 * through that. Then activation is pure text and costs nothing.
 */
import { threeD } from './capabilities/3d.js';
import { browser } from './capabilities/browser.js';
import { chart } from './capabilities/chart.js';
import { chrome } from './capabilities/chrome.js';
import { computerUse } from './capabilities/computer-use.js';
import { connectors } from './capabilities/connectors.js';
import { diagram } from './capabilities/diagram.js';
import { generation } from './capabilities/generation.js';
import { memory } from './capabilities/memory.js';
import { office } from './capabilities/office.js';
import { personal } from './capabilities/personal.js';
import { svg } from './capabilities/svg.js';
import type { Capability } from './capabilities/types.js';
import { webResearch } from './capabilities/web-research.js';
import { workflows } from './capabilities/workflows.js';

export type { Capability } from './capabilities/types.js';

/** The tool that activates a capability — named here so prompt + runtime agree. */
export const CAPABILITY_TOOL_NAME = 'capability';

/**
 * The capabilities on offer.
 *
 * Grouped the way a person would ask for them, not the way the code is organised
 * — "calendar, mail and reminders" is one thing to a user even though it is five
 * connectors, and the user asked for exactly that bundling.
 *
 * ONE FILE PER CAPABILITY, this list the only place their order lives (the W0-A
 * pre-wire, deliverables/research/PLAN.md §2.3). The order IS prompt bytes — the
 * CLI preamble, the capability menu and the tool description list them in it —
 * so the split changed nothing the model reads: the snapshot test in
 * ../prompt/canonical-prompt.snapshot.test.ts holds the prompt and the tool
 * surface byte-identical to the code before it. `diagram`, `memory` and
 * `workflows` are placeholders, `undefined` until their lanes fill them, and a
 * placeholder is left out rather than listed empty.
 */
export const CAPABILITIES: readonly Capability[] = [
  browser,
  computerUse,
  chrome,
  personal,
  webResearch,
  generation,
  svg,
  diagram,
  chart,
  office,
  threeD,
  memory,
  workflows,
  connectors,
].filter((c): c is Capability => c !== undefined);

/** Look one up by name, tolerantly — "computer use" and "computer_use" both work. */
export function findCapability(name: string): Capability | undefined {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return (
    CAPABILITIES.find((c) => c.name === key) ??
    // A near-miss is far more useful than "unknown capability": the model asking
    // for "mail" plainly wants the one that contains mail.
    CAPABILITIES.find((c) => c.name.includes(key) || key.includes(c.name))
  );
}

/**
 * The capability that contains a given tool.
 *
 * Used when the model's stated intent names a tool it has not been given: it
 * wants to click, so it is browsing, so it is about to want type and scroll too.
 * Turning on the whole group costs the SAME single re-prefill as smuggling in the
 * one tool, and saves the next two. the user: "load the capability suite of browser
 * tools when it's called immediately."
 */
export function capabilityForTool(tool: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.tools.includes(tool));
}

/** The menu, for a bare `capability()` call. */
export function capabilityMenu(): string {
  const lines = CAPABILITIES.map((c) => `- ${c.name} — ${c.summary}`);
  return [
    'Capabilities you can turn on, by name:',
    '',
    ...lines,
    '',
    `Call ${CAPABILITY_TOOL_NAME} with one of these names and its tools join your list from ` +
      'your NEXT reply onward — not this one. Turn on only what the task needs.',
  ].join('\n');
}

/**
 * What the model is told when a capability comes on: the tools it now has, and
 * the rule for using them well.
 *
 * `available` filters to what is actually registered in THIS build — naming a
 * tool that does not exist would have the model call into nothing.
 */
export function capabilityActivated(
  cap: Capability,
  available: readonly string[],
  /**
   * The command this capability answers to when the CLI is the interface.
   *
   * IN CLI MODE THERE IS NOTHING TO WAIT FOR. The paragraph below tells the
   * model its new tools are "NOT callable in this reply" — true when activation
   * changes the advertised tool array, and false when every tool is already a
   * command on PATH. Left unchanged it costs a wasted turn: the model stops,
   * announces what it is about to do, and hands back a reply that could have
   * done it. Absent ⇒ the schemas wording, which is the existing behaviour.
   */
  cliCommand?: string,
): string {
  const present = cap.tools.filter((t) => available.includes(t));
  if (present.length === 0) {
    return (
      `The "${cap.name}" capability is not available in this build — none of its tools are ` +
      'installed. Say so plainly rather than pretending to use it.'
    );
  }
  if (cliCommand !== undefined) {
    return [
      `"${cap.name}" is available NOW, as \`${cliCommand}\` — it always was, and it stays. ` +
        `Run \`${cliCommand} --help\` to see what it does.`,
      '',
      'Nothing is pending and nothing changed: these are commands, not a tool list, so use ' +
        'them in THIS reply rather than stopping to announce them.',
      '',
      cap.guidance,
    ].join('\n');
  }
  return [
    `"${cap.name}" is on, and takes effect on your NEXT reply: ${present.join(', ')}.`,
    '',
    'They are NOT callable in this reply — calling one now returns "tool not found". Finish ' +
      'this reply with what you can already do, or stop and say what you are about to do with ' +
      'them; they will be in your tool list from your next reply onward, and stay there.',
    '',
    cap.guidance,
  ].join('\n');
}
