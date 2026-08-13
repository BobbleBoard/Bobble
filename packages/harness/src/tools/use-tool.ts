/**
 * `use` — call a tool the model has been TOLD about but which is not in its
 * advertised tool list.
 *
 * This was meant to make a capability cost nothing: the advertised set stays
 * fixed, no turn pays a re-prefill, a capability just names the tools it may now
 * use and `use` carries the call. Measured against the running server: told about
 * `mac_snapshot` in prose, the model emitted
 * `use({tool:"mac_snapshot",args:{app:"Safari"}})` correctly on the first try.
 *
 * IT ONLY REACHES OUR OWN TOOLS. It dispatches through the registry in
 * ./tool-registry.ts, which captures each tool's real `execute` as it registers —
 * and every extension gets its OWN api object, so the registry holds the harness's
 * tools and nothing else. pi's ExtensionAPI exposes `getAllTools()` (name,
 * description, parameters — no `execute`) and no `getToolDefinition`, so there is
 * no seam to dispatch another extension's tool. Measured: `use({tool:
 * "browser_click"})` and `use({tool:"mac_click"})` both answered "There is no tool
 * called …" while both tools were plainly loaded.
 *
 * So this is a fallback for HARNESS tools only. Anything a turn cannot proceed
 * without belongs in the preset (see ALWAYS_BROWSER_TOOLS).
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { ToolRegistry } from './tool-registry.js';

export const USE_TOOL_NAME = 'use';

/** Names that must never be reachable this way — `use` calling itself, mainly. */
const NEVER = new Set([USE_TOOL_NAME]);

export interface UseToolOptions {
  readonly registry: ToolRegistry;
  /** Tools the model already has advertised — it should call those directly. */
  readonly active: () => readonly string[];
}

export function registerUseTool(pi: ExtensionAPI, opts: UseToolOptions): void {
  pi.registerTool({
    name: USE_TOOL_NAME,
    label: 'Use',
    description:
      'Fallback: call a tool by name when it is not in your tool list. Prefer calling a tool ' +
      'directly when you can see it — after `capability` turns a group on, those tools appear ' +
      'in your list and should be called normally. Use this only if one you were told about ' +
      'is still not callable.',
    promptSnippet: 'Call a tool a capability made available',
    parameters: Type.Object({
      tool: Type.String({ description: 'The tool name, exactly as the capability named it.' }),
      args: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "That tool's arguments." }),
      ),
    }),
    async execute(id, params, ...rest) {
      const p = (params ?? {}) as { tool?: unknown; args?: unknown };
      const name = typeof p.tool === 'string' ? p.tool.trim() : '';
      if (name === '' || NEVER.has(name)) {
        return {
          content: [{ type: 'text', text: 'Pass the name of the tool you want to call.' }],
          details: undefined,
        };
      }
      const target = opts.registry.get(name);
      if (target === undefined) {
        // Say what IS reachable — a bare "unknown tool" invites another guess.
        // And do NOT say "turn on the capability that provides it": that advice
        // cannot work inside this reply (see the header), so a model that follows
        // it calls `capability` and then loops on the same unreachable name. It
        // did exactly that, four times, before falling back to a selenium script.
        const known = opts.registry.names().slice(0, 40).join(', ');
        return {
          content: [
            {
              type: 'text',
              text:
                `"${name}" cannot be called this way. This tool only reaches: ${known}. ` +
                'Do not retry it or try to turn it on — nothing you do in this reply will make ' +
                'it callable. Use what you already have, or finish and say what you need.',
            },
          ],
          details: undefined,
        };
      }
      const args = p.args !== undefined && p.args !== null ? p.args : {};
      // The target's own errors belong to the target — let them surface as its
      // result rather than being reworded here.
      return (await target.execute(id, args, ...rest)) as never;
    },
  });
}
