/**
 * The `generate_image` tool — the model's request to synthesise an image. It
 * validates + normalises the request against the modality catalog, enqueues a
 * job over the gen bridge (the app's JobQueue runs mflux/MLX and streams
 * progress to the canvas), and returns the produced image(s): a text summary
 * carrying the model-name FOOTNOTE plus the pixels as `image` blocks so a
 * vision-capable chat model can see (and, in phase 2, critique) its own output.
 *
 * Loaded outside Pi Desktop (no bridge env) the tool still registers but reports
 * a clear "bridge unavailable" error, so the extension is always safe to load.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentToolResult, ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  defaultImageModel,
  defaultVideoModel,
  type GenOutput,
  getModel,
  modelsForModality,
} from '@pi-desktop/gen-service';
import { shareTool } from '@pi-desktop/tool-bus';
import { type TSchema, Type } from '@sinclair/typebox';
import type { GenBridge } from './gen-bridge-client.js';
import type {
  GenerateAudioResult,
  GenerateImageResult,
  GenerateVideoResult,
} from './gen-contract.js';

export const GENERATE_IMAGE_TOOL = 'generate_image';
export const GENERATE_VIDEO_TOOL = 'generate_video';
export const GENERATE_SPEECH_TOOL = 'generate_speech';
export const GENERATE_MUSIC_TOOL = 'generate_music';
export const GENERATE_SFX_TOOL = 'generate_sfx';
export const GENERATE_SVG_TOOL = 'generate_svg';

/** Attach at most this many candidate images back to the model (context budget). */
const MAX_ATTACHED_IMAGES = 4;
/** Skip attaching an image larger than this (keep the context sane). */
const MAX_ATTACH_BYTES = 6 * 1024 * 1024;

interface GenerateDetails {
  ok: boolean;
  jobId?: string;
  model?: string;
  outputs?: readonly GenOutput[];
  error?: string;
  [k: string]: unknown;
}

export interface GenToolsOptions {
  /** The bridge to the app; null → tools report a clear unavailable error. */
  readonly bridge: GenBridge | null;
  /** Injectable image reader (tests). Default: fs.readFile. */
  readonly readImage?: (path: string) => Promise<Buffer>;
  /** Register the image/video tools. Default true (tests, `registerGenUse`);
   *  the app passes the generation experiment flag. */
  readonly media?: boolean;
  /** Register `generate_svg`. Default true; the app passes whether OmniSVG's
   *  model is on disk, so a command that can only fail is never advertised. */
  readonly svg?: boolean;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errResult(message: string): AgentToolResult<GenerateDetails> {
  return {
    content: [{ type: 'text', text: `generate_image failed: ${message}` }],
    details: { ok: false, error: message },
  };
}

function videoErrResult(message: string): AgentToolResult<GenerateDetails> {
  return {
    content: [{ type: 'text', text: `generate_video failed: ${message}` }],
    details: { ok: false, error: message },
  };
}

/** Parse a `<w>x<h>` size string into even, bounded dimensions. */
export function parseSize(size: string | undefined): { width: number; height: number } {
  const fallback = { width: 1024, height: 1024 };
  if (size === undefined) return fallback;
  const m = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i.exec(size.trim());
  if (m === null) return fallback;
  const clamp = (n: number): number => Math.max(256, Math.min(1536, Math.round(n / 16) * 16));
  return { width: clamp(Number(m[1])), height: clamp(Number(m[2])) };
}

const IMAGE_MODEL_IDS = modelsForModality('image').map((m) => m.id);
const VIDEO_MODEL_IDS = modelsForModality('video').map((m) => m.id);
const AUDIO_MODELS = modelsForModality('audio');
/* Speech runs on the uv worker; music and SFX run ComfyUI graphs. The split is
   what decides which arm of the job runs, so the tools advertise it too. */
const SPEECH_MODEL_IDS = AUDIO_MODELS.filter(
  (m) => m.backend === 'mlx-audio' || m.backend === 'torch-tts',
).map((m) => m.id);
const SOUND_MODEL_IDS = AUDIO_MODELS.filter((m) => m.backend === 'comfyui').map((m) => m.id);

/**
 * A prompt that reads as MOTION GRAPHICS (animated text / titles / charts,
 * kinetic typography, explainers, slideshows) routes to the deterministic, CPU,
 * commercial-safe HyperFrames runner rather than a heavy diffusion text→video
 * model. Used only to pick a DEFAULT when the caller names no model.
 */
const MOTION_GRAPHICS_RE =
  /\b(motion[\s-]?graphics?|kinetic typography|lower third|title cards?|title sequence|animated (?:text|titles?|logos?|charts?|graphs?|infographics?|captions?|subtitles?)|text animation|typograph(?:y|ic)|slideshow|explainer)\b/i;

/**
 * Choose the video model id: an explicit id always wins; otherwise a
 * motion-graphics prompt selects the catalog's `hyperframes` entry and any other
 * prompt selects the photoreal {@link defaultVideoModel}. The app-side bridge
 * then routes purely by the chosen model's backend (ComfyUI vs HyperFrames).
 */
function resolveVideoModelId(explicit: string | undefined, prompt: string): string {
  if (explicit !== undefined) return explicit;
  if (MOTION_GRAPHICS_RE.test(prompt)) {
    const hf = modelsForModality('video').find((m) => m.backend === 'hyperframes');
    if (hf !== undefined) return hf.id;
  }
  return defaultVideoModel().id;
}

/** Register the generation tool set onto `pi`. */
export function registerGenTools(pi: ExtensionAPI, options: GenToolsOptions): void {
  const bridge = options.bridge;
  const readImage = options.readImage ?? ((p: string) => readFile(p));
  const media = options.media ?? true;
  const svg = options.svg ?? true;

  if (svg) registerSvgTool(pi, bridge);
  if (!media) return;

  shareTool(pi, {
    name: GENERATE_IMAGE_TOOL,
    label: 'Generate: Image',
    description:
      'Generate an image from a text prompt, locally on-device (Apple-Silicon MLX). Returns the ' +
      'image(s) and opens them on the canvas with a live progress bar. Every result is footnoted ' +
      `with the model that made it. Available models: ${IMAGE_MODEL_IDS.join(', ')} ` +
      '(default is a fast, Apache-licensed model). Use size like "512x512" or "1024x1024"; higher ' +
      'sizes and step counts are slower.',
    promptSnippet: 'Generate an image from a text prompt (on-device)',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'What to draw. Be specific about subject, style, lighting.',
      }),
      model: Type.Optional(
        Type.String({
          description: `Model id. One of: ${IMAGE_MODEL_IDS.join(', ')}. Default: fast model.`,
        }),
      ),
      size: Type.Optional(
        Type.String({ description: 'Image size "WxH" (e.g. "512x512"). Default "1024x1024".' }),
      ),
      n: Type.Optional(
        Type.Number({
          description: 'Number of candidates to generate (distinct seeds). Default 1.',
        }),
      ),
      steps: Type.Optional(
        Type.Number({ description: 'Denoising steps (model default if omitted).' }),
      ),
      seed: Type.Optional(Type.Number({ description: 'Base RNG seed for reproducibility.' })),
      negative_prompt: Type.Optional(Type.String({ description: 'What to avoid in the image.' })),
    }),
    async execute(_id, params): Promise<AgentToolResult<GenerateDetails>> {
      if (bridge === null) {
        return errResult(
          'generation bridge unavailable (the gen-tools extension must run inside Pi Desktop)',
        );
      }
      // Resolve + validate the model against the catalog.
      const modelId = params.model ?? defaultImageModel().id;
      const model = getModel(modelId);
      if (model === undefined || model.modality !== 'image') {
        return errResult(
          `unknown image model "${modelId}". Choose one of: ${IMAGE_MODEL_IDS.join(', ')}`,
        );
      }

      try {
        const result = await bridge.request<GenerateImageResult>('generate', {
          prompt: params.prompt,
          model: modelId,
          size: params.size,
          n: params.n,
          steps: params.steps,
          seed: params.seed,
          negativePrompt: params.negative_prompt,
        });

        const outputs = result.outputs;
        if (outputs.length === 0) return errResult('the generator produced no images');

        const footnote = `Model: ${model.label} (${model.id}, ${model.license})`;
        const lines = outputs.map(
          (o, i) => `  ${i + 1}. ${o.outputPath}${o.seed !== undefined ? ` (seed ${o.seed})` : ''}`,
        );
        const text =
          `Generated ${outputs.length} image${outputs.length === 1 ? '' : 's'} on the canvas:\n` +
          `${lines.join('\n')}\n${footnote}`;

        const content: AgentToolResult<GenerateDetails>['content'] = [{ type: 'text', text }];
        // Attach the pixels so a vision-capable model can see its output.
        for (const output of outputs.slice(0, MAX_ATTACHED_IMAGES)) {
          try {
            const bytes = await readImage(output.outputPath);
            if (bytes.length <= MAX_ATTACH_BYTES) {
              content.push({
                type: 'image',
                data: bytes.toString('base64'),
                mimeType: 'image/png',
              });
            }
          } catch {
            // Best-effort: the path is already in the text if the read fails.
          }
        }

        return {
          content,
          details: { ok: true, jobId: result.jobId, model: model.id, outputs },
        };
      } catch (err) {
        return errResult(messageOf(err));
      }
    },
  });

  shareTool(pi, {
    name: GENERATE_VIDEO_TOOL,
    label: 'Generate: Video',
    description:
      'Generate a short video from a text prompt, locally on-device. Two paths, chosen by model: ' +
      'motion-graphics (animated text/titles/charts — deterministic, CPU, commercial-safe) render ' +
      'via HyperFrames; photoreal text→video renders via a local diffusion model (LTX / Wan). ' +
      'Opens the clip on the canvas with a live progress bar and footnotes it with the model that ' +
      `made it. Because you cannot watch an MP4, a still POSTER FRAME of the result is attached as ` +
      'an image so you can see (and critique) your own output. Available models: ' +
      `${VIDEO_MODEL_IDS.join(', ')}. If no model is given, a motion-graphics prompt uses ` +
      'HyperFrames and any other prompt uses the default photoreal model. Use size like "768x512"; ' +
      'longer clips and higher resolutions are much slower.',
    promptSnippet: 'Generate a short video from a text prompt (on-device)',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'What to animate. Be specific about subject, motion, style, camera.',
      }),
      model: Type.Optional(
        Type.String({
          description: `Model id. One of: ${VIDEO_MODEL_IDS.join(', ')}. Default: chosen from the prompt.`,
        }),
      ),
      seconds: Type.Optional(
        Type.Number({
          description: 'Clip duration in seconds (model/catalog default if omitted).',
        }),
      ),
      size: Type.Optional(
        Type.String({ description: 'Frame size "WxH" (e.g. "768x512"). Default per model.' }),
      ),
      fps: Type.Optional(
        Type.Number({ description: 'Frames per second (model default if omitted).' }),
      ),
      seed: Type.Optional(Type.Number({ description: 'Base RNG seed for reproducibility.' })),
      negative_prompt: Type.Optional(Type.String({ description: 'What to avoid in the video.' })),
    }),
    async execute(_id, params): Promise<AgentToolResult<GenerateDetails>> {
      if (bridge === null) {
        return videoErrResult(
          'generation bridge unavailable (the gen-tools extension must run inside Pi Desktop)',
        );
      }
      // Resolve + validate the model against the catalog.
      const modelId = resolveVideoModelId(params.model, params.prompt);
      const model = getModel(modelId);
      if (model === undefined || model.modality !== 'video') {
        return videoErrResult(
          `unknown video model "${modelId}". Choose one of: ${VIDEO_MODEL_IDS.join(', ')}`,
        );
      }

      try {
        const result = await bridge.request<GenerateVideoResult>('generateVideo', {
          prompt: params.prompt,
          model: modelId,
          seconds: params.seconds,
          size: params.size,
          fps: params.fps,
          seed: params.seed,
          negativePrompt: params.negative_prompt,
        });

        const outputs = result.outputs;
        if (outputs.length === 0) return videoErrResult('the generator produced no video');

        const footnote = `Model: ${model.label} (${model.id}, ${model.license})`;
        const lines = outputs.map(
          (o, i) => `  ${i + 1}. ${o.outputPath}${o.seed !== undefined ? ` (seed ${o.seed})` : ''}`,
        );
        const text =
          `Generated ${outputs.length} video${outputs.length === 1 ? '' : 's'} on the canvas:\n` +
          `${lines.join('\n')}\n${footnote}`;

        const content: AgentToolResult<GenerateDetails>['content'] = [{ type: 'text', text }];
        // A chat model can't watch an MP4 — attach the extracted poster frame so a
        // vision-capable model can SEE (and critique) its own output.
        if (result.posterFramePath !== undefined) {
          try {
            const bytes = await readImage(result.posterFramePath);
            if (bytes.length <= MAX_ATTACH_BYTES) {
              content.push({
                type: 'image',
                data: bytes.toString('base64'),
                mimeType: 'image/png',
              });
            }
          } catch {
            // Best-effort: the video paths are already in the text if the read fails.
          }
        }

        return {
          content,
          details: {
            ok: true,
            jobId: result.jobId,
            model: model.id,
            outputs,
            posterFramePath: result.posterFramePath,
          },
        };
      } catch (err) {
        return videoErrResult(messageOf(err));
      }
    },
  });
}

/** Error result for an audio tool, named so the model reads which one failed. */
function audioErrResult(tool: string, message: string): AgentToolResult<GenerateDetails> {
  return {
    content: [{ type: 'text', text: `${tool} failed: ${message}` }],
    details: { ok: false, error: message },
  };
}

/**
 * THREE TOOLS, NOT ONE.
 *
 * `generate_audio(kind=…)` would have been fewer lines and worse: a model
 * choosing between "speech", "music" and "sfx" inside one schema picks wrong far
 * more often than a model choosing between three named tools, and the parameters
 * barely overlap — narration wants a voice and a reference clip, a sound effect
 * wants a length in seconds and several variations to pick from. Separate tools
 * let each describe only what it actually takes.
 */
export function registerAudioTools(pi: ExtensionAPI, options: GenToolsOptions): void {
  const bridge = options.bridge;

  const audioTool = (
    name: string,
    label: string,
    kind: 'speech' | 'music' | 'sfx',
    description: string,
    snippet: string,
    extra: Record<string, TSchema>,
    ids: readonly string[],
  ): void => {
    shareTool(pi, {
      name,
      label,
      description,
      promptSnippet: snippet,
      parameters: Type.Object({
        prompt: Type.String({
          description:
            kind === 'speech'
              ? 'The exact text to read aloud.'
              : 'What the sound should be. Be specific about instruments, mood, materials.',
        }),
        model: Type.Optional(
          Type.String({
            description: `Model id. One of: ${ids.join(', ')}. Default: recommended.`,
          }),
        ),
        seed: Type.Optional(Type.Number({ description: 'Base RNG seed.' })),
        ...extra,
      }),
      async execute(_id, params): Promise<AgentToolResult<GenerateDetails>> {
        if (bridge === null) {
          return audioErrResult(
            name,
            'generation bridge unavailable (the gen-tools extension must run inside Pi Desktop)',
          );
        }
        const p = params as Record<string, unknown>;
        const modelId = typeof p.model === 'string' ? p.model : undefined;
        if (modelId !== undefined && !ids.includes(modelId)) {
          return audioErrResult(
            name,
            `unknown model "${modelId}". Choose one of: ${ids.join(', ')}`,
          );
        }
        try {
          const result = await bridge.request<GenerateAudioResult>('generateAudio', {
            prompt: p.prompt,
            kind,
            model: modelId,
            seconds: p.seconds,
            steps: p.steps,
            voice: p.voice,
            speed: p.speed,
            lang: p.lang,
            refAudio: p.reference_audio,
            refText: p.reference_text,
            seed: p.seed,
            count: p.n,
          });
          const outputs = result.outputs;
          if (outputs.length === 0) return audioErrResult(name, 'no audio was produced');
          const lines = outputs.map(
            (o, i) => `  ${i + 1}. ${o.path}${o.seed !== undefined ? ` (seed ${o.seed})` : ''}`,
          );
          const first = outputs[0];
          const footnote = first === undefined ? '' : `\nModel: ${first.model}`;
          return {
            content: [
              {
                type: 'text',
                text:
                  `Generated ${outputs.length} audio file${outputs.length === 1 ? '' : 's'}:\n` +
                  `${lines.join('\n')}${footnote}`,
              },
            ],
            details: {
              ok: true,
              jobId: result.jobId,
              outputs: outputs.map((o) => ({
                outputPath: o.path,
                modality: 'audio' as const,
                model: o.model,
                ...(o.seed !== undefined ? { seed: o.seed } : {}),
              })),
            },
          };
        } catch (err) {
          return audioErrResult(name, messageOf(err));
        }
      },
    });
  };

  audioTool(
    GENERATE_SPEECH_TOOL,
    'Generate: Speech',
    'speech',
    'Read text aloud in a synthetic voice, locally on-device. Supports preset voices and ' +
      'ZERO-SHOT VOICE CLONING from a 3-10 second reference clip (reference_audio). Use this for ' +
      `narration, dialogue and read-alouds. Available models: ${SPEECH_MODEL_IDS.join(', ')}.`,
    'Read text aloud on-device, optionally cloning a voice',
    {
      voice: Type.Optional(Type.String({ description: 'Preset voice id (e.g. "af_heart").' })),
      speed: Type.Optional(Type.Number({ description: 'Speaking rate. 1.0 is normal.' })),
      lang: Type.Optional(
        Type.String({ description: 'Language code (e.g. "a" = American English).' }),
      ),
      reference_audio: Type.Optional(
        Type.String({
          description:
            'Absolute path to a 3-10s clip of a voice to CLONE. Without it, a preset voice is used.',
        }),
      ),
      reference_text: Type.Optional(
        Type.String({ description: 'Transcript of reference_audio, when the model wants it.' }),
      ),
    },
    SPEECH_MODEL_IDS,
  );

  audioTool(
    GENERATE_MUSIC_TOOL,
    'Generate: Music',
    'music',
    'Compose a piece of music from a description, locally on-device. Describe genre, ' +
      `instruments, tempo and mood. Available models: ${SOUND_MODEL_IDS.join(', ')}.`,
    'Compose music from a description (on-device)',
    {
      seconds: Type.Optional(Type.Number({ description: 'Length in seconds. Default 20.' })),
      steps: Type.Optional(Type.Number({ description: 'Diffusion steps. Higher is slower.' })),
    },
    SOUND_MODEL_IDS,
  );

  audioTool(
    GENERATE_SFX_TOOL,
    'Generate: Sound effect',
    'sfx',
    'Generate a short sound effect from a description (a door slam, footsteps on gravel, a ' +
      'sword being drawn), locally on-device. Keep these SHORT — cost scales with length. Ask ' +
      `for several variations with n and pick one. Available models: ${SOUND_MODEL_IDS.join(', ')}.`,
    'Generate a short sound effect (on-device)',
    {
      seconds: Type.Optional(
        Type.Number({ description: 'Length in seconds. Default 5, keep it short.' }),
      ),
      steps: Type.Optional(Type.Number({ description: 'Diffusion steps. Higher is slower.' })),
      n: Type.Optional(Type.Number({ description: 'How many variations to produce. Default 1.' })),
    },
    SOUND_MODEL_IDS,
  );
}

/** `generate_svg` — OmniSVG. Registered on its own so the connector can turn it
 *  on without the generation experiment. See the block below for the ask. */
function registerSvgTool(pi: ExtensionAPI, bridge: GenBridge | null): void {
  /*
   * SVG — OmniSVG, through the app's own llama-server. the user: "a simple cli tool
   * that essentially calls this as a subagent eg. svg <optional prompt> --image
   * <optional reference image path(s)>". In CLI mode this IS the `svg` command
   * (tool-cli.ts maps it to an empty path), and the prompt is its positional.
   *
   * The result is vector paths, not pixels, so nothing is attached back as an
   * image: the file opens on the canvas, and the text names it and says how
   * many paths it has — which is the one number that separates a real drawing
   * from a stray blob.
   */
  shareTool(pi, {
    name: GENERATE_SVG_TOOL,
    label: 'Generate: SVG',
    description:
      'Draw an icon, logo, symbol or simple flat illustration as an SVG file, on-device with ' +
      'OmniSVG — from a short description, a reference image, or both. Every graphic goes ' +
      'through this: a website\'s logo and icons, a "simple illustration", a pictogram — ' +
      'whether or not the word SVG was used. Never write SVG markup by hand. One call per ' +
      'graphic; describe the shape and colour plainly ("a coffee cup, flat, two colours"). ' +
      'With an image it traces that image into vector paths. `out` puts the file where a ' +
      'page references it (assets/logo.svg); otherwise it lands in Generated and opens on ' +
      'the canvas. Photos and realistic pictures are not vectors — those are generation.',
    promptSnippet: 'Draw an icon, logo or simple illustration as an SVG (on-device)',
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({
          description:
            'What to draw, plainly: subject, shape, colour. Optional when an image is given.',
        }),
      ),
      image: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: 'Reference image path(s) to trace into SVG. Each becomes its own file.',
        }),
      ),
      candidates: Type.Optional(
        Type.Number({
          description: 'Samples per input; the best is kept. Default 3, max 6. More is slower.',
        }),
      ),
      out: Type.Optional(
        Type.String({
          description:
            'Where to put the file, relative to the working folder — assets/logo.svg. Use it ' +
            'when the SVG belongs to a site or project, so the page can reference it as ' +
            'written. With several inputs it is a folder.',
        }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<GenerateDetails>> {
      if (bridge === null) {
        return errResult(
          'generation bridge unavailable (the gen-tools extension must run inside Pi Desktop)',
        );
      }
      const images =
        params.image === undefined
          ? []
          : Array.isArray(params.image)
            ? params.image
            : [params.image];
      if ((params.prompt ?? '').trim() === '' && images.length === 0) {
        return errResult('give a prompt, a reference image path, or both');
      }
      /*
       * `out` IS FENCED THE WAY `write` IS. The model names a path; the file is
       * written by the app's main process, which can reach anywhere — so the
       * destination has to stay inside the working folder, the same rule the
       * write tool enforces, with the same shape of refusal (name the root,
       * say what to pass instead).
       */
      const root = path.resolve(process.env.PI_DESKTOP_WORKSPACE_ROOT ?? process.cwd());
      let outPath: string | undefined;
      if (params.out !== undefined && params.out.trim() !== '') {
        outPath = path.resolve(root, params.out.trim());
        if (outPath !== root && !outPath.startsWith(`${root}${path.sep}`)) {
          return errResult(
            `out must be inside the working folder (${root}) — pass a relative path such as assets/logo.svg`,
          );
        }
      }
      try {
        const result = await bridge.request<{
          outputs: readonly {
            outputPath: string;
            paths: number;
            source: string;
            stop: string;
            tokPerSec: number | null;
            tokens: number;
          }[];
        }>('generateSvg', {
          prompt: params.prompt,
          images,
          candidates: params.candidates,
          ...(outPath === undefined ? {} : { outPath }),
        });
        const lines = result.outputs.map(
          (o, i) =>
            `  ${i + 1}. ${o.outputPath} — ${o.paths} path${o.paths === 1 ? '' : 's'}` +
            `${o.source === 'prompt' ? '' : ` (from ${o.source})`}` +
            `${o.stop === 'eos' ? '' : ' — hit the length limit; may be incomplete'}`,
        );
        /* Say how to USE it, in the reply the model reads next: a page references
           the file by its path; the markup is not pasted back in. */
        const first = result.outputs[0];
        const rel =
          first !== undefined && first.outputPath.startsWith(`${root}${path.sep}`)
            ? path.relative(root, first.outputPath)
            : undefined;
        const usage =
          rel === undefined
            ? 'Reference it by its path, or `cp` it into a project; never retype its markup.'
            : `In a page: <img src="${rel}" alt="…">. Never retype its markup.`;
        const text =
          `Made ${result.outputs.length} SVG${result.outputs.length === 1 ? '' : 's'}` +
          `${outPath === undefined ? ' on the canvas' : ''}:\n` +
          `${lines.join('\n')}\n${usage}\nModel: OmniSVG 1.1 4B (omnisvg-1.1-4b, Apache-2.0)`;
        return {
          content: [{ type: 'text', text }],
          details: {
            ok: true,
            model: 'omnisvg-1.1-4b',
            outputs: result.outputs.map((o) => ({
              outputPath: o.outputPath,
              modality: 'image' as const,
              model: 'omnisvg-1.1-4b',
            })),
          },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `generate_svg failed: ${messageOf(err)}` }],
          details: { ok: false, error: messageOf(err) },
        };
      }
    },
  });
}
