/**
 * The Mac Vision executor, against a fake helper that answers with REAL
 * responses captured from `pi-mac --vision-serve` on the fixture pictures
 * (packages/pi-mac/src/__fixtures__/vision-responses.json).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseVisionForget,
  parseVisionInfo,
  parseVisionInstanceAt,
  parseVisionLift,
  parseVisionOcr,
  parseVisionWarm,
} from '@pi-desktop/pi-mac';
import { afterEach, describe, expect, it } from 'vitest';
import { MacVisionExecutor, pruneVisionOutputs, type VisionClientLike } from './mac-vision';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(
  readFileSync(
    path.join(here, '../../../../packages/pi-mac/src/__fixtures__/vision-responses.json'),
    'utf8',
  ),
) as Record<string, { result?: unknown }>;
const real = (name: string): unknown => structuredClone(REAL[name]?.result);

interface Call {
  method: string;
  params?: unknown;
}

function fakeClient(overrides: Partial<Record<keyof VisionClientLike, unknown>> = {}) {
  const calls: Call[] = [];
  let disposed = 0;
  const answer = <T>(method: string, params: unknown, fallback: () => T): Promise<T> => {
    calls.push({ method, params });
    const o = overrides[method as keyof VisionClientLike];
    if (o instanceof Error) return Promise.reject(o);
    if (typeof o === 'function') return Promise.resolve((o as (p: unknown) => T)(params));
    return Promise.resolve(fallback());
  };
  const client: VisionClientLike = {
    info: () => answer('info', undefined, () => parseVisionInfo(real('info'))),
    lift: (p) => answer('lift', p, () => parseVisionLift(real('liftApples'))),
    instanceAt: (p) => answer('instanceAt', p, () => parseVisionInstanceAt(real('instanceAtHit'))),
    ocr: (p) => answer('ocr', p, () => parseVisionOcr(real('ocrSign'))),
    warm: () => answer('warm', undefined, () => parseVisionWarm(real('warm'))),
    forget: (image) => answer('forget', image, () => parseVisionForget(real('forget'))),
    dispose: () => {
      disposed++;
    },
  };
  return { client, calls, disposedCount: () => disposed };
}

/** A clock the test turns by hand. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    fireAll: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    count: () => pending.size,
  };
}

function executor(
  fake = fakeClient(),
  opts: Partial<ConstructorParameters<typeof MacVisionExecutor>[0]> = {},
) {
  const timers = manualTimers();
  let created = 0;
  const exec = new MacVisionExecutor({
    helperPath: '/app/pi-mac',
    outDir: '/cache/vision',
    platform: 'darwin',
    fileExists: () => true,
    createClient: () => {
      created++;
      return fake.client;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...opts,
  });
  return { exec, fake, timers, created: () => created };
}

describe('available()', () => {
  it('is false off macOS or without the helper, and never starts one', async () => {
    const off = executor(undefined, { platform: 'linux' });
    expect(await off.exec.available()).toBe(false);
    const missing = executor(undefined, { fileExists: () => false });
    expect(await missing.exec.available()).toBe(false);
    expect(off.created() + missing.created()).toBe(0);
  });

  it('asks the helper once and accepts only the protocol it speaks', async () => {
    const { exec, fake } = executor();
    expect(await exec.available()).toBe(true);
    expect(await exec.available()).toBe(true);
    expect(fake.calls.filter((c) => c.method === 'info')).toHaveLength(1);

    const old = fakeClient({ info: () => ({ ...parseVisionInfo(real('info')), version: 0 }) });
    expect(await executor(old).exec.available()).toBe(false);
  });

  it('treats a failed probe as "not now", and asks again next time', async () => {
    let fail = true;
    const flaky = fakeClient({
      info: () => {
        if (fail) throw new Error('spawn ENOENT');
        return parseVisionInfo(real('info'));
      },
    });
    const { exec } = executor(flaky);
    expect(await exec.available()).toBe(false);
    fail = false;
    expect(await exec.available()).toBe(true);
  });
});

describe('segmentAt()', () => {
  it('turns a tap on one of several objects into two proposals, smallest first', async () => {
    const { exec, fake } = executor();
    const seg = await exec.segmentAt('/doc/apples.jpg', { x: 146, y: 363 }, { radius: 6 });
    expect(seg).toMatchObject({ engine: 'apple-vision', hit: true, index: 3, width: 960 });
    expect(seg.proposals.map((p) => p.id)).toEqual(['vision:instance:3', 'vision:foreground']);
    expect(seg.proposals[0]?.area).toBeLessThan(seg.proposals[1]?.area ?? 0);
    expect(seg.proposals[0]?.maskPath).toMatch(/-mask-3\.png$/);
    expect(fake.calls[0]).toEqual({
      method: 'instanceAt',
      params: {
        image: '/doc/apples.jpg',
        x: 146,
        y: 363,
        radius: 6,
        out: '/cache/vision',
        write: ['mask'],
      },
    });
    expect(fake.calls[1]).toMatchObject({
      method: 'lift',
      params: { write: ['foregroundMask'], out: '/cache/vision' },
    });
  });

  it('offers only the object itself when it is the only one', async () => {
    const single = parseVisionInstanceAt(real('instanceAtHit'));
    const fake = fakeClient({ instanceAt: () => ({ ...single, count: 1 }) });
    const { exec } = executor(fake);
    const seg = await exec.segmentAt('/doc/cat.jpg', { x: 600, y: 240 });
    expect(seg.proposals.map((p) => p.kind)).toEqual(['instance']);
    expect(fake.calls.map((c) => c.method)).toEqual(['instanceAt']);
  });

  it('reports a miss with no proposals, so the router can try the next engine', async () => {
    const fake = fakeClient({ instanceAt: () => parseVisionInstanceAt(real('instanceAtMiss')) });
    const { exec } = executor(fake);
    const seg = await exec.segmentAt('/doc/apples.jpg', { x: 470, y: 100 });
    expect(seg).toMatchObject({ hit: false, index: 0, proposals: [] });
    expect(fake.calls.map((c) => c.method)).toEqual(['instanceAt']);
  });

  it('carries the snap distance, and writes masks where the caller says', async () => {
    const fake = fakeClient({
      instanceAt: () => ({
        ...parseVisionInstanceAt(real('instanceAtHit')),
        distance: 11,
        count: 1,
      }),
    });
    const { exec } = executor(fake);
    const seg = await exec.segmentAt('/doc/a.jpg', { x: 1, y: 2 }, { outDir: '/doc/masks' });
    expect(seg.distance).toBe(11);
    expect(fake.calls[0]).toMatchObject({ params: { out: '/doc/masks' } });
  });
});

describe('the size limit', () => {
  it('passes a configured maxPixels to every analysis', async () => {
    const { exec, fake } = executor(undefined, { maxPixels: 24_000_000 });
    await exec.segmentAt('/doc/apples.jpg', { x: 146, y: 363 });
    await exec.matte('/doc/cat.jpg');
    await exec.instances('/doc/apples.jpg');
    await exec.ocr('/doc/sign.png');
    for (const call of fake.calls) {
      expect(call.params, call.method).toMatchObject({ maxPixels: 24_000_000 });
    }
    expect(fake.calls).toHaveLength(5); // instanceAt + the foreground lift + 3
  });
});

describe('matte()', () => {
  it('returns the foreground cutout and mask', async () => {
    const fake = fakeClient({ lift: () => parseVisionLift(real('liftCat')) });
    const { exec } = executor(fake);
    const m = await exec.matte('/doc/cat.jpg', { crop: true });
    expect(m).toMatchObject({ engine: 'apple-vision', found: true, width: 960, height: 640 });
    expect(m.cutoutPath).toMatch(/-cutout-fg-crop\.png$/);
    expect(m.maskPath).toMatch(/-mask-fg\.png$/);
    expect(m.cutoutBox).toBeDefined();
    expect(fake.calls[0]).toMatchObject({
      params: { write: ['foregroundMask', 'foregroundCutout'], crop: true },
    });
  });

  it('says so when there is nothing to lift (BiRefNet is next)', async () => {
    const fake = fakeClient({ lift: () => parseVisionLift(real('liftBlank')) });
    const m = await executor(fake).exec.matte('/doc/blank.png');
    expect(m).toEqual({ engine: 'apple-vision', found: false, width: 320, height: 240 });
  });
});

describe('ocr() and the rest', () => {
  it('passes OCR options through with the picture', async () => {
    const { exec, fake } = executor();
    const r = await exec.ocr('/doc/sign.png', { correction: false, level: 'accurate' });
    expect(r.text).toBe('FRESH BRAED DAILY');
    expect(fake.calls[0]).toEqual({
      method: 'ocr',
      params: { correction: false, level: 'accurate', image: '/doc/sign.png' },
    });
  });

  it('lists every object with masks and a label map', async () => {
    const { exec, fake } = executor();
    expect((await exec.instances('/doc/apples.jpg')).count).toBe(3);
    expect(fake.calls[0]).toMatchObject({ params: { write: ['mask', 'labels'] } });
  });

  it('does not start a helper just to forget', async () => {
    const { exec, created } = executor();
    await exec.forget('/doc/a.jpg');
    expect(created()).toBe(0);
    await exec.warm();
    await exec.forget('/doc/a.jpg');
    expect(created()).toBe(1);
  });

  it('surfaces the helper error unchanged', async () => {
    const fake = fakeClient({ lift: new Error('pi-mac: image not found: /doc/nope.png') });
    await expect(executor(fake).exec.matte('/doc/nope.png')).rejects.toThrow('image not found');
  });
});

describe('the default output folder is scratch', () => {
  const DAY = 24 * 60 * 60_000;
  const NOW = Date.UTC(2026, 8, 23, 12);
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A folder holding `files` (name → age in ms at NOW). */
  function folder(files: Record<string, number>): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mac-vision-prune-'));
    dirs.push(dir);
    for (const [name, age] of Object.entries(files)) {
      const file = path.join(dir, name);
      if (name.endsWith('/')) mkdirSync(file);
      else writeFileSync(file, 'x');
      const t = (NOW - age) / 1000;
      utimesSync(file, t, t);
    }
    return dir;
  }
  const names = (dir: string) => readdirSync(dir).sort();

  it('deletes only helper outputs older than the cutoff', async () => {
    const dir = folder({
      'cat-1a2b3c4d-mask-1.png': 2 * DAY,
      '.cat-1a2b3c4d-mask-1.png.4242.tmp': 2 * DAY, // an interrupted write
      'apples-9f8e7d6c-mask-fg.png': 60_000, // written a minute ago
      'notes.txt': 2 * DAY, // not something the helper writes
      'nested/': 2 * DAY,
    });
    expect(await pruneVisionOutputs(dir, NOW - DAY)).toBe(2);
    expect(names(dir)).toEqual(['apples-9f8e7d6c-mask-fg.png', 'nested', 'notes.txt']);
  });

  it('is quiet about a folder that does not exist yet', async () => {
    expect(await pruneVisionOutputs('/nonexistent/bobble-vision', NOW)).toBe(0);
  });

  it('prunes before each new helper writes, and never a folder an op names', async () => {
    const out = folder({ 'old-mask-1.png': 2 * DAY, 'recent-mask-1.png': 60_000 });
    const docMasks = folder({ 'kept-by-the-document.png': 30 * DAY });
    const seenAtFirstOp: string[][] = [];
    const fake = fakeClient({
      warm: () => {
        seenAtFirstOp.push(names(out));
        return parseVisionWarm(real('warm'));
      },
    });
    const { exec, timers } = executor(fake, { outDir: out, now: () => NOW });
    await exec.warm();
    expect(seenAtFirstOp).toEqual([['recent-mask-1.png']]); // gone BEFORE the op ran
    await exec.segmentAt('/doc/apples.jpg', { x: 146, y: 363 }, { outDir: docMasks });
    expect(names(docMasks)).toEqual(['kept-by-the-document.png']);

    // The helper idles out; the next one prunes again.
    timers.fireAll();
    writeFileSync(path.join(out, 'stale-mask-2.png'), 'x');
    const t = (NOW - 3 * DAY) / 1000;
    utimesSync(path.join(out, 'stale-mask-2.png'), t, t);
    await exec.ocr('/doc/sign.png');
    expect(existsSync(path.join(out, 'stale-mask-2.png'))).toBe(false);
    expect(names(out)).toEqual(['recent-mask-1.png']);
  });

  it('can be switched off', async () => {
    const out = folder({ 'old-mask-1.png': 30 * DAY });
    const { exec } = executor(fakeClient(), { outDir: out, now: () => NOW, pruneAfterMs: 0 });
    await exec.warm();
    expect(names(out)).toEqual(['old-mask-1.png']);
  });
});

describe('the helper lifetime', () => {
  it('stops the helper after the idle time, and starts a new one on the next op', async () => {
    const { exec, fake, timers, created } = executor();
    await exec.warm();
    expect(exec.running).toBe(true);
    expect(timers.count()).toBe(1);
    timers.fireAll();
    expect(exec.running).toBe(false);
    expect(fake.disposedCount()).toBe(1);
    await exec.ocr('/doc/sign.png');
    expect(created()).toBe(2);
  });

  it('never stops a helper that is mid-request', async () => {
    let release: () => void = () => undefined;
    const slow = fakeClient({
      ocr: () => new Promise((r) => (release = () => r(parseVisionOcr(real('ocrSign'))))),
    });
    const { exec, timers } = executor(slow);
    await exec.warm(); // arms the idle timer
    const pending = exec.ocr('/doc/sign.png'); // cancels it while running
    expect(timers.count()).toBe(0);
    release();
    await pending;
    expect(timers.count()).toBe(1);
    expect(exec.running).toBe(true);
  });

  it('refuses work after dispose', async () => {
    const { exec, fake } = executor();
    await exec.warm();
    exec.dispose();
    expect(fake.disposedCount()).toBe(1);
    await expect(exec.warm()).rejects.toThrow('disposed');
  });
});
