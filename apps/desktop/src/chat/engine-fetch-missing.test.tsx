// @vitest-environment jsdom
/**
 * "FETCH MISSING" COUNTS WHAT IS MISSING AFTER IT FETCHES IT.
 *
 * rapid-mlx's vision runtime is an `engine:` companion: installed, but not an
 * engine the engines store lists — so nothing the button's companions query
 * waited on changed when it landed. It kept saying "Fetch missing · 1" until
 * the menu was reopened, and a second press reinstalled it (and an install
 * begins by deleting the runtime's ready marker, so a launch meanwhile fell off
 * the vision lane).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let runtimeInstalled = false;
(window as unknown as { piDesktop: unknown }).piDesktop = {
  invoke: vi.fn(async (channel: string) =>
    channel === 'llm:companions'
      ? {
          companions: [
            {
              kind: 'engine:rapid-mlx-vision',
              what: 'rapid-mlx vision runtime',
              source: 'rapid-mlx[vision]',
              present: runtimeInstalled,
            },
          ],
        }
      : undefined,
  ),
  onEvent: () => () => {},
};

const { FetchMissingButton } = await import('./EngineMenu');
const { useLlmStore } = await import('../state/llm-store');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Let the companions query and the install settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('Fetch missing', () => {
  it("stops counting rapid-mlx's vision runtime once it is installed", async () => {
    runtimeInstalled = false;
    const installEngine = vi.fn(async () => {
      runtimeInstalled = true;
      return { success: true };
    });
    useLlmStore.setState((s) => ({
      status: {
        ...s.status,
        model: { id: 'qwen3.5-4b-mtp', displayName: 'Qwen3.5 4B', quant: 'Q8_0', contextWindow: 1 },
      },
      download: null,
      engines: {},
      installEngine,
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(<FetchMissingButton open plan={[]} onNote={() => {}} />));
    await settle();
    const button = host.querySelector('[data-testid="engine-fetch-missing"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('no Fetch missing button');
    expect(button.textContent).toBe('Fetch missing · 1');

    await act(async () => {
      button.click();
    });
    await settle();

    expect(installEngine).toHaveBeenCalledWith('rapid-mlx-vision');
    expect(button.textContent).toBe('Nothing missing');
    // Nothing left to press, so nothing is installed twice.
    expect(button.disabled).toBe(true);
  });
});
