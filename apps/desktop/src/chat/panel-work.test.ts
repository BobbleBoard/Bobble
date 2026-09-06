import { describe, expect, it } from 'vitest';
import { panelWorkLine, streamingTab } from './panel-work';

describe('panelWorkLine', () => {
  it('names the file and points at the panel', () => {
    expect(panelWorkLine({ name: 'launch-plan.md', kind: 'markdown' }, true)).toBe(
      'Writing launch-plan.md in the panel →',
    );
  });

  it('draws rather than writes an image', () => {
    expect(panelWorkLine({ name: 'poster.png', kind: 'image' }, true)).toBe(
      'Drawing poster.png in the panel →',
    );
  });

  /*
   * ONLY WHILE LIVE. A finished file already sits in the chain above with its
   * own open affordance; a status line repeating it is a second, staler copy of
   * the same fact — and the one that will still be there tomorrow.
   */
  it('says nothing once the turn is over', () => {
    expect(panelWorkLine({ name: 'launch-plan.md', kind: 'markdown' }, false)).toBeNull();
  });

  it('says nothing when the panel is idle', () => {
    expect(panelWorkLine(null, true)).toBeNull();
  });

  it('says nothing rather than pointing at a nameless tab', () => {
    expect(panelWorkLine({ name: '   ', kind: 'file' }, true)).toBeNull();
  });
});

describe('streamingTab', () => {
  it('picks the tab that is actually being written', () => {
    const tabs = [
      { title: 'notes.md', streaming: false },
      { title: 'launch-plan.md', streaming: true },
      { title: 'draft.md' },
    ];
    expect(streamingTab(tabs)?.title).toBe('launch-plan.md');
  });

  it('is null when nothing is streaming', () => {
    expect(streamingTab([{ title: 'a' }, { title: 'b', streaming: false }])).toBeNull();
  });
});
