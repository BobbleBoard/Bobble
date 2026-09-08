import { describe, expect, it } from 'vitest';
import { clockTime, humanSize, mediaFromToolResult, pdFilePath } from './thread-media';

/**
 * The strings under test are VERBATIM from the generate tools in
 * `@pi-desktop/gen-tools` — this parser and those tools are two ends of one
 * contract, and a fixture that paraphrased them would pass while the real thing
 * mounted nothing.
 */
const SPEECH = `Generated 1 audio file:
  1. /Users/j/Bobble/generated/read-this-aloud/speech_000.wav (seed 7)
Model: kokoro-82m`;

const SFX_THREE = `Generated 3 audio files:
  1. /Users/j/Bobble/generated/door-slam/sfx_000.wav (seed 11)
  2. /Users/j/Bobble/generated/door-slam/sfx_001.wav (seed 12)
  3. /Users/j/Bobble/generated/door-slam/sfx_002.wav (seed 13)
Model: stable-audio-open-small`;

const IMAGE = `Generated 1 image on the canvas:
  1. /Users/j/Bobble/generated/a-red-fox/final_000.png (seed 42)
Model: FLUX.2 klein (4B) (flux2-klein-4b, apache-2.0)`;

describe('mounting the media a turn produced', () => {
  it('finds a single speech file and calls it audio', () => {
    const items = mediaFromToolResult('generate_speech', SPEECH);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('audio');
    expect(items[0]?.name).toBe('speech_000.wav');
  });

  it('keeps every candidate, in the order listed', () => {
    const items = mediaFromToolResult('generate_sfx', SFX_THREE);
    expect(items.map((i) => i.name)).toEqual(['sfx_000.wav', 'sfx_001.wav', 'sfx_002.wav']);
  });

  it('does not let "(seed 7)" bleed into the filename', () => {
    // The bounded pattern exists for exactly this: a greedy path match swallows
    // the rest of the line and mounts a file that does not exist.
    const items = mediaFromToolResult('generate_speech', SPEECH);
    expect(items[0]?.path.endsWith('.wav')).toBe(true);
    expect(items[0]?.path).not.toContain('seed');
  });

  it('classifies by extension', () => {
    expect(mediaFromToolResult('generate_image', IMAGE)[0]?.kind).toBe('image');
    expect(mediaFromToolResult('generate_video', 'made it:\n  1. /x/y/clip.mp4')[0]?.kind).toBe(
      'video',
    );
  });

  it('mounts a repeated path only once', () => {
    const twice = '  1. /a/b/c.wav\nsaved to /a/b/c.wav';
    expect(mediaFromToolResult('generate_music', twice)).toHaveLength(1);
  });
});

describe('what it refuses to mount', () => {
  it('ignores tools we do not own', () => {
    // A bash call that happens to print a .png must not become a player.
    expect(mediaFromToolResult('bash', 'wrote /tmp/screenshot.png')).toEqual([]);
    expect(mediaFromToolResult('read_file', '/tmp/a.wav')).toEqual([]);
  });

  it('ignores an errored result', () => {
    expect(mediaFromToolResult('generate_sfx', '  1. /a/b.wav', true)).toEqual([]);
  });

  it('ignores output with no recognised media', () => {
    expect(mediaFromToolResult('generate_image', 'nothing was produced')).toEqual([]);
    expect(mediaFromToolResult('generate_image', '  1. /a/b/notes.txt')).toEqual([]);
  });

  it('survives empty and missing text', () => {
    expect(mediaFromToolResult('generate_image', undefined)).toEqual([]);
    expect(mediaFromToolResult(undefined, 'x')).toEqual([]);
  });
});

describe('the app URL and the path name ONE file', () => {
  /*
   * The harness image tools return both, deliberately: line 1 is the
   * `pd-file://` URL the renderer can load, line 2 the plain path the model
   * feeds back to `edit_image` (packages/harness/src/tools/image-tools.ts).
   *
   * The path scanner matched INSIDE the URL as well, so every generated picture
   * mounted twice — once correctly, and once as "//f/Users/…", a path that
   * exists nowhere and renders as a broken card directly under the real one.
   */
  const IMAGE_TOOL_RESULT =
    'pd-file://f/Users/j/Bobble/generated/a%20fox/cand0.png\n' +
    'Generated image saved at /Users/j/Bobble/generated/a fox/cand0.png';

  it('reads the path out of the URL, decoded', () => {
    expect(pdFilePath('pd-file://f/Users/j/x%20y/a.png')).toBe('/Users/j/x y/a.png');
    expect(pdFilePath('/Users/j/a.png')).toBeUndefined();
    expect(pdFilePath('https://example.com/a.png')).toBeUndefined();
  });

  it('mounts a generated picture exactly once', () => {
    const items = mediaFromToolResult(
      'generate_image',
      'pd-file://f/Users/j/Bobble/generated/fox/cand0.png\n' +
        'Generated image saved at /Users/j/Bobble/generated/fox/cand0.png',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.path).toBe('/Users/j/Bobble/generated/fox/cand0.png');
    expect(items[0]?.kind).toBe('image');
  });

  it('still mounts it when the URL is all the tool gave', () => {
    const items = mediaFromToolResult('generate_image', 'pd-file://f/tmp/a.png');
    expect(items).toHaveLength(1);
    expect(items[0]?.path).toBe('/tmp/a.png');
  });

  it('decodes the encoded segments, so a name with a space still resolves', () => {
    const items = mediaFromToolResult('generate_image', IMAGE_TOOL_RESULT);
    expect(items).toHaveLength(1);
    expect(items[0]?.path).toBe('/Users/j/Bobble/generated/a fox/cand0.png');
  });

  it('gives an EDITED image the same card as a generated one', () => {
    // `edit_image` produces a NEW picture beside the original, and it used to
    // reach the thread as a line of prose with a path in it while the identical
    // file from `generate_image` got the full card. The iterate loop — make one,
    // change it, change it again — ran on the one tool that showed nothing.
    const items = mediaFromToolResult(
      'edit_image',
      'pd-file://f/tmp/edited.png\nEdited image saved at /tmp/edited.png',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.path).toBe('/tmp/edited.png');
  });
});

describe('card formatting', () => {
  it('reads sizes the way a person would', () => {
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(208_640)).toBe('204 KB');
    expect(humanSize(5_400_000)).toBe('5.1 MB');
    expect(humanSize(undefined)).toBe('');
  });

  it('formats a transport clock', () => {
    expect(clockTime(0)).toBe('0:00');
    expect(clockTime(4.45)).toBe('0:04');
    expect(clockTime(75)).toBe('1:15');
    expect(clockTime(undefined)).toBe('0:00');
  });
});
