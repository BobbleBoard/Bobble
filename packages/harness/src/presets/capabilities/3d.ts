/**
 * The `3d` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import type { Capability } from './types.js';

export const threeD: Capability = {
  name: '3d',
  /* the user (2026-09-17): "3d should be a connector". The two tools register
     only when the Bobble 3D connector is on and an engine that makes meshes
     is on this Mac (PI_BOBBLE_3D_READY) — so this group, like `svg`, exists
     for the model exactly when it can be honoured and not otherwise. The
     line names the habit it replaces, because a model with bash and a
     memory of trimesh/blender scripts will otherwise write geometry by hand
     — the same finding as the image and chart lines above. */
  summary:
    'Make a 3D model (.glb) from a description or a picture, and texture, split into parts, ' +
    'rig or retopologise one — on-device, shown in the chat as a card the user can turn. ' +
    'Every request for a 3D model, mesh, asset or figure goes here; never write geometry ' +
    'in code (trimesh, bpy, OBJ by hand).',
  guidance:
    'generate_3d takes a prompt ("a low-poly fox sitting"), an image_path (a picture the chat ' +
    'has — a generate_image result, an attachment), or both, and a finish: pbr (default, the ' +
    'full material), color (base colour only) or grey (the shape alone, quickest). One object ' +
    'on a plain ground works; a scene does not. It takes minutes — say so in one line and wait; ' +
    'do not poll or retry. refine_3d works on a model the chat has: texture (paint a grey one, ' +
    'or repaint with a prompt), segment (named parts — the card gets an Explode control), rig ' +
    '(a skeleton — the card gets a Skeleton control), retopo (a clean low-poly version). Each ' +
    'result is a NEW file beside the original. Refer to a model by the path the result names.',
  /* In CLI mode: `3d generate <prompt> --image <path>` and `3d refine <model>
     --op texture` (tool-cli.ts states both paths — deriving them would read
     "3d generate 3d"). */
  tools: ['generate_3d', 'refine_3d'],
};
