/**
 * TURNING "THESE WEIGHTS ARE ON DISK" INTO A COMFY GRAPH.
 *
 * The workflow templates carry placeholder loader names — `t5xxl.safetensors`,
 * `ltxv-distilled-q4_k_m.gguf` — because a graph has to name SOMETHING and the
 * template cannot know what anyone downloaded. This resolves them against the
 * store manifest: which file in this model is the transformer, which is the text
 * encoder, which is the VAE.
 *
 * IT MATCHES ON PATH, NOT ON ORDER, and the patterns are deliberately loose.
 * Repos disagree about everything except roughly what things are called: a VAE
 * lives under `vae/` or has `vae` in its name, an encoder under `text_encoder/`
 * or `text_encoders/` or is called `t5`/`gemma`/`clip`. Being loose here means a
 * new repo layout usually just works; being strict would mean a new entry in
 * this file for every model, which is the thing that rots.
 *
 * WHEN IT CANNOT TELL, IT SAYS SO by returning undefined, and the studio refuses
 * the job with a sentence naming the model. That is much better than handing
 * Comfy a graph with a placeholder filename in it, which fails several minutes
 * later inside a Python traceback.
 */
import type { StoredModel } from '@pi-desktop/model-store';

export interface ResolvedWorkflow {
  /** Template id in the gen-service registry. */
  readonly template: string;
  /** Loader filenames, keyed by the template's param names. */
  readonly loaderInputs: Record<string, string>;
}

/** The first file whose path matches any pattern, or undefined. */
function pick(model: StoredModel, patterns: readonly RegExp[]): string | undefined {
  for (const rx of patterns) {
    const hit = model.files.find((f) => rx.test(f.path));
    if (hit !== undefined) return hit.path;
  }
  return undefined;
}

const WEIGHTS = /\.(safetensors|gguf|sft|ckpt)$/i;

/** The main transformer: the biggest weight file that is not an encoder or VAE. */
function pickTransformer(model: StoredModel): string | undefined {
  const candidates = model.files
    .filter((f) => WEIGHTS.test(f.path))
    .filter((f) => !/(^|\/)(vae|text_encoders?|tokenizer)\//i.test(f.path))
    .filter((f) => !/(vae|t5|clip|gemma|encoder)/i.test(f.path.split('/').pop() ?? ''))
    .sort((a, b) => b.bytes - a.bytes);
  return candidates[0]?.path;
}

/**
 * Which family this is, from the manifest rather than from a name the user could
 * have typed. `family` is written by the curated catalogue at download time.
 */
export function resolveWorkflow(
  model: StoredModel,
  kind: 'image' | 'video',
): ResolvedWorkflow | undefined {
  const transformer = pickTransformer(model);
  if (transformer === undefined) return undefined;

  const vae = pick(model, [/(^|\/)vae\/.*\.safetensors$/i, /vae.*\.safetensors$/i]);
  const clip = pick(model, [
    /(^|\/)text_encoders?\/.*\.safetensors$/i,
    /(t5|gemma|clip|qwen3vl).*\.(safetensors|gguf)$/i,
  ]);

  if (kind === 'video' && (model.family === 'ltx' || /ltx/i.test(model.repo))) {
    if (vae === undefined || clip === undefined) return undefined;
    return {
      template: 'ltx-video-2b-distilled-gguf',
      loaderInputs: { unetName: transformer, vaeName: vae, clipName: clip },
    };
  }

  if (kind === 'image' && (model.family === 'flux2' || /flux/i.test(model.repo))) {
    if (vae === undefined || clip === undefined) return undefined;
    return {
      template: 'flux1-dev-gguf-q6k',
      loaderInputs: { unetName: transformer, vaeName: vae, clipName: clip },
    };
  }

  return undefined;
}
