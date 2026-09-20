import { getModel } from '@pi-desktop/gen-service';
import { describe, expect, it } from 'vitest';
import { buildComfyImageJob, isComfyImageModel } from './image-dispatch';

describe('buildComfyImageJob', () => {
  const qwen = getModel('qwen-image-2.1');
  if (qwen === undefined) throw new Error('catalog lost qwen-image-2.1');

  it('recognises the ComfyUI image entries and not the mflux ones', () => {
    expect(isComfyImageModel(qwen)).toBe(true);
    const klein = getModel('flux2-klein-4b');
    expect(klein !== undefined && isComfyImageModel(klein)).toBe(false);
  });

  it('builds a comfy job with the template, the seeds and only the inputs the graph binds', () => {
    const job = buildComfyImageJob(
      qwen,
      {
        prompt: 'a red fox',
        width: 1024,
        height: 768,
        steps: 12,
        negativePrompt: 'blurry',
        guidance: 1,
        seeds: [1, 2],
      },
      'gen_1',
      '/tmp/out',
    );
    expect(job).toMatchObject({
      id: 'gen_1',
      modality: 'image',
      backend: 'comfyui',
      outputDir: '/tmp/out',
    });
    expect(job.comfy?.workflowTemplate).toBe('qwen-image-2.1-t2i');
    expect(job.comfy?.seeds).toEqual([1, 2]);
    expect(job.comfy?.inputs).toEqual({
      prompt: 'a red fox',
      width: 1024,
      height: 768,
      negativePrompt: 'blurry',
      steps: 12,
      cfg: 1,
    });
    expect(job.image).toBeUndefined();
  });

  it('leaves guidance and steps out when the caller gave none (the graph keeps its own)', () => {
    const job = buildComfyImageJob(
      qwen,
      { prompt: 'x', width: 1024, height: 1024, seeds: [7] },
      'g',
      '/o',
    );
    expect(job.comfy?.inputs).toEqual({
      prompt: 'x',
      width: 1024,
      height: 1024,
      negativePrompt: '',
    });
  });

  it('refuses an mflux image model and a non-image model', () => {
    const klein = getModel('flux2-klein-4b');
    if (klein === undefined) throw new Error('catalog lost klein');
    expect(() =>
      buildComfyImageJob(klein, { prompt: 'x', width: 1, height: 1, seeds: [1] }, 'g', '/o'),
    ).toThrow(/no ComfyUI workflow/);
    const tts = getModel('kokoro-82m');
    if (tts === undefined) throw new Error('catalog lost kokoro');
    expect(() =>
      buildComfyImageJob(tts, { prompt: 'x', width: 1, height: 1, seeds: [1] }, 'g', '/o'),
    ).toThrow(/not an image model/);
  });
});
