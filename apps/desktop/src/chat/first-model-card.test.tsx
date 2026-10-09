// @vitest-environment jsdom
/**
 * THE FIRST MODEL, ONE CLICK FROM THE EMPTY CHAT — every state the card has,
 * rendered from the two stores it reads (no IPC, no download). The states a
 * look probe cannot photograph without fetching 6 GB: downloading, paused,
 * failed, and the engine installing first.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useLlmStore } = await import('../state/llm-store');
const { useFirstRunSetup, START_MODEL_ID } = await import('../onboarding/first-run-setup');
const { ENGINES } = await import('../settings/engine-catalog');
const { FirstModelCard } = await import('./FirstModelCard');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const GB = 1024 ** 3;
const start = vi.fn(async () => {});
const resume = vi.fn(async () => {});
let container: HTMLElement;

async function mount(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(<FirstModelCard />);
  });
  return container;
}

const card = () => container.querySelector('[data-testid="first-model-card"]');
const text = () => card()?.textContent ?? '';

beforeEach(() => {
  start.mockClear();
  resume.mockClear();
  const dflash = ENGINES.find((e) => e.id === 'dflash-mlx');
  useFirstRunSetup.setState({
    checked: true,
    engine: dflash ?? null,
    installedEngineIds: new Set(),
    harnesses: [],
    enginePhase: 'idle',
    engineError: null,
    check: async () => {},
    start,
  });
  useLlmStore.setState({
    status: { ...useLlmStore.getState().status, downloadedModelIds: [] },
    catalog: [
      {
        id: START_MODEL_ID,
        displayName: 'Qwen3.5 4B (MTP)',
        quants: [{ quant: 'Q8_0', bytes: 4.3 * GB }],
        downloaded: false,
      } as never,
    ],
    download: null,
    downloadError: null,
    resumeDownload: resume,
  });
});

afterEach(() => {
  container.remove();
});

describe('FirstModelCard', () => {
  it('offers the one download, with the engine and model together', async () => {
    await mount();
    expect(text()).toContain('Download a model to start');
    expect(text()).toMatch(/Qwen3\.5 4B answers right here on this Mac/);
    expect(text()).toMatch(/\d\.\d GB, once\./);
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="first-model-download"]',
    );
    expect(button?.textContent).toBe('Download');
    await act(async () => button?.click());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('says the engine comes first while it installs', async () => {
    useFirstRunSetup.setState({ enginePhase: 'working' });
    await mount();
    expect(text()).toContain('Getting the engine for this Mac');
    expect(card()?.getAttribute('data-installing')).toBe('true');
    expect(container.querySelector('button')).toBeNull();
  });

  it('becomes the progress while the model downloads', async () => {
    useLlmStore.setState({
      download: {
        modelId: START_MODEL_ID,
        file: 'm.gguf',
        received: 1.8 * GB,
        total: 4.3 * GB,
        fraction: 0.42,
        bytesPerSec: null,
        paused: false,
      },
    });
    await mount();
    expect(text()).toContain('Downloading Qwen3.5 4B');
    expect(text()).toContain('1.8 GB of 4.3 GB');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '42',
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('offers Resume when paused', async () => {
    useLlmStore.setState({
      download: {
        modelId: START_MODEL_ID,
        file: 'm.gguf',
        received: GB,
        total: 4.3 * GB,
        fraction: 0.23,
        bytesPerSec: null,
        paused: true,
      },
    });
    await mount();
    expect(text()).toContain('is paused');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="first-model-resume"]')?.click(),
    );
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('says why it stopped, in words, with Try again', async () => {
    useLlmStore.setState({
      downloadError: {
        modelId: START_MODEL_ID,
        error: 'getaddrinfo ENOTFOUND huggingface.co',
        at: 0,
      },
    });
    await mount();
    expect(text()).toContain('The download stopped');
    expect(text()).not.toContain('ENOTFOUND');
    expect(container.querySelector('[data-testid="first-model-retry"]')?.textContent).toBe(
      'Try again',
    );
  });

  it('is gone once a model is on this Mac', async () => {
    useLlmStore.setState({
      status: { ...useLlmStore.getState().status, downloadedModelIds: [START_MODEL_ID] },
    });
    await mount();
    expect(card()).toBeNull();
  });

  it('shows nothing before the models on disk have been read', async () => {
    useFirstRunSetup.setState({ checked: false });
    await mount();
    expect(card()).toBeNull();
  });
});
