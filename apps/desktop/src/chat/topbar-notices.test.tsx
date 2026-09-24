// @vitest-environment jsdom
/**
 * The top bar's centre with the notices features register (the W0-A
 * pre-wire): nothing registered → exactly the model status (here: nothing,
 * no model is starting); an urgent notice wins; a quiet one shows only when
 * the model status has nothing to say.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TopBarStatus } from './TopBarStatus';
import { registerTopBarNotice } from './topbar-notices';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLElement | null = null;
const offs: Array<() => void> = [];
afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  for (const f of offs.splice(0)) f();
});

async function render(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<TopBarStatus />));
  return container.innerHTML;
}

const notice = (id: string, priority: number, text: string | null) => ({
  id,
  priority,
  Component: ({ fallback }: { fallback: ReactNode }) =>
    text === null ? fallback : <span data-testid={`notice-${id}`}>{text}</span>,
});

describe('TopBarStatus and the notice registry', () => {
  it('renders nothing extra with nothing registered (no model is starting here)', async () => {
    expect(await render()).toBe('');
  });

  it('shows a quiet notice when the model status has nothing to say', async () => {
    offs.push(registerTopBarNotice(notice('sharing', -1, 'Sharing with 2 devices')));
    expect(await render()).toContain('Sharing with 2 devices');
  });

  it('puts the most urgent notice that has something to say first', async () => {
    offs.push(
      registerTopBarNotice(notice('quiet', -1, 'Sharing with 2 devices')),
      registerTopBarNotice(notice('idle', 20, null)),
      registerTopBarNotice(notice('training', 10, 'Training · 42%')),
    );
    const html = await render();
    expect(html).toContain('Training · 42%');
    expect(html).not.toContain('Sharing with 2 devices');
  });
});
