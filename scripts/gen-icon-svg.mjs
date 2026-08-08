#!/usr/bin/env node
/**
 * Generate apps/desktop/build/icon.svg — the Bobble mark.
 *
 * The mark is a 2x2 grid of rounded squares with one slot missing, on a
 * squircle tile with a macOS-style rim light. The missing slot is the whole
 * idea: it is the hole the loading animation walks clockwise around, so the
 * static icon is a frame of the motion rather than a separate drawing.
 *
 * Every number below came out of the tuner at ~/bobble-testbed/icon-tuner.html,
 * which renders this same geometry live. Change PARAMS here, re-run, and the
 * .icns follows:
 *
 *   node scripts/gen-icon-svg.mjs && bash scripts/gen-icon.sh
 *
 * Written as parameters rather than a pasted SVG so the icon stays tunable —
 * a hand-edited 1024px path is a dead end the moment anyone wants the bevel a
 * few percent tighter.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PARAMS = {
  /** Aqua / Pink / Yellow. One colour per square — there are exactly three. */
  palette: ['#14C4C4', '#FF4FA3', '#FFC93C'],
  /** Which slot is empty, clockwise from top-left: 0 TL, 1 TR, 2 BR, 3 BL. */
  hole: 0,
  /** Square corner radius, as a percent of half the square's side. */
  bevel: 54,
  /** Square border weight, in viewBox units. */
  border: 1.5,
  /** Space between squares. */
  gap: 4,
  /** Space from the canvas edge to the grid. */
  inset: 15,
  /** Tile wash: a light tint of the first palette colour. */
  tileTint: 0.86,
  /** Tile corner: drives the superellipse exponent. 52% lands near n=5, Apple's. */
  tileBevel: 52,
  /** Rim light: top-edge shine, bottom seat shadow and the outer hairline. */
  rim: 65,
  /** Tile's own top-to-bottom gradient. */
  tileShade: 45,
};

const VB = 120;
const TILE_MARGIN = 4;

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v) => clamp255(v).toString(16).padStart(2, '0');
const channel = (h, i) => parseInt(h.slice(i, i + 2), 16);
const mix = (a, b, t) =>
  '#' +
  hex2(channel(a, 1) + (channel(b, 1) - channel(a, 1)) * t) +
  hex2(channel(a, 3) + (channel(b, 3) - channel(a, 3)) * t) +
  hex2(channel(a, 5) + (channel(b, 5) - channel(a, 5)) * t);
const darken = (h, t) => mix(h, '#000000', t);
const lighten = (h, t) => mix(h, '#ffffff', t);

/**
 * A superellipse, not a rounded rect. macOS icon tiles are squircles: the
 * corner curvature is continuous rather than an arc spliced onto a straight
 * edge, which is why a plain `rx` tile reads subtly wrong beside real ones.
 */
function squirclePath(x, y, size, n) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size / 2;
  const e = 2 / n;
  const STEPS = 128;
  let d = '';
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * 2 * Math.PI;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const px = cx + r * Math.sign(ct) * Math.abs(ct) ** e;
    const py = cy + r * Math.sign(st) * Math.abs(st) ** e;
    d += `${i ? 'L' : 'M'}${px.toFixed(3)} ${py.toFixed(3)}`;
  }
  return `${d}Z`;
}

function build(p) {
  const base = lighten(p.palette[0], p.tileTint);
  const shade = p.tileShade / 100;
  const rim = p.rim / 100;
  const tileSize = VB - 2 * TILE_MARGIN;
  const n = 8 - (p.tileBevel / 100) * 5.5;
  const rimWidth = Math.max(0.8, 1.6 * (p.rim / 65));
  const tile = (inset, attrs) =>
    `<path d="${squirclePath(TILE_MARGIN + inset, TILE_MARGIN + inset, tileSize - inset * 2, n)}" ${attrs}/>`;

  const side = (VB - 2 * p.inset - p.gap) / 2;
  const far = p.inset + side + p.gap;
  const slots = [
    [p.inset, p.inset],
    [far, p.inset],
    [far, far],
    [p.inset, far],
  ];
  const radius = (p.bevel / 100) * (side / 2);

  const squares = [];
  let colour = 0;
  for (let i = 0; i < 4; i++) {
    if (i === p.hole) continue;
    const [x, y] = slots[i];
    squares.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${side.toFixed(2)}" height="${side.toFixed(2)}" ` +
        `rx="${radius.toFixed(2)}" fill="${p.palette[colour]}" stroke="#111111" ` +
        `stroke-width="${p.border}" stroke-linejoin="round"/>`,
    );
    colour++;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 ${VB} ${VB}" role="img" aria-label="Bobble">
  <title>Bobble</title>
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${lighten(base, 0.2 * shade)}"/>
      <stop offset="1" stop-color="${darken(base, 0.17 * shade)}"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${(0.92 * rim).toFixed(3)}"/>
      <stop offset="0.30" stop-color="#ffffff" stop-opacity="${(0.2 * rim).toFixed(3)}"/>
      <stop offset="0.62" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="seat" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="${(0.34 * rim).toFixed(3)}"/>
    </linearGradient>
  </defs>
  ${tile(0, 'fill="url(#tile)"')}
  ${tile(rimWidth / 2, `fill="none" stroke="url(#rim)" stroke-width="${rimWidth.toFixed(2)}"`)}
  ${tile(rimWidth / 2, `fill="none" stroke="url(#seat)" stroke-width="${rimWidth.toFixed(2)}"`)}
  ${tile(0, 'fill="none" stroke="#000000" stroke-opacity="0.15" stroke-width="0.7"')}
  ${squares.join('\n  ')}
</svg>
`;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'apps/desktop/build/icon.svg');
writeFileSync(out, build(PARAMS));
console.log(`gen-icon-svg: wrote ${out}`);
