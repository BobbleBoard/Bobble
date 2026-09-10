// @vitest-environment jsdom
/**
 * "Done" must not appear over a turn that is still working — and must not
 * SURVIVE one either.
 *
 * the user has now reported this FOUR times, the last with a screenshot: "premature
 * done is showing while thoughts/tools are still being written." Every previous
 * fix was a one-line change to an expression, and the fourth cause was one no
 * pure-function test could reach: `everDone` latched one-way, so a chain that
 * had legitimately settled kept showing Done after it received more thinking
 * and another tool call.
 *
 * That is a bug ACROSS RENDERS, which is why this file mounts the real
 * component and re-renders it rather than asserting on a helper.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityChain, type ActivityStepData } from './activity-chain.tsx';

const step = (over: Partial<ActivityStepData> = {}): ActivityStepData =>
  ({ kind: 'bash', label: 'Ran a command', detail: 'ls', id: 's1', ...over }) as ActivityStepData;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Mount once; `rerender` drives the prop changes the bug lives in. */
function mount(props: { steps: ActivityStepData[]; complete?: boolean; active?: boolean }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<ActivityChain {...props} />));
  return {
    text: () => host?.textContent ?? '',
    /* Collapsing is a CSS state, not an unmount — the steps stay in the DOM
       either way — so the chain's own `data-expanded` is the only honest read. */
    expanded: () =>
      host?.querySelector('[data-expanded]')?.getAttribute('data-expanded') === 'true',
    rerender: (next: typeof props) => act(() => root?.render(<ActivityChain {...next} />)),
  };
}

describe('ActivityChain — Done never covers a live turn', () => {
  it('does not say Done while the turn owner says the turn is live', () => {
    const ui = mount({ steps: [step()], complete: false, active: false });
    expect(ui.text()).not.toMatch(/Done/);
  });

  it('says Done once the owner says the turn is over', () => {
    const ui = mount({ steps: [step()], complete: true, active: false });
    expect(ui.text()).toMatch(/Done/);
  });

  /*
   * THE FOURTH BUG, and the one this file exists for. Settle the chain, then
   * give it more work — exactly what the screenshot showed: a Done sitting
   * under a thinking block and a fresh tool row.
   */
  it('RETRACTS Done when the same chain gets more work', () => {
    const ui = mount({ steps: [step()], complete: true, active: false });
    expect(ui.text()).toMatch(/Done/);

    ui.rerender({
      steps: [step(), step({ id: 's2', kind: 'thinking', label: 'Thinking' })],
      complete: false,
      active: true,
    });
    expect(ui.text()).not.toMatch(/Done/);
  });

  it('does not flicker Done off between two tool calls', () => {
    // The behaviour the latch was added for: `complete` stays false across the
    // gap, so nothing ever showed Done and there is nothing to retract.
    const ui = mount({ steps: [step()], complete: false, active: true });
    expect(ui.text()).not.toMatch(/Done/);
    ui.rerender({ steps: [step()], complete: false, active: false }); // the gap
    expect(ui.text()).not.toMatch(/Done/);
    ui.rerender({ steps: [step(), step({ id: 's2' })], complete: false, active: true });
    expect(ui.text()).not.toMatch(/Done/);
  });

  it('keeps Done across a re-render once the turn really is over', () => {
    const ui = mount({ steps: [step()], complete: true, active: false });
    expect(ui.text()).toMatch(/Done/);
    ui.rerender({ steps: [step()], complete: true, active: false });
    expect(ui.text()).toMatch(/Done/);
  });
});

/*
 * COLLAPSING is a separate question from Done, and they were tangled: the chain
 * stayed expanded for as long as the TURN ran, so a finished chain sat open
 * through the model's reply and through the next chain's work. the user: "thinking
 * / tool chains need to collapse when they finish and the model starts typing
 * actual response, even if a new one starts right after, the old one is then
 * collapsed."
 */
describe('ActivityChain — a finished chain folds even while the turn runs on', () => {
  const steps = [step(), step({ id: 's2', kind: 'thinking', label: 'Thinking' })];
  it('is open while it is the live chain', () => {
    const ui = mount({ steps, complete: false, active: true });
    expect(ui.expanded()).toBe(true);
  });

  it('folds the moment it stops being the live one, though the turn is not over', () => {
    const ui = mount({ steps, complete: false, active: true });
    expect(ui.expanded()).toBe(true);
    // The model starts typing its reply: a later segment exists, so this chain
    // is no longer the live one — but the TURN is still streaming, which is
    // exactly the case that used to hold it open.
    ui.rerender({ steps, complete: false, active: false });
    expect(ui.expanded()).toBe(false);
  });

  it('folds when the turn ends too', () => {
    const ui = mount({ steps, complete: false, active: true });
    ui.rerender({ steps, complete: true, active: false });
    expect(ui.expanded()).toBe(false);
  });
});

/*
 * the user's connector row: "<generic connectors icon> Used <connector app icon>
 * <connector app name> <action eg. read page or listed tabs>", and "the tiny
 * text to the right with the raw cli command is not shown, instead a '>' ...
 * clicking that expands the individual tool and shows the exact cli command and
 * what was returned."
 */
describe('ActivityChain — connector usage reads as a sentence, not a shell line', () => {
  const used = (over: Partial<ActivityStepData> = {}): ActivityStepData =>
    ({
      kind: 'bash',
      label: 'Read the page in Chrome',
      action: 'Read the page',
      app: 'Google Chrome',
      detail: 'chrome snapshot "2TB"',
      command: 'chrome snapshot "2TB"',
      id: 'c1',
      ...over,
    }) as ActivityStepData;

  it('says Used, then the app, then the action', () => {
    const ui = mount({ steps: [used()], complete: true, active: false });
    expect(ui.text()).toMatch(/Used/);
    expect(ui.text()).toMatch(/Google Chrome/);
    expect(ui.text()).toMatch(/Read the page/);
  });

  it('does not put the raw command on the row', () => {
    const _ui = mount({ steps: [used()], complete: true, active: false });
    const row = host?.querySelector('.pd-chain-used');
    expect(row).not.toBeNull();
    expect(row?.textContent ?? '').not.toMatch(/chrome snapshot/);
  });

  /* An ordinary shell command has no app and no action, so it keeps the old
     shape — the raw line beside the verb. */
  it('leaves a plain command alone', () => {
    const ui = mount({
      steps: [step({ label: 'Ran a command', detail: 'ls -la' })],
      complete: true,
      active: false,
    });
    expect(host?.querySelector('.pd-chain-used')).toBeNull();
    expect(ui.text()).toMatch(/ls -la/);
  });
});
