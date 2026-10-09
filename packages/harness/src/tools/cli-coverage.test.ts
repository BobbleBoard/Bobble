import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../presets/capabilities';
import { toolCliGroups } from './tool-cli-groups';

/**
 * CLI MODE MUST NOT LOSE A CAPABILITY.
 *
 * The user's definition, and the whole point of the mode: "cli mode has no
 * capability loss over regular, it simply makes everything cli based and
 * accessible via the bash tool, all tools are always available, and their
 * information accessible via `<name> --help`."
 *
 * So anything a model could be handed as a schema must be reachable as a
 * command. This is the guard: add a tool to a preset or a capability group
 * without giving it a command and the build says so, here, rather than a model
 * discovering the hole mid-task and shelling out instead — which is exactly
 * what happened before `python_run`, `spotlight_search`,
 * `create_scheduled_task` and `present` were given commands.
 *
 * The live counterpart is `apps/desktop/tests/e2e/cli-coverage-probe.mjs`,
 * which asks a real session what it registered. This file can only see what is
 * written down; that one sees what is true.
 */

/**
 * Everything schemas mode can put in front of a model.
 *
 * This used to union a per-task tool table with the capabilities. The table is
 * gone — there is one base set now, and every other toolset arrives through
 * `capability` — so the capabilities ARE the surface, which is a tighter
 * statement of the same guard.
 */
function schemaReachable(): Set<string> {
  const out = new Set<string>();
  for (const cap of CAPABILITIES) for (const t of cap.tools) out.add(t);
  return out;
}

/** Everything CLI mode can put on PATH. */
function commandReachable(): Set<string> {
  const out = new Set<string>();
  for (const group of toolCliGroups()) for (const t of group.tools) out.add(t);
  return out;
}

/**
 * The interface itself. A command for `bash` would be a loop, and `capability`
 * / `use` are the schema mechanism — one turns a group on, the other calls a
 * tool that is not in the list. In CLI mode nothing is off and nothing is
 * hidden, so both are meaningless there. That is the mode working.
 */
const INTERFACE_TOOLS = new Set(['bash', 'capability', 'use']);

/**
 * The user's round-20 decision: the fenced file tools stay advertised as schemas in
 * CLI mode, because every accumulated write/edit safety fix hangs off them.
 * They ALSO have `file …` commands, so nothing is lost either way.
 */
const PINNED_AS_SCHEMAS = new Set(['read', 'write', 'edit', 'ls']);

/**
 * Provided by a CONNECTOR, not by this package — HyperFrames and the video
 * editing façade arrive over MCP. In CLI mode they are reachable through the
 * connector bridge (`pi-tool <server> <tool>`, `--help` rendered from the
 * server's own inputSchema), which is a different translation from this one.
 */
const CONNECTOR_PROVIDED = new Set([
  'motion_graphics_render',
  'video_edit',
  'extract_frames',
  'probe',
]);

/**
 * Named in a preset, registered by nothing in this repo.
 *
 * These front-load a class for a build that has the extension; here they are
 * filtered out by `resolvePresetTools`, which keeps only what the session
 * actually registered. Listed rather than deleted because deleting them would
 * silently un-front-load those classes wherever the tools DO exist — but listed
 * so the next audit does not have to rediscover that they are inert.
 */
const NOT_REGISTERED_HERE = new Set([
  'image_generate',
  'image_edit',
  'image_detect',
  'image_ocr',
  'image_segment',
  'video_locate',
  'model_3d_generate',
  'model_3d_view',
  // The registered tool is `generate_video`, which the media group has; this
  // is an older spelling that nothing answers to.
  'video_generate',
  'find',
  'grep',
]);

describe('every schema tool is reachable as a command', () => {
  it('leaves no capability that CLI mode cannot reach', () => {
    const commands = commandReachable();
    const missing = [...schemaReachable()]
      .filter(
        (t) =>
          !commands.has(t) &&
          !INTERFACE_TOOLS.has(t) &&
          !PINNED_AS_SCHEMAS.has(t) &&
          !CONNECTOR_PROVIDED.has(t) &&
          !NOT_REGISTERED_HERE.has(t),
      )
      .sort();
    expect(missing).toEqual([]);
  });

  it('gives the four that had no command one', () => {
    // The gap this test was written for, kept as a named case so a refactor
    // that drops one of them fails loudly rather than quietly.
    const commands = commandReachable();
    for (const t of ['python_run', 'spotlight_search', 'create_scheduled_task', 'present']) {
      expect(commands.has(t), t).toBe(true);
    }
  });

  it('exempts nothing that is not also reachable some other way', () => {
    // Every exemption above must be justified by another route. The pinned file
    // tools are schemas AND commands; the connector tools come over MCP; the
    // unregistered ones are not there to reach.
    for (const t of PINNED_AS_SCHEMAS) expect(commandReachable().has(t)).toBe(true);
  });
});

/**
 * SPECIALISTS RUN ON THE CLI BY DEFAULT, AND LOSE NOTHING BY IT.
 *
 * The user: "ensure there is a cli connector for the specialists that is by
 * default there and enabled, cli tools are a good context saver so it's
 * important that they're just the same power as schemas." The desktop spawns
 * every specialist child with PI_DESKTOP_TOOL_CLI=1 (its own setting), and
 * `cliVisibleTools` narrows the commands to that specialist's kit — so every
 * tool a kit names has to have a command, or the kit is quietly smaller in the
 * mode it now runs in.
 */
describe('every specialist kit is reachable as commands', () => {
  it('names no tool that CLI mode cannot offer a specialist', async () => {
    const { MESH_SPECIALIST_KINDS, specialistToolsFor } = await import('../corp/corp-mesh');
    const commands = commandReachable();
    const gaps: string[] = [];
    for (const kind of MESH_SPECIALIST_KINDS) {
      for (const t of specialistToolsFor(kind)) {
        if (
          !commands.has(t) &&
          !INTERFACE_TOOLS.has(t) &&
          !PINNED_AS_SCHEMAS.has(t) &&
          !CONNECTOR_PROVIDED.has(t) &&
          !NOT_REGISTERED_HERE.has(t)
        ) {
          gaps.push(`${kind}: ${t}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });
});
