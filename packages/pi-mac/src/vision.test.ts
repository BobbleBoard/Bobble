import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MacChildProcess, MacSpawnFn } from './spawn.js';
import {
  MacVisionClient,
  parseVisionInfo,
  parseVisionInstanceAt,
  parseVisionLift,
  parseVisionOcr,
  VISION_DEFAULT_TIMEOUT_MS,
  VisionArgumentError,
  VisionContractError,
} from './vision.js';
import { VISION_PROTOCOL_VERSION } from './vision-types.js';

/**
 * REAL responses from the Swift helper, captured on the fixture pictures —
 * so these tests pin the wire the helper actually speaks, not a shape someone
 * remembered.
 */
type Captured = { ok: boolean; result?: Record<string, unknown>; error?: string };
const REAL = JSON.parse(
  readFileSync(new URL('./__fixtures__/vision-responses.json', import.meta.url), 'utf8'),
) as Record<string, Captured>;

function real(name: string): Record<string, unknown> {
  const c = REAL[name];
  if (c?.ok !== true || c.result === undefined) throw new Error(`no captured result ${name}`);
  return structuredClone(c.result);
}

/** A fake `pi-mac --vision-serve`: answers each NDJSON request by method. */
function fakeHelper(
  answer: (req: { method: string; params: Record<string, unknown> }) => Captured,
): {
  spawnFn: MacSpawnFn;
  spawns: Array<{ command: string; args: readonly string[] }>;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const spawnFn: MacSpawnFn = (command, args) => {
    spawns.push({ command, args });
    const dataCbs: Array<(c: string) => void> = [];
    const child: MacChildProcess = {
      pid: 42,
      stdin: {
        write: (data, cb) => {
          const req = JSON.parse(data.trim()) as {
            id: number;
            method: string;
            params: Record<string, unknown>;
          };
          requests.push({ method: req.method, params: req.params });
          const reply = answer(req);
          queueMicrotask(() => {
            for (const f of dataCbs) f(`${JSON.stringify({ ...reply, id: req.id })}\n`);
          });
          cb?.(null);
        },
        end: () => undefined,
        on: () => undefined,
      },
      stdout: { on: (_e, cb) => dataCbs.push(cb as (c: string) => void) },
      stderr: { on: () => undefined },
      on: () => undefined,
      kill: () => undefined,
    };
    return child;
  };
  return { spawnFn, spawns, requests };
}

function client(answer: Parameters<typeof fakeHelper>[0]) {
  const helper = fakeHelper(answer);
  const vision = new MacVisionClient({ spawnFn: helper.spawnFn, helperPath: '/bin/pi-mac' });
  return { vision, ...helper };
}

describe('the captured wire parses as the contract says', () => {
  it('info carries the protocol version this client speaks', () => {
    const info = parseVisionInfo(real('info'));
    expect(info.version).toBe(VISION_PROTOCOL_VERSION);
    expect(info.lift).toBe(true);
    expect(info.ocr).toBe(true);
    expect(info.ocrLanguages).toContain('en-US');
    expect(info.cache.capacity).toBeGreaterThan(0);
  });

  it('lift on the cat: one instance, masks, cutouts, labels and cropped boxes', () => {
    const lift = parseVisionLift(real('liftCat'));
    expect(lift.width).toBe(960);
    expect(lift.height).toBe(640);
    expect(lift.count).toBe(1);
    const [cat] = lift.instances;
    expect(cat?.index).toBe(1);
    expect(cat?.bbox).toEqual({ x: 382, y: 166, width: 338, height: 380 });
    expect(cat?.maskPath).toMatch(/^\/out\/cat-[0-9a-f]{8}-mask-1\.png$/);
    expect(cat?.cutoutPath).toMatch(/-cutout-1-crop\.png$/);
    // A cropped cutout keeps its soft edge: its box holds the ≥50% bbox.
    expect(cat?.cutoutBox?.x).toBeLessThanOrEqual(cat?.bbox.x ?? 0);
    expect(lift.foreground?.maskPath).toMatch(/-mask-fg\.png$/);
    expect(lift.labelsPath).toMatch(/-labels\.png$/);
  });

  it('lift on the apples: three instances, numbered by Vision (not left to right)', () => {
    const lift = parseVisionLift(real('liftApples'));
    expect(lift.count).toBe(3);
    const byX = [...lift.instances].sort((a, b) => a.bbox.x - b.bbox.x).map((i) => i.index);
    expect(byX).toEqual([3, 2, 1]);
    // The default writes: a mask per instance and the union; no cutouts.
    for (const i of lift.instances) expect(i.cutoutPath).toBeUndefined();
    expect(lift.foreground?.maskPath).toBeDefined();
  });

  it('lift on a blank picture: nothing, and no foreground', () => {
    const lift = parseVisionLift(real('liftBlank'));
    expect(lift.count).toBe(0);
    expect(lift.instances).toEqual([]);
    expect(lift.foreground).toBeUndefined();
  });

  it('instanceAt: a hit, a miss and a snap', () => {
    const hit = parseVisionInstanceAt(real('instanceAtHit'));
    expect(hit).toMatchObject({ hit: true, index: 3, point: { x: 146, y: 363 } });
    expect(hit.instance?.maskPath).toMatch(/-mask-3\.png$/);

    const miss = parseVisionInstanceAt(real('instanceAtMiss'));
    expect(miss).toMatchObject({ hit: false, index: 0, count: 3 });
    expect(miss.instance).toBeUndefined();

    const snapped = parseVisionInstanceAt(real('instanceAtSnapped'));
    expect(snapped).toMatchObject({ hit: true, index: 2 });
    expect(snapped.distance).toBeGreaterThan(0);
    expect(snapped.distance).toBeLessThanOrEqual(20);
    expect(snapped.instance?.maskPath).toBeUndefined(); // write: []
  });

  it('ocr: lines, quads and word boxes, in picture pixels', () => {
    const ocr = parseVisionOcr(real('ocrSign'));
    expect(ocr.text).toBe('FRESH BRAED DAILY');
    expect(ocr.correction).toBe(false);
    const [line] = ocr.lines;
    expect(line?.quad).toHaveLength(4);
    expect(line?.words?.map((w) => w.text)).toEqual(['FRESH', 'BRAED', 'DAILY']);
    for (const w of line?.words ?? []) {
      expect(w.box?.x).toBeGreaterThanOrEqual(0);
      expect((w.box?.x ?? 0) + (w.box?.width ?? 0)).toBeLessThanOrEqual(ocr.width + 1);
    }
    expect(parseVisionOcr(real('ocrBlank')).lines).toEqual([]);
  });
});

describe('a helper that drifts from the contract fails loudly, with the field', () => {
  it('names a missing bbox width', () => {
    const bad = real('liftCat');
    const inst = (bad.instances as Array<{ bbox: Record<string, unknown> }>)[0];
    if (inst !== undefined) delete inst.bbox.width;
    expect(() => parseVisionLift(bad)).toThrow(VisionContractError);
    expect(() => parseVisionLift(bad)).toThrow('lift.instances[0].bbox.width is not a number');
  });

  it('refuses a count that disagrees with the instances', () => {
    const bad = { ...real('liftApples'), count: 2 };
    expect(() => parseVisionLift(bad)).toThrow('lift.count is 2 but 3 instances came back');
  });

  it('refuses a hit with no instance, and an instance with the wrong label', () => {
    const noInstance = real('instanceAtHit');
    delete noInstance.instance;
    expect(() => parseVisionInstanceAt(noInstance)).toThrow('is missing for a hit');

    const wrong = real('instanceAtHit');
    (wrong.instance as { index: number }).index = 1;
    expect(() => parseVisionInstanceAt(wrong)).toThrow('instanceAt.instance.index is not 3');
  });

  it('refuses a three-cornered quad and an unknown level', () => {
    const quad = real('ocrSign');
    (quad.lines as Array<{ quad: unknown[] }>)[0]?.quad.pop();
    expect(() => parseVisionOcr(quad)).toThrow('does not have 4 corners');
    expect(() => parseVisionOcr({ ...real('ocrSign'), level: 'turbo' })).toThrow(
      'ocr.level is "turbo"',
    );
  });

  it('refuses a result that is not an object at all', () => {
    expect(() => parseVisionLift(null)).toThrow('lift is not an object');
    expect(() => parseVisionOcr([1, 2])).toThrow('ocr is not an object');
  });
});

describe('MacVisionClient', () => {
  it('spawns the --vision-serve mode and sends typed params as plain JSON', async () => {
    const { vision, spawns, requests } = client(() => ({ ok: true, result: real('liftCat') }));
    const lift = await vision.lift({
      image: '/fixtures/cat.jpg',
      out: '/out',
      write: ['mask', 'cutout'],
      crop: true,
      prefix: undefined,
    });
    expect(lift.count).toBe(1);
    expect(spawns).toEqual([{ command: '/bin/pi-mac', args: ['--vision-serve'] }]);
    // undefined keys never reach the wire.
    expect(requests[0]).toEqual({
      method: 'lift',
      params: { image: '/fixtures/cat.jpg', out: '/out', write: ['mask', 'cutout'], crop: true },
    });
    vision.dispose();
  });

  it('routes every method to its helper verb', async () => {
    const answers: Record<string, string> = {
      info: 'info',
      lift: 'liftApples',
      instanceAt: 'instanceAtHit',
      ocr: 'ocrSign',
      warm: 'warm',
      forget: 'forget',
    };
    const { vision, requests, spawns } = client((req) => ({
      ok: true,
      result: real(answers[req.method] ?? 'info'),
    }));
    expect((await vision.info()).version).toBe(1);
    expect((await vision.lift({ image: '/p/apples.jpg' })).count).toBe(3);
    expect((await vision.instanceAt({ image: '/p/apples.jpg', x: 146, y: 363 })).index).toBe(3);
    expect((await vision.ocr({ image: '/p/sign.png', correction: false })).lines).toHaveLength(1);
    expect((await vision.warm()).text).toBe('Warm up');
    expect(await vision.forget()).toEqual({ dropped: 2, entries: 0 });
    await vision.forget('/p/apples.jpg');
    expect(requests.map((r) => r.method)).toEqual([
      'info',
      'lift',
      'instanceAt',
      'ocr',
      'warm',
      'forget',
      'forget',
    ]);
    expect(requests.at(-1)?.params).toEqual({ image: '/p/apples.jpg' });
    expect(spawns).toHaveLength(1); // one long-lived helper
    vision.dispose();
  });

  it("passes the helper's own error message through", async () => {
    const { vision } = client(() => REAL.errorOutside as Captured);
    await expect(vision.instanceAt({ image: '/p/apples.jpg', x: 5000, y: 1 })).rejects.toThrow(
      'point (5000.00, 1.00) is outside the 960×640 image',
    );
    vision.dispose();
  });

  it('refuses bad arguments before anything is spawned', async () => {
    const { vision, spawns } = client(() => ({ ok: true, result: {} }));
    await expect(vision.lift({ image: 'relative/cat.jpg' })).rejects.toThrow(VisionArgumentError);
    await expect(vision.lift({ image: 'relative/cat.jpg' })).rejects.toThrow(
      'image must be an absolute path',
    );
    await expect(vision.lift({ image: '' })).rejects.toThrow('image must be a file path');
    await expect(vision.instanceAt({ image: '/p/a.jpg', x: Number.NaN, y: 1 })).rejects.toThrow(
      'x must be a number',
    );
    await expect(vision.instanceAt({ image: '/p/a.jpg', x: -1, y: 1 })).rejects.toThrow(
      'x must be at least 0',
    );
    await expect(
      vision.instanceAt({ image: '/p/a.jpg', x: 1, y: 1, radius: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow('radius must be a number');
    await expect(
      // @ts-expect-error — an output lift does not know, on purpose
      vision.lift({ image: '/p/a.jpg', write: ['mask', 'thumbnail'] }),
    ).rejects.toThrow('unknown write option thumbnail');
    await expect(
      // @ts-expect-error — only accurate | fast exist
      vision.ocr({ image: '/p/a.jpg', level: 'turbo' }),
    ).rejects.toThrow('level must be "accurate" or "fast"');
    await expect(vision.ocr({ image: '/p/a.jpg', minConfidence: 2 })).rejects.toThrow(
      'minConfidence must be at most 1',
    );
    await expect(
      vision.ocr({ image: '/p/a.jpg', region: { x: 0, y: 0, width: 0, height: 10 } }),
    ).rejects.toThrow('region must have a positive size');
    await expect(vision.forget('rel.png')).rejects.toThrow('image must be an absolute path');
    expect(spawns).toHaveLength(0);
    vision.dispose();
  });

  it('refuses a relative output folder and fractional instance numbers', async () => {
    const { vision, spawns } = client(() => ({ ok: true, result: {} }));
    await expect(vision.lift({ image: '/p/a.jpg', out: 'masks' })).rejects.toThrow(
      'out must be an absolute path (got "masks")',
    );
    await expect(vision.instanceAt({ image: '/p/a.jpg', x: 1, y: 1, out: './m' })).rejects.toThrow(
      'out must be an absolute path',
    );
    // 1.9 would truncate to instance 1 inside the helper.
    await expect(vision.lift({ image: '/p/a.jpg', instances: [1.9] })).rejects.toThrow(
      'instances[] must be whole numbers (got 1.9)',
    );
    expect(spawns).toHaveLength(0);
    vision.dispose();
  });

  it('reads ~/ as the home folder, for the picture and the output folder', async () => {
    const { vision, requests } = client(() => ({ ok: true, result: real('liftApples') }));
    await vision.lift({ image: '~/pics/apples.jpg', out: '~/masks', write: [] });
    expect(requests[0]?.params).toEqual({
      image: path.join(homedir(), 'pics/apples.jpg'),
      out: path.join(homedir(), 'masks'),
      write: [],
    });
    vision.dispose();
  });

  it("reads the cache's bytes and budget, and tolerates a helper that omits them", () => {
    const info = parseVisionInfo(real('info'));
    expect(info.cache.budgetBytes).toBe(768 * 1_048_576);
    expect(info.cache.bytes).toBeGreaterThan(0);
    const older = parseVisionInfo({ ...real('info'), cache: { entries: 1, capacity: 2 } });
    expect(older.cache).toEqual({ entries: 1, capacity: 2 });
  });

  it('allows the slow first OCR of a new build by default', () => {
    expect(VISION_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('a request that times out', () => {
  /* The helper is single-threaded: a request that timed out is still running
     in it, and everything sent after would queue behind it. So a timeout
     restarts the helper and the next request reaches a fresh one. */
  it('restarts the helper so the next request is answered', async () => {
    const kills: string[] = [];
    let spawned = 0;
    const spawnFn: MacSpawnFn = () => {
      spawned += 1;
      const wedged = spawned === 1; // the first helper never answers
      const dataCbs: Array<(c: string) => void> = [];
      const child: MacChildProcess = {
        pid: 100 + spawned,
        stdin: {
          write: (data, cb) => {
            cb?.(null);
            if (wedged) return;
            const req = JSON.parse(data.trim()) as { id: number };
            queueMicrotask(() => {
              for (const f of dataCbs) {
                f(`${JSON.stringify({ id: req.id, ok: true, result: real('info') })}\n`);
              }
            });
          },
          end: () => undefined,
          on: () => undefined,
        },
        stdout: { on: (_e, cb) => dataCbs.push(cb as (c: string) => void) },
        stderr: { on: () => undefined },
        on: () => undefined,
        kill: (signal) => {
          kills.push(`${100 + spawned}:${signal ?? ''}`);
        },
      };
      return child;
    };
    const vision = new MacVisionClient({
      spawnFn,
      helperPath: '/bin/pi-mac',
      requestTimeoutMs: 30,
    });
    await expect(vision.info()).rejects.toThrow('timed out');
    expect(kills).toEqual(['101:SIGTERM']); // the wedged helper was stopped
    await expect(vision.info()).resolves.toMatchObject({ version: 1 });
    expect(spawned).toBe(2);
    vision.dispose();
  });
});
