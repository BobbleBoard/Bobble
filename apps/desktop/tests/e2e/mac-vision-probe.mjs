#!/usr/bin/env node
/**
 * mac-vision-probe — `pi-mac --vision` (MAC-01) on the fixture pictures.
 *
 *   node scripts/with-lock.mjs probe -- node tests/e2e/mac-vision-probe.mjs
 *
 * No app is launched and no window can open: this drives the helper binary
 * directly over its NDJSON pipe (the "node script on fixtures" of the studios
 * plan), then checks everything a person would otherwise have to take on
 * faith:
 *
 *   - SIGNED WITH THE STABLE IDENTITY: the helper's designated requirement is
 *     the certificate one ship-local.sh gives the bundled helper (a cdhash
 *     requirement would silently drop computer-use grants on every ship —
 *     memory pi-desktop-tcc-signing). Signs the dev build when it is not.
 *   - LIFT: the cat is instance 1 with a box matching one measured WITHOUT
 *     Vision (fixtures.json); its mask, cutout and label map are right pixel
 *     for pixel where it matters — the cutout keeps the photo's own values
 *     wherever it is opaque.
 *   - INSTANCE AT A POINT: a tap on each of three apples names three different
 *     instances; the wall and table are background; a near miss snaps only
 *     with a radius.
 *   - ORIENTATION: an EXIF-rotated copy answers in display coordinates.
 *   - OCR: every poster line exactly, in order; a misspelling read literally;
 *     a region read returns only its lines, at picture (not crop) coordinates.
 *   - ONE-SHOT: `pi-mac --vision <method> [json|path]` answers one line with the
 *     right exit code (0 ok, 1 error, 2 usage).
 *   - NO PROMPT, NO DOCK TILE, NO FOCUS: tccd's own log shows only preflight
 *     (non-prompting) requests for the helper, no permission prompt and no
 *     accessibility warning during the run; the helper is never registered
 *     with LaunchServices (absent from `lsappinfo list`); the frontmost app
 *     never becomes ours.
 *   - NO ORPHAN: a helper whose parent is SIGKILLed exits by itself.
 *
 * Writes verification pictures (masks tinted over the photos, OCR boxes over
 * the poster, the cutout on a checkerboard) and report.json to SHOT_DIR —
 * LOOK at them; the numbers alone are not the claim.
 *
 * Env: SHOT_DIR (default <tmp>/mac-vision-probe); PI_MAC_HELPER_PATH to test a
 * particular binary (never re-signed by this probe).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontmostApp } from './_focus.mjs';
import { cropPng, decodePng, encodePng } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const PKG = path.join(REPO, 'packages/pi-mac');
const FIXTURES = path.join(PKG, 'fixtures/vision');
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'mac-vision-probe');
const CUSTOM_HELPER = process.env.PI_MAC_HELPER_PATH;
const HELPER = CUSTOM_HELPER ?? path.join(PKG, 'swift/.build/release/pi-mac');
const KEYCHAIN = path.join(homedir(), 'Library/Keychains/bobble-signing.keychain-db');
const INSTALLED =
  '/Applications/Bobble.app/Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/pi-mac/swift/.build/release/pi-mac';
/** A process that would be the probe taking the screen if it came to the front. */
const OURS = new Set(['pi-mac', 'Electron', 'Bobble']);

if (process.platform !== 'darwin') {
  console.log('mac-vision-probe: macOS only — skipped');
  process.exit(0);
}

mkdirSync(SHOT_DIR, { recursive: true });
const failures = [];
const report = { helper: HELPER, steps: {}, timings: {} };
function check(ok, message) {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  return ok;
}
function step(name) {
  console.log(`\n── ${name}`);
}

// ── the helper binary: built and stably signed ──────────────────────────────

function requirementOf(bin) {
  const r = spawnSync('codesign', ['-d', '-r-', bin], { encoding: 'utf8' });
  return /designated => (.*)/.exec(`${r.stdout}${r.stderr}`)?.[1]?.trim() ?? '(unsigned)';
}

step('helper build and signature');
if (!existsSync(HELPER)) {
  if (CUSTOM_HELPER) {
    console.error(`mac-vision-probe: no helper at ${HELPER}`);
    process.exit(1);
  }
  console.log('  building pi-mac (swift build -c release)…');
  const b = spawnSync(
    'swift',
    ['build', '-c', 'release', '--package-path', path.join(PKG, 'swift')],
    {
      stdio: 'inherit',
    },
  );
  if (b.status !== 0) process.exit(1);
}
const stableIdentity = existsSync(KEYCHAIN);
if (stableIdentity && !CUSTOM_HELPER && !requirementOf(HELPER).includes('certificate leaf')) {
  console.log('  signing the dev build with the stable identity (scripts/build-signed.sh)…');
  const s = spawnSync('bash', [path.join(PKG, 'scripts/build-signed.sh'), '--no-build'], {
    stdio: 'inherit',
  });
  if (s.status !== 0) process.exit(1);
}
const requirement = requirementOf(HELPER);
const installedRequirement = existsSync(INSTALLED) ? requirementOf(INSTALLED) : null;
report.signing = { requirement, installedRequirement, stableIdentityOnThisMac: stableIdentity };
console.log(`  requirement: ${requirement}`);
if (stableIdentity) {
  check(
    requirement.includes('certificate leaf') && !requirement.includes('cdhash'),
    'the helper is signed with the stable identity (certificate requirement, not a cdhash)',
  );
  if (installedRequirement !== null) {
    check(
      requirement === installedRequirement,
      'its requirement is the one the installed Bobble helper carries',
    );
  }
} else {
  console.log('  (no stable signing identity on this Mac — signature not asserted)');
}

// ── fixtures, copied out of the repo (as the editor's ~/Bobble/studio) ──────

const manifest = JSON.parse(readFileSync(path.join(FIXTURES, 'fixtures.json'), 'utf8')).files;
const work = mkdtempSync(path.join(tmpdir(), 'mac-vision-probe-'));
const out = path.join(work, 'out');
mkdirSync(out);
for (const name of Object.keys(manifest))
  copyFileSync(path.join(FIXTURES, name), path.join(work, name));
const fx = (name) => path.join(work, name);

/** Decode any picture ImageIO reads, through sips, as raw 8-bit pixels. */
function pixelsOf(file) {
  const png = path.join(work, `${path.basename(file)}.decoded.png`);
  const r = spawnSync('sips', ['-s', 'format', 'png', file, '--out', png], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sips could not decode ${file}`);
  return decodePng(readFileSync(png));
}
const readPng = (file) => decodePng(readFileSync(file));

// ── the NDJSON client ────────────────────────────────────────────────────────

function startHelper(env = {}) {
  const child = spawn(HELPER, ['--vision-serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let buf = '';
  let nextId = 0;
  const pending = new Map();
  const stderr = [];
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === '') continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  child.stderr.on('data', (d) => stderr.push(String(d)));
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  function call(method, params = {}, timeoutMs = 60_000) {
    nextId += 1;
    const id = nextId;
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve({ ...msg, roundTripMs: Math.round(performance.now() - t0) });
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  return { child, call, stderr, exited };
}

// ── pixel helpers for the verification pictures ─────────────────────────────

function rgbaOf(img) {
  const { width, height, channels, data } = img;
  const outBuf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const grey = channels <= 2;
    outBuf[i * 4] = data[s];
    outBuf[i * 4 + 1] = grey ? data[s] : data[s + 1];
    outBuf[i * 4 + 2] = grey ? data[s] : data[s + 2];
    outBuf[i * 4 + 3] = channels === 4 ? data[s + 3] : channels === 2 ? data[s + 1] : 255;
  }
  return { width, height, channels: 4, data: outBuf };
}
function tint(img, mask, [r, g, b], strength) {
  for (let i = 0; i < img.width * img.height; i += 1) {
    const a = (mask[i] / 255) * strength;
    if (a === 0) continue;
    img.data[i * 4] = Math.round(img.data[i * 4] * (1 - a) + r * a);
    img.data[i * 4 + 1] = Math.round(img.data[i * 4 + 1] * (1 - a) + g * a);
    img.data[i * 4 + 2] = Math.round(img.data[i * 4 + 2] * (1 - a) + b * a);
  }
}
function put(img, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = 255;
}
function rect(img, box, colour, thickness = 2) {
  for (let t = 0; t < thickness; t += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      put(img, x, box.y + t, colour);
      put(img, x, box.y + box.height - 1 - t, colour);
    }
    for (let y = box.y; y < box.y + box.height; y += 1) {
      put(img, box.x + t, y, colour);
      put(img, box.x + box.width - 1 - t, y, colour);
    }
  }
}
function dot(img, cx, cy, radius, colour) {
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y <= radius * radius) put(img, cx + x, cy + y, colour);
    }
  }
}
function ring(img, cx, cy, radius, colour) {
  for (let a = 0; a < 720; a += 1) {
    const t = (a / 720) * 2 * Math.PI;
    for (const d of [0, 1])
      put(img, cx + (radius + d) * Math.cos(t), cy + (radius + d) * Math.sin(t), colour);
  }
}
function checkerUnder(cutout) {
  const img = {
    width: cutout.width,
    height: cutout.height,
    channels: 4,
    data: Buffer.alloc(cutout.width * cutout.height * 4),
  };
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const i = y * img.width + x;
      const bg = ((x >> 4) + (y >> 4)) % 2 === 0 ? 236 : 196;
      const a = cutout.data[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c += 1)
        img.data[i * 4 + c] = Math.round(cutout.data[i * 4 + c] * a + bg * (1 - a));
      img.data[i * 4 + 3] = 255;
    }
  }
  return img;
}
function save(name, img) {
  const file = path.join(SHOT_DIR, name);
  writeFileSync(file, encodePng(img));
  return file;
}
function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.width * a.height + b.width * b.height - inter);
}
const at = (img, x, y) => img.data[(y * img.width + x) * img.channels];

// ── the run ──────────────────────────────────────────────────────────────────

const WHITE = [255, 255, 255];
const ORANGE = [255, 138, 0];
const GREEN = [0, 200, 90];
const RED = [230, 40, 40];
const YELLOW = [255, 220, 0];
const TEAL = [0, 170, 190];
const PALETTE = [TEAL, [255, 90, 40], [70, 120, 255], [240, 200, 0]];

const logStart = new Date(Date.now() - 1500);
const before = frontmostApp();
const frontSamples = [];
const sampleFront = (label) => frontSamples.push({ label, app: frontmostApp() });
report.focus = { before };

const helper = startHelper();
const helperPids = [helper.child.pid];

try {
  step('protocol, dock and warm-up');
  const info = await helper.call('info');
  check(info.ok && info.result.version === 1, `protocol version 1 (os ${info.result?.os})`);
  const apps = spawnSync('lsappinfo', ['list'], { encoding: 'utf8' }).stdout ?? '';
  check(apps.includes('"Finder"'), 'lsappinfo lists registered apps (the dock check can see)');
  check(
    !new RegExp(`pid = ${helper.child.pid}\\b`).test(apps),
    `the helper (pid ${helper.child.pid}) is not registered as an app — no dock tile is possible`,
  );
  const warm = await helper.call('warm', {}, 180_000);
  check(
    warm.ok && warm.result.text === 'Warm up',
    `warm-up read its own picture ("${warm.result?.text}")`,
  );
  report.timings.warm = warm.result;
  console.log(
    `  warm: lift ${warm.result?.liftMs} ms, accurate OCR ${warm.result?.ocrMs} ms (a new build prepares its text models once)`,
  );
  sampleFront('after warm-up');

  // ── the cat: one subject ──────────────────────────────────────────────────
  step('lift — cat.jpg (one subject)');
  const catWant = manifest['cat.jpg'].subject;
  const cat = await helper.call('lift', {
    image: fx('cat.jpg'),
    out,
    write: ['mask', 'cutout', 'foregroundMask', 'foregroundCutout', 'labels'],
  });
  check(cat.ok, `lift answered (${cat.error ?? 'ok'})`);
  const catInst = cat.result.instances[0];
  check(
    cat.result.count === 1 && catInst?.index === 1,
    'exactly one instance, and it is instance 1',
  );
  const catIoU = iou(catInst.bbox, catWant.box);
  check(
    catIoU >= catWant.minIoU,
    `bbox ${JSON.stringify(catInst.bbox)} vs measured ${JSON.stringify(catWant.box)}: IoU ${catIoU.toFixed(3)} ≥ ${catWant.minIoU}`,
  );
  report.timings.catLift = {
    analysisMs: cat.result.analysisMs,
    ms: cat.result.ms,
    roundTripMs: cat.roundTripMs,
  };
  const catSrc = pixelsOf(fx('cat.jpg'));
  const catMask = readPng(catInst.maskPath);
  const catLabels = readPng(cat.result.labelsPath);
  const catCut = readPng(catInst.cutoutPath);
  check(
    catMask.width === 960 && catMask.height === 640 && catMask.channels === 1,
    'mask is 960×640, one channel',
  );
  check(
    catCut.width === 960 && catCut.height === 640 && catCut.channels === 4,
    'cutout is 960×640 RGBA',
  );
  for (const [x, y] of catWant.inside) {
    check(
      at(catMask, x, y) === 255 &&
        at(catLabels, x, y) === 1 &&
        catCut.data[(y * 960 + x) * 4 + 3] === 255,
      `(${x}, ${y}) on the cat: mask 255, label 1, cutout opaque`,
    );
  }
  for (const [x, y] of catWant.outside) {
    check(
      at(catMask, x, y) === 0 &&
        at(catLabels, x, y) === 0 &&
        catCut.data[(y * 960 + x) * 4 + 3] === 0,
      `(${x}, ${y}) off the cat: mask 0, label 0, cutout clear`,
    );
  }
  // The cutout keeps the photo's own pixels wherever it is opaque.
  let opaque = 0;
  let differ = 0;
  let maxDelta = 0;
  for (let i = 0; i < 960 * 640; i += 1) {
    if (catCut.data[i * 4 + 3] !== 255) continue;
    opaque += 1;
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(catCut.data[i * 4 + c] - catSrc.data[i * catSrc.channels + c]);
      if (d > 0) differ += 1;
      if (d > maxDelta) maxDelta = d;
    }
  }
  check(
    opaque > 50_000 && differ === 0,
    `cutout RGB equals the photo on all ${opaque} opaque pixels (max Δ ${maxDelta})`,
  );
  report.steps.cutoutIdentity = { opaque, differingChannels: differ, maxDelta };
  const catView = rgbaOf(catSrc);
  tint(catView, catMask.data, TEAL, 0.5);
  rect(catView, catWant.box, WHITE, 2);
  rect(catView, catInst.bbox, ORANGE, 2);
  for (const [x, y] of catWant.inside) dot(catView, x, y, 6, GREEN);
  for (const [x, y] of catWant.outside) dot(catView, x, y, 6, RED);
  save('cat-lift.png', catView);
  save('cat-cutout-on-checker.png', checkerUnder(catCut));
  save('cat-mask.png', catMask);
  sampleFront('after cat');

  // ── the apples: three instances, taps ────────────────────────────────────
  step('instanceAt — apples.jpg (three objects)');
  const apWant = manifest['apples.jpg'];
  const apLift = await helper.call('lift', {
    image: fx('apples.jpg'),
    out,
    write: ['mask', 'labels'],
  });
  check(apLift.ok && apLift.result.count === 3, `three instances (${apLift.result?.count})`);
  const apLabels = readPng(apLift.result.labelsPath);
  const apSrc = pixelsOf(fx('apples.jpg'));
  const apView = rgbaOf(apSrc);
  const indices = new Set();
  for (const apple of apWant.apples) {
    const [x, y] = apple.tap;
    const hit = await helper.call('instanceAt', { image: fx('apples.jpg'), x, y, out });
    const inst = hit.result?.instance;
    check(
      hit.ok && hit.result.hit === true && inst !== undefined,
      `tap on the ${apple.name} apple (${x}, ${y}) hits instance ${hit.result?.index}`,
    );
    if (inst === undefined) continue;
    indices.add(hit.result.index);
    const score = iou(inst.bbox, apple.box);
    check(
      score >= apWant.minIoU,
      `  its bbox matches the measured ${apple.name} apple: IoU ${score.toFixed(3)}`,
    );
    check(
      at(apLabels, x, y) === hit.result.index,
      `  the label map agrees (${at(apLabels, x, y)})`,
    );
    report.timings[`tap-${apple.name}`] = {
      ms: hit.result.ms,
      cached: hit.result.cached,
      roundTripMs: hit.roundTripMs,
    };
    const colour = PALETTE[hit.result.index % PALETTE.length];
    tint(apView, readPng(inst.maskPath).data, colour, 0.55);
    rect(apView, apple.box, WHITE, 2);
    rect(apView, inst.bbox, colour, 2);
    dot(apView, x, y, 7, WHITE);
    dot(apView, x, y, 4, [0, 0, 0]);
  }
  check(indices.size === 3, `three taps, three different instances (${[...indices].join(', ')})`);
  for (const [x, y] of apWant.background) {
    const bg = await helper.call('instanceAt', { image: fx('apples.jpg'), x, y });
    check(bg.ok && bg.result.hit === false && bg.result.index === 0, `(${x}, ${y}) is background`);
    dot(apView, x, y, 6, RED);
  }
  const [nx, ny] = apWant.nearMiss.point;
  const miss = await helper.call('instanceAt', {
    image: fx('apples.jpg'),
    x: nx,
    y: ny,
    write: [],
  });
  const snap = await helper.call('instanceAt', {
    image: fx('apples.jpg'),
    x: nx,
    y: ny,
    radius: apWant.nearMiss.radius,
    write: [],
  });
  const middle = apWant.apples.find((a) => a.name === apWant.nearMiss.apple);
  check(miss.result.hit === false, `near miss (${nx}, ${ny}) without a radius: background`);
  check(
    snap.result.hit === true && iou(snap.result.instance.bbox, middle.box) >= apWant.minIoU,
    `…with radius ${apWant.nearMiss.radius}: the ${middle.name} apple, snapped ${snap.result.distance} px`,
  );
  ring(apView, nx, ny, apWant.nearMiss.radius, YELLOW);
  dot(apView, nx, ny, 4, YELLOW);
  save('apples-instances.png', apView);
  sampleFront('after apples');

  // ── orientation ──────────────────────────────────────────────────────────
  step('orientation — cat-rotated.jpg (EXIF 6)');
  const rot = await helper.call('lift', { image: fx('cat-rotated.jpg'), out, write: ['mask'] });
  check(rot.ok && rot.result.orientation === 6, 'the EXIF orientation (6) was read and applied');
  check(
    rot.result.width === 960 && rot.result.height === 640,
    `displayed size 960×640 (stored 640×960): ${rot.result.width}×${rot.result.height}`,
  );
  const rotIoU = iou(rot.result.instances[0].bbox, catInst.bbox);
  check(rotIoU >= 0.95, `its cat lands where the upright cat is: IoU ${rotIoU.toFixed(3)}`);
  const rotView = rgbaOf(catSrc);
  tint(rotView, readPng(rot.result.instances[0].maskPath).data, [255, 90, 40], 0.5);
  rect(rotView, rot.result.instances[0].bbox, ORANGE, 2);
  save('cat-rotated-mask-over-upright.png', rotView);

  // ── OCR ──────────────────────────────────────────────────────────────────
  step('ocr — poster.png and sign-misspelt.png');
  const poster = await helper.call('ocr', { image: fx('poster.png') });
  const gotLines = poster.result?.lines.map((l) => l.text) ?? [];
  check(
    JSON.stringify(gotLines) === JSON.stringify(manifest['poster.png'].lines),
    `every poster line, exactly and in order (${gotLines.length}/${manifest['poster.png'].lines.length})`,
  );
  if (JSON.stringify(gotLines) !== JSON.stringify(manifest['poster.png'].lines))
    console.log('   got:', gotLines);
  report.timings.posterOcr = { ms: poster.result?.ms, roundTripMs: poster.roundTripMs };
  const posterView = rgbaOf(readPng(fx('poster.png')));
  for (const line of poster.result.lines) {
    rect(posterView, roundBox(line.box), GREEN, 3);
    for (const w of line.words ?? []) if (w.box) rect(posterView, roundBox(w.box), ORANGE, 1);
  }
  save('poster-ocr.png', posterView);

  // A region is read as its own crop and mapped back to PICTURE pixels (top-left
  // origin): the band holding the last three lines, inset from the left edge so
  // x is offset too.
  //   - EXACT: the same crop saved as its own file and read whole gives the
  //     same lines and word boxes once shifted by the region's origin — to the
  //     hundredth of a pixel. Crop coordinates, a flip or a scale would all
  //     fail this.
  //   - ROUGH: against the FULL read the boxes only overlap. Vision boxes the
  //     crop's text differently (MEASURED: "Friday 12 June…" is 40 px tall on
  //     the whole poster, 61.6 px on the crop — the same in both region and
  //     file reads), so the full read is an overlap check, not an equality.
  const band = { x: 40, y: 690, width: 820, height: 450 };
  const inBand = (poster.result?.lines ?? []).filter(
    (l) => l.box.y >= band.y && l.box.y + l.box.height <= band.y + band.height,
  );
  const part = await helper.call('ocr', { image: fx('poster.png'), region: band });
  const partLines = part.result?.lines ?? [];
  check(
    part.ok &&
      inBand.length === 3 &&
      JSON.stringify(partLines.map((l) => l.text)) === JSON.stringify(inBand.map((l) => l.text)),
    `a region read returns just the lines inside it (${partLines.map((l) => `"${l.text}"`).join(', ')})`,
  );
  const bandFile = path.join(work, 'poster-band.png');
  writeFileSync(bandFile, cropPng(readFileSync(fx('poster.png')), band));
  const whole = await helper.call('ocr', { image: bandFile });
  const wholeLines = whole.result?.lines ?? [];
  const shifted = (b) => ({ ...b, x: b.x + band.x, y: b.y + band.y });
  let worst = 0;
  const widen = (a, b) => {
    if (a === undefined && b === undefined) return; // a word neither read could place
    if (a === undefined || b === undefined) {
      worst = Number.POSITIVE_INFINITY;
      return;
    }
    for (const k of ['x', 'y', 'width', 'height']) worst = Math.max(worst, Math.abs(a[k] - b[k]));
  };
  partLines.forEach((l, i) => {
    const w = wholeLines[i];
    widen(l.box, w && shifted(w.box));
    (l.words ?? []).forEach((word, j) => {
      const other = w?.words?.[j]?.box;
      widen(word.box, other && shifted(other));
    });
  });
  check(
    whole.ok &&
      wholeLines.length === partLines.length &&
      JSON.stringify(wholeLines.map((l) => l.text)) ===
        JSON.stringify(partLines.map((l) => l.text)) &&
      worst <= 0.02,
    `…at exactly the boxes the same crop read as its own file gives, shifted by the region's origin (lines and words, worst Δ ${worst.toFixed(2)} px)`,
  );
  let lowest = 1;
  partLines.forEach((l, i) => {
    const full = inBand[i]?.box;
    lowest = Math.min(lowest, full === undefined ? 0 : iou(l.box, full));
  });
  check(
    partLines.length === inBand.length && lowest >= 0.5,
    `…where the full read found each line in the picture (lowest IoU ${lowest.toFixed(2)})`,
  );
  report.steps.regionOcr = {
    band,
    lines: partLines.map((l) => l.text),
    worstDeltaVsCropFile: worst,
    lowestIoUVsFullRead: lowest,
  };
  const bandView = rgbaOf(readPng(fx('poster.png')));
  rect(bandView, band, YELLOW, 3);
  for (const l of partLines) rect(bandView, roundBox(l.box), GREEN, 3);
  save('poster-ocr-region.png', bandView);

  const sign = await helper.call('ocr', { image: fx('sign-misspelt.png'), correction: false });
  check(
    sign.ok && sign.result.text === manifest['sign-misspelt.png'].text,
    `the misspelling is read literally ("${sign.result?.text}")`,
  );
  const signView = rgbaOf(readPng(fx('sign-misspelt.png')));
  for (const line of sign.result.lines)
    for (const w of line.words ?? []) if (w.box) rect(signView, roundBox(w.box), ORANGE, 2);
  save('sign-ocr.png', signView);

  // ── nothing there, and errors that must not kill the helper ─────────────
  step('blank picture and error paths');
  const blankLift = await helper.call('lift', { image: fx('blank.png') });
  const blankOcr = await helper.call('ocr', { image: fx('blank.png') });
  check(
    blankLift.result.count === 0 && blankLift.result.foreground === undefined,
    'blank: no instances, no foreground',
  );
  check(blankOcr.result.lines.length === 0, 'blank: no text');
  const missing = await helper.call('lift', { image: fx('nope.png') });
  check(
    missing.ok === false && /image not found/.test(missing.error),
    `missing file → "${missing.error}"`,
  );
  const outside = await helper.call('instanceAt', { image: fx('apples.jpg'), x: 5000, y: 10 });
  check(
    outside.ok === false && /outside the 960×640 image/.test(outside.error),
    `point outside → "${outside.error}"`,
  );
  const bogus = await helper.call('frobnicate');
  check(
    bogus.ok === false && bogus.error === 'unknown method: frobnicate',
    'unknown method → an error line',
  );
  const still = await helper.call('info');
  check(still.ok, 'the helper still answers after the errors');
  sampleFront('after OCR and errors');

  // ── the one-shot form, for a shell: one request, one line, an exit code ──
  step('one-shot — pi-mac --vision <method> [json|path]');
  {
    const oneShot = (...args) => {
      const r = spawnSync(HELPER, ['--vision', ...args], { encoding: 'utf8', timeout: 120_000 });
      if (r.pid) helperPids.push(r.pid);
      const lines = (r.stdout ?? '').split('\n').filter((l) => l.trim() !== '');
      let msg = null;
      try {
        msg = lines.length === 1 ? JSON.parse(lines[0]) : null;
      } catch {
        msg = null;
      }
      return { status: r.status, lines: lines.length, msg, stderr: r.stderr ?? '' };
    };
    const read = oneShot(
      'ocr',
      JSON.stringify({ image: fx('sign-misspelt.png'), correction: false }),
    );
    check(
      read.status === 0 && read.lines === 1 && read.msg?.ok === true && read.msg.id === undefined,
      `ocr with JSON params: exit 0, one { ok, result } line (${read.msg?.result?.text})`,
    );
    const byPath = oneShot('lift', fx('cat.jpg'));
    check(
      byPath.status === 0 && byPath.msg?.result?.count === 1,
      `lift with a bare path: exit 0, ${byPath.msg?.result?.count} instance`,
    );
    const badJson = oneShot('lift', '{not json');
    check(
      badJson.status === 1 &&
        badJson.msg?.ok === false &&
        /not a JSON object/.test(badJson.msg.error),
      `malformed JSON params: exit 1 with an error line ("${badJson.msg?.error}")`,
    );
    const unknown = oneShot('frobnicate');
    check(
      unknown.status === 1 && unknown.msg?.error === 'unknown method: frobnicate',
      'an unknown method: exit 1 with an error line',
    );
    const bare = oneShot();
    check(
      bare.status === 2 && bare.lines === 0 && /usage: pi-mac --vision/.test(bare.stderr),
      'no method: exit 2, usage on stderr, nothing on stdout',
    );
    // Two pictures is not "lift both": it must not quietly lift only the first.
    const extra = oneShot('lift', fx('cat.jpg'), fx('apples.jpg'));
    check(
      extra.status === 2 && extra.lines === 0 && /usage: pi-mac --vision/.test(extra.stderr),
      'a stray extra argument: exit 2, usage on stderr, nothing on stdout',
    );
  }

  // ── hardening: each of these failed before the code-review fixes ────────
  step('hardening — radius, prefixes, limits, absurd numbers');
  {
    // The snap radius is a real circle around the TAP POINT. From the apples'
    // own label map, find a background pixel whose nearest labelled pixel is
    // √D away, D NOT a perfect square (sqrt(D)² lands a hair under D in
    // floating point — the second review's catch). Tapping that pixel's
    // centre: a radius a hair under √D must miss (the first cut's `d < r² + 1`
    // let it through), and a radius of exactly √D must reach it, reporting √D.
    const L = apLabels;
    // Squared distances whose square root squares back to LESS than itself in
    // doubles (6, 12, 13, 18, 23, 24 …) — exactly where a plain `d <= r*r`
    // misses; any other non-square D is the fallback.
    const edge = (D) => Math.sqrt(D) * Math.sqrt(D) < D;
    let target = null;
    let fallback = null;
    for (let y = 300; y < 420 && target === null; y += 1) {
      for (let x = 368; x > 330 && target === null; x -= 1) {
        if (at(L, x, y) !== 0) continue;
        let best = Number.POSITIVE_INFINITY;
        for (let dy = -5; dy <= 5; dy += 1) {
          for (let dx = -5; dx <= 5; dx += 1) {
            if (at(L, x + dx, y + dy) !== 0) best = Math.min(best, dx * dx + dy * dy);
          }
        }
        if (best < 5 || best > 25 || Number.isInteger(Math.sqrt(best))) continue;
        if (edge(best)) target = { x, y, d2: best };
        else fallback ??= { x, y, d2: best };
      }
    }
    target ??= fallback;
    check(
      target !== null,
      `found a background pixel beside the middle apple (${JSON.stringify(target)})`,
    );
    if (target !== null) {
      const exact = Math.sqrt(target.d2);
      const under = await helper.call('instanceAt', {
        image: fx('apples.jpg'),
        x: target.x + 0.5,
        y: target.y + 0.5,
        radius: exact - 0.05,
        write: [],
      });
      const onIt = await helper.call('instanceAt', {
        image: fx('apples.jpg'),
        x: target.x + 0.5,
        y: target.y + 0.5,
        radius: exact,
        write: [],
      });
      check(
        under.ok && under.result.hit === false,
        `radius ${(exact - 0.05).toFixed(2)} does not reach a pixel ${exact.toFixed(2)} px away`,
      );
      check(
        onIt.ok && onIt.result.hit === true && onIt.result.distance === Number(exact.toFixed(2)),
        `radius ${exact.toFixed(2)} reaches it, reporting ${onIt.result?.distance} px`,
      );
    }

    // A prefix two pictures share must not hand back the other one's mask.
    const shared = path.join(work, 'shared');
    mkdirSync(shared);
    await helper.call('lift', {
      image: fx('cat.jpg'),
      out: shared,
      prefix: 'doc',
      write: ['mask'],
    });
    await helper.call('lift', {
      image: fx('apples.jpg'),
      out: shared,
      prefix: 'doc',
      write: ['mask'],
    });
    const back = await helper.call('lift', {
      image: fx('cat.jpg'),
      out: shared,
      prefix: 'doc',
      write: ['mask'],
    });
    const backMask = readPng(back.result.instances[0].maskPath);
    check(
      back.result.cached === true && at(backMask, 600, 240) === 255,
      "a prefix shared with the apples still returns the cat's own mask (cat head = 255)",
    );

    // The size limit holds for a picture that is already cached.
    await helper.call('lift', { image: fx('cat.jpg'), write: [] });
    const capped = await helper.call('lift', {
      image: fx('cat.jpg'),
      maxPixels: 100_000,
      write: [],
    });
    check(
      !capped.ok && /too large/.test(capped.error ?? ''),
      `maxPixels applies to a cached picture ("${capped.error}")`,
    );

    // 1.9 is not instance 1.
    const frac = await helper.call('lift', {
      image: fx('apples.jpg'),
      instances: [1.9],
      write: [],
    });
    check(
      !frac.ok && /whole numbers/.test(frac.error ?? ''),
      `fractional instance numbers are refused ("${frac.error}")`,
    );

    // Absurd numbers are clamped or refused — never a crash.
    const far = await helper.call('instanceAt', {
      image: fx('apples.jpg'),
      x: 470,
      y: 100,
      radius: 1e19,
      write: [],
    });
    check(
      far.ok && far.result.hit === true,
      `radius 1e19 is clamped, not a trap (snapped ${far.result?.distance} px)`,
    );
    const offRegion = await helper.call('ocr', {
      image: fx('poster.png'),
      region: { x: 1e19, y: 0, width: 1, height: 1 },
    });
    check(
      !offRegion.ok && /outside/.test(offRegion.error ?? ''),
      `a region at x = 1e19 is refused ("${offRegion.error}")`,
    );
    const wide = await helper.call('ocr', {
      image: fx('poster.png'),
      region: { x: -1e19, y: 0, width: 2e19, height: 300 },
      words: false,
    });
    check(
      wide.ok && wide.result.lines[0]?.text === 'MIDNIGHT',
      'a region wider than the world is clamped to the picture',
    );
    const alive = await helper.call('info');
    check(alive.ok, 'the helper is still answering after all of that');

    // The cache is trimmed to its byte budget (a 4 MB budget holds one of
    // these pictures, not two), always keeping the most recent.
    const tight = startHelper({ PI_MAC_VISION_CACHE_MB: '4' });
    helperPids.push(tight.child.pid);
    await tight.call('lift', { image: fx('cat.jpg'), write: [] });
    await tight.call('lift', { image: fx('apples.jpg'), write: [] });
    const tightInfo = await tight.call('info');
    const catAgain = await tight.call('lift', { image: fx('cat.jpg'), write: [] });
    check(
      tightInfo.result.cache.budgetBytes === 4 * 1_048_576 &&
        tightInfo.result.cache.entries === 1 &&
        catAgain.result.cached === false,
      `4 MB budget: one picture kept (${tightInfo.result.cache.bytes} bytes), the older one analysed afresh`,
    );
    report.steps.cacheBudget = tightInfo.result.cache;
    tight.child.stdin.end();
    await tight.exited;
  }
} catch (err) {
  failures.push(`probe crashed: ${err instanceof Error ? err.stack : err}`);
  console.error(err);
} finally {
  helper.child.stdin.end();
  const exit = await Promise.race([
    helper.exited,
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);
  check(
    exit !== null && exit.code === 0,
    `the helper exits cleanly when its stdin closes (${JSON.stringify(exit)})`,
  );
  if (helper.stderr.length > 0) console.log('  helper stderr:', helper.stderr.join('').trim());
}

function roundBox(b) {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  };
}

// ── no orphan: kill the parent, the helper must follow ─────────────────────
step('orphan check');
{
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn(${JSON.stringify(HELPER)}, ['--vision-serve'], { stdio: ['pipe', 'pipe', 'ignore'] });
       c.stdout.on('data', () => {});
       console.log(c.pid);
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const childPid = await new Promise((resolve) =>
    parent.stdout.once('data', (d) => resolve(Number(String(d).trim()))),
  );
  helperPids.push(childPid);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await new Promise((r) => setTimeout(r, 300));
  check(alive(childPid), `a second helper (pid ${childPid}) is running under a throwaway parent`);
  parent.kill('SIGKILL');
  const t0 = Date.now();
  while (alive(childPid) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  const gone = !alive(childPid);
  check(gone, `after SIGKILL of its parent the helper exited by itself in ${Date.now() - t0} ms`);
  if (!gone) process.kill(childPid, 'SIGKILL');
}

// ── focus ────────────────────────────────────────────────────────────────────
step('focus guard');
sampleFront('end');
report.focus.samples = frontSamples;
const stolen = frontSamples.filter((s) => s.app !== null && s.app !== before && OURS.has(s.app));
check(
  before === null || stolen.length === 0,
  `frontmost stayed with the user (${before ?? 'unreadable'}); never ${[...OURS].join('/')}`,
);

// ── TCC: only silent preflights, no prompt, no accessibility warning ───────
step('TCC (tccd log)');
await new Promise((r) => setTimeout(r, 1500)); // let the log catch up
{
  const pad = (n) => String(n).padStart(2, '0');
  const d = logStart;
  const start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const r = spawnSync(
    '/usr/bin/log',
    [
      'show',
      '--start',
      start,
      '--info',
      '--style',
      'ndjson',
      '--predicate',
      'process == "tccd" OR process == "universalAccessAuthWarn"',
    ],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  const events = (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null);
  const mentionsOurs = (msg) =>
    helperPids.some(
      (p) =>
        msg.includes(`pid=${p},`) ||
        msg.includes(`pid:${p},`) ||
        msg.includes(`TCCD_MSG_ID="${p}.`),
    );
  const ours = events.filter((e) => mentionsOurs(e.eventMessage ?? ''));
  const requests = ours.filter((e) => (e.eventMessage ?? '').startsWith('REQUEST_MSG'));
  const prompting = requests.filter((e) => !/preflight=true/.test(e.eventMessage));
  const services = [
    ...new Set(requests.map((e) => /service="(\w+)"/.exec(e.eventMessage)?.[1]).filter(Boolean)),
  ];
  const prompts = events.filter((e) => /display_prompt/.test(e.eventMessage ?? ''));
  const warnings = events.filter((e) =>
    (e.processImagePath ?? '').endsWith('universalAccessAuthWarn'),
  );
  report.tcc = {
    logEvents: events.length,
    requestsForHelper: requests.length,
    services,
    prompting: prompting.length,
    prompts: prompts.length,
    accessibilityWarnings: warnings.length,
  };
  check(events.length > 0, `tccd's log is readable (${events.length} events in the window)`);
  check(
    prompting.length === 0,
    `every TCC request for the helper was a silent preflight (${requests.length} requests: ${services.join(', ') || 'none'})`,
  );
  check(prompts.length === 0, 'no permission prompt was displayed during the run');
  check(warnings.length === 0, 'no accessibility warning was launched during the run');
}

rmSync(work, { recursive: true, force: true });
report.failures = failures;
writeFileSync(path.join(SHOT_DIR, 'report.json'), JSON.stringify(report, null, 2));
console.log(
  `\nmac-vision-probe: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} — pictures and report.json in ${SHOT_DIR}`,
);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
