/**
 * THE FOLDER THAT OPENS — a project row's glyph, morphing between the closed
 * and the open folder as the row folds and unfolds.
 *
 * The user (2026-09-20) handed over the two drawings and asked for the
 * "animation between the two". The two are not the same path: the closed one
 * is a body with a tab and a shelf line, the open one a back panel and a
 * skewed front. So the morph is geometric rather than a `d` transition: each
 * subpath is sampled into the same number of points along its length, the
 * sample order is rotated (and reversed, when that is closer) so that
 * matching points are neighbours, and the frames in between are polylines
 * through the interpolated points — exact drawings at both ends, 240 ms of
 * paper folding in between. A missing counterpart (the open folder's short
 * tab line) grows from, or shrinks to, a point.
 */
import { clsx } from 'clsx';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { GLYPHS } from './glyph.tsx';

type Pt = readonly [number, number];
const SAMPLES = 40;
const DURATION_MS = 240;

/** Split a path into its subpaths (each starting with M). */
function subpaths(d: string): string[] {
  return d
    .split(/(?=M)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Sample a subpath into SAMPLES points along its length (needs the DOM). */
function sample(d: string): { pts: Pt[]; closed: boolean } {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  const total = path.getTotalLength();
  const pts: Pt[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const p = path.getPointAtLength((total * i) / (SAMPLES - 1));
    pts.push([p.x, p.y]);
  }
  return { pts, closed: /Z\s*$/i.test(d) };
}

/** The point a missing counterpart collapses to: the other shape's centre. */
function centre(pts: readonly Pt[]): Pt {
  const n = pts.length;
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}

/** Rotate/reverse `to` so its points sit nearest the matching points of `from`. */
function align(from: readonly Pt[], to: readonly Pt[], closed: boolean): Pt[] {
  const cost = (seq: readonly Pt[]) =>
    seq.reduce((s, p, i) => {
      const q = from[i] as Pt;
      return s + (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    }, 0);
  let best = to;
  let bestCost = cost(to);
  const candidates: Pt[][] = [[...to].reverse()];
  if (closed) {
    // A closed shape can start anywhere along its outline.
    for (let k = 1; k < to.length; k += 1) {
      const rot = [...to.slice(k), ...to.slice(0, k)];
      candidates.push(rot, [...rot].reverse());
    }
  }
  for (const c of candidates) {
    const cc = cost(c);
    if (cc < bestCost) {
      bestCost = cc;
      best = c;
    }
  }
  return [...best];
}

function polyline(pts: readonly Pt[], closed: boolean): string {
  const f = (n: number) => (Math.round(n * 100) / 100).toString();
  return `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join('L')}${closed ? 'Z' : ''}`;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** The two drawings, as their subpaths, path by path. */
function shapes(open: boolean): string[][] {
  return (open ? GLYPHS.folderOpen : GLYPHS.folder).map((p) => subpaths(p.d));
}

/**
 * WHAT FOLDS INTO WHAT. Paired by hand, because the natural pairing is not
 * the index order: the closed folder's BODY (its outline carries the tab at
 * the top left) is the open folder's BACK PANEL (the same tab, the same left
 * side); the closed folder's shelf line is what the open folder's FRONT
 * panel folds down from; the open folder's short tab underline has no
 * counterpart and shrinks to a point. `[path, subpath]` into each drawing.
 */
const PAIRS: readonly (readonly [
  closed: readonly [number, number] | null,
  open: readonly [number, number] | null,
])[] = [
  [
    [1, 0],
    [0, 0],
  ],
  [
    [0, 0],
    [1, 0],
  ],
  [null, [0, 1]],
];

export interface FolderGlyphProps {
  readonly open: boolean;
  readonly size?: number;
  readonly className?: string;
}

export function FolderGlyph({ open, size = 16, className }: FolderGlyphProps) {
  // The exact drawing for the state we are in (or heading to); frames in
  // between replace it while the morph runs.
  const [frames, setFrames] = useState<string[] | null>(null);
  const shown = useRef(open);
  const raf = useRef(0);

  useEffect(() => {
    if (shown.current === open) return;
    const from = shapes(shown.current);
    const to = shapes(open);
    const wasOpen = shown.current;
    shown.current = open;
    if (
      typeof document === 'undefined' ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    ) {
      setFrames(null);
      return;
    }
    const pick = (drawing: string[][], at: readonly [number, number] | null) =>
      at === null ? null : sample(drawing[at[0]]?.[at[1]] ?? 'M12 12');
    const pairs = PAIRS.map(([c, o]) => {
      const sa = pick(from, wasOpen ? o : c);
      const sb = pick(to, open ? o : c);
      const closed = (sb ?? sa)?.closed === true;
      const a = sa?.pts ?? Array.from({ length: SAMPLES }, () => centre((sb as { pts: Pt[] }).pts));
      const bRaw = sb?.pts ?? Array.from({ length: SAMPLES }, () => centre(a));
      return { a, b: sa !== null && sb !== null ? align(a, bRaw, closed) : bRaw, closed };
    });
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / DURATION_MS);
      const k = easeOut(t);
      setFrames(
        pairs.map(({ a, b, closed }) =>
          polyline(
            a.map((p, i) => {
              const q = b[i] as Pt;
              return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k] as const;
            }),
            closed && t === 1,
          ),
        ),
      );
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else setFrames(null);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [open]);

  const glyph = open ? GLYPHS.folderOpen : GLYPHS.folder;
  return (
    <svg
      width={size}
      height={size}
      style={{ '--pd-icon-base': size } as CSSProperties}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx('pd-icon pd-glyph pd-folder-glyph', className)}
      data-glyph={open ? 'folderOpen' : 'folder'}
      data-morphing={frames !== null ? 'true' : 'false'}
      aria-hidden="true"
    >
      {frames !== null
        ? frames.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: frames are positional
            <path key={i} d={d} vectorEffect="non-scaling-stroke" />
          ))
        : glyph.map((p) => (
            <path
              key={p.d}
              d={p.d}
              vectorEffect="non-scaling-stroke"
              {...(p.cap === 'butt' ? { strokeLinecap: 'butt' as const } : {})}
              {...(p.join === 'miter' ? { strokeLinejoin: 'miter' as const } : {})}
            />
          ))}
    </svg>
  );
}
