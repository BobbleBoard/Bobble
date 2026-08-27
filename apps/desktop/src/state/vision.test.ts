import { describe, expect, it } from 'vitest';
import { useLlmStore } from './llm-store';
import { ensureVisionMode, resolveVisionTarget } from './local-model';
import { messageNeedsVision } from './pi-connect';

describe('messageNeedsVision', () => {
  it('is true only when an image attachment is present', () => {
    expect(messageNeedsVision({ imageDataUris: ['data:image/png;base64,AAAA'] })).toBe(true);
    expect(messageNeedsVision({ imageDataUris: [] })).toBe(false);
    expect(messageNeedsVision({})).toBe(false);
  });
});

describe('resolveVisionTarget', () => {
  const catalog = [
    { id: 'gemma-4-e2b-it', vision: true },
    { id: 'nemotron-3-nano-30b-a3b', vision: false },
    { id: 'gemma-4-12b-it', vision: true },
  ];

  it('no-ops when the server is already multimodal (vision is sticky)', () => {
    expect(resolveVisionTarget({ launchMode: 'multimodal', catalog }).action).toBe('already-on');
  });

  it('no-ops when a fast-text server already has a projector attached', () => {
    // The regression this exists for: the projector is attached on EVERY launch
    // now, so the first image used to force a ~105s unload/reload into
    // multimodal to gain vision the server already had — and lose speculative
    // decoding for the rest of the session.
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      visionReady: true,
      model: { id: 'gemma-4-e2b-it', quant: 'Q4_K_M' },
      catalog,
    });
    expect(d.action).toBe('already-on');
  });

  it('still relaunches when the server genuinely cannot see', () => {
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      visionReady: false,
      model: { id: 'gemma-4-e2b-it', quant: 'Q4_K_M' },
      catalog,
    });
    expect(d).toEqual({ action: 'relaunch', modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M' });
  });

  it('relaunches the CURRENT model in multimodal when it supports vision', () => {
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'gemma-4-e2b-it', quant: 'Q4_K_M' },
      catalog,
    });
    expect(d).toEqual({ action: 'relaunch', modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M' });
  });

  it('falls back to a downloaded vision tier pick when the current model is text-only', () => {
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'nemotron-3-nano-30b-a3b' },
      catalog,
      tierModels: {
        fast: { modelId: 'gemma-4-e2b-it', quant: 'Q4_K_M', vision: true, downloaded: false },
        balanced: { modelId: 'gemma-4-12b-it', quant: 'Q4_K_M', vision: true, downloaded: true },
        intelligent: { modelId: 'qwen', quant: 'Q4_K_M', vision: true, downloaded: false },
      },
    });
    // intelligent + fast are vision but not downloaded → the downloaded balanced wins.
    expect(d).toEqual({ action: 'relaunch', modelId: 'gemma-4-12b-it', quant: 'Q4_K_M' });
  });

  it('returns none when nothing vision-capable is available', () => {
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'nemotron-3-nano-30b-a3b' },
      catalog,
    });
    expect(d.action).toBe('none');
  });
});

describe('ensureVisionMode — sticky no-op path', () => {
  it('returns already-on (no relaunch) when the server is multimodal', async () => {
    const prev = useLlmStore.getState().status;
    useLlmStore.setState({ status: { ...prev, launchMode: 'multimodal' } });
    const res = await ensureVisionMode();
    expect(res).toEqual({ ok: true, changed: false });
    useLlmStore.setState({ status: prev });
  });
});

describe('a pinned model is an instruction, not a preference', () => {
  /*
   * MEASURED, and it cost two ten-task benchmark runs before the main log gave
   * it up. Ling 3.0 (text-only) was explicitly pinned; a tool screenshotted a
   * page it had just written, main raised `llm:vision-wanted`, and the vision
   * resolver answered "relaunch qwen3.5-9b-mtp" — a model the user had never
   * chosen, on a 105-second load, which took the running turn with it. The turn
   * emitted zero characters and sat until the cap, and nothing on screen ever
   * said the model had changed.
   *
   * Falling back to another model is right when the APP is choosing (Auto, or a
   * tier). When the user has named one, running a different one behind their
   * back is worse than not seeing one image.
   */
  const TIERS = {
    fast: { modelId: 'fast-vlm', quant: 'Q4', vision: true, downloaded: true },
    balanced: { modelId: 'balanced-vlm', quant: 'Q4', vision: true, downloaded: true },
    intelligent: { modelId: 'big-vlm', quant: 'Q4', vision: true, downloaded: true },
  };

  it('does NOT switch away from a pinned text-only model', () => {
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'ling-3.0-tiny' },
      catalog: [{ id: 'ling-3.0-tiny', vision: false }],
      pinnedModelId: 'ling-3.0-tiny',
      tierModels: TIERS,
    });
    expect(d.action).toBe('none');
    if (d.action === 'none') expect(d.reason).toContain('pinned');
  });

  it('still upgrades the pinned model itself when IT can see', () => {
    // The pin is honoured by relaunching the SAME model in multimodal — that is
    // not a switch, it is the model the user chose, with its projector loaded.
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'qwen3.5-9b-mtp', quant: 'Q8_0' },
      catalog: [{ id: 'qwen3.5-9b-mtp', vision: true }],
      pinnedModelId: 'qwen3.5-9b-mtp',
      tierModels: TIERS,
    });
    expect(d).toEqual({ action: 'relaunch', modelId: 'qwen3.5-9b-mtp', quant: 'Q8_0' });
  });

  it('still falls back when the app is choosing the model', () => {
    // Unchanged under Auto / a tier: no pin means no instruction to violate.
    const d = resolveVisionTarget({
      launchMode: 'fast-text',
      model: { id: 'ling-3.0-tiny' },
      catalog: [{ id: 'ling-3.0-tiny', vision: false }],
      pinnedModelId: null,
      tierModels: TIERS,
    });
    expect(d).toEqual({ action: 'relaunch', modelId: 'big-vlm', quant: 'Q4' });
  });
});
