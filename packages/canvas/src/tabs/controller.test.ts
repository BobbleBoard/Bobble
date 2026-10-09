import { describe, expect, it, vi } from 'vitest';
import { CanvasController, createCanvasController } from './controller.ts';

function seqIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `t${n}`;
  };
}

describe('CanvasController', () => {
  it('openTab appends, focuses, and un-collapses; returns the new id', () => {
    const c = new CanvasController({ idFactory: seqIds(), initialState: { collapsed: true } });
    const id = c.openTab({ kind: 'browser', title: 'New tab' });
    expect(id).toBe('t1');
    const state = c.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe('t1');
    expect(state.collapsed).toBe(false);
  });

  it('focusTab activates an existing tab and ignores unknown ids', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const a = c.openTab({ kind: 'code', title: 'a' });
    const b = c.openTab({ kind: 'code', title: 'b' });
    expect(c.getState().activeTabId).toBe(b);
    c.focusTab(a);
    expect(c.getState().activeTabId).toBe(a);
    c.focusTab('nope');
    expect(c.getState().activeTabId).toBe(a);
  });

  it('upsertTab opens once per key then focuses+merges the same tab', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const first = c.upsertTab('artifact-7', { kind: 'image', title: 'Preview' });
    const other = c.openTab({ kind: 'code', title: 'code' });
    expect(c.getState().activeTabId).toBe(other);

    const second = c.upsertTab('artifact-7', {
      kind: 'image',
      title: 'Preview v2',
      mediaStatus: 'loaded',
    });
    expect(second).toBe(first); // same tab id — no duplicate
    expect(c.getState().tabs).toHaveLength(2);
    expect(c.getState().activeTabId).toBe(first); // re-opening focuses it
    const tab = c.getState().tabs.find((t) => t.id === first);
    expect(tab?.title).toBe('Preview v2'); // spec merged in
    expect(tab?.mediaStatus).toBe('loaded');
  });

  it('closeTab removes and reassigns active to the left neighbour, then null', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const a = c.openTab({ kind: 'code', title: 'a' });
    const b = c.openTab({ kind: 'code', title: 'b' });
    const cc = c.openTab({ kind: 'code', title: 'c' });
    c.focusTab(b);
    c.closeTab(b);
    expect(c.getState().tabs.map((t) => t.id)).toEqual([a, cc]);
    expect(c.getState().activeTabId).toBe(a); // left neighbour
    c.closeTab(a);
    c.closeTab(cc);
    expect(c.getState().tabs).toHaveLength(0);
    expect(c.getState().activeTabId).toBeNull();
  });

  it('updateTab merges a patch into a tab (preserving id)', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const id = c.openTab({ kind: 'browser', title: 'New tab' });
    c.updateTab(id, { url: 'https://example.com', canGoBack: true });
    const tab = c.getState().tabs[0];
    expect(tab?.id).toBe(id);
    expect(tab?.url).toBe('https://example.com');
    expect(tab?.canGoBack).toBe(true);
  });

  it('setCollapsed / setFullscreen toggle and no-op when unchanged', () => {
    const c = createCanvasController({ idFactory: seqIds() });
    const listener = vi.fn();
    c.subscribe(listener);
    c.setCollapsed(true);
    expect(c.getState().collapsed).toBe(true);
    c.setCollapsed(true); // no-op
    c.setFullscreen(true);
    expect(c.getState().fullscreen).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2); // one per real change
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const c = new CanvasController({ idFactory: seqIds() });
    const listener = vi.fn();
    const off = c.subscribe(listener);
    c.openTab({ kind: 'code', title: 'a' });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    c.openTab({ kind: 'code', title: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('closing the LAST tab closes the rail', () => {
  /*
   * The user: "clicking the X on the last tab in the canvas should close the canvas
   * sidebar." Lives on the controller because the affordances had drifted — ⌘W
   * collapsed the rail and the tab's own X did not, so the same action behaved
   * differently depending on how you performed it.
   */
  it('fires onEmpty when the final tab goes', () => {
    let closed = 0;
    const c = createCanvasController({
      onEmpty: () => {
        closed += 1;
      },
    });
    const a = c.openTab({ kind: 'file', title: 'a.ts' });
    const b = c.openTab({ kind: 'file', title: 'b.ts' });
    c.closeTab(a);
    expect(closed).toBe(0); // one tab left — the rail stays
    c.closeTab(b);
    expect(closed).toBe(1);
  });

  it('does NOT fire for a close that leaves tabs behind', () => {
    let closed = 0;
    const c = createCanvasController({
      onEmpty: () => {
        closed += 1;
      },
    });
    c.openTab({ kind: 'file', title: 'a.ts' });
    const b = c.openTab({ kind: 'file', title: 'b.ts' });
    c.closeTab(b);
    expect(closed).toBe(0);
  });

  it('does NOT fire for an unknown id, which removes nothing', () => {
    let closed = 0;
    const c = createCanvasController({
      onEmpty: () => {
        closed += 1;
      },
    });
    c.closeTab('nope');
    expect(closed).toBe(0);
  });

  it('works without the callback — a headless controller has no rail', () => {
    const c = createCanvasController();
    const a = c.openTab({ kind: 'file', title: 'a.ts' });
    expect(() => c.closeTab(a)).not.toThrow();
    expect(c.getState().tabs).toHaveLength(0);
  });
});

/**
 * THE LOOP CLASS.
 *
 * React #185 ("Maximum update depth exceeded") is built out of writes that
 * change nothing but notify anyway: an effect keyed on canvas state writes back
 * to the canvas, the write commits a fresh object, every subscriber re-renders,
 * and the effect can be woken by its own write. The controller is the one place
 * that can make that impossible, so a no-op write must be silent.
 *
 * These fail on the old controller, which committed unconditionally.
 */
describe('a write that changes nothing notifies nobody', () => {
  it('updateTab with the values a tab already has does not notify', () => {
    const c = createCanvasController();
    const id = c.openTab({ kind: 'browser', title: 'Browser', url: 'https://a.test' });
    let notified = 0;
    c.subscribe(() => {
      notified += 1;
    });
    c.updateTab(id, { url: 'https://a.test' });
    c.updateTab(id, { title: 'Browser' });
    c.updateTab(id, { url: 'https://a.test', title: 'Browser' });
    expect(notified).toBe(0);
    // …and a real change still lands.
    c.updateTab(id, { url: 'https://b.test' });
    expect(notified).toBe(1);
    expect(c.getState().tabs[0]?.url).toBe('https://b.test');
  });

  it('the state object itself is unchanged by a no-op patch', () => {
    const c = createCanvasController();
    const id = c.openTab({ kind: 'code', title: 'x.ts' });
    const before = c.getState();
    c.updateTab(id, { title: 'x.ts' });
    expect(c.getState()).toBe(before);
  });

  it('focusTab on the already-focused tab of an open canvas does not notify', () => {
    const c = createCanvasController();
    const a = c.openTab({ kind: 'code', title: 'a' });
    const b = c.openTab({ kind: 'code', title: 'b' });
    let notified = 0;
    c.subscribe(() => {
      notified += 1;
    });
    c.focusTab(b); // already active, canvas already open
    expect(notified).toBe(0);
    c.focusTab(a);
    expect(notified).toBe(1);
    // …and it still un-collapses when the canvas is closed on the active tab.
    c.setCollapsed(true);
    notified = 0;
    c.focusTab(a);
    expect(notified).toBe(1);
    expect(c.getState().collapsed).toBe(false);
  });
});
