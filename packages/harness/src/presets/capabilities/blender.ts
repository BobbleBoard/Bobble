/**
 * The `blender` capability — the user's own Blender, through the add-on Blender
 * Lab ships (packages/mac-connectors/src/blender.ts). The user (2026-10-07), on the
 * third-party MCP server it replaces: "fix that to be a small cli tool".
 *
 * Its tools are registered only on a Mac with Blender installed, and a CLI
 * group whose tools are not registered is not in the prompt (tool-cli.ts
 * buildCli), so in Bash-CLI mode the line exists only where Blender does; in
 * schemas mode its name is one more word in the `capability` menu. Every byte
 * of the summary is in the canonical prompt where it shows (PLAN.md R8).
 */
import { BLENDER_TOOLS } from '@pi-desktop/mac-connectors/tool-names';
import type { Capability } from './types.js';

export const blender: Capability = {
  name: 'blender',
  /* "When they name it", as `chrome` says it: a 3D model that is not asked for
     IN Blender is the `3d` line's, which says never to write geometry in bpy. */
  summary:
    "The user's own Blender, when they name it: read the open scene, run Python (bpy) in " +
    'it, and render a picture of it.',
  guidance:
    'Read the scene first. Change it with Python — a few lines inline, more as a .py file — ' +
    'and after a change render a quick picture and look at it before saying it is done. If ' +
    'Blender is not open, open it with `open -a Blender` and run the command again.',
  tools: [...BLENDER_TOOLS],
};
