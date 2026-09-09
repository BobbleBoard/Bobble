import { describe, expect, it } from 'vitest';
import { describeTally, emptyTally, noteResult } from './modality';

const img = (bytes: number) => ({ type: 'image', data: 'A'.repeat(Math.ceil((bytes * 4) / 3)) });
const txt = (text: string) => ({ type: 'text', text });

describe('the modality tally', () => {
  it('separates what came back from what the act was aimed by', () => {
    const t = emptyTally();
    noteResult(t, 'mac_snapshot', {}, [txt('[1] AXButton "One"\n[2] AXTextField')]);
    noteResult(t, 'mac_click', { index: 2 }, [txt('Clicked element [2].')]);
    noteResult(t, 'mac_click', { x: 400, y: 220 }, [txt('Clicked at (400, 220).')]);
    expect(t.axSnapshots).toBe(1);
    expect(t.byIndex).toBe(1);
    expect(t.byCoord).toBe(1);
    expect(t.images).toBe(0);
  });

  it('counts an index-aimed click as index-aimed even when x,y ride along', () => {
    // The tools resolve a menu, then an index, then a coordinate — so a call
    // carrying both was aimed by the index, and counting it as a pixel act
    // would overstate exactly the number the user is asking about.
    const t = emptyTally();
    noteResult(t, 'browser_click', { index: 3, x: 10, y: 10 }, [txt('Clicked element [3].')]);
    expect(t.byIndex).toBe(1);
    expect(t.byCoord).toBe(0);
  });

  it('records an image’s real byte cost, not its base64 length', () => {
    const t = emptyTally();
    noteResult(t, 'mac_snapshot', {}, [txt('[1] AXButton'), img(30_000)]);
    expect(t.images).toBe(1);
    expect(t.imageBytes).toBeGreaterThan(29_000);
    expect(t.imageBytes).toBeLessThan(31_000);
  });

  it('marks the app that leaves the model no choice', () => {
    // Blender: three elements, none of them the app. Every act there is a
    // coordinate because there is nothing else to aim at — the run has to be
    // able to say "forced", not "preferred".
    const t = emptyTally();
    noteResult(t, 'mac_snapshot', {}, [
      txt('"Blender" exposes no Accessibility elements, so it has no indexes — pass x and y'),
    ]);
    noteResult(t, 'mac_click', { x: 800, y: 400 }, [txt('Clicked at (800, 400).')]);
    expect(t.visualOnly).toBe(1);
    expect(t.byCoord).toBe(1);
    expect(describeTally(t)).toContain('no-tree snapshots 1/1');
  });

  it('separates the browser’s DOM from a native tree', () => {
    const t = emptyTally();
    noteResult(t, 'browser_snapshot', {}, [txt('x'.repeat(2048))]);
    noteResult(t, 'mac_snapshot', {}, [txt('y'.repeat(1024))]);
    expect(t.domSnapshots).toBe(1);
    expect(t.domChars).toBe(2048);
    expect(t.axSnapshots).toBe(1);
    expect(t.axChars).toBe(1024);
  });

  it('does not count a plain shell result as a snapshot', () => {
    const t = emptyTally();
    noteResult(t, 'bash', { command: 'ls' }, [txt('a\nb\n')]);
    expect(t.axSnapshots).toBe(0);
    expect(t.otherResults).toBe(1);
  });
});
