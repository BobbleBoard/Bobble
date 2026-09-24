/**
 * MacVisionClient against the REAL compiled helper, on the fixture pictures.
 * Gated like live.test.ts: PI_MAC_E2E=1 and a prior
 * `bash packages/pi-mac/scripts/build-signed.sh` (or `pnpm --filter
 * @pi-desktop/pi-mac build:swift`). Vision on files needs no permission, so
 * unlike the computer-use live test nothing here depends on a TCC grant.
 *
 * Expectations come from fixtures/vision/fixtures.json, whose boxes were
 * measured WITHOUT Vision — this compares Vision with an independent
 * reference, not with a recording of itself.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devHelperPath } from './helper-path.js';
import { MacVisionClient } from './vision.js';
import { VISION_PROTOCOL_VERSION, type VisionBox } from './vision-types.js';

const LIVE = process.env.PI_MAC_E2E === '1';
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/vision');

interface Manifest {
  files: {
    'cat.jpg': {
      subject: {
        box: VisionBox;
        minIoU: number;
        inside: [number, number][];
        outside: [number, number][];
      };
    };
    'apples.jpg': {
      apples: { name: string; box: VisionBox; tap: [number, number] }[];
      minIoU: number;
      background: [number, number][];
      nearMiss: { point: [number, number]; radius: number; apple: string };
    };
    'poster.png': { lines: string[] };
    'sign-misspelt.png': { text: string };
  };
}

function iou(a: VisionBox, b: VisionBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** The value, or a failure that names what was missing. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

/** Width and height from a PNG's IHDR — enough to prove a mask is full size. */
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe.skipIf(!LIVE)('pi-mac --vision live (real binary, fixture pictures)', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(FIXTURES, 'fixtures.json'), 'utf8'),
  ) as Manifest;
  const out = mkdtempSync(path.join(tmpdir(), 'pi-mac-vision-live-'));
  const fx = (name: string) => path.join(FIXTURES, name);
  let vision: MacVisionClient;

  beforeAll(async () => {
    expect(existsSync(devHelperPath()), 'build the helper first').toBe(true);
    vision = new MacVisionClient();
    // A freshly built helper spends ~29 s once preparing its text models.
    const warm = await vision.warm();
    console.log(`[vision live] warm: lift ${warm.liftMs} ms, ocr ${warm.ocrMs} ms`);
  }, 180_000);

  afterAll(() => {
    vision?.dispose();
    rmSync(out, { recursive: true, force: true });
  });

  it('speaks the protocol version this client was written for', async () => {
    expect((await vision.info()).version).toBe(VISION_PROTOCOL_VERSION);
  });

  it('lifts the cat as instance 1 with a sensible box and a full-size mask', async () => {
    const want = manifest.files['cat.jpg'].subject;
    const lift = await vision.lift({
      image: fx('cat.jpg'),
      out,
      write: ['mask', 'foregroundCutout'],
    });
    expect(lift.count).toBe(1);
    const cat = must(lift.instances[0], 'the cat');
    expect(cat.index).toBe(1);
    expect(iou(cat.bbox, want.box)).toBeGreaterThanOrEqual(want.minIoU);
    expect(pngSize(must(cat.maskPath, 'mask'))).toEqual({ width: 960, height: 640 });
    expect(existsSync(must(lift.foreground?.cutoutPath, 'cutout'))).toBe(true);
    for (const [x, y] of want.inside) {
      expect((await vision.instanceAt({ image: fx('cat.jpg'), x, y, write: [] })).index).toBe(1);
    }
    for (const [x, y] of want.outside) {
      expect((await vision.instanceAt({ image: fx('cat.jpg'), x, y, write: [] })).hit).toBe(false);
    }
  });

  it('tells the three apples apart by a tap on each', async () => {
    const want = manifest.files['apples.jpg'];
    const seen = new Set<number>();
    for (const apple of want.apples) {
      const [x, y] = apple.tap;
      const at = await vision.instanceAt({ image: fx('apples.jpg'), x, y, out });
      expect(at.hit, apple.name).toBe(true);
      expect(at.count).toBe(3);
      const found = must(at.instance, apple.name);
      expect(iou(found.bbox, apple.box), apple.name).toBeGreaterThanOrEqual(want.minIoU);
      seen.add(at.index);
    }
    expect(seen.size).toBe(3);
    for (const [x, y] of want.background) {
      expect((await vision.instanceAt({ image: fx('apples.jpg'), x, y })).hit).toBe(false);
    }
    const [nx, ny] = want.nearMiss.point;
    const miss = await vision.instanceAt({ image: fx('apples.jpg'), x: nx, y: ny, write: [] });
    const snap = await vision.instanceAt({
      image: fx('apples.jpg'),
      x: nx,
      y: ny,
      radius: want.nearMiss.radius,
      write: [],
    });
    const middle = must(
      want.apples.find((a) => a.name === want.nearMiss.apple),
      'the near-miss apple',
    );
    expect(miss.hit).toBe(false);
    expect(snap.hit).toBe(true);
    expect(iou(must(snap.instance, 'snapped apple').bbox, middle.box)).toBeGreaterThanOrEqual(
      want.minIoU,
    );
  });

  it('reports an EXIF-rotated picture in display coordinates', async () => {
    const upright = await vision.lift({ image: fx('cat.jpg'), write: [] });
    const rotated = await vision.lift({ image: fx('cat-rotated.jpg'), write: [] });
    expect(rotated.orientation).toBe(6);
    expect([rotated.width, rotated.height]).toEqual([960, 640]);
    const a = must(rotated.instances[0], 'rotated cat').bbox;
    const b = must(upright.instances[0], 'upright cat').bbox;
    expect(iou(a, b)).toBeGreaterThanOrEqual(0.95);
  });

  it('reads every line of the poster, in order', async () => {
    const ocr = await vision.ocr({ image: fx('poster.png') });
    expect(ocr.lines.map((l) => l.text)).toEqual(manifest.files['poster.png'].lines);
    for (const line of ocr.lines) {
      expect(line.box.x).toBeGreaterThanOrEqual(0);
      expect(line.box.y + line.box.height).toBeLessThanOrEqual(1200);
    }
  });

  it('reads a misspelling literally with correction off', async () => {
    const ocr = await vision.ocr({ image: fx('sign-misspelt.png'), correction: false });
    expect(ocr.text).toBe(manifest.files['sign-misspelt.png'].text);
  });

  it('finds nothing in a blank picture', async () => {
    expect((await vision.lift({ image: fx('blank.png') })).count).toBe(0);
    expect((await vision.ocr({ image: fx('blank.png') })).lines).toEqual([]);
  });

  it('clamps or refuses absurd numbers instead of dying', async () => {
    const far = await vision.instanceAt({
      image: fx('apples.jpg'),
      x: 470,
      y: 100,
      radius: 1e19,
      write: [],
    });
    expect(far.hit).toBe(true); // clamped to a tap tolerance, not a trap
    await expect(
      vision.ocr({ image: fx('poster.png'), region: { x: 1e19, y: 0, width: 1, height: 1 } }),
    ).rejects.toThrow('region lies outside');
    expect((await vision.info()).version).toBe(VISION_PROTOCOL_VERSION); // still alive
  });

  it('applies maxPixels to a picture that is already cached', async () => {
    await vision.lift({ image: fx('cat.jpg'), write: [] });
    await expect(
      vision.lift({ image: fx('cat.jpg'), maxPixels: 100_000, write: [] }),
    ).rejects.toThrow('too large');
  });

  it("returns the helper's error for a missing file", async () => {
    await expect(vision.lift({ image: fx('nope.png') })).rejects.toThrow('image not found');
  });
});
