// @vitest-environment jsdom
/**
 * The wait row folds away instead of vanishing — unless a step takes its place.
 *
 * A card drawn beneath the chain jumped 34px when this row came and went in one
 * frame (the live diagram's hand-over, 2026-09-25). Growing in is CSS; folding
 * away needs the row to stay MOUNTED, the same element, marked leaving, for the
 * length of the fold — a bug across renders, so this mounts the real component.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityChain, type ActivityStepData } from './activity-chain.tsx';

const step = (id: string): ActivityStepData =>
  ({ kind: 'bash', label: 'Ran a command', detail: 'ls', id }) as ActivityStepData;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

type Props = Parameters<typeof ActivityChain>[0];

function mount(props: Props) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<ActivityChain {...props} />));
  return {
    row: () => host?.querySelector('.pd-chain-step--prefill') ?? null,
    rerender: (next: Props) => act(() => root?.render(<ActivityChain {...next} />)),
  };
}

describe('ActivityChain — the wait row', () => {
  it('stays mounted, marked leaving, while it folds, then goes', () => {
    vi.useFakeTimers();
    const ui = mount({ steps: [step('a')], active: true, prefill: { percent: null, label: 'Processing' } });
    const before = ui.row();
    expect(before).not.toBeNull();
    expect(before?.getAttribute('data-leaving')).toBeNull();

    ui.rerender({ steps: [step('a')], active: true });
    // The same element, so the CSS transition has a height to fold from.
    expect(ui.row()).toBe(before);
    expect(ui.row()?.getAttribute('data-leaving')).toBe('true');
    expect(ui.row()?.textContent).toMatch(/Processing/);

    act(() => vi.advanceTimersByTime(250));
    expect(ui.row()).toBeNull();
  });

  it('is simply replaced when the next step arrives in the same render', () => {
    const ui = mount({ steps: [step('a')], active: true, prefill: { percent: 40, label: 'Processing' } });
    expect(ui.row()).not.toBeNull();
    ui.rerender({ steps: [step('a'), step('b')], active: true });
    expect(ui.row()).toBeNull();
  });

  it('comes back unfolded when the wait resumes mid-fold', () => {
    vi.useFakeTimers();
    const ui = mount({ steps: [step('a')], active: true, prefill: { percent: null } });
    ui.rerender({ steps: [step('a')], active: true });
    expect(ui.row()?.getAttribute('data-leaving')).toBe('true');
    ui.rerender({ steps: [step('a')], active: true, prefill: { percent: 10 } });
    expect(ui.row()?.getAttribute('data-leaving')).toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(ui.row()).not.toBeNull();
  });
});
