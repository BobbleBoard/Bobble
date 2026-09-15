/**
 * The module judgement. Each test is a case where getting it wrong either hides
 * a working studio or promises one that cannot run.
 */
import { describe, expect, it } from 'vitest';
import type { Gen3dModelId, Gen3dModelInfo } from '../../electron/gen3d/gen3d-contract';
import { CORE_MODULE_MODELS, formatModuleSize, moduleHeadline, moduleState } from './module-state';

const GB = 1024 ** 3;
const m = (
  id: Gen3dModelId,
  installed: boolean,
  sizeBytes = 10 * GB,
  downloading = false,
): Gen3dModelInfo => ({
  id,
  label: id,
  role: 'geometry',
  sizeBytes,
  installed,
  downloading,
  note: '',
});

const allCore = (installed: boolean, downloading = false): Gen3dModelInfo[] =>
  CORE_MODULE_MODELS.map((id) => m(id, installed, 10 * GB, downloading));

describe('moduleState', () => {
  it('is ready only when every core model is installed', () => {
    const s = moduleState(true, allCore(true));
    expect(s.status).toBe('ready');
    expect(s.usable).toBe(true);
    expect(s.remainingBytes).toBe(0);
  });

  it('is not-installed when a core model is missing, and totals only what is MISSING', () => {
    // Charging for what is already on disk would quote 40GB to someone who
    // needs 10 — the number has to be the actual remaining download.
    const models = allCore(true);
    models[1] = m(CORE_MODULE_MODELS[1] as Gen3dModelId, false, 16 * GB);
    const s = moduleState(true, models);
    expect(s.status).toBe('not-installed');
    expect(s.usable).toBe(false);
    expect(s.remainingBytes).toBe(16 * GB);
    expect(s.missing).toEqual([CORE_MODULE_MODELS[1]]);
  });

  it('reports the missing RUNTIME separately from missing weights', () => {
    // "Download 34GB" is the wrong instruction when the real fix is uv.
    const s = moduleState(false, allCore(false));
    expect(s.status).toBe('no-runtime');
    expect(moduleHeadline(s)).toMatch(/runtime/i);
  });

  it('says installing while a core model is in flight', () => {
    const s = moduleState(true, allCore(false, true));
    expect(s.status).toBe('installing');
    expect(s.usable).toBe(false);
  });

  it('an EMPTY catalog is not "ready" — the sidecar answers before it has booted', () => {
    // The dangerous default: zero missing out of zero models reads as complete.
    const s = moduleState(true, []);
    expect(s.status).not.toBe('ready');
    expect(s.usable).toBe(false);
  });

  it('an optional extra being absent does not make the module unusable', () => {
    // Motion/learned-rig/edit are per-stage downloads. A studio that can
    // generate and rig is usable; gating it on ardy would hide a working app.
    const models = [...allCore(true), m('ardy-motion', false, 16 * GB), m('skintokens', false)];
    expect(moduleState(true, models).status).toBe('ready');
  });
});

describe('formatModuleSize', () => {
  it('reads as a download size, not a byte count', () => {
    expect(formatModuleSize(34.2 * GB)).toBe('34 GB');
    expect(formatModuleSize(1.5 * GB)).toBe('1.5 GB');
    expect(formatModuleSize(870 * 1024 ** 2)).toBe('870 MB');
  });

  it('shows nothing rather than "0 B" when there is nothing to fetch', () => {
    expect(formatModuleSize(0)).toBe('');
  });
});

describe('a runtime that is still starting is not a runtime that is missing', () => {
  /*
   * the user: "3D studio shows 'runtime is not available' on every first open of the
   * app even when previously installed." The first `gen3d:catalog` call after
   * launch ALWAYS finds the sidecar down: it kicks off the uv boot and answers
   * immediately with the disk-derived catalog, so `engineReady:false` arrived on
   * every single launch and the studio read it as a broken install.
   */
  const installed = allCore(true);

  it('says checking while the boot is in flight', () => {
    const state = moduleState(false, installed, true);
    expect(state.status).toBe('checking');
    expect(moduleHeadline(state)).toBe('Starting the 3D engine…');
  });

  it('still says unavailable when nothing is starting', () => {
    expect(moduleState(false, installed, false).status).toBe('no-runtime');
  });

  it('is neither once the engine answers', () => {
    expect(moduleState(true, installed, false).status).toBe('ready');
  });
});

describe('the ComfyUI path — image → 3D with nothing to build', () => {
  const comfy = (ready: boolean, runtimeReady = ready, weightsReady = ready) => ({
    runtimeReady,
    weightsReady,
    ready,
    modelId: 'trellis2-comfy',
    approxGB: ready ? 0 : 15.5,
  });

  it('makes a studio with no engine usable when ComfyUI and the weights are there', () => {
    const s = moduleState(false, [], false, comfy(true));
    expect(s.status).toBe('ready');
    expect(s.usable).toBe(true);
    expect(s.comfy?.ready).toBe(true);
  });

  it('keeps the engine judgement, and the offer, when ComfyUI is not ready', () => {
    const s = moduleState(false, allCore(false), false, comfy(false));
    expect(s.status).toBe('no-runtime');
    expect(s.usable).toBe(false);
    expect(s.comfy).toMatchObject({ ready: false, approxGB: 15.5 });
    // The headline is about the module, not the engine's runtime.
    expect(moduleHeadline(s)).toBe('3D module not installed');
  });

  it('still says the engine is missing when no ComfyUI path was reported', () => {
    const s = moduleState(false, allCore(false), false, null);
    expect(s.comfy).toBeUndefined();
    expect(moduleHeadline(s)).toBe('The 3D engine runtime is not available');
  });

  it('with the engine installed as well, the engine’s missing core still totals', () => {
    const models = allCore(true);
    models[0] = m(CORE_MODULE_MODELS[0] as Gen3dModelId, false, 4 * GB);
    const s = moduleState(true, models, false, comfy(true));
    expect(s.usable).toBe(true);
    expect(s.missing).toEqual([CORE_MODULE_MODELS[0]]);
    expect(s.remainingBytes).toBe(4 * GB);
  });
});
