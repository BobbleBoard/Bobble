/**
 * The audio dispatcher, tested against the REAL catalogue.
 *
 * Deliberately not against fixtures: the whole bug this file exists to fix was
 * that eleven catalogued audio models, three ComfyUI graphs and a fully written
 * `run_audio` worker had no caller, so anything that stubs the catalogue would
 * have passed happily the whole time it was unreachable. These assertions fail
 * if the catalogue entry loses the field the worker needs.
 */
import { getModel, MODALITY_CATALOG } from '@pi-desktop/gen-service';
import { describe, expect, it } from 'vitest';
import {
  audioWorkflowTemplate,
  buildAudioJob,
  defaultAudioModel,
  defaultSeconds,
} from './audio-dispatch';

const seeds = [7];

describe('speech jobs (the uv worker arm)', () => {
  it('fills the audio arm, not the comfy arm', () => {
    const model = getModel('kokoro-82m');
    if (model === undefined) throw new Error('kokoro-82m is missing from the catalogue');
    const job = buildAudioJob(
      model,
      { prompt: 'hello there', kind: 'speech', seeds },
      'j1',
      '/out',
    );
    expect(job.modality).toBe('audio');
    expect(job.backend).toBe('mlx-audio');
    expect(job.audio?.prompt).toBe('hello there');
    expect(job.comfy).toBeUndefined();
  });

  it('passes the RESOLVED mlx-audio repo, not the provenance one', () => {
    /*
     * The catalogue's own correction: Kokoro's model card is hexgrad/Kokoro-82M
     * but mlx-audio can only load prince-canuma/Kokoro-82M. Sending the card's
     * repo is a load failure several seconds into the worker.
     */
    const model = getModel('kokoro-82m');
    if (model === undefined) throw new Error('kokoro-82m is missing from the catalogue');
    const job = buildAudioJob(model, { prompt: 'x', kind: 'speech', seeds }, 'j', '/out');
    expect(job.audio?.mlxAudioModel).toBe('prince-canuma/Kokoro-82M');
    expect(job.audio?.mlxAudioModel).not.toBe(model.repo);
  });

  it('carries a reference clip through for zero-shot cloning', () => {
    const model = getModel('qwen3-tts-1.7b');
    if (model === undefined) throw new Error('qwen3-tts-1.7b is missing from the catalogue');
    const job = buildAudioJob(
      model,
      { prompt: 'read this', kind: 'speech', refAudio: '/tmp/me.wav', refText: 'sample', seeds },
      'j',
      '/out',
    );
    expect(job.audio?.refAudio).toBe('/tmp/me.wav');
    expect(job.audio?.refText).toBe('sample');
  });

  it('never emits refText without refAudio', () => {
    // --ref_text alone puts a transcript on a command line with nothing to clone.
    const model = getModel('qwen3-tts-1.7b');
    if (model === undefined) throw new Error('qwen3-tts-1.7b is missing from the catalogue');
    const job = buildAudioJob(
      model,
      { prompt: 'read this', kind: 'speech', refText: 'orphan', seeds },
      'j',
      '/out',
    );
    expect(job.audio?.refText).toBeUndefined();
  });

  it('seeds drive the candidate count', () => {
    const model = getModel('kokoro-82m');
    if (model === undefined) throw new Error('kokoro-82m is missing from the catalogue');
    const job = buildAudioJob(model, { prompt: 'x', kind: 'speech', seeds: [1, 2, 3] }, 'j', '/o');
    expect(job.audio?.seeds).toEqual([1, 2, 3]);
  });
});

describe('music and SFX jobs (the ComfyUI arm)', () => {
  it('routes ACE-Step to its music graph', () => {
    const model = getModel('ace-step');
    if (model === undefined) throw new Error('ace-step is missing from the catalogue');
    const job = buildAudioJob(model, { prompt: 'lo-fi piano', kind: 'music', seeds }, 'j', '/out');
    expect(job.backend).toBe('comfyui');
    expect(job.comfy?.workflowTemplate).toBe('ace-step-music');
    expect(job.audio).toBeUndefined();
  });

  it('routes the small Stable Audio build to the SFX graph', () => {
    const model = getModel('stable-audio-open-small');
    if (model === undefined) throw new Error('stable-audio-open-small is missing');
    const job = buildAudioJob(model, { prompt: 'door slam', kind: 'sfx', seeds }, 'j', '/out');
    expect(job.comfy?.workflowTemplate).toBe('stable-audio-open-small');
  });

  it('gives SFX a SHORT default and music a long one', () => {
    /*
     * Not cosmetic: audio cost scales with duration, so a 20-second default on a
     * door slam wastes most of a minute per attempt on sound nobody keeps.
     */
    expect(defaultSeconds('sfx')).toBe(5);
    expect(defaultSeconds('music')).toBe(20);
    const model = getModel('stable-audio-open-small');
    if (model === undefined) throw new Error('stable-audio-open-small is missing');
    const job = buildAudioJob(model, { prompt: 'thud', kind: 'sfx', seeds }, 'j', '/out');
    expect(job.comfy?.inputs.seconds).toBe(5);
  });

  it('every ComfyUI audio model in the catalogue resolves to a graph', () => {
    // The check that would have caught the original gap: a catalogued model with
    // no way to run is worse than an absent one, because it advertises itself.
    const comfyAudio = MODALITY_CATALOG.filter(
      (m) => m.modality === 'audio' && m.backend === 'comfyui',
    );
    expect(comfyAudio.length).toBeGreaterThan(0);
    for (const m of comfyAudio) {
      expect(audioWorkflowTemplate(m), `${m.id} has no workflow graph`).toBeDefined();
    }
  });
});

describe('refusals', () => {
  it('refuses a non-audio model by name', () => {
    const model = getModel('flux2-klein-4b');
    if (model === undefined) throw new Error('flux2-klein-4b is missing from the catalogue');
    expect(() => buildAudioJob(model, { prompt: 'x', kind: 'music', seeds }, 'j', '/o')).toThrow(
      /not an audio model/,
    );
  });
});

describe('defaults', () => {
  it('picks a speech model for speech and a comfy model for sound', () => {
    const speech = defaultAudioModel('speech', MODALITY_CATALOG);
    expect(speech?.modality).toBe('audio');
    expect(['mlx-audio', 'torch-tts']).toContain(speech?.backend);

    const sfx = defaultAudioModel('sfx', MODALITY_CATALOG);
    expect(sfx?.id).toBe('stable-audio-open-small');

    const music = defaultAudioModel('music', MODALITY_CATALOG);
    expect(music?.id).toBe('ace-step');
  });
});
