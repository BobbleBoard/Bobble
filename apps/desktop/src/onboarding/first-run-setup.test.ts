// @vitest-environment jsdom
/**
 * "Download and finish" — engines first, then the model, never waiting on the
 * model. A faster engine that fails to install must not leave the Mac without
 * a model: the 4B runs on llama.cpp, which arrives with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useLlmStore } = await import('../state/llm-store');
const { useFirstRunSetup, START_MODEL_ID } = await import('./first-run-setup');
const { ENGINES } = await import('../settings/engine-catalog');

const installs: string[] = [];
let failId: string | null = null;
const downloadModel = vi.fn(async () => {});

beforeEach(() => {
  installs.length = 0;
  failId = null;
  downloadModel.mockClear();
  Object.assign(window, {
    piDesktop: {
      invoke: async (channel: string, req: { id: string }) => {
        if (channel !== 'engines:install') throw new Error(`unexpected ${channel}`);
        installs.push(req.id);
        return req.id === failId ? { success: false, error: 'no space left' } : { success: true };
      },
    },
  });
  useFirstRunSetup.setState({
    checked: true,
    engine: ENGINES.find((e) => e.id === 'dflash-mlx') ?? null,
    installedEngineIds: new Set(),
    enginePhase: 'idle',
    engineError: null,
  });
  useLlmStore.setState({
    status: { ...useLlmStore.getState().status, downloadedModelIds: [] },
    catalog: [],
    download: null,
    downloadModel,
  });
});

describe('first-run start', () => {
  it('installs the prerequisites, then the engine, then starts the model', async () => {
    await useFirstRunSetup.getState().start();
    expect(installs).toEqual(['rapid-mlx', 'dflash-mlx']);
    expect(useFirstRunSetup.getState().enginePhase).toBe('done');
    expect(downloadModel).toHaveBeenCalledWith(START_MODEL_ID);
  });

  it('still downloads the model when an engine fails, and says why', async () => {
    failId = 'rapid-mlx';
    await useFirstRunSetup.getState().start();
    expect(installs).toEqual(['rapid-mlx']);
    expect(useFirstRunSetup.getState().enginePhase).toBe('failed');
    expect(useFirstRunSetup.getState().engineError).toBe('no space left');
    expect(downloadModel).toHaveBeenCalledWith(START_MODEL_ID);
  });

  it('skips what is already there', async () => {
    useFirstRunSetup.setState({ installedEngineIds: new Set(['rapid-mlx', 'dflash-mlx']) });
    useLlmStore.setState({
      status: { ...useLlmStore.getState().status, downloadedModelIds: [START_MODEL_ID] },
    });
    await useFirstRunSetup.getState().start();
    expect(installs).toEqual([]);
    expect(downloadModel).not.toHaveBeenCalled();
  });
});
