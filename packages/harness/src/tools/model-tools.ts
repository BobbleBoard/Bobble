/**
 * `generate_3d` + `refine_3d` — the 3D studio's engine as ORDINARY CHAT TOOLS,
 * the Bobble 3D connector's two tools. The user (2026-09-17): "3d should be a
 * connector that gets recommended for install upon installing the 3d studio
 * module, the card for during generation/texturing/segmentation/rigging …
 * should just be a little embedded viewport rotatable".
 *
 * Both ride the same app bridge the image tools use (image-bridge-client.ts —
 * one socket, one engine owner, one reply shape): the app runs the studio's
 * own `gen3d:generate` / `gen3d:stage` and answers with the path of the LAST
 * `.glb` the job produced (textured geometry replaces untextured on the same
 * job). The studio's panels watch the same broadcast, so a model made here is
 * in the 3D studio's history too.
 *
 * ## How the model reaches the chat
 * Same contract as the image tools: line 1 of the result is the `pd-file://`
 * URL (the chat mounts a `.glb` at that URL as the turnable card — the same
 * MediaCard the studios use, with Color / Normals / Grey, Skeleton and Explode
 * under it), line 2 is the plain path for a follow-up `refine_3d`, and a third
 * line names the path the way the model should say it — relative to the
 * working folder (workspace-relative.ts), because the model is not told where
 * the folder is.
 *
 * ## Registration
 * Only when the app says the connector is on AND an engine that can make a
 * mesh is on this Mac (`PI_BOBBLE_3D_READY=1`, decided at pi's spawn — see
 * pi-main.ts). Absent, nothing registers: the model never sees a capability
 * the machine cannot honour. The user's rule: prompt pressure, not enforcement —
 * the tool is either honestly there or honestly not.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { ImageBridge, ImageBridgeResult } from './image-bridge-client.js';
import { imageBridgeFromEnv } from './image-bridge-client.js';
import { pdFileUrl } from './image-tools.js';
import { pathForModel } from './workspace-relative.js';

export const GENERATE_3D_TOOL = 'generate_3d';
export const REFINE_3D_TOOL = 'refine_3d';

/** The env key pi-main publishes when the Bobble 3D connector's tools may register. */
export const BOBBLE_3D_READY_ENV = 'PI_BOBBLE_3D_READY';

export type Refine3dOp = 'texture' | 'segment' | 'rig' | 'retopo';
const REFINE_OPS: readonly Refine3dOp[] = ['texture', 'segment', 'rig', 'retopo'];

interface ModelToolDetails {
  ok: boolean;
  path?: string;
  error?: string;
  [k: string]: unknown;
}

function errorResult(tool: string, message: string): AgentToolResult<ModelToolDetails> {
  return {
    content: [{ type: 'text', text: `${tool} failed: ${message}` }],
    details: { ok: false, error: message },
  };
}

/**
 * Shape the bridge's answer into the tool result the chat renders — the media
 * URL first (the thread's card), then the path, then how to SAY it.
 */
export function modelToolResult(
  tool: string,
  verb: string,
  result: ImageBridgeResult,
  workspaceRoot: string | undefined,
): AgentToolResult<ModelToolDetails> {
  if (!result.ok) return errorResult(tool, result.error);
  const said = pathForModel(result.path, workspaceRoot);
  const lines = [pdFileUrl(result.path), `${verb} ${result.path}`];
  if (said !== result.path) {
    lines.push(
      `Refer to it as "${said}" — the path relative to the working folder; the model is shown in the chat as a card the user can turn.`,
    );
  } else {
    lines.push('The model is shown in the chat as a card the user can turn.');
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: { ok: true, path: result.path },
  };
}

/** `~/x`, `x` (from the working folder) or `/x` → an absolute path. */
function absolutePath(raw: string, env: Record<string, string | undefined>): string {
  const expanded = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded)
    ? expanded
    : resolve(env.PI_DESKTOP_WORKSPACE_ROOT ?? process.cwd(), expanded);
}

const GenerateParams = Type.Object({
  prompt: Type.Optional(
    Type.String({
      description:
        'What to make, as one object: "a low-poly fox sitting", "a ceramic teapot with a bamboo ' +
        'handle". One subject on a plain ground works best; a scene or a crowd does not. Optional ' +
        'when image_path is given (then it steers the texture).',
    }),
  ),
  image_path: Type.Optional(
    Type.String({
      description:
        'A picture to build the model FROM (the path a generate_image returned, or a file the ' +
        'user attached). The subject should be centred, whole and on a plain background. Optional ' +
        'when prompt is given.',
    }),
  ),
  finish: Type.Optional(
    Type.Union([Type.Literal('pbr'), Type.Literal('color'), Type.Literal('grey')], {
      description:
        'How far to finish it: "pbr" (default) is the full material, "color" the painted base ' +
        'colour only, "grey" the untextured shape — faster, for a quick look at the form.',
    }),
  ),
  resolution: Type.Optional(
    Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], {
      description:
        'How fine the shape is. "low" (default here) fits beside the chat model on a 24 GB Mac ' +
        'and takes a few minutes; "medium" is the 3D studio\'s default — finer, about 19 GB of ' +
        'memory, several times longer — and may be refused when memory is short; "high" more so. ' +
        'Only go above low when the user asks for detail.',
    }),
  ),
});

const RefineParams = Type.Object({
  model_path: Type.String({
    description:
      'The .glb to work on — the path a previous generate_3d or refine_3d returned, or one the ' +
      'user gave you.',
  }),
  op: Type.Union(
    [Type.Literal('texture'), Type.Literal('segment'), Type.Literal('rig'), Type.Literal('retopo')],
    {
      description:
        '"texture" paints a grey model (or repaints one); "segment" splits it into named parts ' +
        '(the card can then explode them); "rig" gives it a skeleton (the card shows it); ' +
        '"retopo" makes a clean low-poly version for games and editing.',
    },
  ),
  prompt: Type.Optional(
    Type.String({
      description: 'For texture only: what the surface should look like ("weathered bronze").',
    }),
  ),
});

/** What `generate_3d` answers when the app has 3D but it is not set up. */
export const NOT_SET_UP_3D =
  '3D is not set up on this Mac yet, so no model was made. Bobble 3D makes 3D models ' +
  'on-device; the user turns it on in Connectors → Bobble 3D (it downloads the engine ' +
  'first). Tell them that, in a sentence or two. Do not hand over a picture as if it were a ' +
  'model — if a concept picture would help meanwhile, make it only if they want one, and ' +
  'call it a picture.';

/*
 * THE APP HAS 3D, BUT IT IS OFF: the command is there, and says so.
 *
 * With the tools absent the model does not know 3D exists. MEASURED (4B, the
 * visual suite, "a stylized low-poly treasure chest 3D model for my game"),
 * twice. With nothing: "I don't have access to 3D modeling software" and an
 * offer to write vertex data in Python. With a rule line in the prompt ("not
 * set up on this Mac — say where the user turns it on"): it generated a
 * picture and opened with "I've created a stylized low-poly treasure chest
 * with clean game-ready topology". A line is read and weighed; a command is
 * reached for. So when the app has the connector but it is off
 * (PI_BOBBLE_3D_READY=0), `3d generate` exists with the real arguments and
 * answers what is true at the moment the model asks — how to turn it on.
 */
function registerNotSetUp3d(pi: ExtensionAPI): void {
  pi.registerTool({
    name: GENERATE_3D_TOOL,
    label: 'Generate 3D model',
    description:
      'Make a 3D model (.glb) from a description or a picture, on-device — NOT SET UP on this ' +
      'Mac yet: calling it says how the user turns it on.',
    promptSnippet: 'generate_3d: 3D models (not set up yet — calling it says how to turn it on).',
    parameters: GenerateParams,
    async execute(): Promise<AgentToolResult<ModelToolDetails>> {
      return errorResult(GENERATE_3D_TOOL, NOT_SET_UP_3D);
    },
  });
}

/**
 * Register the 3D tools onto `pi`.
 *
 * GRACEFUL DEGRADATION: with no bridge (a plain CLI pi outside Pi Desktop) or
 * with the connector off / no engine (`PI_BOBBLE_3D_READY` not '1'), NOTHING
 * registers. Pass an explicit bridge and env in tests.
 */
export function registerModelTools(
  pi: ExtensionAPI,
  bridge: ImageBridge | null = imageBridgeFromEnv(),
  env: Record<string, string | undefined> = process.env,
): void {
  if (bridge === null) return;
  if (env[BOBBLE_3D_READY_ENV] === '0') {
    registerNotSetUp3d(pi);
    return;
  }
  if (env[BOBBLE_3D_READY_ENV] !== '1') return;
  const root = (): string | undefined => {
    const r = env.PI_DESKTOP_WORKSPACE_ROOT;
    return r === undefined || r === '' ? undefined : r;
  };

  pi.registerTool({
    name: GENERATE_3D_TOOL,
    label: 'Generate 3D model',
    description:
      'Make a 3D model (.glb) from a description, a picture, or both — on-device, on the 3D ' +
      "studio's engine. The model appears INLINE in the chat as a card the user can turn, with " +
      'Color / Normals / Grey under it, and the result gives you its path for refine_3d. Takes ' +
      'several minutes (a text prompt first makes a picture, then the shape, then the texture); ' +
      'only one generation runs at a time on this machine.',
    promptSnippet:
      'generate_3d: make a 3D model from a prompt or a picture (on-device); it turns inline in the chat.',
    parameters: GenerateParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<ModelToolDetails>> {
      const prompt = params.prompt?.trim() ?? '';
      const rawImage = params.image_path?.trim() ?? '';
      if (prompt === '' && rawImage === '') {
        return errorResult(GENERATE_3D_TOOL, 'give a prompt, an image_path, or both');
      }
      const imagePath = rawImage === '' ? undefined : absolutePath(rawImage, env);
      const finish = params.finish ?? 'pbr';
      /* LOW BY DEFAULT IN THE CHAT. MEASURED (2026-09-18, this 24 GB M5 Pro,
         nothing else resident): the studio's medium is sized at ~19 GB and
         the guardian refused it with 15.8 GB free; low is ~10 GB and fits
         beside a resident chat model, which in a chat there always is. */
      const resolution = params.resolution ?? 'low';
      return modelToolResult(
        GENERATE_3D_TOOL,
        'Generated 3D model saved at',
        await bridge.call(
          'generate_3d',
          {
            ...(prompt !== '' ? { prompt } : {}),
            ...(imagePath !== undefined ? { imagePath } : {}),
            finish,
            resolution,
          },
          signal,
        ),
        root(),
      );
    },
  });

  pi.registerTool({
    name: REFINE_3D_TOOL,
    label: 'Refine 3D model',
    description:
      'Work on a 3D model the chat already has: "texture" paints it, "segment" splits it into ' +
      'parts, "rig" gives it a skeleton, "retopo" makes a clean low-poly version. On-device, on ' +
      "the 3D studio's engine; the result is a NEW .glb beside the original (left untouched), " +
      'shown inline as a card the user can turn — with Skeleton after a rig and Explode after ' +
      'a segment. Minutes each; one job at a time on this machine.',
    promptSnippet:
      'refine_3d: texture, segment, rig or retopo a 3D model the chat has; renders inline in the chat.',
    parameters: RefineParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<ModelToolDetails>> {
      const raw = params.model_path.trim();
      if (raw === '') return errorResult(REFINE_3D_TOOL, 'model_path is empty');
      const op = params.op;
      if (!REFINE_OPS.includes(op)) {
        return errorResult(REFINE_3D_TOOL, `op must be one of ${REFINE_OPS.join(', ')}`);
      }
      const modelPath = absolutePath(raw, env);
      const prompt = params.prompt?.trim() ?? '';
      const verb =
        op === 'texture'
          ? 'Textured model saved at'
          : op === 'segment'
            ? 'Segmented model (named parts) saved at'
            : op === 'rig'
              ? 'Rigged model saved at'
              : 'Retopologised model saved at';
      return modelToolResult(
        REFINE_3D_TOOL,
        verb,
        await bridge.call(
          'refine_3d',
          { op, modelPath, ...(prompt !== '' ? { prompt } : {}) },
          signal,
        ),
        root(),
      );
    },
  });
}
