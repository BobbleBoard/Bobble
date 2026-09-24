// @vitest-environment jsdom
/**
 * "THINKING FOR 14m" TWO SECONDS INTO A NEW CHAT (the user, 2026-09-23).
 *
 * The running timer remembers when it first saw each step, by the step's id,
 * for the life of the renderer — so a remount keeps its clock. A thinking block
 * has no id of its own and was keyed by its slot, `thinking:0`, which is the
 * same slot in every chat: a new chat's first thought picked up the start time
 * of the first thought seen that session. The chain key makes it unique.
 */
import { CanvasProvider } from '@pi-desktop/canvas';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityBlock } from './activity-mapping';
import { ThreadActivityChain } from './ThreadActivity';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const thinking = (text: string): ActivityBlock =>
  ({ type: 'thinking', thinking: text }) as unknown as ActivityBlock;

async function mountChain(chainKey: string | undefined): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CanvasProvider>
        <ThreadActivityChain
          {...(chainKey === undefined ? {} : { chainKey })}
          blocks={[thinking('Let me work out how to draw a smiley face in Desmos.')]}
          resultForBlock={new Map()}
          runningToolCalls={[]}
          streaming
        />
      </CanvasProvider>,
    );
  });
  return container;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a new chat’s first thought does not inherit an old start time', () => {
  it('two chains, fourteen minutes apart, each time their OWN thought', async () => {
    const t0 = 1_790_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await mountChain('group-early-a0');
    now.mockReturnValue(t0 + 14 * 60_000);
    const later = await mountChain('group-late-a0');
    const label = later.querySelector('.pd-chain-step-elapsed')?.textContent ?? '';
    expect(label).not.toMatch(/14m/);
    expect(label).toBe('');
  });

  it('a caller with no key gets a key of its own mount — never the shared slot', async () => {
    const t0 = 1_790_100_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await mountChain(undefined);
    now.mockReturnValue(t0 + 9 * 60_000);
    const later = await mountChain(undefined);
    expect(later.querySelector('.pd-chain-step-elapsed')?.textContent ?? '').toBe('');
  });
});
