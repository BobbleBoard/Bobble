import { describe, expect, it } from 'vitest';
import { taskLabel, uniqueTasks } from './StorageView';

describe('Manage Storage card chips', () => {
  it('shows one chip per label, not per spelling', () => {
    // Comfy-Org/Mage-Flow: the 3D engine says `image`, the Recommended catalog
    // `text-to-image` — both read "text → image", and the card showed it twice.
    const tasks = uniqueTasks(['image', 'text-to-image']);
    expect(tasks.map(taskLabel)).toEqual(['text → image']);
  });

  it('keeps distinct jobs, in order', () => {
    expect(uniqueTasks(['image', 'segment']).map(taskLabel)).toEqual([
      'text → image',
      'part segmentation',
    ]);
    expect(uniqueTasks([])).toEqual([]);
  });
});
