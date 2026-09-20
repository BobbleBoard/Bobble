/**
 * AN IMAGE ON ComfyUI. The image path was mflux-only — `handleGenerate` built
 * an `image` spec with an mflux command — until Qwen-Image 2.1 (2026-09-20),
 * which runs on a Mac only as GGUFs through ComfyUI. This is the image
 * counterpart of video-dispatch's `buildVideoJob`: a catalog IMAGE entry with
 * a `comfy` config + the normalised params → the `comfy` job the ComfyUI
 * adapter runs, with only the inputs the template binds (fillWorkflow throws
 * on an unbound one).
 *
 * One job carries every candidate seed: the adapter POSTs one prompt per seed
 * and the picture lands as `candidate` events, the same as an mflux batch.
 */
import type { ComfyJobSpec, GenJob, ModalityModel } from '@pi-desktop/gen-service';

export interface ComfyImageJobParams {
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly steps?: number;
  readonly negativePrompt?: string;
  /** Classifier-free guidance; only bound when the template has a `cfg`. */
  readonly guidance?: number;
  readonly seeds: readonly number[];
}

/** Whether a catalog image entry runs on ComfyUI (has a graph to fill). */
export function isComfyImageModel(model: ModalityModel): boolean {
  return model.modality === 'image' && model.backend === 'comfyui' && model.comfy !== undefined;
}

export function buildComfyImageJob(
  model: ModalityModel,
  params: ComfyImageJobParams,
  jobId: string,
  outputDir: string,
): GenJob {
  if (model.modality !== 'image') throw new Error(`model "${model.id}" is not an image model`);
  if (model.backend !== 'comfyui' || model.comfy === undefined) {
    throw new Error(`image model "${model.id}" has no ComfyUI workflow config`);
  }
  const binds = (key: string): boolean => key in (model.comfy?.paramMap ?? {});
  const inputs: Record<string, string | number | boolean> = {
    prompt: params.prompt,
    width: params.width,
    height: params.height,
  };
  if (binds('negativePrompt')) inputs.negativePrompt = params.negativePrompt ?? '';
  if (params.steps !== undefined && binds('steps')) inputs.steps = params.steps;
  if (params.guidance !== undefined && binds('cfg')) inputs.cfg = params.guidance;
  const comfy: ComfyJobSpec = {
    prompt: params.prompt,
    modelId: model.id,
    workflowTemplate: model.comfy.workflowTemplate,
    inputs,
    seeds: [...params.seeds],
  };
  return { id: jobId, modality: 'image', backend: 'comfyui', outputDir, comfy };
}
