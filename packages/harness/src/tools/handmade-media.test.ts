/**
 * The line between "synthesising media a generator should have made" and
 * "drawing with code, which is a perfectly good thing to do".
 *
 * A guard that cannot tell those apart is worse than no guard: it would block
 * charts, diagrams and fixtures, which no generator makes.
 */
import { describe, expect, it } from 'vitest';
import {
  handmadeMediaKind,
  handmadeMediaRefusal,
  isHandmadeMedia,
  type MediaKind,
} from './handmade-media.js';

const ALL: ReadonlySet<MediaKind> = new Set<MediaKind>(['image', 'audio', 'video']);

/* The actual script MiniCPM5 2B wrote when asked in chat for a picture of a mug,
   abridged — the case this exists for. */
const MUG = `
from PIL import Image, ImageDraw
import random
W, H = 768, 768
img = Image.new("RGB", (W, H))
draw = ImageDraw.Draw(img)
# --- Sky gradient (morning light) ---
sky_top = (240, 230, 200, 255)
for y in range(H):
    draw.line([(0, y), (W, y)], fill=sky_top)
img.save("mug_morning.png")
`;

describe('handmadeMediaKind', () => {
  it('catches the measured case: a Pillow script that draws and saves a picture', () => {
    expect(handmadeMediaKind('make_mug_morning.py', MUG)).toBe('image');
  });

  it('names the modality from what the script emits', () => {
    expect(
      handmadeMediaKind('tone.py', 'import wave\nf = wave.open("out.wav", "wb")\nf.close()'),
    ).toBe('audio');
    expect(
      handmadeMediaKind('clip.py', 'from moviepy import *\nclip.write_videofile("out.mp4")'),
    ).toBe('video');
  });

  it('reads a numbered frame sequence as a clip, not a picture', () => {
    // The script a 2B actually wrote when asked for a two-second video: it draws
    // frames and never names an mp4, because ffmpeg came afterwards in bash.
    const frames = `
from PIL import Image, ImageDraw
frames = []
for i in range(60):
    img = Image.new('RGB', (640, 480))
    ImageDraw.Draw(img).ellipse([0, 0, 10, 10], fill=(255, 0, 0))
    frames.append(img)
for i, frame in enumerate(frames):
    frame.save(f'frame_{i:04d}.png')
`;
    expect(handmadeMediaKind('make_video.py', frames)).toBe('video');
    expect(handmadeMediaRefusal('make_video.py', 'video', { cli: true })).toContain(
      'media generate video',
    );
  });

  it('does not call a single drawn picture a clip', () => {
    expect(handmadeMediaKind('make_mug_morning.py', MUG)).toBe('image');
  });

  it('leaves a chart alone — a rendering of data is not a picture of something', () => {
    const chart = `
import matplotlib.pyplot as plt
plt.plot([1, 2, 3], [4, 5, 6])
plt.savefig("revenue.png")
`;
    expect(handmadeMediaKind('chart.py', chart)).toBeNull();
  });

  it('leaves ordinary image PROCESSING alone', () => {
    // Opening, cropping and resizing a photo that already exists is work a
    // generator cannot do at all.
    const crop = `
from PIL import Image
im = Image.open("photo.jpg")
im.crop((0, 0, 100, 100)).resize((64, 64)).save("thumb.png")
`;
    expect(handmadeMediaKind('thumb.py', crop)).toBeNull();
  });

  it('ignores a script that draws but never writes a media file', () => {
    const onscreen = `
from PIL import Image, ImageDraw
img = Image.new("RGB", (10, 10))
ImageDraw.Draw(img).line([(0, 0), (9, 9)])
img.show()
`;
    expect(handmadeMediaKind('preview.py', onscreen)).toBeNull();
  });

  it('is about scripts, not about media files themselves', () => {
    // A `.png` arriving through `write` is a different (and fine) thing.
    expect(handmadeMediaKind('out.png', MUG)).toBeNull();
  });
});

describe('isHandmadeMedia', () => {
  it('only fires when the generator that would have done the job exists', () => {
    expect(isHandmadeMedia({ path: 'm.py', content: MUG, available: ALL })).toBe('image');
    expect(isHandmadeMedia({ path: 'm.py', content: MUG, available: new Set() })).toBeNull();
    // An audio generator does not make this an audio problem.
    expect(
      isHandmadeMedia({ path: 'm.py', content: MUG, available: new Set<MediaKind>(['audio']) }),
    ).toBeNull();
  });
});

describe('handmadeMediaRefusal', () => {
  it('names the generator in the mode’s own shape, the call, and the way through', () => {
    const r = handmadeMediaRefusal('make_mug_morning.py', 'image', { cli: true });
    expect(r).toContain('media generate image');
    expect(r).toContain('UNCHANGED');
    // Schemas mode: the TOOL, and how to get it — a command the model cannot
    // run is a dead end. SEEN: "Run it with the bash tool" read as "run the
    // script with bash".
    const schema = handmadeMediaRefusal('make_mug_morning.py', 'image');
    expect(schema).toContain('generate_image {');
    expect(schema).toContain('capability("generation")');
    expect(schema).not.toContain('media generate');
    expect(schema).toContain('Do NOT run this script');
    expect(handmadeMediaRefusal('t.py', 'audio', { cli: true })).toContain('media generate music');
    expect(handmadeMediaRefusal('c.py', 'video', { cli: true })).toContain('media generate video');
  });
});
