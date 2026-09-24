#!/usr/bin/env node
/**
 * Re-capture src/__fixtures__/vision-responses.json from the REAL helper.
 *
 *   bash packages/pi-mac/scripts/build-signed.sh
 *   node packages/pi-mac/scripts/capture-vision-responses.mjs [--check]
 *   npx biome format --write packages/pi-mac/src/__fixtures__/vision-responses.json
 *
 * (the last line folds the short arrays back the way the repo formats JSON).
 *
 * The TS contract tests (src/vision.test.ts, apps/desktop/electron/editor/
 * mac-vision.test.ts) parse these responses, so they pin the wire the helper
 * actually speaks rather than a shape someone remembered. Run this after any
 * change to Vision.swift's result shapes; `--check` only reports whether the
 * committed file still has the same KEYS at every level as a fresh capture
 * (numbers such as timings and content tags differ run to run) and writes
 * nothing.
 *
 * Headless: it talks to `pi-mac --vision-serve` over a pipe (no window, no
 * permission — Vision reads files). Paths are rewritten to /fixtures and /out
 * so the file does not depend on this checkout's location, and the OCR language
 * list is trimmed to its first three entries.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(PKG, 'fixtures/vision');
const TARGET = path.join(PKG, 'src/__fixtures__/vision-responses.json');
const HELPER = process.env.PI_MAC_HELPER_PATH ?? path.join(PKG, 'swift/.build/release/pi-mac');
const CHECK = process.argv.includes('--check');

const out = mkdtempSync(path.join(tmpdir(), 'pi-mac-vision-capture-'));
const fx = (name) => path.join(FIXTURES, name);

const child = spawn(HELPER, ['--vision-serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
let nextId = 0;
const waiting = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
child.on('exit', (code) => {
  for (const [, resolve] of waiting) resolve({ ok: false, error: `helper exited (${code})` });
});

function call(method, params = {}) {
  nextId += 1;
  const id = nextId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

/** Every string with the checkout's paths replaced, recursively. */
function portable(value) {
  if (typeof value === 'string')
    return value.split(FIXTURES).join('/fixtures').split(out).join('/out');
  if (Array.isArray(value)) return value.map(portable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portable(v)]));
  }
  return value;
}

/** The same keys at every level (arrays compared by their first element). */
function shape(value) {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shape(value[k])]),
    );
  }
  return typeof value;
}

// The order (and so the ids) the committed file has always had.
const steps = [
  ['warm', 'warm', {}],
  [
    'liftCat',
    'lift',
    {
      image: fx('cat.jpg'),
      out,
      write: ['mask', 'cutout', 'foregroundMask', 'foregroundCutout', 'labels'],
      crop: true,
    },
  ],
  ['liftApples', 'lift', { image: fx('apples.jpg'), out }],
  ['info', 'info', {}],
  ['liftBlank', 'lift', { image: fx('blank.png'), out }],
  ['instanceAtHit', 'instanceAt', { image: fx('apples.jpg'), x: 146, y: 363, out }],
  ['instanceAtMiss', 'instanceAt', { image: fx('apples.jpg'), x: 470, y: 100, out }],
  [
    'instanceAtSnapped',
    'instanceAt',
    { image: fx('apples.jpg'), x: 360, y: 360, radius: 20, write: [] },
  ],
  ['ocrSign', 'ocr', { image: fx('sign-misspelt.png'), correction: false }],
  ['ocrBlank', 'ocr', { image: fx('blank.png') }],
  ['errorNotFound', 'lift', { image: fx('nope.png') }],
  ['errorOutside', 'instanceAt', { image: fx('apples.jpg'), x: 5000, y: 1 }],
  ['errorWrite', 'lift', { image: fx('apples.jpg'), write: ['bogus'] }],
  ['errorMethod', 'frobnicate', {}],
  ['forget', 'forget', {}],
];

const captured = {
  _about:
    'Real pi-mac --vision-serve responses captured from the Swift helper on packages/pi-mac/fixtures/vision (paths rewritten to /fixtures and /out; the OCR language list trimmed). Pins the wire shapes the TS parsers accept. Regenerate with scripts/capture-vision-responses.mjs.',
};
let failed = false;
try {
  for (const [name, method, params] of steps) {
    const msg = portable(await call(method, params));
    const wantOk = !name.startsWith('error');
    if (msg.ok !== wantOk) {
      console.error(`capture: ${name} answered ok=${msg.ok} (${msg.error ?? 'no error'})`);
      failed = true;
    }
    if (name === 'info' && Array.isArray(msg.result?.ocrLanguages)) {
      msg.result.ocrLanguages = msg.result.ocrLanguages.slice(0, 3);
    }
    captured[name] = msg;
  }
} finally {
  child.stdin.end();
  rmSync(out, { recursive: true, force: true });
}
if (failed) process.exit(1);

if (CHECK) {
  const committed = JSON.parse(readFileSync(TARGET, 'utf8'));
  const drift = Object.keys(captured).filter(
    (k) => JSON.stringify(shape(committed[k])) !== JSON.stringify(shape(captured[k])),
  );
  if (drift.length > 0) {
    console.error(`capture --check: the wire changed for ${drift.join(', ')} — re-capture`);
    process.exit(1);
  }
  console.log('capture --check: the committed responses match the helper, key for key');
} else {
  writeFileSync(TARGET, `${JSON.stringify(captured, null, 2)}\n`);
  console.log(`capture: wrote ${Object.keys(captured).length - 1} responses to ${TARGET}`);
}
