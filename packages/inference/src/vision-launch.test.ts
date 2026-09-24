import { describe, expect, it } from 'vitest';
import {
  blindNote,
  mlxWeightsHaveVision,
  planVisionEngine,
  type VisionEngineInput,
} from './vision-launch';

const base: VisionEngineInput = {
  profile: { engine: 'llamacpp', spec: 'mtp' },
  visionWanted: true,
  explicit: false,
  modelHasProjector: true,
  ggufOnDisk: true,
  mlxTwinHasVision: true,
  rapidVisionReady: true,
};

describe('planVisionEngine — vision on unless the user says otherwise (the user 2026-09-23)', () => {
  it('llama.cpp sees through the projector, method untouched', () => {
    expect(planVisionEngine(base)).toEqual({
      profile: { engine: 'llamacpp', spec: 'mtp' },
      vision: 'projector',
    });
  });

  it('rapid-mlx sees on its vision lane — without MTP, which that lane does not honour', () => {
    expect(planVisionEngine({ ...base, profile: { engine: 'rapid-mlx', spec: 'mtp' } })).toEqual({
      profile: { engine: 'rapid-mlx', spec: 'none' },
      vision: 'lane',
    });
  });

  it('the run the user hit: rapid-mlx + MTP with no vision runtime goes to llama.cpp, and says why', () => {
    const plan = planVisionEngine(
      { ...base, profile: { engine: 'rapid-mlx', spec: 'mtp' }, rapidVisionReady: false },
      'mtp',
    );
    expect(plan.profile).toEqual({ engine: 'llamacpp', spec: 'mtp' });
    expect(plan.vision).toBe('projector');
    expect(plan.fallback?.from).toBe('rapid-mlx');
    expect(plan.fallback?.why).toContain('vision runtime');
  });

  it('a text-only MLX engine hands a calibrated launch to llama.cpp; an MLX-only method becomes the default', () => {
    const plan = planVisionEngine(
      { ...base, profile: { engine: 'mlx-dspark', spec: 'dspark' } },
      'mtp',
    );
    expect(plan.profile).toEqual({ engine: 'llamacpp', spec: 'mtp' });
    expect(plan.fallback?.why).toBe('mlx-dspark is text-only');
  });

  it('a row the user CLICKED is honoured as clicked, and reported blind', () => {
    expect(
      planVisionEngine({
        ...base,
        profile: { engine: 'dflash-mlx', spec: 'dflash' },
        explicit: true,
      }),
    ).toEqual({
      profile: { engine: 'dflash-mlx', spec: 'dflash' },
      vision: 'none',
      blindReason: 'engine',
    });
  });

  it('with no GGUF to fall back on, the chosen engine runs blind and says so', () => {
    const plan = planVisionEngine({
      ...base,
      profile: { engine: 'mlx-lm', spec: 'none' },
      ggufOnDisk: false,
    });
    expect(plan).toEqual({
      profile: { engine: 'mlx-lm', spec: 'none' },
      vision: 'none',
      blindReason: 'engine',
    });
  });

  it('vision OFF keeps the chosen launch (rapid-mlx keeps MTP) and the reason is "off"', () => {
    expect(
      planVisionEngine({
        ...base,
        visionWanted: false,
        profile: { engine: 'rapid-mlx', spec: 'mtp' },
      }),
    ).toEqual({
      profile: { engine: 'rapid-mlx', spec: 'mtp' },
      vision: 'none',
      blindReason: 'off',
    });
  });

  it('a model with no vision at all is "model", whatever the setting', () => {
    const blind = { ...base, modelHasProjector: false, mlxTwinHasVision: false };
    expect(planVisionEngine(blind).blindReason).toBe('model');
    expect(planVisionEngine({ ...blind, visionWanted: false }).blindReason).toBe('model');
  });
});

describe('mlxWeightsHaveVision — the evidence rapid-mlx itself reads', () => {
  it('needs both the config and the tensors', () => {
    const tensors = ['language_model.layers.0.mlp.weight', 'vision_tower.blocks.0.attn.qkv.bias'];
    expect(mlxWeightsHaveVision({ vision_config: {} }, tensors)).toBe(true);
    // A text-only fork of a multimodal architecture (rapid-mlx #393).
    expect(mlxWeightsHaveVision({ vision_config: {} }, ['language_model.layers.0.weight'])).toBe(
      false,
    );
    expect(mlxWeightsHaveVision({}, tensors)).toBe(false);
    expect(mlxWeightsHaveVision(null, tensors)).toBe(false);
  });
});

describe('blindNote — the truth, in the words for its cause', () => {
  it('names the switch when it is off, the model when it has none', () => {
    expect(blindNote('off')).toContain('vision is switched off');
    expect(blindNote('off')).toContain('engine menu → Vision');
    expect(blindNote('model')).toContain('has no vision');
    expect(blindNote('engine')).toContain('text-only');
    for (const r of ['off', 'model', 'engine', 'projector', undefined] as const) {
      expect(blindNote(r)).toContain('Do NOT loop');
      // Never the old claim that the whole model is in a "text-only mode".
      expect(blindNote(r)).not.toContain('TEXT-ONLY mode');
    }
  });
});
