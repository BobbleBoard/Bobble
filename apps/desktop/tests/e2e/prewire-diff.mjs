/**
 * BEFORE vs AFTER, pixel for pixel and tree for tree — the other half of
 * prewire-look.mjs.
 *
 *   node apps/desktop/tests/e2e/prewire-diff.mjs <before-dir> <after-dir> [out-dir]
 *
 * For every `<state>-<mode>.png` in BEFORE it decodes the AFTER picture of the
 * same name and counts the pixels that differ (any channel, any amount), with
 * the bounding box of the difference. For every `<state>.dom.json` it compares
 * the test ids in order, the visible text and the element count. With an
 * out-dir it also writes a heat image per differing picture (changed pixels
 * in red over a dimmed AFTER), so a difference can be LOOKED at, not just
 * counted.
 *
 * Exit code 1 when anything differs; the table says what.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng } from './png.mjs';

const [beforeDir, afterDir, outDir] = process.argv.slice(2);
if (beforeDir === undefined || afterDir === undefined) {
  console.error('usage: prewire-diff.mjs <before-dir> <after-dir> [out-dir]');
  process.exit(64);
}
if (outDir !== undefined) mkdirSync(outDir, { recursive: true });

const rgba = (img) => {
  // Normalise to 4 channels so two encodings of the same picture compare equal.
  if (img.channels === 4) return img.data;
  const out = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0, j = 0; i < img.width * img.height; i++) {
    const c = img.channels;
    out[j++] = img.data[i * c];
    out[j++] = img.data[i * c + (c >= 3 ? 1 : 0)];
    out[j++] = img.data[i * c + (c >= 3 ? 2 : 0)];
    out[j++] = c === 2 || c === 4 ? img.data[i * c + c - 1] : 255;
  }
  return out;
};

let failures = 0;
const rows = [];
for (const name of readdirSync(beforeDir).sort()) {
  const a = path.join(beforeDir, name);
  const b = path.join(afterDir, name);
  if (name.endsWith('.png')) {
    if (!existsSync(b)) {
      rows.push({ name, result: 'MISSING in after' });
      failures++;
      continue;
    }
    const A = decodePng(readFileSync(a));
    const B = decodePng(readFileSync(b));
    if (A.width !== B.width || A.height !== B.height) {
      rows.push({ name, result: `SIZE ${A.width}x${A.height} → ${B.width}x${B.height}` });
      failures++;
      continue;
    }
    const pa = rgba(A);
    const pb = rgba(B);
    let diff = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    const heat = outDir === undefined ? null : Buffer.alloc(A.width * A.height * 4);
    for (let i = 0; i < A.width * A.height; i++) {
      const o = i * 4;
      const same =
        pa[o] === pb[o] &&
        pa[o + 1] === pb[o + 1] &&
        pa[o + 2] === pb[o + 2] &&
        pa[o + 3] === pb[o + 3];
      if (!same) {
        diff++;
        const x = i % A.width;
        const y = Math.floor(i / A.width);
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      if (heat !== null) {
        if (same) {
          heat[o] = pb[o] >> 2;
          heat[o + 1] = pb[o + 1] >> 2;
          heat[o + 2] = pb[o + 2] >> 2;
        } else {
          heat[o] = 255;
          heat[o + 1] = 0;
          heat[o + 2] = 0;
        }
        heat[o + 3] = 255;
      }
    }
    if (diff === 0) {
      rows.push({ name, result: 'identical' });
    } else {
      failures++;
      rows.push({ name, result: `${diff} px differ in [${x0},${y0}]–[${x1},${y1}]` });
      if (heat !== null) {
        writeFileSync(
          path.join(outDir, name.replace(/\.png$/, '.diff.png')),
          encodePng({ width: A.width, height: A.height, channels: 4, data: heat }),
        );
      }
    }
  } else if (name.endsWith('.dom.json') || name === 'settings-nav.json' || name === 'states.json') {
    if (!existsSync(b)) {
      rows.push({ name, result: 'MISSING in after' });
      failures++;
      continue;
    }
    const A = JSON.parse(readFileSync(a, 'utf8'));
    const B = JSON.parse(readFileSync(b, 'utf8'));
    const problems = [];
    if (name.endsWith('.dom.json')) {
      if (JSON.stringify(A.testids) !== JSON.stringify(B.testids)) {
        const gone = A.testids.filter((t) => !B.testids.includes(t));
        const added = B.testids.filter((t) => !A.testids.includes(t));
        problems.push(`testids differ (−${JSON.stringify(gone)} +${JSON.stringify(added)})`);
      }
      if (A.text !== B.text) {
        let at = 0;
        while (at < A.text.length && A.text[at] === B.text[at]) at++;
        problems.push(
          `text differs at ${at}: ${JSON.stringify(A.text.slice(at, at + 60))} → ${JSON.stringify(B.text.slice(at, at + 60))}`,
        );
      }
      if (A.nodes !== B.nodes) problems.push(`elements ${A.nodes} → ${B.nodes}`);
    } else if (JSON.stringify(A) !== JSON.stringify(B)) {
      problems.push('content differs');
    }
    if (problems.length > 0) failures++;
    rows.push({ name, result: problems.length === 0 ? 'identical' : problems.join('; ') });
  }
}
for (const r of rows)
  console.log(`${r.result === 'identical' ? '  ' : '✗ '}${r.name}: ${r.result}`);
const pngs = rows.filter((r) => r.name.endsWith('.png'));
console.log(
  `\n${pngs.filter((r) => r.result === 'identical').length}/${pngs.length} pictures identical, ` +
    `${rows.length - pngs.length - rows.filter((r) => !r.name.endsWith('.png') && r.result !== 'identical').length}/${rows.length - pngs.length} digests identical`,
);
process.exit(failures === 0 ? 0 : 1);
