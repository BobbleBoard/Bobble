// @vitest-environment jsdom
/**
 * The user, top of their chat list: "total blank screen."
 *
 * A render throw unmounts React's whole tree by design and leaves an empty
 * <div id="root">. The renderer PROCESS is fine, so main's crash recovery
 * (electron/renderer-recovery.ts) never fires — it only handles the process
 * dying. This boundary is the only thing standing between a bad render anywhere
 * in the app and a blank window with no explanation.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  mounted.push({ container, root });
  return container;
}

afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.container.remove();
  }
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error('a component exploded');
}

describe('AppErrorBoundary', () => {
  it('renders its children when nothing is wrong', async () => {
    const el = await mount(
      <AppErrorBoundary>
        <p>the app</p>
      </AppErrorBoundary>,
    );
    expect(el.textContent).toContain('the app');
    expect(el.querySelector('[data-testid="app-crash"]')).toBeNull();
  });

  it('shows the error instead of a blank window', async () => {
    // React logs the caught error itself; this test asserts behaviour, not noise.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const el = await mount(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(el.querySelector('[data-testid="app-crash"]')).not.toBeNull();
    // The message itself, not "something went wrong" — on a local app the user
    // is the only reporter there is.
    expect(el.textContent).toContain('a component exploded');
    // …and a way out.
    expect(el.textContent).toContain('Reload');
  });
});

/**
 * THE BUTTONS HAVE TO DO SOMETHING.
 *
 * They did not: `window.location.reload()` and `window.location.search = ''`
 * are renderer-initiated navigations, which main refuses (`will-navigate` →
 * preventDefault), so the user's only way off this screen was ⌘R. These pin the two
 * recoveries to the two buttons.
 */
describe('AppErrorBoundary recovery', () => {
  it('Reload asks for a re-mount, not a navigation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onSoftReload } = await import('./app-reload');
    let asked = 0;
    const off = onSoftReload(() => {
      asked += 1;
    });
    const el = await mount(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    const button = el.querySelector<HTMLButtonElement>('[data-testid="app-crash-reload"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(asked).toBe(1);
    off();
  });

  it('the fresh-window button asks MAIN to reload the document', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as unknown as { window: { piDesktop: unknown } }).window.piDesktop = { invoke };
    const el = await mount(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    const button = el.querySelector<HTMLButtonElement>('[data-testid="app-crash-fresh"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(invoke).toHaveBeenCalledWith('app:reload-window', { fresh: true });
  });
});
