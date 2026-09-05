/**
 * WHAT EACH ROOM WILL TAKE OFF THE DESKTOP.
 *
 * The list is a claim about the ENGINES, not about what the app can display, so
 * it is worth pinning: a file waved through here is one that fails forty seconds
 * into a run with a Python traceback, and a file wrongly refused is a capability
 * that silently does not exist.
 */
import { describe, expect, it } from 'vitest';
import { studioAccepts } from './use-handoff';

describe('studioAccepts', () => {
  it('takes the containers each engine actually reads', () => {
    expect(studioAccepts('image', 'fox.png')).toBe(true);
    expect(studioAccepts('image', 'fox.jpeg')).toBe(true);
    expect(studioAccepts('image', 'fox.webp')).toBe(true);
    expect(studioAccepts('video', 'clip.mp4')).toBe(true);
    expect(studioAccepts('audio', 'take.wav')).toBe(true);
    expect(studioAccepts('3d', 'bust.glb')).toBe(true);
  });

  it('refuses a file the room cannot work from', () => {
    expect(studioAccepts('image', 'notes.txt')).toBe(false);
    expect(studioAccepts('image', 'clip.mp4')).toBe(false);
    expect(studioAccepts('3d', 'fox.png')).toBe(false);
    expect(studioAccepts('audio', 'bust.glb')).toBe(false);
  });

  it('ignores the case of the extension', () => {
    // A camera roll is full of .JPG and a scan tool writes .PNG; refusing those
    // would look like the drop target is simply broken.
    expect(studioAccepts('image', 'DSC_0001.JPG')).toBe(true);
    expect(studioAccepts('3d', 'Bust.GLB')).toBe(true);
  });

  it('refuses a name with no extension at all rather than guessing', () => {
    expect(studioAccepts('image', 'screenshot')).toBe(false);
  });

  it('reads the LAST extension, not the first one it finds', () => {
    // `render.png.bak` is not a PNG, and `v2.final.png` is.
    expect(studioAccepts('image', 'render.png.bak')).toBe(false);
    expect(studioAccepts('image', 'v2.final.png')).toBe(true);
  });
});
