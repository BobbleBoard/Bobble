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
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
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
  /** Which of `svg`'s engines are on disk. Default both (tests). */
  readonly svgEngines?: SvgEngines;
}

/** The two models behind `svg`: OmniSVG draws pictures; VFIG writes figures as SVG code, and edits SVGs. */
export interface SvgEngines {
  readonly omnisvg: boolean;
  readonly vfig: boolean;
}

/*
 * A FIGURE IS VFIG'S. MEASURED 2026-09-25 (the SVG bake-off, and OmniSVG 1.1 on
 * the authors' own examples once pictures reached it): OmniSVG traces an icon or
 * an illustration well and cannot write a word — the kinetic-theory figure, a
 * bar chart, a GAN diagram and a logo with its name came back as scraps. VFIG
 * rebuilt each as SVG code with every label a <text> (the diagram at SSIM
 * 0.83), and made 3.5 of 4 edits to an existing SVG right. So an edit, or a
 * picture the model calls a figure, or one whose prompt names what only a
 * figure has, goes to VFIG; everything else to OmniSVG.
 */
const FIGURE_WORDS =
  /\b(figure|fig\.?|diagram|chart|graph|plot|axis|axes|label(?:l?ed|s)?|text|words?|equation|formula|table|schematic|circuit|flow ?chart|infographic|annotat\w*)\b/i;

export function svgEngineFor(
  req: {
    readonly prompt?: string;
    readonly images: readonly string[];
    readonly edit?: string;
    readonly figure?: boolean;
  },
  engines: SvgEngines,
): { engine: 'omnisvg' | 'vfig' } | { error: string } {
  const wantsVfig =
    req.edit !== undefined ||
    req.figure === true ||
    (req.images.length > 0 && FIGURE_WORDS.test(`${req.prompt ?? ''} ${req.images.join(' ')}`));
  if (wantsVfig) {
    if (engines.vfig) return { engine: 'vfig' };
    return {
      error:
        req.edit !== undefined
          ? 'editing an SVG needs VFIG, which is not installed here — edit the file yourself (it is SVG text), then present it'
          : 'turning a figure into SVG needs VFIG, which is not installed here — for a diagram use the diagram command; for a maths or physics figure, math',
    };
  }
  if (engines.omnisvg) return { engine: 'omnisvg' };
  return engines.vfig ? { engine: 'vfig' } : { error: 'no SVG model is installed' };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errResult(
  message: string,
  tool: string = GENERATE_IMAGE_TOOL,
): AgentToolResult<GenerateDetails> {
  return {
    content: [{ type: 'text', text: `${tool} failed: ${message}` }],
    details: { ok: false, error: message },
  };
}

/* The svg tool's failures in its own name. MEASURED (the suite's icon set):
   every refusal of the svg command read "`media generate image` failed" — the
   picture tool's name, which the CLI then turned into the wrong command. */
const svgErr = (message: string): AgentToolResult<GenerateDetails> =>
  errResult(message, GENERATE_SVG_TOOL);

function videoErrResult(message: string): AgentToolResult<GenerateDetails> {
  return {
    content: [{ type: 'text', text: `generate_video failed: ${message}` }],
    details: { ok: false, error: message },
  };
}

/**
 * Parse a `<w>x<h>` size string into even, bounded dimensions.
 *
 * The fallback is the CALLER's, because a still and a clip want different ones —
 * 1024x1024 is a good picture and an hour-long video on this class of machine.
 * See gen-manager's `VIDEO_DEFAULT_SIZE`.
 */
export function parseSize(
  size: string | undefined,
  fallback: { width: number; height: number } = { width: 1024, height: 1024 },
): { width: number; height: number } {
  if (size === undefined) return fallback;
  const m = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i.exec(size.trim());
  if (m === null) return fallback;
  const clamp = (n: number): number => Math.max(256, Math.min(1536, Math.round(n / 16) * 16));
  return { width: clamp(Number(m[1])), height: clamp(Number(m[2])) };
}

/*
 * ONLY THE MODELS THE IMAGE PATH CAN RUN. The catalog also lists a ComfyUI-
 * backed image model, and the manager's image path is mflux-only — so a list
 * taken from the modality alone advertised `flux1-dev-gguf`, the 4B chose it
 * for "high-quality", and was told "unknown or non-image model" by the very
 * tool that had offered it (SEEN). An offer has to be one the tool can keep.
 */
const IMAGE_MODEL_IDS = modelsForModality('image')
  .filter((m) => m.mflux !== undefined)
  .map((m) => m.id);
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

  if (svg) registerSvgTool(pi, bridge, options.svgEngines ?? { omnisvg: true, vfig: true });
  if (!media) return;

  shareTool(pi, {
    name: GENERATE_IMAGE_TOOL,
    label: 'Generate: Image',
    description:
      'Generate an image from a text prompt, locally on-device (Apple-Silicon MLX). Returns the ' +
      'image(s) and opens them on the canvas with a live progress bar. Every result is footnoted ' +
      `with the model that made it. Available models: ${IMAGE_MODEL_IDS.join(', ')} ` +
      '(default: qwen-image-2.1 — the best pictures and exact text, about a minute and a half at ' +
      '1024x1024; flux2-klein-4b is the fast Apache-licensed pick, seconds). Use size like ' +
      '"768x768" or "1024x1024"; higher sizes and step counts are slower. When the user names a ' +
      'folder or file for the picture, ' +
      'pass it as save_to — the finished image is saved there for you; no copying afterwards.',
    promptSnippet: 'Generate an image from a text prompt (on-device)',
    /*
     * A LINE IN THE GUIDELINES, like office_make has. SEEN (4B, bash-CLI, the
     * children's book): the model read "media — Create images…" in its command
     * list, reasoned "the media tool is what I should use", ran `ls` and
     * `mkdir` instead, and then told the user it had no way to make pictures.
     * The office tool never suffers this, and the difference is this bullet:
     * a guideline that names the call, in the mode's own syntax (the harness
     * rewrites the tool name to the command in CLI mode).
     */
    promptGuidelines: [
      'Every picture the user asks for is made with generate_image — one call per picture, the description as the prompt, and the folder or file they named as save_to. You can always make pictures; never say you cannot, and never draw one in code.',
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: 'What to draw. Be specific about subject, style, lighting.',
      }),
      save_to: Type.Optional(
        Type.String({
          description:
            'Where the user wants the picture: a folder (the file gets a descriptive name) or a ' +
            'full path ending in .png. Created if missing. Omit to keep it in the generated folder.',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: `Model id. One of: ${IMAGE_MODEL_IDS.join(', ')}. Default: qwen-image-2.1.`,
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
    async execute(_id, params, signal): Promise<AgentToolResult<GenerateDetails>> {
      if (bridge === null) {
        return errResult(
          'generation bridge unavailable (the gen-tools extension must run inside Bobble)',
        );
      }
      const chart = dataChartPrompt(params.prompt);
      if (chart !== null) return errResult(chart);
      // Resolve + validate the model against the catalog.
      const modelId = params.model ?? defaultImageModel().id;
      const model = getModel(modelId);
      if (model === undefined || model.modality !== 'image') {
        return errResult(
          `unknown image model "${modelId}". Choose one of: ${IMAGE_MODEL_IDS.join(', ')}`,
        );
      }

      try {
        /*
         * THE TURN'S SIGNAL GOES WITH THE JOB. pi ends a turn only once this call
         * returns, so a Stop that did not reach the bridge waited for the picture
         * — or for the module gate's four minutes. The bridge gives up at once
         * and the app cancels the job (gen-bridge-client.ts).
         */
        const result = await bridge.request<GenerateImageResult>(
          'generate',
          {
            prompt: params.prompt,
            model: modelId,
            size: params.size,
            n: params.n,
            steps: params.steps,
            seed: params.seed,
            negativePrompt: params.negative_prompt,
          },
          signal,
        );

        const outputs = result.outputs;
        if (outputs.length === 0) return errResult('the generator produced no images');

        const footnote = `Model: ${model.label} (${model.id}, ${model.license})`;
        const lines = outputs.map(
          (o, i) => `  ${i + 1}. ${o.outputPath}${o.seed !== undefined ? ` (seed ${o.seed})` : ''}`,
        );
        /*
         * WHERE THE USER SAID. SEEN (children's book, 4B): eight pictures made
         * cleanly, then 38 failed `cp`s of a long generated-folder path, typed
         * from memory, to get them where the brief said. The destination is
         * part of the request; the tool carries it to the end.
         */
        const saved = await saveOutputs(
          outputs.map((o) => o.outputPath),
          params.save_to,
          params.prompt,
        );
        const savedLines =
          saved.paths.length > 0
            ? `\nSaved to:\n${saved.paths.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`
            : '';
        const saveNote =
          saved.error !== undefined ? `\nCould not save to ${params.save_to}: ${saved.error}` : '';
        const text =
          `Generated ${outputs.length} image${outputs.length === 1 ? '' : 's'} on the canvas:\n` +
          `${lines.join('\n')}${savedLines}${saveNote}\n${footnote}`;

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
    /*
     * THE SAME LINE THE PICTURE TOOL HAS, FOR THE SAME REASON. MEASURED (4B,
     * CLI, the visual suite): asked for "a 6-second animated intro for my
     * YouTube channel 'Byte Sized'", it ran `media generate image
     * --save_to=byte_sized_intro.mp4`, then three more stills of "frames" —
     * eight minutes, no animation. The only generation call its guidelines
     * named was the picture one. Titles in motion are HyperFrames: a diffusion
     * video model cannot spell the channel's name.
     */
    promptGuidelines: [
      'Every animation or clip the user asks for is made with generate_video — never answered with still pictures. Words, titles and logos that move are motion graphics: model hyperframes, with the words to show in quotes. Real-world footage uses the default model.',
    ],
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
    async execute(_id, params, signal): Promise<AgentToolResult<GenerateDetails>> {
      if (bridge === null) {
        return videoErrResult(
          'generation bridge unavailable (the gen-tools extension must run inside Bobble)',
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
        const result = await bridge.request<GenerateVideoResult>(
          'generateVideo',
          {
            prompt: params.prompt,
            model: modelId,
            seconds: params.seconds,
            size: params.size,
            fps: params.fps,
            seed: params.seed,
            negativePrompt: params.negative_prompt,
          },
          signal,
        );

        const outputs = result.outputs;
        if (outputs.length === 0) return videoErrResult('the generator produced no video');

        const footnote = `Model: ${model.label} (${model.id}, ${model.license})`;
        const text = videoResultText(outputs, footnote);

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

/**
 * What the model reads back from `generate_video` — and what the thread reads
 * its cards out of (apps/desktop/src/chat/thread-media.ts mounts every absolute
 * media path in this text as a card).
 *
 * ONE ANIMATION IS ONE FILE. HyperFrames renders stills and joins them into one
 * animated PNG. The text used to list every still — 121 numbered paths for five
 * seconds at 24 fps — so the chat filled with 121 picture cards (the user: "each of
 * which was placed as it's own png card in the chat, severely cluttering it").
 * Now the one file is listed, and the frames are named by their FOLDER: a path
 * with no file extension, which the thread does not read as media, and which
 * the model can still open a single frame from.
 */
export function videoResultText(outputs: readonly GenOutput[], footnote: string): string {
  const lines = outputs.map(
    (o, i) => `  ${i + 1}. ${o.outputPath}${o.seed !== undefined ? ` (seed ${o.seed})` : ''}`,
  );
  const frames = outputs.length === 1 ? outputs[0]?.frames : undefined;
  if (frames === undefined) {
    return (
      `Generated ${outputs.length} video${outputs.length === 1 ? '' : 's'} on the canvas:\n` +
      `${lines.join('\n')}\n${footnote}`
    );
  }
  const n = frames.count;
  const clip = `${n} frame${n === 1 ? '' : 's'} at ${frames.fps} fps (${(n / frames.fps).toFixed(1)} s)`;
  const head = frames.animated
    ? `Generated 1 animation — ${clip}, looping — as ONE animated PNG:`
    : `Rendered ${clip}, but the frames could not be joined into one animated PNG, so this is the last frame on its own:`;
  const folder = `${frames.dir.replace(/\/+$/, '')}/`;
  const each = n === 1 ? 'The frame is' : `Each of the ${n} frames is`;
  return (
    `${head}\n${lines.join('\n')}\n` +
    `${each} also saved as its own PNG in the folder ${folder}\n${footnote}`
  );
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
      async execute(_id, params, signal): Promise<AgentToolResult<GenerateDetails>> {
        if (bridge === null) {
          return audioErrResult(
            name,
            'generation bridge unavailable (the gen-tools extension must run inside Bobble)',
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
          const result = await bridge.request<GenerateAudioResult>(
            'generateAudio',
            {
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
            },
            signal,
          );
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

/**
 * A CHART OF NUMBERS IS NOT A PICTURE. MEASURED on a 4B asked for a bar chart
 * of four figures: it ran image generation with "2021=12, 2022=19, 2023=27,
 * 2024=35" in the prompt, got a chart-shaped painting whose bars mean
 * nothing, and told the user it could not look at it. A diffusion model
 * cannot put a value on an axis; the office pipeline's `chart` kind draws
 * one from its numbers. The test is narrow on purpose — chart words AND at
 * least three numbers — so "a poster of a stock chart going up" (art, no
 * data) still paints.
 */
export function dataChartPrompt(prompt: string | undefined): string | null {
  const text = prompt ?? '';
  const chartWords =
    /\b(bar|line|pie|donut|scatter|area|column|stacked)\s*(chart|graph|plot)s?\b|\bhistogram\b|\b(chart|graph|plot)\s+(of|showing|with)\b/i;
  if (!chartWords.test(text)) return null;
  const numbers = text.match(/(?<![\w.])\d+(?:[.,]\d+)?%?(?![\w])/g) ?? [];
  if (numbers.length < 3) return null;
  return (
    'A chart of data is drawn from its numbers, not painted — image generation cannot put a value ' +
    'on an axis. Draw it with the chart tool instead: chart with the type, title, labels and values ' +
    '(CLI: chart bar "Title" --labels "2021, 2022, 2023" --values "12, 19, 27"). It appears in the ' +
    'chat as an interactive card in a second, and writes an .svg into the project for a page or a deck.'
  );
}

/**
 * The answer when an svg prompt is SVG markup rather than a description of a
 * drawing, or null when it is a description.
 */
export function svgMarkupPrompt(prompt: string | undefined): string | null {
  if (!/^\s*(?:<\?xml\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(prompt ?? '')) {
    return null;
  }
  const saved =
    'That prompt is SVG markup, and svg draws from a description (OmniSVG): it would have ' +
    'drawn stray shapes, not your markup. Markup you wrote is saved as it is — write it to ' +
    'a .svg file, then present that file to see it rendered. To have OmniSVG draw instead, ' +
    'describe the picture in one sentence.';
  /* MEASURED (STEM suite, 4B): the kinetic-theory cube and "why d/dx sin x =
     cos x" were each hand-written as markup and sent here — the cube a flat
     rectangle with its labels on one another. A maths or physics figure has a
     command that places and checks its labels; this is the moment to say so. */
  return MATH_MARKUP.test(prompt ?? '')
    ? `${saved} But this is a maths or physics figure: the math command draws it in the app's style, with its labels placed, checked, and steps tied to it — \`math --help\`.`
    : saved;
}

/** Words and marks of a maths or physics figure, in markup a model wrote. */
const MATH_MARKUP =
  /\b(axis|axes|graph|plot|sin|cos|tan|slope|tangent|derivative|integral|velocity|acceleration|force|mass|spring|molecule|wave|parabola|vertex|equation|triangle|hypotenuse|vector|momentum|pressure|oscillat\w*|pendulum|projectile)\b|[πθω∫∑√²³Δ]/i;

/** `generate_svg` — OmniSVG. Registered on its own so the connector can turn it
 *  on without the generation experiment. See the block below for the ask. */
function registerSvgTool(pi: ExtensionAPI, bridge: GenBridge | null, engines: SvgEngines): void {
  /* SHARED, like every tool here: the CLI runs only tools on the bus. A plain
     pi.registerTool left `svg` "no such command" in bash-CLI mode (MEASURED,
     vfig-svg-probe, 2026-09-25) while pi itself still listed it. */
  shareTool(pi, {
    name: GENERATE_SVG_TOOL,
    label: 'Generate: SVG',
    description:
      /* the user (2026-09-24): "I feel like there's something wrong with omnisvg or
         maybe just how it's used" — every graphic was routed here, including
         icon sets and logos with names, which OmniSVG cannot make; the model
         now writes those itself and checks them with present. */
      'Make an SVG on-device. Two models, chosen by the job: OmniSVG draws an organic, ' +
      'illustrative picture from a short description or traces a picture into vector paths; ' +
      'VFIG turns a FIGURE — a diagram, a chart, a labelled drawing, anything with words — into ' +
      'SVG code with its words as real text (--figure, with the picture), and changes an SVG that ' +
      'exists (--edit file.svg, with what to change as the prompt). OmniSVG cannot keep a set ' +
      'consistent or write a word: icons, a logo with its name, patterns and exact shapes are ' +
      'better written as SVG yourself and checked with present. One call per drawing, a picture ' +
      'prompt one caption-like sentence — the subject, its colours and shapes, the style ("A red ' +
      'lighthouse on a green cliff at sunset, flat colours, centered."); a bare name or a slug ' +
      'draws something else. `out` puts the file where a page references it (assets/hero.svg); ' +
      'otherwise it lands in Generated. Photos and realistic pictures are not vectors — those ' +
      'are generation. A new flowchart or process is the diagram command, numbers the chart ' +
      'command, a maths or physics figure the math command.',
    promptSnippet:
      'Draw an illustration or trace a picture (OmniSVG); turn a figure into SVG code, or edit an SVG (VFIG)',
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({
          description:
            /* MEASURED 2026-09-25 (the app's pipeline, Q8): "a coffee cup icon"
               drew stacked bowls; "A brown coffee cup on a saucer with white
               steam curls, flat icon, centered." drew the cup. OmniSVG was
               trained on captions, and a caption is what it draws from. */
            'What to draw, as one caption-like sentence: the subject, its colours and shapes, ' +
            'the style. With --edit, what to change. Optional when an image is given.',
        }),
      ),
      image: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description: 'Picture(s) to trace into SVG. Each becomes its own file.',
        }),
      ),
      figure: Type.Optional(
        Type.Boolean({
          description:
            'The picture is a figure — a diagram, chart, labelled drawing, anything with words: VFIG rebuilds it as SVG code, its words as text.',
        }),
      ),
      edit: Type.Optional(
        Type.String({
          description:
            'An SVG file to change (relative to the working folder); the prompt says what to change. The file is changed in place.',
        }),
      ),
      candidates: Type.Optional(
        Type.Number({
          description:
            'OmniSVG: samples per input; the best is kept. Default 3, max 6. More is slower.',
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
    async execute(_id, params, signal): Promise<AgentToolResult<GenerateDetails>> {
      if (bridge === null) {
        return svgErr(
          'generation bridge unavailable (the gen-tools extension must run inside Bobble)',
        );
      }
      const images =
        params.image === undefined
          ? []
          : Array.isArray(params.image)
            ? params.image
            : [params.image];
      const edit =
        typeof params.edit === 'string' && params.edit.trim() !== ''
          ? params.edit.trim()
          : undefined;
      if ((params.prompt ?? '').trim() === '' && images.length === 0) {
        return svgErr(
          edit !== undefined
            ? 'say what to change in the prompt'
            : 'give a prompt, a reference image path, or both',
        );
      }
      /*
       * A PROMPT THAT IS ALREADY SVG IS THE MODEL'S OWN DRAWING. MEASURED (4B,
       * the visual suite's Pythagorean animation): `svg --out=animation "<?xml
       * …><svg …>"` — six thousand characters of markup it had written, sent
       * to OmniSVG as a description. OmniSVG drew five stray paths, and the
       * model's drawing went nowhere. Markup is saved, not described.
       */
      const markup = svgMarkupPrompt(params.prompt);
      if (markup !== null) return svgErr(markup);
      /*
       * `out` IS FENCED THE WAY `write` IS. The model names a path; the file is
       * written by the app's main process, which can reach anywhere — so the
       * destination has to stay inside the working folder, the same rule the
       * write tool enforces, with the same shape of refusal (name the root,
       * say what to pass instead). An edit's file is fenced the same way.
       */
      const root = path.resolve(process.env.PI_DESKTOP_WORKSPACE_ROOT ?? process.cwd());
      const inside = (p: string) => p === root || p.startsWith(`${root}${path.sep}`);
      let outPath: string | undefined;
      if (params.out !== undefined && params.out.trim() !== '') {
        outPath = path.resolve(root, params.out.trim());
        if (!inside(outPath)) {
          return svgErr(
            `out must be inside the working folder (${root}) — pass a relative path such as assets/logo.svg`,
          );
        }
      }
      let editPath: string | undefined;
      if (edit !== undefined) {
        editPath = path.resolve(root, edit);
        if (!inside(editPath) || !/\.svg$/i.test(editPath)) {
          return svgErr(
            `--edit takes an .svg file inside the working folder (${root}), such as assets/logo.svg`,
          );
        }
      }
      /*
       * A PICTURE'S PATH IS THE WORKING FOLDER'S. The main process reads the
       * file, and its cwd is the app's own — so `svg --image photo.png` read
       * nothing (ENOENT from the app bundle) unless the path was absolute. It
       * is resolved the way `write` resolves, and one that is not there is named.
       */
      const pictures: string[] = [];
      for (const img of images) {
        const abs = path.resolve(root, img.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~'));
        if (
          !(await stat(abs)
            .then((st) => st.isFile())
            .catch(() => false))
        ) {
          return svgErr(
            `there is no picture at ${img} (in ${root}) — check the path, or save the picture there first`,
          );
        }
        pictures.push(abs);
      }
      const route = svgEngineFor(
        {
          prompt: params.prompt,
          images,
          ...(edit !== undefined ? { edit } : {}),
          ...(params.figure === true ? { figure: true } : {}),
        },
        engines,
      );
      if ('error' in route) return svgErr(route.error);
      const model = route.engine === 'vfig' ? 'vfig-4b' : 'omnisvg-1.1-4b';
      try {
        const result = await bridge.request<{
          outputs: readonly {
            outputPath: string;
            paths: number;
            source: string;
            stop: string;
            complete?: boolean;
            tokPerSec: number | null;
            tokens: number;
          }[];
        }>(
          'generateSvg',
          {
            engine: route.engine,
            prompt: params.prompt,
            images: pictures,
            candidates: params.candidates,
            ...(editPath === undefined ? {} : { edit: editPath }),
            ...(outPath === undefined ? {} : { outPath }),
          },
          signal,
        );
        const cutShort = (o: { stop: string; complete?: boolean }) =>
          route.engine === 'vfig'
            ? o.complete === false
              ? ` — it stopped before the end (${o.stop === 'loop' ? 'it began repeating itself, and was cut there' : o.stop === 'stall' ? 'it went on writing definitions without drawing anything, and was cut there' : 'the context filled'}); the file is closed and valid, but may be missing its last parts`
              : ''
            : o.stop === 'eos'
              ? ''
              : ' — hit the length limit; may be incomplete';
        const lines = result.outputs.map(
          (o, i) =>
            `  ${i + 1}. ${o.outputPath} — ${o.paths} ${route.engine === 'vfig' ? 'element' : 'path'}${o.paths === 1 ? '' : 's'}` +
            `${o.source === 'prompt' ? '' : ` (from ${o.source})`}${cutShort(o)}`,
        );
        /* Say how to USE it, in the reply the model reads next: a page references
           the file by its path; the markup is not pasted back in. */
        const first = result.outputs[0];
        const rel =
          first !== undefined && first.outputPath.startsWith(`${root}${path.sep}`)
            ? path.relative(root, first.outputPath)
            : undefined;
        const usage =
          editPath !== undefined
            ? 'The file is changed in place.'
            : rel === undefined
              ? 'Reference it by its path, or `cp` it into a project; never retype its markup.'
              : `In a page: <img src="${rel}" alt="…">. Never retype its markup.`;
        /* What a call makes stays in the work until it is presented (the user,
           2026-09-24, turn-cards.ts) — and present renders the drawing back, the
           one look the model gets at what was made. */
        const shown =
          'It is in your work; present it when it is what they asked for — present also shows you the drawing.';
        const made =
          editPath !== undefined
            ? `Edited ${path.relative(root, editPath)}`
            : `Made ${result.outputs.length} SVG${result.outputs.length === 1 ? '' : 's'}${outPath === undefined ? ' on the canvas' : ''}`;
        const byline =
          route.engine === 'vfig'
            ? 'Model: VFIG 4B (vfig-4b) — SVG code, its words as text, so it can be edited'
            : 'Model: OmniSVG 1.1 4B (omnisvg-1.1-4b, Apache-2.0)';
        const text = `${made}:\n${lines.join('\n')}\n${usage} ${shown}\n${byline}`;
        return {
          content: [{ type: 'text', text }],
          details: {
            ok: true,
            model,
            outputs: result.outputs.map((o) => ({
              outputPath: o.outputPath,
              modality: 'image' as const,
              model,
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

/** A short file-safe name from the prompt, for a picture saved into a folder. */
export function pictureName(prompt: string, index: number, count: number): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'image';
  return count > 1 ? `${slug}-${index + 1}.png` : `${slug}.png`;
}

/**
 * Copy the finished pictures to where the user asked. A path ending in .png is
 * a FILE (the first candidate takes it, the rest sit beside it numbered); any
 * other path is a FOLDER, created if missing, and each picture gets a name from
 * its prompt. `~` is the home directory. Never throws: a destination that
 * cannot be written is reported in the tool text, with the pictures still in
 * the generated folder.
 */
export async function saveOutputs(
  outputPaths: readonly string[],
  saveTo: string | undefined,
  prompt: string,
  deps: {
    copy?: (from: string, to: string) => Promise<void>;
    ensureDir?: (dir: string) => Promise<void>;
    isDir?: (p: string) => Promise<boolean>;
    /** What a relative destination is relative to (default: the working folder). */
    root?: string;
  } = {},
): Promise<{ paths: string[]; error?: string }> {
  if (saveTo === undefined || saveTo.trim() === '' || outputPaths.length === 0)
    return { paths: [] };
  const copy = deps.copy ?? ((from, to) => copyFile(from, to));
  const ensureDir = deps.ensureDir ?? (async (dir) => void (await mkdir(dir, { recursive: true })));
  const isDir =
    deps.isDir ??
    (async (p: string) => {
      try {
        return (await stat(p)).isDirectory();
      } catch {
        return false;
      }
    });
  let target = saveTo.trim();
  if (target === '~' || target.startsWith('~/')) target = path.join(homedir(), target.slice(1));
  /*
   * `/cow-on-the-moon.png` IS NOT A FILE AT THE ROOT OF THE DISK. SEEN
   * 2026-09-15 (qwen3.5-4b): a leading slash on a bare name, twice in one turn
   * — the same slip the file tools repair as a dropped root — and macOS's
   * read-only system volume answered EACCES. Nothing a model asks for lives
   * at `/`; a single segment under it means the working folder.
   */
  if (/^\/[^/]+$/.test(target)) target = target.slice(1);
  const trailingSlash = /[\\/]$/.test(target);
  /*
   * RELATIVE TO THE WORKING FOLDER, the one the prompt names. MEASURED
   * 2026-09-15: told "Working folder: …/Bobble/image-of-a-cow — relative paths
   * resolve inside it", the model asked for `--save_to=cow-on-the-moon.png`,
   * and the picture landed in …/Bobble — pi's own cwd, one level up — so its
   * `coordinate present cow-on-the-moon.png`, resolved where the prompt said,
   * found nothing. The harness publishes the live folder on the env the
   * `svg` command's `out` already reads (WORKSPACE_ROOT_ENV); a relative
   * `save_to` means the same folder every other relative path means.
   */
  target = path.resolve(
    deps.root ?? process.env.PI_DESKTOP_WORKSPACE_ROOT ?? process.cwd(),
    target,
  );
  /*
   * FILE OR FOLDER. Named with an image extension: a file. A trailing slash,
   * or a directory that already exists: a folder. Otherwise — SEEN (4B): eight
   * pictures each sent to ".../childrens-book/title-slide" and the like, a name
   * with no extension meant as the file — a single picture takes the name and
   * gets ".png"; several pictures make it a folder.
   */
  const named = /\.(png|jpe?g|webp)$/i.test(target);
  /*
   * …AND A NAME WITH ANY OTHER EXTENSION IS A FILE TOO, never a folder named
   * like one. FOUND by the visual suite (4B, 2026-09-25): asked for an SVG, the
   * model generated a picture with `--save_to=lighthouse-sunset.svg`; that fell
   * through to "a folder", a DIRECTORY named lighthouse-sunset.svg was made with
   * the PNG inside, and every later `write lighthouse-sunset.svg` failed with
   * EISDIR — the model flailed out of its working folder over it. The bytes are
   * PNG, so the file takes .png below, as a .jpg name already does.
   */
  const otherExt = !named && /\.[a-z0-9]{1,5}$/i.test(path.basename(target));
  const asFile =
    ((named || otherExt) && !trailingSlash && !(await isDir(target))) ||
    (!named &&
      !trailingSlash &&
      outputPaths.length === 1 &&
      path.extname(target) === '' &&
      !(await isDir(target)));
  if (asFile && !named && !otherExt) target = `${target}.png`;
  /*
   * THE BYTES ARE PNG. A name ending in .jpg keeps its name and gets the
   * extension the file really has (SEEN: `--save-to fox-storybook.jpg`, 2.2 MB
   * of PNG under a .jpg name) — a lie in the extension outlives the chat.
   */
  const produced = path.extname(outputPaths[0] ?? '').toLowerCase() || '.png';
  if (asFile && path.extname(target).toLowerCase() !== produced) {
    target = target.replace(/\.[a-z0-9]+$/i, produced);
  }
  const paths: string[] = [];
  try {
    if (asFile) {
      await ensureDir(path.dirname(target));
      for (let i = 0; i < outputPaths.length; i += 1) {
        const dest = i === 0 ? target : target.replace(/\.png$/i, `-${i + 1}.png`);
        await copy(outputPaths[i] as string, dest);
        paths.push(dest);
      }
    } else {
      await ensureDir(target);
      for (let i = 0; i < outputPaths.length; i += 1) {
        const dest = path.join(target, pictureName(prompt, i, outputPaths.length));
        await copy(outputPaths[i] as string, dest);
        paths.push(dest);
      }
    }
    return { paths };
  } catch (err) {
    return { paths, error: err instanceof Error ? err.message : String(err) };
  }
}
