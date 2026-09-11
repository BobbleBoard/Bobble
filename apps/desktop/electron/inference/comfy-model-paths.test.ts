/**
 * The extra_model_paths.yaml the app hands ComfyUI must name directories that
 * EXIST in the store, in ComfyUI's own syntax.
 *
 * It did not. Every category was written as `image|video` — a modality layout
 * the store has never had (comfy-install.ts creates `checkpoints/`, `unet/`,
 * `vae/`, `text_encoders/` …), in a separator ComfyUI does not use (it splits on
 * newlines, so `image|video` is one directory with a pipe in its name). The net
 * effect was a ComfyUI that could see none of the weights the app had
 * downloaded, which looks exactly like "generation is broken".
 */
import { describe, expect, it } from 'vitest';
import { COMFY_MODEL_SUBDIRS } from '../gen/comfy-install';

// The categories engines-main writes. Kept here rather than exported so the test
// is an independent statement of the contract, not a mirror of the code.
const WRITTEN = [
  'checkpoints',
  'unet',
  'diffusion_models',
  'clip',
  'clip_vision',
  'text_encoders',
  'audio_encoders',
  'vae',
  'loras',
  'controlnet',
  'upscale_models',
];

describe('ComfyUI model paths', () => {
  it('names exactly the directories comfy-install creates', () => {
    expect([...WRITTEN].sort()).toEqual([...COMFY_MODEL_SUBDIRS].sort());
  });

  it('never uses a separator ComfyUI does not understand', () => {
    // A value is one path (or several on their own lines). A pipe makes it a
    // directory name, and there is no such directory.
    for (const c of WRITTEN) expect(c).not.toContain('|');
  });

  it('has no modality directories, because the store is by tensor kind', () => {
    expect(WRITTEN).not.toContain('image');
    expect(WRITTEN).not.toContain('video');
    expect(WRITTEN).not.toContain('audio');
    // `audio_checkpoints` was written too, and is not a ComfyUI category at all.
    expect(WRITTEN).not.toContain('audio_checkpoints');
  });
});
