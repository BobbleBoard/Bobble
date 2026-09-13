import { describe, expect, it } from 'vitest';
import {
  applyLibraryMigration,
  comfyShelfFor,
  hubShelfFor,
  type LegacySnapshot,
  planLibraryMigration,
} from './library-migration';

const snap = (over: Partial<LegacySnapshot> = {}): LegacySnapshot => ({
  cacheRoot: '/c',
  libraryRoot: '/L',
  ggufIds: [],
  mlxSlugs: [],
  comfyFiles: {},
  hubEntries: [],
  hubFeatureByRepo: {},
  gen3dModels: [],
  omnisvgSubdirs: [],
  ...over,
});

describe('where the weights on this Mac go', () => {
  it('files ComfyUI weights by what they make, from their names', () => {
    expect(comfyShelfFor('LTX-2.5-Distilled-Q4_K_M.gguf')).toBe('Video/Generation');
    expect(comfyShelfFor('MiniMax-H3-FL2VA-Pruned-Q3_K_M.gguf')).toBe('Video/Generation');
    expect(comfyShelfFor('umt5-xxl-encoder-Q5_K_M.gguf')).toBe('Video/Generation');
    expect(comfyShelfFor('wan2.1_t2v_1.3B_fp16.safetensors')).toBe('Video/Generation');
    expect(comfyShelfFor('gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors')).toBe(
      'Video/Generation',
    );
    expect(comfyShelfFor('ace_step_1.5_turbo_aio.safetensors')).toBe('Audio/Music');
    expect(comfyShelfFor('qwen_4b_ace15.safetensors')).toBe('Audio/Music');
    expect(comfyShelfFor('minimax_music3_dit_fp16.safetensors')).toBe('Audio/Music');
    expect(comfyShelfFor('stable_audio_3_small_music.safetensors')).toBe('Audio/Music');
    expect(comfyShelfFor('stable_audio_3_small_sfx.safetensors')).toBe('Audio/SFX');
    expect(comfyShelfFor('stable-audio-open-1.0.safetensors')).toBe('Audio/SFX');
    expect(comfyShelfFor('t5gemma_b_b_ul2.safetensors')).toBe('Audio/Music');
    expect(comfyShelfFor('flux1-dev-Q6_K.gguf')).toBe('Image/Generation');
    expect(comfyShelfFor('mystery_weights.safetensors')).toBe('Unsorted');
  });

  it('files the workers’ hub repos by the feature that lists them, support models apart', () => {
    expect(hubShelfFor('microsoft/TRELLIS.2-4B', 'trellis2')).toBe('3D/Generation');
    expect(hubShelfFor('camenduru/dinov3-vitl16-pretrain-lvd1689m', 'trellis2')).toBe('Support');
    expect(hubShelfFor('ZhengPeng7/BiRefNet', 'trellis2')).toBe('Support');
    expect(hubShelfFor('microsoft/Mage-Flow-Edit-Turbo', 'mageflow-edit')).toBe('Image/Editing');
    expect(hubShelfFor('microsoft/Mage-Flow-Turbo', 'mageflow')).toBe('Image/Generation');
    expect(hubShelfFor('Roblox/cubepart', 'cubepart')).toBe('3D/Generation');
    expect(hubShelfFor('Qwen/Qwen3-VL-4B-Instruct', 'cubepart')).toBe('Support');
    expect(hubShelfFor('VAST-AI/SkinTokens', 'skintokens')).toBe('3D/Rigging');
    expect(hubShelfFor('nvidia/ARDY-Core-RP-20FPS-Horizon40', 'ardy-motion')).toBe('3D/Motion');
    expect(hubShelfFor('meta-llama/Meta-Llama-3-8B-Instruct', 'ardy-motion')).toBe('Support');
    expect(hubShelfFor('mlx-community/parakeet-tdt-0.6b-v3', 'parakeet-asr')).toBe(
      'Audio/Transcription',
    );
    expect(hubShelfFor('mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16', 'qwen3-tts')).toBe(
      'Audio/Speech',
    );
    expect(hubShelfFor('ilintar/Dasheng-AudioGen-GGUF', 'dasheng-sfx')).toBe('Audio/SFX');
    // Not in the registry: the name decides.
    expect(hubShelfFor('Qwen/Qwen-Image')).toBe('Image/Generation');
    expect(hubShelfFor('ilintar/thinksound-gguf')).toBe('Audio/SFX');
    expect(hubShelfFor('mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit')).toBe('Audio/Speech');
    expect(hubShelfFor('mlx-community/Qwen3.5-4B-8bit')).toBe('Support');
    expect(hubShelfFor('z-lab/Qwen3.5-4B-DFlash')).toBe('Support');
    expect(hubShelfFor('someone/unknowable')).toBe('Unsorted');
  });

  it('plans every move with the engines’ view kept: hub and 3D repos link back, GGUFs do not', () => {
    const plan = planLibraryMigration(
      snap({
        ggufIds: ['qwen3.5-4b-mtp'],
        mlxSlugs: ['mlx-community__qwen3.5-4b-mlx-8bit'],
        comfyFiles: { unet: ['LTX-2.5-Distilled-Q4_K_M.gguf'], vae: ['odd.safetensors'] },
        hubEntries: ['models--microsoft--TRELLIS.2-4B'],
        hubFeatureByRepo: { 'microsoft/TRELLIS.2-4B': 'trellis2' },
        gen3dModels: ['Pixal3D'],
        omnisvgSubdirs: ['gguf'],
      }),
    );
    const byKind = Object.fromEntries(plan.moves.map((m) => [m.kind, m]));
    expect(byKind.gguf).toMatchObject({
      from: '/c/models/qwen3.5-4b-mtp',
      to: '/L/LLM/qwen3.5-4b-mtp',
      linkBack: false,
    });
    expect(byKind.mlx).toMatchObject({ to: '/L/LLM/MLX/mlx-community__qwen3.5-4b-mlx-8bit' });
    expect(plan.moves.find((m) => m.from.endsWith('LTX-2.5-Distilled-Q4_K_M.gguf'))?.to).toBe(
      '/L/Video/Generation/unet/LTX-2.5-Distilled-Q4_K_M.gguf',
    );
    expect(plan.moves.find((m) => m.from.endsWith('odd.safetensors'))?.to).toBe(
      '/L/Unsorted/vae/odd.safetensors',
    );
    expect(plan.unsorted).toEqual(['vae/odd.safetensors']);
    expect(byKind.hub).toMatchObject({
      from: '/c/gen3d/hf/hub/models--microsoft--TRELLIS.2-4B',
      to: '/L/3D/Generation/microsoft__trellis.2-4b',
      linkBack: true,
    });
    expect(byKind['gen3d-model']).toMatchObject({ to: '/L/3D/Generation/Pixal3D', linkBack: true });
    expect(byKind.omnisvg).toMatchObject({ to: '/L/Image/Vector/OmniSVG/gguf', linkBack: true });
  });

  it('applies by renaming, links back where asked, and skips what is gone, linked, taken or elsewhere', () => {
    const plan = planLibraryMigration(
      snap({
        ggufIds: ['a', 'gone', 'taken', 'far'],
        hubEntries: ['models--x--y'],
      }),
    );
    const present = new Set([
      '/c/models/a',
      '/c/models/taken',
      '/L/LLM/taken',
      '/c/models/far',
      '/c/gen3d/hf/hub/models--x--y',
    ]);
    const renamed: string[] = [];
    const links: string[] = [];
    const res = applyLibraryMigration(plan, {
      exists: (p) => present.has(p),
      isSymlink: () => false,
      mkdirp: () => {},
      rename: (from, to) => {
        if (from === '/c/models/far') throw Object.assign(new Error('xdev'), { code: 'EXDEV' });
        renamed.push(`${from}→${to}`);
      },
      symlink: (target, at) => links.push(`${at}→${target}`),
    });
    expect(renamed).toEqual([
      '/c/models/a→/L/LLM/a',
      '/c/gen3d/hf/hub/models--x--y→/L/Unsorted/x__y',
    ]);
    expect(links).toEqual(['/c/gen3d/hf/hub/models--x--y→../../../../L/Unsorted/x__y']);
    expect(res.moved.map((m) => m.from)).toEqual(['/c/models/a', '/c/gen3d/hf/hub/models--x--y']);
    expect(res.skipped.map((s) => `${s.move.from}:${s.why}`)).toEqual([
      '/c/models/gone:gone',
      '/c/models/taken:target exists',
      '/c/models/far:other volume',
    ]);
  });
});
