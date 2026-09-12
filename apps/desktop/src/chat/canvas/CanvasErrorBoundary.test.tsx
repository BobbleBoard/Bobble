// @vitest-environment jsdom
/**
 * the user, on the renderer crash in the canvas assessment: "that cannot happen".
 * Twice a React update loop inside the canvas took the whole window to the
 * app-level boundary. These pin the containment: a canvas failure resets and
 * remounts the canvas once, stays down (with a Reset) if it fails again at
 * once, and never reaches anything outside the rail.
 *
 * React retries a throwing render once before it reaches a boundary, so the
 * fixtures fail by CONDITION, not by count: a component that throws until the
 * canvas store has been reset is exactly the loop that clears on a remount.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCanvasForNewSession } from '../../state/canvas-store';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';

vi.mock('../../state/canvas-store', () => ({
  resetCanvasForNewSession: vi.fn(),
  useCanvasStore: { getState: () => ({ sideWidth: 420 }) },
}));
const resets = vi.mocked(resetCanvasForNewSession);

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
beforeEach(() => {
  resets.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.container.remove();
  }
  vi.restoreAllMocks();
});

/** Fails until the canvas has been reset `until` times — then draws. */
function ClearsOnReset({ until }: { until: number }): ReactNode {
  if (resets.mock.calls.length < until) throw new Error(`canvas loop ${resets.mock.calls.length}`);
  return <p>canvas ok</p>;
}

describe('CanvasErrorBoundary', () => {
  it('resets and remounts the canvas once, and the rail comes back', async () => {
    const el = await mount(
      <CanvasErrorBoundary>
        <ClearsOnReset until={1} />
      </CanvasErrorBoundary>,
    );
    expect(resets).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="canvas-crash"]')).toBeNull();
    expect(el.textContent).toContain('canvas ok');
  });

  it('stays down with a Reset when the failure comes straight back', async () => {
    const el = await mount(
      <CanvasErrorBoundary>
        <ClearsOnReset until={2} />
      </CanvasErrorBoundary>,
    );
    // One automatic reset, then it fails again inside the window: no loop of
    // resets, the card instead.
    expect(resets).toHaveBeenCalledTimes(1);
    const card = el.querySelector('[data-testid="canvas-crash"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Your chat is unaffected');
    expect(card?.textContent).toContain('canvas loop 1');
    // The person's Reset is a second reset; the loop is gone by then.
    await act(async () => {
      (el.querySelector('[data-testid="canvas-crash-reset"]') as HTMLButtonElement).click();
    });
    expect(resets).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[data-testid="canvas-crash"]')).toBeNull();
    expect(el.textContent).toContain('canvas ok');
  });

  it('logs the component stack — the evidence the hunt needs', async () => {
    await mount(
      <CanvasErrorBoundary>
        <ClearsOnReset until={1} />
      </CanvasErrorBoundary>,
    );
    const ours = vi.mocked(console.error).mock.calls.find((c) => c[0] === 'Bobble canvas error');
    expect(ours).toBeDefined();
    expect(String(ours?.[2])).toContain('ClearsOnReset');
  });

  it('keeps everything outside the rail untouched', async () => {
    const el = await mount(
      <div>
        <p>the chat</p>
        <CanvasErrorBoundary>
          <ClearsOnReset until={2} />
        </CanvasErrorBoundary>
      </div>,
    );
    expect(el.textContent).toContain('the chat');
    expect(el.querySelector('[data-testid="canvas-crash"]')).not.toBeNull();
  });
});
