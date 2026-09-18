/**
 * A CATALOG AUDIO MODEL + PARAMS → THE RIGHT {@link GenJob} ARM.
 *
 * The audio side of the catalogue was the most complete unreachable thing in the
 * app: eleven models, a fully-specified `run_audio` in the Python worker (voice,
 * speed, lang, `--ref_audio` zero-shot clone, seeds-as-candidate-count), three
 * ComfyUI graphs (`ace-step-music`, `stable-audio-open`, `stable-audio-open-small`)
 * and a `GenJob.audio` arm in the protocol — with NO CALLER. `dispatch()` knew
 * `generate` and `generateVideo` and nothing else, so none of it could run.
 *
 * This is the missing middle, and it is deliberately the audio twin of
 * {@link buildVideoJob}: same shape, same injection seams, same "resolve the
 * catalogue entry, normalise the params, pick the arm" job.
 *
 * TWO BACKENDS, THREE KINDS OF SOUND. The split is not cosmetic — it decides
 * which arm of the job is filled in:
 *
 *   speech  → `mlx-audio` / `torch-tts` → the `audio` arm (uv worker, run_audio)
 *   music   → `comfyui` ace-step-music  → the `comfy` arm (graph + loaders)
 *   sfx     → `comfyui` stable-audio-*  → the `comfy` arm
 *
 * WHY THE KIND IS AN INPUT RATHER THAN INFERRED. A caller asking for a sound
 * effect and a caller asking for narration want different defaults (a 5-second
 * mono bang vs a paragraph read at speed 1.0) and different failure messages.
 * Inferring it from the model id would work right up until someone points a
 * music model at a line of dialogue and gets thirty seconds of singing.
 */
import path from 'node:path';
import type { AudioJobSpec, GenJob, ModalityModel } from '@pi-desktop/gen-service';

/** What the caller is asking for — see the file docstring for why this is explicit. */
export type AudioKind = 'speech' | 'music' | 'sfx';

/** Normalised audio parameters, already clamped by the caller. */
export interface AudioJobParams {
  readonly prompt: string;
  readonly kind: AudioKind;
  /** Seconds of audio, for the generative (non-speech) paths. */
  readonly seconds?: number;
  /** Diffusion steps, where the model has them. */
  readonly steps?: number;
  /** `--voice` preset, speech only. */
  readonly voice?: string;
  /** `--speed`, speech only. */
  readonly speed?: number;
  /** `--lang_code`, speech only. */
  readonly lang?: string;
  /** Reference clip for zero-shot voice cloning, speech only. */
  readonly refAudio?: string;
  /** Transcript of {@link refAudio}, for clone models that want it. */
  readonly refText?: string;
  /** One per candidate. */
  readonly seeds: readonly number[];
}

/**
 * The ComfyUI graph for a generative audio model.
 *
 * Read off the catalogue entry when it names one, and otherwise chosen from the
 * model id — the three audio graphs are named after the models they run, which
 * makes the fallback exact rather than a guess.
 */
export function audioWorkflowTemplate(model: ModalityModel): string | undefined {
  const explicit = model.comfy?.workflowTemplate;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (model.id === 'ace-step') return 'ace-step-music';
  if (model.id === 'stable-audio-open') return 'stable-audio-open';
  if (model.id === 'stable-audio-open-small') return 'stable-audio-open-small';
  return undefined;
}

/**
 * Default length in seconds for a kind.
 *
 * A sound effect is SHORT and a piece of music is not, and getting this wrong is
 * expensive in a way a wrong image size is not: audio generation cost scales
 * with duration, so a 30-second default on an SFX request wastes most of a
 * minute per attempt on sound nobody will keep.
 */
export function defaultSeconds(kind: AudioKind): number {
  if (kind === 'sfx') return 5;
  if (kind === 'music') return 20;
  return 0; // speech is as long as the text takes
}

/**
 * Resolve a catalogue audio model + params into a runnable job.
 *
 * Throws with the model named when the entry cannot support the request — a
 * music graph that is not installed, or a speech model with no resolved
 * mlx-audio repo. Refusing here with a sentence beats handing the worker a spec
 * with an empty `--model` and reading the traceback several seconds later.
 */
export function buildAudioJob(
  model: ModalityModel,
  params: AudioJobParams,
  jobId: string,
  outputDir: string,
): GenJob {
  if (model.modality !== 'audio') {
    throw new Error(`model "${model.id}" is not an audio model`);
  }

  if (model.backend === 'mlx-audio' || model.backend === 'torch-tts') {
    /*
     * SPEECH. `mlxAudioModel` is the RESOLVED repo, which is not always the
     * provenance repo — Kokoro's card is `hexgrad/Kokoro-82M` while mlx-audio
     * must load `prince-canuma/Kokoro-82M`. Falling back to `repo` when the
     * catalogue has not resolved one keeps entries that happen to agree working,
     * without inventing a value for the ones that do not.
     */
    const resolved = model.mlxAudioModel ?? model.repo;
    if (typeof resolved !== 'string' || resolved.length === 0) {
      throw new Error(`audio model "${model.id}" has no resolved mlx-audio repo to load`);
    }
    const audio: AudioJobSpec = {
      prompt: params.prompt,
      modelId: model.id,
      mlxAudioModel: resolved,
      seeds: params.seeds,
      audioFormat: 'wav',
      ...(params.voice !== undefined ? { voice: params.voice } : {}),
      ...(params.speed !== undefined ? { speed: params.speed } : {}),
      ...(params.lang !== undefined ? { lang: params.lang } : {}),
      ...(params.steps !== undefined ? { steps: params.steps } : {}),
      // `refText` is only meaningful WITH `refAudio`; emitting it alone would
      // put a stray --ref_text on a command line that has nothing to clone.
      ...(params.refAudio !== undefined ? { refAudio: params.refAudio } : {}),
      ...(params.refAudio !== undefined && params.refText !== undefined
        ? { refText: params.refText }
        : {}),
    };
    return {
      id: jobId,
      modality: 'audio',
      backend: model.backend,
      outputDir,
      audio,
    };
  }

  if (model.backend === 'comfyui') {
    const template = audioWorkflowTemplate(model);
    if (template === undefined) {
      throw new Error(`audio model "${model.id}" has no ComfyUI workflow graph`);
    }
    const seconds = params.seconds ?? defaultSeconds(params.kind);
    return {
      id: jobId,
      modality: 'audio',
      backend: 'comfyui',
      outputDir,
      comfy: {
        prompt: params.prompt,
        modelId: model.id,
        workflowTemplate: template,
        inputs: {
          prompt: params.prompt,
          negativePrompt: '',
          seconds,
          steps: params.steps ?? model.defaultSteps ?? 8,
        },
        seeds: [...params.seeds],
      },
    };
  }

  throw new Error(`audio model "${model.id}" has no runnable backend (${model.backend})`);
}

/** Where a job's audio lands, named after what was asked for rather than its id. */
export function audioOutputName(kind: AudioKind, prompt: string): string {
  const base = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const fallback = kind === 'speech' ? 'speech' : kind === 'music' ? 'music' : 'sfx';
  return base.length > 0 ? base : fallback;
}

/** The default catalogue model for a kind, from the models actually present. */
export function defaultAudioModel(
  kind: AudioKind,
  models: readonly ModalityModel[],
): ModalityModel | undefined {
  const audio = models.filter((m) => m.modality === 'audio');
  if (kind === 'speech') {
    const speech = audio.filter((m) => m.backend === 'mlx-audio' || m.backend === 'torch-tts');
    return speech.find((m) => m.recommended === true) ?? speech[0];
  }
  /*
   * BY KIND, IN ORDER. SEEN (the user, 2026-09-17): "sfx of a door creaking" ran
   * on stable-audio-3-MUSIC — the sfx pick named a model that is no longer in
   * the catalogue and the fallback was "the first ComfyUI audio model", which
   * is the music one. Each kind now names the builds tuned for it, newest
   * first, and only then takes whatever ComfyUI audio model there is.
   */
  const wanted =
    kind === 'sfx'
      ? ['stable-audio-3-sfx', 'stable-audio-open-small', 'stable-audio-open']
      : ['stable-audio-3-music', 'ace-step', 'stable-audio-open'];
  const comfy = audio.filter((m) => m.backend === 'comfyui');
  for (const id of wanted) {
    const hit = comfy.find((m) => m.id === id);
    if (hit !== undefined) return hit;
  }
  return comfy[0];
}

/** Absolute path helper mirroring the video dispatcher's output convention. */
export function audioOutputDir(root: string, name: string): string {
  return path.join(root, name);
}
