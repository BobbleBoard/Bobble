import type { StoredModel } from '@pi-desktop/model-store';
import { describe, expect, it } from 'vitest';
import { resolveWorkflow } from './studio-workflow';

const model = (
  over: Partial<StoredModel> & { id: string; files: StoredModel['files'] },
): StoredModel => ({
  repo: over.id,
  name: over.id,
  org: 'x',
  kind: 'video',
  dir: `/store/video/${over.id}`,
  bytes: 0,
  installedAt: '2026-08-21T00:00:00.000Z',
  source: 'store',
  ...over,
});

const f = (path: string, bytes: number) => ({ path, bytes });

describe('resolving a ComfyUI graph from what is on disk', () => {
  it('names the real files, not the template placeholders', () => {
    // The templates ship `t5xxl.safetensors` / `ltxv-distilled-q4_k_m.gguf`
    // because a graph has to name something; nobody's store contains those.
    const ltx = model({
      id: 'city96__ltx-video-0.9.6-distilled-gguf',
      family: 'ltx',
      files: [
        f('ltxv-2b-0.9.6-distilled-04-25-Q4_K_M.gguf', 1_330_000_000),
        f('LTX-Video-0.9.6-VAE-BF16.safetensors', 2_490_000_000),
      ],
    });
    const t5 = model({
      id: 'city96__t5-v1_1-xxl-encoder-gguf',
      files: [f('t5-v1_1-xxl-encoder-Q4_K_M.gguf', 2_900_000_000)],
    });
    const out = resolveWorkflow(ltx, 'video', [ltx, t5]);
    expect(out?.template).toBe('ltx-video-2b-distilled-gguf');
    expect(out?.loaderInputs.unetName).toBe('ltxv-2b-0.9.6-distilled-04-25-Q4_K_M.gguf');
    expect(out?.loaderInputs.vaeName).toBe('LTX-Video-0.9.6-VAE-BF16.safetensors');
  });

  it('finds the encoder in a SIBLING repo, which is where the quants put it', () => {
    // The whole reason a recipe spans repos: the transformer is city96's LTX
    // build, the T5 encoder is city96's separate encoder build.
    const ltx = model({
      id: 'ltxrepo',
      family: 'ltx',
      files: [f('ltxv-2b-Q4_K_M.gguf', 1_330_000_000), f('vae/ltx-vae.safetensors', 2_000_000_000)],
    });
    const t5 = model({
      id: 'city96__t5-v1_1-xxl-encoder-gguf',
      files: [f('t5-v1_1-xxl-encoder-Q4_K_M.gguf', 2_900_000_000)],
    });
    const out = resolveWorkflow(ltx, 'video', [ltx, t5]);
    // Named relative to the store's KIND root, which is what the yaml points at.
    expect(out?.loaderInputs.clipName).toBe(
      'city96__t5-v1_1-xxl-encoder-gguf/t5-v1_1-xxl-encoder-Q4_K_M.gguf',
    );
  });

  it('refuses rather than handing Comfy a graph it cannot load', () => {
    // A transformer with no encoder anywhere is an incomplete setup, and saying
    // so beats a Python traceback five minutes into a run.
    const lonely = model({
      id: 'ltxrepo',
      family: 'ltx',
      files: [f('ltxv-2b-Q4_K_M.gguf', 1_330_000_000)],
    });
    expect(resolveWorkflow(lonely, 'video', [lonely])).toBeUndefined();
  });

  it('does not mistake the VAE or the encoder for the transformer', () => {
    // The transformer is picked as the biggest weight that is NOT one of those;
    // a 2.5 GB VAE beside a 1.3 GB transformer would otherwise win on size.
    const m = model({
      id: 'ltxrepo',
      family: 'ltx',
      files: [
        f('ltxv-2b-Q4_K_M.gguf', 1_330_000_000),
        f('LTX-Video-VAE-BF16.safetensors', 2_490_000_000),
        f('text_encoders/t5.gguf', 2_900_000_000),
      ],
    });
    expect(resolveWorkflow(m, 'video', [m])?.loaderInputs.unetName).toBe('ltxv-2b-Q4_K_M.gguf');
  });
});
