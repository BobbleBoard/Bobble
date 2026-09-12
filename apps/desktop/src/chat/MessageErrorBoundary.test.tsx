// @vitest-environment jsdom
/** One reply failing to draw must cost one row, not the window. */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageErrorBoundary } from './MessageErrorBoundary';

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
  throw new Error('a reply exploded');
}

describe('MessageErrorBoundary', () => {
  it('replaces only the reply that failed, keeping its text readable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const el = await mount(
      <div>
        <p>the reply before</p>
        <MessageErrorBoundary fallbackText="what the model said">
          <Boom />
        </MessageErrorBoundary>
        <p>the reply after</p>
      </div>,
    );
    expect(el.textContent).toContain('the reply before');
    expect(el.textContent).toContain('the reply after');
    expect(el.querySelector('[data-testid="message-crash"]')?.textContent).toContain(
      'what the model said',
    );
  });
});
