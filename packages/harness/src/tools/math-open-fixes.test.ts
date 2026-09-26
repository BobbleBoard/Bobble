import { describe, expect, it } from 'vitest';
import { fixesToPush, noteDrawn } from './math-open-fixes.js';

describe('the problems a maths page was last drawn with', () => {
  it('are named at the first present after the draw, and not again', () => {
    noteDrawn('/w/shm.html', 'shm.math.json', ['mass at (40, -60) is outside the figure']);
    expect(fixesToPush('/w/shm.html')).toEqual({
      fixes: ['mass at (40, -60) is outside the figure'],
      spec: 'shm.math.json',
    });
    expect(fixesToPush('/w/shm.html')).toBeNull();
    // A new draw with problems is named again; a clean one clears them.
    noteDrawn('/w/shm.html', 'shm.math.json', ['labels overlap']);
    noteDrawn('/w/shm.html', 'shm.math.json', []);
    expect(fixesToPush('/w/shm.html')).toBeNull();
  });
});
