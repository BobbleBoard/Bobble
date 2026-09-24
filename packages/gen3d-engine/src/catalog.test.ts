import { describe, expect, it } from 'vitest';
import {
  autoremesherCli,
  detectInstalled,
  GEN3D_MODEL_SPECS,
  installStampPath,
  repoAttribution,
  specTotalBytes,
  TRELLIS_PIPELINE_TYPES,
  TRELLIS_RESOLUTIONS,
  toSidecarRegistry,
} from './catalog';

describe('catalog', () => {
  it('carries the verified TRELLIS resolution presets (512/1024/1536, not 768)', () => {
    expect(TRELLIS_RESOLUTIONS).toEqual({ low: 512, medium: 1024, high: 1536 });
    expect(TRELLIS_PIPELINE_TYPES.low).toBe('512');
    expect(TRELLIS_PIPELINE_TYPES.medium).toBe('1024_cascade');
    expect(TRELLIS_PIPELINE_TYPES.high).toBe('1536_cascade');
  });

  it('covers every contract model id exactly once', () => {
    expect(GEN3D_MODEL_SPECS.map((s) => s.id).sort()).toEqual([
      'ardy-motion',
      'autoremesher',
      'cubepart',
      'dasheng-sfx',
      'fluid-1-cleanup',
      'humanoid-rig',
      'mageflow',
      'mageflow-edit',
      'parakeet-asr',
      'qwen3-tts',
      'skintokens',
      'trellis2',
    ]);
  });

  it('trellis2 totals its four repos (core + ss-decoder + the two gated substitutes)', () => {
    const trellis = GEN3D_MODEL_SPECS.find((s) => s.id === 'trellis2');
    expect(trellis).toBeDefined();
    if (trellis === undefined) return;
    expect(trellis.repos).toHaveLength(4);
    expect(specTotalBytes(trellis)).toBe(
      16_237_485_044 + 147_592_217 + 1_212_584_680 + 444_566_195,
    );
  });

  it('ships NO separate texture model — TRELLIS re-bakes its own colours', () => {
    // Texturing used to pull Hunyuan Paint: the paintpbr subset (6.89 GB) plus
    // dinov2-giant (4.55 GB) = 11.4 GB of weights for something TRELLIS already
    // produces. The generation now saves its voxel colour field beside the mesh
    // and the Texture stage re-bakes from that, so nothing here backs 'texture'.
    expect(GEN3D_MODEL_SPECS.filter((s) => s.role === 'texture')).toEqual([]);
  });

  it('autoremesher has no weights — its size is the release dmg', () => {
    const remesher = GEN3D_MODEL_SPECS.find((s) => s.id === 'autoremesher');
    expect(remesher?.repos).toHaveLength(0);
    expect(specTotalBytes(remesher as NonNullable<typeof remesher>)).toBe(17_259_387);
  });

  it('detectInstalled reduces stamp-file existence per weight-backed model', () => {
    const cache = '/cache';
    const present = new Set([installStampPath(cache, 'trellis2'), autoremesherCli(cache)]);
    const installed = detectInstalled((p) => present.has(p), cache);
    expect(installed.trellis2).toBe(true);
    expect(installed.mageflow).toBe(false);
    expect(installed.cubepart).toBe(false);
    // Tools with nothing to download earn no stamp — probe what they need.
    expect(installed.autoremesher).toBe(true);
    expect(installed['humanoid-rig']).toBe(true);
  });

  it('a missing AutoRemesher binary reads as not installed, stamp or not', () => {
    const installed = detectInstalled(() => false, '/cache');
    expect(installed.autoremesher).toBe(false);
  });

  it('sidecar registry carries repos, mirrors and pipeline types', () => {
    const registry = toSidecarRegistry();
    expect(registry.models).toHaveLength(12); // cube3d removed
    expect(registry.gatedMirrors['facebook/dinov3-vitl16-pretrain-lvd1689m']).toContain(
      'camenduru',
    );
    expect(registry.pipelineTypes.high).toBe('1536_cascade');
    const mageflow = registry.models.find((m) => m.id === 'mageflow');
    // Comfy-Org's transformer + VAE (8,576,589,816) + Qwen3-VL-4B (8,887,284,080).
    expect(mageflow?.totalBytes).toBe(17_463_873_896);
  });

  it('attributes a repo to its one model, and a shared one to nobody in particular', () => {
    // One user: the card is that model's, exactly as before.
    expect(repoAttribution('ZhengPeng7/BiRefNet')).toEqual({
      label: 'TRELLIS-2 (4B)',
      blurb: GEN3D_MODEL_SPECS.find((s) => s.id === 'trellis2')?.note,
      roles: ['geometry'],
    });
    // The Mage-Flow text encoder is CubePart's prompt encoder too: a CubePart
    // user must not be told it is "Mage-Flow Turbo".
    expect(repoAttribution('Qwen/Qwen3-VL-4B-Instruct')).toEqual({
      blurb: 'Shared by Mage-Flow Turbo, Mage-Flow Edit and CubePart.',
      roles: ['image', 'segment'],
    });
    expect(repoAttribution('Comfy-Org/Mage-Flow')?.blurb).toBe(
      'Shared by Mage-Flow Turbo and Mage-Flow Edit.',
    );
    expect(repoAttribution('Comfy-Org/Mage-Flow')?.label).toBeUndefined();
    // The old microsoft/* copies on a shelf are still that model's weights.
    expect(repoAttribution('microsoft/Mage-Flow-Edit-Turbo')?.label).toBe('Mage-Flow Edit');
    expect(repoAttribution('microsoft/Mage-Flow-Turbo')?.label).toBe('Mage-Flow Turbo');
    expect(repoAttribution('someone/unrelated')).toBeUndefined();
  });

  it('models without pins, layouts or legacy repos serialize exactly as before', () => {
    // The sidecar JSON of every other model must not change shape (keys only
    // appear when set), or a Python side reading it strictly would break.
    const registry = toSidecarRegistry();
    for (const m of registry.models.filter((x) => !x.id.startsWith('mageflow'))) {
      expect(Object.keys(m).sort()).toEqual(['env', 'id', 'repos', 'totalBytes']);
      for (const r of m.repos) {
        expect(Object.keys(r).every((k) => ['repo', 'allowPatterns', 'bytes'].includes(k))).toBe(
          true,
        );
      }
    }
  });
});
