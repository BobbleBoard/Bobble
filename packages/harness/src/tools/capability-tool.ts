/**
 * The `capability` tool — the replacement for `tool_search`.
 *
 * Called bare it lists what is on offer; called with a name it turns that group
 * on and says, in the result, exactly which tools the model will have and how to
 * use them well. One call, a fixed set, no scoring, nothing to loop on.
 *
 * WHAT "ON" MEANS, EXACTLY. pi snapshots the tool array when a run begins
 * (pi-agent-core agent.js:273) and both the provider request and the tool
 * executor read that snapshot, so `setActiveTools` lands on the NEXT run — pi's
 * own words: "Changes take effect on the next agent turn." Measured live: after
 * this tool answered "browser is on. You now have: … browser_click …", the very
 * next `browser_click` came back "Tool browser_click not found", twice, and the
 * advertised array never moved off tools[17] across 20 requests. The result text
 * says so now. Anything a turn genuinely cannot proceed without belongs in the
 * preset instead (see ALWAYS_BROWSER_TOOLS, which is why the browser suite is no
 * longer behind this tool).
 *
 * See ./presets/capabilities.ts for why a named group beats a search.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import {
  CAPABILITIES,
  CAPABILITY_TOOL_NAME,
  capabilityActivated,
  capabilityMenu,
  findCapability,
} from '../presets/capabilities.js';

export interface CapabilityToolOptions {
  /** Turn the named tools on. The harness unions them into the active set. */
  readonly onActivate: (tools: readonly string[]) => void;
  /** Every tool name registered in this build. */
  readonly available: () => readonly string[];
  /**
   * The command a capability answers to when the CLI is the interface, or
   * undefined in schemas mode.
   *
   * It changes what the tool SAYS, not what it does: in CLI mode every tool is
   * already a command on PATH, so there is nothing to wait for and the "not
   * callable in this reply" paragraph would cost a turn for nothing. See
   * `capabilityActivated`.
   */
  readonly cliCommandFor?: (capability: string) => string;
}

export function registerCapabilityTool(pi: ExtensionAPI, opts: CapabilityToolOptions): void {
  const names = CAPABILITIES.map((c) => c.name).join(', ');
  pi.registerTool({
    name: CAPABILITY_TOOL_NAME,
    label: 'Capability',
    description:
      opts.cliCommandFor !== undefined
        ? 'Look up what a group of commands can do. Call it with no argument to see the ' +
          `groups, or with a name for that group's guidance: ${names}. Everything is already ` +
          'on your PATH — this tells you about it, it does not switch anything on.'
        : 'Turn on a group of tools you need but do not currently have. Call it with no ' +
          `argument to see what is available, or with a name to switch that group on: ${names}. ` +
          'The tools join your list from your NEXT reply onward — they are not callable in the ' +
          'same reply that turns them on. Turn on only what the task actually needs.',
    promptSnippet: 'Turn on a group of tools (browser, computer-use, personal, …)',
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: `The capability to turn on: ${names}. Omit to list them.`,
        }),
      ),
    }),
    async execute(_id, params) {
      const raw = (params as { name?: unknown })?.name;
      const wanted = typeof raw === 'string' ? raw.trim() : '';
      if (wanted === '') {
        return { content: [{ type: 'text', text: capabilityMenu() }], details: undefined };
      }
      const cap = findCapability(wanted);
      if (cap === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: `There is no "${wanted}" capability.\n\n${capabilityMenu()}`,
            },
          ],
          details: undefined,
        };
      }
      const available = opts.available();
      const present = cap.tools.filter((t) => available.includes(t));
      // Activate only what exists — naming an absent tool would have the model
      // call into nothing, and the message below says so honestly instead.
      if (present.length > 0) opts.onActivate(present);
      return {
        content: [
          {
            type: 'text',
            text: capabilityActivated(cap, available, opts.cliCommandFor?.(cap.name)),
          },
        ],
        details: undefined,
      };
    },
  });
}
